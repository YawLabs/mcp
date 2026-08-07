// Host an MCP sidecar on the oam runtime (https://oamjs.org) instead of
// node/npx. This is the spawn-rewrite half of "run Yaw's MCP sidecars on oam":
// connectToUpstream() applies it after resolveUvSpawn (upstream.ts) for every
// server that has not opted out -- oam is the default when it is installed and
// meets MIN_OAM_VERSION (see default-runtime.ts for the resolution order).
//
// It is deliberately conservative -- a pure optimization, never a correctness
// dependency. It rewrites only Node-based launches and falls back to the
// original node/npx command whenever oam can't host the server:
//   * oam isn't installed (no `oam` on PATH / OAM_BIN)        -> Node
//   * the command isn't Node-based (uv/uvx/docker/python/...) -> unchanged
//   * an npx package can't be resolved on disk                -> npx (Node)
//     (oam run needs a real entry; it can't reproduce npx's fetch-on-demand)
//
// Compat note: opt in the pure-JS/SDK tier (npmjs/fetch/lemonsqueezy) and the
// pure-JS DB drivers (postgres via `pg`, redis via `ioredis`) first. Servers
// with native addons (ssh2) or bundled browsers (playwright) are not oam-
// hostable yet. Boot failures ARE recovered: connectToUpstream respawns once
// on the original node/npx command when an oam-hosted child fails the connect
// handshake or dies during the initial capability fetch (see upstream.ts).
// There is still no auto-fallback after a healthy boot, so only opt in
// servers verified to run on oam.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { sidecarsNodeModules } from "./paths.js";

/**
 * Strip an npm version/tag suffix from a package spec:
 *   "@yawlabs/x-mcp@latest" -> "@yawlabs/x-mcp"
 *   "server-memory@1.2.3"   -> "server-memory"
 *   "@scope/name"           -> "@scope/name"
 */
export function packageName(spec: string): string {
  // For a scoped package the leading "@" is part of the name; the version
  // separator is the SECOND "@".
  const start = spec.startsWith("@") ? 1 : 0;
  const at = spec.indexOf("@", start);
  return at === -1 ? spec : spec.slice(0, at);
}

/**
 * Minimum oam version yaw-mcp will host sidecars on.
 *
 * POLICY: this tracks the LATEST oam release. Bump it with every oam release,
 * not only when a release happens to fix something this code noticed. oam is
 * pre-1.0 and moves fast, the install channel (oamjs.org) only ever hands out
 * the current release, and hosting sidecars on a runtime older than that means
 * debugging against a build nobody else is running. There is no support
 * commitment for older builds, so there is no reason to admit them.
 *
 * Below-min is treated the same as oam-absent: the spawn falls back to
 * node/npx with one warn log naming both versions. That is a safe outcome --
 * the user gets node, which is what they had before oam existed -- so an
 * aggressive floor costs nothing but a fallback, while a lax one silently
 * hosts production sidecars on a runtime that is no longer current.
 */
export const MIN_OAM_VERSION = "0.8.3";

/** One "oam is missing" warning per process, not one per opted-in server.
 *  Cleared by resetOamBinCache so tests do not leak it across cases. */
let warnedOamMissing = false;

/** Result of probing the oam binary (`oam --version`). */
export interface OamProbe {
  /** The spawnable oam binary -- null when oam is not installed OR its
   *  version is below MIN_OAM_VERSION (both mean "fall back to node"). */
  bin: string | null;
  /** Version reported by `oam --version` (e.g. "0.6.0"), or null when oam
   *  is not installed or the output was unparseable. */
  version: string | null;
  /** True when oam IS installed but below MIN_OAM_VERSION (bin is null). */
  belowMin: boolean;
}

let oamProbeCache: OamProbe | undefined;

/** Extract the first x.y.z version from `oam --version` output ("oam 0.6.0"). */
export function parseOamVersion(out: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  return m ? m[1] : null;
}

/** Dotted-numeric x.y.z compare: negative when a < b, 0 when equal/unparseable.
 *  Local copy (doctor-cmd.ts has compareSemver, but importing it here would
 *  create an upstream -> oam-spawn -> doctor-cmd dependency chain). */
function compareVersions(a: string, b: string): number {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Convert forward slashes to backslashes on Windows. The MCP SDK spawns stdio
 * servers with `shell: true` (-> cmd.exe), which mis-parses a forward-slash
 * command path ("C:/Users/.../oam.exe" makes cmd read "/Users" as a switch).
 * A backslash path (or a bare "oam.exe" on PATH) spawns correctly. No-op off
 * Windows. `platform` is injectable so the behaviour is testable cross-OS.
 */
export function winNormalize(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? p.replace(/\//g, "\\") : p;
}

/**
 * Probe the oam binary once (`oam --version`) and cache the result. OAM_BIN
 * overrides the binary path; it's normalized to a cmd-safe path so a
 * forward-slash OAM_BIN still spawns. The version output is parsed and gated
 * against MIN_OAM_VERSION: a below-min install is reported with bin=null
 * (same fallback as oam-absent) plus ONE warn log naming both versions. An
 * unparseable version is treated as usable -- a working `--version` proves
 * oam exists, and refusing on a future format change would silently disable
 * every opted-in server.
 *
 * `run` is injectable so the parse + gate logic is testable without a real
 * binary on PATH.
 */
/** How long `oam --version` gets before we give up and fall back to node.
 *  Matches the 3s budget uv-bootstrap's onPath() probe already uses. */
export const OAM_PROBE_TIMEOUT_MS = 3_000;

/**
 * SIGKILL, not the SIGTERM default. The kill is best-effort either way (see
 * below), but SIGTERM is strictly weaker: a child that traps or ignores it
 * simply keeps running, and Node does not escalate on its own.
 *
 * Measured on Linux (node v18) against the old synchronous probe, timeout 1500:
 *   child traps SIGTERM,  default killSignal -> never returned (killed at 12s)
 *   child traps SIGTERM,  killSignal SIGKILL -> threw at 1508ms, ETIMEDOUT
 *   child traps nothing,  default killSignal -> threw at 1504ms  (control)
 * Windows was unaffected either way: TerminateProcess cannot be trapped.
 */
export const OAM_PROBE_KILL_SIGNAL = "SIGKILL";

/** Hard cap on retained `oam --version` stdout. Replaces the 1MB maxBuffer
 *  that execFileSync applied for free before the async rewrite. */
export const OAM_PROBE_MAX_OUTPUT = 8 * 1024;

/** Bytes of the previous chunk kept so a version split across a chunk
 *  boundary ("0.6" | ".0") still matches. A dotted triple is ~20 chars. */
const VERSION_CARRY = 32;

/**
 * Accumulator for probe stdout.
 *
 * A naive prefix cap (`if (out.length < MAX) out += chunk`) is wrong twice
 * over, and both were shipped before this existed:
 *
 *   1. It is SOFT. The length check runs before the append, so one oversized
 *      chunk lands whole -- an 80KB chunk was retained in full under the old
 *      code. The bound was "MAX plus one chunk", not MAX.
 *   2. It DISCARDS THE VERSION when a binary prints more than MAX of banner
 *      first. parseOamVersion then returns null, and because the below-min
 *      branch is guarded on `version !== null`, the MIN_OAM_VERSION gate is
 *      skipped entirely -- yaw-mcp hosts on an oam it never version-checked.
 *      That gate exists because old builds produce hangs that look like
 *      server bugs, so truncation reintroduces exactly what it guards.
 *
 * So: scan every chunk for a version regardless of position, retain only a
 * hard-capped head for the no-version case, and never grow past the cap.
 * Exported for direct unit testing -- asserting the constant's value proves
 * nothing about whether anything is actually capped.
 */
export function createProbeCollector(max: number = OAM_PROBE_MAX_OUTPUT) {
  let head = "";
  let carry = "";
  let found: string | null = null;

  return {
    push(chunk: string): void {
      // Once a version is in hand there is nothing left for a further chunk to
      // do: `found` is monotonic, `carry` is read only on the not-yet-found
      // branch, and `head` is unreachable through result(). Returning early
      // matters for the exact case the cap exists for -- a binary that keeps
      // spewing after printing its version otherwise costs a full-chunk concat
      // plus a slice on every data event, with nothing retained to show for it.
      if (found !== null) return;
      // Scan across the boundary so a version straddling two chunks is seen.
      found = parseOamVersion(carry + chunk);
      carry = (carry + chunk).slice(-VERSION_CARRY);
      if (head.length >= max) return;
      head += chunk.slice(0, max - head.length); // slice, so the cap is HARD
    },
    /** The version if one appeared anywhere, else the capped head (which
     *  parses to null either way, so the caller's contract is unchanged). */
    result(): string {
      return found ?? head;
    },
    /** Test hook: bytes actually retained. */
    retainedLength(): number {
      return head.length;
    },
  };
}

/**
 * Run `oam --version` WITHOUT blocking the event loop.
 *
 * This was execFileSync until issue #91. A synchronous probe on the upstream
 * connect path of a single-threaded broker means any oam binary that fails to
 * exit freezes the whole hub -- the client stdio transport and every in-flight
 * upstream call stop being serviced. `timeout` did not fix that: spawnSync's
 * timer only *sends* killSignal and then keeps waiting for the child to exit,
 * so an unkillable child hangs the call regardless. A process in
 * uninterruptible sleep (D state) on a wedged NFS/FUSE mount takes no signal
 * at all, SIGKILL included, until the kernel completes the I/O -- which was
 * precisely the reported failure mode.
 *
 * Async is the only actual fix: the timer settles the promise and the event
 * loop keeps turning whether or not the orphan ever dies. We still try to kill
 * it, and `unref()` the timer so a pending probe cannot hold the process open
 * at shutdown.
 *
 * Resolves to the version found in stdout (or the capped head when none was
 * found -- see createProbeCollector), or rejects with `code: "ETIMEDOUT"` on
 * expiry -- the same shape probeOam's catch already distinguishes.
 */
function spawnVersionProbe(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: process.platform === "win32",
      });
    } catch (err) {
      reject(err);
      return;
    }

    // Bounded, position-independent collection -- see createProbeCollector for
    // why a plain prefix cap loses the version and does not actually cap.
    const collector = createProbeCollector();
    child.stdout?.setEncoding("utf8");
    // A pipe 'error' with no listener is an uncaught exception, which would
    // take the broker down -- precisely what the header promises this file
    // never does. And the riskiest moment is one we create on purpose: the
    // timeout path below destroys this pipe while a wedged child may still be
    // writing to it. Swallow it; there is nothing to recover, and the probe
    // still settles via 'close' or the deadline.
    child.stdout?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => collector.push(chunk));
    // 'error' fires for ENOENT (oam not installed) -- the routine case.
    child.on("error", (err) => settle(() => reject(err)));
    // `code` is null when the child died on a signal, so reporting it alone
    // yields "oam exited null" -- the one diagnostic the message carries,
    // dropped in the case most worth diagnosing.
    child.on("close", (code, signal) =>
      settle(() => (code === 0 ? resolve(collector.result()) : reject(new Error(`oam exited ${code ?? signal}`)))),
    );

    timer = setTimeout(() => {
      settle(() => {
        // Best-effort. A D-state child ignores this, which is exactly why the
        // promise is settled independently rather than waiting on the kill.
        try {
          child.kill(OAM_PROBE_KILL_SIGNAL);
        } catch {
          /* already gone */
        }
        // DETACH, do not merely kill. A live child with a piped stdout keeps
        // the PARENT's event loop alive -- verified: a parent with an unkilled
        // child and nothing else pending was still running after 6s. So when
        // the kill above does not take effect (the D-state case this whole
        // probe exists for, or a grandchild inheriting the pipe), settling the
        // promise unblocks the connect path but the broker can then never
        // exit. Trading a connect-path hang for a shutdown hang is not a fix.
        // unref drops the child from the loop's handle count; destroying stdout
        // releases the pipe the grandchild case would otherwise hold open.
        try {
          child.stdout?.destroy();
          child.unref();
        } catch {
          /* already gone */
        }
        const err = new Error(`oam --version exceeded ${OAM_PROBE_TIMEOUT_MS}ms`) as Error & { code?: string };
        err.code = "ETIMEDOUT";
        reject(err);
      });
    }, OAM_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** In-flight probe, so N concurrent connects share ONE spawn rather than
 *  racing to start their own before any of them has populated the cache. */
let oamProbeInFlight: Promise<OamProbe> | undefined;

/** Bumped by resetOamBinCache. A probe that was already in flight when the
 *  reset landed must NOT write its result afterwards -- otherwise the reset is
 *  silently undone by a probe the caller believes it discarded, and one test's
 *  probe can populate the cache for the next. */
let oamProbeGeneration = 0;

export async function probeOam(run: (bin: string) => Promise<string> = spawnVersionProbe): Promise<OamProbe> {
  if (oamProbeCache !== undefined) return oamProbeCache;
  if (oamProbeInFlight !== undefined) return oamProbeInFlight;
  const generation = oamProbeGeneration;
  oamProbeInFlight = probeOamUncached(run, generation).finally(() => {
    if (generation === oamProbeGeneration) oamProbeInFlight = undefined;
  });
  return oamProbeInFlight;
}

async function probeOamUncached(run: (bin: string) => Promise<string>, generation: number): Promise<OamProbe> {
  if (oamProbeCache !== undefined) return oamProbeCache;
  const bin = winNormalize(process.env.OAM_BIN || (process.platform === "win32" ? "oam.exe" : "oam"));
  /** Publish only if no reset landed while we were awaiting the spawn. The
   *  result is still RETURNED to this call's own caller either way -- it is
   *  correct for the state it observed; it just must not become the cache a
   *  post-reset caller reads. */
  const publish = (probe: OamProbe): OamProbe => {
    if (generation === oamProbeGeneration) oamProbeCache = probe;
    return probe;
  };
  try {
    const version = parseOamVersion(await run(bin));
    if (version !== null && compareVersions(version, MIN_OAM_VERSION) < 0) {
      log("warn", "oam is installed but below the minimum supported version; falling back to node", {
        oamVersion: version,
        minVersion: MIN_OAM_VERSION,
        // The floor tracks the latest release, so below-min always means out
        // of date, and oam updates itself in place.
        updateWith: "oam self-update",
      });
      return publish({ bin: null, version, belowMin: true });
    }
    return publish({ bin, version, belowMin: false });
  } catch (err) {
    // "oam is not installed" is the expected, silent case -- ENOENT here is
    // routine and logging it would be noise on every node-only setup.
    //
    // EVERY other failure is not routine: oam IS on disk and did not produce a
    // usable --version. Since the probe result is cached for the process
    // lifetime, that one moment silently downgrades every opted-in server to
    // node until restart, with nothing to explain why. So warn once, matching
    // the belowMin path, and let the timeout keep its own message -- it is the
    // only failure with an actionable budget attached to it.
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ETIMEDOUT") {
      log("warn", "oam did not respond to --version in time; falling back to node for this process", {
        timeoutMs: OAM_PROBE_TIMEOUT_MS,
        bin,
      });
    } else if (code !== "ENOENT") {
      // A non-zero exit, a signal death, an EACCES on a non-executable file,
      // or a spawn that threw outright. All of them mean a present-but-broken
      // oam, which is worth strictly more noise than an absent one.
      log("warn", "oam --version failed; falling back to node for this process", {
        bin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return publish({ bin: null, version: null, belowMin: false });
  }
}

/**
 * The oam binary to spawn, or `null` if oam isn't available (not installed,
 * or installed below MIN_OAM_VERSION -- see probeOam).
 */
export async function oamBin(): Promise<string | null> {
  return (await probeOam()).bin;
}

/** Reset the cached oam-binary probe (test hook). Bumps the generation so a
 *  probe still in flight cannot publish its result afterwards. */
export function resetOamBinCache(): void {
  warnedOamMissing = false;
  oamProbeCache = undefined;
  oamProbeInFlight = undefined;
  oamProbeGeneration++;
  // Cleared here too so the once-per-package pinned notice does not leak
  // across cases in tests that already reset the probe.
  pinnedReported.clear();
}

export interface OamRewriteDeps {
  /** The oam binary, or null when oam is unavailable (-> Node fallback). */
  oamBin: string | null;
  /** Resolve a package name to an on-disk entry, or null if unresolvable. */
  resolveEntry: (pkg: string) => string | null;
}

/**
 * Pure rewrite of a Node-based launch to `oam run`. Returns {command,args}
 * UNCHANGED for the Node-fallback cases described in the module header.
 *   node <entry> [..rest]   -> oam run <entry> [-- ..rest]
 *   npx [-y] <pkg> [..rest] -> oam run <resolved> [-- ..rest]
 */
export function rewriteForOam(
  command: string,
  args: string[],
  deps: OamRewriteDeps,
): { command: string; args: string[] } {
  const bin = deps.oamBin;
  if (!bin) return { command, args };

  const toOam = (entry: string, rest: string[]) => ({
    command: bin,
    args: rest.length > 0 ? ["run", entry, "--", ...rest] : ["run", entry],
  });

  if (command === "node") {
    const [entry, ...rest] = args;
    if (!entry) return { command, args };
    // A leading-dash arg is a node flag (--enable-source-maps, --inspect, ...),
    // not the entry file; oam would eat it and mis-launch. Stay on node --
    // mirrors the npx flag guard below.
    if (entry.startsWith("-")) return { command, args };
    return toOam(entry, rest);
  }

  if (command === "npx") {
    // Only -y/--yes are recognized, so any OTHER npx flag (--package, -p,
    // --node-options, ...) lands in `spec` and would be treated as the
    // package name. Staying on npx is the safe answer -- reimplementing
    // npx's arg parser here is not worth it -- but say WHY at debug level:
    // from the outside, an opted-in server quietly running on node is
    // indistinguishable from oam being absent.
    //
    // -y/--yes are skipped only where npx ITSELF consumes them: before the
    // spec. Everything after the spec belongs to the SERVER, so `rest` is
    // sliced from the original argv rather than from a filtered copy.
    // Filtering the whole list also ate a server's own trailing `--yes`, so
    // the oam launch and the npx fallback handed the child different
    // arguments -- the one thing this rewrite promises never to do.
    const specIdx = args.findIndex((a) => a !== "-y" && a !== "--yes");
    const spec = specIdx === -1 ? undefined : args[specIdx];
    if (!spec) return { command, args };
    if (spec.startsWith("-")) {
      log("debug", "npx launch carries flags yaw-mcp does not parse; staying on npx instead of oam", {
        flag: spec,
        args,
      });
      return { command, args };
    }
    const pkg = packageName(spec);
    const entry = deps.resolveEntry(pkg);
    if (!entry) {
      // oam run needs a real on-disk entry; it can't reproduce npx's
      // fetch-on-demand. Keep npx.
      log("debug", "npx package has no on-disk entry; staying on npx instead of oam", { package: pkg });
      return { command, args };
    }
    return toOam(entry, args.slice(specIdx + 1));
  }

  return { command, args };
}

/**
 * The `node_modules` directories of every npx install cache, derived from a
 * module path that lives under `_npx/<hash>/...`. When the broker is itself
 * launched via `npx -y @yawlabs/mcp`, its own location is inside one such
 * cache, so the SIBLING caches -- where other `npx -y <pkg>` servers were
 * fetched -- are reachable from here. Returns `[]` when the path is not under
 * an npx cache (e.g. a global or `node <abs>` launch).
 *
 * `fromUrl` is injectable for testing; it defaults to this module's own URL.
 */
export function npxCacheNodeModules(fromUrl: string = import.meta.url): string[] {
  let here: string;
  try {
    here = fileURLToPath(fromUrl);
  } catch {
    return [];
  }
  const marker = `${sep}_npx${sep}`;
  const idx = here.indexOf(marker);
  if (idx === -1) return [];
  const npxRoot = here.slice(0, idx + marker.length - sep.length); // ".../_npx"
  try {
    return readdirSync(npxRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(npxRoot, e.name, "node_modules"));
  } catch {
    return [];
  }
}

/** The `cache=` setting in an npmrc, or null when the file is absent or does
 *  not set one. npmrc is `key=value` per line with `;`/`#` comments. */
function npmrcCache(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*cache\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !/^\s*[;#]/.test(line)) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

// Memoized PER fromUrl: the answer cannot change within a process, and this
// sits behind the connect path. Keyed rather than a single slot because the
// result genuinely depends on the argument -- a single slot would make the
// first caller's fromUrl decide the answer for every later one, which is a
// parameter that silently stops mattering.
const npmCacheDirCache = new Map<string, string | null>();

/**
 * npm's cache directory -- the parent of `_npx`, where `npx -y <pkg>` puts the
 * package it fetched.
 *
 * Resolved WITHOUT shelling out to `npm config get cache`: that is ~half a
 * second of process spawn on a path that runs while an MCP client waits for
 * its tools. Instead this walks npm's own precedence order over the npmrc
 * files, which are plain text and cheap to read.
 *
 * The builtin npmrc is the one that matters in practice and the easy one to
 * forget: version managers (scoop, nvm, volta, asdf) relocate the cache there,
 * NOT in the user's `~/.npmrc`, so a resolver that checks only the user file
 * and the platform default misses the cache entirely on a managed install. It
 * lives beside npm itself in the global `node_modules`, which is exactly what
 * ownNodeModules() already computes -- `process.execPath` is no good for this,
 * because a shimmed install (scoop's `current` junction) points somewhere the
 * global tree is not.
 *
 * Returns null when nothing resolves, which just means "no npx cache to
 * search" -- callers fall back to node/npx as always.
 */
export function npmCacheDir(fromUrl: string = import.meta.url): string | null {
  const cached = npmCacheDirCache.get(fromUrl);
  if (cached !== undefined) return cached;
  const resolved = resolveNpmCacheDir(fromUrl);
  npmCacheDirCache.set(fromUrl, resolved);
  return resolved;
}

/** Reset the memoized npm cache dirs (test hook). */
export function resetNpmCacheDir(): void {
  npmCacheDirCache.clear();
}

function resolveNpmCacheDir(fromUrl: string): string | null {
  // npm's precedence, highest first.
  const fromEnv = process.env.npm_config_cache;
  if (fromEnv) return fromEnv;

  const candidates = [join(homedir(), ".npmrc")];
  for (const nodeModules of ownNodeModules(fromUrl)) {
    // <prefix>/etc/npmrc (global) then <globalroot>/npm/npmrc (builtin).
    candidates.push(join(dirname(nodeModules), "etc", "npmrc"), join(nodeModules, "npm", "npmrc"));
  }
  // npm as it sits beside the running node itself. This is what covers a
  // broker that is NOT globally installed -- a repo checkout or a project
  // `node_modules` has no npm inside it, so the loop above finds nothing.
  const nodeDir = dirname(process.execPath);
  candidates.push(
    join(nodeDir, "node_modules", "npm", "npmrc"), // Windows layout
    join(nodeDir, "..", "lib", "node_modules", "npm", "npmrc"), // POSIX layout
  );
  for (const file of candidates) {
    const cache = npmrcCache(file);
    if (cache) return cache;
  }

  // npm's compiled-in default, used when no npmrc overrides it.
  const fallback =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm-cache")
      : join(homedir(), ".npm");
  return fallback && existsSync(fallback) ? fallback : null;
}

/**
 * Every `_npx/<hash>/node_modules` under npm's cache directory.
 *
 * The sibling npxCacheNodeModules() finds these too, but ONLY when the broker
 * itself was launched through npx, because it derives the cache root from the
 * broker's own module path. A globally installed broker has no `_npx` segment
 * in its path, so it saw nothing -- and `npm i -g @yawlabs/mcp` is precisely
 * what `install` recommends in order to host on oam. The result was that the
 * oam runtime silently did nothing for every `npx -y <pkg>` sidecar on the
 * most common install shape, while doctor still reported them as "oam".
 *
 * Locating the cache independently of the broker's own path is what closes
 * that gap.
 */
export function npmCacheNpxNodeModules(cacheDir: string | null): string[] {
  if (!cacheDir) return [];
  const npxRoot = join(cacheDir, "_npx");
  try {
    return readdirSync(npxRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(npxRoot, e.name, "node_modules"));
  } catch {
    return [];
  }
}

/**
 * The `node_modules` that contains the broker itself, derived from the LAST
 * `node_modules` segment of a module path. Lets the broker's own dependencies
 * be searched even when it is launched as a global / `node <abs>` install (not
 * via npx). Returns `[]` when the path has no `node_modules` segment.
 *
 * `fromUrl` is injectable for testing; it defaults to this module's own URL.
 */
export function ownNodeModules(fromUrl: string = import.meta.url): string[] {
  let here: string;
  try {
    here = fileURLToPath(fromUrl);
  } catch {
    return [];
  }
  const seg = `${sep}node_modules${sep}`;
  const idx = here.lastIndexOf(seg);
  if (idx === -1) return [];
  return [here.slice(0, idx + seg.length - sep.length)];
}

/**
 * Read a package's RUNNABLE entry from its package.json: the `bin` (the CLI
 * `npx` would execute), falling back to `main`. Deliberately NOT
 * `require.resolve`, which returns the `exports["."]` LIBRARY entry -- often a
 * different file than the bin (e.g. fetch-mcp: bin=dist/index.js vs
 * exports.=dist/server.js) AND throws ERR_PACKAGE_PATH_NOT_EXPORTED on an
 * ESM-only `exports` with no `require`/`default` condition. Reading
 * package.json directly sidesteps the package's own `exports` gating entirely.
 *
 * Returns the declared `version` alongside the entry. Choosing between cached
 * copies needs it, and this function has already parsed the file the version
 * lives in -- reading it a second time would mean two reads and two JSON
 * parses per candidate, across every npx cache directory (well over a hundred
 * on a machine that has used npx for a while) on the connect path.
 */
interface PackageHit {
  entry: string;
  /** null when the package declares no usable `version` string. */
  version: string | null;
}

function packageEntry(pkgDir: string, pkg: string): PackageHit | null {
  const pjPath = join(pkgDir, "package.json");
  if (!existsSync(pjPath)) return null;
  let j: { bin?: string | Record<string, string>; main?: string; name?: string; version?: unknown };
  try {
    j = JSON.parse(readFileSync(pjPath, "utf8"));
  } catch {
    return null;
  }
  let rel: string | undefined;
  if (typeof j.bin === "string") {
    rel = j.bin;
  } else if (j.bin && typeof j.bin === "object") {
    // Prefer the bin keyed by the unscoped name, then the full name, then the
    // first declared bin (servers often name the bin differently from the pkg).
    const unscoped = pkg.slice(pkg.lastIndexOf("/") + 1);
    rel = j.bin[unscoped] ?? (j.name ? j.bin[j.name] : undefined) ?? Object.values(j.bin)[0];
  }
  if (!rel && typeof j.main === "string") rel = j.main;
  if (!rel) return null;
  return {
    entry: isAbsolute(rel) ? rel : join(pkgDir, rel),
    version: typeof j.version === "string" ? j.version : null,
  };
}

/**
 * Resolve a package name to an on-disk RUNNABLE entry, or `null`. Searches the
 * broker's own node_modules first, then every npx cache -- an `npx -y <pkg>`
 * server lives in a `_npx/<hash>/node_modules` the broker's own resolver can't
 * see, so without this an opted-in npx server silently falls back to Node.
 * Among cached copies the HIGHEST version wins. Resolves the package's BIN
 * (read straight from package.json) rather than require.resolve's library "."
 * export. `null` keeps the npx/node command.
 *
 * `fromUrl`, `npmCache`, and `managedRoot` are injectable for testing; they
 * default to this module's own URL, the resolved npm cache, and the managed
 * sidecar tree. Tests should pass `npmCache` and `managedRoot` explicitly (a
 * temp dir, or null) so they never read the host's real cache or home dir.
 */
export function resolveNpmEntry(
  pkg: string,
  fromUrl: string = import.meta.url,
  npmCache: string | null = npmCacheDir(fromUrl),
  managedRoot: string | null = sidecarsNodeModules(),
): string | null {
  const parts = pkg.split("/"); // "@scope/name" -> ["@scope", "name"]

  // A durable install is authoritative: it is a deliberate `npm i`, it is the
  // single copy, and it is what npx itself would prefer. Take it outright.
  //
  // The managed tree (`yaw-mcp sidecars install`) comes first among these: it
  // is the only one the user asked yaw-mcp to maintain, so when it and some
  // ambient node_modules both have the package, the managed answer is the one
  // they can actually move forward by re-running the command.
  const durable: Array<{ nodeModules: string; source: PinSource }> = [
    ...(managedRoot ? [{ nodeModules: managedRoot, source: "managed" as const }] : []),
    ...ownNodeModules(fromUrl).map((nodeModules) => ({ nodeModules, source: "durable" as const })),
  ];
  for (const { nodeModules, source } of durable) {
    const hit = packageEntry(join(nodeModules, ...parts), pkg);
    if (hit) {
      // Reported here too, not just for cache hits: a durable copy pins just
      // as hard as a cached one -- `oam run <entry>` cannot re-resolve
      // "@latest" wherever the entry came from. Leaving these silent meant
      // the notice never fired for the managed tree, i.e. for the exact
      // install path `sidecars install` exists to promote.
      notePinnedSidecar(pkg, hit.version, source);
      return hit.entry;
    }
  }

  // The npx cache is keyed by content hash, not by package, so a machine that
  // has run a server for months holds every version it ever fetched -- 15
  // copies of one sidecar is real, observed. Iteration order is the hash
  // order, i.e. arbitrary, so taking the first hit silently pinned whatever
  // the directory listing happened to surface: a config that says `@latest`
  // ran a months-old build with no warning anywhere. Pick the highest version
  // instead, which is the closest on-disk answer to what `@latest` asked for.
  const roots = new Set([...npxCacheNodeModules(fromUrl), ...npmCacheNpxNodeModules(npmCache)]);
  let best: PackageHit | null = null;
  for (const nodeModules of roots) {
    const hit = packageEntry(join(nodeModules, ...parts), pkg);
    if (!hit) continue;
    // An unversioned candidate only wins when nothing else has been found:
    // compareVersions returns 0 for unparseable input, so it can never
    // displace a real version.
    if (
      best === null ||
      (hit.version !== null && (best.version === null || compareVersions(hit.version, best.version) > 0))
    ) {
      best = hit;
    }
  }
  if (best !== null) notePinnedSidecar(pkg, best.version, "npx-cache");
  return best?.entry ?? null;
}

/** Where a resolved entry came from. Governs the command that actually moves
 *  that copy forward -- the three are genuinely different, and naming the
 *  wrong one is worse than naming none. */
type PinSource = "managed" | "durable" | "npx-cache";

/** How to refresh a pinned copy, per source. `npm install <pkg>@latest` is
 *  scoped to whichever tree the entry was found in, which is what a durable
 *  install (global or project) responds to. */
const REFRESH_COMMAND: Record<PinSource, (pkg: string) => string> = {
  managed: () => "yaw-mcp sidecars install",
  durable: (pkg) => `npm install ${pkg}@latest`,
  "npx-cache": (pkg) => `npx -y ${pkg}@latest --help`,
};

/** Packages already reported as pinned -- one line each, not one per connect. */
const pinnedReported = new Set<string>();

/** Reset the pinned-sidecar log dedupe (test hook). */
export function resetPinnedSidecarLog(): void {
  pinnedReported.clear();
}

/**
 * Say, once per package, that a sidecar is running from an on-disk copy rather
 * than through npx.
 *
 * This is the one user-visible consequence of hosting on oam that is otherwise
 * invisible. `npx -y <pkg>@latest` re-resolves the tag on every spawn, so those
 * servers used to update themselves; `oam run <entry>` cannot, because oam has
 * no fetch-on-demand. Worse, once oam is the default, npx stops running for
 * these servers at all, so the cache that supplied the entry also stops being
 * refreshed -- the version pins itself indefinitely.
 *
 * Logged at info, not debug: a debug-level line is exactly how the resolver's
 * failure to find these packages at all went unnoticed.
 */
function notePinnedSidecar(pkg: string, version: string | null, source: PinSource): void {
  if (pinnedReported.has(pkg)) return;
  pinnedReported.add(pkg);
  log("info", "hosting sidecar on oam from an on-disk copy; it will not self-update the way npx does", {
    package: pkg,
    version: version ?? "unknown",
    source,
    refreshWith: REFRESH_COMMAND[source](pkg),
  });
}

/**
 * Resolve a package entry ONLY from a durable install -- a real global or
 * project `node_modules`, never the npx cache.
 *
 * Writing a launch entry into a client's config is a different problem from
 * spawning a sidecar right now, so it needs a different resolver:
 *
 *   * An npx-cache path is fine to spawn (it exists this instant) but wrong to
 *     PERSIST. `~/.npm/_npx/<hash>` is a cache; `npm cache clean` or an
 *     eviction turns the client's MCP entry into a path that isn't there, and
 *     a broker that fails to launch at all is strictly worse than one running
 *     on node.
 *   * A durable path also keeps updates working. `npm update -g` rewrites the
 *     global install IN PLACE, so a pinned path still picks up new versions.
 *     That matters because the npx entry it replaces carries `@latest`, which
 *     re-resolves on every spawn -- pointing at a cache path keyed by content
 *     hash would silently freeze the broker at one version forever.
 *
 * Returning null means "stay on npx", and it is the common answer: when
 * yaw-mcp is itself launched via `npx -y`, its own module lives in the cache,
 * so there is nothing durable to point at.
 */
export function resolveStableNpmEntry(pkg: string, fromUrl: string = import.meta.url): string | null {
  const npxMarker = `${sep}_npx${sep}`;
  for (const nodeModules of ownNodeModules(fromUrl)) {
    if (nodeModules.includes(npxMarker)) continue;
    const hit = packageEntry(join(nodeModules, ...pkg.split("/")), pkg);
    if (hit) return hit.entry;
  }
  return null;
}

/**
 * Resolve a server's launch to run on oam unless it has opted OUT -- oam is
 * the default whenever it is installed and meets MIN_OAM_VERSION. A no-op for
 * non-Node commands and a safe Node fallback when oam isn't installed or the
 * package can't be resolved on disk.
 *
 * `optedIn` says whether oam was actually ASKED for (per-server `runtime` or a
 * config default) as opposed to merely being the default; it only governs
 * whether an absent oam is worth a warning.
 */
export async function resolveOamSpawn(
  command: string,
  args: string[],
  optedIn = true,
): Promise<{ command: string; args: string[] }> {
  const probe = await probeOam();
  // Absence is silent inside the probe on purpose -- warning there would fire
  // on every node-only install, which is noise -- but when the user EXPLICITLY
  // opted in and is getting node anyway, that is indistinguishable from oam
  // working, so say it once. `optedIn` is false when oam is merely the default
  // (nothing configured); an absent oam is then the expected state, not a
  // misconfiguration, and must stay quiet. belowMin already warns in the probe
  // with its own actionable numbers, so this covers only genuine absence.
  if (optedIn && probe.bin === null && !probe.belowMin && !warnedOamMissing) {
    warnedOamMissing = true;
    log("warn", "a server opted in to oam but oam is not installed; running it on node instead", {
      install: "curl -fsSL https://oamjs.org/install.sh | sh",
      installWindows: "irm https://oamjs.org/install.ps1 | iex",
      overrideWith: "OAM_BIN",
    });
  }
  return rewriteForOam(command, args, {
    oamBin: probe.bin,
    resolveEntry: (pkg) => resolveNpmEntry(pkg),
  });
}

/** True when a launch command names an oam binary -- bare "oam"/"oam.exe" or
 *  any path ending in one. Splits on BOTH separators: Windows is the platform
 *  that writes a backslash path here (`C:\...\oam.exe`), so a "/"-only split
 *  would fail to recognise oam on the very platform the entry came from.
 *  Not a PATH lookup -- this classifies what the config ASKS for, and a bare
 *  name resolves at spawn time. */
export function isOamCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? command;
  return /^oam(\.exe)?$/i.test(base);
}

/**
 * Whether a launch entry runs the broker on oam, including through a shell
 * wrapper.
 *
 * `install` never writes the wrapped shape -- the `cmd /c` wrap exists for
 * npx's `.cmd` shim and oam is a real executable -- but a hand-edited config
 * reasonably might, and reporting "node" for an entry that plainly launches
 * oam is worse than not reporting at all.
 */
export function isOamLaunch(command: string, args: readonly string[] = []): boolean {
  if (isOamCommand(command)) return true;
  const base = command.split(/[\\/]/).pop() ?? command;

  // cmd and POSIX shells package their payload DIFFERENTLY, and treating them
  // alike is why the first version of this recognised neither real shape.
  if (/^cmd(\.exe)?$/i.test(base)) {
    // cmd takes the command as separate argv entries. Skip its own switches:
    // `/d /s /c` is the everyday shape (npm emits it), not just `/c`. The
    // pattern is deliberately "slash + ONE letter" so a POSIX path argument
    // like /usr/local/bin/oam is never mistaken for a switch.
    const first = args.find((a) => !/^\/[a-z]$/i.test(a));
    return first !== undefined && isOamCommand(first);
  }

  if (/^(sh|bash|zsh|dash)$/i.test(base)) {
    // A POSIX shell takes the WHOLE command as one string after -c
    // ("oam run /path/index.js"), so the payload has to be tokenised. Reading
    // it as a bare command name is what made this return false for every
    // realistic `sh -c` entry.
    const dashC = args.indexOf("-c");
    const payload = dashC >= 0 ? args[dashC + 1] : args[0];
    if (payload === undefined) return false;
    // Strip quotes that do not hide a space. Tokenising on whitespace cannot
    // recover a quoted path that CONTAINS one, and a display marker does not
    // justify a shell parser -- such an entry reports "node". Under-reporting
    // is the safe direction: it never claims oam for something that is not.
    const firstToken = payload
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^["']|["']$/g, "");
    return firstToken !== undefined && firstToken.length > 0 && isOamCommand(firstToken);
  }

  return false;
}
