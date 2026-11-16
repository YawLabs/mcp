// Config-level default runtime for MCP sidecars ("oam" | "node").
//
// Per-server `runtime: "oam"` (types.ts) is the original opt-in; this module
// adds the production-default knob so a machine with oam installed can host
// EVERY node/npx sidecar on it without editing each server entry:
//
//   resolution order (first hit wins):
//     1. per-server `config.runtime` ("node" stays an escape hatch)
//     2. YAW_MCP_DEFAULT_RUNTIME env var
//     3. bundles.json top-level `defaultRuntime`
//     4. unset -> oam when it is installed and >= MIN_OAM_VERSION, else node
//
// Step 4 is the "auto" default. It is not an opt-in: nothing is configured, so
// nothing should be SAID when oam is absent -- that is the overwhelmingly
// common case and a warning there is pure noise. Callers distinguish the two
// by whether steps 1-3 produced an answer (see `optedIn` on resolveOamSpawn);
// only an explicit opt-in that fails to reach oam is worth a warning.
//
// Applied in connectToUpstream (upstream.ts), NOT at config-load time, because
// the default is a machine-level fact (is oam installed HERE?) rather than a
// property of the config: it has to be resolved on the machine that SPAWNS the
// sidecar, not wherever bundles.json happened to be written. Moving it to
// config-load time would be cheaper (one call instead of one per connect) and
// is exactly the wrong trade.
//
// The bundles.json read is cached after the first call -- the connect path must
// not re-read the file per spawn. The cache is keyed on the stat signature
// (local-bundles.ts bundlesSignature) of every file the load consulted, so it
// costs a stat or two per connect and an EDIT to `defaultRuntime` is picked up
// by the next connect, like every other bundles.json edit -- it used to hold
// for the process lifetime, while each activation error promised the edit was
// live. ONE shape is handled differently: a bundles.json that exists but
// yielded no config (a degraded read with nothing configured) does not cache
// its verdict as an answer; it is negative-cached on the same signature AND a
// short time bound. See the inline notes in defaultRuntime below.

import { bundlesSignature, type LoadLocalBundlesResult, loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import {
  classifyNpxLaunch,
  describeNodeFlagRefusal,
  MIN_OAM_VERSION,
  nodeLaunchKind,
  type OamProbe,
  oamFailureLabel,
  scanNodeLaunchFlags,
} from "./oam-spawn.js";
import type { UpstreamServerConfig } from "./types.js";

export type RuntimeChoice = "oam" | "node";

/** The last usable bundles.json answer (`value` null = read, nothing
 *  configured), with the files that read consulted and the stat signature they
 *  had. undefined = not probed yet. The answer is served only while the
 *  signature still matches, so an edit to any consulted file -- or the
 *  creation of one that was absent -- re-reads on the next connect.
 *
 *  One exception keeps a stale entry in use: when that re-read is degraded
 *  and empty (the edit left a file that will not parse), the entry is kept
 *  and its value is still the answer, until a later read succeeds -- see the
 *  degraded branch of resolveBundlesDefault.
 *
 *  What a stat cannot see stays stale until one of those files moves or the
 *  broker restarts: a project `.yaw-mcp/` created where the load's directory
 *  walk found none (it is not in consultedPaths, so nothing watches for it),
 *  and the same-size, same-mtime rewrite bundlesSignature documents. server.ts
 *  watches the same set the same way for its own reload, so the two agree
 *  about when bundles.json has changed. */
let bundlesDefaultCache: { value: RuntimeChoice | null; watched: string[]; signature: string } | undefined;
let warnedInvalidEnv = false;

/** The read currently in flight, so a BURST of connects collapses into one.
 *
 *  The result cache alone does not do that: it is written after the await, and
 *  prewarm connects to every active server CONCURRENTLY -- so every one of
 *  them sees `bundlesDefaultCache === undefined`, and N connects meant N full
 *  loads (read, project-trust hash, parse) of the same file, plus N copies of
 *  its read-time warnings. Memoizing the PROMISE is what makes "read once"
 *  true for the concurrent case the docstring describes; the result cache
 *  still covers every later call. Cleared as soon as it settles, so a degraded
 *  read (which deliberately caches no answer) stays retryable. */
let inflight: Promise<RuntimeChoice | null> | null = null;

/** Every file the previous degraded verdict depended on, with the joint stat
 *  signature they had at the time (bundlesSignature -- the same detector the
 *  positive cache and server.ts use, not a second one kept here). While it
 *  still matches the verdict cannot have changed, so the re-read is skipped --
 *  see defaultRuntime. Null once any call reaches a usable answer.
 *
 *  Plural because the verdict is not a function of one file. A broken
 *  PROJECT bundles.json still falls back to the user-global file for
 *  `defaultRuntime` (local-bundles.ts, LoadLocalBundlesResult), so keying
 *  only on the broken project file meant an explicit user-global
 *  `defaultRuntime: "node"` written afterwards was never picked up -- the
 *  exact silent inversion this exemption exists to prevent. The signature
 *  records an absent file as absent, so CREATING a file invalidates too. */
let degradedProbe: { watched: string[]; signature: string; at: number } | null = null;

/** How long a degraded verdict may be reused before it is re-derived, even
 *  when every watched file is byte-identical.
 *
 *  The stat signatures catch the common invalidations immediately (the user
 *  fixes the broken file, or sets the knob in the file it falls back to). But
 *  the verdict also depends on an input no stat can watch: whether a project
 *  `.yaw-mcp/` exists ANYWHERE between cwd and $HOME. That is a directory
 *  walk, not a path, so a project bundles.json created mid-process would
 *  otherwise stay invisible for the process lifetime -- silently inverting an
 *  explicit defaultRuntime, which is the one failure this exemption exists to
 *  prevent. Bounding the reuse in time makes EVERY input converge, including
 *  the ones that cannot be enumerated, while still collapsing a burst of
 *  connects into a single read. */
const DEGRADED_RECHECK_MS = 5_000;
let warnedDegradedBundles = false;

/** Reset the cached bundles.json default (test hook). */
export function resetDefaultRuntimeCache(): void {
  bundlesDefaultCache = undefined;
  warnedInvalidEnv = false;
  degradedProbe = null;
  warnedDegradedBundles = false;
  inflight = null;
}

/**
 * Step 2 of the resolution order: the YAW_MCP_DEFAULT_RUNTIME override, or
 * null when it is unset/empty/invalid. An invalid value warns once per process
 * (the `warnedInvalidEnv` latch) and is otherwise ignored.
 *
 * Shared by BOTH resolvers below on purpose. They differ only in their env
 * source (doctor injects one; the connect path reads process.env), and any
 * divergence in what counts as valid would make doctor report a default the
 * connect path does not honor -- so the parse lives in exactly one place.
 */
function readEnvChoice(env: NodeJS.ProcessEnv): RuntimeChoice | null {
  // Trimmed first for the cmd.exe `set VAR=node && yaw-mcp` idiom, which
  // keeps the space before `&&` in the value -- the same rule resolveTimeoutEnv
  // (upstream.ts) and decideServeMode (serve-gate.ts) apply. Untrimmed, an
  // explicit "node " opt-out warned and fell through to the oam default.
  const raw = env.YAW_MCP_DEFAULT_RUNTIME?.trim();
  if (raw === "oam" || raw === "node") return raw;
  if (raw !== undefined && raw !== "" && !warnedInvalidEnv) {
    warnedInvalidEnv = true;
    log("warn", 'Ignoring invalid YAW_MCP_DEFAULT_RUNTIME (expected "oam" or "node")', { value: raw });
  }
  return null;
}

/** Where a resolved default came from -- surfaced by the reporting commands. */
export interface DefaultRuntimeInfo {
  runtime: RuntimeChoice | null;
  source: "env" | "bundles" | null;
  /** Absolute path of the bundles.json that set the default (source
   *  "bundles" only). Doctor prints it because the connect path resolves
   *  project-local bundles from the BROKER's cwd (wherever the MCP client
   *  spawned yaw-mcp) while doctor resolves from the shell's cwd --
   *  naming the file makes a divergence between the two visible. */
  path: string | null;
}

/**
 * Resolve the config-level default runtime WITHOUT caching, reporting where
 * it came from. Used by the interactive reporting commands, which want fresh
 * state and provenance rather than the connect path's cache: `doctor` (OAM
 * RUNTIME section) and `sidecars install` (its unhosted note). The env var wins
 * over bundles.json; an invalid env value is ignored with a warn (once per
 * process, shared with defaultRuntime below).
 *
 * `bundles` is an ALREADY-LOADED loadLocalBundles result, for a caller that
 * needs the same file for something else. Passing it is not an optimization
 * detail -- doctor reads bundles.json for its server list too, and without
 * this it read the file TWICE per run, which was observable: every read-time
 * diagnostic ("bundles.json is not valid JSON; ignoring") was logged twice for
 * one invocation. BOTH reporting commands pass it today -- sidecars-cmd loads
 * bundles.json for its own server list before it asks for the default, exactly
 * as doctor does, and threads that load down to its unhosted note. Omitting it
 * is the fallback for a caller with no read of its own: correct, but it re-reads
 * the file and re-emits those read-time warns, which is the bug the seam exists
 * to prevent.
 *
 * `env` is threaded into that load so the loader's project-trust gate sees the
 * same environment the caller's own probe does -- otherwise this resolver could
 * honour a project file doctor reports as ignored (or the reverse).
 */
export async function describeDefaultRuntime(
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    home?: string;
    bundles?: Pick<LoadLocalBundlesResult, "defaultRuntime" | "defaultRuntimePath"> | null;
  } = {},
): Promise<DefaultRuntimeInfo> {
  const env = opts.env ?? process.env;
  const fromEnv = readEnvChoice(env);
  if (fromEnv !== null) return { runtime: fromEnv, source: "env", path: null };
  const bundles =
    opts.bundles !== undefined
      ? opts.bundles
      : await loadLocalBundles({ cwd: opts.cwd, home: opts.home, env }).catch(() => null);
  return bundles?.defaultRuntime !== undefined
    ? { runtime: bundles.defaultRuntime, source: "bundles", path: bundles.defaultRuntimePath ?? null }
    : { runtime: null, source: null, path: null };
}

/**
 * The config-level default runtime, or null when nothing is configured. Null
 * is not "node": the connect path resolves it to oam when oam is installed and
 * at or above MIN_OAM_VERSION, and to node otherwise (step 4 in the header).
 * Env is checked on every call
 * (cheap, and lets a respawned broker pick up a change); the bundles.json
 * top-level `defaultRuntime` is read once and cached until a file that read
 * consulted changes on disk (see `bundlesDefaultCache`) -- this sits on the
 * upstream connect path, so the steady state is a stat per consulted file,
 * not a read. One read per change really means one: a concurrent burst
 * (prewarm connects every active server at the same moment) joins the read
 * already in flight rather than each starting its own -- see `inflight`.
 *
 * `cwd`/`home`/`env` default to the real process values (production passes
 * nothing); they exist so the bundles path is testable without depending on
 * the machine the suite runs on. They seed a READ only: the cache below is a
 * single slot keyed on the files the last read consulted, not on these
 * arguments, so a later call passing different values gets the cached answer
 * rather than its own for as long as those files are unchanged. Production
 * resolves one cwd for the process, so this is a test-ergonomics parameter,
 * NOT a per-call override -- key the cache before treating it as one.
 */
export async function defaultRuntime(
  opts: { cwd?: string; home?: string; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<RuntimeChoice | null> {
  const fromEnv = readEnvChoice(opts.env ?? process.env);
  if (fromEnv !== null) return fromEnv;
  const cached = bundlesDefaultCache;
  if (cached !== undefined && bundlesSignature(cached.watched) === cached.signature) return cached.value;
  // Never read, or a consulted file changed since. Join the read already in
  // flight rather than starting a second one. The memo is assigned BEFORE the
  // first await inside the load, so every connect in a prewarm burst lands
  // here and gets the same promise; it is cleared when that promise settles,
  // which is what keeps the uncached degraded verdict retryable on the NEXT
  // burst.
  if (inflight === null) {
    inflight = resolveBundlesDefault(opts).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** The uncached miss path of defaultRuntime: the degraded-probe gate, the
 *  bundles.json load, and the caching decision. A named function rather than
 *  inline so the promise memo above has something to hold. */
async function resolveBundlesDefault(opts: {
  cwd?: string;
  home?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeChoice | null> {
  // A degraded read is not cached as an ANSWER (see below), which used to
  // mean the whole load -- read, project-trust hash, parse -- ran again on
  // every connect for as long as the file stayed broken. One stat says
  // whether it is still the same file; if it is, so is the verdict.
  const now = opts.now ?? Date.now;
  if (
    degradedProbe !== null &&
    now() - degradedProbe.at < DEGRADED_RECHECK_MS &&
    bundlesSignature(degradedProbe.watched) === degradedProbe.signature
  ) {
    // The last good answer when there is one (see the degraded branch below),
    // null when this process never read a usable file.
    return bundlesDefaultCache?.value ?? null;
  }
  // `env` is threaded through for the same reason describeDefaultRuntime
  // passes it: loadLocalBundles's project-trust probe reads the env it is
  // handed, so a caller that injected one expects the trust decision -- and
  // with it whether a project-local defaultRuntime counts -- to follow it.
  const bundles = await loadLocalBundles({ cwd: opts.cwd ?? process.cwd(), home: opts.home, env: opts.env }).catch(
    () => null,
  );
  // A bundles.json that EXISTS but yielded no config (unreadable, or JSON
  // that will not parse) is a degraded read, not an answer -- and it is
  // indistinguishable from "nothing configured" once it reaches the cache.
  // That matters now that unset means oam-when-installed: caching it would
  // silently INVERT an explicit `defaultRuntime: "node"` for the rest of
  // the process. Return the fallback for this call, and let a connect that
  // sees a CHANGED file re-read it (the stat gate above is what keeps an
  // unchanged broken file from costing a read per connect).
  //
  // Only the degraded-AND-empty pair is left uncached. The healthy shapes
  // all still cache on the first call, including "no bundles.json anywhere"
  // (path null), so the connect path does not re-read per spawn.
  const degraded = bundles === null || (bundles.config === null && bundles.path !== null);
  const resolved = bundles?.defaultRuntime ?? null;
  if (degraded && resolved === null) {
    // An earlier usable answer is KEPT, not dropped. Its files changed (that
    // is how this call got here), but what replaced them cannot be read --
    // typically a half-finished edit saved with a JSON syntax error. Dropping
    // it would answer null, which the connect path resolves to oam when oam is
    // installed: an explicit `defaultRuntime: "node"` inverted mid-edit, the
    // one failure this exemption exists to prevent. The entry's signature is
    // now stale, so defaultRuntime's fast path no longer serves it; every call
    // comes through here (or the stat gate above) and the file is re-read as
    // soon as it changes again or the recheck window lapses. A file that is
    // DELETED is not degraded (the loader reports no path) and replaces the
    // answer normally.
    const lastGood = bundlesDefaultCache?.value ?? null;
    // Remember WHICH files were consulted and how they looked, so the next
    // connect can answer with a stat. A signature taken after the read can,
    // in the narrow case of the file being fixed mid-read, describe content
    // this call never saw -- the fix is then picked up when the recheck
    // window below lapses rather than on the next connect. `bundles === null`
    // (the loader itself threw) leaves no path to stat, so that shape keeps
    // re-reading as before. A broken file that has since become unstat-able
    // is recorded as absent, and so is re-read once it reappears or the
    // window lapses.
    const path = bundles?.path ?? null;
    if (path === null) {
      degradedProbe = null;
    } else {
      // Watch every file the load CONSULTED, as reported by the loader --
      // not a set derived from `path` here. Deriving it locally was wrong
      // in both directions: keying on the broken file alone missed the
      // user-global fallback, and adding the global path by hand still
      // missed the project candidate when the GLOBAL file was the broken
      // one (a project bundles.json created afterwards would never be
      // seen). consultedPaths is built where those inputs are actually
      // read, so it cannot drift from them. The DEGRADED_RECHECK_MS bound
      // above covers what it still cannot list -- a project `.yaw-mcp/`
      // that does not exist yet.
      const watched = bundles?.consultedPaths?.length ? bundles.consultedPaths : [path];
      degradedProbe = { watched, signature: bundlesSignature(watched), at: now() };
    }
    if (!warnedDegradedBundles) {
      warnedDegradedBundles = true;
      // Once, not per connect: the loader's own parse diagnostic stops
      // firing as soon as the re-read stops, so without this line the last
      // word on a broken bundles.json would be a single startup warning.
      log(
        "warn",
        lastGood === null
          ? "bundles.json could not be read for the default runtime; using the fallback until the file changes"
          : `bundles.json could not be read for the default runtime; keeping the last value read ("${lastGood}") until the file changes`,
        { path: path ?? "(unknown)" },
      );
    }
    return lastGood;
  }
  degradedProbe = null;
  // `bundles` is non-null here (a null load is degraded-and-empty, handled
  // above). The signature is taken after the read, with the same narrow
  // mid-read caveat as the degraded probe's: an edit that lands between the
  // read and this stat is described by the signature without having been
  // read, and stays unseen until the file moves again.
  const watched = bundles?.consultedPaths ?? [];
  bundlesDefaultCache = { value: resolved, watched, signature: bundlesSignature(watched) };
  return resolved;
}

/**
 * Plain-English form of an OamProbeFailure. It MOVED to oam-spawn.ts, next to
 * the type it describes, because resolveOamSpawn needs it too for its
 * opted-in-but-unusable warn and this module already imports from there -- the
 * other direction would be an import cycle on the connect path.
 *
 * Re-exported rather than relocated-and-repointed so doctor-cmd (which reaches
 * every other runtime-reporting helper through this module) keeps one import
 * site, and so this stays the place a reader looks for the wording.
 */
export { oamFailureLabel };

/** Machine-readable "why" for a per-server runtime verdict. Everything from
 *  "not-node-command" down is a silent-fallback case the reporting commands
 *  exist to make visible: the config asks for oam and the spawn quietly hands
 *  back node.
 *
 *  The six launch-shape codes each mirror ONE `return { command, args }` in
 *  rewriteForOam (oam-spawn.ts), in that function's own order. That 1:1 mapping
 *  is the point -- it is what makes a future gate added there and not here an
 *  auditable omission rather than an invisible one. "node-flag-entry" keeps
 *  its name for --json consumers, though since oam 0.19.5 (inside the floor) it means
 *  a leading node flag the rewrite will not carry onto `oam run`, not any
 *  leading flag (see scanNodeLaunchFlags). */
export type ServerRuntimeCode =
  | "remote"
  | "per-server-node"
  | "default-node"
  | "per-server-oam"
  | "default-oam"
  | "not-node-command"
  | "node-no-entry"
  | "node-flag-entry"
  | "npx-no-spec"
  | "npx-flag-spec"
  | "npx-non-registry-spec"
  | "npx-version-range"
  | "oam-not-installed"
  | "oam-unusable"
  | "oam-below-min";

/** Per-server effective-runtime verdict. Two commands render it: `doctor` (the
 *  per-server lines of its OAM RUNTIME section) and `sidecars install` (which
 *  reuses `reason` verbatim for its unhosted note, so the two cannot describe
 *  the same machine differently). */
export interface ServerRuntimeInfo {
  /** What the server would actually get: "oam", "node", or null for remote
   *  servers (no local spawn to host). */
  runtime: RuntimeChoice | null;
  code: ServerRuntimeCode;
  /** Human-readable "why" -- also emitted in --json output. */
  reason: string;
}

/**
 * The refusals rewriteForOam makes on the LAUNCH SHAPE alone -- command plus
 * argv, no disk lookup, no probe. Null when the shape is one the rewrite
 * accepts.
 *
 * Split out, and expressed with oam-spawn's own exported classifiers
 * (scanNodeLaunchFlags for a node launch, classifyNpxLaunch for an npx one)
 * rather than re-derived here,
 * for the reason the nodeLaunchKind comment below gives: doctor answering a
 * spawn-time question a SECOND way is how doctor ends up printing a runtime the
 * spawn does not produce. These gates are deterministic -- a config that trips
 * one gets node on every machine, oam installed or not -- so reporting "oam"
 * for them was reporting the POLICY decision, not the launch.
 *
 * The one refusal deliberately NOT modelled is the last: `resolveEntry`
 * returning null (no on-disk copy, or none declaring an exact pin). That reads
 * the npx caches at spawn time and would make doctor flap between runs; the
 * renderer says it in prose instead (doctor-cmd.ts's npx note).
 */
function describeLaunchShape(
  command: string,
  args: readonly string[],
): { code: ServerRuntimeCode; detail: string } | null {
  const kind = nodeLaunchKind(command);
  if (kind === "node") {
    // `node` with nothing to run, or with a leading node FLAG the rewrite
    // will not carry onto `oam run` (off the verified allowlist, like
    // --enable-source-maps or --inspect, or a value flag given spaced). The
    // SAME scan rewriteForOam runs, so an allowlisted flag such as
    // --max-old-space-size=4096 reports oam here exactly when the spawn hosts
    // it there.
    const scan = scanNodeLaunchFlags(args);
    if (scan.kind === "no-entry") return { code: "node-no-entry", detail: "the node launch names no entry file" };
    if (scan.kind === "refused")
      return { code: "node-flag-entry", detail: describeNodeFlagRefusal(scan.flag, scan.why) };
    return null;
  }
  if (kind === "npx") {
    // The SAME classification both rewrites run (classifyNpxLaunch), not a
    // second copy of its gate sequence -- only -y/--yes are npx's own, and
    // only ahead of the spec.
    const launch = classifyNpxLaunch(args);
    switch (launch.kind) {
      case "no-spec":
        return { code: "npx-no-spec", detail: "the npx launch names no package" };
      case "flag-spec":
        return {
          code: "npx-flag-spec",
          detail: `the npx launch carries ${launch.flag}, a flag yaw-mcp does not parse`,
        };
      case "non-registry-spec":
        return {
          code: "npx-non-registry-spec",
          detail: `the npx spec ${launch.spec} is a git/path target, not a registry package`,
        };
      case "version-range":
        return {
          code: "npx-version-range",
          detail: `the npx spec pins the range ${launch.range}, which yaw-mcp cannot evaluate`,
        };
      case "hostable":
        return null;
    }
  }
  return null;
}

/**
 * Pure verdict of which runtime a server would ACTUALLY get and why, mirroring
 * the gates connectToUpstream + resolveOamSpawn apply at spawn time:
 * per-server runtime > config default; then the command must be node/npx-shaped
 * AND carry a launch shape rewriteForOam accepts; then the oam binary must
 * exist and be >= MIN_OAM_VERSION. Deliberately does NOT probe package
 * resolution on disk (resolveNpmEntry) -- that depends on the npx caches at
 * spawn time and would make doctor output flap.
 *
 * `args` matters as much as `command` and callers must pass it: an `npx` server
 * whose spec is `github:owner/repo`, or a `node` launch that opens with a flag,
 * is refused by the rewrite on every machine. Omitting it is read as the empty
 * argv, which is what connectToUpstream itself passes (`config.args ?? []`).
 */
export function describeServerRuntime(
  server: Pick<UpstreamServerConfig, "type" | "command" | "runtime" | "args">,
  configDefault: RuntimeChoice | null,
  probe: OamProbe,
): ServerRuntimeInfo {
  if (server.type !== "local") {
    return { runtime: null, code: "remote", reason: "remote server (no local spawn)" };
  }
  if (server.runtime === "node") {
    return { runtime: "node", code: "per-server-node", reason: 'per-server runtime:"node"' };
  }
  // `null` (nothing configured) now means oam-when-available, so only an
  // explicit "node" default keeps a server off oam.
  const wantsOam = server.runtime === "oam" || (server.runtime === undefined && configDefault !== "node");
  if (!wantsOam) {
    return { runtime: "node", code: "default-node", reason: 'config default runtime:"node"' };
  }
  const via =
    server.runtime === "oam"
      ? 'per-server runtime:"oam"'
      : configDefault === "oam"
        ? 'default runtime "oam"'
        : "oam is the default when installed";
  // nodeLaunchKind, NOT string equality against "node"/"npx". rewriteForOam
  // matches on the BASENAME with any Windows executable extension stripped, so
  // `/usr/bin/node app.js`, `node.exe`, and an nvm/volta shim all get hosted on
  // oam at spawn time. Answering that question a second way here is the one
  // failure this whole module exists to prevent: doctor printing "node" for a
  // server the spawn puts on oam is worse than either behaviour alone, because
  // it sends the reader looking for the wrong bug.
  if (server.command === undefined || nodeLaunchKind(server.command) === null) {
    return { runtime: "node", code: "not-node-command", reason: `${via}, but command is not node/npx` };
  }
  // Launch-shape refusals rank ABOVE the probe verdicts for the same reason
  // not-node-command already does: they hold on every machine, so naming the
  // oam install instead would send the reader to fix the one thing that would
  // change nothing. `args ?? []` mirrors connectToUpstream's own coercion.
  const shape = describeLaunchShape(server.command, server.args ?? []);
  if (shape !== null) {
    return { runtime: "node", code: shape.code, reason: `${via}, but ${shape.detail}` };
  }
  if (probe.belowMin) {
    return {
      runtime: "node",
      code: "oam-below-min",
      reason: `${via}, but oam ${probe.version} is below min ${MIN_OAM_VERSION}`,
    };
  }
  // A PRESENT-but-broken oam before an absent one: both carry `bin === null`,
  // and only `failure` separates them. Reporting a wedged binary as "not
  // installed" sends a user who has oam installed -- often with OAM_BIN pointed
  // straight at it -- off to install it again, while the real cause never
  // surfaces. Checked after belowMin because that path sets failure to null and
  // has its own actionable numbers.
  if (probe.failure !== null) {
    return {
      runtime: "node",
      code: "oam-unusable",
      reason: `${via}, but oam is installed and unusable (${oamFailureLabel(probe.failure)})`,
    };
  }
  if (probe.bin === null) {
    return { runtime: "node", code: "oam-not-installed", reason: `${via}, but oam is not installed` };
  }
  return {
    runtime: "oam",
    code: server.runtime === "oam" ? "per-server-oam" : "default-oam",
    reason: via,
  };
}
