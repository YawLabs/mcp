// `yaw-mcp doctor` — prints a one-screen diagnostic of the user's yaw-mcp setup.
// Goal: when a support ticket comes in ("nothing is working"), the user
// pastes the doctor output and we can usually pinpoint the issue from
// it alone (no token / wrong token source / wrong API base / which
// clients have yaw-mcp wired up vs. don't / file permissions).
//
// The output is plain text so it survives Discord / Slack pasting.
// Tokens are always fingerprinted (never raw) — see tokenFingerprint in
// config-loader.ts for the exact masking (the visible slice varies with
// token length; short tokens reveal fewer characters).
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
//   0  healthy (token present, no warnings) OR local mode (no token —
//      yaw-mcp still starts and serves ~/.yaw-mcp/bundles.json)
//   2  warnings (e.g., schema-version mismatch, loose file permissions)
//   (1 = fatal is reserved and currently UNREACHABLE: a missing token is
//   treated as healthy local mode, not a fatal error, on both paths.)

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AnalyticsFailure, getDroppedEventsCount, getLastAnalyticsFailure } from "./analytics.js";
import { cliToNamespaces } from "./cli-shadows.js";
import {
  CURRENT_SCHEMA_VERSION,
  type LoadedConfigFile,
  loadYawMcpConfig,
  type ResolvedConfig,
  tokenFingerprint,
} from "./config-loader.js";
import {
  type DefaultRuntimeInfo,
  describeDefaultRuntime,
  describeServerRuntime,
  type ServerRuntimeInfo,
} from "./default-runtime.js";
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
import { loadLocalBundles } from "./local-bundles.js";
import { MIN_OAM_VERSION, type OamProbe, probeOam } from "./oam-spawn.js";
import { userConfigDir } from "./paths.js";
import { loadState, STATE_FILENAME, STATE_SCHEMA_VERSION } from "./persistence.js";
import { getLastReportFailure, type ReportFailure } from "./tool-report.js";
import { formatTtl, gcExpiredTrials, scanTrials, type TryEventBody } from "./try-cmd.js";
import {
  BINARY_DOWNLOAD_URL,
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  refineInstallMethod,
} from "./upgrade-cmd.js";
import { selectFlakyNamespaces } from "./usage-hints.js";

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
  oamProbe?: () => OamProbe;
}

// Machine-readable shape emitted by `yaw-mcp doctor --json`. Mirrors the
// text sections so support / dashboard consumers can pick fields with jq.
// The raw token is NEVER included — only its fingerprint.
//
// Sections deliberately NOT mirrored (text-only, by design):
//   - SHADOWED CLI USAGE is carried as `shellShadows` (same data, renamed).
//   - UPGRADE AVAILABLE's method-aware terminal hint is text-only; the JSON
//     `upgrade` block carries the version facts but no install-method copy.
// Everything else (CONFIG FILES, TOKEN, API BASE, ENVIRONMENT, STATE,
// RELIABILITY, TRIALS, BACKGROUND POSTERS, INSTALLED CLIENTS, WARNINGS,
// DIAGNOSIS) has a structured field below.
export interface DoctorJsonSnapshot {
  timestamp: string;
  version: string;
  platform: InstallOS;
  token: { fingerprint: string; source: string };
  apiBase: { value: string; source: string };
  loadedFiles: Array<{ scope: string; path: string; schemaVersion?: number; schemaAhead: boolean }>;
  warnings: string[];
  env: Record<string, string | null>;
  state: {
    disabled: boolean;
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
  // Background HTTP poster failure latches (analytics, tool-report). A
  // non-null entry is the 401/403 token-lost-write-scope signal; both null
  // is the healthy case. Mirrors the text path's BACKGROUND POSTERS section.
  backgroundPosters: {
    analytics: { statusCode: number; url: string; at: string } | null;
    toolReport: { statusCode: number; url: string; at: string } | null;
  };
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
    defaultRuntime: "oam" | "node" | null;
    defaultRuntimeSource: "env" | "bundles" | null;
    defaultRuntimePath: string | null;
    servers: Array<{ namespace: string; runtime: "oam" | "node" | null; reason: string }>;
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

// Single source of truth for the YAW_MCP_DISABLE_PERSISTENCE truthiness
// predicate. Was open-coded in four places (both STATE/RELIABILITY pairs
// across the text and json paths); keeping them in lockstep matters since
// a divergence would have one section reading state.json while another
// treats persistence as off. persistence.ts has no exported decision to
// reuse, so this is the local canonical form.
function isPersistenceDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.YAW_MCP_DISABLE_PERSISTENCE;
  return raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
}

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

  print("CONFIG FILES");
  if (config.loadedFiles.length === 0) {
    print("  (none — using defaults + env)");
  } else {
    for (const f of config.loadedFiles) {
      print(`  ${f.scope.padEnd(7)} ${f.path}${schemaSuffix(f)}`);
    }
  }
  print("");

  print("TOKEN");
  print(`  value:  ${tokenFingerprint(config.token)}`);
  print(`  source: ${config.tokenSource}`);
  print("");

  print("API BASE");
  print(`  value:  ${config.apiBase}`);
  print(`  source: ${config.apiBaseSource}`);
  print("");

  // Behavior-modifier env vars that yaw-mcp actually reads at runtime.
  // Surfaced here so support diagnostics can see at a glance whether an
  // override is active (e.g., "my auto-load isn't working" — doctor
  // says AUTO_LOAD is not set). TOKEN / URL / DISABLE_PERSISTENCE have
  // their own dedicated sections and are intentionally omitted.
  renderEnvSection({ env, print });

  // oam runtime visibility — which runtime each server would ACTUALLY get
  // (oam vs node) and why. The oam spawn-rewrite falls back to node
  // silently by design (oam absent / below min / non-node command), so
  // this section is where that fallback becomes visible.
  const oamStatus = await collectOamRuntimeStatus({ env, cwd, home, probeFn: opts.oamProbe ?? probeOam });
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

  // Background HTTP posters (analytics, tool-report) fire-and-forget by
  // design, but a 401/403 there means the user's token has lost write
  // scope and their analytics is silently disappearing. Latches in the
  // poster modules capture only the most recent rejection per module;
  // the section is rendered ONLY when at least one latch is set so
  // healthy installs stay quiet.
  renderBackgroundPostersSection({ print });

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
  // block the diagnostic. Times out after 2s to keep doctor snappy.
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
  const latest = skipCheck ? null : await fetchLatestVersion(opts.registryFetch);
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
  // Warnings are emitted to stderr UNCONDITIONALLY (regardless of token
  // state) so a pipeline that captures only stdout still sees them. The
  // text WARNINGS section above is part of the human report (stdout); the
  // stderr stream below is the always-on signal. Local mode exits 0,
  // but warning lines still print here so they don't get masked by the
  // "fully functional" diagnosis below.
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErr(`warning: ${w}\n`);
  }
  if (config.token === null) {
    // No token is NOT an error: yaw-mcp runs in local mode, serving
    // whatever is in ~/.yaw-mcp/bundles.json. runServer() (index.ts) treats
    // a missing token as non-fatal, so doctor must agree -- reporting
    // "cannot start" here was a false alarm that the Yaw MCP panel surfaced
    // as a blocking ATTENTION banner.
    print("DIAGNOSIS");
    print("  Local mode -- fully functional, no account needed. yaw-mcp serves");
    print("  whatever servers are configured locally in ~/.yaw-mcp/bundles.json.");
  } else if (config.warnings.length > 0) {
    exitCode = 2;
    print("DIAGNOSIS");
    print("  Token present, but warnings above need attention.");
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
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const clients = probeClients({ home, os, cwd, claudeConfigDir });

  const envVarNames = [
    "YAW_MCP_POLL_INTERVAL",
    "YAW_MCP_SERVER_CAP",
    "YAW_MCP_MIN_COMPLIANCE",
    "YAW_MCP_AUTO_LOAD",
    "YAW_MCP_AUTO_ACTIVATE",
    "YAW_MCP_PRUNE_RESPONSES",
    "YAW_MCP_DEFAULT_RUNTIME",
  ] as const;
  const envOverrides: Record<string, string | null> = {};
  for (const name of envVarNames) {
    const raw = env[name];
    envOverrides[name] = raw === undefined || raw === "" ? null : raw;
  }

  // STATE + RELIABILITY section data. Load state.json ONCE for both
  // (previously loaded twice here). YAW_MCP_DISABLE_PERSISTENCE
  // short-circuits to a null read; otherwise we read the file a single
  // time and thread it into both blocks.
  const persistDisabled = isPersistenceDisabled(env);
  const stateFilePath = join(userConfigDir(home), STATE_FILENAME);
  const persisted = persistDisabled ? null : await loadState(stateFilePath);
  const state: DoctorJsonSnapshot["state"] =
    persistDisabled || !persisted
      ? { disabled: true, path: null, savedAt: null, learningEntries: null, packHistoryEntries: null }
      : (() => {
          const fresh = persisted.savedAt === 0;
          return {
            disabled: false,
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
  const trialGc = await gcExpiredTrials({ home, env, postEvent: opts.postTryEvent, now: opts.now }).catch(() => ({
    cleared: 0,
    failed: 0,
  }));
  const trialScan = await scanTrials({ home, now: opts.now });
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
  const oamRuntime: DoctorJsonSnapshot["oamRuntime"] = {
    binary: oamStatus.probe.bin,
    version: oamStatus.probe.version,
    belowMin: oamStatus.probe.belowMin,
    minVersion: MIN_OAM_VERSION,
    defaultRuntime: oamStatus.dflt.runtime,
    defaultRuntimeSource: oamStatus.dflt.source,
    defaultRuntimePath: oamStatus.dflt.path,
    servers: oamStatus.servers.map((s) => ({
      namespace: s.namespace,
      runtime: s.info.runtime,
      reason: s.info.reason,
    })),
  };

  // Background HTTP poster failure latches — same getters the text path's
  // renderBackgroundPostersSection reads. A non-null entry is the
  // 401/403 token-lost-write-scope signal.
  const analyticsFailure = getLastAnalyticsFailure();
  const reportFailure = getLastReportFailure();
  const backgroundPosters: DoctorJsonSnapshot["backgroundPosters"] = {
    analytics: analyticsFailure
      ? {
          statusCode: analyticsFailure.statusCode,
          url: analyticsFailure.url,
          at: new Date(analyticsFailure.at).toISOString(),
        }
      : null,
    toolReport: reportFailure
      ? { statusCode: reportFailure.statusCode, url: reportFailure.url, at: new Date(reportFailure.at).toISOString() }
      : null,
  };

  // Mirrors the text path's hook handling (see runDoctor): an explicit
  // registryFetch bypasses the VITEST guard, and currentVersion overrides
  // the build-time VERSION. opts.argvPath is intentionally unused here --
  // the JSON snapshot's upgrade block carries no install method.
  // The process.env.VITEST read here is the same deliberate exception
  // documented on the text path's skipCheck above (opts.env is stripped
  // to `{}` under vitest, so VITEST is only visible via process.env).
  const skipCheck = (opts.skipRegistryCheck === true || Boolean(process.env.VITEST)) && !opts.registryFetch;
  const latest = skipCheck ? null : await fetchLatestVersion(opts.registryFetch);
  const effectiveVersion = opts.currentVersion ?? VERSION;
  const stale = latest !== null && effectiveVersion !== "dev" && compareSemver(effectiveVersion, latest) < 0;

  let exitCode = 0;
  let summary: string;
  // Always-on warning stream: mirrors the text path so JSON-mode pipelines
  // that capture stdout (the JSON blob) still surface config warnings on
  // stderr, even in local mode where exit code is 0.
  const writeErrJson = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErrJson(`warning: ${w}\n`);
  }
  if (config.token === null) {
    // Local mode -- not an error (see runDoctor's text branch).
    summary = "Local mode -- fully functional, no account needed.";
  } else if (config.warnings.length > 0) {
    exitCode = 2;
    summary = "Token present, but warnings need attention.";
  } else {
    summary = stale ? "Healthy, but an upgrade is available." : "All good. yaw-mcp should start cleanly.";
  }

  const snapshotJson: DoctorJsonSnapshot = {
    timestamp,
    version: VERSION,
    platform: os,
    token: { fingerprint: tokenFingerprint(config.token), source: config.tokenSource },
    apiBase: { value: config.apiBase, source: config.apiBaseSource },
    loadedFiles: config.loadedFiles.map((f) => ({
      scope: f.scope,
      path: f.path,
      ...(f.version !== undefined ? { schemaVersion: f.version } : {}),
      schemaAhead: f.version !== undefined && f.version > CURRENT_SCHEMA_VERSION,
    })),
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
    { name: "YAW_MCP_POLL_INTERVAL", defaultHint: "default 60s" },
    { name: "YAW_MCP_SERVER_CAP", defaultHint: "default 6" },
    { name: "YAW_MCP_MIN_COMPLIANCE", defaultHint: "filter inactive" },
    { name: "YAW_MCP_AUTO_LOAD", defaultHint: "auto-load inactive" },
    { name: "YAW_MCP_AUTO_ACTIVATE", defaultHint: "default on" },
    { name: "YAW_MCP_PRUNE_RESPONSES", defaultHint: "pruning active" },
    { name: "YAW_MCP_DEFAULT_RUNTIME", defaultHint: "per-server opt-in only" },
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
// locally-defined server. Account-mode server defs live on the backend, so
// the per-server list here covers bundles.json only — `yaw-mcp servers`
// carries the same verdict for account servers.
interface OamRuntimeStatus {
  probe: OamProbe;
  dflt: DefaultRuntimeInfo;
  servers: Array<{ namespace: string; info: ServerRuntimeInfo }>;
}

async function collectOamRuntimeStatus(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  probeFn: () => OamProbe;
}): Promise<OamRuntimeStatus> {
  const probe = opts.probeFn();
  const dflt = await describeDefaultRuntime({ env: opts.env, cwd: opts.cwd, home: opts.home });
  const bundles = await loadLocalBundles({ cwd: opts.cwd, home: opts.home }).catch(() => null);
  const servers = (bundles?.config?.servers ?? []).map((s) => ({
    namespace: s.namespace,
    info: describeServerRuntime(s, dflt.runtime, probe),
  }));
  return { probe, dflt, servers };
}

function renderOamRuntimeSection(opts: { status: OamRuntimeStatus; print: (s?: string) => void }): void {
  const { status, print } = opts;
  const { probe, dflt, servers } = status;
  print("OAM RUNTIME");
  if (probe.belowMin) {
    print(`  binary:  installed (v${probe.version}) — below min ${MIN_OAM_VERSION}; IGNORED, servers run on node`);
  } else if (probe.bin === null) {
    print("  binary:  not installed — node/npx spawns are used directly");
  } else {
    print(`  binary:  ${probe.bin} (v${probe.version ?? "unknown"}, min ${MIN_OAM_VERSION})`);
  }
  // Name the exact source: the connect path resolves project-local bundles
  // from the BROKER's cwd, doctor from the shell's cwd — printing the file
  // path makes a divergence between the two spottable.
  const dfltLabel =
    dflt.runtime !== null
      ? `${dflt.runtime} (${dflt.source === "env" ? "env YAW_MCP_DEFAULT_RUNTIME" : `bundles.json defaultRuntime @ ${dflt.path}`})`
      : '(not set — per-server runtime:"oam" opt-in only)';
  print(`  default runtime: ${dfltLabel}`);
  if (servers.length > 0) {
    print("  servers (local bundles.json):");
    const widest = servers.reduce((m, s) => Math.max(m, s.namespace.length), 0);
    for (const s of servers) {
      print(`    ${s.namespace.padEnd(widest)}  ${(s.info.runtime ?? "-").padEnd(4)}  ${s.info.reason}`);
    }
  }
  print("");
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
  if (version !== STATE_SCHEMA_VERSION) {
    return { kind: "stale-version", version, expected: STATE_SCHEMA_VERSION };
  }
  return { kind: "ok" };
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
  const gc = await gcExpiredTrials({ home, env, postEvent, now }).catch(() => ({ cleared: 0, failed: 0 }));
  const scan = await scanTrials({ home, now });
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

// Render the BACKGROUND POSTERS section -- only when at least one
// latch is set. The point is to be silent when everything is working;
// a healthy install must not see this header. Reads the latches via
// the module getters (no cross-module circular: doctor depends on
// analytics/tool-report, never the reverse). The "no recent failure"
// row appears only alongside a sibling that DID fail, so the user can
// tell which poster is broken vs. which is fine.
function renderBackgroundPostersSection(opts: { print: (s?: string) => void }): void {
  const { print } = opts;
  const analyticsFailure = getLastAnalyticsFailure();
  const reportFailure = getLastReportFailure();
  const dropped = getDroppedEventsCount();
  if (!analyticsFailure && !reportFailure && dropped === 0) return;

  const now = Date.now();
  const fmt = (f: AnalyticsFailure | ReportFailure): string =>
    `HTTP ${f.statusCode} from ${f.url}, ${formatRelativeAge(now - f.at)} ago`;

  print("BACKGROUND POSTERS (recent failures)");
  print(`  analytics:    ${analyticsFailure ? fmt(analyticsFailure) : "(no recent failure)"}`);
  print(`  tool-report:  ${reportFailure ? fmt(reportFailure) : "(no recent failure)"}`);
  if (dropped > 0) {
    print(
      `  dropped:      ${dropped} analytics event${dropped === 1 ? "" : "s"} dropped (buffer full or non-retryable flush)`,
    );
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
  if (c.hasMcpEntry && c.hasLegacyEntry) {
    return `OK — has "${ENTRY_NAME}" entry; legacy "${c.legacyEntryName}" entry also present — remove it to avoid running yaw-mcp twice`;
  }
  if (c.hasMcpEntry) return `OK — has "${ENTRY_NAME}" entry`;
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

function probeClients(opts: ProbeOptions): ClientProbeResult[] {
  const out: ClientProbeResult[] = [];
  for (const target of INSTALL_TARGETS) {
    const unavailable = !target.availableOn.includes(opts.os);
    if (unavailable) {
      out.push({
        clientId: target.clientId,
        scope: target.scopes[0].scope,
        path: "(n/a)",
        exists: false,
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null,
        malformed: false,
        unavailable: true,
      });
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
      let classified = {
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null as string | null,
        malformed: false,
      };
      if (exists) {
        try {
          statSync(resolved.absolute);
          const raw = readFileSync(resolved.absolute, "utf8");
          classified = classifyProbeContent(raw, resolved.containerPath);
        } catch {
          classified = { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: true };
        }
      }
      out.push({
        clientId: target.clientId,
        scope: scope.scope,
        path: resolved.absolute,
        exists,
        ...classified,
        unavailable: false,
      });
    }
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

/** Classify raw config file content for a probe result. Shared by both
 *  the sync and async probe variants so the parsing logic lives once. */
function classifyProbeContent(
  raw: string,
  containerPath: string[],
): { hasMcpEntry: boolean; hasLegacyEntry: boolean; legacyEntryName: string | null; malformed: boolean } {
  if (raw.trim().length === 0) {
    return { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: false };
  }
  try {
    const parsed = parseJsonc(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: true };
    }
    const container = walkContainer(parsed as Record<string, unknown>, containerPath);
    if (!container) {
      return { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: false };
    }
    const legacyEntryName = findLegacyEntry(container);
    return {
      hasMcpEntry: ENTRY_NAME in container,
      hasLegacyEntry: legacyEntryName !== null,
      legacyEntryName,
      malformed: false,
    };
  } catch {
    return { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: true };
  }
}

// Async variant for code paths that prefer non-blocking I/O. Used by
// install-cmd.ts (runInstallList, for `yaw-mcp install --list`) and
// try-cmd.ts (autoDetectClient, picking a client for a trial) — both
// async contexts where the synchronous probeClients would block. Doctor
// itself uses the sync probeClients (it runs once, interactively).
export async function probeClientsAsync(opts: ProbeOptions): Promise<ClientProbeResult[]> {
  const result: ClientProbeResult[] = [];
  for (const target of INSTALL_TARGETS) {
    const unavailable = !target.availableOn.includes(opts.os);
    if (unavailable) {
      result.push({
        clientId: target.clientId,
        scope: target.scopes[0].scope,
        path: "(n/a)",
        exists: false,
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null,
        malformed: false,
        unavailable: true,
      });
      continue;
    }
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
        continue;
      }
      const exists = existsSync(resolved.absolute);
      let classified = {
        hasMcpEntry: false,
        hasLegacyEntry: false,
        legacyEntryName: null as string | null,
        malformed: false,
      };
      if (exists) {
        try {
          await stat(resolved.absolute);
          const raw = await readFile(resolved.absolute, "utf8");
          classified = classifyProbeContent(raw, resolved.containerPath);
        } catch {
          classified = { hasMcpEntry: false, hasLegacyEntry: false, legacyEntryName: null, malformed: true };
        }
      }
      result.push({
        clientId: target.clientId,
        scope: scope.scope,
        path: resolved.absolute,
        exists,
        ...classified,
        unavailable: false,
      });
    }
  }
  return result;
}

// Hit the public npm registry for the latest `@yawlabs/mcp` version.
// Intentionally thin: on ANY error (offline, timeout, rate-limited,
// corp proxy) we return null and doctor just skips the upgrade section.
// This function is NEVER awaited on a hot path — it only runs in doctor,
// which is user-interactive.
async function fetchLatestVersion(override?: () => Promise<string | null>): Promise<string | null> {
  if (override) {
    try {
      return await override();
    } catch {
      return null;
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetch("https://registry.npmjs.org/@yawlabs/mcp/latest", {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

function readTailLines(path: string, n: number): string[] {
  try {
    const raw = readFileSync(path, "utf8");
    const all = raw.split(/\r?\n/);
    return all.length <= n ? all : all.slice(all.length - n);
  } catch {
    return [];
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
  // Strip leading env-var assignments.
  while (/^[A-Z_][A-Z0-9_]*=/i.test(rest)) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    rest = rest.slice(space + 1).trimStart();
  }
  // Strip `sudo` / `time` / `command` prefixes.
  const prefixes = ["sudo", "time", "command", "exec"];
  const firstWord = rest.split(/\s+/)[0];
  if (prefixes.includes(firstWord)) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    rest = rest.slice(space + 1).trimStart();
  }
  const first = rest.split(/\s+/)[0];
  if (!first) return null;
  // Reject pipes, redirects, subshells, empty assignments.
  if (/[|&;<>()`$]/.test(first)) return null;
  // Strip path prefix — we match on the binary name.
  const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  return slash === -1 ? first : first.slice(slash + 1);
}

// Tiny semver compare — full semver is overkill; we only need to
// recognize "a is older than b" for dotted numeric x.y.z tags. Anything
// unparseable returns 0 (treated as equal) so a weird version string
// can't accidentally show a false "upgrade available" banner.
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}
