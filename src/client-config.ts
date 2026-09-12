// The format-agnostic client-config model: one module owns "classify the
// file, read the entry map, upsert, remove, find the legacy key, compare,
// report malformed" for every config syntax, so a consumer never learns
// whether a client stores its servers as JSON, JSONC or TOML.
//
// WHY THIS EXISTS. Every install target today is "a JSON object map under
// containerPath, entry keyed `mcp`", and that assumption is re-derived by a
// dozen functions across install-cmd, doctor-cmd, try-cmd and import-cmd --
// each with its own object-shape walk, its own `ENTRY_NAME in container` test
// and its own parseJsonc call. A target whose file is not JSON would
// therefore be read correctly by whichever consumer its author remembered and
// mis-read by the rest, and a mis-read reports "not installed" or aborts on a
// parse error. The fix is structural: the syntax lives behind ONE seam.
//
// WHAT LIVES WHERE.
//   * this file -- the model (formats, addresses, reads, entries, transforms,
//     sites, reload), the adapter REGISTRY, the single reader of the env vars
//     that relocate a client config, and the write facade that verifies its
//     own output before any caller can persist it.
//   * client-config-json.ts -- the JSON-family adapter (JSONC-tolerant and
//     strict JSON), which delegates every splice to jsonc.ts so it inherits
//     that module's byte-preservation contract.
//   * a sibling module -- one more adapter per syntax, registered through
//     `registerConfigAdapter`. The `"toml"` format is DECLARED here and has
//     no adapter in this build: `adapterFor("toml")` throws
//     MissingConfigAdapterError until one is registered.
//
// NO AMBIENT READS. This module reads `process.env` at exactly one place --
// the default argument of `readClientEnv` -- and the filesystem at exactly
// two, the default arguments of `selectSites` and `readClientConfigFile`.
// Everything else takes what it needs as a parameter, which is what keeps a
// hermetic test hermetic and what keeps a read and a write from resolving one
// path two different ways (the split `resolveAppDataDir` documents).
//
// ENTRY-LEVEL READS ARE NOT PER-ADAPTER, on purpose. `entries`, `entry`,
// `normalized`, `legacyKey`, `otherServerKeys`, `count`, `carryableEnv` and
// `carried` are methods of ClientConfigView, not of ConfigAdapter: once an adapter has
// classified the bytes into EntryView[], those questions have one answer for
// every syntax. Putting them on the adapter would mean one implementation per
// format of a rule with no format in it -- the "shared guard gets one
// adopter" failure this seam exists to remove.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { JSON_ADAPTER, JSONC_ADAPTER } from "./client-config-json.js";
import {
  ENTRY_NAME,
  type InstallOS,
  type LaunchEntry,
  LEGACY_ENTRY_NAMES,
  type ResolvedPath,
} from "./install-target-model.js";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** The config syntaxes a client can store its server map in.
 *
 *  `"jsonc"` is JSON as editors actually write it: `//` comments and trailing
 *  commas are legal and MUST survive a write. `"json"` is strict JSON -- a
 *  comment or a trailing comma makes the file unloadable for its client, so a
 *  write into one is refused rather than producing a file the client silently
 *  skips. Strictness is therefore a property the TARGET declares (see
 *  `effectiveConfigFormat`), never a guess about the bytes.
 *
 *  `"toml"` is declared with no adapter in this build. It is part of the union
 *  so `adapterFor` can refuse it by name instead of a consumer discovering
 *  the gap as a parse failure. */
export type ConfigFormat = "json" | "jsonc" | "toml";

/** Every DECLARED format, for a caller that has to enumerate them. Not "every
 *  format with an adapter" -- ask `hasConfigAdapter` for that. */
export const CONFIG_FORMATS: readonly ConfigFormat[] = ["json", "jsonc", "toml"];

/** How a format is NAMED in a user-facing sentence: "is not valid JSON",
 *  "exists but TOML is malformed". JSONC answers "JSON", which is what
 *  install and doctor print today and what the user's editor calls the file. */
export type SyntaxName = "JSON" | "TOML";

export function syntaxNameFor(format: ConfigFormat): SyntaxName {
  return format === "toml" ? "TOML" : "JSON";
}

/** Where a client keeps its server map, as data.
 *
 *  `root` is the container key -- "mcpServers" for almost everyone, "servers"
 *  for VS Code, "context_servers" for Zed, "mcp_servers" for Codex. It is the
 *  LAST segment of a ResolvedPath's containerPath; the earlier segments (for
 *  Claude Code's local scope) are the resolver's business. */
export interface ConfigShape {
  format: ConfigFormat;
  root: string;
  /** Who owns the file. `"shared"` (the default, and every existing target)
   *  is a user config yaw-mcp splices into. `"dedicated"` is a file yaw-mcp
   *  creates for itself. Nothing in this module behaves differently on it: it
   *  is carried so the Done and uninstall wording can say whether the file
   *  stays behind. */
  ownership?: "shared" | "dedicated";
}

/** The part of a scope spec that can override the target's format.
 *
 *  Claude Code stores user and local scope in `~/.claude.json` (which it
 *  writes itself) but reads a project's `.mcp.json` strictly: a comment there
 *  makes it skip the whole file. So strictness is per SCOPE, not per client,
 *  and one flag on the scope spec turns a `"jsonc"` target into a strict
 *  `"json"` site. */
export interface ConfigStrictness {
  strictJson?: boolean;
}

/** The format a SITE is actually read and written with: the target's format,
 *  narrowed to strict JSON when the scope says the client parses that file
 *  strictly. Only `"jsonc"` narrows -- a scope cannot make TOML strict, and a
 *  target that already declares `"json"` is strict everywhere. */
export function effectiveConfigFormat(shape: ConfigShape, scope?: ConfigStrictness): ConfigFormat {
  return scope?.strictJson === true && shape.format === "jsonc" ? "json" : shape.format;
}

// ---------------------------------------------------------------------------
// Addresses, sites and reads
// ---------------------------------------------------------------------------

/** Where the entry map lives inside one file, in that file's own syntax.
 *
 *  OPAQUE to consumers: only this module and the adapters read its fields. A
 *  consumer holds one because the resolver produced it, passes it back, and
 *  never walks it -- which is the point, since walking it is what tied a
 *  dozen functions to JSON. */
export interface EntryAddress {
  format: ConfigFormat;
  /** Key path to the container: `["mcpServers"]`, `["servers"]`,
   *  `["context_servers"]`, `["mcp_servers"]`, or Claude Code's local-scope
   *  three-segment path through its per-project map. */
  containerPath: readonly string[];
}

/** One file a (client, scope) writes to.
 *
 *  Almost every target resolves to exactly one site. Cline fans out: a shared
 *  file plus one copy under every editor whose Cline extension storage
 *  exists, because a shared-file-only install is invisible to most Cline
 *  windows. `detectDir` is what splits the two kinds:
 *
 *    * `null`  -- written unconditionally (every existing target, and Cline's
 *                 shared file). The file need not exist yet.
 *    * a path  -- written only when that directory already exists. A
 *                 DIRECTORY rather than the config file itself, so a detected
 *                 editor with no MCP settings yet still gets one. */
export interface ConfigSite {
  /** Stable id for messages and tests: "default", "shared", "vscode". */
  id: string;
  /** How the site is named in a row or a Done line: "Cline (VS Code)". */
  label: string;
  /** Absolute path, display path and container path, from the resolver. */
  resolved: ResolvedPath;
  /** The site's EFFECTIVE format -- `effectiveConfigFormat` already applied,
   *  so a strict scope of a JSONC target reads as `"json"` here. */
  format: ConfigFormat;
  detectDir: string | null;
}

/** The sites of a target that this machine actually has: every unconditional
 *  site, plus each conditional one whose `detectDir` exists.
 *
 *  `exists` is the seam a test overrides. Order is preserved, so a shared file
 *  stays first and rows come out in table order. */
export function selectSites(sites: readonly ConfigSite[], exists: (p: string) => boolean = existsSync): ConfigSite[] {
  return sites.filter((site) => site.detectDir === null || exists(site.detectDir));
}

/** The address of a site's entry map. */
export function addressOf(site: ConfigSite): EntryAddress {
  return { format: site.format, containerPath: site.resolved.containerPath };
}

/** A position in the file's own bytes. `line` and `column` are 1-based, the
 *  spelling every editor uses; `offset` is a 0-based index into the raw text
 *  INCLUDING a leading BOM when the file has one. */
export interface ConfigPosition {
  offset: number;
  line: number;
  column: number;
}

/** `offset` as a 1-based line/column pair against `raw`. Counts LF, so a CRLF
 *  file reports the line numbers an editor shows. */
export function positionAt(raw: string, offset: number): ConfigPosition {
  const clamped = Math.max(0, Math.min(offset, raw.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (raw[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset: clamped, line, column: clamped - lineStart + 1 };
}

/** The file parses for yaw-mcp but NOT for the client that owns it: strict
 *  JSON carrying a comment or a trailing comma. Every server in such a file
 *  is silently not loading, so splicing one more in would print Done over a
 *  file nothing reads.
 *
 *  `detail` is the client-side parser's own complaint and `position` points at
 *  the first byte it rejected. */
export interface StrictViolation {
  syntax: SyntaxName;
  detail: string;
  position: ConfigPosition | null;
}

/** One server in the container, in file order.
 *
 *  `key` is how the client addresses it (an object key in every JSON-family
 *  target, a sub-table name in TOML). `value` is the stored value exactly as
 *  the file holds it, which is what drift comparison and carry-forward read.
 *  `launch` is the normalised launch view -- `null` when the value is not an
 *  object with a string `command`. */
export interface EntryView {
  key: string;
  value: unknown;
  launch: LaunchEntry | null;
}

/** Why a file did not parse. `"syntax"` is the parser's refusal; `"root"` is a
 *  document whose root is not a map (a JSON array, a scalar) and so has no
 *  place to put a container. */
export type MalformedReason = "syntax" | "root";

/** Everything reading one client config file can conclude, in one union.
 *
 *  Each kind maps onto messages and exit codes the consumers already have:
 *  `absent` is "not installed", `unreadable` is the EISDIR/EACCES/EBUSY case,
 *  `malformed` is "is not valid <syntax>" / "is not a <syntax> object",
 *  `blocked` is the non-object container key install can sometimes repair, and
 *  `unspliceable` is a file that parses but holds our entry in a shape the
 *  splicer will not edit. */
export type ConfigRead =
  /** No file, or a file that is empty or whitespace-only. */
  | { kind: "absent" }
  /** The bytes could not be read. `code` is the errno, carried separately so a
   *  caller can tell a transient read (EBUSY, EAGAIN) from a real one without
   *  matching on node's message wording. */
  | { kind: "unreadable"; code: string | null; message: string }
  | { kind: "malformed"; syntax: SyntaxName; reason: MalformedReason; detail: string; position: ConfigPosition | null }
  /** A key along the container path holds a non-object. `reparable` is true
   *  when replacing it with an empty container throws nothing away (null, a
   *  scalar, an empty array) and false when it could hold real servers in the
   *  wrong shape (a non-empty array).
   *
   *  `unloadable` rides along for the same reason it does on `ok`: a file can
   *  be BOTH strict-unloadable and blocked, and without it here a repair would
   *  be allowed into a file the client does not read. */
  | {
      kind: "blocked";
      path: readonly string[];
      shape: string;
      reparable: boolean;
      unloadable: StrictViolation | null;
    }
  /** Parses, but the entry (or the container) is spelled in a way the splicer
   *  will not edit -- a TOML inline or dotted table, which cannot be extended
   *  by a later header. */
  | { kind: "unspliceable"; key: string; reason: string }
  /** Read. `containerPresent` distinguishes "no container at that path" from
   *  "an empty container", which is what `install --list` needs to tell
   *  no-entries from other-entries. `unloadable` is non-null when the client's
   *  own parser would reject the file (see StrictViolation). */
  | { kind: "ok"; containerPresent: boolean; entries: readonly EntryView[]; unloadable: StrictViolation | null };

// ---------------------------------------------------------------------------
// Entry transforms
// ---------------------------------------------------------------------------

/** What an entry is being built FOR. `"broker"` is the yaw-mcp entry install
 *  writes; `"upstream"` is the one-off trial entry `try` writes, pointing at
 *  someone else's server. The two differ per client, which is why every
 *  transform hook takes the purpose. */
export type EntryPurpose = "broker" | "upstream";

/** One stored entry as `import` reads it: the canonical fields, plus the three
 *  facts a client can state about an entry that are not fields at all.
 *
 *  This exists so a client's own field SPELLINGS are mapped once, beside that
 *  client, instead of import learning five vocabularies (Codex spells headers
 *  `http_headers` and disables with `enabled: false`; Zed also uses `enabled`
 *  and marks a remote-only server `remote: true`; Cline uses `disabled`). The
 *  importer reads `entry`'s canonical fields and nothing else, so a new client
 *  is a new `forImport`, never an edit to the importer. */
export interface ImportView {
  /** The entry in the shape the importer reads -- command, args, env, url,
   *  headers, type, description. A client-specific key belongs in
   *  `discardedKeys`, not here. */
  entry: Record<string, unknown>;
  /** The client stores this server switched OFF. Imported, but inactive. */
  disabled?: boolean;
  /** Not importable at all, in the client's own terms ("Zed resolves it
   *  through an extension"). Printed beside the entry in the skipped list. */
  skipReason?: string;
  /** Keys the destination cannot hold, named so the importer can say what it
   *  dropped instead of dropping them silently. */
  discardedKeys?: string[];
}

/** How one target's entry differs from the canonical shape.
 *
 *  Every hook is optional and every default is today's behaviour, so a target
 *  that declares none reads and writes byte-for-byte what it does now. */
export interface EntryTransform {
  /** Stored value -> the entry every consumer compares and inspects.
   *
   *  A client whose own installer writes a nested transport form needs it
   *  folded to the flat shape here; without that, an entry yaw-mcp put there
   *  and the client then rewrote reads as a foreign server rather than as
   *  ours. Numeric normalisation belongs here too, so a value a vendor CLI
   *  re-serialises in another spelling is not drift. Default: identity. */
  normalize?: (stored: unknown) => unknown;
  /** Fields the CLIENT owns on our entry: install neither writes them nor
   *  treats them as drift, and every path but `--force` carries them forward
   *  (a disabled flag, an auto-approve list, a timeout). The target validates
   *  them here -- a `disabled: "yes"` is the user's to fix, not ours to
   *  propagate.
   *
   *  `env` is NOT carried here: the core carries it, with its own string-only
   *  filter and its own `--force` drop line, so returning it would mean two
   *  owners for one field. `carriedFieldsOf` drops the key. */
  carry?: (stored: Record<string, unknown>) => Record<string, unknown>;
  /** Fields install WRITES beyond command/args/env, and therefore compares
   *  like them (a startup timeout the client requires). Part of the entry, so
   *  a user who changes one sees it in the drift diff. */
  extraFields?: (ctx: { os: InstallOS; purpose: EntryPurpose }) => Record<string, unknown>;
  /** Windows launch policy, by purpose: whether the entry is wrapped in
   *  `cmd /c` or emitted bare for the client to resolve the `.cmd` shim
   *  itself.
   *
   *  DATA ONLY -- nothing in client-config*.ts reads this field. It lives on
   *  the transform because an entry's shape is one idea; `buildLaunchEntry`
   *  in install-targets.ts is what applies it. */
  windowsLaunch?: { broker: "cmd-wrap" | "bare"; upstream: "cmd-wrap" | "bare" };
  /** Stored value -> the entry `import` reads, in the client's own terms.
   *  `importViewOf` applies it; without it an entry imports as its normalised
   *  self and nothing is disabled, skipped or discarded.
   *
   *  The hook is what keeps a client's field names OUT of the importer: a
   *  target maps its own spellings here, so adding a client never edits
   *  import-cmd.ts (which is why it belongs to the transform rather than to
   *  the importer's own table). */
  forImport?: (stored: Record<string, unknown>) => ImportView;
}

/** True for a plain object -- neither null nor an array. The test every read
 *  here makes before treating a parsed value as an entry or a container. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `stored` as the transform says every consumer should see it. */
export function normalizeEntry(stored: unknown, transform?: EntryTransform): unknown {
  return transform?.normalize === undefined ? stored : transform.normalize(stored);
}

/** The launch view of a stored entry, or null when there is nothing to launch.
 *
 *  `args` is FILTERED to strings rather than cast: a hand-edited config whose
 *  args carry a number parses fine, and every consumer downstream calls string
 *  methods on each token. `env` keeps only string-valued keys, per key, for
 *  the same reason -- a numeric `DEBUG: 1` must not take the valid keys beside
 *  it down with it. */
export function launchOf(value: unknown): LaunchEntry | null {
  if (!isRecord(value)) return null;
  const record = value;
  if (typeof record.command !== "string") return null;
  const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
  const env = stringMap(record.env);
  return env === undefined ? { command: record.command, args } : { command: record.command, args, env };
}

/** The string-valued keys of an `env` object, or undefined when there are none
 *  (or when `env` is not an object). */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const kept: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") kept[key] = v;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** The env a rewrite carries forward from a stored entry: string values only,
 *  undefined when there is nothing to carry. */
export function carryableEnvOf(stored: unknown): Record<string, string> | undefined {
  if (!isRecord(stored)) return undefined;
  return stringMap(stored.env);
}

/** The client-owned fields a rewrite carries forward, per the target's own
 *  `carry` hook. `env` is dropped here even if a hook returns it -- the core
 *  owns that field. */
export function carriedFieldsOf(stored: unknown, transform?: EntryTransform): Record<string, unknown> {
  if (transform?.carry === undefined) return {};
  if (!isRecord(stored)) return {};
  const carried = { ...transform.carry(stored) };
  delete carried.env;
  return carried;
}

/** One stored entry as `import` should read it.
 *
 *  With no `forImport` hook the entry imports as its NORMALISED self -- which
 *  is what makes a client that stores our own launch under a nested transport
 *  key import as a launchable server rather than as an opaque object -- and
 *  nothing is disabled, skipped or discarded. A hook replaces that default
 *  outright: the target has the whole say over its own entries.
 *
 *  A normalise hook that returns a non-object leaves the STORED value as the
 *  entry, so a transform written for one shape cannot turn a foreign server
 *  into an empty import. */
export function importViewOf(stored: Record<string, unknown>, transform?: EntryTransform): ImportView {
  if (transform?.forImport !== undefined) return transform.forImport(stored);
  const normalized = normalizeEntry(stored, transform);
  return { entry: isRecord(normalized) ? normalized : stored };
}

export interface ComposeEntryOptions {
  /** What the launcher built: command, args, and an env of its own for the
   *  upstream shape. Wins over everything else. */
  base: LaunchEntry | Record<string, unknown>;
  transform?: EntryTransform;
  os: InstallOS;
  purpose: EntryPurpose;
  /** Env carried from the stored entry, from `carryableEnvOf`. Fills a gap
   *  only: an entry that brings its own env is untouched. `--force` passes
   *  nothing, which is how that flag becomes a true overwrite. */
  env?: Record<string, string>;
  /** Client-owned fields carried from the stored entry, from
   *  `carriedFieldsOf`. `--force` passes nothing. */
  carried?: Record<string, unknown>;
}

/** The entry to write: carried client fields, then the target's extra fields,
 *  then the built launch entry, then the carried env.
 *
 *  Precedence is deliberate and tested: the launch entry is LAST of the three
 *  spreads, so neither a stale carried field nor a target's extra field can
 *  change the command or the args install is writing. The env fill matches
 *  install's rule exactly -- it applies only when the composed entry has no
 *  env of its own and the carried map is non-empty. */
export function composeEntry(opts: ComposeEntryOptions): Record<string, unknown> {
  const extra = opts.transform?.extraFields?.({ os: opts.os, purpose: opts.purpose }) ?? {};
  const out: Record<string, unknown> = { ...opts.carried, ...extra, ...opts.base };
  if (out.env === undefined && opts.env !== undefined && Object.keys(opts.env).length > 0) out.env = opts.env;
  return out;
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

/** What the user has to do before the client picks up a config change.
 *
 *  `"restart"` is the default and today's wording. `"live"` is a client with a
 *  file watcher. `"reload-window"` is an editor extension with no watcher on
 *  the file yaw-mcp wrote, where a full restart is more than the user needs. */
export type ReloadKind = "live" | "restart" | "reload-window";

/** The sentence after "Done: <label> is configured." for one reload kind.
 *
 *  `undefined` means `"restart"`, and that branch returns the string install
 *  prints today byte-for-byte, so routing the existing targets through here
 *  changes no output. */
export function reloadDoneClause(reload: ReloadKind | undefined, label: string): string {
  switch (reload) {
    case "live":
      return `${label} starts the server when the file is saved -- no restart needed.`;
    case "reload-window":
      return "Reload the IDE window to pick up the new MCP server.";
    default:
      return "Restart it to pick up the new MCP server.";
  }
}

// ---------------------------------------------------------------------------
// Adapters and the registry
// ---------------------------------------------------------------------------

/** Everything one config syntax has to be able to do.
 *
 *  `classify` is pure and NEVER throws: every failure is a ConfigRead kind,
 *  because a consumer that has to try/catch a read is a consumer that will
 *  report a parse error as a missing install. The writing methods may throw (a
 *  splice can refuse), and `applyClientConfigEdits` is what turns that into
 *  the existing "Refusing to overwrite" path. */
export interface ConfigAdapter {
  /** How this syntax is named in a sentence. */
  syntax: SyntaxName;
  /** Read `raw` at `addr` and say what it is. `transform` only affects
   *  `EntryView.launch`, never the classification. */
  classify(raw: string, addr: EntryAddress, transform?: EntryTransform): ConfigRead;
  /** Upsert one entry, appending a NEW key after the container's last member
   *  and replacing an existing one in place. `raw === null` means the file
   *  does not exist: render a fresh document. */
  upsert(raw: string | null, addr: EntryAddress, key: string, entry: Record<string, unknown>): string;
  /** Remove one entry. Returns `raw` ITSELF -- the same reference,
   *  byte-identical, BOM included -- when the entry is not there, which is the
   *  no-op contract `removeJsoncEntry` already has and which try's cleanup and
   *  doctor's GC both detect by identity. */
  remove(raw: string, addr: EntryAddress, key: string): string;
  /** Replace a reparable blocked container key with an empty container. */
  repairContainer(raw: string, addr: EntryAddress, blockedPath: readonly string[]): string;
  /** What `--dry-run` prints: the entry as it would appear, in the file's own
   *  syntax. `creating` is true when the file does not exist yet. */
  renderPreview(addr: EntryAddress, key: string, entry: Record<string, unknown>, creating: boolean): string;
  /** How to name the container in a message: the file alone, or the file plus
   *  the nested container it holds. */
  describeLocation(absolute: string, addr: EntryAddress): string;
  /** The whole document, canonically rendered, with our entries taken out --
   *  the "everything the edit was not about" fingerprint the post-write check
   *  compares. Valid only on text `classify` returned `ok` for (or, for the
   *  strict flavour, `ok` with `unloadable` set); throws otherwise.
   *
   *  `drop` names the entries to remove from the container. `dropContainer`
   *  removes the container itself instead, for the two edits that legitimately
   *  change it: a repair, and an upsert that creates it. */
  canon(raw: string, addr: EntryAddress, opts?: { drop?: readonly string[]; dropContainer?: boolean }): string;
}

/** The DESIGN.md spelling of `ConfigAdapter`, kept as an alias so a sibling
 *  adapter written against that document compiles unchanged. One interface,
 *  two names for it -- never two interfaces. */
export type FormatAdapter = ConfigAdapter;

export class MissingConfigAdapterError extends Error {
  readonly format: ConfigFormat;
  constructor(format: ConfigFormat) {
    const syntax = syntaxNameFor(format);
    super(
      `no config adapter for "${format}" -- this build of yaw-mcp cannot read or write ${syntax} client configs. ` +
        `Register one with registerConfigAdapter("${format}", ...) before using a ${format} target.`,
    );
    this.name = "MissingConfigAdapterError";
    this.format = format;
  }
}

/** Adapters registered at runtime, by format. The JSON family is not in here
 *  -- it is built in (see `builtInAdapter`) -- so a stray reset cannot leave
 *  the existing targets without a reader. */
const REGISTERED = new Map<ConfigFormat, ConfigAdapter>();

/** The adapters this module ships.
 *
 *  Read inside a FUNCTION rather than at module scope on purpose:
 *  client-config-json.ts imports helpers from this file, so a top-level
 *  `const ADAPTERS = { json: JSON_ADAPTER }` here would throw a TDZ
 *  ReferenceError whenever the json module happened to be loaded first.
 *  Deferring the read to first call makes the import order irrelevant, which
 *  client-config-json.test.ts pins by importing that module first. */
function builtInAdapter(format: ConfigFormat): ConfigAdapter | undefined {
  if (format === "json") return JSON_ADAPTER;
  if (format === "jsonc") return JSONC_ADAPTER;
  return undefined;
}

/** Add the adapter for one format. Call it from the adapter's OWN module, at
 *  module scope, so importing that module is what makes the format usable.
 *
 *  Refuses a second adapter for a format that already has one: two readers of
 *  one syntax is the split this seam exists to prevent, and a second
 *  registration is far more likely to be a mistake than an upgrade. */
export function registerConfigAdapter(format: ConfigFormat, adapter: ConfigAdapter): void {
  if (builtInAdapter(format) !== undefined || REGISTERED.has(format)) {
    throw new Error(`a config adapter for "${format}" is already registered`);
  }
  REGISTERED.set(format, adapter);
}

/** True when `format` can be read and written in this build. */
export function hasConfigAdapter(format: ConfigFormat): boolean {
  return builtInAdapter(format) !== undefined || REGISTERED.has(format);
}

/** The adapter for `format`, or a MissingConfigAdapterError naming it. */
export function adapterFor(format: ConfigFormat): ConfigAdapter {
  const adapter = builtInAdapter(format) ?? REGISTERED.get(format);
  if (adapter === undefined) throw new MissingConfigAdapterError(format);
  return adapter;
}

/** TEST SEAM. Drops every adapter registered at runtime; the built-in JSON
 *  family is unaffected. Exists so a test can assert the
 *  no-adapter-for-this-format refusal after another test registered a stub for
 *  that same format. */
export function resetConfigAdapterRegistry(): void {
  REGISTERED.clear();
}

// ---------------------------------------------------------------------------
// Shared value helpers (every adapter uses these)
// ---------------------------------------------------------------------------

/** A JSON value rendered canonically: object keys sorted, `undefined`-valued
 *  keys dropped, no whitespace.
 *
 *  Two canonical strings are equal exactly when the two values are equal AS
 *  JSON -- the question install's idempotence check asks ("would writing this
 *  CHANGE what the client reads") and the question the post-write check asks
 *  of every untouched neighbour. Key order is deliberately not part of it: a
 *  hand-edited entry spelling its args before its command means what install's
 *  own spelling means, and rewriting the file to reorder two keys is churn
 *  with no behaviour behind it.
 *
 *  A BIGINT renders as its digits. `JSON.stringify` THROWS on one, and a
 *  throw here would surface as a raw TypeError out of a post-write check whose
 *  whole job is to refuse cleanly -- which is reachable the moment a syntax
 *  whose parser yields bigints for large integers is registered (the declared
 *  `"toml"` slot: smol-toml's `integersAsBigInt: "asNeeded"` returns one for an
 *  integer outside the double-safe range). Digits are also the right answer
 *  for the comparison this function serves: under `asNeeded` a value is a
 *  bigint only when it does NOT fit a number, so a bigint and a number that
 *  render alike differ in spelling and not in value.
 *
 *  A value JSON cannot represent at all (a function, a symbol, `undefined`)
 *  renders as `null`, the way JSON.stringify treats one inside an array. Those
 *  come from a caller, never from a parser; the fallback is there so this can
 *  never return `undefined` and make two unequal values compare equal. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** How to name a value's SHAPE in a message -- what is there instead of a
 *  container. Shape, never contents: such a value can be arbitrarily large,
 *  and the user needs to know which key is wrong rather than have it echoed
 *  back. */
export function describeValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  return `a ${typeof value}`;
}

/** `text` with exactly one final newline, never doubled.
 *
 *  A splice leaves the bytes outside its own span alone, so a file that did
 *  not end in a newline comes back without one. Every caller that WRITES
 *  terminates it -- POSIX tools and diffs both want the newline, and the file
 *  is being rewritten anyway.
 *
 *  Apply this to text you are about to write, never to a value you are
 *  comparing by identity: a no-op removal returns its input string itself, and
 *  terminating that would turn "nothing changed" into a phantom write. */
export function terminateWithNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The legacy entry key present among `keys`, or null.
 *
 *  Same list and same precedence as `findLegacyEntry` in install-targets.ts,
 *  over KEYS instead of an object, so it also answers for a syntax whose
 *  entries are not object members. */
export function findLegacyKey(keys: readonly string[]): string | null {
  return LEGACY_ENTRY_NAMES.find((name) => keys.includes(name)) ?? null;
}

// ---------------------------------------------------------------------------
// The view every consumer reads
// ---------------------------------------------------------------------------

export interface ClientConfigView {
  /** What the file is. */
  readonly read: ConfigRead;
  /** The bytes, or null when there is no file. */
  readonly raw: string | null;
  /** The address the entries were read at -- the one a write goes to. */
  readonly address: EntryAddress;
  /** Which of the candidate addresses that was: 0 unless the caller passed
   *  variants and a later one held the wiring. */
  readonly addressIndex: number;
  readonly adapter: ConfigAdapter;
  /** Every entry in the container, in file order. Empty for any read that is
   *  not `ok`. */
  entries(): readonly EntryView[];
  /** One entry by key (default: yaw-mcp's own). Defined whenever the KEY is
   *  present, whatever its value -- "has an entry" has always been key
   *  presence, and an entry whose value is a number is wired-and-broken, not
   *  absent. */
  entry(key?: string): EntryView | undefined;
  /** One entry's stored value as the target's `normalize` hook says every
   *  consumer should see it, or undefined when the key is absent.
   *
   *  This is the LEFT side of a drift comparison -- `EntryView.launch` answers
   *  "what would run", which is a strict subset, and the entry install is
   *  about to write carries fields beyond it. Reading it off the view rather
   *  than re-applying the hook at the callsite is what keeps the read and the
   *  comparison from normalising two different ways. */
  normalized(key?: string): unknown;
  /** The legacy key still in the container, or null. */
  legacyKey(): string | null;
  /** Other servers configured directly in this container: every key that is
   *  neither ours nor legacy and whose value is an object. */
  otherServerKeys(): string[];
  /** How many entries the container holds, ours and any legacy one included.
   *  0 for every read that is not `ok`. */
  count(): number;
  /** The env a rewrite would carry forward from one entry. */
  carryableEnv(key?: string): Record<string, string> | undefined;
  /** The client-owned fields a rewrite would carry forward from one entry. */
  carried(key?: string): Record<string, unknown>;
  /** Non-null when the client's own parser would reject this file. */
  unloadable(): StrictViolation | null;
}

export interface ClassifyOptions {
  transform?: EntryTransform;
  /** Container addresses to consider, in priority order, INSTEAD of the site's
   *  own path.
   *
   *  This is how Claude Code's drive-letter-case fold reaches the model: the
   *  caller passes the helper's paths (canonical first) and the view reports
   *  the first container that holds our wiring, falling back to the first that
   *  exists and then to the canonical one. Deciding WHICH spellings are
   *  equivalent stays in install-targets.ts, which owns that question; this
   *  only picks among the paths it was handed. */
  containerPaths?: readonly (readonly string[])[];
}

/** Classify one client config file's bytes. Sync, so doctor's probe can use
 *  it; `null` raw means the file does not exist. */
export function classifyClientConfig(
  raw: string | null,
  site: ConfigSite,
  opts: ClassifyOptions = {},
): ClientConfigView {
  const adapter = adapterFor(site.format);
  const candidates =
    opts.containerPaths !== undefined && opts.containerPaths.length > 0
      ? opts.containerPaths
      : [site.resolved.containerPath];
  const addressAt = (index: number): EntryAddress => ({ format: site.format, containerPath: candidates[index] });
  if (raw === null) return makeView({ kind: "absent" }, null, addressAt(0), 0, adapter, opts);

  let chosen = 0;
  let read = adapter.classify(raw, addressAt(0), opts.transform);
  if (candidates.length > 1) {
    // The first container holding our wiring wins outright; otherwise the
    // first that exists at all, so an empty canonical container still reads as
    // "present, no entry" rather than as "not configured".
    let bestWired = isWired(read);
    let bestPresent = read.kind === "ok" && read.containerPresent;
    for (let i = 1; !bestWired && i < candidates.length; i++) {
      const other = adapter.classify(raw, addressAt(i), opts.transform);
      const wired = isWired(other);
      const present = other.kind === "ok" && other.containerPresent;
      if (wired || (present && !bestPresent)) {
        chosen = i;
        read = other;
        bestWired = wired;
        bestPresent = present;
      }
    }
  }
  return makeView(read, raw, addressAt(chosen), chosen, adapter, opts);
}

function isWired(read: ConfigRead): boolean {
  if (read.kind !== "ok") return false;
  const keys = read.entries.map((e) => e.key);
  return keys.includes(ENTRY_NAME) || findLegacyKey(keys) !== null;
}

function makeView(
  read: ConfigRead,
  raw: string | null,
  address: EntryAddress,
  addressIndex: number,
  adapter: ConfigAdapter,
  opts: ClassifyOptions,
): ClientConfigView {
  const entries = read.kind === "ok" ? read.entries : [];
  const at = (key: string | undefined): EntryView | undefined => entries.find((e) => e.key === (key ?? ENTRY_NAME));
  return {
    read,
    raw,
    address,
    addressIndex,
    adapter,
    entries: () => entries,
    entry: (key?: string) => at(key),
    normalized: (key?: string) => {
      const found = at(key);
      return found === undefined ? undefined : normalizeEntry(found.value, opts.transform);
    },
    legacyKey: () => findLegacyKey(entries.map((e) => e.key)),
    otherServerKeys: () => {
      const skip = new Set<string>([ENTRY_NAME, ...LEGACY_ENTRY_NAMES]);
      return entries
        .filter((e) => !skip.has(e.key) && typeof e.value === "object" && e.value !== null && !Array.isArray(e.value))
        .map((e) => e.key);
    },
    count: () => entries.length,
    carryableEnv: (key?: string) => carryableEnvOf(at(key)?.value),
    carried: (key?: string) => carriedFieldsOf(at(key)?.value, opts.transform),
    unloadable: () => (read.kind === "ok" || read.kind === "blocked" ? read.unloadable : null),
  };
}

export interface ReadSeam {
  /** Reads the file's bytes. The seam doctor's probe already has, kept so its
   *  EBUSY and EISDIR tests keep working. */
  readFile?: (path: string) => Promise<string>;
}

/** Read and classify one site's file, owning the IO.
 *
 *  ENOENT is `absent`, not an error: a client that has never been configured
 *  has no file, and that is the ordinary case. Every other errno is
 *  `unreadable` WITH its code, so a caller can tell a directory at the path
 *  (EISDIR) or an AV scanner holding the handle (EBUSY) from a syntax error
 *  the user would otherwise be sent to fix. */
export async function readClientConfigFile(
  site: ConfigSite,
  opts: ClassifyOptions & ReadSeam = {},
): Promise<ClientConfigView> {
  const load = opts.readFile ?? ((path: string) => readFile(path, "utf8"));
  let raw: string;
  try {
    raw = await load(site.resolved.absolute);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return classifyClientConfig(null, site, opts);
    const read: ConfigRead = {
      kind: "unreadable",
      code: typeof code === "string" ? code : null,
      message: err instanceof Error ? err.message : String(err),
    };
    return makeView(read, null, addressOf(site), 0, adapterFor(site.format), opts);
  }
  return classifyClientConfig(raw, site, opts);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type ClientConfigEdit =
  | { op: "upsert"; key: string; entry: Record<string, unknown> }
  | { op: "remove"; key: string }
  | { op: "repair"; path: readonly string[] };

/** A write that was refused. Nothing has been written when this is thrown:
 *  `applyClientConfigEdits` returns TEXT, so a refusal simply means the caller
 *  has nothing to persist, and every caller already turns a splice failure
 *  into a "Refusing to overwrite" line and exit 1. */
export class ClientConfigWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigWriteError";
  }
}

/** Apply `edits` to the view's text, one at a time against the running text,
 *  and return the new text -- AFTER verifying it.
 *
 *  This is the only exported way to obtain edited client-config text, which is
 *  what makes the verification unskippable: an adapter's `upsert` / `remove` /
 *  `repairContainer` is reached through here. The caller still does its own IO
 *  (install re-checks the file's fingerprint between read and write; try
 *  writes with a tightened mode), so the write itself stays where it is.
 *
 *  What it refuses before touching anything:
 *    * any read that is not `ok` -- malformed, unreadable, unspliceable, or
 *      blocked without a `repair` edit for the blocked key;
 *    * an upsert or a repair into a file the CLIENT cannot load (strict JSON
 *      carrying a comment or a trailing comma). A remove is still allowed
 *      there: taking our entry out of a file the client skips is correct, and
 *      refusing it would leave the user unable to uninstall.
 *
 *  What it verifies after:
 *    1. the result classifies `ok`, and is no less loadable than the input;
 *    2. every entry no edit named keeps its value AND its relative order;
 *    3. every upserted key reads back equal, and every removed key is gone;
 *    4. the rest of the document -- everything but the entries the edits named
 *       -- is unchanged.
 *
 *  The cost is one extra parse per write. What it buys is that a bug in a
 *  splicer refuses the write instead of corrupting the user's config. */
export function applyClientConfigEdits(
  view: ClientConfigView,
  edits: readonly ClientConfigEdit[],
  site?: { resolved: Pick<ResolvedPath, "absolute"> },
): string {
  if (edits.length === 0) throw new ClientConfigWriteError("applyClientConfigEdits: no edits to apply");
  const where = site === undefined ? "the config file" : site.resolved.absolute;
  const { adapter, address, read } = view;
  const writes = edits.some((edit) => edit.op !== "remove");

  if (read.kind === "absent") {
    const only = edits[0];
    if (edits.length !== 1 || only.op !== "upsert") {
      throw new ClientConfigWriteError(
        `${where} does not exist, so there is nothing in it to ${only.op === "remove" ? "remove" : "repair"}`,
      );
    }
    let fresh: string;
    try {
      fresh = adapter.upsert(null, address, only.key, only.entry);
    } catch (err) {
      throw new ClientConfigWriteError(
        `${where} could not be created (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    verifyEdits(adapter, address, null, fresh, edits, where, view);
    return fresh;
  }
  if (read.kind === "blocked") {
    // A blocked container is editable only with a `repair` edit naming that
    // exact key, and only when replacing it throws nothing away. The repair
    // has to come FIRST -- a splice into a key that still holds a non-object
    // is what the repair exists to prevent.
    const repair = edits.find((edit) => edit.op === "repair" && sameSegments(edit.path, read.path));
    if (repair === undefined || !read.reparable || edits[0] !== repair) {
      throw new ClientConfigWriteError(refusalFor(read, where, edits));
    }
  } else if (read.kind !== "ok") {
    throw new ClientConfigWriteError(refusalFor(read, where, edits));
  }
  const unloadable = view.unloadable();
  if (unloadable !== null && writes) {
    throw new ClientConfigWriteError(
      `${where} has comments or trailing commas, which its client reads as invalid ${unloadable.syntax} ` +
        `(${unloadable.detail}), so no server in it is loading -- refusing to write into it`,
    );
  }

  const before = view.raw;
  if (before === null) throw new ClientConfigWriteError(`${where} was classified without its bytes`);
  // One edit at a time, each against the RESULT of the last: every splice
  // computes its offsets against the text it is handed, so two edits applied
  // to the same input would each drop the other's change.
  //
  // A splicer that refuses becomes a ClientConfigWriteError like every other
  // refusal, so a caller has exactly one error type to handle and its message
  // still carries the splicer's own words.
  let text = before;
  try {
    for (const edit of edits) {
      if (edit.op === "upsert") text = adapter.upsert(text, address, edit.key, edit.entry);
      else if (edit.op === "remove") text = adapter.remove(text, address, edit.key);
      else text = adapter.repairContainer(text, address, edit.path);
    }
  } catch (err) {
    if (err instanceof ClientConfigWriteError) throw err;
    throw new ClientConfigWriteError(
      `${where} could not be edited (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  verifyEdits(adapter, address, before, text, edits, where, view);
  return text;
}

function refusalFor(read: ConfigRead, where: string, edits: readonly ClientConfigEdit[]): string {
  if (read.kind === "unreadable") return `${where} could not be read (${read.message})`;
  if (read.kind === "malformed") {
    const at = read.position === null ? "" : ` at line ${read.position.line} column ${read.position.column}`;
    return read.reason === "root"
      ? `${where} is not a ${read.syntax} object (it is ${read.detail})`
      : `${where} is not valid ${read.syntax}${at} (${read.detail})`;
  }
  if (read.kind === "unspliceable") {
    return `the "${read.key}" entry in ${where} is ${read.reason}, so yaw-mcp will not edit it`;
  }
  if (read.kind === "blocked") {
    const key = read.path.join(".");
    const repaired = edits.some((edit) => edit.op === "repair" && sameSegments(edit.path, read.path));
    if (repaired && read.reparable) {
      return `"${key}" in ${where} is ${read.shape}: its repair has to be the FIRST edit, before anything is spliced in`;
    }
    return read.reparable
      ? `"${key}" in ${where} is ${read.shape}, not an object -- it has to be repaired before an entry can be written`
      : `"${key}" in ${where} is ${read.shape}, not an object -- refusing to overwrite it`;
  }
  return `${where} cannot be edited`;
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

function verifyEdits(
  adapter: ConfigAdapter,
  address: EntryAddress,
  before: string | null,
  after: string,
  edits: readonly ClientConfigEdit[],
  where: string,
  view: ClientConfigView,
): void {
  const touched = new Set<string>();
  for (const edit of edits) {
    if (edit.op !== "repair") touched.add(edit.key);
  }
  const reread = adapter.classify(after, address, undefined);
  if (reread.kind !== "ok") {
    throw new ClientConfigWriteError(
      `writing to ${where} would have produced a file yaw-mcp cannot read back (${reread.kind}) -- nothing was written`,
    );
  }
  if (reread.unloadable !== null && view.unloadable() === null) {
    throw new ClientConfigWriteError(
      `writing to ${where} would have produced a file its client cannot load ` +
        `(${reread.unloadable.detail}) -- nothing was written`,
    );
  }

  const keptBefore = view.entries().filter((e) => !touched.has(e.key));
  const keptAfter = reread.entries.filter((e) => !touched.has(e.key));
  if (keptAfter.map((e) => e.key).join(" ") !== keptBefore.map((e) => e.key).join(" ")) {
    throw new ClientConfigWriteError(
      `writing to ${where} would have changed which other servers it holds, or their order -- nothing was written`,
    );
  }
  for (let i = 0; i < keptBefore.length; i++) {
    if (canonicalJson(keptBefore[i].value) !== canonicalJson(keptAfter[i].value)) {
      throw new ClientConfigWriteError(
        `writing to ${where} would have changed the "${keptBefore[i].key}" entry beside it -- nothing was written`,
      );
    }
  }

  for (const edit of edits) {
    if (edit.op === "upsert") {
      const written = reread.entries.find((e) => e.key === edit.key);
      if (written === undefined || canonicalJson(written.value) !== canonicalJson(edit.entry)) {
        throw new ClientConfigWriteError(
          `the "${edit.key}" entry did not read back from ${where} as it was written -- nothing was written`,
        );
      }
    } else if (edit.op === "remove" && reread.entries.some((e) => e.key === edit.key)) {
      throw new ClientConfigWriteError(
        `the "${edit.key}" entry is still in ${where} after removing it -- nothing was written`,
      );
    }
  }

  if (before !== null) {
    // A repair replaces the container, and an upsert into a file that had none
    // creates it, so on those two paths the container itself is what the edit
    // was about -- comparing it would fail a change the caller asked for. Every
    // other path compares the container minus the entries the edits named.
    const containerChanged =
      edits.some((edit) => edit.op === "repair") || (view.read.kind === "ok" && !view.read.containerPresent);
    const opts = containerChanged ? { dropContainer: true } : { drop: [...touched] };
    if (adapter.canon(before, address, opts) !== adapter.canon(after, address, opts)) {
      throw new ClientConfigWriteError(
        `writing to ${where} would have changed other settings in the file -- nothing was written`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The one reader of the env vars that relocate a client config
// ---------------------------------------------------------------------------

/** Every environment variable that moves a client's config file, as DATA, so a
 *  test can assert the CLI's Environment help block names all of them.
 *
 *  Before this, `CLAUDE_CONFIG_DIR` was read in six hand-rolled places in
 *  src/. Adding more variables to six sites is exactly the one-adopter trap
 *  that makes a client honour an override in `install` and ignore it in
 *  `doctor`. */
export const CLIENT_ENV_VARS = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLINE_DATA_DIR",
  "CLINE_DIR",
  "CLINE_MCP_SETTINGS_PATH",
  "CODEX_HOME",
  "CONTINUE_GLOBAL_DIR",
  "XDG_CONFIG_HOME",
] as const;

/** The overrides one environment carries. A variable that is unset -- or set
 *  to the empty string -- is ABSENT here, never present-and-empty. */
export interface ClientEnv {
  /** Windows `%APPDATA%`. Already honoured by `resolveAppDataDir`; read here
   *  too so one call answers for every client. */
  appData?: string;
  /** Claude Code: moves BOTH `.claude.json` and `settings.json` into that
   *  directory. */
  claudeConfigDir?: string;
  clineDataDir?: string;
  clineDir?: string;
  clineMcpSettingsPath?: string;
  /** Codex: the directory its `config.toml` lives in. */
  codexHome?: string;
  continueGlobalDir?: string;
  /** XDG config root. Reported VERBATIM: whether a relative value is usable is
   *  the resolver's call -- each client's own resolver is the reference for
   *  its files -- and a reader that silently dropped one would make "why is my
   *  XDG_CONFIG_HOME ignored" invisible. */
  xdgConfigHome?: string;
}

/** Read every client-config override from one environment.
 *
 *  THE one place this module touches `process.env`, via the default argument;
 *  every other function takes what it needs as a parameter. An EMPTY string
 *  counts as UNSET, the rule `resolveAppDataDir` already follows: an
 *  empty-but-set `%APPDATA%` is ordinary on Windows and in CI, and passing it
 *  through once made every Claude Desktop path relative, which doctor then
 *  stat-ed against the process cwd. */
export function readClientEnv(env: NodeJS.ProcessEnv = process.env): ClientEnv {
  const value = (name: (typeof CLIENT_ENV_VARS)[number]): string | undefined => {
    const raw = env[name];
    return raw !== undefined && raw.length > 0 ? raw : undefined;
  };
  const out: ClientEnv = {};
  const appData = value("APPDATA");
  if (appData !== undefined) out.appData = appData;
  const claudeConfigDir = value("CLAUDE_CONFIG_DIR");
  if (claudeConfigDir !== undefined) out.claudeConfigDir = claudeConfigDir;
  const clineDataDir = value("CLINE_DATA_DIR");
  if (clineDataDir !== undefined) out.clineDataDir = clineDataDir;
  const clineDir = value("CLINE_DIR");
  if (clineDir !== undefined) out.clineDir = clineDir;
  const clineMcpSettingsPath = value("CLINE_MCP_SETTINGS_PATH");
  if (clineMcpSettingsPath !== undefined) out.clineMcpSettingsPath = clineMcpSettingsPath;
  const codexHome = value("CODEX_HOME");
  if (codexHome !== undefined) out.codexHome = codexHome;
  const continueGlobalDir = value("CONTINUE_GLOBAL_DIR");
  if (continueGlobalDir !== undefined) out.continueGlobalDir = continueGlobalDir;
  const xdgConfigHome = value("XDG_CONFIG_HOME");
  if (xdgConfigHome !== undefined) out.xdgConfigHome = xdgConfigHome;
  return out;
}
