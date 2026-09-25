// `yaw-mcp import <client>` -- adopt the MCP servers an AI client already has
// into ~/.yaw-mcp/bundles.json.
//
// THE CLIFF THIS EXISTS FOR. Somebody with six servers already configured in
// Claude Code installs yaw-mcp, opens it, and is told they have none. Every
// one of those servers is sitting in a JSON file yaw-mcp can read, in a shape
// yaw-mcp already understands -- and the only way across was to retype them
// one `yaw-mcp add` at a time, from a catalog that may not even list them.
//
// WHAT WAS RECOVERED, AND FROM WHERE. A cloud-backed `mcp_connect_import`
// meta-tool shipped and was deleted in 5b70f50 ("a local-backed install tool
// may return later"), and the expensive part of it was the client-config
// PARSING, which is recovered here: the `mcpServers`-must-be-a-plain-object
// check, the skip-ourselves rule, the per-key namespace derivation, and the
// namespace-collision report. Three things deliberately did NOT come back:
//   * Its BASENAME ALLOWLIST, which existed because the old tool took an
//     arbitrary `filepath` from the model and had to stop it reading
//     /etc/passwd. This command takes a CLIENT, and the path comes from
//     INSTALL_TARGETS, so there is no caller-supplied path to constrain.
//   * Its `sanitizeNamespace`, which mapped punctuation to underscores and
//     could return "" or a digit-leading string -- both of which NAMESPACE_RE
//     rejects, so the entry would have been dropped at load. deriveNamespace
//     (the one `add` uses) is used instead: it strips punctuation, prefixes a
//     letter, and always produces something the loader accepts.
//   * Its refusal to carry `env` across. That rule was about not TRANSMITTING
//     credentials to a hosted backend; nothing is transmitted here, and an
//     import that dropped the env would produce servers that cannot start.
//     The keys are named in the transcript (never the values) with a pointer
//     at the vault.
//
// THE SECOND TRAP: THE ORIGINAL KEEPS LOADING. Importing a server does not
// unwire it from the client, so afterwards the client launches it BOTH
// directly and through yaw-mcp -- two copies of every server, and for a stdio
// server two child processes. So the flow offers to remove the originals, and
// the offer has exactly three answers: a prompt on a TTY (defaulting to NO),
// `--remove-originals`, or `--keep-originals`. Off a TTY with no flag the
// originals STAY -- silently unwiring somebody's working client config is a
// worse outcome than running a server twice. And the removal is REFUSED
// outright when the client has no yaw-mcp entry of its own, because then the
// imported servers would be reachable from nowhere at all. `--dry-run` beside
// `--remove-originals` previews that removal -- the file, and every key a real
// run would take out of it or the reason it would take out none -- through the
// same search and the same splice the real run uses.
//
// THE THIRD TRAP: THE CLIENT CONFIG IS THE OTHER COPY. Every line below that
// removes something, or overwrites something, exists because the two files
// disagree about what is stored and the user only ever sees one of them:
//   * A candidate counts as IMPORTED only when its entry actually OWNS a
//     namespace in bundles.json at the end of the run. Two client keys can
//     derive one namespace and only the last writer survives -- and removing
//     BOTH from the client config deleted the loser from both sides at once.
//   * A write that lands on an entry bundles.json ALREADY holds is reported
//     with the launch it replaces, before anything is written. An imported
//     entry carries no catalog slug, so upsertUserBundle's cross-slug refusal
//     cannot fire for it and every match MERGES, with the client entry
//     winning. A silent launch-command swap is how an import turns into
//     arbitrary command execution on the next activate. So a merge that would
//     CHANGE the stored entry is not written without an answer, as install's
//     own entry is not: a prompt on a TTY ([o]verwrite / [s]kip / [a]bort,
//     default skip), `--force`, or -- off a TTY with neither -- exit 2 with
//     nothing written at all. A match the merge would leave as it is is not a
//     collision and is not asked about.
//   * The plan prints the namespace the file will actually hold, which is not
//     always the derived one: a stored entry matched by NAME keeps its own.
//   * A `${...}` the client expands itself is expanded here, or the server is
//     refused BY NAME. yaw-mcp does not expand them at spawn, so importing one
//     verbatim produces an entry that cannot work while looking imported.
//   * Nothing is dropped in silence: an `env` / `headers` shape the loader
//     would refuse is named (key names only), and one un-removable key never
//     aborts the removal of the others.

import { homedir } from "node:os";
import { basename, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { clientChoices, resolveClientArg } from "./client-aliases.js";
import {
  applyClientConfigEdits,
  type ClientConfigEdit,
  type ClientConfigView,
  type ConfigSite,
  classifyClientConfig,
  containerKeysAt,
  containerNounFor,
  type EntryTransform,
  importViewOf,
  readClientConfigFile,
  siteAt,
  terminateWithNewline,
  unloadableConfigProblem,
} from "./client-config.js";
import { deepEqualJson, describeEntryDiff, resolveInstallSite } from "./install-cmd.js";
import {
  blockedContainerFix,
  type ClientEnvValues,
  claudeCodeContainerPathVariants,
  ENTRY_NAME,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  LEGACY_ENTRY_NAMES,
  resolveAppDataDir,
  resolveInstallSites,
  unloadableConfigFix,
  unparseableConfigFix,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import {
  deriveNamespace,
  type LaunchShape,
  localBundlesPath,
  previewUpsertUserBundle,
  upsertUserBundle,
} from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { userConfigDir } from "./paths.js";
import { askYesNo, QUESTION_CANCELLED, questionOrEmpty } from "./readline-question.js";
import { displayArg, displaySafe } from "./trust-cmd.js";
import { TRIAL_ENTRY_PREFIX } from "./try-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

export const IMPORT_USAGE = `Usage: yaw-mcp import <client> [flags]

  Read the MCP servers a client already has configured and add them to your
  local ~/.yaw-mcp/bundles.json, so yaw-mcp serves the servers you already had
  instead of starting empty.

  <client> is one of: ${clientChoices("import").join(", ")}.

  yaw-mcp's own entry is never imported, under any of its names. Each server's
  command, args, url, headers and env come across as they are -- an import that
  dropped the env would produce servers that cannot start -- so a credential
  sitting in your client config lands in bundles.json (file mode 0600). Move it
  into the vault afterwards with \`yaw-mcp secrets set NAME\` and
  \`yaw-mcp set <server> env.KEY='\${secret:NAME}'\`.

  A server already in bundles.json is MERGED, with the client's copy winning,
  so the plan names every entry that would be replaced and shows the launch
  command it would replace. When the merge would change the stored entry, a
  terminal run asks first -- [o]verwrite, [s]kip or [a]bort, and a bare Enter
  skips that server -- and a run off one writes nothing and exits 2 unless you
  pass --force. A stored entry the merge would leave as it is is not asked
  about. A VS Code server written with a \${input:...} or
  \${env:...} variable is skipped by name: VS Code expands those itself and
  yaw-mcp does not, so importing one would produce a server that cannot start.

  AFTER AN IMPORT THE CLIENT STILL LAUNCHES THOSE SERVERS ITSELF, so you would
  be running each of them twice -- once directly, once through yaw-mcp. This
  command offers to remove the originals from the client config. On a terminal
  it asks (a bare Enter is NO); off one it leaves them alone and tells you the
  flag. It refuses to remove them at all if the client has no yaw-mcp entry in
  any of the config files it reads, since that is the only way it would still
  reach them.

Flags:
  --scope <s>          user | project | local, for clients that have more than
                       one config file. Defaults to the client's user scope.
  --project-dir <dir>  Project root for a project/workspace scope
                       (default: the current directory).
  --dry-run            Show what would be imported -- and, with
                       --remove-originals, which client entries would be
                       removed. Writes nothing.
  --remove-originals   Remove the imported entries from the client config
                       without asking.
  --keep-originals     Leave the client config alone without asking.
  --force              Overwrite a bundles.json entry the import would change
                       without asking.`;

export interface ImportCommandOptions {
  clientId?: InstallClientId;
  scope?: InstallScope;
  projectDir?: string;
  os?: InstallOS;
  dryRun?: boolean;
  removeOriginals?: boolean;
  keepOriginals?: boolean;
  /** Overwrite every bundles.json entry the import would change, without
   *  asking -- the only way past that question off a TTY. */
  force?: boolean;
  home?: string;
  cwd?: string;
  appData?: string;
  claudeConfigDir?: string;
  /** Every client env var, as `readClientEnv` reported it, threaded from the
   *  dispatcher. Only a MODULAR row reads it (Zed's $XDG_CONFIG_HOME, Cline's
   *  three knobs, Continue's global dir); the six inline rows take their one
   *  variable from `claudeConfigDir` above. Read by the dispatcher and never
   *  here, so a test that calls this runner directly stays hermetic. */
  clientEnv?: ClientEnvValues;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the removal prompt without a real TTY read. It does
   *  NOT answer the bundles.json overwrite question, which reads `io`. */
  promptAnswer?: string;
  /** The streams both questions are asked on; process.stdin / process.stdout
   *  when absent. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; terminal?: boolean };
}

export interface ImportCommandResult {
  exitCode: number;
  /** Files actually written -- bundles.json, and the client config when the
   *  originals were removed. Empty under --dry-run. */
  written: string[];
}

/** Entry keys that are yaw-mcp itself and must never be imported. Importing
 *  the broker into its own server list makes yaw-mcp spawn yaw-mcp, which
 *  spawns yaw-mcp. The current key is ENTRY_NAME; the legacy ones are still on
 *  disk in upgraded installs; the old cloud-era import also skipped
 *  "mcp-connect", which no installer of ours ever wrote but which a very old
 *  hand-written config can carry -- it is kept for that reason alone. Trial
 *  entries (`yaw-mcp-try-<slug>`) are excluded separately, by PREFIX: they are
 *  deliberately temporary and doctor garbage-collects them. */
const SELF_ENTRY_NAMES: ReadonlySet<string> = new Set([ENTRY_NAME, ...LEGACY_ENTRY_NAMES, "mcp-connect"]);

function isSelfEntry(key: string): boolean {
  return SELF_ENTRY_NAMES.has(key) || key.startsWith(TRIAL_ENTRY_PREFIX);
}

/** One server read out of a client config, before it becomes a bundles entry. */
interface ImportCandidate {
  /** The key as it appears in the client config -- the name the user knows. */
  key: string;
  /** The namespace DERIVED from the key. What the file will actually hold is
   *  `plannedNamespace` below, which is not always the same thing. */
  namespace: string;
  entry: Partial<UpstreamServerConfig>;
  /** env / header key NAMES for the transcript. Never their values. */
  credentialKeys: string[];
  /** Loader-worded notes about what a malformed `env` / `headers` lost, key
   *  NAMES only. Empty for the overwhelmingly common well-formed case. */
  discarded: string[];
  /** The namespace upsertUserBundle would actually write, from
   *  previewUpsertUserBundle: a stored entry matched by NAME keeps its own
   *  namespace, so this is not always `namespace`. Falls back to the derived
   *  one when the preview could not be taken. */
  plannedNamespace: string;
  /** The launch shape of the entry already in bundles.json that this write
   *  would fold onto, when there is one. */
  replacing?: LaunchShape;
  /** What this write would CHANGE in that stored entry, one line per
   *  difference (storedEntryChanges). Absent when there is no stored entry,
   *  when the merge would leave it as it is, or when the write could not be
   *  previewed -- and only a present one is asked about. */
  changes?: string[];
}

/** A raw `env` / `headers` block from a client config, reduced to the
 *  string-valued entries the loader would honour PLUS what had to be thrown
 *  away. The survivors alone are not enough: a hand-edited `"env": "FOO=bar"`
 *  and a `"PORT": 8080` both vanished with no plan line, no carries line and
 *  no warning, while the LOADER warns for both shapes (local-bundles.ts
 *  validateEntry) and `yaw-mcp set` refuses them outright. Key NAMES only --
 *  a client config is where the credentials are. */
interface RawMapField {
  /** The string-valued entries, or undefined when none survived. */
  map?: Record<string, string>;
  /** The field was PRESENT but was not a plain object, so all of it is gone. */
  shapeless: boolean;
  /** Keys dropped because their value was not a string. */
  droppedKeys: string[];
}

function readStringMap(raw: unknown): RawMapField {
  if (raw === undefined) return { shapeless: false, droppedKeys: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { shapeless: true, droppedKeys: [] };
  const out: Record<string, string> = {};
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else droppedKeys.push(k);
  }
  return { map: Object.keys(out).length > 0 ? out : undefined, shapeless: false, droppedKeys };
}

/** What a malformed `env` / `headers` cost this entry, worded like the
 *  loader's own warnings so the two surfaces read as one voice. A `null` is a
 *  shapeless value, not an absent one -- validateEntry warns for it too. */
function discardNotes(field: "env" | "headers", key: string, f: RawMapField): string[] {
  const on = `on "${displaySafe(key)}"`;
  const notes: string[] = [];
  if (f.shapeless) {
    notes.push(
      field === "env"
        ? `ignoring 'env' ${on} (expected an object of string values) -- the server will start with none of its variables set`
        : `ignoring 'headers' ${on} (expected an object of string values)`,
    );
  }
  for (const k of f.droppedKeys) {
    notes.push(
      field === "env"
        ? `ignoring env "${displaySafe(k)}" ${on} (expected a string value)`
        : `ignoring header "${displaySafe(k)}" ${on} (expected a string value)`,
    );
  }
  return notes;
}

/** The values a `${...}` span can be resolved against at import time. */
interface ClientVars {
  /** The workspace folder, or undefined at a scope that resolves none (VS
   *  Code's user-profile mcp.json belongs to no workspace at all). */
  workspaceFolder?: string;
}

/**
 * Expand the `${...}` spans that are knowable FROM HERE, and record the ones
 * that are not.
 *
 * VS Code expands these itself before it launches anything; yaw-mcp does not,
 * so a span copied across verbatim reaches the child process as the literal
 * text and the server cannot work -- which is worse than not importing it,
 * because it looks imported.
 *
 * Expanded: `${workspaceFolder}` and `${workspaceFolderBasename}`, and only at
 * a scope that actually resolved a project directory.
 *
 * NOT expanded, deliberately:
 *   * `${input:<id>}` -- the file's `inputs` block DECLARES it, but the value
 *     lives in VS Code's prompt / secret storage and is never in the file.
 *   * `${env:VAR}` -- the value is deliberately not in the file either, and
 *     resolving it here would copy a credential out of the environment into
 *     bundles.json, which is the opposite of what writing it that way asked
 *     for. yaw-mcp's channel for that is the vault (`${secret:NAME}`).
 *   * anything else, which is a variable this importer does not know.
 * Any of those makes the whole server UNRESOLVED: it is refused by name rather
 * than imported broken.
 *
 * `${secret:NAME}` is left alone and is NOT unresolved -- that is yaw-mcp's own
 * reference, resolved against the vault at spawn (secrets-vault.ts), so a
 * hand-written one in a client config still means here what it says.
 */
function expandClientVars(s: string, vars: ClientVars, unresolved: Set<string>): string {
  return s.replace(/\$\{[^{}]*\}/g, (span) => {
    const name = span.slice(2, -1);
    if (name.startsWith("secret:")) return span;
    if (vars.workspaceFolder !== undefined) {
      if (name === "workspaceFolder") return vars.workspaceFolder;
      if (name === "workspaceFolderBasename") return basename(vars.workspaceFolder);
    }
    unresolved.add(span);
    return span;
  });
}

/** One server the import built, or refused to build. */
interface BuiltEntry {
  entry: Partial<UpstreamServerConfig>;
  credentialKeys: string[];
  discarded: string[];
  /** `${...}` spans this importer cannot resolve. Non-empty means the server is
   *  skipped rather than imported. */
  unresolved: string[];
}

/**
 * Turn one client-config entry into the bundles.json entry it corresponds to.
 * Returns null for a value that is not an object at all (a hand-edit artifact)
 * or that describes neither a command nor a url -- there is nothing to launch.
 *
 * The local/remote split is the same predicate the loader applies: a `url`
 * with no `command` is remote, everything else is local. VS Code additionally
 * writes a `type` of "stdio" | "http" | "sse" on its entries; where it names a
 * remote transport it is carried into `transport`, because that is the one
 * thing a url alone does not say (SSE and streamable-HTTP are different wire
 * protocols and yaw-mcp defaults to the latter).
 *
 * `vars` is null for a client whose expansion rules this command does not
 * know, and then nothing is interpreted at all. Guessing one would refuse
 * strings that work today, so only the client whose own file DECLARES its
 * variables -- VS Code, via the `inputs` block in that same mcp.json -- gets
 * the treatment.
 */
function toEntry(key: string, value: unknown, vars: ClientVars | null): BuiltEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const unresolved = new Set<string>();
  const expand = (s: string): string => (vars === null ? s : expandClientVars(s, vars, unresolved));
  const expandMap = (m: Record<string, string> | undefined): Record<string, string> | undefined =>
    m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, val]) => [k, expand(val)]));

  const command = typeof v.command === "string" && v.command.trim() !== "" ? expand(v.command) : undefined;
  const url = typeof v.url === "string" && v.url.trim() !== "" ? expand(v.url) : undefined;
  if (!command && !url) return null;

  const namespace = deriveNamespace(key);
  const base: Partial<UpstreamServerConfig> = {
    id: `local-${namespace}`,
    name: key,
    namespace,
    isActive: true,
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };

  if (!command && url) {
    const rawHeaders = readStringMap(v.headers);
    const headers = expandMap(rawHeaders.map);
    // VS Code's `"type": "sse"`. Anything else (including "http") takes
    // yaw-mcp's own streamable-http default, which validateEntry applies when
    // the field is absent -- so it is left absent rather than being stamped,
    // keeping the entry the shortest true description of itself.
    const transport = v.type === "sse" ? ("sse" as const) : undefined;
    return {
      entry: { ...base, type: "remote", url, ...(transport ? { transport } : {}), ...(headers ? { headers } : {}) },
      credentialKeys: Object.keys(headers ?? {}),
      discarded: discardNotes("headers", key, rawHeaders),
      unresolved: [...unresolved],
    };
  }

  const args = Array.isArray(v.args)
    ? v.args.filter((a): a is string => typeof a === "string").map((a) => expand(a))
    : undefined;
  const rawEnv = readStringMap(v.env);
  const env = expandMap(rawEnv.map);
  return {
    entry: {
      ...base,
      type: "local",
      transport: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    },
    credentialKeys: Object.keys(env ?? {}),
    discarded: discardNotes("env", key, rawEnv),
    unresolved: [...unresolved],
  };
}

/** `${input:<id>}` declarations from a VS Code mcp.json, id -> description.
 *  VS Code PROMPTS for these (or reads them back out of its own secret storage
 *  when `"password": true`), so the value is never in the file and an import
 *  can only name what it would need. Reading the block is what lets the
 *  refusal say WHICH value VS Code would ask for, and tells a declared input
 *  apart from a typo that is broken in VS Code too.
 *
 *  THE ONE parse of a client config left in this file, and the reason it is
 *  not routed through the client-config core: `inputs` is not a server
 *  container. It is a document-level ARRAY of variable declarations that only
 *  VS Code writes, and the core models entry MAPS -- asking it for the keys at
 *  `["inputs"]` would report an array as a blocked container, which is neither
 *  true nor useful here. The vscode row declares `hooks.importVariables:
 *  "vscode-inputs"` for the handler that will own this; until that handler
 *  exists, the parse stays here, reaching for nothing but `inputs`, and is
 *  allow-listed by name in the boundary scan. Unparseable bytes yield no
 *  declarations rather than throwing: the caller has already classified the
 *  file through the core and would not be here if it did not parse. */
function readVsCodeInputs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  const inputs = (parsed as Record<string, unknown>).inputs;
  if (!Array.isArray(inputs)) return out;
  for (const item of inputs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") continue;
    out.set(r.id, typeof r.description === "string" ? r.description : "");
  }
  return out;
}

/** The unresolvable spans of one server, for the skip line. The SPAN only --
 *  never the string it sat in, which is where a credential would be. */
function describeUnresolved(spans: string[], inputs: Map<string, string>): string {
  return spans
    .map((span) => {
      const name = span.slice(2, -1);
      const description = name.startsWith("input:") ? inputs.get(name.slice("input:".length)) : undefined;
      return description ? `${displaySafe(span)} (${displaySafe(description)})` : displaySafe(span);
    })
    .join(", ");
}

/** One launch shape as a terminal line -- the same two forms the candidate
 *  list prints, so the "was" line of a replacement reads like the entry above
 *  it. */
function renderLaunch(shape: LaunchShape): string {
  if (shape.command !== undefined && shape.command !== "") {
    return `$ ${[shape.command, ...(shape.args ?? [])].map(displayArg).join(" ")}`;
  }
  return shape.url ? `HTTP ${displaySafe(shape.url)}` : "(no launch command)";
}

/** previewUpsertUserBundle's answer for one candidate. */
type UpsertPreview = Awaited<ReturnType<typeof previewUpsertUserBundle>>;

/**
 * What an import's write would change in the entry bundles.json already holds,
 * one line per difference -- or null when the merge would leave that entry as
 * it is, which is not a collision and is not asked about. Called only for a
 * preview that found a stored entry.
 *
 * `preview.entry` is the MERGED entry the write would land. The entry it folds
 * onto is read back through the same call: an upsert carrying nothing but the
 * stored entry's own namespace matches that entry and sets no other field, so
 * what it would land is the stored entry. That keeps bundles.json's reader and
 * the upsert's two-pass lookup in local-bundles.ts rather than restating either
 * here. A read-back that lands on an entry with a different launch from the
 * one `preview` reported replacing is treated as unreadable.
 *
 * The read-back is the stored entry AS A MERGE NORMALIZES IT: a blank or
 * non-string env value and an empty optionalEnvKeys come out dropped. This
 * write drops them too unless the client's entry names that env key, so a
 * write whose only effect is that normalization is not asked about, and an env
 * key the client names over a blank stored value is described as added rather
 * than changed -- even when the client's value is blank too and the write
 * would change nothing, which asks one question more than it needs to.
 *
 * "Differs" is install's own test and wording -- deepEqualJson and
 * describeEntryDiff -- so key order is not a difference, and only command and
 * args are shown with their values: env is named by key, anything else by
 * field name. Each line goes through displaySafe, since bundles.json is a
 * hand-editable file.
 *
 * Never throws. A read-back that throws, finds no entry, or lands on another
 * launch answers with a line saying so, which still counts as a change: the
 * cost is a question that did not need asking, never an overwrite made
 * without one.
 */
async function storedEntryChanges(
  preview: UpsertPreview,
  home: string,
  warnOnce: (w: string) => void,
): Promise<string[] | null> {
  const unreadable = ["the stored entry could not be read back to compare, so it is treated as changed"];
  if (preview.namespace === undefined) return unreadable;
  try {
    const stored = await previewUpsertUserBundle({ namespace: preview.namespace }, { home });
    for (const w of stored.warnings) warnOnce(w);
    if (!stored.replaced || JSON.stringify(stored.replacing) !== JSON.stringify(preview.replacing)) return unreadable;
    if (deepEqualJson(stored.entry, preview.entry)) return null;
    return describeEntryDiff(stored.entry, preview.entry).map(displaySafe);
  } catch {
    return unreadable;
  }
}

/** Diff lines under a common indent, built outside the template literals that
 *  print them. */
function indentLines(lines: readonly string[], indent: string): string {
  return lines.map((l) => `${indent}${l}`).join("\n");
}

/** Every answer to the bundles.json overwrite question, or the answer that
 *  stopped the asking. */
type CollisionAnswers = Map<ImportCandidate, "overwrite" | "skip"> | "abort" | "cancelled";

/**
 * Ask about each entry this import would change, in plan order, before
 * anything is written. install's promptCollision, once per entry: the same
 * three answers and the same `(default: skip)`, with EOF read as that default
 * and Ctrl+C as a cancel, both through questionOrEmpty. [a]bort or Ctrl+C stops
 * the asking there.
 *
 * Each answer is the line that arrives while its question is waiting. A line
 * that arrives while none is -- typed ahead of the second question, say -- is
 * not kept for the next one: readline emits it with no question to take it,
 * and that question then waits for a fresh line, or takes the default at EOF.
 */
async function askBundleCollisions(
  changing: readonly ImportCandidate[],
  bundlesFile: string,
  io: ImportCommandOptions["io"],
): Promise<CollisionAnswers> {
  const rl = createInterface({
    input: io?.stdin ?? process.stdin,
    output: io?.stdout ?? process.stdout,
    terminal: io?.terminal,
  });
  const answers = new Map<ImportCandidate, "overwrite" | "skip">();
  try {
    for (const c of changing) {
      const diff = indentLines(c.changes ?? [], "    ");
      const raw = await questionOrEmpty(
        rl,
        `${bundlesFile} already has an entry "${displaySafe(c.plannedNamespace)}" that differs from the one importing ${displayArg(c.key)} would write:\n` +
          `${diff}\n` +
          "  [o]verwrite, [s]kip, or [a]bort? (default: skip) ",
      );
      if (raw === QUESTION_CANCELLED) return "cancelled";
      const answer = raw.trim().toLowerCase();
      if (answer.startsWith("a")) return "abort";
      answers.set(c, answer.startsWith("o") ? "overwrite" : "skip");
    }
    return answers;
  } finally {
    rl.close();
  }
}

/** A config file plus the path inside it that holds the server entries -- as a
 *  `ConfigSite`, so its SYNTAX is the one the target row and the scope
 *  resolved and is never restated here. A client with more than one scope has
 *  more than one of these. */
type ContainerRef = ConfigSite;

function describeContainer(ref: ContainerRef): string {
  return `${displaySafe(ref.resolved.absolute)} (${ref.resolved.containerPath.join(".")})`;
}

/** Is yaw-mcp itself wired into this container -- under its own entry key or a
 *  pre-rename one? Asked of the VIEW rather than of a parsed object, so the
 *  answer comes from the site's own adapter and the legacy list has one
 *  reader. */
function isWiredIn(view: ClientConfigView): boolean {
  return view.entry() !== undefined || view.legacyKey() !== null;
}

/** What one searched container turned out to be. Only `container` can hold a
 *  yaw-mcp entry; the other two differ in what `yaw-mcp install` would do
 *  with the file, which is what the refusal's advice depends on.
 *
 *  - `none`: nothing install objects to -- the file is absent or empty, the
 *    container key is absent, or it holds a shape install replaces with `{}`
 *    itself (null, a scalar, an empty array -- the core reports that as a
 *    `blocked` read with `reparable` true). "Run install first" is true for
 *    these.
 *  - `refused`: a file install will NOT write -- unreadable, not JSON, a root
 *    that is not an object, or a container key holding a non-empty array. A
 *    bare `yaw-mcp install <client>` exits 1 on it, so the advice has to name
 *    the by-hand step first. `clause` says what is wrong; `installSays` and
 *    `fix` say what install does and what gets past it, in install's words.
 *
 *  `wired` answers the ONE question the caller asks of a `container`: is
 *  yaw-mcp itself in it. The container object is deliberately not carried out
 *  of here any more -- nothing outside the core needs to hold one. */
type ContainerRead =
  | { state: "container"; wired: boolean }
  | { state: "none" }
  | { state: "refused"; clause: string; installSays: string; fix: (then: string) => string };

/** Read the server container at one path, telling apart the states install
 *  treats differently (see ContainerRead). The checks follow install's own
 *  read in runInstall, in its order, so the two do not disagree about which
 *  file install refuses: that disagreement was the bug -- an unparseable file
 *  answered "no yaw-mcp entry ... run `yaw-mcp install` first", and install
 *  then exited 1 on it.
 *
 *  Anything but `container` counts as NOT holding a yaw-mcp entry, and the two
 *  errors are not symmetric: a false "wired" removes originals the client can
 *  no longer reach, while a false "not wired" only refuses a removal that
 *  would have been safe. */
async function readContainer(ref: ContainerRef): Promise<ContainerRead> {
  const where = displaySafe(ref.resolved.absolute);
  // Read the CANONICAL address first: every state install treats differently
  // is a fact about the file or about the canonical container, in install's
  // own order, and only the "is yaw-mcp wired in" question folds across the
  // drive-case siblings (below).
  const view = await readClientConfigFile(ref);
  const read = view.read;
  // Absent (no file, or an empty one): install creates or fills it, so "run
  // install" works. The core reads an empty or whitespace-only file as absent
  // for exactly the reason install writes one as if it were absent.
  if (read.kind === "absent") return { state: "none" };
  if (read.kind === "unreadable") {
    // install's describeUnreadableConfig wording, so the two name one fault
    // the same way.
    if (read.code === "EISDIR") {
      return {
        state: "refused",
        clause: `${where} is a directory, not a file`,
        installSays: `cannot read ${where}`,
        fix: (then) => `move or remove it, then ${then}`,
      };
    }
    return {
      state: "refused",
      clause: `${where} could not be read (${displaySafe(read.message)})`,
      installSays: `cannot read ${where}`,
      fix: (then) => `check the file and its permissions, then ${then}`,
    };
  }
  // `read.syntax` and `view.adapter.syntax` are the adapter's own name for the
  // file's language. A JSON-family client says "JSON", byte-identical to the
  // literals these clauses replaced; Codex CLI's config.toml (its row declares
  // `forImport`, so import reads it) says "TOML", and so does the remedy.
  if (read.kind === "malformed") {
    return {
      state: "refused",
      clause:
        read.reason === "root" ? `${where} is not a ${read.syntax} object` : `${where} is not valid ${read.syntax}`,
      installSays: `refuses to overwrite ${where}`,
      fix: (then: string) => unparseableConfigFix(then, read.syntax),
    };
  }
  if (read.kind === "blocked") {
    if (!read.reparable) {
      const keyPath = `"${read.path.join(".")}" in ${where}`;
      const syntax = view.adapter.syntax;
      return {
        state: "refused",
        clause: `${keyPath} is ${read.shape}, not ${containerNounFor(syntax)}`,
        installSays: `refuses to overwrite ${keyPath}`,
        fix: (then: string) => blockedContainerFix(then, syntax),
      };
    }
    return { state: "none" };
  }
  if (read.kind === "unspliceable") {
    const keyPath = `the "${read.key}" entry in ${where}`;
    return {
      state: "refused",
      clause: `${keyPath} is ${read.reason}`,
      installSays: `refuses to edit ${keyPath}`,
      fix: (then) => `rewrite that entry by hand, then ${then}`,
    };
  }
  // Parses for US, not for its client: a strict-JSON site carrying a comment
  // or a trailing comma, which that client reads with JSON.parse and so loads
  // NO server from -- including any yaw-mcp entry sitting in it.
  //
  // REFUSED rather than `container`, and this is the asymmetry the doc above
  // is about. A yaw-mcp entry in such a file is NOT wiring: the client cannot
  // see it. Answering "wired" here let `--remove-originals` delete servers out
  // of a config that WAS loading them (~/.claude.json) on the strength of a
  // broker the client never loads, leaving it able to reach neither -- the
  // false-"wired" half, which is the destructive one. Placed after `blocked`
  // to match install's own order: applyClientConfigEdits raises the blocked
  // refusal before the unloadable gate, so on a file that is both, the blocked
  // clause is the one the user actually hits.
  const unloadable = view.unloadable();
  if (unloadable !== null) {
    return {
      state: "refused",
      clause: `${where} ${unloadableConfigProblem(unloadable)}`,
      installSays: `refuses to write into ${where}`,
      fix: unloadableConfigFix,
    };
  }
  // The only question this function is asked is "is yaw-mcp already wired in
  // for this project", and an entry an older version wrote under the other
  // drive-letter case answers it yes -- so the wiring question, and only it,
  // folds across the siblings. The view picks the first candidate carrying our
  // wiring and otherwise the first that exists, so a bare canonical container
  // still reads as "present, nothing wired".
  const folded = classifyClientConfig(view.raw, ref, { containerPaths: driveCaseVariants(ref, view.raw) });
  const at = folded.read;
  // A container that is not present at all is "none": there is nothing there
  // for install to object to, and nothing for a yaw-mcp entry to be in.
  if (at.kind !== "ok" || !at.containerPresent) return { state: "none" };
  return { state: "container", wired: isWiredIn(folded) };
}

/** The container addresses one site's drive-letter-case siblings occupy, in
 *  priority order (canonical first).
 *
 *  The RULE lives in install-targets.ts, which owns the `projects[...]`
 *  question; the candidate keys come from the file's own container through the
 *  core, so nothing here parses a client config to find them. `raw` is the
 *  bytes when the caller already holds them, and null when it does not -- a
 *  null yields the canonical path alone, which is the same degradation
 *  `claudeCodeContainerPathVariants` documents for a key lister that answers
 *  nothing -- so a caller with no bytes reads where writes go. */
function driveCaseVariants(site: ConfigSite, raw: string | null): string[][] {
  return claudeCodeContainerPathVariants(site.resolved.containerPath, (prefix) => containerKeysAt(raw, site, prefix));
}

export function parseImportArgs(
  argv: string[],
): { ok: true; options: ImportCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: IMPORT_USAGE };
  const opts: ImportCommandOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--scope": {
        const v = next();
        if (!v || !["user", "project", "local"].includes(v)) {
          return { ok: false, error: `yaw-mcp import: --scope requires user|project|local\n${IMPORT_USAGE}` };
        }
        opts.scope = v as InstallScope;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v || v.startsWith("-")) {
          return { ok: false, error: `yaw-mcp import: --project-dir requires a value\n${IMPORT_USAGE}` };
        }
        opts.projectDir = v;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--remove-originals":
        opts.removeOriginals = true;
        break;
      case "--keep-originals":
        opts.keepOriginals = true;
        break;
      // install's word for the same answer: replace a differing entry without
      // asking. Unrelated to the two flags above, which answer the question
      // about the CLIENT config.
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        return { ok: false, error: IMPORT_USAGE, help: true };
      default:
        if (a.startsWith("-")) return { ok: false, error: `yaw-mcp import: unknown flag "${a}"\n${IMPORT_USAGE}` };
        positional.push(a);
    }
  }
  // Opposite answers to one question. Picking a winner silently is exactly the
  // class of thing this command must not do to a file the user did not ask it
  // to touch.
  if (opts.removeOriginals && opts.keepOriginals) {
    return {
      ok: false,
      error: `yaw-mcp import: --remove-originals and --keep-originals are opposites -- pass one.\n${IMPORT_USAGE}`,
    };
  }
  if (positional.length !== 1) {
    return { ok: false, error: `yaw-mcp import: expected exactly one client.\n${IMPORT_USAGE}` };
  }
  // Resolved HERE rather than left to resolveInstallSite: that helper answers
  // an unknown client by printing install's own multi-KB usage, which is not
  // the text an `import` typo should produce. Same resolver as install's, so
  // import takes exactly the names install does, aliases included.
  const resolved = resolveClientArg("import", positional[0]);
  if (!resolved) {
    return {
      ok: false,
      error: `yaw-mcp import: unknown client "${positional[0]}". Choose: ${clientChoices("import").join(", ")}`,
    };
  }
  opts.clientId = resolved.clientId;
  // An alias's scope is a DEFAULT: an explicit --scope beside it still wins.
  if (resolved.scope !== undefined && opts.scope === undefined) opts.scope = resolved.scope;
  return { ok: true, options: opts };
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors runRemove's isInteractive. */
function isInteractive(opts: ImportCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** One candidate that actually reached bundles.json. */
interface ImportedEntry {
  candidate: ImportCandidate;
  /** The namespace the entry LANDED under -- taken from the entry as written,
   *  never from the derived one: a name-fallback merge keeps the stored
   *  namespace, and this is the identity the removal decision hangs on. */
  landed: string;
}

/** What runImport resolved its client and scope to -- resolveInstallSite's
 *  answer, once it has one. */
type ImportSite = NonNullable<ReturnType<typeof resolveInstallSite>>;

/** Where the search for yaw-mcp's own entry looked, and what it found. The
 *  real run decides from it whether the originals may go, and a dry run with
 *  --remove-originals previews that same decision from it. */
interface BrokerSearch {
  /** Every container searched, the imported one FIRST. */
  searched: ContainerRef[];
  /** The first searched container holding a yaw-mcp entry, or null when none
   *  does -- and then the originals are never removed. */
  wiredIn: ContainerRef | null;
  /** The searched containers `yaw-mcp install` refuses, each with its words. */
  refused: Map<ContainerRef, Extract<ContainerRead, { state: "refused" }>>;
  /** The container a bare `yaw-mcp install <client>` writes -- the step the
   *  refusal names -- or null when no user-scope path resolved. */
  installRef: ContainerRef | null;
}

/**
 * Find the yaw-mcp entry the imported servers would be reached through once
 * their originals are gone. Reads files; never writes one.
 *
 * A client with more than one scope reads more than one container -- Claude
 * Code's user-scope `mcpServers` and its local-scope `projects[<dir>].mcpServers`
 * are both inside ~/.claude.json -- so searching only the container the
 * servers came from reported "no yaw-mcp entry" at a non-user scope while one
 * sat in the same file, and the remedy it printed (`yaw-mcp install <client>`,
 * which writes the USER scope) fixed nothing the message was about.
 *
 * `sourceRef` is the imported container and `source` the view of it the caller
 * already holds. It is searched FIRST, from that view, so the single-scope
 * clients read no extra files at all.
 */
async function searchForBroker(
  site: ImportSite,
  sourceRef: ContainerRef,
  source: ClientConfigView,
  opts: ImportCommandOptions,
  home: string,
): Promise<BrokerSearch> {
  const { target } = site;
  const searched: ContainerRef[] = [sourceRef];
  // The container a bare `yaw-mcp install <client>` writes -- the step the
  // refusal names. Every client has a user scope and resolveInstallSite
  // defaults to it, so it is the user-scope ref.
  let installRef: ContainerRef | null = site.scope === "user" ? searched[0] : null;
  for (const spec of target.scopes) {
    if (spec.scope === site.scope) continue;
    try {
      // SITES, so each searched container carries the syntax its own row and
      // scope resolved -- the read below never restates a format. A row that
      // fans one scope out to several files contributes all of them, which is
      // where the entry could be.
      const others = resolveInstallSites({
        clientId: target.clientId,
        scope: spec.scope,
        os: site.os,
        home,
        appData: resolveAppDataDir({ appData: opts.appData, home }),
        // Same env the target scope resolved with, so an env-redirected client
        // is searched at its REAL other-scope path rather than the default one.
        clientEnv: opts.clientEnv,
        // The project the user is standing in -- the same resolution
        // resolveInstallSite would have made had that scope been the target.
        projectDir: spec.requiresProjectDir
          ? (site.projectDir ?? resolvePath(opts.cwd ?? process.cwd(), "."))
          : undefined,
        claudeConfigDir: opts.claudeConfigDir,
      });
      for (const other of others) {
        const already = searched.find(
          (r) =>
            r.resolved.absolute === other.resolved.absolute &&
            r.resolved.containerPath.join(".") === other.resolved.containerPath.join("."),
        );
        const ref = already ?? other;
        if (!already) searched.push(ref);
        if (spec.scope === "user" && installRef === null) installRef = ref;
      }
    } catch {
      // A scope this machine cannot resolve a path for is one the client is
      // not reading either, so it is simply not searched.
    }
  }
  let wiredIn: ContainerRef | null = null;
  const refused = new Map<ContainerRef, Extract<ContainerRead, { state: "refused" }>>();
  for (let i = 0; i < searched.length; i++) {
    // The imported container is FIRST and is the VIEW already in hand, so the
    // single-scope clients read no extra files at all.
    const read: ContainerRead =
      i === 0 ? { state: "container", wired: isWiredIn(source) } : await readContainer(searched[i]);
    if (read.state === "container" && read.wired) {
      wiredIn = searched[i];
      break;
    }
    if (read.state === "refused") refused.set(searched[i], read);
  }
  return { searched, wiredIn, refused, installRef };
}

/**
 * Why the originals stay when no searched container holds a yaw-mcp entry,
 * and what to run -- everything after the lead, so the real run ("Not
 * removing the originals: ...") and the dry run ("Would not remove the
 * originals: ...") give one reason in one wording.
 *
 * The one case where removing is never right: with no yaw-mcp entry in the
 * client config, dropping the originals leaves the client unable to reach ANY
 * of them, and the import would read as a success while taking every server
 * offline. The containers are NAMED rather than the claim being made about the
 * client as a whole: "it has no entry" was a statement about one container,
 * made as though it covered every file the client reads.
 *
 * A container install refuses is named for what it is, not as "no entry". When
 * it is the one `yaw-mcp install <client>` writes, "run install first" sent the
 * user to a command that exits 1 on it, so the advice leads with install's own
 * by-hand step instead. One clause per distinct fault: Claude Code's user and
 * local scopes share ~/.claude.json, and an unparseable one would otherwise be
 * reported twice.
 */
function removalRefusal(search: BrokerSearch, target: ImportSite["target"]): string {
  const { searched, refused, installRef } = search;
  const noEntry = searched.filter((r) => !refused.has(r));
  const clauses = [`no yaw-mcp entry in ${noEntry.map(describeContainer).join(" or ")}`];
  for (const r of refused.values()) if (!clauses.includes(r.clause)) clauses.push(r.clause);
  const installCmd = `yaw-mcp install ${target.clientId}`;
  const blocking = installRef ? refused.get(installRef) : undefined;
  const next = blocking
    ? `\`${installCmd}\` ${blocking.installSays}; ${blocking.fix(`run \`${installCmd}\` and re-run this with --remove-originals`)}.`
    : `Run \`${installCmd}\` first, then re-run this with --remove-originals.`;
  return `${clauses.join(", and ")}, so ${target.label} would be left with no way to reach them. ${next}`;
}

/** What peeling the imported keys out of a client config's text produced. */
interface OriginalsSplice {
  /** The text a write would persist. */
  next: string;
  /** The keys that actually came out, in the order they were asked for. */
  removed: string[];
  /** The keys the splicer refused, each rendered as `key (why)`. */
  unremovable: string[];
}

/**
 * Peel `keys` out of the client config's bytes through the core's write
 * facade, one key at a time, exactly as `uninstall` and `try-cleanup` do. A
 * parse-and-reserialize would take the user's comments -- and, in
 * ~/.claude.json, the rest of their Claude Code state -- with it, and going
 * through the facade is what VERIFIES each removal (nothing but that key
 * moved, no neighbour changed, the file still reads back) before there are
 * bytes to persist.
 *
 * ONE CALL PER KEY, each classified against the text the last one produced,
 * rather than one call carrying every removal: a key the splicer refuses (an
 * empty-string key is the shape that reaches it) must not abort the removal
 * for every other imported server, which is what a single edit list would do.
 * That was the bug -- one loop-wide catch, under a message that named no key
 * at all.
 *
 * Pure: it writes nothing and returns the text for the caller to persist. That
 * is what lets a dry run name exactly the keys the real run would take out,
 * rather than the keys it asked for.
 */
function spliceOutOriginals(
  raw: string,
  site: ConfigSite,
  keys: readonly string[],
  transform: EntryTransform | undefined,
): OriginalsSplice {
  let next = raw;
  const removed: string[] = [];
  const unremovable: string[] = [];
  for (const key of keys) {
    try {
      const at = classifyClientConfig(next, site, { transform });
      const edits: ClientConfigEdit[] = [{ op: "remove", key }];
      const after = applyClientConfigEdits(at, edits, site);
      if (after !== next) removed.push(key);
      next = after;
    } catch (e) {
      unremovable.push(`${displayArg(key)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { next, removed, unremovable };
}

/** The line naming the keys a removal cannot take out. `outcome` is the real
 *  run's "could not be removed" or the dry run's "would not be removed"; the
 *  rest is one sentence, so the two cannot drift apart. */
function unremovableNote(outcome: string, file: string, unremovable: string[], label: string): string {
  const one = unremovable.length === 1;
  return `yaw-mcp import: ${outcome} from ${file}: ${unremovable.join("; ")}. Remove ${one ? "that entry" : "those entries"} by hand; ${label} would otherwise keep launching ${one ? "it" : "them"} alongside yaw-mcp.`;
}

export async function runImport(opts: ImportCommandOptions): Promise<ImportCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const errOut = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => errOut(`${s}\n`);

  const home = opts.home ?? homedir();
  const site = resolveInstallSite("import", { ...opts, home }, printErr);
  if (!site) return { exitCode: 2, written: [] };
  const { target, resolved } = site;

  // bundles.json's own read diagnostics reach this command twice per candidate
  // -- once from the plan's preview, once from the write. Printed once each,
  // so a malformed `defaultRuntime` does not appear twelve times for a
  // six-server import.
  const reportedWarnings = new Set<string>();
  const warnOnce = (w: string): void => {
    if (reportedWarnings.has(w)) return;
    reportedWarnings.add(w);
    printErr(`warning: ${w}`);
  };

  print(`Source: ${target.label} (${site.scope})`);
  print(`File:   ${displaySafe(resolved.absolute)}`);

  // The source file is read THROUGH THE CORE: one reader for every syntax,
  // the strictness the site declared, and the entries handed back by the
  // site's own adapter rather than by a walk here.
  const targetSite = site.sites[0];
  const view = await readClientConfigFile(targetSite, { transform: target.entry });
  const read = view.read;
  if (read.kind === "unreadable") {
    printErr(`yaw-mcp import: cannot read ${displaySafe(resolved.absolute)}: ${read.message}`);
    return { exitCode: 1, written: [] };
  }
  if (read.kind === "absent") {
    // `raw` is null for a file that is not there and the empty string for one
    // that is there and holds nothing -- which the core reads as absent for
    // the same reason install writes an empty file as if it were absent. Both
    // mean "no servers to import", and each says which it is: the previous
    // wording told a user with an empty config that it was invalid JSON.
    printErr(
      view.raw === null
        ? `yaw-mcp import: ${displaySafe(resolved.absolute)} does not exist -- ${target.label} has no MCP servers configured at this scope.`
        : `yaw-mcp import: ${displaySafe(resolved.absolute)} is empty -- ${target.label} has no MCP servers configured at this scope.`,
    );
    return { exitCode: 1, written: [] };
  }
  // `read.syntax` is the adapter's own name for the file's language: "JSON"
  // for every JSON-family client, where both lines are byte-identical to the
  // literals they replaced, and "TOML" for Codex CLI's config.toml, which
  // import reads through its forImport row (target-codex-cli.ts) -- so a
  // config.toml that does not parse is reported as TOML here, as in
  // readContainer above.
  if (read.kind === "malformed") {
    printErr(
      read.reason === "root"
        ? `yaw-mcp import: ${displaySafe(resolved.absolute)} is not a ${read.syntax} object.`
        : `yaw-mcp import: ${displaySafe(resolved.absolute)} is not valid ${read.syntax} (${read.detail}).`,
    );
    return { exitCode: 1, written: [] };
  }

  // The client's OWN container -- `mcpServers` for most clients, `servers` for
  // VS Code, `context_servers` for Zed, and `projects[<absDir>].mcpServers`
  // for Claude Code at local scope. It comes off the site the resolver
  // produced, which is what keeps this command from assuming a single
  // spelling; pasting a Claude Code shape into a VS Code file fails silently,
  // which is the bug the table records.
  //
  // EVERY projects[] read resolves its path through the one helper -- see
  // driveCaseVariants. The canonical key comes first; a drive-letter-case
  // sibling of the same project is read too, because an older version wrote the
  // servers there and "Nothing to import" over a file full of them is the same
  // blindness `uninstall` had. `sourcePath` carries the key that was actually
  // read all the way down to the removal below: reading a sibling and then
  // deleting from the canonical key would leave every imported server wired.
  //
  // A `blocked` or `unspliceable` read reaches here and finds no container at
  // any candidate, which lands on the "nothing to import" line below -- the
  // same place the walk this replaces left it.
  let source: ClientConfigView | null = null;
  let sourcePath: string[] = [...resolved.containerPath];
  for (const variantPath of driveCaseVariants(targetSite, view.raw)) {
    const at = classifyClientConfig(view.raw, siteAt(targetSite, variantPath), { transform: target.entry });
    if (at.read.kind !== "ok" || !at.read.containerPresent) continue;
    // The first NON-EMPTY container wins; an empty one is only a fallback, so
    // an empty canonical container still produces the "nothing to import"
    // message about the key the user asked about.
    if (source === null || at.count() > 0) {
      source = at;
      sourcePath = variantPath;
    }
    if (at.count() > 0) break;
  }
  if (source === null) {
    print(`\nNothing to import: no "${resolved.containerPath.join(".")}" object in ${displaySafe(resolved.absolute)}.`);
    return { exitCode: 0, written: [] };
  }

  // VS Code is the only client that declares its own variables in the file
  // being read (the `inputs` block), so it is the only one whose `${...}`
  // spans are interpreted here -- see toEntry.
  const isVsCode = target.clientId === "vscode";
  const vars: ClientVars | null = isVsCode ? { workspaceFolder: site.projectDir } : null;
  const inputs = isVsCode ? readVsCodeInputs(view.raw ?? "") : new Map<string, string>();

  const candidates: ImportCandidate[] = [];
  const skippedSelf: string[] = [];
  const unusable: string[] = [];
  /** Servers refused over a `${...}` this importer cannot resolve, already
   *  rendered as "  <key>: <spans>" lines. */
  const unresolvable: string[] = [];
  for (const { key, value } of source.entries()) {
    if (isSelfEntry(key)) {
      skippedSelf.push(key);
      continue;
    }
    // A value that is not an object is not a server at all (a hand-edit
    // artifact), and `importViewOf` takes a record -- so that shape is refused
    // here rather than inside it, on the same terms `toEntry` already refused
    // it.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      unusable.push(key);
      continue;
    }
    // THE TARGET's own view of its own entry. With no `forImport` hook this is
    // the entry as the row's `normalize` says every consumer should see it,
    // which is what makes a client that stores our launch under a nested
    // transport key (Cline) import as a launchable server rather than as an
    // opaque object with no command in it.
    //
    // Only `entry` is read today, and that is the whole of what the importer
    // asks for: `disabled`, `skipReason` and `discardedKeys` arrive on an
    // ImportView only from a `forImport` hook. Codex CLI's row declares one
    // (target-codex-cli.ts), so a TOML entry reaches this line through it, but
    // the importer does not act on those three fields yet -- wiring them is
    // separate work, with its own tests, not a side effect of reading TOML.
    const built = toEntry(key, importViewOf(value as Record<string, unknown>, target.entry).entry, vars);
    if (!built) {
      unusable.push(key);
      continue;
    }
    if (built.unresolved.length > 0) {
      unresolvable.push(`  ${displayArg(key)}: ${describeUnresolved(built.unresolved, inputs)}`);
      continue;
    }
    candidates.push({
      key,
      namespace: built.entry.namespace as string,
      entry: built.entry,
      credentialKeys: built.credentialKeys,
      discarded: built.discarded,
      plannedNamespace: built.entry.namespace as string,
    });
  }

  /** Everything skipped, on stderr, in one place -- so a run whose candidate
   *  list came out empty still says why. */
  const reportSkips = (): void => {
    if (unusable.length > 0) {
      printErr(`Skipped (no command or url to launch): ${unusable.map(displayArg).join(", ")}`);
    }
    if (unresolvable.length > 0) {
      printErr(
        `Skipped (${target.label} expands these variables itself and yaw-mcp does not, so the entry would launch with the literal text):\n${unresolvable.join("\n")}\nAdd each by hand once you know the value: \`yaw-mcp add <name> --command ... --env KEY='\${secret:NAME}'\`.`,
      );
    }
  };

  if (candidates.length === 0) {
    print(`\nNothing to import: no servers in ${displaySafe(resolved.absolute)} beyond yaw-mcp's own entry.`);
    reportSkips();
    return { exitCode: 0, written: [] };
  }

  // What each write would actually do, taken BEFORE anything is written so
  // every candidate is diffed against the same on-disk state the user is
  // looking at. Three things come out of it that the candidate cannot know on
  // its own: the namespace the file will hold (a stored entry matched by NAME
  // keeps its own, so printing the derived one named a namespace that would
  // never exist), the launch command this write would replace, and whether it
  // would change the stored entry at all -- the question asked before writing.
  /** Candidates whose write could not be previewed. The real run's write of
   *  each throws the same error and skips it, so none of them is imported --
   *  which is what a dry run's removal preview needs to know. */
  const unpreviewed = new Set<ImportCandidate>();
  for (const c of candidates) {
    try {
      const preview = await previewUpsertUserBundle(c.entry, { home });
      for (const w of preview.warnings) warnOnce(w);
      c.plannedNamespace = preview.namespace ?? c.namespace;
      c.replacing = preview.replaced ? preview.replacing : undefined;
      // Never throws, so a failed comparison cannot land this candidate in
      // `unpreviewed` below.
      if (preview.replaced) c.changes = (await storedEntryChanges(preview, home, warnOnce)) ?? undefined;
    } catch (e) {
      // A bundles.json that is present but unparseable. The write below throws
      // the same error and reports it per candidate; the plan just falls back
      // to the derived namespace rather than aborting a run that has not
      // touched anything yet.
      unpreviewed.add(c);
      warnOnce(`could not preview the write against bundles.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Two client keys can derive ONE namespace ("my-tool" and "My Tool" both
  // land on "mytool"), and the second write silently replaces the first. The
  // old cloud-era import reported this and it is worth keeping: the user
  // cannot otherwise tell which of the two survived.
  //
  // Keyed on the PLANNED namespace, not the derived one: two keys can also
  // collide through the name fallback (one matching a stored entry by name and
  // inheriting its namespace, the other deriving that same namespace), and a
  // map built from the derived names alone does not see that pair at all.
  const byNamespace = new Map<string, string[]>();
  for (const c of candidates) {
    byNamespace.set(c.plannedNamespace, [...(byNamespace.get(c.plannedNamespace) ?? []), c.key]);
  }
  const collisions = [...byNamespace.entries()].filter(([, keys]) => keys.length > 1);

  print("");
  print(`Servers to import (${candidates.length}):`);
  for (const c of candidates) {
    print(`  ${displayArg(c.key)} -> ${c.plannedNamespace}`);
    print(`    ${renderLaunch(c.entry)}`);
    // Key NAMES only. A client config is where the credentials are, and this
    // transcript goes on a terminal and into bug reports.
    if (c.credentialKeys.length > 0) {
      print(`    carries: ${c.credentialKeys.map(displayArg).join(", ")} (values copied, not shown)`);
    }
    // An imported entry carries no catalog slug, so upsertUserBundle's
    // cross-slug refusal can never fire for it: EVERY match merges, with the
    // client's copy winning. Naming what the write would overwrite -- and,
    // below the plan, asking before a write that would change it -- is what
    // stands between "adopt the servers I already had" and "replace the launch
    // command of one of them", which is arbitrary command execution on the
    // next activate.
    if (c.replacing) {
      print(`    REPLACES the "${c.plannedNamespace}" entry already in bundles.json:`);
      print(`      was: ${renderLaunch(c.replacing)}`);
    }
  }
  if (skippedSelf.length > 0) print(`\nSkipped yaw-mcp's own entries: ${skippedSelf.map(displayArg).join(", ")}`);
  reportSkips();
  // Named, never dropped in silence: the loader warns for both shapes and
  // `set` refuses them outright, so an import that swallowed them was the one
  // surface where a hand-edit artifact could cost a credential with nothing
  // anywhere saying so.
  for (const c of candidates) {
    for (const note of c.discarded) printErr(`warning: ${displaySafe(resolved.absolute)}: ${note}`);
  }
  for (const [ns, keys] of collisions) {
    printErr(
      `warning: namespace collision -- ${keys.map(displayArg).join(" and ")} both derive "${ns}", so only the last one imported keeps that namespace. Rename one in ${displaySafe(resolved.absolute)} and re-run, or edit the namespace in bundles.json.`,
    );
  }

  /** The candidates whose write would CHANGE an entry bundles.json already
   *  holds -- the ones the question below is about. */
  const changing = candidates.filter((c) => c.changes !== undefined);

  if (opts.dryRun) {
    // ----- the entries the import would change ---------------------------
    //
    // Previewed, never asked about: a dry run answers no question, so it shows
    // the overwrite a real run would make if it went ahead -- install's dry
    // run does the same -- and says what a real run needs to go ahead.
    if (changing.length > 0) print("");
    for (const c of changing) {
      const how = opts.force ? "--force" : "a real run asks first, and off a terminal needs --force";
      print(`Would overwrite the "${displaySafe(c.plannedNamespace)}" entry in bundles.json (${how}):`);
      for (const d of c.changes ?? []) print(`  ${d}`);
    }

    // ----- what --remove-originals would take out ------------------------
    //
    // The removal is the one step of an import that edits a file the user did
    // not name, so a dry run asked for it previews it: the file and every key
    // a real run would take out of it, or the reason it would take out none.
    // Without --remove-originals nothing is printed here: a real run then
    // leaves the file alone or asks first, and a preview cannot answer that
    // question for the user. --keep-originals beside it wins, as it does in
    // the real run below (parseImportArgs refuses that pair, so only a direct
    // caller can pass both).
    //
    // The search, the refusal and the splice are the real run's own, over the
    // same bytes, so the preview cannot name a key the real run would leave or
    // miss one it would take. Only the imported SET is predicted rather than
    // read back: the real run takes it from its writes -- the last writer of
    // each namespace -- and here it is the last candidate PLANNED onto each
    // one, less any whose write could not be previewed. Like the "Would
    // overwrite" preview above, it assumes every entry the import would change
    // is overwritten; a real run whose question is answered [s]kip for one
    // does not import that server, so leaves its key where it is.
    if (opts.removeOriginals && !opts.keepOriginals) {
      const file = displaySafe(resolved.absolute);
      const planned = new Map<string, ImportCandidate>();
      for (const c of candidates) if (!unpreviewed.has(c)) planned.set(c.plannedNamespace, c);
      if (planned.size === 0) {
        printErr(
          `yaw-mcp import: would remove nothing from ${file} -- none of these servers would be imported, because their write to bundles.json could not be previewed (the warning above says why).`,
        );
      } else {
        const broker = await searchForBroker(site, siteAt(targetSite, sourcePath), source, opts, home);
        if (broker.wiredIn === null) {
          printErr(`Would not remove the originals: ${removalRefusal(broker, target)}`);
        } else {
          const keys = [...planned.values()].map((c) => c.key);
          const preview = spliceOutOriginals(view.raw ?? "", siteAt(targetSite, sourcePath), keys, target.entry);
          if (preview.unremovable.length > 0) {
            printErr(unremovableNote("would not be removed", file, preview.unremovable, target.label));
          }
          const count = preview.removed.length;
          if (count === 0) {
            printErr(
              `yaw-mcp import: would remove nothing from ${file}; it would be left unchanged. The servers would be imported either way.`,
            );
          } else {
            print("");
            if (broker.wiredIn !== broker.searched[0]) {
              print(`Reached through the yaw-mcp entry in ${describeContainer(broker.wiredIn)}.`);
            }
            print(`Would remove ${count} ${count === 1 ? "entry" : "entries"} from ${file} (--remove-originals):`);
            for (const key of preview.removed) print(`  ${displayArg(key)}`);
          }
        }
      }
    }
    print("\n--- dry run: nothing was written ---");
    return { exitCode: 0, written: [] };
  }

  // ----- entries bundles.json already holds that this import would change --
  //
  // Decided BEFORE the first write, so [a]bort, Ctrl+C and the off-TTY refusal
  // leave both files exactly as they were, the servers that collide with
  // nothing included: a run that wrote half its plan and then stopped would
  // leave the user to work out which half landed.
  const bundlesFile = displaySafe(localBundlesPath(userConfigDir(home)));
  /** Candidates whose question was answered [s]kip. They are not written, so
   *  they are not imported, so their originals are never removed below. */
  const declined = new Set<ImportCandidate>();
  if (changing.length > 0) {
    /** Null under --force, which answers every question "overwrite". */
    let answers: Map<ImportCandidate, "overwrite" | "skip"> | null = null;
    if (!opts.force) {
      if (!isInteractive(opts)) {
        // Off a TTY, silence is not consent here either. install refuses to
        // replace its own differing entry with exit 2 -- the code `remove` and
        // `uninstall` also use for a confirmation that could not be asked for,
        // each naming --force -- so a script can tell "needs a flag" from a
        // failed write without reading the prose. The diff comes with the
        // refusal, so a scripted run sees what --force would replace before it
        // is re-run with it.
        const one = changing.length === 1;
        const blocks = changing.map(
          (c) =>
            `  "${displaySafe(c.plannedNamespace)}" differs from the one importing ${displayArg(c.key)} would write:\n` +
            indentLines(c.changes ?? [], "    "),
        );
        printErr(
          `yaw-mcp import: ${bundlesFile} already has ${changing.length === 1 ? "an entry" : `${changing.length} entries`} this import would change, and there is no terminal to ask on. Nothing was written.\n` +
            `${blocks.join("\n")}\n` +
            `  Re-run with --force to overwrite ${one ? "it" : "them"}, or --dry-run to preview.`,
        );
        return { exitCode: 2, written: [] };
      }
      const asked = await askBundleCollisions(changing, bundlesFile, opts.io);
      if (asked === "abort") {
        printErr("yaw-mcp import: Aborted. Nothing was written.");
        return { exitCode: 1, written: [] };
      }
      if (asked === "cancelled") {
        // Ctrl+C at the question: exit 130, the convention every other prompt
        // in the product follows.
        printErr("yaw-mcp import: Cancelled. Nothing was written.");
        return { exitCode: 130, written: [] };
      }
      answers = asked;
    }
    // Printed only once every question is answered: an "Overwriting" line
    // printed between two questions would stand in the transcript above a
    // later [a]bort that wrote nothing.
    print("");
    for (const c of changing) {
      const ns = displaySafe(c.plannedNamespace);
      if (answers === null) {
        // The plan showed only the launch; --force is the one path on which
        // nothing has shown the rest of the diff yet.
        print(`Overwriting the "${ns}" entry in bundles.json (--force):`);
        for (const d of c.changes ?? []) print(`  ${d}`);
      } else if (answers.get(c) === "overwrite") {
        print(`Overwriting the "${ns}" entry in bundles.json.`);
      } else {
        declined.add(c);
        print(`Left the "${ns}" entry in bundles.json as it is -- ${displayArg(c.key)} is not imported.`);
      }
    }
  }
  const toWrite = candidates.filter((c) => !declined.has(c));
  if (toWrite.length === 0) {
    print(
      `\nNothing imported: every server was skipped, so bundles.json and ${displaySafe(resolved.absolute)} are unchanged.`,
    );
    return { exitCode: 0, written: [] };
  }

  const written: string[] = [];
  const results: ImportedEntry[] = [];
  /** Namespaces THIS run has already written, so a collision is not counted as
   *  an update of something that was there beforehand. */
  const writtenNamespaces = new Set<string>();
  let updated = 0;
  for (const c of toWrite) {
    try {
      const res = await upsertUserBundle(c.entry, { home });
      for (const w of res.warnings) warnOnce(w);
      const landed = typeof res.entry.namespace === "string" ? res.entry.namespace : c.plannedNamespace;
      if (res.replaced && !writtenNamespaces.has(landed)) updated++;
      writtenNamespaces.add(landed);
      // The same note `add` prints, on the same channel (stderr, so it
      // survives a redirected stdout). A slug-less stored entry merges even
      // when the launch differs, and dropping this note left the swap silent
      // on the one path where upsertUserBundle had already worked out that it
      // was happening.
      if (res.launchChanged) {
        printErr(
          `Note: importing ${displayArg(c.key)} CHANGED the entry's launch command:\n  from: ${renderLaunch(res.launchChanged.from)}\n    to: ${renderLaunch(res.launchChanged.to)}\nIf the previous entry was a different server you meant to keep, restore it from the app or edit bundles.json.`,
        );
      }
      results.push({ candidate: c, landed });
      if (!written.includes(res.path)) written.push(res.path);
    } catch (e) {
      // NOT the cross-slug collision this catch used to claim: an imported
      // entry never carries a catalog slug, and upsertUserBundle refuses only
      // when BOTH sides have one, so that refusal is unreachable from here.
      // What does reach it is a bundles.json that is present but unparseable,
      // or a failed write. Reported and skipped rather than fatal: the
      // remaining candidates are unrelated and importing them is still the
      // right outcome.
      printErr(`yaw-mcp import: skipped "${displayArg(c.key)}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Only the LAST writer of a namespace is actually in bundles.json; an
  // earlier candidate that landed on the same one was overwritten by it and is
  // NOT imported, however cleanly its own upsert returned. Counting it anyway
  // and then removing it from the client config deleted a working server from
  // both sides at once -- gone from bundles.json (overwritten) and gone from
  // the client (removed).
  const owners = new Map<string, ImportedEntry>();
  for (const r of results) owners.set(r.landed, r);
  const imported = [...owners.values()];
  const overwritten = results.filter((r) => owners.get(r.landed) !== r);

  if (imported.length === 0) {
    printErr("yaw-mcp import: nothing was imported.");
    return { exitCode: 1, written };
  }

  print("");
  print(
    `Imported ${imported.length} server${imported.length === 1 ? "" : "s"} into ${displaySafe(written[0] ?? "bundles.json")}${updated > 0 ? ` (${updated} updated, ${imported.length - updated} added)` : ""}.`,
  );
  if (overwritten.length > 0) {
    const lost = overwritten
      .map((r) => {
        const winner = owners.get(r.landed)?.candidate.key ?? "";
        return `${displayArg(r.candidate.key)} -- "${r.landed}" went to ${displayArg(winner)}`;
      })
      .join(", ");
    printErr(
      `Not imported (another key that derives the same namespace overwrote it): ${lost}. Left in ${displaySafe(resolved.absolute)} so nothing is lost: rename one of them there and re-run, or add it by hand with \`yaw-mcp add\`.`,
    );
  }
  if (imported.some((r) => r.candidate.credentialKeys.length > 0)) {
    const names = [...new Set(imported.flatMap((r) => r.candidate.credentialKeys))];
    print(
      `Credentials came across as plain values: ${names.map(displayArg).join(", ")}. Move each one into the vault with \`yaw-mcp secrets set NAME\`, then \`yaw-mcp set <server> env.KEY='\${secret:NAME}'\`.`,
    );
  }

  // ----- the duplicate-run trap -----------------------------------------
  //
  // The client is STILL launching every one of these directly. Nothing about
  // the import changed that, so without this step the user now runs each
  // imported server twice: once from the client, once from yaw-mcp.
  print("");
  print(
    `${target.label} still launches ${imported.length === 1 ? "that server" : "those servers"} itself, so ${imported.length === 1 ? "it" : "they"} would now run twice -- once directly, once through yaw-mcp.`,
  );

  if (opts.keepOriginals) {
    print(`Left ${displaySafe(resolved.absolute)} alone (--keep-originals).`);
    return { exitCode: 0, written };
  }

  // Where a yaw-mcp entry could be, across every scope of the client -- see
  // searchForBroker. With none, removing the originals is never right, and
  // the reason and the step to take are removalRefusal's.
  const search = await searchForBroker(site, siteAt(targetSite, sourcePath), source, opts, home);
  const wiredIn = search.wiredIn;
  if (!wiredIn) {
    printErr(`Not removing the originals: ${removalRefusal(search, target)}`);
    return { exitCode: 0, written };
  }
  if (wiredIn !== search.searched[0]) {
    print(`Reached through the yaw-mcp entry in ${describeContainer(wiredIn)}.`);
  }

  if (!opts.removeOriginals) {
    if (!isInteractive(opts)) {
      // Off a TTY, silence is NOT consent. The import stands; the client
      // config is untouched and the user is told exactly what to run.
      printErr(
        `Left ${displaySafe(resolved.absolute)} alone -- there is no terminal to ask on. Re-run with --remove-originals to drop ${imported.length === 1 ? "that entry" : "those entries"}, or --keep-originals to stop being asked.`,
      );
      return { exitCode: 0, written };
    }
    const answer = await askYesNo(
      opts,
      `  Remove ${imported.length === 1 ? "it" : `those ${imported.length} entries`} from ${resolved.absolute}? [y/N] `,
    );
    if (answer === QUESTION_CANCELLED) {
      printErr("yaw-mcp import: Cancelled. The servers were imported; the client config is unchanged.");
      return { exitCode: 130, written };
    }
    if (answer !== "y" && answer !== "yes") {
      print(`Left ${displaySafe(resolved.absolute)} alone. Remove those entries by hand when you are ready.`);
      return { exitCode: 0, written };
    }
  }

  // Peeled out of the bytes the plan was read from, one key at a time, at the
  // container address the servers were actually READ from (`sourcePath`, a
  // drive-case sibling included) -- see spliceOutOriginals.
  const splice = spliceOutOriginals(
    view.raw ?? "",
    siteAt(targetSite, sourcePath),
    imported.map((r) => r.candidate.key),
    target.entry,
  );
  if (splice.unremovable.length > 0) {
    printErr(unremovableNote("could not be removed", displaySafe(resolved.absolute), splice.unremovable, target.label));
  }
  const removed = splice.removed.length;
  if (removed === 0) {
    printErr(
      `yaw-mcp import: nothing was removed from ${displaySafe(resolved.absolute)}; it was left unchanged. The servers are imported either way.`,
    );
    return { exitCode: 0, written };
  }
  try {
    await atomicWriteFile(resolved.absolute, terminateWithNewline(splice.next));
  } catch (e) {
    printErr(
      `yaw-mcp import: could not write ${displaySafe(resolved.absolute)} (${(e as Error).message}). It was left unchanged; the servers are imported either way.`,
    );
    return { exitCode: 0, written };
  }
  written.push(resolved.absolute);
  print(
    `Removed ${removed} entr${removed === 1 ? "y" : "ies"} from ${displaySafe(resolved.absolute)}. Restart ${target.label} so it picks up the change.`,
  );
  return { exitCode: 0, written };
}
