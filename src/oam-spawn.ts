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
// hostable yet. There is no auto-fallback once oam has launched the child, so
// only opt in servers verified to run on oam.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const requireFrom = createRequire(import.meta.url);

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

let oamBinCache: string | null | undefined;

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
 * The oam binary to spawn, or `null` if oam isn't available. Probed once with
 * `oam --version` and cached. OAM_BIN overrides the binary path; it's
 * normalized to a cmd-safe path so a forward-slash OAM_BIN still spawns.
 */
export function oamBin(): string | null {
  if (oamBinCache !== undefined) return oamBinCache;
  const bin = winNormalize(process.env.OAM_BIN || (process.platform === "win32" ? "oam.exe" : "oam"));
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    oamBinCache = bin;
  } catch {
    oamBinCache = null;
  }
  return oamBinCache;
}

/** Reset the cached oam-binary probe (test hook). */
export function resetOamBinCache(): void {
  oamBinCache = undefined;
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
    const positional = args.filter((a) => a !== "-y" && a !== "--yes");
    const [spec, ...rest] = positional;
    if (!spec) return { command, args };
    const entry = deps.resolveEntry(packageName(spec));
    if (!entry) return { command, args }; // not installed locally -> keep npx
    return toOam(entry, rest);
  }

  return { command, args };
}

/**
 * Resolve a server's launch to run on oam when it has opted in
 * (`config.runtime === "oam"`). A no-op for non-Node commands and a safe Node
 * fallback when oam isn't installed or the package can't be resolved on disk.
 */
export function resolveOamSpawn(command: string, args: string[]): { command: string; args: string[] } {
  return rewriteForOam(command, args, {
    oamBin: oamBin(),
    resolveEntry: (pkg) => {
      try {
        return requireFrom.resolve(pkg);
      } catch {
        return null;
      }
    },
  });
}
