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
// not re-read the file per spawn. ONE shape is exempt: a bundles.json that
// exists but yielded no config (a degraded read with nothing configured) does
// not cache its verdict, so a file that gets FIXED is picked up by the next
// connect. It is negative-cached on the stat signature of EVERY file the
// verdict read instead, so a tree that stays broken costs a couple of stats
// per connect rather than a full read-hash-parse. See the inline note in
// defaultRuntime below.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LoadLocalBundlesResult, loadLocalBundles, localBundlesPath } from "./local-bundles.js";
import { log } from "./logger.js";
import {
  isRegistrySpec,
  MIN_OAM_VERSION,
  nodeLaunchKind,
  npxSpecIndex,
  type OamProbe,
  oamFailureLabel,
  specConstraint,
} from "./oam-spawn.js";
import { CONFIG_DIRNAME } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

export type RuntimeChoice = "oam" | "node";

// undefined = bundles.json not probed yet; null = probed, nothing configured.
let bundlesDefaultCache: RuntimeChoice | null | undefined;
let warnedInvalidEnv = false;

/** Every file the previous degraded verdict depended on, with the stat
 *  signature each had at the time. While they ALL still carry those
 *  signatures the verdict cannot have changed, so the re-read is skipped --
 *  see defaultRuntime. Null once any call reaches a usable answer.
 *
 *  Plural because the verdict is not a function of one file. A broken
 *  PROJECT bundles.json still falls back to the user-global file for
 *  `defaultRuntime` (local-bundles.ts, LoadLocalBundlesResult), so keying
 *  only on the broken project file meant an explicit user-global
 *  `defaultRuntime: "node"` written afterwards was never picked up -- the
 *  exact silent inversion this exemption exists to prevent. A `null`
 *  signature records "absent", so CREATING a file invalidates too. */
let degradedProbe: Array<{ path: string; signature: string | null }> | null = null;
let warnedDegradedBundles = false;

/** mtime + size of a file, or null when it cannot be stat'ed (deleted, or the
 *  directory became unreadable) -- null forces the full re-read, which is the
 *  right answer for a file that is no longer the one we looked at.
 *
 *  Size rides along with mtime because filesystem timestamp granularity is
 *  coarse (~15ms on NTFS): two writes inside one tick can share an mtime, and
 *  the pair is far less likely to collide than mtime alone. */
function statSignature(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** Reset the cached bundles.json default (test hook). */
export function resetDefaultRuntimeCache(): void {
  bundlesDefaultCache = undefined;
  warnedInvalidEnv = false;
  degradedProbe = null;
  warnedDegradedBundles = false;
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
  const raw = env.YAW_MCP_DEFAULT_RUNTIME;
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
 * one invocation. Omit it and the file is loaded here (what sidecars-cmd does,
 * having no bundles read of its own to share).
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
 * The config-level default runtime, or null when nothing is configured
 * (today's behavior: node/npx untouched). Env is checked on every call
 * (cheap, and lets a respawned broker pick up a change); the bundles.json
 * top-level `defaultRuntime` is read once and cached -- this sits on the
 * upstream connect path.
 *
 * `cwd`/`home` default to the real process values (production passes
 * nothing); they exist so the bundles path is testable without depending on
 * the machine the suite runs on. They seed the ONE-TIME read only: the cache
 * below is a single unkeyed slot, so a later call passing different values
 * gets the first call's answer rather than its own. Production resolves one
 * cwd for the process, so this is a test-ergonomics parameter, NOT a
 * per-call override -- key the cache before treating it as one.
 */
export async function defaultRuntime(opts: { cwd?: string; home?: string } = {}): Promise<RuntimeChoice | null> {
  const fromEnv = readEnvChoice(process.env);
  if (fromEnv !== null) return fromEnv;
  if (bundlesDefaultCache === undefined) {
    // A degraded read is not cached as an ANSWER (see below), which used to
    // mean the whole load -- read, project-trust hash, parse -- ran again on
    // every connect for as long as the file stayed broken. One stat says
    // whether it is still the same file; if it is, so is the verdict.
    if (degradedProbe?.every((f) => statSignature(f.path) === f.signature)) return null;
    const bundles = await loadLocalBundles({ cwd: opts.cwd ?? process.cwd(), home: opts.home }).catch(() => null);
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
      // Remember WHICH file was broken and how it looked, so the next connect
      // can answer with a stat. A signature taken after the read can, in the
      // narrow case of the file being fixed mid-read, describe content this
      // call never saw -- the fix is then picked up on the following edit or
      // restart rather than the next connect. That is a strictly smaller
      // staleness window than the positive cache, which holds for the process
      // lifetime. `bundles === null` (the loader itself threw) leaves no path
      // to stat, so that shape keeps re-reading as before.
      const path = bundles?.path ?? null;
      const signature = path === null ? null : statSignature(path);
      if (path === null || signature === null) {
        degradedProbe = null;
      } else {
        // The broken file plus the user-global file it falls back to. Same
        // construction local-bundles uses, so the two cannot disagree about
        // which path that is. Deduped for the case where the broken file IS
        // the user-global one.
        const globalPath = localBundlesPath(join(opts.home ?? homedir(), CONFIG_DIRNAME));
        const watched = path === globalPath ? [path] : [path, globalPath];
        degradedProbe = watched.map((f) => ({ path: f, signature: statSignature(f) }));
      }
      if (!warnedDegradedBundles) {
        warnedDegradedBundles = true;
        // Once, not per connect: the loader's own parse diagnostic stops
        // firing as soon as the re-read stops, so without this line the last
        // word on a broken bundles.json would be a single startup warning.
        log(
          "warn",
          "bundles.json could not be read for the default runtime; using the fallback until the file changes",
          { path: path ?? "(unknown)" },
        );
      }
      return null;
    }
    degradedProbe = null;
    bundlesDefaultCache = resolved;
  }
  return bundlesDefaultCache;
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
 *  auditable omission rather than an invisible one. */
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
 * Split out, and expressed with oam-spawn's own exported predicates
 * (npxSpecIndex / isRegistrySpec / specConstraint) rather than re-derived here,
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
    // `node` with nothing to run, or with a node FLAG where the entry belongs
    // (--enable-source-maps, --inspect): oam would eat the flag and mis-launch,
    // so the rewrite stays on node.
    const entry = args[0];
    if (!entry) return { code: "node-no-entry", detail: "the node launch names no entry file" };
    if (entry.startsWith("-")) {
      return { code: "node-flag-entry", detail: `the node launch starts with the flag ${entry}, not an entry file` };
    }
    return null;
  }
  if (kind === "npx") {
    // Same index the rewrite slices the server's own args at -- only -y/--yes
    // are npx's own, and only ahead of the spec.
    const idx = npxSpecIndex(args);
    const spec = idx === -1 ? undefined : args[idx];
    if (!spec) return { code: "npx-no-spec", detail: "the npx launch names no package" };
    if (spec.startsWith("-")) {
      return {
        code: "npx-flag-spec",
        detail: `the npx launch carries ${spec}, a flag yaw-mcp does not parse`,
      };
    }
    if (!isRegistrySpec(spec)) {
      return {
        code: "npx-non-registry-spec",
        detail: `the npx spec ${spec} is a git/path target, not a registry package`,
      };
    }
    const constraint = specConstraint(spec);
    if (constraint.kind === "range") {
      return {
        code: "npx-version-range",
        detail: `the npx spec pins the range ${constraint.raw}, which yaw-mcp cannot evaluate`,
      };
    }
    return null;
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
