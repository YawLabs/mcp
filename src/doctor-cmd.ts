// `yaw-mcp doctor` — prints a one-screen diagnostic of the user's yaw-mcp setup.
// Goal: when a support ticket comes in ("nothing is working"), the user
// pastes the doctor output and we can usually pinpoint the issue from
// it alone (which config files loaded / which clients have yaw-mcp wired
// up vs. don't / what the local bundles + learning state look like).
//
// The output is plain text so it survives Discord / Slack pasting.
//
// Side effects: doctor is NOT purely read-only. It runs the expired-trial
// GC pass (gcExpiredTrials, both the text and --json paths), which is a
// read-modify-write + unlink on client config files: it peels expired
// `yaw-mcp-try-*` entries out of each client config, deletes the trial
// marker, and fires a fire-and-forget expiry-gc telemetry event. There is
// no lock around that write, so it carries the same TOCTOU class as any
// other config mutation. The sweep is best-effort: any failure is swallowed
// and never aborts the diagnostic.
//
// Exit codes:
//   0  healthy — every config file parsed cleanly and raised no warnings
//   2  warnings (e.g., schema-version mismatch, a retired `token` /
//      `apiBase` key still sitting in a config file)
//   (1 = fatal is reserved and currently UNREACHABLE: nothing doctor
//   inspects is fatal — a bad config file degrades to a warning.)
//
// The exit-2 gate is UNCONDITIONALLY "any warning". It used to be gated on
// `config.token !== null`, which meant a warning-producing config exited 0
// whenever no token was configured -- i.e. always, once account mode went
// away. Do not re-introduce a precondition here.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cliToNamespaces } from "./cli-shadows.js";
import {
  CURRENT_SCHEMA_VERSION,
  type LoadedConfigFile,
  loadYawMcpConfig,
  type ResolvedConfig,
} from "./config-loader.js";
import {
  type DefaultRuntimeInfo,
  describeDefaultRuntime,
  describeServerRuntime,
  oamFailureLabel,
  type ServerRuntimeInfo,
} from "./default-runtime.js";
import { type GuideFile, loadProjectGuide, projectGuideNotice } from "./guide.js";
import {
  CURRENT_OS,
  ENTRY_NAME,
  findLegacyEntry,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import {
  loadLocalBundles,
  type ProjectTrustProbe,
  probeProjectTrust,
  projectFileIsHonoured,
  untrustedProjectWarning,
} from "./local-bundles.js";
import {
  compareVersions,
  isOamCommand,
  isOamLaunch,
  MIN_OAM_VERSION,
  nodeLaunchKind,
  type OamProbe,
  type OamProbeFailure,
  probeOam,
} from "./oam-spawn.js";
import { userConfigDir } from "./paths.js";
import {
  isPersistenceDisabled,
  isReadableStateVersion,
  loadState,
  STATE_FILENAME,
  STATE_SCHEMA_VERSION,
} from "./persistence.js";
import { collectSidecarSpecs, hasManagedSidecars, installedVersion, sidecarsRoot } from "./sidecars-cmd.js";
import { TRUST_BYPASS_ENV } from "./trust.js";
import { formatTtl, gcExpiredTrials, scanTrials, type TryEventBody } from "./try-cmd.js";
import {
  BINARY_DOWNLOAD_URL,
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  refineInstallMethod,
} from "./upgrade-cmd.js";
import { selectFlakyNamespaces } from "./usage-hints.js";

/**
 * Warning text for a project bundles.json that is NOT being loaded because
 * it has not been approved (or that IS being loaded only because the escape
 * hatch is set). Returns null when there is nothing to say.
 *
 * This belongs in doctor because the gate is deliberately silent-ish at
 * runtime: the server logs a warning to a stream most users never read, so
 * from their side "my project's servers stopped appearing" has no visible
 * cause. Any warning takes doctor to exit 2, which is the right signal --
 * the setup genuinely needs a decision from the user.
 */
function projectTrustWarning(probe: ProjectTrustProbe | null): string | null {
  if (!probe || probe.path === null) return null;
  // "none" = no project file at all; "trusted" is the healthy case.
  if (probe.status === "none" || probe.status === "trusted") return null;
  if (probe.status === "unreadable") {
    // Not a consent problem -- the bytes cannot be read at all, so neither
    // branch below applies. The loader raises its own one-line version of
    // this (`<path>: could not read file (...) -- skipping`); the detailed
    // form below replaces it, and foldBundleWarnings drops the short one so
    // the same fact is not printed twice.
    if (probe.pathTrusted === true || probe.bypassed) {
      // Approved-path (or bypassed) unreadable file: the loader stays
      // committed to it, which means ZERO servers from anywhere.
      return `${probe.path}: project bundles.json could not be read (${probe.error}). It was approved before, so yaw-mcp stays committed to that location and loads NO servers from it. Fix the file, or \`yaw-mcp trust --revoke\` it to fall back to your user-global bundles.json.`;
    }
    return untrustedProjectWarning(probe, { detail: true });
  }
  if (probe.bypassed) {
    // The escape hatch is only worth flagging when it is actually loading
    // something unreviewed -- staying quiet otherwise keeps doctor from
    // nagging a CI box where the var is set but every file is approved.
    return `${probe.path}: loaded WITHOUT approval because ${TRUST_BYPASS_ENV} is set -- every command in that file spawns as you, unreviewed. Unset it and run \`yaw-mcp trust\` to review and approve the file instead.`;
  }
  // Detailed form: the runtime warning is deliberately one short line (it
  // repeats on every command), and doctor is where the user gets sent to
  // find out what it actually means.
  return untrustedProjectWarning(probe, { detail: true });
}

/**
 * The bundles.json loader warnings doctor should fold into `config.warnings`.
 *
 * ALL of them, minus the ones projectTrustWarning above already renders in a
 * better (detailed) form. Folding is what makes a broken bundles.json visible
 * at all: `loadYawMcpConfig` never reads bundles.json, so a file that fails to
 * parse used to leave doctor printing "All good. yaw-mcp should start cleanly."
 * and exiting 0 with zero servers -- the exact ticket doctor exists to answer,
 * answered wrong. Once folded they reach the WARNINGS block, the always-on
 * stderr stream, and the unconditional exit-2 gate.
 *
 * The dedupe is keyed on the probe rather than on the warning text: the loader
 * PARSES the project file only when it is honoured AND readable, so in every
 * other state the only warnings it can raise about that path are the
 * trust/readability ones doctor already says itself. When it does parse (an
 * approved file, or one loaded under the env bypass) its schema diagnostics are
 * genuinely new information and all of them are kept -- including alongside the
 * bypass warning, which is a different fact about the same file.
 */
function foldBundleWarnings(warnings: readonly string[], probe: ProjectTrustProbe | null): string[] {
  if (!probe || probe.path === null) return [...warnings];
  if (projectFileIsHonoured(probe) && probe.status !== "unreadable") return [...warnings];
  const prefix = `${probe.path}:`;
  return warnings.filter((w) => !w.startsWith(prefix));
}

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. Used for the
   *  always-on warning stream so pipelines that capture stdout still see
   *  config warnings even when doctor exits 0 (e.g. local mode). */
  err?: (s: string) => void;
  /** Disable the npm registry freshness check (tests, offline use). */
  skipRegistryCheck?: boolean;
  /** Test hook: return the latest-version string for @yawlabs/mcp. */
  registryFetch?: () => Promise<string | null>;
  /** Emit a single JSON blob instead of the human-readable text report. */
  json?: boolean;
  /** Test hook: replace the fire-and-forget POST for expiry-gc events. */
  postTryEvent?: (baseUrl: string, body: TryEventBody) => Promise<void>;
  /** Test hook: override Date.now() used by the trial GC pass. */
  now?: () => number;
  /** Test hook: override the current version used for the staleness comparison
   *  and UPGRADE AVAILABLE hint. Defaults to VERSION (the build-time constant).
   *  Used ONLY in the upgrade-hint comparison and hint rendering; all other
   *  version references in doctor output continue to use the constant. */
  currentVersion?: string;
  /** Test hook: override process.argv[1] used for install-method detection in
   *  the UPGRADE AVAILABLE hint. Defaults to process.argv[1]. */
  argvPath?: string;
  /** Test hook: replace the real `oam --version` probe so the OAM RUNTIME
   *  section is deterministic regardless of what's installed on the host. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
}

// Machine-readable shape emitted by `yaw-mcp doctor --json`. Mirrors the
// text sections so support / dashboard consumers can pick fields with jq.
//
// Sections deliberately NOT mirrored (text-only, by design):
//   - SHADOWED CLI USAGE is carried as `shellShadows` (same data, renamed).
//   - UPGRADE AVAILABLE's method-aware terminal hint is text-only; the JSON
//     `upgrade` block carries the version facts but no install-method copy.
// Everything else (CONFIG FILES, ENVIRONMENT, STATE, RELIABILITY, TRIALS,
// INSTALLED CLIENTS, WARNINGS, DIAGNOSIS) has a structured field below.
export interface DoctorJsonSnapshot {
  timestamp: string;
  version: string;
  platform: InstallOS;
  // DEPRECATED — every member is always `null`. yaw-mcp is local-only; there
  // is no token and no API base to report. The NESTED SHAPE is retained
  // rather than flattened to a bare `null` for the same reason as
  // `backgroundPosters` below: a consumer reading `.token.source` or
  // `.apiBase.value` keeps parsing instead of throwing on a null deref.
  // Dropped in a later release.
  token: { fingerprint: null; source: null };
  apiBase: { value: null; source: null };
  loadedFiles: Array<{ scope: string; path: string; schemaVersion?: number; schemaAhead: boolean }>;
  // Project-scoped YAW-MCP.md, or null when there isn't one. `unapproved` is
  // true when it is served from a directory whose bundles.json is not
  // approved -- repo-authored text reaching the model. Deliberately NOT a
  // warning (see renderProjectGuideSection): it does not move the exit code.
  projectGuide: { path: string; unapproved: boolean } | null;
  warnings: string[];
  // Behavior-modifier env vars, null when unset. `YAW_MCP_POLL_INTERVAL` is
  // DEPRECATED and always null -- the remote config poll loop it tuned was
  // removed with the hosted backend. The key is retained (same reasoning as
  // backgroundPosters below) so consumers reading it keep working through
  // the deprecation window.
  env: Record<string, string | null>;
  state: {
    disabled: boolean;
    /** Result of pre-parsing state.json, mirroring the text path's STATE
     *  section. "disabled" means persistence is off; the other values come
     *  straight from peekStateFile. WITHOUT this, loadState's swallow-and-
     *  return-empty behaviour made a corrupt file look healthy-and-fresh. */
    status: "disabled" | "ok" | "missing" | "malformed" | "stale-version" | "unreadable";
    /** Parse / read error message for the malformed + unreadable cases,
     *  or the on-disk schema version for stale-version. Null otherwise. */
    detail: string | null;
    path: string | null;
    savedAt: string | null;
    learningEntries: number | null;
    packHistoryEntries: number | null;
  };
  reliability: Array<{
    namespace: string;
    dispatched: number;
    succeeded: number;
    successRate: number;
    lastUsedAt: string;
  }>;
  clients: ClientProbeResult[];
  shellShadows: ShadowHit[];
  // Trial state. `cleared` is the count of expired trials swept this run
  // (the GC write side effect — runs on the --json path too, matching the
  // text path). `live` lists still-active trials with their TTL; `malformed`
  // lists marker files that failed to parse.
  trials: {
    cleared: number;
    live: Array<{ slug: string; clientName: string; clientPath: string; msUntilExpiry: number }>;
    malformed: string[];
  };
  // DEPRECATED — both members are always `null`. The background HTTP
  // posters (analytics, tool-report) that populated this were removed with
  // the hosted backend. The NESTED SHAPE is retained deliberately, not
  // flattened to a bare `null`: the latches that fed it were in-process
  // server state and `doctor` runs as a fresh process, so this block
  // already emitted `{"analytics": null, "toolReport": null}` in practice.
  // Keeping the object means `doctor --json` output is byte-identical for
  // external consumers, including anyone reading `.backgroundPosters.analytics`
  // — flattening to `null` would throw for them. Dropped in a later release.
  backgroundPosters: { analytics: null; toolReport: null };
  // oam runtime visibility: whether the oam binary is usable (installed AND
  // >= minVersion), the config-level default, and the per-server effective
  // runtime for locally-defined servers (bundles.json). Mirrors the text
  // path's OAM RUNTIME section so the oam->node silent fallback is
  // machine-readable too.
  oamRuntime: {
    binary: string | null;
    version: string | null;
    belowMin: boolean;
    minVersion: string;
    /** Why a PRESENT oam produced no usable binary ("timeout" / "exit" /
     *  "spawn"), or null. Null covers BOTH a healthy oam and an absent one --
     *  absence is `binary: null` with `failure: null`. Without this pair a
     *  wedged binary was indistinguishable from one that was never installed,
     *  so support read `binary: null` and told the user to install oam. */
    failure: OamProbeFailure | null;
    /** The underlying error message behind `failure`, or null. */
    failureDetail: string | null;
    defaultRuntime: "oam" | "node" | null;
    defaultRuntimeSource: "env" | "bundles" | null;
    defaultRuntimePath: string | null;
    servers: Array<{ namespace: string; runtime: "oam" | "node" | null; reason: string }>;
    /** The managed install (`yaw-mcp sidecars install`): where it lives, and
     *  the version of each configured package in it. A null version means the
     *  package is not in the managed tree, so that server resolves from the
     *  npx cache instead. This is the version an oam-hosted sidecar will
     *  ACTUALLY run -- bundles.json only says "@latest" and oam cannot
     *  re-resolve it, so nothing else reports this. `packages` is empty when
     *  no npx-launched server is configured. */
    managed: { root: string; packages: Array<{ pkg: string; version: string | null }> };
  };
  upgrade: { current: string; latest: string | null; stale: boolean };
  diagnosis: { exitCode: number; summary: string };
}

export interface ClientProbeResult {
  clientId: InstallClientId;
  scope: InstallScope;
  path: string;
  exists: boolean;
  hasMcpEntry: boolean;
  /** Pre-rename `"mcp.hosting"` key still in the container. Surfaced so
   *  upgraded users know to trim by hand — nothing in the runtime writes
   *  this key anymore. */
  hasLegacyEntry: boolean;
  /** The specific legacy entry key found (e.g. "mcp.hosting" / "yaw-mcp"), or
   *  null. Lets the status line name the stale key in the trim hint. */
  legacyEntryName: string | null;
  malformed: boolean;
  unavailable: boolean;
  /** An absolute launch `command` in the entry that no longer exists on disk,
   *  or null. Only absolute paths are checked -- a bare "npx"/"cmd" is
   *  PATH-resolved and cannot be verified cheaply. This catches the failure
   *  mode an absolute entry introduces: `install` can write a path (an oam
   *  binary, a global node_modules entry), and if that later moves or is
   *  uninstalled the client cannot start the broker AT ALL, where the npx
   *  entry would simply have kept working. */
  launchCommandMissing: string | null;
  /** What the WRITTEN entry will launch the broker on: "oam" when its command
   *  is an oam binary, "node" for the npx/node/cmd shapes, null when there is
   *  no entry. Derived from the config, not from this process -- `yaw-mcp
   *  doctor` in a shell runs on node even when the configured entry uses oam,
   *  so the running process cannot answer "did my install put the broker on
   *  oam?". The config can. */
  launchRuntime: "oam" | "node" | null;
  /** A BARE oam launch command in the entry (`"command": "oam"`), or null.
   *  Distinct from launchCommandMissing, which only inspects ABSOLUTE paths and
   *  therefore cannot see this one. `install` used to write it; a bare name
   *  resolves against the client's PATH, which a GUI-launched client does not
   *  inherit from the shell, so the broker fails to start with no fallback.
   *  Existing configs still carry it, so doctor reports it. */
  launchOamNotAbsolute: string | null;
  /** The absolute `oam run` entry path in the entry that no longer exists, or
   *  null. oam has no fetch-on-demand, so unlike the npx shape a stale entry
   *  here cannot be recovered at launch. */
  launchOamEntryMissing: string | null;
}

export interface DoctorResult {
  exitCode: number;
  /** Lines printed to stdout, in order — exposed for tests. */
  lines: string[];
  /** Structured snapshot of what doctor inspected. */
  snapshot: {
    version: string;
    config: ResolvedConfig;
    clients: ClientProbeResult[];
  };
}

// __VERSION__ is substituted at build time by tsup; guard for unbundled
// source (tests) where the declare keeps it undefined.
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

// The YAW_MCP_DISABLE_PERSISTENCE predicate is imported from persistence.ts,
// which owns the state file the flag disables. Doctor used to keep its own
// copy (as did server.ts and reset-learning-cmd.ts); doctor passes its INJECTED
// `env` rather than process.env, which is why the shared one takes an env.
// All four of doctor's own uses -- the STATE/RELIABILITY pair on each of the
// text and json paths -- go through it, so no section can read state.json while
// another treats persistence as off.

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  if (opts.json) return runDoctorJson(opts);

  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const os = opts.os ?? CURRENT_OS;
  const env = opts.env ?? process.env;

  print(`yaw-mcp doctor — ${new Date().toISOString()}`);
  print(`yaw-mcp version: ${VERSION}`);
  print(`platform: ${os}`);
  print("");

  const config = await loadYawMcpConfig({ cwd, home, env });
  // Project-trust gate (see trust.ts). Folded into config.warnings so it
  // renders in WARNINGS, hits the always-on stderr stream, and drives the
  // exit-2 gate like every other warning.
  const trustProbe = await probeProjectTrust({ cwd, home, env }).catch(() => null);
  const trustWarning = projectTrustWarning(trustProbe);
  if (trustWarning) config.warnings = [...config.warnings, trustWarning];

  print("CONFIG FILES");
  if (config.loadedFiles.length === 0) {
    print("  (none — using defaults + env)");
  } else {
    for (const f of config.loadedFiles) {
      print(`  ${f.scope.padEnd(7)} ${f.path}${schemaSuffix(f)}`);
    }
  }
  print("");

  // Project YAW-MCP.md that reaches the model from an unapproved project dir
  // (see guide.ts). Informational, NOT folded into config.warnings: the setup
  // is legitimate, so it must not drive exit 2 the way the bundles gate does.
  const projectGuide = await loadProjectGuide(cwd, home, env).catch(() => null);
  renderProjectGuideSection({ guide: projectGuide, print });

  // Behavior-modifier env vars that yaw-mcp actually reads at runtime.
  // Surfaced here so support diagnostics can see at a glance whether an
  // override is active (e.g., "my auto-load isn't working" — doctor
  // says AUTO_LOAD is not set). DISABLE_PERSISTENCE has its own dedicated
  // section and is intentionally omitted.
  renderEnvSection({ env, print });

  // oam runtime visibility — which runtime each server would ACTUALLY get
  // (oam vs node) and why. The oam spawn-rewrite falls back to node
  // silently by design (oam absent / below min / non-node command), so
  // this section is where that fallback becomes visible.
  const oamStatus = await collectOamRuntimeStatus({ env, cwd, home, probeFn: opts.oamProbe ?? probeOam });
  // bundles.json diagnostics (unparseable file, bad schema version, invalid
  // defaultRuntime, skipped server entries) come back from the loader the
  // collector already ran. They were DISCARDED here, which is how a hand-edited
  // bundles.json that no longer parses -- every server gone -- still printed
  // "All good" and exited 0. See foldBundleWarnings.
  config.warnings = [...config.warnings, ...foldBundleWarnings(oamStatus.bundleWarnings, trustProbe)];
  renderOamRuntimeSection({ status: oamStatus, print });

  // Load state.json ONCE for both the STATE and RELIABILITY sections.
  // Previously each section re-read the file (peek + loadState in STATE,
  // loadState again in RELIABILITY = up to 3 reads/run), which was wasted
  // I/O and opened a small TOCTOU window between reads. Skip the read
  // entirely when persistence is disabled.
  const persistenceDisabled = isPersistenceDisabled(env);
  const stateFilePath = join(userConfigDir(home), STATE_FILENAME);
  const statePeek: StatePeek | null = persistenceDisabled ? null : await peekStateFile(stateFilePath);
  const persistedState = statePeek?.kind === "ok" ? await loadState(stateFilePath) : null;

  // Persisted cross-session state — ~/.yaw-mcp/state.json. Shows whether
  // persistence is disabled by env, and otherwise reports the file path
  // + how fresh the snapshot is + how much signal it carries.
  renderStateSection({
    filePath: stateFilePath,
    disabled: persistenceDisabled,
    persisted: persistedState,
    peek: statePeek,
    print,
  });

  // Reliability roll-up — pulls flaky namespaces from the same
  // state.json the STATE section introspected. Same definition as the
  // cross-session block in mcp_connect_health, so "flaky" means the
  // same thing whether you check via the LLM or via the CLI.
  renderReliabilitySection({ disabled: persistenceDisabled, persisted: persistedState, print });

  // Trial GC + live-trial readout. Runs the expired-trial sweep first
  // so the readout shows the post-GC state (no stale "expired" rows
  // hanging around). Best-effort: any sweep failure is logged via
  // try-cmd's debug logger; doctor itself never errors out on it.
  await renderTrialsSection({ home, env, print, postEvent: opts.postTryEvent, now: opts.now });

  // Probe every supported client/scope combo on the current OS. Honor
  // CLAUDE_CONFIG_DIR so doctor sees the same file Claude Code reads
  // when run inside a wrapper (Yaw Mode, dev container with the env set).
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const clients = probeClients({ home, os, cwd, claudeConfigDir });
  print("INSTALLED CLIENTS (probed config files)");
  for (const c of clients) {
    const installCmd = `yaw-mcp install ${c.clientId}${c.scope === "user" ? "" : ` --scope ${c.scope}`}`;
    const status = renderClientStatus(c, installCmd);
    const label = INSTALL_TARGETS.find((t) => t.clientId === c.clientId)?.label ?? c.clientId;
    print(`  ${label} (${c.scope}): ${status}`);
    print(`    ${c.path}`);
  }
  print("");

  if (config.warnings.length > 0) {
    print("WARNINGS");
    for (const w of config.warnings) print(`  ! ${w}`);
    print("");
  }

  // Shell-history CLI-shadow scan. Reads recent bash/zsh/PowerShell
  // history lines and flags any that invoked a CLI an MCP server
  // shadows (per the static registry in cli-shadows.ts). Non-fatal —
  // purely informational. History files may not exist, may be
  // unreadable, or may use a format we can't parse; any failure is
  // silently skipped and this section is omitted.
  const shadowHits = scanShellHistoryForShadows({ home, env });
  if (shadowHits.length > 0) {
    print("SHADOWED CLI USAGE (recent shell history)");
    print("  Commands below have MCP servers that can replace them;");
    print("  activate the server and prefer its tools over the CLI.");
    for (const hit of shadowHits) {
      const pluralHit = hit.count === 1 ? "time" : "times";
      print(`  ${hit.cli.padEnd(12)} ${hit.count} ${pluralHit} → server(s): ${hit.namespaces.join(", ")}`);
    }
    print("");
  }

  // Freshness check: is this binary behind the npm registry? Skip in
  // source ("dev") mode and absorb any network error silently — a
  // stale-version warning that depends on an external service must not
  // block the diagnostic. Times out after DOCTOR_REGISTRY_TIMEOUT_MS to keep
  // doctor snappy -- see that constant for why doctor's budget is shorter than
  // upgrade's.
  // Auto-skipped under vitest (check process.env directly since tests
  // pass a stripped `env: {}`).
  // skipRegistryCheck=true or VITEST env both suppress the real registry
  // fetch. But if a registryFetch hook is explicitly provided (test hook
  // for the upgrade-hint branches), we honour it regardless of VITEST so
  // the hint branches are actually reachable under vitest.
  // NOTE: this is the ONE deliberate process.env read in doctor (the rest
  // route through opts.env). Tests pass a stripped `env: {}`, so VITEST
  // would never be visible via opts.env; reading process.env directly is
  // what lets the auto-skip fire under vitest. Kept intentional.
  const skipCheck = (opts.skipRegistryCheck === true || Boolean(process.env.VITEST)) && !opts.registryFetch;
  const latest = skipCheck
    ? null
    : await fetchLatestVersion({ timeoutMs: DOCTOR_REGISTRY_TIMEOUT_MS, override: opts.registryFetch });
  const effectiveVersion = opts.currentVersion ?? VERSION;
  const staleHint = latest && effectiveVersion !== "dev" && compareSemver(effectiveVersion, latest) < 0 ? latest : null;
  if (staleHint) {
    // Method-aware so the hint is always the user's TERMINAL action --
    // never a command that turns around and prints another command.
    // Refinement consults `npm prefix -g` for the ambiguous methods
    // (auto-skipped under vitest; see refineInstallMethod).
    const effectiveArgvPath = opts.argvPath ?? process.argv[1];
    const method = (await detectSea())
      ? "binary"
      : await refineInstallMethod(detectInstallMethod(effectiveArgvPath), effectiveArgvPath);
    print("UPGRADE AVAILABLE");
    if (method === "bundled-app") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. This copy ships inside`);
      print("  Yaw Terminal and updates with the app — update Yaw Terminal to get it.");
    } else if (method === "npx") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. npx fetches the latest`);
      print("  on each spawn — restart your MCP client to pick it up.");
    } else if (method === "binary") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. This is a standalone`);
      print("  binary — download the latest build and replace the executable:");
      print(`    ${BINARY_DOWNLOAD_URL}`);
    } else if (
      method === "global-npm" ||
      method === "pnpm-global" ||
      method === "bun-global" ||
      method === "local-node-modules"
    ) {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. To upgrade in place:`);
      print("");
      print("    yaw-mcp upgrade --run");
    } else {
      const plan = buildUpgradePlan({ current: effectiveVersion, latest: staleHint, method });
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. To upgrade:`);
      print("");
      print(`    ${plan.command ?? "npm install -g @yawlabs/mcp@latest"}`);
    }
    print("");
  }

  let exitCode = 0;
  // Warnings are emitted to stderr UNCONDITIONALLY so a pipeline that
  // captures only stdout still sees them. The text WARNINGS section above
  // is part of the human report (stdout); the stderr stream below is the
  // always-on signal.
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErr(`warning: ${w}\n`);
  }
  // Any warning is exit 2. See the exit-code note at the top of this file:
  // this gate must stay unconditional. The old form ran the warning branch
  // only when a token was resolved, so once account mode went away a
  // malformed config would have exited 0 with the warnings buried.
  if (config.warnings.length > 0) {
    exitCode = 2;
    print("DIAGNOSIS");
    print("  Warnings above need attention.");
  } else {
    print("DIAGNOSIS");
    print(
      staleHint ? "  Healthy, but an upgrade is available (see above)." : "  All good. yaw-mcp should start cleanly.",
    );
  }

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// JSON counterpart to runDoctor. Same data-collection sequence, no
// print calls — emits a single JSON blob so pipelines and dashboards
// can consume the diagnostic without parsing the text layout. Token is
// always fingerprinted, never raw, matching the text renderer's rule.
async function runDoctorJson(opts: DoctorOptions): Promise<DoctorResult> {
  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const os = opts.os ?? CURRENT_OS;
  const env = opts.env ?? process.env;

  const timestamp = new Date().toISOString();
  const config = await loadYawMcpConfig({ cwd, home, env });
  // Same project-trust fold as the text path, so `doctor --json` reports the
  // gate in `.warnings` and exits 2 identically.
  const trustProbe = await probeProjectTrust({ cwd, home, env }).catch(() => null);
  const trustWarning = projectTrustWarning(trustProbe);
  if (trustWarning) config.warnings = [...config.warnings, trustWarning];
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const clients = probeClients({ home, os, cwd, claudeConfigDir });

  // Same project-guide probe as the text path's PROJECT GUIDE section.
  const guide = await loadProjectGuide(cwd, home, env).catch(() => null);
  const projectGuide: DoctorJsonSnapshot["projectGuide"] = guide
    ? { path: guide.path, unapproved: guide.unapproved === true }
    : null;

  const envVarNames = [
    "YAW_MCP_SERVER_CAP",
    "YAW_MCP_MIN_COMPLIANCE",
    "YAW_MCP_AUTO_LOAD",
    "YAW_MCP_AUTO_ACTIVATE",
    "YAW_MCP_PRUNE_RESPONSES",
    "YAW_MCP_DEFAULT_RUNTIME",
  ] as const;
  // DEPRECATED key, seeded first so it keeps its position in the emitted
  // object. YAW_MCP_POLL_INTERVAL configured the remote config poll loop,
  // which went with the hosted backend; nothing reads the var any more, so
  // it reports null even when it IS set. The key survives the deprecation
  // window so `.env.YAW_MCP_POLL_INTERVAL` consumers don't break on a
  // missing property. Dropped in a later release.
  const envOverrides: Record<string, string | null> = { YAW_MCP_POLL_INTERVAL: null };
  for (const name of envVarNames) {
    const raw = env[name];
    envOverrides[name] = raw === undefined || raw === "" ? null : raw;
  }

  // STATE + RELIABILITY section data. Load state.json ONCE for both
  // (previously loaded twice here). YAW_MCP_DISABLE_PERSISTENCE
  // short-circuits to a null read; otherwise we read the file a single
  // time and thread it into both blocks.
  //
  // The peek runs FIRST, exactly like the text path: loadState swallows a
  // parse error and hands back an empty state, so a corrupt / stale-schema /
  // unreadable state.json used to be reported here as healthy-and-fresh
  // while `doctor` (text) called it out as corrupt. Same detection now.
  const persistDisabled = isPersistenceDisabled(env);
  const stateFilePath = join(userConfigDir(home), STATE_FILENAME);
  const statePeek: StatePeek | null = persistDisabled ? null : await peekStateFile(stateFilePath);
  const stateUsable = statePeek !== null && (statePeek.kind === "ok" || statePeek.kind === "missing");
  const persisted = stateUsable ? await loadState(stateFilePath) : null;
  const state: DoctorJsonSnapshot["state"] = ((): DoctorJsonSnapshot["state"] => {
    if (persistDisabled || statePeek === null) {
      return {
        disabled: true,
        status: "disabled",
        detail: null,
        path: null,
        savedAt: null,
        learningEntries: null,
        packHistoryEntries: null,
      };
    }
    if (!stateUsable || !persisted) {
      return {
        disabled: false,
        status: statePeek.kind,
        detail: statePeekDetail(statePeek),
        path: stateFilePath,
        savedAt: null,
        learningEntries: null,
        packHistoryEntries: null,
      };
    }
    const fresh = persisted.savedAt === 0;
    return {
      disabled: false,
      status: statePeek.kind,
      detail: null,
      path: stateFilePath,
      savedAt: fresh ? null : new Date(persisted.savedAt).toISOString(),
      learningEntries: fresh ? 0 : Object.keys(persisted.learning).length,
      packHistoryEntries: fresh ? 0 : persisted.packHistory.length,
    };
  })();

  // Reliability rollup — same selectFlakyNamespaces path as renderReliabilitySection
  // and mcp_connect_health, so all three surfaces agree on "flaky."
  const reliability: DoctorJsonSnapshot["reliability"] = [];
  if (!persistDisabled && persisted) {
    if (persisted.savedAt !== 0) {
      const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
      for (const { namespace, usage } of selectFlakyNamespaces(entries, 5)) {
        reliability.push({
          namespace,
          dispatched: usage.dispatched,
          // `succeeded` is a graded-reward SUM (learning.ts), so adding [0,1]
          // rewards can leave IEEE-754 noise (e.g. 48.00000000000001). Round for
          // a clean diagnostic; successRate stays computed from the raw value.
          succeeded: Math.round(usage.succeeded * 1000) / 1000,
          successRate: usage.succeeded / usage.dispatched,
          lastUsedAt: new Date(usage.lastUsedAt).toISOString(),
        });
      }
    }
  }

  const shellShadows = scanShellHistoryForShadows({ home, env });

  // Trial GC + readout. The --json path MUST run gcExpiredTrials too, so
  // `doctor` and `doctor --json` have the SAME persistent side effects
  // (peel expired entries out of client configs, delete markers, fire the
  // expiry-gc telemetry). Previously the JSON path returned early and
  // skipped GC entirely, leaving expired trials wired up. Best-effort:
  // any sweep failure is swallowed, matching renderTrialsSection.
  // Scan once, then hand the scan to the GC pass so the trials dir isn't
  // read twice (GC only unlinks expired markers, so live/malformed in this
  // pre-sweep scan match the post-sweep readout state).
  const trialScan = await scanTrials({ home, now: opts.now });
  const trialGc = await gcExpiredTrials({
    home,
    env,
    postEvent: opts.postTryEvent,
    now: opts.now,
    scan: trialScan,
  }).catch(() => ({ cleared: 0, failed: 0 }));
  const trials: DoctorJsonSnapshot["trials"] = {
    cleared: trialGc.cleared,
    live: trialScan.live.map(({ marker, msUntilExpiry }) => ({
      slug: marker.slug,
      clientName: marker.clientName,
      clientPath: marker.clientPath,
      msUntilExpiry,
    })),
    malformed: trialScan.malformed,
  };

  // oam runtime block — same collector as the text path's OAM RUNTIME
  // section, so the two surfaces can't drift.
  const oamStatus = await collectOamRuntimeStatus({ env, cwd, home, probeFn: opts.oamProbe ?? probeOam });
  // Identical fold to the text path -- a malformed bundles.json must reach
  // `.warnings` and exit 2 on both surfaces.
  config.warnings = [...config.warnings, ...foldBundleWarnings(oamStatus.bundleWarnings, trustProbe)];
  const oamRuntime: DoctorJsonSnapshot["oamRuntime"] = {
    binary: oamStatus.probe.bin,
    version: oamStatus.probe.version,
    belowMin: oamStatus.probe.belowMin,
    minVersion: MIN_OAM_VERSION,
    failure: oamStatus.probe.failure,
    failureDetail: oamStatus.probe.failureDetail,
    defaultRuntime: oamStatus.dflt.runtime,
    defaultRuntimeSource: oamStatus.dflt.source,
    defaultRuntimePath: oamStatus.dflt.path,
    servers: oamStatus.servers.map((s) => ({
      namespace: s.namespace,
      runtime: s.info.runtime,
      reason: s.info.reason,
    })),
    // Mirrored, not dropped. collectOamRuntimeStatus already pays for these
    // reads on both paths, and the text renderer has always printed them --
    // emitting only on the text path made the shared-collector claim above
    // false and hid the one machine-level fact from every --json consumer.
    managed: oamStatus.managed,
  };

  // DEPRECATED key, emitted with its original nested shape (both members
  // null) so `doctor --json` output is unchanged for consumers during the
  // deprecation window. See DoctorJsonSnapshot.backgroundPosters.
  const backgroundPosters: DoctorJsonSnapshot["backgroundPosters"] = { analytics: null, toolReport: null };

  // Mirrors the text path's hook handling (see runDoctor): an explicit
  // registryFetch bypasses the VITEST guard, and currentVersion overrides
  // the build-time VERSION. opts.argvPath is intentionally unused here --
  // the JSON snapshot's upgrade block carries no install method.
  // The process.env.VITEST read here is the same deliberate exception
  // documented on the text path's skipCheck above (opts.env is stripped
  // to `{}` under vitest, so VITEST is only visible via process.env).
  const skipCheck = (opts.skipRegistryCheck === true || Boolean(process.env.VITEST)) && !opts.registryFetch;
  const latest = skipCheck
    ? null
    : await fetchLatestVersion({ timeoutMs: DOCTOR_REGISTRY_TIMEOUT_MS, override: opts.registryFetch });
  const effectiveVersion = opts.currentVersion ?? VERSION;
  const stale = latest !== null && effectiveVersion !== "dev" && compareSemver(effectiveVersion, latest) < 0;

  let exitCode = 0;
  let summary: string;
  // Always-on warning stream: mirrors the text path so JSON-mode pipelines
  // that capture stdout (the JSON blob) still surface config warnings on
  // stderr even when the exit code is 0.
  const writeErrJson = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErrJson(`warning: ${w}\n`);
  }
  // Unconditional warning gate, identical to the text path.
  if (config.warnings.length > 0) {
    exitCode = 2;
    summary = "Warnings need attention.";
  } else {
    summary = stale ? "Healthy, but an upgrade is available." : "All good. yaw-mcp should start cleanly.";
  }

  const snapshotJson: DoctorJsonSnapshot = {
    timestamp,
    version: VERSION,
    platform: os,
    // DEPRECATED keys, emitted with their original nested shape and null
    // members so `doctor --json` stays parseable for consumers reading
    // `.token.source` / `.apiBase.value`. See DoctorJsonSnapshot.
    token: { fingerprint: null, source: null },
    apiBase: { value: null, source: null },
    loadedFiles: config.loadedFiles.map((f) => ({
      scope: f.scope,
      path: f.path,
      ...(f.version !== undefined ? { schemaVersion: f.version } : {}),
      schemaAhead: f.version !== undefined && f.version > CURRENT_SCHEMA_VERSION,
    })),
    projectGuide,
    warnings: config.warnings,
    env: envOverrides,
    state,
    reliability,
    clients,
    shellShadows,
    trials,
    backgroundPosters,
    oamRuntime,
    upgrade: { current: effectiveVersion, latest, stale },
    diagnosis: { exitCode, summary },
  };

  const blob = JSON.stringify(snapshotJson, null, 2);
  lines.push(blob);
  write(`${blob}\n`);

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// Prints the STATE section. Broken out so the control flow in
// runDoctor stays linear — this is already the third file-reading
// section (config, client probes, history scan).
// Enumerates the behavior-modifier env vars yaw-mcp actually reads so a
// support ticket can paste doctor output and we can tell at a glance
// which knobs are turned on. Leaves TOKEN / URL / DISABLE_PERSISTENCE
// to their dedicated sections (they have richer context there).
//
// The "default when unset" hint next to each unset value is the most
// useful bit — without it users don't know what the omission means.
function renderEnvSection(opts: { env: NodeJS.ProcessEnv; print: (s?: string) => void }): void {
  const { env, print } = opts;
  const vars: Array<{ name: string; defaultHint: string }> = [
    { name: "YAW_MCP_SERVER_CAP", defaultHint: "default 6" },
    { name: "YAW_MCP_MIN_COMPLIANCE", defaultHint: "filter inactive" },
    { name: "YAW_MCP_AUTO_LOAD", defaultHint: "auto-load inactive" },
    { name: "YAW_MCP_AUTO_ACTIVATE", defaultHint: "default on" },
    { name: "YAW_MCP_PRUNE_RESPONSES", defaultHint: "pruning active" },
    { name: "YAW_MCP_DEFAULT_RUNTIME", defaultHint: "oam when installed" },
  ];
  const widest = vars.reduce((m, v) => Math.max(m, v.name.length), 0);
  print("ENVIRONMENT (behavior overrides)");
  for (const v of vars) {
    const raw = env[v.name];
    const value = raw === undefined || raw === "" ? `(not set — ${v.defaultHint})` : raw;
    print(`  ${v.name.padEnd(widest)}  ${value}`);
  }
  print("");
}

// Everything the OAM RUNTIME section (text) / oamRuntime block (json) needs,
// collected once so the two paths can't drift: the binary probe, the
// config-level default (+ provenance), and a per-server verdict for every
// configured server. The list covers bundles.json because bundles.json is now
// the ONLY server source -- account mode is gone (`yaw-mcp servers` is a
// deprecated stub that always exits 1), so there is no second source of server
// definitions for this section to be missing.
interface OamRuntimeStatus {
  probe: OamProbe;
  dflt: DefaultRuntimeInfo;
  /** `command` rides along so the renderer can qualify an `oam` verdict for an
   *  `npx` server: describeServerRuntime deliberately does not probe package
   *  resolution (it would make doctor flap), but rewriteForOam DOES, and keeps
   *  npx when the package is on disk nowhere. */
  servers: Array<{ namespace: string; command: string | undefined; info: ServerRuntimeInfo }>;
  /** The managed install (`yaw-mcp sidecars install`): where it is, and the
   *  version of each package in it. Empty when it has never been run. */
  managed: { root: string; packages: Array<{ pkg: string; version: string | null }> };
  /** Diagnostics from the bundles.json read (unparseable file, schema ahead,
   *  invalid defaultRuntime, skipped entries). The caller folds these into
   *  config.warnings -- see foldBundleWarnings. */
  bundleWarnings: string[];
}

async function collectOamRuntimeStatus(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  // Accepts sync OR async so doctor's own test fixtures can keep passing a
  // plain object while production passes the async probeOam (issue #91).
  probeFn: () => OamProbe | Promise<OamProbe>;
}): Promise<OamRuntimeStatus> {
  const probe = await opts.probeFn();
  // `env` is threaded through so the loader's trust gate sees the SAME
  // environment doctor's own probeProjectTrust does. Without it the loader read
  // process.env while doctor read opts.env, and the two could disagree about
  // whether the project file is honoured -- which would print a bypass warning
  // and an "IGNORED" warning about the same file in the same report.
  const bundles = await loadLocalBundles({ cwd: opts.cwd, home: opts.home, env: opts.env }).catch(() => null);
  // Hand describeDefaultRuntime the load we just did instead of letting it do
  // its own -- it reads the SAME file. Two reads was not merely wasteful: the
  // loader warns on a bundles.json it cannot parse, so a malformed file logged
  // "bundles.json is not valid JSON" TWICE per doctor run. Passing null when the
  // load failed is the same answer it would have reached itself (its own catch
  // collapses a failed load to null), so the resolution is unchanged.
  const dflt = await describeDefaultRuntime({ env: opts.env, cwd: opts.cwd, home: opts.home, bundles });
  const servers = (bundles?.config?.servers ?? []).map((s) => ({
    namespace: s.namespace,
    command: s.command,
    info: describeServerRuntime(s, dflt.runtime, probe),
  }));
  // Report the version actually installed for each package the config asks
  // for -- that is the number an oam-hosted server will run, and the one thing
  // the config file itself cannot tell you.
  const specs = collectSidecarSpecs(bundles?.config?.servers ?? []);
  // Skip the per-package reads entirely when the tree was never created --
  // `sidecars install` is opt-in, so "never run" is the common case, and each
  // package would otherwise cost a stat + read + JSON.parse that can only come
  // back null.
  const anyManaged = hasManagedSidecars(opts.home);
  const managed = {
    root: sidecarsRoot(opts.home),
    packages: specs.map((s) => ({ pkg: s.pkg, version: anyManaged ? installedVersion(s.pkg, opts.home) : null })),
  };
  return { probe, dflt, servers, managed, bundleWarnings: bundles?.warnings ?? [] };
}

function renderOamRuntimeSection(opts: { status: OamRuntimeStatus; print: (s?: string) => void }): void {
  const { status, print } = opts;
  const { probe, dflt, servers } = status;
  print("OAM RUNTIME");
  if (probe.belowMin) {
    print(`  binary:  installed (v${probe.version}) — below min ${MIN_OAM_VERSION}; IGNORED, servers run on node`);
    // The floor tracks the latest oam release, so "below min" is always
    // "out of date" rather than "wrong build" -- and oam updates itself in
    // place. Naming the one command that fixes it beats re-running an
    // installer that has to be looked up.
    print("           fix: oam self-update");
  } else if (probe.failure !== null) {
    // PRESENT but unusable. This used to print "not installed", which sent a
    // user who has oam installed (and often OAM_BIN set at it) off to install
    // it again, while the real cause -- a binary that wedges or errors on
    // --version -- appeared only as a raw JSON log line on stderr.
    print(`  binary:  installed but UNUSABLE (${oamFailureLabel(probe.failure)}); servers run on node`);
    if (probe.failureDetail !== null) print(`           detail: ${probe.failureDetail}`);
    print("           fix: run `oam --version` by hand; OAM_BIN overrides which binary is probed");
  } else if (probe.bin === null) {
    print("  binary:  not installed — node/npx spawns are used directly");
  } else if (probe.version === null) {
    // A working --version proves oam exists, so the probe treats an
    // unparseable version as usable and hosts on it (oam-spawn.ts) -- but the
    // MIN_OAM_VERSION floor is gated on a parsed version, so it never ran.
    // Rendering this as "(vunknown, min 0.8.3)" read exactly like a version
    // that PASSED the floor, which is the one thing this line must not do.
    print(`  binary:  ${probe.bin} (version unparseable -- min ${MIN_OAM_VERSION} NOT verified, hosting anyway)`);
  } else {
    print(`  binary:  ${probe.bin} (v${probe.version}, min ${MIN_OAM_VERSION})`);
  }
  // What THIS process runs on. Meaningful when doctor is called as a tool
  // through the broker (same process), and explicitly labelled so it is not
  // mistaken for what a client's configured entry will launch -- `yaw-mcp
  // doctor` typed into a shell runs on node no matter what the entry says.
  // The per-client "(runs on oam)" marker in CLIENTS answers that one.
  // Guarded, not just cast: process.versions is another runtime's surface, and
  // an unexpected shape would otherwise render "[object Object]" into the one
  // line whose whole job is to be trustworthy.
  const rawOamVersion = (process.versions as Record<string, unknown>).oam;
  const runningOam = typeof rawOamVersion === "string" && rawOamVersion.length > 0 ? rawOamVersion : null;
  print(`  this process: ${runningOam ? `oam ${runningOam}` : `node ${process.version}`}`);
  // Name the exact source: the connect path resolves project-local bundles
  // from the BROKER's cwd, doctor from the shell's cwd — printing the file
  // path makes a divergence between the two spottable.
  const dfltLabel =
    dflt.runtime !== null
      ? `${dflt.runtime} (${dflt.source === "env" ? "env YAW_MCP_DEFAULT_RUNTIME" : `bundles.json defaultRuntime @ ${dflt.path}`})`
      : `(not set — oam when installed, currently ${probe.bin !== null ? "oam" : "node"})`;
  print(`  default runtime: ${dfltLabel}`);
  if (servers.length > 0) {
    print("  servers (local bundles.json):");
    const widest = servers.reduce((m, s) => Math.max(m, s.namespace.length), 0);
    for (const s of servers) {
      print(`    ${s.namespace.padEnd(widest)}  ${(s.info.runtime ?? "-").padEnd(4)}  ${s.info.reason}`);
    }
    // An `oam` verdict for an npx server is conditional in a way the verdict
    // itself cannot express: the spawn rewrite needs a real on-disk entry
    // (oam has no fetch-on-demand), so a package present in no node_modules
    // and no npx cache stays on npx/node. describeServerRuntime deliberately
    // does not probe that -- it depends on the caches at spawn time and would
    // make this section flap -- so say it once here instead of claiming oam
    // unconditionally.
    // nodeLaunchKind, not `=== "npx"`: an absolute `/usr/local/bin/npx` or a
    // `npx.cmd` shim is the same launch and needs the same caveat.
    const anyNpxOnOam = servers.some(
      (s) => s.info.runtime === "oam" && s.command !== undefined && nodeLaunchKind(s.command) === "npx",
    );
    if (anyNpxOnOam) {
      print("    note: an npx server reaches oam only once its package is on disk (managed");
      print("          tree or npx cache); until then the spawn stays on npx/node.");
    }
  }
  // Which VERSION each sidecar will run. An oam-hosted server runs a copy from
  // disk and cannot re-resolve "@latest" the way npx did, so the version is a
  // fact about this machine that nothing else reports.
  const { managed } = status;
  if (managed.packages.length > 0) {
    const anyInstalled = managed.packages.some((p) => p.version !== null);
    print(`  managed install: ${anyInstalled ? managed.root : "none — run `yaw-mcp sidecars install`"}`);
    if (anyInstalled) {
      const widest = managed.packages.reduce((m, p) => Math.max(m, p.pkg.length), 0);
      for (const p of managed.packages) {
        // Says what was actually CHECKED. The old wording ("resolves from the
        // npx cache") asserted a lookup doctor never performs -- nothing here
        // reads any npx cache -- and was wrong whenever the package sits in no
        // cache either, which is the case that keeps the server on npx/node.
        print(`    ${p.pkg.padEnd(widest)}  ${p.version ?? "not in the managed tree"}`);
      }
    }
  }
  print("");
}

// PROJECT GUIDE section — printed ONLY when a project-scoped YAW-MCP.md is
// being served from a directory whose bundles.json is not approved. An
// approved (or absent) project guide is silent, matching the
// silence-on-empty convention of the reliability / trials sections.
function renderProjectGuideSection(opts: { guide: GuideFile | null; print: (s?: string) => void }): void {
  const notice = projectGuideNotice(opts.guide);
  if (!notice) return;
  opts.print("PROJECT GUIDE");
  // Same `  ! ` shape as the WARNINGS section so it reads as a flag, even
  // though it deliberately does not feed the exit code.
  opts.print(`  ! ${notice}`);
  opts.print("");
}

function renderStateSection(opts: {
  filePath: string;
  disabled: boolean;
  /** State loaded once by the caller; null iff persistence is disabled. */
  persisted: Awaited<ReturnType<typeof loadState>> | null;
  /** Peek result hoisted to the caller to avoid re-reading state.json. */
  peek: StatePeek | null;
  print: (s?: string) => void;
}): void {
  const { filePath, disabled, persisted, peek, print } = opts;
  print("STATE");
  if (disabled || !peek) {
    if (disabled) print("  status: disabled via YAW_MCP_DISABLE_PERSISTENCE");
    print("");
    return;
  }
  print(`  path:   ${filePath}`);
  if (peek.kind === "malformed") {
    print("  status: corrupt -- file exists but JSON is unparseable");
    print(`  fix:    \`yaw-mcp reset-learning\` to clear, or open ${filePath} and fix by hand`);
    print(`  detail: ${peek.message}`);
    print("");
    return;
  }
  if (peek.kind === "stale-version") {
    print(`  status: schema mismatch (file is v${peek.version ?? "?"}, this yaw-mcp reads v${peek.expected})`);
    print("  fix:    `yaw-mcp reset-learning` to drop the old file -- learning will rebuild on use");
    print("");
    return;
  }
  if (peek.kind === "unreadable") {
    print(`  status: unreadable (${peek.message})`);
    print("");
    return;
  }
  // persisted is non-null here: the caller only passes null when
  // persistence is disabled, which the `disabled` branch above handled.
  if (!persisted || persisted.savedAt === 0) {
    print("  (no persisted state yet — will be created on the first tool call)");
  } else {
    print(`  last saved:           ${formatRelativeAge(Date.now() - persisted.savedAt)} ago`);
    print(`  learning entries:     ${Object.keys(persisted.learning).length}`);
    print(`  pack history entries: ${persisted.packHistory.length}`);
  }
  print("");
}

type StatePeek =
  | { kind: "missing" }
  | { kind: "ok" }
  | { kind: "malformed"; message: string }
  | { kind: "stale-version"; version: unknown; expected: number }
  | { kind: "unreadable"; message: string };

async function peekStateFile(filePath: string): Promise<StatePeek> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "malformed", message: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "malformed", message: "top-level value is not an object" };
  const version = (parsed as { version?: unknown }).version;
  // Readable, not identical. STATE_SCHEMA_VERSION went 1 -> 2 for the
  // additive toolCache field, and loadState MIGRATES a v1 file rather than
  // discarding it -- so an exact-equality check here would report a healthy
  // v1 file as "stale-version" for the one session before its first save
  // rewrites it at v2, while learning and packHistory were loading fine.
  if (!isReadableStateVersion(version)) {
    return { kind: "stale-version", version, expected: STATE_SCHEMA_VERSION };
  }
  return { kind: "ok" };
}

/** One-line explanation for a non-ok peek, for the --json state.detail
 *  field. The text path prints the same facts as `detail:` / `status:`
 *  lines; this keeps the two surfaces carrying the same information. */
function statePeekDetail(peek: StatePeek): string | null {
  if (peek.kind === "malformed" || peek.kind === "unreadable") return peek.message;
  if (peek.kind === "stale-version") {
    return `file is v${String(peek.version ?? "?")}, this yaw-mcp reads v${peek.expected}`;
  }
  return null;
}

// Roll up the flaky-dormant list from persisted state.json. Mirrors the
// cross-session reliability block in mcp_connect_health so the CLI
// diagnostic and the LLM-facing health tool agree on what counts as
// flaky. Silently omitted when persistence is disabled or nothing
// qualifies — no point printing an empty header.
function renderReliabilitySection(opts: {
  disabled: boolean;
  /** State loaded once by the caller; null iff persistence is disabled. */
  persisted: Awaited<ReturnType<typeof loadState>> | null;
  print: (s?: string) => void;
}): void {
  const { disabled, persisted, print } = opts;
  if (disabled || !persisted) return;
  if (persisted.savedAt === 0) return;

  const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
  const flaky = selectFlakyNamespaces(entries, 5);
  if (flaky.length === 0) return;

  print("RELIABILITY (dormant, <80% success)");
  const now = Date.now();
  for (const { namespace, usage } of flaky) {
    const rate = Math.round((usage.succeeded / usage.dispatched) * 100);
    const age = formatRelativeAge(now - usage.lastUsedAt);
    print(`  ${namespace} — ${usage.dispatched} calls, ${rate}% success, last used ${age} ago`);
  }
  print("");
}

// Trials section — runs the expired-trial GC pass first (peels each
// expired entry out of its client config + deletes the marker + fires
// the expiry-gc telemetry event), then renders the still-live trials
// with their countdown. Section is OMITTED when there are no trials
// at all so healthy installs stay quiet. Mirrors the silence-on-empty
// convention of the reliability and background-posters sections.
async function renderTrialsSection(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
  print: (s?: string) => void;
  postEvent?: (baseUrl: string, body: TryEventBody) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const { home, env, print, postEvent, now } = opts;
  // Scan once, then hand the scan to the GC pass (GC only unlinks expired
  // markers, so live/malformed here match the post-sweep readout state).
  const scan = await scanTrials({ home, now });
  const gc = await gcExpiredTrials({ home, env, postEvent, now, scan }).catch(() => ({ cleared: 0, failed: 0 }));
  if (scan.live.length === 0 && gc.cleared === 0 && scan.malformed.length === 0) return;
  print("TRIALS (yaw-mcp try)");
  if (gc.cleared > 0) {
    print(`  swept ${gc.cleared} expired trial${gc.cleared === 1 ? "" : "s"} this run`);
  }
  for (const { marker, msUntilExpiry } of scan.live) {
    print(`  ${marker.slug} -> ${marker.clientName} (${marker.clientPath}) — expires in ${formatTtl(msUntilExpiry)}`);
  }
  for (const path of scan.malformed) {
    print(`  ! malformed marker at ${path} (delete by hand)`);
  }
  print("");
}

// Compact relative age for STATE output. We'd rather show "3m" than a
// raw millisecond count; finer granularity isn't useful when the file
// is only written after a 1s debounce.
export function formatRelativeAge(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function schemaSuffix(f: LoadedConfigFile): string {
  if (f.version === undefined) return "";
  if (f.version > CURRENT_SCHEMA_VERSION)
    return ` (schema v${f.version}, this yaw-mcp supports v${CURRENT_SCHEMA_VERSION})`;
  return ` (schema v${f.version})`;
}

/** One-line status string for the CLIENTS section of doctor output.
 *  Centralises the per-state wording so the renderer in `runDoctor`
 *  doesn't carry a nested ternary tree as more states get added. */
function renderClientStatus(c: ClientProbeResult, installCmd: string): string {
  if (c.unavailable) return "unavailable on this OS";
  if (c.malformed) return "exists but JSON is malformed — fix or rerun `yaw-mcp install`";
  // Checked BEFORE the combined legacy branch: a launch command that no longer
  // exists is the one state that means the client cannot start yaw-mcp AT ALL,
  // and the combined branch used to swallow it -- a config carrying both a
  // legacy entry and a rotted absolute command reported "OK" and told the user
  // to remove the OTHER entry, leaving only the broken one. When both are true
  // the legacy trim hint is appended rather than dropped, so neither problem
  // goes unnamed.
  if (c.launchCommandMissing) {
    const legacy = c.hasLegacyEntry
      ? `; legacy "${c.legacyEntryName}" entry also present — remove it once the working entry is back`
      : "";
    return `has "${ENTRY_NAME}" entry, but its launch command does not exist: ${c.launchCommandMissing} — the client cannot start yaw-mcp; rerun \`${installCmd}\`${legacy}`;
  }
  // Both oam-specific states below are "the entry looks fine and will not
  // start", so they rank with launchCommandMissing rather than with the OK
  // branches -- reporting "OK (runs on oam)" for either is the wrong answer.
  if (c.launchOamEntryMissing) {
    return `has "${ENTRY_NAME}" entry running on oam, but its entry file does not exist: ${c.launchOamEntryMissing} — oam cannot fetch it on demand the way npx would; rerun \`${installCmd}\``;
  }
  if (c.launchOamNotAbsolute) {
    return `has "${ENTRY_NAME}" entry with a bare "${c.launchOamNotAbsolute}" command — it resolves against the client's PATH, which a GUI-launched client does not inherit from your shell; rerun \`${installCmd}\` to write an absolute path, or set OAM_BIN`;
  }
  if (c.hasMcpEntry && c.hasLegacyEntry) {
    return `OK — has "${ENTRY_NAME}" entry${c.launchRuntime === "oam" ? " (runs on oam)" : ""}; legacy "${c.legacyEntryName}" entry also present — remove it to avoid running yaw-mcp twice`;
  }
  if (c.hasMcpEntry) {
    return `OK — has "${ENTRY_NAME}" entry${c.launchRuntime === "oam" ? " (runs on oam)" : ""}`;
  }
  if (c.hasLegacyEntry) {
    return `legacy "${c.legacyEntryName}" entry present — run \`${installCmd}\` to migrate, then remove the legacy entry by hand`;
  }
  if (c.exists) return `present, no "${ENTRY_NAME}" entry — run \`${installCmd}\``;
  return `not configured — run \`${installCmd}\``;
}

interface ProbeOptions {
  home: string;
  os: InstallOS;
  cwd: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set, claude-code probes hit
   *  `<DIR>/.claude.json` instead of `<HOME>/.claude.json` so doctor and
   *  `yaw-mcp install --list` see the same file Claude Code reads. */
  claudeConfigDir?: string;
}

/** One (client, scope) probe slot: the result skeleton plus, when a config
 *  file is actually on disk, the read the caller still has to perform.
 *  `read` is null for unavailable clients and for missing files — those
 *  results are already final. */
interface ProbeSlot {
  result: ClientProbeResult;
  read: { path: string; containerPath: string[] } | null;
}

const MALFORMED = {
  hasMcpEntry: false,
  hasLegacyEntry: false,
  legacyEntryName: null,
  malformed: true,
  launchCommandMissing: null,
  launchRuntime: null,
  launchOamNotAbsolute: null,
  launchOamEntryMissing: null,
} as const;

/** Enumerate every (client, scope) combo for the current OS and resolve its
 *  config path. Shared by the sync and async probe variants so the client
 *  walk, the path resolution and the result shape live in exactly one place —
 *  the two used to be ~55-line copy-paste twins that could silently drift. */
function* enumerateProbeSlots(opts: ProbeOptions): Generator<ProbeSlot> {
  for (const target of INSTALL_TARGETS) {
    if (!target.availableOn.includes(opts.os)) {
      yield {
        result: {
          clientId: target.clientId,
          scope: target.scopes[0].scope,
          path: "(n/a)",
          exists: false,
          hasMcpEntry: false,
          launchCommandMissing: null,
          launchRuntime: null,
          launchOamNotAbsolute: null,
          launchOamEntryMissing: null,
          hasLegacyEntry: false,
          legacyEntryName: null,
          malformed: false,
          unavailable: true,
        },
        read: null,
      };
      continue;
    }
    // Probe each scope the client supports. For user scope we always
    // know the path; for project/local we use cwd (typical: the user
    // ran doctor inside the repo they care about).
    for (const scope of target.scopes) {
      let resolved: ReturnType<typeof resolveInstallPath>;
      try {
        resolved = resolveInstallPath({
          clientId: target.clientId,
          scope: scope.scope,
          os: opts.os,
          home: opts.home,
          projectDir: scope.requiresProjectDir ? opts.cwd : undefined,
          claudeConfigDir: opts.claudeConfigDir,
        });
      } catch {
        // resolveInstallPath throws when project is required but missing —
        // shouldn't happen here since we always pass cwd, but defensive.
        continue;
      }
      const exists = existsSync(resolved.absolute);
      yield {
        result: {
          clientId: target.clientId,
          scope: scope.scope,
          path: resolved.absolute,
          exists,
          hasMcpEntry: false,
          launchCommandMissing: null,
          launchRuntime: null,
          launchOamNotAbsolute: null,
          launchOamEntryMissing: null,
          hasLegacyEntry: false,
          legacyEntryName: null,
          malformed: false,
          unavailable: false,
        },
        read: exists ? { path: resolved.absolute, containerPath: resolved.containerPath } : null,
      };
    }
  }
}

function probeClients(opts: ProbeOptions): ClientProbeResult[] {
  const out: ClientProbeResult[] = [];
  for (const { result, read } of enumerateProbeSlots(opts)) {
    if (read) {
      try {
        Object.assign(result, classifyProbeContent(readFileSync(read.path, "utf8"), read.containerPath));
      } catch {
        Object.assign(result, MALFORMED);
      }
    }
    out.push(result);
  }
  return out;
}

/** Walk a JSON-key path to the mcpServers/servers container.
 *  Returns the object at the path, or null if any segment is missing/non-object. */
function walkContainer(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
  return cur as Record<string, unknown>;
}

/**
 * The oam argv a launch entry ultimately runs, with any shell wrapper peeled
 * off -- or null when this entry is not an oam launch we can read.
 *
 * DELIBERATE DUPLICATION of the unwrap in `isOamLaunch` (oam-spawn.ts). That
 * function answers "is this oam?" and throws the unwrapped tokens away;
 * everything after the wrapper is what THIS needs. The two must stay in step:
 * `isOamLaunch` is what sets `launchRuntime === "oam"`, so any wrapper shape it
 * starts accepting has to be added here too, or the entry scan below falls back
 * to reading the wrapper's own switches as an oam path.
 */
function oamArgvTokens(command: string, args: readonly string[]): readonly string[] | null {
  if (isOamCommand(command)) return args;
  const base = command.split(/[\\/]/).pop() ?? command;

  if (/^cmd(\.exe)?$/i.test(base)) {
    // cmd's payload is separate argv entries after its own switches, and the
    // everyday shape is `/d /s /c` (what npm emits), not just `/c`. Matching
    // "slash + ONE letter" keeps a POSIX path like /usr/local/bin/oam out of
    // the switch set.
    const i = args.findIndex((a) => !/^\/[a-z]$/i.test(a));
    if (i < 0 || !isOamCommand(args[i])) return null;
    return args.slice(i + 1);
  }

  if (/^(sh|bash|zsh|dash)$/i.test(base)) {
    // A POSIX shell carries the whole command as one string after -c, so the
    // payload has to be tokenised on whitespace.
    const dashC = args.indexOf("-c");
    const payload = dashC >= 0 ? args[dashC + 1] : args[0];
    if (payload === undefined) return null;
    // A quote anywhere in the payload means whitespace tokenising can cut a
    // path in half, and half a path fails the exists() check below -- doctor
    // would report a healthy entry as missing. Under-reporting is the safe
    // direction here (isOamLaunch takes the same position), so bail instead.
    if (/["']/.test(payload)) return null;
    const tokens = payload.trim().split(/\s+/);
    if (tokens[0] === undefined || !isOamCommand(tokens[0])) return null;
    return tokens.slice(1);
  }

  return null;
}

/**
 * The entry file an `oam run` launch entry points at, or null when there is
 * nothing to check.
 *
 * Anchored on the `run` SUBCOMMAND rather than on "first non-flag arg in argv":
 * the raw argv can start with a wrapper's switches (`cmd /d /s /c ...`), and
 * picking args[1] off that shape yields `/s` -- which `isAbsolute` accepts on
 * both platforms and `existsSync` then rejects, reporting a working install as
 * broken. Anything that is not `<oam> [flags] run [flags] <entry>` returns null
 * and is simply not checked.
 *
 * Known limit: a flag taking a SEPARATE value after `run` (`run --profile x
 * entry.js`) would pick `x`. No such flag exists today -- install writes
 * `run --no-check <entry>` -- and the fallout is bounded to a spurious report
 * only if that value also looks like an absolute path that does not exist.
 */
export function oamRunEntryPath(command: string, args: readonly string[]): string | null {
  const tokens = oamArgvTokens(command, args);
  if (tokens === null) return null;
  // Leading flags belong to oam itself; the first bare token is the subcommand.
  const sub = tokens.findIndex((t) => !t.startsWith("-"));
  if (sub < 0 || tokens[sub] !== "run") return null;
  return tokens.slice(sub + 1).find((t) => !t.startsWith("-")) ?? null;
}

/** Classify raw config file content for a probe result. Shared by both
 *  the sync and async probe variants so the parsing logic lives once. */
function classifyProbeContent(
  raw: string,
  containerPath: string[],
  exists: (p: string) => boolean = existsSync,
): {
  hasMcpEntry: boolean;
  hasLegacyEntry: boolean;
  legacyEntryName: string | null;
  malformed: boolean;
  launchCommandMissing: string | null;
  launchRuntime: "oam" | "node" | null;
  launchOamNotAbsolute: string | null;
  launchOamEntryMissing: string | null;
} {
  if (raw.trim().length === 0) {
    return {
      hasMcpEntry: false,
      hasLegacyEntry: false,
      legacyEntryName: null,
      malformed: false,
      launchCommandMissing: null,
      launchRuntime: null,
      launchOamNotAbsolute: null,
      launchOamEntryMissing: null,
    };
  }
  try {
    const parsed = parseJsonc(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null,
        malformed: true,
        launchCommandMissing: null,
        launchRuntime: null,
        launchOamNotAbsolute: null,
        launchOamEntryMissing: null,
      };
    }
    const container = walkContainer(parsed as Record<string, unknown>, containerPath);
    if (!container) {
      return {
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null,
        malformed: false,
        launchCommandMissing: null,
        launchRuntime: null,
        launchOamNotAbsolute: null,
        launchOamEntryMissing: null,
      };
    }
    const legacyEntryName = findLegacyEntry(container);
    const entry = container[ENTRY_NAME];
    let launchCommandMissing: string | null = null;
    let launchRuntime: "oam" | "node" | null = null;
    let launchOamNotAbsolute: string | null = null;
    let launchOamEntryMissing: string | null = null;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const command = (entry as { command?: unknown }).command;
      if (typeof command === "string") {
        if (isAbsolute(command) && !exists(command)) launchCommandMissing = command;
        const entryArgs = (entry as { args?: unknown }).args;
        const args = Array.isArray(entryArgs) ? (entryArgs as string[]) : [];
        launchRuntime = isOamLaunch(command, args) ? "oam" : "node";
        // A BARE oam command is the one shape the absolute-path check above
        // cannot see, and it is the shape older installs actually wrote. It
        // resolves against the CLIENT's PATH, not the shell's, so a
        // GUI-launched client (Claude Desktop from the Dock, Cursor from
        // Explorer) never finds an oam that lives in ~/.oam/bin -- the broker
        // fails to start with no fallback. `install` no longer writes this,
        // but nothing rewrites the configs that already carry it, so doctor is
        // the only thing that can surface it.
        if (isOamCommand(command) && !isAbsolute(command)) launchOamNotAbsolute = command;
        // `oam run [--no-check] <entry>`: unlike npx, oam cannot fetch a
        // missing entry on demand, so a stale path here is a hard launch
        // failure rather than a slow start.
        //
        // Goes through oamRunEntryPath rather than scanning `args` directly:
        // launchRuntime is "oam" for the `cmd /d /s /c oam run ...` and
        // `sh -c "oam run ..."` shapes too, and on those the raw argv's first
        // non-flag token is the wrapper's own switch, not the entry file.
        if (launchRuntime === "oam") {
          const entryPath = oamRunEntryPath(command, args);
          if (entryPath !== null && isAbsolute(entryPath) && !exists(entryPath)) {
            launchOamEntryMissing = entryPath;
          }
        }
      }
    }
    return {
      hasMcpEntry: ENTRY_NAME in container,
      hasLegacyEntry: legacyEntryName !== null,
      legacyEntryName,
      malformed: false,
      launchCommandMissing,
      launchRuntime,
      launchOamNotAbsolute,
      launchOamEntryMissing,
    };
  } catch {
    return {
      hasMcpEntry: false,
      hasLegacyEntry: false,
      legacyEntryName: null,
      malformed: true,
      launchCommandMissing: null,
      launchRuntime: null,
      launchOamNotAbsolute: null,
      launchOamEntryMissing: null,
    };
  }
}

// Async variant for code paths that prefer non-blocking I/O. Used by
// install-cmd.ts (runInstallList, for `yaw-mcp install --list`) and
// try-cmd.ts (autoDetectClient, picking a client for a trial) — both
// async contexts where the synchronous probeClients would block. Doctor
// itself uses the sync probeClients (it runs once, interactively).
export async function probeClientsAsync(opts: ProbeOptions): Promise<ClientProbeResult[]> {
  const out: ClientProbeResult[] = [];
  for (const { result, read } of enumerateProbeSlots(opts)) {
    if (read) {
      try {
        Object.assign(result, classifyProbeContent(await readFile(read.path, "utf8"), read.containerPath));
      } catch {
        Object.assign(result, MALFORMED);
      }
    }
    out.push(result);
  }
  return out;
}

// Doctor's abort budget for the freshness probe, deliberately SHORTER than
// upgrade-cmd's 3000ms default.
//
// The asymmetry is the requirement, not an oversight. `upgrade` exists to answer
// "is there a newer version"; it has nothing at all to print until the registry
// replies, so waiting longer is strictly better there. Doctor's freshness line
// is one of ~20 checks, and every other one is local and instant -- a firewalled
// or black-holed registry that stalls the whole report is a worse outcome than
// an UPGRADE AVAILABLE banner that stays silent for one run. Doctor must not
// hang.
//
// The cost of the shorter budget, stated plainly: on a registry slow enough to
// answer between 2s and 3s, doctor reports nothing while `upgrade` would have
// reported an available upgrade. That is the intended trade, and it is why this
// is a parameter of the shared probe rather than a second implementation --
// upgrade-cmd's `fetchLatestVersion` owns the URL, the response validation and
// the failure-to-null semantics for all three callers, and only the number
// differs here.
const DOCTOR_REGISTRY_TIMEOUT_MS = 2000;

export interface ShadowHit {
  cli: string;
  count: number;
  namespaces: string[];
}

// How many lines from the tail of each history file we examine. 500 is
// long enough to catch a day or two of normal terminal usage without
// loading massive archives into memory. History files grow unbounded
// on many setups — reading the whole thing would be wasteful here.
const SHELL_HISTORY_TAIL_LINES = 500;

// Hard cap on the BYTES read from the end of each history file. This is what
// makes the memory claim above true: readTailLines seeks to `size - this` and
// reads forward, so a 400 MB PSReadLine archive costs one 256 KB buffer rather
// than the whole file (plus a full line array) per doctor run. 256 KB holds
// far more than 500 lines of any realistic history, so the line cap above is
// still the binding limit in practice.
const SHELL_HISTORY_TAIL_BYTES = 256 * 1024;

/** Scan recent bash / zsh / PowerShell history for commands that an
 *  MCP server shadows. Returns a sorted (count desc) list of hits.
 *  Any I/O error on a history file is swallowed — this is purely
 *  diagnostic, never fatal. */
export function scanShellHistoryForShadows(opts: { home: string; env: NodeJS.ProcessEnv }): ShadowHit[] {
  const shadowMap = cliToNamespaces();
  const counts = new Map<string, number>();

  for (const source of shellHistorySources(opts)) {
    const lines = readTailLines(source.path, SHELL_HISTORY_TAIL_LINES);
    for (const raw of lines) {
      const cmd = source.extractCommand(raw);
      if (!cmd) continue;
      const binary = extractLeadingBinary(cmd);
      if (!binary) continue;
      if (!shadowMap.has(binary)) continue;
      counts.set(binary, (counts.get(binary) ?? 0) + 1);
    }
  }

  const hits: ShadowHit[] = [];
  for (const [cli, count] of counts) {
    const namespaces = shadowMap.get(cli) ?? [];
    hits.push({ cli, count, namespaces });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits;
}

interface ShellHistorySource {
  path: string;
  /** Given a raw line, return the command or null to skip. */
  extractCommand: (line: string) => string | null;
}

function shellHistorySources(opts: { home: string; env: NodeJS.ProcessEnv }): ShellHistorySource[] {
  const sources: ShellHistorySource[] = [];
  sources.push({ path: join(opts.home, ".bash_history"), extractCommand: (l) => l.trim() || null });
  sources.push({
    path: join(opts.home, ".zsh_history"),
    // Zsh extended-history lines look like `: 1700000000:0;npm audit`.
    // Strip the metadata prefix so we get just the command.
    extractCommand: (l) => {
      const trimmed = l.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith(":")) {
        const semi = trimmed.indexOf(";");
        return semi === -1 ? null : trimmed.slice(semi + 1);
      }
      return trimmed;
    },
  });
  const appData = opts.env.APPDATA;
  if (appData) {
    sources.push({
      path: join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
      extractCommand: (l) => l.trim() || null,
    });
  }
  return sources;
}

/** Read at most the last `n` lines of a file, reading at most
 *  SHELL_HISTORY_TAIL_BYTES from the END of it rather than the whole file.
 *
 *  The whole-file read this replaces made the "without loading massive
 *  archives into memory" claim above false: it allocated the entire file PLUS
 *  a line array for every one of the three sources on every doctor run, and on
 *  a multi-hundred-MB history readFileSync throws ERR_STRING_TOO_LONG -- which
 *  the catch swallowed, so the SHADOWED CLI section silently disappeared with
 *  no diagnostic. Any I/O error still yields [] (purely diagnostic section).
 */
function readTailLines(path: string, n: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = size > SHELL_HISTORY_TAIL_BYTES ? size - SHELL_HISTORY_TAIL_BYTES : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const got = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, got).toString("utf8");
    if (start > 0) {
      // The window almost certainly opens mid-line, and its first bytes can be
      // the tail of a multi-byte character. Drop through the first newline so
      // only whole, correctly-decoded lines are parsed.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const all = text.split(/\r?\n/);
    return all.length <= n ? all : all.slice(all.length - n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do with a close failure on a read-only probe.
      }
    }
  }
}

// Pull the leading binary out of a shell command, stripping any
// leading env-var assignments (`FOO=bar CMD=quux cmd arg`), `sudo`,
// and path-style invocations (`/usr/local/bin/npm` → `npm`). Returns
// null for lines we can't confidently parse (pipes, command
// substitution, assignments only).
function extractLeadingBinary(command: string): string | null {
  let rest = command.trimStart();
  if (!rest) return null;
  // Drop leading control chars like `! ` (bang-prefixed history
  // references from bash shouldn't even land here, but defensive).
  if (rest.startsWith("!")) return null;
  // Strip leading env-var assignments AND wrapper prefixes, repeatedly:
  // real history lines stack them (`sudo time npm audit`, `sudo FOO=1 npm
  // ci`), and peeling exactly one wrapper left `time` as the "binary".
  // Both classes are handled in ONE loop so any interleaving works.
  const prefixes = ["sudo", "time", "command", "exec"];
  for (;;) {
    const firstWord = rest.split(/\s+/)[0] ?? "";
    const isAssignment = /^[A-Z_][A-Z0-9_]*=/i.test(rest);
    if (!isAssignment && !prefixes.includes(firstWord)) break;
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    const next = rest.slice(space + 1).trimStart();
    // Defensive: a line of pure separators can't shrink further.
    if (next === rest || next.length === 0) return null;
    rest = next;
  }
  const first = rest.split(/\s+/)[0];
  if (!first) return null;
  // Reject pipes, redirects, subshells, empty assignments.
  if (/[|&;<>()`$]/.test(first)) return null;
  // Strip path prefix — we match on the binary name.
  const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  return slash === -1 ? first : first.slice(slash + 1);
}

// Version compare, delegated to oam-spawn's `compareVersions` -- the canonical
// implementation for the package.
//
// This used to be a local triple-only copy, and the duplication was not
// harmless: it read "0.8.3-rc.1" as EQUAL to a 0.8.3 floor, so doctor could
// report that a prerelease met a MIN_OAM_VERSION floor that oam-spawn (which
// implements real prerelease precedence) ranks it BELOW. doctor printing one
// verdict while the spawn path acts on another is the failure this whole
// section exists to prevent, so the two must share one comparator.
//
// `compareVersions` is anchored and does NOT accept a leading "v"; the old copy
// did. That tolerance is preserved here rather than dropped, because these
// inputs include a version read from a package.json that a git-tag-shaped build
// can write as "v1.2.3", and silently returning 0 for it would suppress the
// upgrade banner instead of showing a wrong one. Unparseable still compares
// equal, so a weird version string cannot invent a false "upgrade available".
export function compareSemver(a: string, b: string): number {
  const strip = (s: string) => (s.startsWith("v") ? s.slice(1) : s);
  return compareVersions(strip(a), strip(b));
}
