// The Codex CLI row, as DATA -- plus the one thing no other row needs: the
// TOML format adapter, registered into the core's registry at module scope, so
// that importing this row is what makes `format: "toml"` readable and writable.
//
// Imports the LEAF model (install-target-model.ts) and the core seam
// (client-config.ts), never install-targets.ts -- that module's own evaluation
// builds INSTALL_TARGETS out of this one, so an import back would be a cycle
// (the boundary test pins it).
//
// WHAT IS CODEX-SPECIFIC AND LIVES HERE:
//   * the file is TOML, not JSON, and its servers are `[mcp_servers.<name>]`
//     tables. The splice, the scanner, the renderer and the post-write check
//     are client-config-toml.ts's; this file is the ConfigAdapter face they
//     are reached through, and it is the ONLY module that registers "toml";
//   * `$CODEX_HOME/config.toml` else `~/.codex/config.toml` for user scope,
//     `<project>/.codex/config.toml` for project scope;
//   * `startup_timeout_sec = 60`, written because Codex's own default is 10
//     seconds and a warm `npx` fetch of @yawlabs/mcp does not reliably finish
//     inside that;
//   * `env_vars` and `enabled` are Codex's own per-server fields and are
//     carried from a stored entry on every path but --force, the way `env`
//     already is -- otherwise a user who allow-listed HTTPS_PROXY (which this
//     row's own notes tell them to do) would lose it to `install --repair`;
//   * a bare `npx` launch entry on Windows, because Codex resolves the `.cmd`
//     shim itself. That is `entry.windowsLaunch.broker: "bare"`, never a
//     client-id branch in a consumer.
//
// VENDOR EVIDENCE. Every claim below was checked on 2026-09-12 against the
// bytes named, with `curl` on the raw source / page rather than a rendered
// view:
//
//   D1 https://developers.openai.com/codex/mcp -- 308 to
//      https://learn.chatgpt.com/docs/extend/mcp?surface=cli
//      "Codex stores MCP configuration in config.toml ... By default this is
//      ~/.codex/config.toml, but you can also scope MCP servers to a project
//      with .codex/config.toml (trusted projects only)"; "Configure each MCP
//      server with a [mcp_servers.<server-name>] table"; the stdio field list
//      ("env (optional): Environment variables to set for the server",
//      "env_vars (optional): Environment variables to allow and forward",
//      `env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]`);
//      "startup_timeout_sec (optional): Timeout (seconds) for the server to
//      start. Default: 10"; "enabled (optional): Set false to dis[able]".
//   D2 https://learn.chatgpt.com/docs/config-file/config-advanced --
//      "Codex stores its local state under CODEX_HOME (defaults to ~/.codex)";
//      "Codex loads project-scoped config files only when the project is
//      trusted"; "By default, Codex treats a directory containing .git as the
//      project root".
//   S1 codex-rs/utils/home-dir/src/lib.rs -- `CODEX_HOME` counts only when set
//      AND non-empty; when set it must exist and be a directory, else Err;
//      unset falls back to `home_dir()/.codex`.
//   S2 codex-rs/rmcp-client/src/program_resolver.rs -- on Windows the program
//      is resolved with `which::which_in` against the forwarded PATH, which is
//      how "tools like `npx`, `pnpm`, and `yarn` ... work correctly on Windows
//      without requiring users to specify full paths or extensions". Unix
//      returns the program unchanged.
//   S3 the resolver landed in commit f828cd28 (2025-11-16, PR #3828);
//      `gh api repos/openai/codex/compare/f828cd28...rust-v0.58.0` reports
//      "diverged" and `...rust-v0.59.0` reports "ahead", so rust-v0.59.0
//      (published 2025-11-19) is the first release carrying it. That is the
//      floor the notes state for Windows.
//   S4 codex-rs/rmcp-client/src/stdio_server_launcher.rs -- the spawn is
//      `.current_dir(cwd).env_clear().envs(&envs)`, and
//      codex-rs/rmcp-client/src/utils.rs builds `envs` from an ALLOWLIST
//      (`DEFAULT_ENV_VARS`, `WINDOWS_CORE_ENV_VARS` on Windows) plus the names
//      in `env_vars`, the CA-certificate names, and the entry's own `env`.
//      Nothing else in the user's environment reaches the server.
//   S5 codex-rs/config/src/mcp_types.rs -- `RawMcpServerConfig` declares
//      `env: Option<HashMap<String, String>>` (string values only),
//      `env_vars: Option<Vec<McpServerEnvVar>>` where an item is a bare name
//      or `{ name, source }` with source "local" or "remote",
//      `startup_timeout_sec: Option<f64>`, `startup_timeout_ms: Option<u64>`,
//      `enabled: Option<bool>`; and `TryFrom` resolves the timeout as
//      `(Some(sec), _) => sec`, `(None, Some(ms)) => from_millis(ms)`, which
//      is the rule `normalizeCodexEntry` mirrors.

import { isAbsolute, join, resolve } from "node:path";
import {
  type ConfigAdapter,
  type ConfigPosition,
  type ConfigRead,
  type EntryAddress,
  type EntryTransform,
  type EntryView,
  type ImportView,
  launchOf,
  normalizeEntry,
  registerConfigAdapter,
} from "./client-config.js";
import {
  canonTomlConfig,
  readTomlConfig,
  removeTomlEntry,
  renderTomlEntry,
  TOML_SYNTAX,
  type TomlConfigRead,
  tomlEntryNames,
  upsertTomlEntry,
} from "./client-config-toml.js";
import { defineTarget, ENTRY_NAME, type PathBase, type ResolvedPath } from "./install-target-model.js";

/** Codex's container key, and the one place this file spells it. */
const CONTAINER_KEY = "mcp_servers";

// ---------------------------------------------------------------------------
// The TOML adapter
// ---------------------------------------------------------------------------

/** The position a TOML parse error is at.
 *
 *  The line and column are the PARSER's own 1-based numbers, kept verbatim so
 *  the message points where smol-toml said; the offset is derived from them so
 *  a caller that wants to slice the text can. A leading BOM is stripped before
 *  the parse and is one character of the original text, so it is added back
 *  here -- otherwise every offset in a BOM-carrying file would be one short. */
function tomlPosition(raw: string, line: number, column: number): ConfigPosition | null {
  if (line < 1 || column < 1) return null;
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  let offset = bom;
  for (let seen = 1; seen < line; seen++) {
    const next = raw.indexOf("\n", offset);
    if (next === -1) return null;
    offset = next + 1;
  }
  return { offset: Math.min(offset + column - 1, raw.length), line, column };
}

/** The names `classify` asks about SPLICEABILITY.
 *
 *  Ours alone, deliberately. An `unspliceable` read refuses every edit through
 *  the write facade, so asking about a name we are not about to rewrite would
 *  turn a neighbouring oddity -- an inline `yaw-mcp` left by hand -- into a
 *  file yaw-mcp declines to touch at all. A legacy or sibling entry in such a
 *  spelling is refused at the WRITE instead, by the splice itself, with the
 *  shape and the remedy in the message. */
const SPLICEABLE_NAMES = [ENTRY_NAME];

function entryViewsOf(read: TomlConfigRead, transform?: EntryTransform): EntryView[] {
  if (read.kind !== "ok") return [];
  // `value` stays the STORED value -- drift comparison and carry-forward read
  // what the file holds -- while `launch` is the normalised view. Identical to
  // the JSON adapter's `entriesOf`, because that rule has no syntax in it.
  return read.entries.map(({ key, value }) => ({ key, value, launch: launchOf(normalizeEntry(value, transform)) }));
}

function classifyToml(raw: string, addr: EntryAddress, transform?: EntryTransform): ConfigRead {
  const read = readTomlConfig(raw, addr.containerPath, SPLICEABLE_NAMES);
  switch (read.kind) {
    case "absent":
      return { kind: "absent" };
    case "malformed":
      // `detail` is the reason WITHOUT the position: the facade's refusal adds
      // " at line L column C" of its own, and TomlConfigError.detail already
      // embeds one, so passing that would print the position twice.
      return {
        kind: "malformed",
        syntax: TOML_SYNTAX,
        reason: "syntax",
        detail: read.reason,
        position: tomlPosition(raw, read.line, read.column),
      };
    case "blocked":
      // A document whose ROOT is not a table has no container key to name, so
      // it reads as a malformed root rather than as a blocked `""`. smol-toml
      // always returns a table, so this is a guard, not a path with a fixture.
      if (read.path.length === 0) {
        return { kind: "malformed", syntax: TOML_SYNTAX, reason: "root", detail: read.shape, position: null };
      }
      // NEVER reparable: Codex refuses to load a file whose `mcp_servers` is
      // not a table at all, and replacing that key would mean rewriting a
      // root-level key-value line -- a second kind of splice, for a shape no
      // tool writes. `repairContainer` below therefore throws, and the facade
      // never calls it because it only repairs a `reparable` read.
      return { kind: "blocked", path: read.path, shape: read.shape, reparable: false, unloadable: null };
    case "unspliceable":
      return { kind: "unspliceable", key: read.key, reason: read.shape };
    default:
      // `unloadable` is a strict-JSON concept: a comment makes a .mcp.json
      // unreadable to its client. TOML has no such gap -- what smol-toml
      // accepts here, Codex's `toml` crate accepts -- so it is always null.
      return {
        kind: "ok",
        containerPresent: read.containerPresent,
        entries: entryViewsOf(read, transform),
        unloadable: null,
      };
  }
}

function upsertToml(raw: string | null, addr: EntryAddress, key: string, entry: Record<string, unknown>): string {
  return upsertTomlEntry(raw, addr.containerPath, key, entry);
}

function removeToml(raw: string, addr: EntryAddress, key: string): string {
  // Returns `raw` ITSELF when the entry is absent -- the identity contract the
  // facade and try's cleanup both detect by reference.
  return removeTomlEntry(raw, addr.containerPath, key);
}

function repairTomlContainer(_raw: string, _addr: EntryAddress, blockedPath: readonly string[]): string {
  throw new Error(
    `"${blockedPath.join(".")}" is not a TOML table, and a TOML container cannot be repaired in place -- ` +
      `make it a table (or remove the key) by hand, then re-run`,
  );
}

/** What `--dry-run` prints: the entry's own table, exactly the bytes the write
 *  would splice in. `creating` is unused -- a TOML entry is a `[header]` block
 *  that reads the same whether or not the file exists, and the block is all
 *  this prints either way, never the merged file (which would put a sibling
 *  server's env into a transcript the user pastes into a bug report). */
function previewToml(addr: EntryAddress, key: string, entry: Record<string, unknown>, _creating: boolean): string {
  return renderTomlEntry(addr.containerPath, key, entry);
}

/** Where the counted entries live. Codex's container is a table header inside
 *  the file and there is no nesting above it, so the file alone says it. */
function describeTomlLocation(absolute: string, _addr: EntryAddress): string {
  return absolute;
}

function canonToml(
  raw: string,
  addr: EntryAddress,
  opts: { drop?: readonly string[]; dropContainer?: boolean } = {},
): string {
  // Dropping the CONTAINER is spelled as dropping every name in it:
  // `canonTomlConfig` deletes a container it has emptied, so the two are the
  // same document. Doing it this way keeps one canonicaliser rather than two.
  const drop =
    opts.dropContainer === true ? tomlEntryNames(readTomlConfig(raw, addr.containerPath)) : (opts.drop ?? []);
  return canonTomlConfig(raw, addr.containerPath, drop);
}

/** Codex CLI's config.toml, spliced table by table.
 *
 *  Registered below at module scope: importing this row is what makes the
 *  format usable, which is the contract `registerConfigAdapter` documents. */
export const TOML_ADAPTER: ConfigAdapter = {
  syntax: TOML_SYNTAX,
  classify: classifyToml,
  upsert: upsertToml,
  remove: removeToml,
  repairContainer: repairTomlContainer,
  renderPreview: previewToml,
  describeLocation: describeTomlLocation,
  canon: canonToml,
};

registerConfigAdapter("toml", TOML_ADAPTER);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Codex's config.toml for one scope.
 *
 *  User scope follows `CODEX_HOME` when it is set, because that is the whole
 *  of Codex's own rule (S1): the variable relocates the directory holding
 *  config.toml, auth.json and the rest, and an empty value counts as unset --
 *  which `readClientEnv` has already applied, so a value that arrives here is
 *  non-empty. A RELATIVE value is resolved against this process's cwd, which
 *  is what Codex's own canonicalisation does from ITS cwd: the two agree when
 *  both are run from the same directory, and a relative CODEX_HOME has no
 *  other defensible reading from here.
 *
 *  `CODEX_HOME` does NOT move the project file: Codex discovers that by
 *  walking up from the working directory, independently of where its home is.
 *
 *  The display path is the absolute one in the CODEX_HOME case -- the same
 *  choice the `claudeConfigDir` branch makes, and for the same reason: a `~`
 *  spelling would name a file the run is not writing.
 *
 *  On Windows `home` is Node's `os.homedir()` (USERPROFILE) while Codex asks
 *  the OS for FOLDERID_Profile. They agree on an ordinary box and can differ
 *  when USERPROFILE is overridden -- a hermetic-test concern, and the reason
 *  every test here passes `home` and `codexHome` explicitly rather than
 *  relying on the ambient environment. */
function resolveCodexPath(base: PathBase): ResolvedPath {
  const containerPath = [CONTAINER_KEY];
  if (base.scope === "project") {
    const sep = base.os === "windows" ? "\\" : "/";
    return {
      absolute: join(base.projectDir, ".codex", "config.toml"),
      display: ["<project folder>", ".codex", "config.toml"].join(sep),
      containerPath,
    };
  }
  const codexHome = base.env.codexHome;
  if (codexHome !== undefined && codexHome.length > 0) {
    const absolute = join(isAbsolute(codexHome) ? codexHome : resolve(codexHome), "config.toml");
    return { absolute, display: absolute, containerPath };
  }
  return {
    absolute: join(base.home, ".codex", "config.toml"),
    display: base.os === "windows" ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml",
    containerPath,
  };
}

// ---------------------------------------------------------------------------
// The entry: what Codex owns on it, and how it reads back
// ---------------------------------------------------------------------------

/** True for one `env_vars` item Codex accepts: a bare variable NAME, or a
 *  table with a string `name` and an optional `source` of "local" or "remote"
 *  (S5, D1). Anything else makes Codex refuse to load the whole file, so
 *  carrying it forward would write back a config the user cannot start. */
function isEnvVarItem(item: unknown): boolean {
  if (typeof item === "string") return true;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (typeof record.name !== "string") return false;
  const source = record.source;
  const sourceOk = source === undefined || source === "local" || source === "remote";
  return sourceOk && Object.keys(record).every((key) => key === "name" || key === "source");
}

/** Codex's own per-server fields, carried from a stored entry.
 *
 *  `env_vars` because this row's notes tell the user to put yaw-mcp's settings
 *  there (Codex forwards an allowlist and nothing else, S4), so dropping it on
 *  a re-run would delete what our own advice made them add. `enabled` because
 *  a user who switched the server off means it: without the carry, `--repair`
 *  would switch it back on and every re-run would report drift.
 *
 *  Each is TYPE-CHECKED, for the reason the Zed row checks its own: carrying
 *  an ill-typed value forward writes back something the client rejects, and a
 *  wrong type here is not a value Codex tolerates -- it refuses to load the
 *  file. `env` is deliberately absent: the core carries that one, with its own
 *  string-only filter and its own --force drop line. */
function carryCodexFields(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(stored.env_vars) && stored.env_vars.length > 0 && stored.env_vars.every(isEnvVarItem)) {
    out.env_vars = [...stored.env_vars];
  }
  if (typeof stored.enabled === "boolean") out.enabled = stored.enabled;
  return out;
}

/** The stored entry as every consumer should see it.
 *
 *  ONE rule, and it is Codex's own (S5): a `startup_timeout_ms` with no
 *  `startup_timeout_sec` beside it IS the startup timeout, in milliseconds, so
 *  an entry spelling our 60 seconds as `startup_timeout_ms = 60000` means what
 *  we would write and must not read as drift. When both are present Codex uses
 *  the seconds one and ignores the other -- so the other is left in place here,
 *  where it shows up in the drift diff as the stale key it is.
 *
 *  What this hook does NOT have to do, because the reader already does it:
 *  make `60` and `60.0` compare equal. Measured on smol-toml 1.8.0 with the
 *  adapter's own parse options -- `60`, `60.0` and `6e1` all come back as the
 *  JS number 60 -- so a Codex round-trip of our block (it re-serialises every
 *  entry, and writes an integral f64 as `60.0`) is not drift. */
function normalizeCodexEntry(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return stored;
  const record = stored as Record<string, unknown>;
  const ms = record.startup_timeout_ms;
  if (record.startup_timeout_sec !== undefined || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return stored;
  }
  const { startup_timeout_ms: _dropped, ...rest } = record;
  return { ...rest, startup_timeout_sec: ms / 1000 };
}

/** Keys a Codex entry can carry that bundles.json has no field for. Named so
 *  `import` can say what it dropped instead of dropping them silently. */
const IMPORT_DISCARDS = [
  "env_vars",
  "cwd",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "enabled_tools",
  "disabled_tools",
  "default_tools_approval_mode",
  "bearer_token_env_var",
  "env_http_headers",
  "http_headers_helper",
  "experimental_environment",
  "environment_id",
  "required",
  "supports_parallel_tool_calls",
  "auth",
  "oauth",
  "tools",
];

/** One stored Codex entry as `import` reads it.
 *
 *  Two spellings are Codex's own and are mapped here rather than in the
 *  importer: HTTP headers are `http_headers` (D1), and a server switched off
 *  is `enabled = false` (D1) rather than the `disabled: true` other clients
 *  use. Everything the destination cannot hold is NAMED in `discardedKeys`. */
function codexImportView(stored: Record<string, unknown>): ImportView {
  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (IMPORT_DISCARDS.includes(key) || key === "enabled" || key === "http_headers") continue;
    entry[key] = value;
  }
  if (typeof stored.http_headers === "object" && stored.http_headers !== null && !Array.isArray(stored.http_headers)) {
    entry.headers = stored.http_headers;
  }
  const view: ImportView = { entry };
  if (stored.enabled === false) view.disabled = true;
  const discarded = IMPORT_DISCARDS.filter((key) => stored[key] !== undefined);
  if (discarded.length > 0) view.discardedKeys = discarded;
  return view;
}

export const CODEX_CLI_TARGET = defineTarget({
  clientId: "codex-cli",
  label: "Codex CLI",
  config: { format: "toml", root: CONTAINER_KEY },
  availableOn: ["macos", "linux", "windows"],
  entry: {
    normalize: normalizeCodexEntry,
    carry: carryCodexFields,
    // Written on OUR entry and on a `try` trial alike, and compared like
    // command and args -- a user who changes it sees it in the drift diff.
    //
    // 60, against Codex's documented default of 10 (D1). The install command
    // in the README is itself `npx -y @yawlabs/mcp@latest`, so Codex's first
    // launch finds a warm npm cache; 10 seconds is the wrong order of
    // magnitude for that launch and 60 is not. A genuinely COLD fetch (a fresh
    // machine, or the first spawn after a new release) can still exceed it --
    // the remedy there is to re-run the spawn, not a timeout we could pick.
    extraFields: () => ({ startup_timeout_sec: 60 }),
    // Bare `npx` on Windows: Codex resolves the `.cmd` shim itself (S2), which
    // is also what `codex mcp add` writes, so a `cmd /c` entry of ours would
    // read as drift the moment the user ran that command. It needs Codex
    // 0.59.0 or newer (S3), which the notes state. A `try` upstream still
    // takes the shared wrap: that entry names a THIRD-PARTY launcher whose
    // args have to survive cmd's parse, which is what escapeCmdArg's caret
    // depths are for, and `buildLaunchEntry`'s upstream branch wraps on
    // Windows regardless of this field.
    windowsLaunch: { broker: "bare", upstream: "cmd-wrap" },
    forImport: codexImportView,
  },
  notes:
    "Codex CLI reads MCP servers from config.toml ([mcp_servers.<name>] tables) under CODEX_HOME, which defaults to ~/.codex. A project's .codex/config.toml is read only once Codex trusts the project. Codex starts a server with a cleared environment and forwards an allowlist, so put yaw-mcp settings in the entry's [mcp_servers.mcp.env] table or name them in env_vars. On Windows the entry is bare npx, not cmd /c npx, and needs Codex 0.59.0 or newer, which resolves npx's .cmd shim itself. Restart Codex after editing; `codex mcp list` shows the entry.",
  resolvePath: resolveCodexPath,
  scopes: [
    // User FIRST, like every other multi-scope row: the probe walks this array
    // in order and it decides `--list` and doctor row order.
    {
      scope: "user",
      label: "User (global)",
      description: "Private to this machine; applies to every project.",
      requiresProjectDir: false,
    },
    {
      scope: "project",
      label: "Project",
      description: "Commit to share with your team; Codex reads it once the project is trusted.",
      requiresProjectDir: true,
    },
  ],
});
