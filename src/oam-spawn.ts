// Host an opted-in MCP sidecar on the oam runtime (https://oam.sh) instead of
// node/npx. This is the spawn-rewrite half of "run Yaw's MCP sidecars on oam":
// connectToUpstream() applies it after resolveUvSpawn (upstream.ts) for servers
// whose config sets `runtime: "oam"`.
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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

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
 * Minimum oam version yaw-mcp will host sidecars on. Older builds predate the
 * extra-fd stdio + npx-bin-resolution fixes MCP sidecars rely on; hosting on
 * them produces hangs that LOOK like server bugs. Below-min is treated the
 * same as oam-absent: the spawn falls back to node/npx (one warn log).
 */
export const MIN_OAM_VERSION = "0.6.0";

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
export function probeOam(
  run: (bin: string) => string = (bin) =>
    execFileSync(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }),
): OamProbe {
  if (oamProbeCache !== undefined) return oamProbeCache;
  const bin = winNormalize(process.env.OAM_BIN || (process.platform === "win32" ? "oam.exe" : "oam"));
  try {
    const version = parseOamVersion(run(bin));
    if (version !== null && compareVersions(version, MIN_OAM_VERSION) < 0) {
      log("warn", "oam is installed but below the minimum supported version; falling back to node", {
        oamVersion: version,
        minVersion: MIN_OAM_VERSION,
      });
      oamProbeCache = { bin: null, version, belowMin: true };
    } else {
      oamProbeCache = { bin, version, belowMin: false };
    }
  } catch {
    oamProbeCache = { bin: null, version: null, belowMin: false };
  }
  return oamProbeCache;
}

/**
 * The oam binary to spawn, or `null` if oam isn't available (not installed,
 * or installed below MIN_OAM_VERSION -- see probeOam).
 */
export function oamBin(): string | null {
  return probeOam().bin;
}

/** Reset the cached oam-binary probe (test hook). */
export function resetOamBinCache(): void {
  oamProbeCache = undefined;
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
    return toOam(entry, rest);
  }

  if (command === "npx") {
    // Only -y/--yes are recognized, so any OTHER npx flag (--package, -p,
    // --node-options, ...) lands in `spec` and would be treated as the
    // package name. Staying on npx is the safe answer -- reimplementing
    // npx's arg parser here is not worth it -- but say WHY at debug level:
    // from the outside, an opted-in server quietly running on node is
    // indistinguishable from oam being absent.
    const positional = args.filter((a) => a !== "-y" && a !== "--yes");
    const [spec, ...rest] = positional;
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
    return toOam(entry, rest);
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
 */
function packageEntry(pkgDir: string, pkg: string): string | null {
  const pjPath = join(pkgDir, "package.json");
  if (!existsSync(pjPath)) return null;
  let j: { bin?: string | Record<string, string>; main?: string; name?: string };
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
  return isAbsolute(rel) ? rel : join(pkgDir, rel);
}

/**
 * Resolve a package name to an on-disk RUNNABLE entry, or `null`. Searches the
 * broker's own node_modules then every npx cache: an `npx -y <pkg>` server
 * lives in a sibling `_npx/<hash>/node_modules` that the broker's own resolver
 * can't see, so without this an opted-in npx server silently falls back to
 * Node. Resolves the package's BIN (read straight from package.json) rather
 * than require.resolve's library "." export. `null` keeps the npx/node command.
 *
 * `fromUrl` is injectable for testing; it defaults to this module's own URL.
 */
export function resolveNpmEntry(pkg: string, fromUrl: string = import.meta.url): string | null {
  const parts = pkg.split("/"); // "@scope/name" -> ["@scope", "name"]
  for (const nodeModules of [...ownNodeModules(fromUrl), ...npxCacheNodeModules(fromUrl)]) {
    const entry = packageEntry(join(nodeModules, ...parts), pkg);
    if (entry) return entry;
  }
  return null;
}

/**
 * Resolve a server's launch to run on oam when it has opted in
 * (`config.runtime === "oam"`). A no-op for non-Node commands and a safe Node
 * fallback when oam isn't installed or the package can't be resolved on disk.
 */
export function resolveOamSpawn(command: string, args: string[]): { command: string; args: string[] } {
  return rewriteForOam(command, args, {
    oamBin: oamBin(),
    resolveEntry: (pkg) => resolveNpmEntry(pkg),
  });
}
