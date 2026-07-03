// Local server-definitions file -- the source of truth for which MCP
// servers yaw-mcp loads when running in "no account" Free mode.
//
// File path: ~/.yaw-mcp/bundles.json (user-global) or
//            <project>/.yaw-mcp/bundles.json (project-local override).
//
// Project-local FULLY overrides user-global -- no merge. That keeps the
// mental model simple: if you've committed a .yaw-mcp/bundles.json with
// your repo, the team gets exactly that set, no surprises from a
// teammate's user-global file leaking in.
//
// When yaw-mcp starts WITH a token, the server DEFINITIONS in this file
// are ignored -- the cloud account is the source of truth, and the
// `servers` array sits unused on disk. When yaw-mcp starts WITHOUT a
// token, bundles.json IS the source. If neither file exists, yaw-mcp
// starts with an empty server list and surfaces the "no servers
// configured" hint pointing at `yaw-mcp add <slug>` (NOT `install`,
// which connects a CLIENT to yaw-mcp).
//
// Exception: the top-level `defaultRuntime` knob ("oam" | "node") is a
// MACHINE-level preference, not a server definition, so it applies in
// BOTH modes -- backend server defs don't carry `runtime`, and the
// account dashboard has no per-machine concept of "oam is installed
// here". See default-runtime.ts for the resolution order
// (YAW_MCP_DEFAULT_RUNTIME env > this file's defaultRuntime > unset).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME, findProjectConfigDir, userConfigDir } from "./paths.js";
import type { ConnectConfig, UpstreamServerConfig } from "./types.js";

/** Canonical filename for the local bundles file. */
export const BUNDLES_FILENAME = "bundles.json";

/** Schema version emitted by current yaw-mcp. Older files load fine
 *  (back-compat is permissive); newer files trigger a warning. */
export const CURRENT_BUNDLES_SCHEMA_VERSION = 1;

/** The on-disk shape. Mirrors ConnectConfig but with `version` instead
 *  of `configVersion` (the latter is a server-generated ETag we derive
 *  here from a content hash). */
export interface LocalBundlesFile {
  version?: number;
  servers: Array<Partial<UpstreamServerConfig>>;
  /** Config-level default runtime for servers that don't set a per-server
   *  `runtime`. Per-server `"node"` stays an escape hatch under a default of
   *  `"oam"`. Applied in connectToUpstream (via default-runtime.ts) so it
   *  covers backend-sourced defs in account mode too. */
  defaultRuntime?: "oam" | "node";
}

/** Build the absolute path to bundles.json inside a given config dir. */
export function localBundlesPath(configDir: string): string {
  return join(configDir, BUNDLES_FILENAME);
}

/** Canonical regex for valid MCP server namespaces. Exported so all
 *  consumers (config.ts, local-bundles.ts, tests) share the same
 *  definition instead of maintaining independent copies. */
export const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,29}$/;

/** Coerce a raw entry from bundles.json into a strict UpstreamServerConfig.
 *  Returns null when required fields are missing or malformed so the loader
 *  can skip the entry with a warning instead of crashing the whole load. */
function validateEntry(entry: unknown, warnings: string[]): UpstreamServerConfig | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warnings.push("bundles.json: skipping non-object server entry");
    return null;
  }
  const e = entry as Record<string, unknown>;

  const namespace = typeof e.namespace === "string" ? e.namespace : "";
  if (!namespace || !NAMESPACE_RE.test(namespace)) {
    warnings.push(`bundles.json: skipping server with invalid namespace ${JSON.stringify(namespace)}`);
    return null;
  }
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : namespace;
  // Default type to "local" -- bundles.json is the local-mode file by
  // definition. Existing dashboard configs use "local" for stdio/spawned
  // servers and "remote" for HTTP/SSE; users can override via the field.
  const type: "local" | "remote" = e.type === "remote" ? "remote" : "local";
  const transport =
    e.transport === "streamable-http" || e.transport === "sse" || e.transport === "stdio"
      ? (e.transport as "stdio" | "streamable-http" | "sse")
      : undefined;

  // Stdio servers need command; remote servers need url. Don't enforce
  // here -- the upstream connector will surface a clear error if the
  // entry can't be spawned/dialed. The validator's job is shape, not
  // semantics.
  const command = typeof e.command === "string" ? e.command : undefined;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : undefined;
  const env =
    e.env && typeof e.env === "object" && !Array.isArray(e.env)
      ? (Object.fromEntries(
          Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : undefined;
  const url = typeof e.url === "string" ? e.url : undefined;
  const description = typeof e.description === "string" ? e.description : undefined;
  // Per-server runtime override. "oam" hosts the server on the oam runtime
  // (connectToUpstream's resolveOamSpawn rewrites node/npx -> `oam run`);
  // "node" or absent = node, the default. Without propagating this here, a
  // bundles.json `"runtime": "oam"` is silently dropped and never reaches the
  // resolver.
  const runtime = e.runtime === "oam" || e.runtime === "node" ? e.runtime : undefined;

  // Default isActive=true in local mode -- if the user wrote a server
  // into bundles.json they presumably want it loadable. Toggle off with
  // explicit `"isActive": false`.
  const isActive = e.isActive !== false;

  // Synthesize an id from the namespace when absent. The id is mainly
  // for dashboard parity; local mode doesn't strictly need it but the
  // downstream code paths use it as a stable handle.
  const id = typeof e.id === "string" && e.id.length > 0 ? e.id : `local-${namespace}`;

  return {
    id,
    name,
    namespace,
    type,
    transport,
    command,
    args,
    env,
    url,
    isActive,
    description,
    runtime,
  };
}

/** Tri-state read result so the caller can distinguish "file doesn't
 *  exist" (fall through to next location) from "file exists but is
 *  malformed" (commit to this location, don't silently substitute
 *  someone else's config). */
interface ReadResult {
  exists: boolean;
  file: LocalBundlesFile | null;
}

/** Read a bundles.json from `path`. Returns:
 *   - { exists: false, file: null } when the file doesn't exist
 *   - { exists: true,  file: <parsed> } when valid
 *   - { exists: true,  file: null } when present-but-malformed (warnings
 *     populated). Caller must NOT fall through in this case -- see
 *     loadLocalBundles. */
async function readBundlesAt(path: string, warnings: string[]): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return { exists: false, file: null };
    }
    // Any other error (EPERM, EACCES, ...) means the file likely exists but
    // we can't read it.  Return exists:true so the caller stays committed to
    // this path instead of silently falling through to the user-global file.
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: could not read file (${msg}) -- skipping`);
    log("warn", "Could not read bundles.json", { path, error: msg, code });
    return { exists: true, file: null };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) -- file ignored`);
    log("warn", "bundles.json is not valid JSON; ignoring", { path, error: msg });
    return { exists: true, file: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object -- file ignored`);
    return { exists: true, file: null };
  }
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : undefined;
  if (version !== undefined && version > CURRENT_BUNDLES_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this yaw-mcp (${CURRENT_BUNDLES_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcp@latest\`. Loading best-effort.`,
    );
  }
  const rawServers = obj.servers;
  if (!Array.isArray(rawServers)) {
    warnings.push(`${path}: 'servers' must be an array -- file ignored`);
    return { exists: true, file: null };
  }
  // Top-level default runtime. Only "oam"/"node" are meaningful; anything
  // else is dropped with a warning (matching the per-server `runtime`
  // validation in validateEntry, which drops silently -- top-level gets a
  // warning because a typo here changes EVERY server's runtime).
  let defaultRuntime: "oam" | "node" | undefined;
  if (obj.defaultRuntime === "oam" || obj.defaultRuntime === "node") {
    defaultRuntime = obj.defaultRuntime;
  } else if (obj.defaultRuntime !== undefined) {
    warnings.push(
      `${path}: ignoring invalid 'defaultRuntime' ${JSON.stringify(obj.defaultRuntime)} (expected "oam" or "node")`,
    );
  }
  return {
    exists: true,
    file: { version, servers: rawServers as Array<Partial<UpstreamServerConfig>>, defaultRuntime },
  };
}

/** Deterministic content-derived configVersion. We use this in lieu of
 *  the backend's ETag so downstream "did the config change since last
 *  poll" checks work the same way in local mode (always equal, since
 *  the file is read once at startup). */
function hashContent(servers: UpstreamServerConfig[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(servers));
  return `local-${h.digest("hex").slice(0, 16)}`;
}

export interface LoadLocalBundlesResult {
  config: ConnectConfig | null;
  path: string | null;
  warnings: string[];
  /** Top-level `defaultRuntime`. A project file that SETS it wins; a project
   *  file that doesn't falls back to the user-global file's value -- the
   *  knob is a MACHINE-level preference, so a committed team bundles.json
   *  (which will never carry a machine fact) must not silently turn it off.
   *  This is the one deliberate departure from the winner-takes-all
   *  server-list precedence. Undefined when nothing sets it. */
  defaultRuntime?: "oam" | "node";
  /** Absolute path of the bundles.json the defaultRuntime came from (may be
   *  the user-global file even when servers came from a project file -- see
   *  above). Undefined when defaultRuntime is undefined. */
  defaultRuntimePath?: string;
}

/** Load bundles.json from the canonical locations. Project-local
 *  (`<project>/.yaw-mcp/bundles.json`) wins over user-global
 *  (`~/.yaw-mcp/bundles.json`) -- no merge (defaultRuntime excepted; see
 *  LoadLocalBundlesResult). Returns null config when neither file exists,
 *  so the caller can render the empty-state hint. */
export async function loadLocalBundles(opts: { cwd?: string; home?: string } = {}): Promise<LoadLocalBundlesResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const warnings: string[] = [];

  const projectDir = await findProjectConfigDir(cwd, home).catch(() => null);
  const projectPath = projectDir ? localBundlesPath(projectDir) : null;
  const globalPath = localBundlesPath(join(home, CONFIG_DIRNAME));

  // Project wins entirely when present. If the project file is present
  // but malformed, we commit to that location (config null, warnings
  // surfaced) instead of silently substituting the user-global config
  // -- a committed bundles.json should be authoritative.
  const projectResult = projectPath
    ? await readBundlesAt(projectPath, warnings)
    : ({ exists: false, file: null } as ReadResult);

  let file: LocalBundlesFile | null;
  let sourcePath: string | null;
  if (projectResult.exists) {
    file = projectResult.file;
    sourcePath = projectPath;
  } else {
    const globalResult = await readBundlesAt(globalPath, warnings);
    file = globalResult.file;
    sourcePath = globalResult.exists ? globalPath : null;
  }

  if (!file) {
    return { config: null, path: sourcePath, warnings };
  }

  const servers: UpstreamServerConfig[] = [];
  for (const raw of file.servers) {
    const validated = validateEntry(raw, warnings);
    if (validated) servers.push(validated);
  }

  // defaultRuntime is machine-level: when a VALID project file won but
  // doesn't set it, fall back to the user-global file's value. The scratch
  // warnings array keeps the global file's diagnostics out of the result --
  // its servers are deliberately shadowed, so "file ignored"-class warnings
  // about it would only confuse.
  let defaultRuntime = file.defaultRuntime;
  let defaultRuntimePath = defaultRuntime !== undefined ? (sourcePath ?? undefined) : undefined;
  if (defaultRuntime === undefined && sourcePath === projectPath && projectPath !== null) {
    const scratch: string[] = [];
    const globalResult = await readBundlesAt(globalPath, scratch);
    if (globalResult.file?.defaultRuntime !== undefined) {
      defaultRuntime = globalResult.file.defaultRuntime;
      defaultRuntimePath = globalPath;
    }
  }

  return {
    config: {
      servers,
      configVersion: hashContent(servers),
    },
    path: sourcePath,
    warnings,
    defaultRuntime,
    defaultRuntimePath,
  };
}

// --- Write path (used by `yaw-mcp add` / `remove`) --------------------------
//
// These mutate the USER-GLOBAL ~/.yaw-mcp/bundles.json. They are the only
// writers of local server definitions in the CLI. A project-local
// <cwd>/.yaw-mcp/bundles.json FULLY overrides user-global on load (see
// loadLocalBundles), so the add/remove commands warn separately when a
// project file would shadow the write -- they don't silently target it.
//
// In-process serializer: concurrent upsert/remove calls on the same file
// would race -- both would read the same on-disk snapshot, both would
// produce a different modified copy, and the loser's write would silently
// overwrite the winner's. Gate both functions through a shared promise chain
// (same pattern as saveState in persistence.ts) so they execute one at a
// time within a single process.
let bundleWriteChain: Promise<void> = Promise.resolve();

/**
 * Derive a namespace from a server's DISPLAY NAME. This MUST stay
 * byte-for-byte identical to the Yaw Terminal app's deriveNamespace
 * (yaw-install-handler.ts) -- both write to the same ~/.yaw-mcp/bundles.json,
 * so a divergent algorithm would make the same catalog server land under two
 * different namespaces (CLI-added vs app/badge-added), duplicating tool
 * prefixes and breaking cross-path dedup + the app's "installed" check.
 *
 * Algorithm (identical to the app): lowercase, strip ALL non-alphanumerics,
 * 's'-prefix a leading non-letter (so "1Password" -> "s1password"), cap at 30,
 * fall back to "server" when nothing survives. Always returns a NAMESPACE_RE-
 * valid string (never null), so callers don't need a failure branch.
 */
export function deriveNamespace(name: string): string {
  let ns = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (ns.length === 0) return "server";
  if (!/^[a-z]/.test(ns)) ns = `s${ns}`;
  if (ns.length > 30) ns = ns.slice(0, 30);
  return ns;
}

/**
 * Read the RAW user-global bundles.json (no validate/coerce) so a save
 * round-trips fields validateEntry would otherwise drop. Returns a fresh
 * skeleton when the file is absent; THROWS when present-but-malformed so a
 * write never clobbers a file the user hand-edited into an invalid state.
 */
async function readRawUserBundles(home: string): Promise<LocalBundlesFile> {
  const path = localBundlesPath(userConfigDir(home));
  if (!existsSync(path)) {
    return { version: CURRENT_BUNDLES_SCHEMA_VERSION, servers: [] };
  }
  const warnings: string[] = [];
  const r = await readBundlesAt(path, warnings);
  if (!r.file) {
    // Branch on the warning content to give the user the most actionable
    // message: a read error (EPERM / EACCES) hints at permissions; a parse
    // failure hints at invalid JSON. readBundlesAt populates warnings with
    // the OS error string for read failures and with "invalid JSON" for
    // parse failures, so we sniff those keywords here.
    const warningText = warnings.join("; ");
    const isReadError = /EPERM|EACCES|could not read/i.test(warningText);
    if (isReadError) {
      throw new Error(`${path} could not be read (${warningText}) -- check file permissions before adding servers.`);
    }
    // Default: parse failure or structural mismatch.
    const detail = warnings.length > 0 ? ` (${warningText})` : "";
    throw new Error(`${path} could not be parsed -- fix the JSON${detail} before adding servers.`);
  }
  // Surface non-fatal read warnings on the write path too: an invalid
  // `defaultRuntime` value (a typo like "omm") is dropped by readBundlesAt,
  // and the rewrite below would silently delete the key from the file --
  // the user should see WHY before it vanishes.
  for (const w of warnings) {
    log("warn", "bundles.json warning (write path)", { warning: w });
  }
  // Round-trip defaultRuntime so an add/remove never drops the user's
  // config-level runtime knob (validateEntry-style coercion already ran in
  // readBundlesAt; an invalid value was warned about and dropped there).
  return {
    version: r.file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION,
    servers: r.file.servers,
    ...(r.file.defaultRuntime !== undefined ? { defaultRuntime: r.file.defaultRuntime } : {}),
  };
}

/**
 * Insert or replace a server entry in the user-global bundles.json. An
 * existing entry matches by namespace OR display name -- the name fallback
 * mirrors the app's deduper (yaw-install-handler.ts doInstall) so a server
 * added on the other path (e.g. a legacy entry written without a namespace)
 * isn't duplicated. Atomic write. Returns the path written and whether an
 * existing entry was replaced (vs a fresh add).
 *
 * Serialized via bundleWriteChain so concurrent calls don't lose writes.
 */
export function upsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string } = {},
): Promise<{ path: string; replaced: boolean }> {
  const result = bundleWriteChain.then(() => doUpsertUserBundle(entry, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function doUpsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string },
): Promise<{ path: string; replaced: boolean }> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  const file = await readRawUserBundles(home);
  const idx = file.servers.findIndex(
    (s) => s?.namespace === entry.namespace || (entry.name != null && s?.name === entry.name),
  );
  const replaced = idx >= 0;
  if (replaced) file.servers[idx] = entry;
  else file.servers.push(entry);
  // Preserve a newer on-disk schema version rather than downgrading it; only
  // stamp CURRENT when the file had none (readRawUserBundles guarantees a
  // numeric version when the file existed, so this only fills the fresh case).
  file.version = file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION;
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod not supported on this filesystem; not fatal.
    }
  }
  return { path, replaced };
}

/**
 * Remove a server entry (by namespace) from the user-global bundles.json.
 * No-op (removed:false) when the file or the namespace is absent. Atomic
 * write when a removal actually happens.
 *
 * Serialized via bundleWriteChain so concurrent calls don't lose writes.
 */
export function removeUserBundle(
  namespace: string,
  opts: { home?: string } = {},
): Promise<{ path: string; removed: boolean }> {
  const result = bundleWriteChain.then(() => doRemoveUserBundle(namespace, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function doRemoveUserBundle(
  namespace: string,
  opts: { home?: string },
): Promise<{ path: string; removed: boolean }> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  if (!existsSync(path)) return { path, removed: false };
  const file = await readRawUserBundles(home);
  const before = file.servers.length;
  file.servers = file.servers.filter((s) => s?.namespace !== namespace);
  if (file.servers.length === before) return { path, removed: false };
  // Preserve a newer on-disk schema version rather than downgrading it.
  file.version = file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION;
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod not supported on this filesystem; not fatal.
    }
  }
  return { path, removed: true };
}

/**
 * Does a project-local bundles.json exist that would shadow a user-global
 * write? `add`/`remove` warn when this returns a path, since a write to
 * user-global won't load while the project file is present.
 */
export async function findShadowingProjectBundles(cwd: string, home: string = homedir()): Promise<string | null> {
  const projectDir = await findProjectConfigDir(cwd, home).catch(() => null);
  if (!projectDir) return null;
  const projectPath = localBundlesPath(projectDir);
  return existsSync(projectPath) ? projectPath : null;
}
