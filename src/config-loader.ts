// yaw-mcp config loader for version, servers, blocked, installNudge.
//
// Config lives in three optional files, highest-precedence first:
//
//   1. <project>/.yaw-mcp/config.local.json  — machine-local override; gitignore by convention
//   2. <project>/.yaw-mcp/config.json        — project-shared file (committed)
//   3. ~/.yaw-mcp/config.json                — user-global default
//
// The project `.yaw-mcp/` directory is discovered by walking up from cwd
// (see paths.ts findProjectConfigDir) -- stopping before $HOME when the
// walk started under it, so a `.yaw-mcp/` sitting at $HOME is treated as
// user-global only; a cwd OUTSIDE $HOME walks to the filesystem root with
// a per-directory ownership check instead.
//
// DEPRECATED KEYS: `token` and `apiBase` are no longer read by anything --
// yaw-mcp is local-only and never contacts a hosted API. A file carrying
// either key still loads (soft deprecation: rejecting it would break every
// existing install), but the loader emits a warning telling the user to
// delete the key. For `token` it adds that there is nothing to revoke: the
// hosted backend that issued those PATs is retired (migrate.ts's header says
// the same of the legacy flat file's token). Deleting the apiBase precedence chain
// also closes a real hole: a committed project-scope `apiBase` could
// redirect the API base while a global-scope token was attached, sending
// that token to an attacker-chosen host.
//
// servers/blocked merging: local beats project for the allow-list, and the
// result can only NARROW a global allow-list (entries outside it are dropped
// with a warning). The deny-lists union across all scopes.
//
// POLICY FILES FAIL CLOSED. A missing file means "no policy from this file". A
// file that exists but cannot be read or parsed, or whose servers / blocked /
// blockedTools have the wrong type, is a policy error: every server spawn is
// refused until it is fixed (see policyErrors). The meta-tools keep working so
// the problem can be diagnosed.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { closestNames } from "./fuzzy.js";
import { parseJsonc } from "./jsonc.js";
import { jsonErrorLocation, NAMESPACE_RE } from "./local-bundles.js";
import { log } from "./logger.js";
import { migrateLegacyConfigPaths, type PendingLegacyMigration, planLegacyConfigMigration } from "./migrate.js";
import { isFeatureEnabled } from "./opt-out-env.js";
import { findProjectConfigDir, normalizeForCompare, userConfigDir } from "./paths.js";

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
  /** Per-TOOL deny-list, holding flattened `<namespace>_<tool>` wire names
   *  with an optional single trailing `*`. A different axis from `blocked`,
   *  which names whole servers and is evaluated at SPAWN; these are evaluated
   *  at CALL. */
  blockedTools?: string[];
  /** Opt-in flag for the shadow-driven install nudge. Off (undefined)
   *  by default; only `true` enables it. See install-nudge.ts. */
  installNudge?: boolean;
  /** The warning for top-level keys this file carries that the loader does not
   *  read, when there are any. Kept per file so the policy surfaces can repeat
   *  it: a misspelled `blocked` enforces nothing. */
  unknownKeysWarning?: string;
}

/** A policy file that exists but could not be honored. */
export interface PolicyError {
  path: string;
  message: string;
}

export interface ResolvedConfig {
  /** Allow-list (local > project, narrowed by global). Undefined when no scope
   *  sets it. An empty list allows nothing. */
  servers?: string[];
  /** Deny-list (union across all scopes that set it). Holds namespaces and
   *  `package:` / `command:` / `url:` identity entries. */
  blocked?: string[];
  /** Present when a policy file is broken. Every spawn is refused while set. */
  policyErrors?: PolicyError[];
  /** Per-tool deny-list, union across every scope that sets it -- the same
   *  merge as `blocked`, and for the same reason: a project config may ADD a
   *  deny, never subtract one. Undefined when no scope sets it. */
  blockedTools?: string[];
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
  /** Broken-policy messages (one per `policyErrors` entry) plus unknown
   *  top-level keys, one per file that has them. A subset of `warnings`,
   *  repeated where the policy is shown (`mcp_connect_health`, activation
   *  refusals) so a refusal carries the file's own KEY-level message and not
   *  just its path. Never a reason to refuse AGAIN: a broken file already
   *  refuses through `policyErrors`, an unknown key may be a newer release's. */
  policyWarnings?: string[];
}

export interface LoadConfigOptions {
  /** Directory to start project-config discovery from. Defaults to process.cwd(). */
  cwd?: string;
  /** Home directory override for tests. Defaults to os.homedir(). */
  home?: string;
  /** Process env the loader consults. Read for exactly ONE key: paths.ts's
   *  ALLOW_UNOWNED_ENV opt-in, which the project-dir walk needs when
   *  ownership is unverifiable (win32). Everything else this loader once read
   *  from the env (YAW_MCP_TOKEN / YAW_MCP_URL) retired with the hosted
   *  backend. Defaults to process.env; doctor (doctor-cmd.ts, the shared
   *  collector) and the tests pass a synthetic one so the walk's trust
   *  decision can be probed without stubbing the real environment.
   *
   *  Wire any future env-dependent key up explicitly, the way this one is --
   *  do not turn the field back into a general escape hatch. That is why
   *  YAW_MCP_READONLY_DIAGNOSTICS is NOT read from here: it arrives as
   *  `readOnly` below, decided by the caller. */
  env?: NodeJS.ProcessEnv;
  /** Load without writing anything: the pre-0.12 legacy-path migration is
   *  PLANNED instead of run, and each file it would have moved comes back as
   *  a warning (its settings are not in this load, and the caller's report
   *  must say so rather than read as if the file did not exist). Nothing is
   *  memoized either, so a later ordinary load in the same process still
   *  migrates.
   *
   *  A caller option rather than an env read, deliberately: the diagnostic
   *  commands (doctor, `bundles match`) pass `isReadOnlyDiagnostics(env)`,
   *  while the server's own startup load never passes it. An env read here
   *  would let a YAW_MCP_READONLY_DIAGNOSTICS that leaked into a client's
   *  environment switch the BROKER's migration off too, so the one process
   *  whose job it is to fold the legacy file in would never do it. */
  readOnly?: boolean;
}

/** Opt-in: `YAW_MCP_READONLY_DIAGNOSTICS=1` (or "true") makes the diagnostic
 *  commands write nothing. Yaw Terminal's MCP panel runs `doctor --json`,
 *  `status --json` and `bundles list --json` on every refresh, and a
 *  background refresh must not edit a client config or move a file:
 *
 *    - `doctor` (text and --json) skips the expired-trial sweep
 *      (gcExpiredTrials, which rewrites client configs and unlinks markers).
 *      It still scans the trials and reports the expired ones as not swept,
 *      as warnings, with the command that sweeps them.
 *    - `doctor` and `bundles match` load config.json with `readOnly` (above):
 *      the legacy-path migration (a mkdir + rename) is reported, not run.
 *    - `doctor` reads its 24 h registry cache (~/.yaw-mcp/registry-cache.json)
 *      but does not write it; an ordinary run is what fills it.
 *    - `status` and `bundles list` already write nothing, flag or no flag.
 *
 *  Unset, every command behaves exactly as before. */
export const READONLY_DIAGNOSTICS_ENV = "YAW_MCP_READONLY_DIAGNOSTICS";

/** Is YAW_MCP_READONLY_DIAGNOSTICS on? The one truthiness rule every
 *  YAW_MCP_* opt-in applies (isPersistenceDisabled, isTrustBypassEnabled,
 *  isAutoLoadEnabled): the value is TRIMMED, then "1" or case-insensitive
 *  "true" is on. Anything else -- unset, empty, "yes", "on", "0" -- is off.
 *  Trimmed for the cmd.exe reason: `set VAR=1 && ...` delivers "1 ", and an
 *  untrimmed copy reads that as off on exactly the shell the user set it from.
 *
 *  Takes `env` for the reason isPersistenceDisabled does: doctor and `bundles`
 *  thread an injected environment, and a predicate they cannot hand their own
 *  env to is one they cannot share. */
export function isReadOnlyDiagnostics(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFeatureEnabled(READONLY_DIAGNOSTICS_ENV, env);
}

/** The warning a read-only load raises for a legacy file it did not move.
 *  Exported so the tests pin the wording instead of re-spelling it. */
export function legacyMigrationSkippedWarning(p: PendingLegacyMigration): string {
  return `${p.legacy}: pre-0.12 config file not migrated -- ${READONLY_DIAGNOSTICS_ENV} is set, so this run moves no files and the settings in it are NOT part of this report. The next yaw-mcp start (or this command with ${READONLY_DIAGNOSTICS_ENV} unset) moves it to ${p.target}.`;
}

/** Config keys that used to drive the hosted backend and are now inert.
 *  Detected (not consumed) so the loader can tell the user to clean up.
 *  Exported alongside KNOWN_CONFIG_KEYS for the schema drift test. */
export const DEPRECATED_KEYS = ["token", "apiBase"] as const;

/** Every top-level key the loader reads. Mirrors the shipped JSON schema
 *  (schemas/yaw-mcp.config.v1.json, additionalProperties:false) so an
 *  unrecognized key gets a warning instead of being a silent no-op --
 *  `$schema` is the editor-autocomplete pointer the schema itself allows.
 *
 *  Exported so config-loader.test.ts can diff it against that schema's
 *  `properties`: the two are the same contract written twice (the schema
 *  refuses an unknown key in the editor, this set warns about it at load),
 *  and the schema is shipped to users by URL, so a key added here and not
 *  there would be flagged invalid in their editor while working fine. */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "version",
  "servers",
  "blocked",
  "blockedTools",
  "installNudge",
]);

/** Public URL of the shipped JSON Schema (schemas/yaw-mcp.config.v1.json).
 *  It is the only place a user can see the whole key list WITH its types and
 *  constraints, and nothing in the product pointed at it -- so it went
 *  undiscovered. Named in the unknown-key warning below (the one moment a
 *  user is demonstrably looking for the key list) and in the README's
 *  Configuration section. Same URL as the schema's own `$id`; dropping it
 *  into a config as `"$schema"` turns on editor completion. */
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/YawLabs/mcp/main/schemas/yaw-mcp.config.v1.json";

/** Build the soft-deprecation warning for a file that still carries
 *  `token` / `apiBase`. Named separately so the exact wording is
 *  assertable from tests and identical on every surface (startup log,
 *  `doctor`, `doctor --json` warnings array). */
function deprecatedKeyWarning(path: string, keys: string[]): string {
  const quoted = keys.map((k) => `'${k}'`).join(" and ");
  const isAre = keys.length > 1 ? "are" : "is";
  const them = keys.length > 1 ? "them" : "it";
  const revoke = keys.includes("token")
    ? // Not "revoke it at its source": the hosted service that issued these
      // tokens is retired (see the DEPRECATED KEYS note in this file's
      // header), so that sent the user looking for a page that is gone.
      // config-loader.test.ts matches "nowhere left to revoke that PAT";
      // doctor-cmd.test.ts matches the "Delete it from <path>" half below.
      ` There is nowhere left to revoke that PAT: the hosted service that issued it is retired, so deleting it from the file is all there is to do.`
    : "";
  return (
    `${path}: ${quoted} ${isAre} no longer used -- yaw-mcp is local-only and never contacts a hosted API. ` +
    `Delete ${them} from ${path}.${revoke}`
  );
}

/** Per-entry shape check. Parameterized because `servers`/`blocked` hold
 *  NAMESPACES while `blockedTools` holds flattened `<namespace>_<tool>` wire
 *  names, which NAMESPACE_RE rejects outright -- it is lowercase-only and caps
 *  at 30 characters, which real tool names routinely exceed. Returns the
 *  warning text, or null when the entry is fine. */
type EntryValidator = (entry: string, field: string, path: string) => string | null;

const namespaceEntry: EntryValidator = (entry, field, path) =>
  NAMESPACE_RE.test(entry)
    ? null
    : `${path}: '${field}' entry '${entry}' is not a valid namespace (a lowercase letter followed by [a-z0-9_], 30 characters at most) -- it can never match an installed server.`;

/** `blocked` also takes a launch identity (server-identity.ts), which is how a
 *  deny survives the server being registered under another namespace. */
const IDENTITY_ENTRY_RE = /^(?:package|command|url):\S/;

const blockedEntry: EntryValidator = (entry, field, path) =>
  IDENTITY_ENTRY_RE.test(entry) ? null : namespaceEntry(entry, field, path);

/** A flattened wire tool name, optionally ending in a single `*` wildcard.
 *  A bare `*` is refused: a deny that matches everything is far more likely a
 *  mistake than an intent, and `blocked` is the way to turn a server off. */
const TOOL_ENTRY_RE = /^[A-Za-z0-9_.:-]+\*?$/;

/** `<identity>#<tool>`: a tool on whichever namespace that server is under. */
const IDENTITY_TOOL_ENTRY_RE = /^(?:package|command|url):\S.*#[A-Za-z0-9_.:-]+\*?$/;

const toolEntry: EntryValidator = (entry, field, path) => {
  if (IDENTITY_TOOL_ENTRY_RE.test(entry)) return null;
  if (!TOOL_ENTRY_RE.test(entry)) {
    return `${path}: '${field}' entry '${entry}' is not a valid tool name (letters, digits, '_', '.', ':', '-', with an optional single trailing '*', or '<identity>#<tool>') -- it can never match a tool.`;
  }
  // Meta-tools are the broker's own control surface: blocking one would
  // disable the mechanism the user manages the block WITH, and the call gate
  // deliberately runs after the meta-tool branches, so an entry naming one
  // could never fire. Say so rather than leaving a line that does nothing.
  if (entry.startsWith("mcp_connect_")) {
    return `${path}: '${field}' entry '${entry}' names a yaw-mcp meta-tool, which cannot be blocked -- remove it, or block the upstream server with 'blocked'.`;
  }
  // Without a separator the entry cannot be a `<namespace>_<tool>` wire name,
  // so it is almost always someone trying to block a whole server here. A
  // wildcard is different: `ssh*` is a working prefix, and dropping a deny
  // the user wrote would leave its tools callable.
  if (!entry.includes("_") && !entry.endsWith("*")) {
    return `${path}: '${field}' entry '${entry}' has no '_' separator, so it cannot be a '<namespace>_<tool>' name -- to block a whole server use 'blocked'.`;
  }
  return null;
};

const POLICY_FIX =
  "No MCP server will start until this is fixed: correct the file (or delete it, since a missing file sets no policy), restart your MCP client, and run `yaw-mcp doctor` to confirm.";

/** Record a broken policy file: refused at every spawn gate, and repeated in
 *  `warnings` so doctor and the startup log show it too. */
function policyProblem(path: string, problem: string, warnings: string[], errors: PolicyError[]): void {
  const message = `${path}: ${problem} ${POLICY_FIX}`;
  warnings.push(message);
  errors.push({ path, message });
}

/** Filter a config array field down to its usable string entries. A field of
 *  the wrong type, or an array holding non-string or blank entries, is a policy
 *  error: guessing what a damaged allow- or deny-list meant is how a typo turns
 *  into allow-all. An entry that is a string of the wrong shape only warns.
 *  Returns undefined when the field is absent or not an array. An empty [] is
 *  preserved: on `servers` it means "allow nothing". */
function filterStringArray(
  raw: unknown,
  field: string,
  path: string,
  warnings: string[],
  errors: PolicyError[],
  validate: EntryValidator = namespaceEntry,
  // Whether a REJECTED entry is dropped as well as warned about. True for
  // blockedTools: a bare `*` is reported as unmatchable, so keeping it would
  // let the gate's prefix match enforce it as deny-everything.
  dropInvalid = false,
): string[] | undefined {
  // What the field holds, for the two messages that are not the validator's.
  const noun = validate === toolEntry ? "tool-name" : "namespace";
  if (!Array.isArray(raw)) {
    // Absence is the normal case for every scope the user hasn't configured.
    if (raw !== undefined) {
      policyProblem(
        path,
        `'${field}' must be an array of ${noun} strings (found ${raw === null ? "null" : typeof raw}), for example "${field}": [].`,
        warnings,
        errors,
      );
    }
    return undefined;
  }
  // Non-strings AND blank strings are not usable (the shipped schema says
  // minLength 1). Survivors are kept TRIMMED: validating `" github".trim()`
  // while keeping the untrimmed spelling would produce an entry no installed
  // namespace can ever match.
  const strings = raw
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter((v): v is string => typeof v === "string" && v !== "");
  const dropped = raw.length - strings.length;
  if (dropped > 0) {
    policyProblem(
      path,
      `'${field}' has ${dropped} non-string or empty ${dropped === 1 ? "entry" : "entries"}; every entry must be a non-empty ${noun} string.`,
      warnings,
      errors,
    );
  }
  // The shape check is a WARNING on servers/blocked: an unmatchable allow entry
  // simply allows nothing. NAMESPACE_RE is imported from local-bundles.ts rather
  // than re-spelled so the validator and the installer pin one definition.
  const kept: string[] = [];
  for (const s of strings) {
    const problem = validate(s, field, path);
    if (problem) warnings.push(problem);
    if (!problem || !dropInvalid) kept.push(s);
  }
  return kept;
}

async function readConfigAt(
  path: string,
  scope: ConfigScope,
  warnings: string[],
  errors: PolicyError[],
): Promise<LoadedConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // "Not there" is the overwhelmingly common case and stays silent:
    // ENOENT (no such file) and ENOTDIR (a component of the path isn't a
    // directory, i.e. `.yaw-mcp/` doesn't exist) both mean there is no file
    // to load. Anything ELSE means the file IS there and we could not read
    // it -- EACCES on a root-owned `~/.yaw-mcp/config.json` (sudo-run
    // install, restored backup), EISDIR on a `config.json/` directory, EIO
    // on a flaky mount. The allow/deny lists in it cannot be known, so this
    // is a policy error like the invalid-JSON case below.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    const msg = err instanceof Error ? err.message : String(err);
    policyProblem(path, `exists but could not be read (${code ?? msg}).`, warnings, errors);
    log("warn", "Config file exists but could not be read; refusing server spawns", { path, error: msg, code });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    // A position, never err.message: V8 quotes a slice of the source around
    // the bad token, which can be a pasted secret. Same rule as bundles.json
    // (parseBundlesContent).
    const where = jsonErrorLocation(raw, err);
    policyProblem(path, `invalid JSON ${where}.`, warnings, errors);
    log("warn", "Config file is not valid JSON; refusing server spawns", { path, location: where });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    policyProblem(path, "the top level must be a JSON object.", warnings, errors);
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : undefined;
  // A PRESENT but wrong-typed version (`"version": "2"` -- the likeliest
  // hand-edit typo, since every other value in the file is a string or an
  // array of them) used to collapse to undefined and skip the newer-schema
  // warning below, so the one user who most needs to be told their file is
  // from a newer yaw-mcp got silence. Warn instead of coercing: guessing a
  // schema version from a string is exactly the kind of leniency that makes
  // the "loading best-effort" claim untrue.
  if ("version" in obj && version === undefined) {
    warnings.push(
      `${path}: 'version' must be a number (found ${obj.version === null ? "null" : typeof obj.version}) -- ignored; schema-version checks are skipped for this file.`,
    );
  }
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

  // Unknown top-level keys warn (the shipped schema is
  // additionalProperties:false): a typo like "blocke" was a silent no-op
  // that fails OPEN to allow-all. Deprecated keys are reported above with
  // their own migration hint, so they are excluded here.
  const unknownKeys = Object.keys(obj).filter(
    (k) => !KNOWN_CONFIG_KEYS.has(k) && !(DEPRECATED_KEYS as readonly string[]).includes(k),
  );
  let unknownKeysWarning: string | undefined;
  if (unknownKeys.length > 0) {
    const known = [...KNOWN_CONFIG_KEYS];
    const guesses = unknownKeys
      .map((k) => [k, closestNames(k, known, 1)[0]] as const)
      .filter(([, guess]) => guess !== undefined)
      .map(([k, guess]) => `'${k}' -> '${guess}'`);
    const hint =
      guesses.length > 0 ? ` Did you mean ${guesses.join(", ")}? Rename it and restart your MCP client.` : "";
    unknownKeysWarning = `${path}: unknown ${unknownKeys.length === 1 ? "key" : "keys"} ${unknownKeys.map((k) => `'${k}'`).join(", ")} ignored, so nothing in ${unknownKeys.length === 1 ? "it is" : "them is"} enforced -- known keys: ${known.join(", ")}.${hint} Full schema: ${CONFIG_SCHEMA_URL}`;
    warnings.push(unknownKeysWarning);
  }

  const servers = filterStringArray(obj.servers, "servers", path, warnings, errors);
  const blocked = filterStringArray(obj.blocked, "blocked", path, warnings, errors, blockedEntry);
  const blockedTools = filterStringArray(obj.blockedTools, "blockedTools", path, warnings, errors, toolEntry, true);
  // Only a literal boolean is honored — a non-boolean (string "true",
  // number 1) is ignored rather than coerced, so a typo can't silently
  // flip on a privacy-sensitive nudge.
  const installNudge = typeof obj.installNudge === "boolean" ? obj.installNudge : undefined;
  // ...but the discard is announced, exactly like the wrong-typed `version`
  // above. `"installNudge": "true"` used to be swallowed with no diagnostic
  // on any surface, so a user who opted in read their own config as enabled
  // while the nudge stayed off.
  if ("installNudge" in obj && installNudge === undefined) {
    warnings.push(
      `${path}: 'installNudge' must be a boolean (found ${obj.installNudge === null ? "null" : typeof obj.installNudge}) -- ignored; the nudge stays off for this file.`,
    );
  }

  return {
    path,
    scope,
    version,
    servers,
    blocked,
    blockedTools,
    installNudge,
    ...(unknownKeysWarning ? { unknownKeysWarning } : {}),
  };
}

/** Merge servers (allow-list). config.local.json beats the project file, and
 *  whichever applies may only narrow the user-global list: a config that
 *  arrives with a cloned repository must not be able to grant itself a server
 *  the user's own allow-list leaves out. */
function pickServers(files: LoadedConfigFile[], warnings: string[]): string[] | undefined {
  const specific =
    files.find((f) => f.scope === "local" && f.servers) ?? files.find((f) => f.scope === "project" && f.servers);
  const global = files.find((f) => f.scope === "global" && f.servers);
  if (!specific?.servers) return global?.servers;
  if (!global?.servers) return specific.servers;
  const allowed = new Set(global.servers);
  const dropped = specific.servers.filter((s) => !allowed.has(s));
  if (dropped.length > 0) {
    const them = dropped.length === 1 ? "it" : "them";
    warnings.push(
      `${specific.path}: 'servers' ${dropped.map((s) => `'${s}'`).join(", ")} dropped -- not in the global allow-list at ${global.path}, and a project config can only narrow that list. To allow ${them}, add ${them} to ${global.path} and restart your MCP client.`,
    );
  }
  return specific.servers.filter((s) => allowed.has(s));
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
function unionStringField(files: LoadedConfigFile[], field: "blocked" | "blockedTools"): string[] | undefined {
  const set = new Set<string>();
  let touched = false;
  for (const f of files) {
    if (f[field]) {
      touched = true;
      for (const b of f[field]) set.add(b);
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
  const key = `${cwd}\u0000${home}`;
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
  const policyErrors: PolicyError[] = [];
  const loadedFiles: LoadedConfigFile[] = [];

  // Fold any pre-0.12 flat config dotfiles into `.yaw-mcp/` before the
  // resolver runs — otherwise a user who upgrades from 0.11.x would
  // silently lose their allow/deny lists until they moved the file by hand.
  // Fail-open: migration errors are logged, never thrown. Memoized per
  // (cwd, home) so repeat loads in one process don't re-walk the tree.
  //
  // A read-only load (see LoadConfigOptions.readOnly) plans the same walk
  // instead and warns per file it would have moved. Not memoized: the memo
  // means "the move has run for this pair", which a plan never makes true.
  if (opts.readOnly) {
    const pending = await planLegacyConfigMigration({ cwd, home }).catch((err): PendingLegacyMigration[] => {
      log("warn", "Legacy config migration check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });
    for (const p of pending) warnings.push(legacyMigrationSkippedWarning(p));
  } else {
    await migrateLegacyConfigPathsOnce(cwd, home);
  }

  const projectConfigDir = await findProjectConfigDir(cwd, home, opts.env).catch((err) => {
    log("warn", "Failed searching for project .yaw-mcp/ dir", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  const globalDir = userConfigDir(home);
  const localPath = projectConfigDir ? join(projectConfigDir, LOCAL_CONFIG_FILENAME) : null;
  const projectPath = projectConfigDir ? join(projectConfigDir, CONFIG_FILENAME) : null;
  const globalPath = join(globalDir, CONFIG_FILENAME);

  const local = localPath ? await readConfigAt(localPath, "local", warnings, policyErrors) : null;
  if (local) loadedFiles.push(local);

  // Belt and braces against double-loading the user-global dir as project
  // config. With the real findProjectConfigDir this cannot fire: the walk gets
  // the same `home`, never returns $HOME's own `.yaw-mcp/` when it starts at or
  // under $HOME, and skips any candidate whose realpath is the user-global dir.
  // It is kept so that a change to the walk cannot turn into one file loaded
  // under two scopes, and config-loader-project-is-global.test.ts reaches it
  // by mocking the walk. Normalize through resolve() and paths.ts
  // normalizeForCompare (case-fold on win32 and darwin, the same rule the walk
  // applies) so a case-variant or unnormalized spelling still compares equal.
  const normalizeDir = (d: string): string => normalizeForCompare(resolve(d));
  const projectIsGlobal = projectConfigDir !== null && normalizeDir(projectConfigDir) === normalizeDir(globalDir);
  const project =
    projectIsGlobal || !projectPath ? null : await readConfigAt(projectPath, "project", warnings, policyErrors);
  if (project) loadedFiles.push(project);

  const global = await readConfigAt(globalPath, "global", warnings, policyErrors);
  if (global) loadedFiles.push(global);

  const policyWarnings = loadedFiles.flatMap((f) => (f.unknownKeysWarning ? [f.unknownKeysWarning] : []));
  // ...and the BROKEN-policy messages too (the policyProblem ones: wrong-typed
  // servers/blocked/blockedTools, unreadable/invalid JSON file). They already
  // reach `warnings` and `policyErrors` (which refuses every spawn), but a
  // refusal only NAMED the file -- while an unknown key got its own
  // policyWarnings line. policyWarnings is display-only (isAllowed and
  // effectiveProfile never read it), so repeating a message here costs no
  // enforcement and gives each refusal the key-level message to show.
  policyWarnings.push(...policyErrors.map((e) => e.message));

  return {
    servers: pickServers(loadedFiles, warnings),
    blocked: unionStringField(loadedFiles, "blocked"),
    blockedTools: unionStringField(loadedFiles, "blockedTools"),
    installNudge: pickInstallNudge(loadedFiles),
    projectConfigDir,
    loadedFiles,
    warnings,
    ...(policyErrors.length > 0 ? { policyErrors } : {}),
    ...(policyWarnings.length > 0 ? { policyWarnings } : {}),
  };
}

// --- Profile compatibility layer ---------------------------------------
//
// server.ts and a few call sites still speak in terms of a "Profile": a
// { path, servers?, blocked?, blockedTools? } record describing which
// namespaces and tools are allowed in this session. The new ResolvedConfig
// carries the same allow/deny lists, so we expose a thin shim that converts
// the relevant slice and preserves the exact shape server.ts already consumes.

export interface Profile {
  /** Primary identity: the highest-precedence config file that was loaded --
   *  the project's config.local.json, else its config.json, else user-global. */
  path: string;
  /** The user-global path, surfaced too when a project-level file is `path`
   *  and the user-global file was also loaded. */
  userPath?: string;
  servers?: string[];
  blocked?: string[];
  /** Per-tool denies, carried so a refusal can name the file that declares
   *  one and `mcp_connect_health` can show the policy. */
  blockedTools?: string[];
  /** Every loaded file that itself declares a `blockedTools` key, highest
   *  precedence first. `path` / `userPath` cannot stand in for this: with a
   *  config.local.json loaded, a project config.json carrying the deny is
   *  neither of them. Absent when no file declares the key. */
  blockedToolsPaths?: string[];
  /** Broken policy files. While present, every server is refused. */
  policyErrors?: PolicyError[];
  /** Broken-policy messages and unknown top-level keys
   *  (ResolvedConfig.policyWarnings): shown, never enforced, and never a
   *  reason to refuse on their own. */
  policyWarnings?: string[];
}

/** Derive a Profile from a ResolvedConfig, or null if no allow/deny
 *  rules are set anywhere. The `servers` / `blocked` / `blockedTools` lists
 *  are what the gates enforce (the server's `this.profile`, and `call`'s
 *  spawn and tool gates). Only the path fields are for display: they
 *  condense which files contributed, for health output and refusal text. */
export function toProfile(config: ResolvedConfig): Profile | null {
  const policyErrors = config.policyErrors?.length ? config.policyErrors : undefined;
  if (
    config.servers === undefined &&
    config.blocked === undefined &&
    config.blockedTools === undefined &&
    !policyErrors &&
    !config.policyWarnings?.length
  ) {
    return null;
  }
  const byScope = new Map<ConfigScope, LoadedConfigFile>();
  for (const f of config.loadedFiles) byScope.set(f.scope, f);

  const local = byScope.get("local");
  const project = byScope.get("project");
  const global = byScope.get("global");

  const primary = local ?? project ?? global;
  // A broken file may be the only one there is, and it still has to produce a
  // profile: null would read as "no policy".
  const path = primary?.path ?? policyErrors?.[0]?.path;
  // Otherwise unreachable: the lists are only ever populated from a loaded file.
  if (path === undefined) return null;

  const result: Profile = {
    path,
    servers: config.servers,
    blocked: config.blocked,
    blockedTools: config.blockedTools,
  };
  if (policyErrors) result.policyErrors = policyErrors;
  if (config.policyWarnings?.length) result.policyWarnings = config.policyWarnings;
  if (primary && primary !== global && global) {
    result.userPath = global.path;
  }
  // loadedFiles is pushed local -> project -> global, so this is precedence
  // order. `f.blockedTools` is set only when the file's own key parsed.
  const declaring = config.loadedFiles.filter((f) => f.blockedTools !== undefined).map((f) => f.path);
  if (declaring.length > 0) result.blockedToolsPaths = declaring;
  return result;
}

/** Returns true iff `namespace` is allowed by the resolved allow/deny lists. */
export function isAllowed(
  rules: { servers?: string[]; blocked?: string[]; policyErrors?: PolicyError[] } | null,
  namespace: string,
): boolean {
  if (!rules) return true;
  if (rules.policyErrors?.length) return false;
  if (rules.blocked?.includes(namespace)) return false;
  // Set means set: an explicit empty list allows nothing.
  if (rules.servers) return rules.servers.includes(namespace);
  return true;
}

/** Back-compat alias for isAllowed when the caller is holding a Profile. */
export function profileAllows(profile: Profile | null, namespace: string): boolean {
  return isAllowed(profile, namespace);
}
