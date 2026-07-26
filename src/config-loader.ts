// yaw-mcp config loader for version, servers, blocked, installNudge.
//
// Config lives in three optional files, highest-precedence first:
//
//   1. <project>/.yaw-mcp/config.local.json  — machine-local override; gitignore by convention
//   2. <project>/.yaw-mcp/config.json        — project-shared file (committed)
//   3. ~/.yaw-mcp/config.json                — user-global default
//
// The project `.yaw-mcp/` directory is discovered by walking up from cwd
// (see paths.ts findProjectConfigDir), stopping exclusively before $HOME
// so a `.yaw-mcp/` sitting at $HOME is treated as user-global only.
//
// DEPRECATED KEYS: `token` and `apiBase` are no longer read by anything --
// yaw-mcp is local-only and never contacts a hosted API. A file carrying
// either key still loads (soft deprecation: rejecting it would break every
// existing install), but the loader emits a warning telling the user to
// delete the key and revoke the PAT. Deleting the apiBase precedence chain
// also closes a real hole: a committed project-scope `apiBase` could
// redirect the API base while a global-scope token was attached, sending
// that token to an attacker-chosen host.
//
// servers/blocked merging: allow-list picks the most specific scope that
// sets it (local > project > global); deny-list unions across all scopes.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { migrateLegacyConfigPaths } from "./migrate.js";
import { findProjectConfigDir, userConfigDir } from "./paths.js";

export const CONFIG_FILENAME = "config.json";
export const LOCAL_CONFIG_FILENAME = "config.local.json";
/** Schema version we currently emit. Older files load fine; newer files
 *  trigger a warning so a user running an old yaw-mcp doesn't silently
 *  ignore fields it doesn't understand. */
export const CURRENT_SCHEMA_VERSION = 1;

export type ConfigScope = "local" | "project" | "global";

export interface LoadedConfigFile {
  path: string;
  scope: ConfigScope;
  version?: number;
  servers?: string[];
  blocked?: string[];
  /** Opt-in flag for the shadow-driven install nudge. Off (undefined)
   *  by default; only `true` enables it. See install-nudge.ts. */
  installNudge?: boolean;
}

export interface ResolvedConfig {
  /** Allow-list (local > project > global). Undefined when no scope sets it. */
  servers?: string[];
  /** Deny-list (union across all scopes that set it). */
  blocked?: string[];
  /** Opt-in: enable the shadow-driven install nudge in discover. Resolved
   *  most-specific-scope-wins (local > project > global). Undefined when no
   *  scope sets it (treated as off). The env var YAW_MCP_INSTALL_NUDGE=1
   *  also enables it independently — see install-nudge.ts installNudgeEnabled. */
  installNudge?: boolean;
  /** Absolute path to the discovered project `.yaw-mcp/` dir, or null if none. */
  projectConfigDir: string | null;
  /** Files actually read + parsed (in load order). */
  loadedFiles: LoadedConfigFile[];
  /** Soft problems that don't fail loading. Surface in `yaw-mcp doctor`. */
  warnings: string[];
}

export interface LoadConfigOptions {
  /** Directory to start project-config discovery from. Defaults to process.cwd(). */
  cwd?: string;
  /** Home directory override for tests. Defaults to os.homedir(). */
  home?: string;
  /** Process env override for tests. Currently unread: the only env vars
   *  this loader ever consulted were YAW_MCP_TOKEN / YAW_MCP_URL, both
   *  retired with the hosted backend. Kept on the options type so the many
   *  existing call sites (server boot, doctor, every CLI subcommand) keep
   *  compiling through the deprecation window. */
  env?: NodeJS.ProcessEnv;
}

/** Config keys that used to drive the hosted backend and are now inert.
 *  Detected (not consumed) so the loader can tell the user to clean up. */
const DEPRECATED_KEYS = ["token", "apiBase"] as const;

/** Build the soft-deprecation warning for a file that still carries
 *  `token` / `apiBase`. Named separately so the exact wording is
 *  assertable from tests and identical on every surface (startup log,
 *  `doctor`, `doctor --json` warnings array). */
function deprecatedKeyWarning(path: string, keys: string[]): string {
  const quoted = keys.map((k) => `'${k}'`).join(" and ");
  const isAre = keys.length > 1 ? "are" : "is";
  const them = keys.length > 1 ? "them" : "it";
  const revoke = keys.includes("token")
    ? ` Revoke that PAT at its source -- deleting it here does not deactivate it.`
    : "";
  return (
    `${path}: ${quoted} ${isAre} no longer used -- yaw-mcp is local-only and never contacts a hosted API. ` +
    `Delete ${them} from ${path}.${revoke}`
  );
}

/** Filter a config array field down to its string entries. Warns when
 *  non-string entries are dropped (mirroring the apiBase field, which warns
 *  rather than silently swallowing an unusable value). Returns undefined
 *  when the field isn't an array OR when every entry was invalid: a
 *  non-empty array that filters to [] must fall THROUGH to the parent scope
 *  rather than resolve to [] -- an empty allow-list means allow-all in
 *  isAllowed, so a `servers:[123]` at a specific scope would otherwise
 *  silently shadow a valid parent scope's allow-list with allow-all. A
 *  genuinely empty [] is preserved as-is (an explicit "no filter"). */
function filterStringArray(raw: unknown, field: string, path: string, warnings: string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const strings = raw.filter((v): v is string => typeof v === "string");
  const dropped = raw.length - strings.length;
  if (dropped > 0) {
    warnings.push(
      `${path}: '${field}' dropped ${dropped} non-string ${dropped === 1 ? "entry" : "entries"} -- only string namespaces are honored.`,
    );
  }
  // All entries invalid (non-empty array that filtered to []): treat as
  // unset so the resolver falls through to the parent scope instead of
  // resolving to an empty (allow-all) list that shadows it.
  if (strings.length === 0 && raw.length > 0) return undefined;
  return strings;
}

async function readConfigAt(path: string, scope: ConfigScope, warnings: string[]): Promise<LoadedConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) -- file ignored`);
    log("warn", "Config file is not valid JSON; ignoring", { path, error: msg });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object -- file ignored`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : undefined;
  if (version !== undefined && version > CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this yaw-mcp (${CURRENT_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcp@latest\`. Loading best-effort.`,
    );
  }

  // Soft deprecation: detect the retired hosted-backend keys, warn, and
  // keep loading. A hard error here would break every config file written
  // by a pre-local-only yaw-mcp -- and the rest of the file (allow/deny
  // lists, installNudge) is still perfectly valid. Key PRESENCE is the
  // trigger, not a usable value: `"token": ""` still needs cleaning up.
  const staleKeys = DEPRECATED_KEYS.filter((k) => k in obj);
  if (staleKeys.length > 0) {
    warnings.push(deprecatedKeyWarning(path, [...staleKeys]));
    log("warn", "Config file carries retired hosted-backend keys", { path, keys: staleKeys.join(",") });
  }

  const servers = filterStringArray(obj.servers, "servers", path, warnings);
  const blocked = filterStringArray(obj.blocked, "blocked", path, warnings);
  // Only a literal boolean is honored — a non-boolean (string "true",
  // number 1) is ignored rather than coerced, so a typo can't silently
  // flip on a privacy-sensitive nudge.
  const installNudge = typeof obj.installNudge === "boolean" ? obj.installNudge : undefined;

  return { path, scope, version, servers, blocked, installNudge };
}

/** Merge servers (allow-list): most specific scope wins. */
function pickServers(files: LoadedConfigFile[]): string[] | undefined {
  const local = files.find((f) => f.scope === "local")?.servers;
  if (local !== undefined) return local;
  const project = files.find((f) => f.scope === "project")?.servers;
  if (project !== undefined) return project;
  return files.find((f) => f.scope === "global")?.servers;
}

/** Resolve installNudge: most specific scope that sets it wins (local >
 *  project > global), mirroring pickServers. Undefined when no scope sets
 *  it — the gate treats that as off. */
function pickInstallNudge(files: LoadedConfigFile[]): boolean | undefined {
  const local = files.find((f) => f.scope === "local")?.installNudge;
  if (local !== undefined) return local;
  const project = files.find((f) => f.scope === "project")?.installNudge;
  if (project !== undefined) return project;
  return files.find((f) => f.scope === "global")?.installNudge;
}

/** Merge blocked (deny-list): union across all scopes that declare it. */
function unionBlocked(files: LoadedConfigFile[]): string[] | undefined {
  const set = new Set<string>();
  let touched = false;
  for (const f of files) {
    if (f.blocked) {
      touched = true;
      for (const b of f.blocked) set.add(b);
    }
  }
  return touched ? [...set] : undefined;
}

// migrateLegacyConfigPaths stat-walks from cwd up to $HOME on every call.
// loadYawMcpConfig runs several times in a single process (server boot,
// doctor, each CLI subcommand, every profile refresh), and the migration
// is idempotent and one-way: once it has run to completion for a given
// (cwd, home) pair there is nothing left to move. Memoize the in-flight /
// settled promise so the walk is paid once per process (and concurrent
// callers share one walk rather than racing each other on rename).
const migrationOnce = new Map<string, Promise<void>>();

function migrateLegacyConfigPathsOnce(cwd: string, home: string): Promise<void> {
  const key = `${cwd} ${home}`;
  let pending = migrationOnce.get(key);
  if (pending === undefined) {
    // Fail-open (matches the migrator's own contract): a rejection is
    // logged, never propagated, and never re-tried -- a broken filesystem
    // state must not brick startup or re-throw on every later load.
    pending = migrateLegacyConfigPaths({ cwd, home }).catch((err) => {
      log("warn", "Legacy config migration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    migrationOnce.set(key, pending);
  }
  return pending;
}

export async function loadYawMcpConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = resolve(opts.home ?? homedir());

  const warnings: string[] = [];
  const loadedFiles: LoadedConfigFile[] = [];

  // Fold any pre-0.12 flat config dotfiles into `.yaw-mcp/` before the
  // resolver runs — otherwise a user who upgrades from 0.11.x would
  // silently lose their allow/deny lists until they moved the file by hand.
  // Fail-open: migration errors are logged, never thrown. Memoized per
  // (cwd, home) so repeat loads in one process don't re-walk the tree.
  await migrateLegacyConfigPathsOnce(cwd, home);

  const projectConfigDir = await findProjectConfigDir(cwd, home).catch((err) => {
    log("warn", "Failed searching for project .yaw-mcp/ dir", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  const globalDir = userConfigDir(home);
  const localPath = projectConfigDir ? join(projectConfigDir, LOCAL_CONFIG_FILENAME) : null;
  const projectPath = projectConfigDir ? join(projectConfigDir, CONFIG_FILENAME) : null;
  const globalPath = join(globalDir, CONFIG_FILENAME);

  const local = localPath ? await readConfigAt(localPath, "local", warnings) : null;
  if (local) loadedFiles.push(local);

  // Avoid double-loading when the discovered project dir IS the user-global dir.
  // findProjectConfigDir excludes $HOME, so this only triggers if someone passes
  // a non-homedir `home` override that happens to equal the walk-up match.
  // Normalize through resolve() (and case-fold on win32) so a case-variant or
  // unnormalized home override doesn't byte-mismatch and double-load.
  const normalizeDir = (d: string): string => {
    const r = resolve(d);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const projectIsGlobal = projectConfigDir !== null && normalizeDir(projectConfigDir) === normalizeDir(globalDir);
  const project = projectIsGlobal || !projectPath ? null : await readConfigAt(projectPath, "project", warnings);
  if (project) loadedFiles.push(project);

  const global = await readConfigAt(globalPath, "global", warnings);
  if (global) loadedFiles.push(global);

  return {
    servers: pickServers(loadedFiles),
    blocked: unionBlocked(loadedFiles),
    installNudge: pickInstallNudge(loadedFiles),
    projectConfigDir,
    loadedFiles,
    warnings,
  };
}

// --- Profile compatibility layer ---------------------------------------
//
// server.ts and a few call sites still speak in terms of a "Profile": a
// { path, servers?, blocked? } record describing which namespaces are
// allowed in this session. The new ResolvedConfig carries the same
// allow/deny lists, so we expose a thin shim that converts the relevant
// slice and preserves the exact shape server.ts already consumes.

export interface Profile {
  /** Primary identity: project config file if one was loaded, else user-global. */
  path: string;
  /** When both project + user-global contributed, the user-global path is surfaced too. */
  userPath?: string;
  servers?: string[];
  blocked?: string[];
}

/** Derive a Profile from a ResolvedConfig, or null if no allow/deny
 *  rules are set anywhere. Display-only: it condenses which files
 *  contributed into `path` (+ `userPath`) for `handleHealth()`. */
export function toProfile(config: ResolvedConfig): Profile | null {
  if (config.servers === undefined && config.blocked === undefined) return null;
  const byScope = new Map<ConfigScope, LoadedConfigFile>();
  for (const f of config.loadedFiles) byScope.set(f.scope, f);

  const local = byScope.get("local");
  const project = byScope.get("project");
  const global = byScope.get("global");

  const primary = local ?? project ?? global;
  if (!primary) return null;

  const result: Profile = {
    path: primary.path,
    servers: config.servers,
    blocked: config.blocked,
  };
  if (primary !== global && global) {
    result.userPath = global.path;
  }
  return result;
}

/** Returns true iff `namespace` is allowed by the resolved allow/deny lists. */
export function isAllowed(rules: { servers?: string[]; blocked?: string[] } | null, namespace: string): boolean {
  if (!rules) return true;
  if (rules.blocked?.includes(namespace)) return false;
  if (rules.servers && rules.servers.length > 0) {
    return rules.servers.includes(namespace);
  }
  return true;
}

/** Back-compat alias for isAllowed when the caller is holding a Profile. */
export function profileAllows(profile: Profile | null, namespace: string): boolean {
  return isAllowed(profile, namespace);
}
