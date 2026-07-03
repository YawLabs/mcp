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
//     4. unset -> node/npx (today's behavior)
//
// Applied in connectToUpstream (upstream.ts), NOT at config-load time, so it
// covers account mode too: backend server defs never carry `runtime`, and the
// default is a machine-level fact (is oam installed HERE?), not an account
// fact. The bundles.json read is cached after the first call -- the connect
// path must not re-read the file per spawn.

import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { MIN_OAM_VERSION, type OamProbe } from "./oam-spawn.js";
import type { UpstreamServerConfig } from "./types.js";

export type RuntimeChoice = "oam" | "node";

// undefined = bundles.json not probed yet; null = probed, nothing configured.
let bundlesDefaultCache: RuntimeChoice | null | undefined;
let warnedInvalidEnv = false;

/** Reset the cached bundles.json default (test hook). */
export function resetDefaultRuntimeCache(): void {
  bundlesDefaultCache = undefined;
  warnedInvalidEnv = false;
}

/** Where a resolved default came from -- surfaced by doctor. */
export interface DefaultRuntimeInfo {
  runtime: RuntimeChoice | null;
  source: "env" | "bundles" | null;
  /** Absolute path of the bundles.json that set the default (source
   *  "bundles" only). Doctor prints it because the connect path resolves
   *  project-local bundles from the BROKER's cwd (wherever the MCP client
   *  spawned yaw-mcp) while doctor/servers resolve from the shell's cwd --
   *  naming the file makes a divergence between the two visible. */
  path: string | null;
}

/**
 * Resolve the config-level default runtime WITHOUT caching, reporting where
 * it came from. Used by doctor/servers (interactive, wants fresh state and
 * provenance). The env var wins over bundles.json; an invalid env value is
 * ignored with a warn (once per process, shared with defaultRuntime below).
 */
export async function describeDefaultRuntime(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string } = {},
): Promise<DefaultRuntimeInfo> {
  const env = opts.env ?? process.env;
  const raw = env.YAW_MCP_DEFAULT_RUNTIME;
  if (raw === "oam" || raw === "node") return { runtime: raw, source: "env", path: null };
  if (raw !== undefined && raw !== "" && !warnedInvalidEnv) {
    warnedInvalidEnv = true;
    log("warn", 'Ignoring invalid YAW_MCP_DEFAULT_RUNTIME (expected "oam" or "node")', { value: raw });
  }
  const bundles = await loadLocalBundles({ cwd: opts.cwd, home: opts.home }).catch(() => ({
    defaultRuntime: undefined,
    defaultRuntimePath: undefined,
  }));
  return bundles.defaultRuntime !== undefined
    ? { runtime: bundles.defaultRuntime, source: "bundles", path: bundles.defaultRuntimePath ?? null }
    : { runtime: null, source: null, path: null };
}

/**
 * The config-level default runtime, or null when nothing is configured
 * (today's behavior: node/npx untouched). Env is checked on every call
 * (cheap, and lets a respawned broker pick up a change); the bundles.json
 * top-level `defaultRuntime` is read once and cached -- this sits on the
 * upstream connect path.
 */
export async function defaultRuntime(): Promise<RuntimeChoice | null> {
  const raw = process.env.YAW_MCP_DEFAULT_RUNTIME;
  if (raw === "oam" || raw === "node") return raw;
  if (raw !== undefined && raw !== "" && !warnedInvalidEnv) {
    warnedInvalidEnv = true;
    log("warn", 'Ignoring invalid YAW_MCP_DEFAULT_RUNTIME (expected "oam" or "node")', { value: raw });
  }
  if (bundlesDefaultCache === undefined) {
    const bundles = await loadLocalBundles({ cwd: process.cwd() }).catch(() => ({ defaultRuntime: undefined }));
    bundlesDefaultCache = bundles.defaultRuntime ?? null;
  }
  return bundlesDefaultCache;
}

/** Machine-readable "why" for a per-server runtime verdict. The last three
 *  are the silent-fallback cases doctor/servers exist to make visible. */
export type ServerRuntimeCode =
  | "remote"
  | "per-server-node"
  | "default-node"
  | "per-server-oam"
  | "default-oam"
  | "not-node-command"
  | "oam-not-installed"
  | "oam-below-min";

/** Per-server effective-runtime verdict for doctor/servers. */
export interface ServerRuntimeInfo {
  /** What the server would actually get: "oam", "node", or null for remote
   *  servers (no local spawn to host). */
  runtime: RuntimeChoice | null;
  code: ServerRuntimeCode;
  /** Human-readable "why" -- also emitted in --json output. */
  reason: string;
}

/**
 * Pure verdict of which runtime a server would ACTUALLY get and why, mirroring
 * the gates connectToUpstream + resolveOamSpawn apply at spawn time:
 * per-server runtime > config default; then the oam binary must exist, be
 * >= MIN_OAM_VERSION, and the command must be node/npx-shaped. Deliberately
 * does NOT probe package resolution on disk (resolveNpmEntry) -- that depends
 * on the npx caches at spawn time and would make doctor output flap.
 */
export function describeServerRuntime(
  server: Pick<UpstreamServerConfig, "type" | "command" | "runtime">,
  configDefault: RuntimeChoice | null,
  probe: OamProbe,
): ServerRuntimeInfo {
  if (server.type !== "local") {
    return { runtime: null, code: "remote", reason: "remote server (no local spawn)" };
  }
  if (server.runtime === "node") {
    return { runtime: "node", code: "per-server-node", reason: 'per-server runtime:"node"' };
  }
  const wantsOam = server.runtime === "oam" || (server.runtime === undefined && configDefault === "oam");
  if (!wantsOam) {
    return { runtime: "node", code: "default-node", reason: "default (no oam opt-in)" };
  }
  const via = server.runtime === "oam" ? 'per-server runtime:"oam"' : 'default runtime "oam"';
  if (server.command !== "node" && server.command !== "npx") {
    return { runtime: "node", code: "not-node-command", reason: `${via}, but command is not node/npx` };
  }
  if (probe.belowMin) {
    return {
      runtime: "node",
      code: "oam-below-min",
      reason: `${via}, but oam ${probe.version} is below min ${MIN_OAM_VERSION}`,
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
