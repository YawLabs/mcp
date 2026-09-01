// Fire-and-forget sidecar refresh check, run once per yaw-mcp serve startup.
//
// Sibling of auto-upgrade.ts, and deliberately shaped like it: a ladder of
// cheap gates, a short registry probe, a best-effort lockfile, and a
// background install nobody awaits. Where auto-upgrade keeps yaw-mcp ITSELF
// current, this keeps the MCP servers in ~/.yaw-mcp/sidecars current.
//
// Why it has to exist. A server configured `npx -y pkg@latest` was current by
// construction -- npx re-resolved the dist-tag on every spawn. `yaw-mcp
// sidecars install` trades that for one known copy per package, and the
// version then pins itself (sidecars-cmd.ts's header says exactly that): oam
// has no fetch-on-demand, so once the managed tree is what gets spawned,
// nothing re-resolves `@latest` ever again. `sidecars install` is deliberately
// NOT automatic -- acquiring packages is network and minutes, and a first
// connect is the thing an MCP client blocks on -- so a user who ran it once
// stays on those versions until they remember to run it again. This module is
// "remember to run it again", moved off the connect path and onto a timer.
//
// WHAT IT WILL MOVE, and what it will never touch. Sidecars exist to PIN
// versions. So only a spec that asked to float is eligible: a configured range
// of `latest`, or no `@version` at all (which sidecarsManifest itself writes as
// `latest`). An explicit pin (`pkg@0.13.3`), a semver range (`pkg@^1.2.0`) and
// any other dist-tag (`pkg@next`) are all the user's stated intent and go in
// `skipped` untouched. Two independent reasons, and the second is the one that
// would have bitten us:
//   - Intent. A pin the user wrote is not ours to move.
//   - Staleness is only MEASURABLE against `latest`. A `@next` spec behind the
//     `latest` dist-tag would read as stale forever, because `npm update`
//     honours the manifest range and can never move it onto the `latest`
//     track. That is a 24-hourly npm spawn that changes nothing, permanently.
//     The same trap applies to `^1.2.0` once 2.0.0 ships.
//
// It also never DOWNGRADES: an installed version newer than `latest` (a local
// dev build, or a release that was yanked after we fetched it) is not stale.
// The comparison is semver via oam-spawn's compareVersions, never a string
// compare -- "0.9.0" > "0.10.0" lexicographically, which would silently skip
// exactly the upgrade the user most wants.
//
// A package that is CONFIGURED but not installed is not refreshed either. It
// is not stale, it was never acquired -- and acquiring it is the network-and-
// minutes cost `sidecars install` is opt-in about. Keeping what you installed
// moving forward is a different promise from fetching things you never asked
// this machine to fetch. (See KNOWN GAPS: the action cannot honour that
// distinction as precisely as the plan states it.)
//
// Never blocks serving: the registry probes run in parallel behind one short
// abort budget, the npm child's stdio is ignored, and the whole thing is
// fire-and-forget. A failure is a no-op -- worst case the sidecars stay on the
// version they were already on for another day.
//
// Concurrent runs are serialized, best-effort, by a lockfile in the sidecars
// root (auto-upgrade's acquireUpgradeLock, reused rather than re-derived).
// N MCP clients starting at once -- several Claude Code panes -- would
// otherwise each fire an `npm install` at one tree.
//
// KNOWN GAPS (documented rather than papered over):
//   - The refresh action is WHOLE-TREE, not per-package. runSidecarsInstall
//     rewrites the manifest from bundles.json and runs one `npm install` plus
//     one `npm update` in the sidecars root; there is no argument that says
//     "only this package". So `plan.stale` is a TRIGGER, not a work list. What
//     protects a pinned spec is therefore not the plan -- it is npm: `update`
//     honours the manifest range, so `pkg@1.0.0` cannot drift even though the
//     whole-tree update runs. The plan's job is to decide whether the tree is
//     worth touching at all; npm's job is to decide what moves when it is.
//   - Consequence of the above: a configured-but-not-installed package IS
//     acquired as a side effect once any other package triggers a refresh,
//     even though the plan lists it as skipped. `npm install` against a
//     manifest that names it cannot do otherwise. It is a merge, not an
//     `npm ci`, so nothing already in the tree is removed.
//   - The lock is advisory: a sidecars root we cannot write to yields a no-op
//     lock and the old unserialized behavior, and a lock left behind by a
//     killed process is stolen once it goes stale (auto-upgrade owns both
//     rules and the constants behind them).
//   - The npm child is not detached, so an MCP client that tears down the
//     process tree takes a half-finished install with it. Recovery is a manual
//     `yaw-mcp sidecars install`; nothing here repairs a partial tree.
//
// Opt-out: YAW_MCP_SIDECAR_REFRESH=0 (or =false), parsed exactly like
// auto-upgrade's YAW_MCP_AUTO_UPGRADE.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireUpgradeLock } from "./auto-upgrade.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { compareVersions } from "./oam-spawn.js";
import { CONFIG_DIRNAME, sidecarsRoot } from "./paths.js";
import {
  collectSidecarSpecs,
  hasManagedSidecars,
  installedVersion,
  runSidecarsInstall,
  type SidecarSpec,
} from "./sidecars-cmd.js";

/** How long a completed check suppresses the next one. A day: sidecar releases
 *  land on the order of days, and the cost of checking is N registry round
 *  trips on a path that runs on EVERY MCP client start -- several times an hour
 *  for a heavy Claude Code user. Mirrors install-nudge's "act once, then stay
 *  quiet" cadence. */
export const SIDECAR_REFRESH_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Abort budget for one package's registry probe. Shorter than `upgrade`'s
 *  3000ms and matched to doctor's 2000ms for the reason doctor picked it:
 *  nobody is waiting for this answer, so a black-holed registry must cost a
 *  bounded couple of seconds and then read as "unknown", not hold a socket and
 *  a timer open behind a long-lived server process. The probes run in parallel,
 *  so N packages cost ONE budget, not N. */
export const SIDECAR_REGISTRY_TIMEOUT_MS = 2000;

/** State file, beside the other ~/.yaw-mcp state.
 *
 *  NOT a key in state.json, which is the obvious-looking home for it. Two
 *  reasons, either one fatal: persistence.ts's loadState rebuilds the state
 *  object from a fixed sanitizer (learning / packHistory / toolCache), so an
 *  unknown key does not survive a load; and saveState writes the WHOLE document
 *  from the running broker's in-memory snapshot, so the next debounced save
 *  would erase a timestamp written behind its back anyway. install-nudge hit
 *  the same wall and reached the same answer -- its own small file. */
export const SIDECAR_REFRESH_STATE_FILENAME = "sidecar-refresh-state.json";

/** Absolute path to the throttle-state file inside `~/.yaw-mcp/`. */
export function sidecarRefreshStatePath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SIDECAR_REFRESH_STATE_FILENAME);
}

/** The persisted throttle state. One key today; read-modify-written rather
 *  than overwritten so a key a later build adds here is not dropped by an
 *  older binary's write. */
interface SidecarRefreshState {
  /** Epoch ms of the last COMPLETED check. See maybeRefreshSidecars for the
   *  one path that deliberately does not record it. */
  lastSidecarRefreshCheck?: number;
}

/** What a write must supply: the state's keys, with the timestamp REQUIRED.
 *  Derived from SidecarRefreshState so the two cannot drift -- adding a key
 *  there widens this automatically instead of leaving a hand-copied literal
 *  behind. */
type SidecarRefreshStatePatch = Required<Pick<SidecarRefreshState, "lastSidecarRefreshCheck">>;

export interface SidecarRefreshDeps {
  /** Test hook: replace the per-package registry probe. */
  fetchLatestImpl?: (pkg: string) => Promise<string | null>;
  /** Test hook: replace the background refresh. `onDone` releases the sidecars
   *  lock and MUST be called once the refresh has finished (or failed). */
  spawnRefreshImpl?: (stale: SidecarSpec[], onDone: () => void) => void;
  /** Test hook: replace the lockfile that serializes concurrent refreshes.
   *  Returning null means "someone else holds it". */
  acquireLockImpl?: (dir: string) => (() => void) | null;
  /** Test hook: replace the on-disk installed-version read. */
  installedVersionImpl?: (pkg: string, home?: string) => string | null;
  /** Test hook: replace the "is there a managed tree at all" probe. */
  hasManagedSidecarsImpl?: (home?: string) => boolean;
  /** Test hook: replace the configured-sidecar-spec load. */
  specsImpl?: () => Promise<SidecarSpec[]>;
  /** Test hook: the clock. */
  nowImpl?: () => number;
  /** Test hook: read the throttle state. Null means unreadable or absent,
   *  which reads as "never checked" (fail-open).
   *
   *  Typed via SidecarRefreshState rather than re-declaring its shape inline:
   *  that interface is read-modify-written precisely so a key a later build
   *  adds is not dropped, and a hand-copied `{ lastSidecarRefreshCheck?: number }`
   *  here would silently fail to carry such a key -- with no type error to
   *  catch the drift, which is the exact failure the interface guards against. */
  readStateImpl?: () => SidecarRefreshState | null;
  /** Test hook: persist the throttle state. Best-effort; never throws. */
  writeStateImpl?: (patch: SidecarRefreshStatePatch) => void;
  /** Home directory the managed tree lives under. Defaults to homedir(). */
  home?: string;
}

export interface SidecarRefreshPlan {
  /** Packages that asked to float and are behind the registry. */
  stale: Array<{ pkg: string; installed: string; latest: string }>;
  /** Every other configured package, with the reason it was passed over. */
  skipped: Array<{ pkg: string; reason: string }>;
}

/** True when a unit test is driving. Every DEFAULT implementation below is
 *  gated on it, in one place, because each one reaches something a test run
 *  must never touch: the network, the user's real ~/.yaw-mcp, a lockfile in a
 *  real sidecars root, or a real `npm install`. Tests inject their own impls
 *  and never see these paths; a test that forgets to inject one gets a
 *  deterministic no-op instead of a machine-dependent side effect. Mirrors the
 *  VITEST short-circuits in upgrade-cmd (npmGlobalPrefix), auto-upgrade
 *  (defaultAcquireLock) and doctor (registrySkipCheck). */
function inUnitTest(): boolean {
  return Boolean(process.env.VITEST);
}

/**
 * The configured version range for a spec, derived EXACTLY the way
 * sidecarsManifest derives the dependency value it writes into the managed
 * package.json: everything after the package name, with the `@` separator
 * stripped, and a bare name reading as `latest`.
 *
 * It has to be the same derivation, because the manifest is what npm actually
 * acts on. If this read `pkg@^1.0.0` as floating while the manifest wrote
 * `^1.0.0`, we would schedule a refresh npm then refuses to perform, and
 * re-schedule it every day forever.
 */
export function configuredRange(spec: SidecarSpec): string {
  // collectSidecarSpecs derives `pkg` FROM `spec` via packageName, so the name
  // is always a prefix -- but a caller constructing a SidecarSpec by hand (or a
  // future collector) could break that, and slicing by a length that does not
  // correspond to a prefix yields a nonsense range. Report the whole spec as
  // the range: it will not equal "latest", so the package is left alone, which
  // is the safe direction for an input we do not understand.
  if (!spec.spec.startsWith(spec.pkg)) return spec.spec;
  const raw = spec.spec.slice(spec.pkg.length).replace(/^@/, "");
  return raw === "" ? "latest" : raw;
}

/**
 * Why this spec can never be refreshed, or null when it is eligible.
 *
 * THE single eligibility rule, shared by buildRefreshPlan (which reports it)
 * and maybeRefreshSidecars (which uses it to avoid probing the registry for a
 * package it could not move anyway). Two copies of this predicate is how the
 * probe set and the plan come to disagree about which packages are in play.
 */
function ineligibleReason(spec: SidecarSpec): string | null {
  const range = configuredRange(spec);
  if (range === "latest") return null;
  return `configured "${range}", not "latest" -- an explicit pin, range or dist-tag is left alone`;
}

/**
 * Decide which managed packages are stale. Pure: no I/O, no clock, no env.
 * This is where the staleness matrix lives, so it is the half that gets tested
 * exhaustively.
 *
 * `stale` and `skipped` PARTITION `specs`: every configured package appears in
 * exactly one of them, exactly once. An up-to-date package is a skip with a
 * reason like any other, so a caller rendering the plan never has to account
 * for a package that simply vanished.
 */
export function buildRefreshPlan(args: {
  specs: SidecarSpec[];
  installed: Map<string, string | null>;
  latest: Map<string, string | null>;
}): SidecarRefreshPlan {
  const stale: SidecarRefreshPlan["stale"] = [];
  const skipped: SidecarRefreshPlan["skipped"] = [];
  for (const spec of args.specs) {
    // Order matters: intent first. A pinned package is passed over for BEING
    // pinned, not for "the registry did not answer" -- we never asked.
    const ineligible = ineligibleReason(spec);
    if (ineligible !== null) {
      skipped.push({ pkg: spec.pkg, reason: ineligible });
      continue;
    }
    const installed = args.installed.get(spec.pkg) ?? null;
    if (installed === null) {
      // Configured but absent. Not stale -- never acquired. See the header on
      // why "keep it current" is not "fetch it for the first time", and the
      // KNOWN GAP that the whole-tree action cannot fully honour that.
      skipped.push({ pkg: spec.pkg, reason: "not installed in the managed tree" });
      continue;
    }
    const latest = args.latest.get(spec.pkg) ?? null;
    if (latest === null) {
      // Offline, 404, a private package, or a probe that timed out. Unknown is
      // not stale: acting on it would mean refreshing on no evidence.
      skipped.push({ pkg: spec.pkg, reason: "registry did not answer" });
      continue;
    }
    // Semver, never a string compare. compareVersions returns 0 for anything it
    // cannot parse, so a package with a non-semver version reads as equal and
    // is passed over rather than being handed a made-up verdict.
    const cmp = compareVersions(installed, latest);
    if (cmp < 0) {
      stale.push({ pkg: spec.pkg, installed, latest });
    } else if (cmp > 0) {
      // Ahead of the registry: a local dev build linked into the tree, or a
      // release yanked after we installed it. Refreshing would DOWNGRADE.
      skipped.push({ pkg: spec.pkg, reason: `installed ${installed} is newer than the registry's ${latest}` });
    } else {
      skipped.push({ pkg: spec.pkg, reason: `up to date (${installed})` });
    }
  }
  return { stale, skipped };
}

/** Latest-version probe for one package. Same contract and response validation
 *  as upgrade-cmd's fetchLatestVersion (null on any failure, hard abort at the
 *  budget) but keyed by package -- that one is hardwired to @yawlabs/mcp.
 *
 *  doctor-cmd has a near-identical fetchSidecarLatest, and this is NOT that one
 *  reused: it is unexported, and importing doctor-cmd would drag the entire
 *  diagnostic command onto the serve startup path for one fetch. (oam-spawn's
 *  compareVersions header documents the same dependency-direction rule.) If a
 *  third copy ever wants to exist, promote one to a shared module instead. */
async function defaultFetchLatest(pkg: string): Promise<string | null> {
  if (inUnitTest()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SIDECAR_REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
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

/** The lock the serve path actually uses.
 *
 *  auto-upgrade's acquireUpgradeLock, not a second implementation of it: the
 *  O_EXCL take, the stale-steal window and the backwards-clock skew margin are
 *  subtle enough that a copy would drift. It is keyed on the DIRECTORY, so a
 *  lock in the sidecars root cannot contend with a lock in a global npm prefix
 *  -- the two features serialize independently even though they share the
 *  primitive. (Wart, called out so nobody hunts for a bug: the file it creates
 *  is named `.yaw-mcp-upgrade.lock` even here. Renaming it per-caller would
 *  mean parameterizing auto-upgrade, for a filename nothing reads.) */
function defaultAcquireLock(dir: string): (() => void) | null {
  if (inUnitTest()) return () => {};
  return acquireUpgradeLock(dir);
}

/** npm runner for the BACKGROUND refresh: silent, and that is the whole point.
 *
 *  sidecars-cmd's own defaultRunNpm spawns with `stdio: ["ignore", 2,
 *  "inherit"]` -- npm's stdout routed to fd 2, npm's stderr inherited. That is
 *  right for the CLI, where progress on stderr keeps `--json` on stdout
 *  parseable and a human wants to watch a long install. It is WRONG here:
 *  called from inside `serve`, it sprays "added 220 packages in 12s" and every
 *  npm warning into the MCP server's own stderr, which is the stream the client
 *  reads our diagnostics from. Hence `stdio: "ignore"` and the no-op out/err at
 *  the call site -- the injectable runNpm hook exists for exactly this.
 *
 *  The rest is defaultRunNpm's shape, and must stay that way: npm on Windows is
 *  a .cmd shim Node refuses to spawn without a shell (post-CVE-2024-27980),
 *  which is safe ONLY because every argument here is a fixed literal and `cwd`
 *  travels as a spawn option rather than in the command line. Do not
 *  interpolate a package name into these args. */
function silentRunNpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(isWindows ? "npm.cmd" : "npm", args, {
        cwd,
        stdio: "ignore",
        // Not detached, so the install shares yaw-mcp's process group -- see the
        // KNOWN GAP in the header about what a client-side teardown does to it.
        detached: false,
        shell: isWindows,
      });
    } catch {
      // spawn can fail SYNCHRONOUSLY (an option the platform rejects, a cwd
      // that vanished) rather than emitting 'error'. Same -1 as the error path.
      resolve(-1);
      return;
    }
    child.on("error", () => resolve(-1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
}

/** Run the refresh in the background and release the lock when it settles.
 *
 *  `stale` is here for the log line and for a test to assert on -- it is NOT a
 *  work list, because runSidecarsInstall has no way to accept one: it rewrites
 *  the manifest from bundles.json and installs the tree as a whole. See the
 *  header's first KNOWN GAP for why that is nonetheless safe for pinned specs.
 *
 *  onDone fires on EVERY exit path -- resolve, reject, and the
 *  impossible-in-practice synchronous throw -- via `finally`. auto-upgrade
 *  needed two handlers and a `released` flag to get the same guarantee out of a
 *  child process; one promise gets it for free. */
function defaultSpawnRefresh(stale: SidecarSpec[], onDone: () => void, home: string): void {
  if (inUnitTest()) {
    onDone();
    return;
  }
  void (async () => {
    try {
      const result = await runSidecarsInstall({
        home,
        // Silent on all three channels. `out`/`err` default to writing the
        // command's prose to stdout/stderr, which from inside serve would mean
        // an "Installed:" table in the middle of the MCP stream.
        runNpm: silentRunNpm,
        out: () => {},
        err: () => {},
      });
      if (result.exitCode === 0) {
        log("info", "yaw-mcp sidecar refresh complete; restart your MCP client to spawn the new versions", {
          refreshed: stale.map((s) => s.pkg),
          installed: result.installed.map((i) => `${i.pkg}@${i.version ?? "?"}`),
        });
      } else {
        // stdio was ignored, so the underlying npm error is not recoverable
        // here. Name the manual command rather than pretending to diagnose.
        log("warn", "yaw-mcp sidecar refresh did not complete; run `yaw-mcp sidecars install` to see why", {
          exitCode: result.exitCode,
        });
      }
    } catch (err) {
      log("warn", "yaw-mcp sidecar refresh failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      onDone();
    }
  })();
}

/** Read the throttle state. Fail-open: an absent, unreadable or corrupt file
 *  reads as null, i.e. "never checked", so the worst case is one extra check --
 *  never a suppressed feature. */
function defaultReadState(home: string): SidecarRefreshState | null {
  if (inUnitTest()) return null;
  try {
    const parsed = JSON.parse(readFileSync(sidecarRefreshStatePath(home), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const at = (parsed as SidecarRefreshState).lastSidecarRefreshCheck;
    // A non-finite / negative timestamp is a hand-edited or corrupt file. Drop
    // the VALUE rather than the whole read: NaN fails every comparison
    // silently, and "never checked" is the honest reading of a broken stamp.
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return {};
    return { lastSidecarRefreshCheck: at };
  } catch {
    return null;
  }
}

/** Persist the throttle state. Read-modify-write so an unknown key written by
 *  a newer build survives this one's write. Best-effort: a write failure costs
 *  at most one extra check on the next startup, so it is swallowed at debug --
 *  the same trade install-nudge makes. Plain writeFileSync rather than an
 *  atomic rename: a torn write reads back as corrupt, which defaultReadState
 *  already treats as "never checked". */
function defaultWriteState(home: string, patch: SidecarRefreshStatePatch): void {
  if (inUnitTest()) return;
  try {
    const path = sidecarRefreshStatePath(home);
    const next = { ...(defaultReadState(home) ?? {}), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    log("debug", "sidecar-refresh: failed to record the check timestamp", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The configured sidecar specs, from the same loader `sidecars install` uses
 *  so the plan is computed against the manifest the refresh will actually
 *  write. A load failure yields no specs, which is a clean no-op. */
async function defaultSpecs(home: string): Promise<SidecarSpec[]> {
  // Gated like every other default. loadLocalBundles walks the real cwd AND
  // the real home for bundles.json, so an ungated call made a test's result
  // depend on the developer's own config -- observably: running this module's
  // suite logged "Skipping an untrusted .yaw-mcp/ dir outside $HOME" naming a
  // real path. No specs is the same clean no-op the catch below produces.
  if (inUnitTest()) return [];
  try {
    const bundles = await loadLocalBundles({ home });
    return collectSidecarSpecs(bundles.config?.servers ?? []);
  } catch {
    return [];
  }
}

/** `hasManagedSidecars`, gated. One existsSync against the real
 *  ~/.yaw-mcp/sidecars, which is the FIRST gate maybeRefreshSidecars hits --
 *  so on a developer machine that has a managed tree, an ungated call let
 *  every later gate run against real state while CI (which has none) stopped
 *  at the door. False is the common real-world answer (`sidecars install` is
 *  opt-in) and the one that makes a forgotten injection a no-op. */
function defaultHasManagedSidecars(home: string): boolean {
  if (inUnitTest()) return false;
  return hasManagedSidecars(home);
}

/** `installedVersion`, gated. A stat + readFileSync + JSON.parse per package
 *  against the real managed tree. Null reads as "configured but not
 *  installed", which buildRefreshPlan already treats as not-stale. */
function defaultInstalledVersion(pkg: string, home: string): string | null {
  if (inUnitTest()) return null;
  return installedVersion(pkg, home);
}

/**
 * Fire-and-forget startup sidecar refresh check. Resolves once the check
 * completes; callers must NOT await it on the serve hot path, and it never
 * rejects -- every failure inside is absorbed to a no-op.
 */
export async function maybeRefreshSidecars(deps: SidecarRefreshDeps = {}): Promise<void> {
  try {
    // 1. Opt-out, before anything else -- same parse as auto-upgrade's, so one
    // habit ("=0 or =false turns it off") covers both background features.
    const optOut = process.env.YAW_MCP_SIDECAR_REFRESH;
    if (optOut === "0" || optOut?.toLowerCase() === "false") return;

    const home = deps.home ?? homedir();
    const now = (deps.nowImpl ?? Date.now)();

    // 2. No managed tree, nothing to refresh. This is the COMMON case --
    // `sidecars install` is opt-in -- and it is one existsSync, so it comes
    // before the state read and long before the network. An npx-launched
    // server re-resolves `@latest` on every spawn and was never stale.
    if (!(deps.hasManagedSidecarsImpl ?? defaultHasManagedSidecars)(home)) return;

    // 3. Throttle. `age < 0` means the recorded check is in the FUTURE -- a
    // clock stepped backwards, or a home directory copied from a machine ahead
    // of this one. Proceeding (rather than clamping, install-nudge's answer for
    // a different cadence) self-heals in one run: this check rewrites the
    // timestamp to a sane `now`. Clamping would instead suppress the feature
    // for a full day on a machine whose clock is already confused.
    const state = (deps.readStateImpl ?? (() => defaultReadState(home)))();
    const last = state?.lastSidecarRefreshCheck;
    if (typeof last === "number") {
      const age = now - last;
      if (age >= 0 && age < SIDECAR_REFRESH_THROTTLE_MS) return;
    }
    const recordCheck = (): void =>
      (deps.writeStateImpl ?? ((patch: SidecarRefreshStatePatch) => defaultWriteState(home, patch)))({
        lastSidecarRefreshCheck: now,
      });

    // 4. What is configured.
    const specs = await (deps.specsImpl ?? (() => defaultSpecs(home)))();
    if (specs.length === 0) {
      recordCheck();
      return;
    }

    // 5. What is on disk, and what the registry has. Both reads are scoped to
    // specs that could actually be moved, via the same ineligibleReason the
    // plan uses -- so neither set can disagree with the plan about who is in
    // play. The installed read is cheap but not free (stat + readFileSync +
    // JSON.parse each) and this is the serve startup path: for a pinned spec
    // buildRefreshPlan reaches its ineligible branch FIRST and never consults
    // installed.get, so reading those versions was work whose result was
    // guaranteed unused. doctor's `anyManaged` short-circuit models the same
    // shape.
    const installedVersionFn = deps.installedVersionImpl ?? defaultInstalledVersion;
    const eligible = specs.filter((s) => ineligibleReason(s) === null);
    const installed = new Map<string, string | null>(
      eligible.map((s): [string, string | null] => [s.pkg, installedVersionFn(s.pkg, home)]),
    );
    const probable = eligible.filter((s) => (installed.get(s.pkg) ?? null) !== null);
    const fetchLatest = deps.fetchLatestImpl ?? defaultFetchLatest;
    // Parallel, so N packages cost one timeout window. Each probe is
    // individually absorbed to null: Promise.all rejects on the FIRST rejection
    // and abandons the others' results, so one 404 must not be able to turn the
    // whole check into a thrown error.
    const latest = new Map<string, string | null>(
      await Promise.all(
        probable.map(async (s): Promise<[string, string | null]> => {
          try {
            return [s.pkg, await fetchLatest(s.pkg)];
          } catch {
            return [s.pkg, null];
          }
        }),
      ),
    );

    // 6. Decide. Some packages resolving and others not is NOT a reason to
    // refuse the batch: the action is whole-tree (see KNOWN GAPS), so "refresh
    // only the ones that resolved" is not even expressible -- and a package
    // whose probe failed is one whose configured `latest` range npm will move
    // forward anyway, which is what that range asked for. Refusing on one
    // failed lookup would let a single 404 or slow package disable the refresh
    // for every other package, once a day, forever.
    const plan = buildRefreshPlan({ specs, installed, latest });
    if (plan.stale.length === 0) {
      // Nothing to do -- including the all-probes-failed (offline) case, which
      // is deliberately RECORDED rather than retried. A machine with no network
      // would otherwise probe the registry on every single client start, which
      // is precisely the storm the throttle exists to prevent; the cost of
      // getting it "wrong" is one day of staleness on a background nicety.
      log("debug", "sidecar refresh: nothing stale", { skipped: plan.skipped });
      recordCheck();
      return;
    }

    // 7. Serialize. A null lock means another process is mid-refresh, and the
    // timestamp is deliberately NOT recorded: the winner is doing the work this
    // process would have done, and if it dies before finishing, the loser
    // retries on the next startup instead of sitting out a full day on a
    // refresh that never happened. (Unlike the offline case above, this is not
    // a completed check -- it is a check that yielded to someone else.)
    const release = (deps.acquireLockImpl ?? defaultAcquireLock)(sidecarsRoot(home));
    if (release === null) {
      log("info", "sidecar refresh: another process is already refreshing this tree; skipping this one", {
        stale: plan.stale.map((s) => s.pkg),
      });
      return;
    }
    // Release exactly once no matter how many paths reach it. The default
    // lock's own release is already idempotent, but an INJECTED acquireLockImpl
    // need not be -- and a double release would unlink a lock a DIFFERENT
    // process had since taken, which is the failure the lock exists to prevent.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    // 8. Go. Record the timestamp regardless of how the background refresh
    // turns out: the CHECK is what the throttle governs, and a refresh that
    // fails must not put this process into a retry loop against a registry or
    // an npm that is already unhappy.
    const staleSpecs = specs.filter((s) => plan.stale.some((p) => p.pkg === s.pkg));
    log("info", "yaw-mcp sidecars are behind npm; refreshing the managed tree in the background", {
      stale: plan.stale.map((s) => `${s.pkg} ${s.installed} -> ${s.latest}`),
    });
    try {
      (deps.spawnRefreshImpl ?? ((s: SidecarSpec[], done: () => void) => defaultSpawnRefresh(s, done, home)))(
        staleSpecs,
        releaseOnce,
      );
    } catch (err) {
      // A synchronous throw out of the spawn would otherwise leave the lock held
      // for the full stale window, suppressing the next several startups'
      // refresh over a failure that already happened.
      releaseOnce();
      log("warn", "sidecar refresh: could not start the background refresh", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    recordCheck();
  } catch (err) {
    // The contract is "never throws". Anything unanticipated -- an injected dep
    // that misbehaves, a clock impl that blows up -- degrades to a skipped
    // check, never to a rejected promise on the serve startup path.
    log("debug", "sidecar refresh check failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
