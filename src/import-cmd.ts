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
// imported servers would be reachable from nowhere at all.
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
//     arbitrary command execution on the next activate.
//   * The plan prints the namespace the file will actually hold, which is not
//     always the derived one: a stored entry matched by NAME keeps its own.
//   * A `${...}` the client expands itself is expanded here, or the server is
//     refused BY NAME. yaw-mcp does not expand them at spawn, so importing one
//     verbatim produces an entry that cannot work while looking imported.
//   * Nothing is dropped in silence: an `env` / `headers` shape the loader
//     would refuse is named (key names only), and one un-removable key never
//     aborts the removal of the others.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { resolveInstallSite } from "./install-cmd.js";
import {
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  LEGACY_ENTRY_NAMES,
  resolveAppDataDir,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc, removeJsoncEntry } from "./jsonc.js";
import { deriveNamespace, type LaunchShape, previewUpsertUserBundle, upsertUserBundle } from "./local-bundles.js";
import { QUESTION_CANCELLED, type QuestionCancelled, questionOrEmpty } from "./readline-question.js";
import { displayArg, displaySafe } from "./trust-cmd.js";
import { TRIAL_ENTRY_PREFIX } from "./try-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

export const IMPORT_USAGE = `Usage: yaw-mcp import <client> [flags]

  Read the MCP servers a client already has configured and add them to your
  local ~/.yaw-mcp/bundles.json, so yaw-mcp serves the servers you already had
  instead of starting empty.

  <client> is one of: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}.

  yaw-mcp's own entry is never imported, under any of its names. Each server's
  command, args, url, headers and env come across as they are -- an import that
  dropped the env would produce servers that cannot start -- so a credential
  sitting in your client config lands in bundles.json (file mode 0600). Move it
  into the vault afterwards with \`yaw-mcp secrets set NAME\` and
  \`yaw-mcp set <server> env.KEY='\${secret:NAME}'\`.

  A server already in bundles.json is MERGED, with the client's copy winning,
  so the plan names every entry that would be replaced and shows the launch
  command it would replace. A VS Code server written with a \${input:...} or
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
  --dry-run            Show what would be imported. Writes nothing.
  --remove-originals   Remove the imported entries from the client config
                       without asking.
  --keep-originals     Leave the client config alone without asking.`;

export interface ImportCommandOptions {
  clientId?: InstallClientId;
  scope?: InstallScope;
  projectDir?: string;
  os?: InstallOS;
  dryRun?: boolean;
  removeOriginals?: boolean;
  keepOriginals?: boolean;
  home?: string;
  cwd?: string;
  appData?: string;
  claudeConfigDir?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the removal prompt without a real TTY read. */
  promptAnswer?: string;
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
 *  apart from a typo that is broken in VS Code too. */
function readVsCodeInputs(parsed: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(parsed.inputs)) return out;
  for (const item of parsed.inputs) {
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

/** A config file plus the JSON path inside it that holds the server entries.
 *  A client with more than one scope has more than one of these. */
interface ContainerRef {
  absolute: string;
  containerPath: string[];
}

function describeContainer(ref: ContainerRef): string {
  return `${displaySafe(ref.absolute)} (${ref.containerPath.join(".")})`;
}

function hasYawMcpEntry(container: Record<string, unknown>): boolean {
  return ENTRY_NAME in container || LEGACY_ENTRY_NAMES.some((n) => n in container);
}

/** The server container at one path, or null when the file is absent,
 *  unreadable, not JSON, or holds no object there.
 *
 *  An unreadable container counts as NOT holding a yaw-mcp entry, and the two
 *  errors are not symmetric: a false "wired" removes originals the client can
 *  no longer reach, while a false "not wired" only refuses a removal that
 *  would have been safe. */
async function readContainer(ref: ContainerRef): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(ref.absolute, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return null;
  }
  let node: unknown = parsed;
  for (const key of ref.containerPath) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>) : null;
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
  const clientId = positional[0] as InstallClientId;
  // Validated HERE rather than left to resolveInstallSite: that helper answers
  // an unknown client by printing install's own multi-KB usage, which is not
  // the text an `import` typo should produce.
  if (!INSTALL_TARGETS.some((t) => t.clientId === clientId)) {
    return {
      ok: false,
      error: `yaw-mcp import: unknown client "${clientId}". Choose: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}`,
    };
  }
  opts.clientId = clientId;
  return { ok: true, options: opts };
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors runRemove's isInteractive. */
function isInteractive(opts: ImportCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask, defaulting to NO. EOF (a piped stdin running dry, ^D) is a decline
 *  rather than a hang -- the same contract `remove`'s confirmation documents. */
async function askYesNo(opts: ImportCommandOptions, question: string): Promise<string | QuestionCancelled> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const rl = createInterface({ input, output, terminal: opts.io?.terminal });
  try {
    const raw = await questionOrEmpty(rl, question);
    return raw === QUESTION_CANCELLED ? raw : raw.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** One candidate that actually reached bundles.json. */
interface ImportedEntry {
  candidate: ImportCandidate;
  /** The namespace the entry LANDED under -- taken from the entry as written,
   *  never from the derived one: a name-fallback merge keeps the stored
   *  namespace, and this is the identity the removal decision hangs on. */
  landed: string;
}

export async function runImport(opts: ImportCommandOptions): Promise<ImportCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const errOut = opts.err ?? ((s: string) => process.stderr.write(s));
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

  let raw: string;
  try {
    raw = await readFile(resolved.absolute, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    printErr(
      code === "ENOENT"
        ? `yaw-mcp import: ${displaySafe(resolved.absolute)} does not exist -- ${target.label} has no MCP servers configured at this scope.`
        : `yaw-mcp import: cannot read ${displaySafe(resolved.absolute)}: ${(e as Error).message}`,
    );
    return { exitCode: 1, written: [] };
  }

  let parsed: unknown;
  try {
    // parseJsonc, not JSON.parse: client configs are hand-edited and several
    // of these clients tolerate `//` comments. The same parser the loader and
    // the removal preview use, so this command cannot disagree with the write
    // path below about which files are readable.
    parsed = parseJsonc(raw);
  } catch (e) {
    printErr(`yaw-mcp import: ${displaySafe(resolved.absolute)} is not valid JSON (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    printErr(`yaw-mcp import: ${displaySafe(resolved.absolute)} is not a JSON object.`);
    return { exitCode: 1, written: [] };
  }

  // Walk the client's OWN container path -- `mcpServers` for most clients,
  // `servers` for VS Code, and `projects[<absDir>].mcpServers` for Claude Code
  // at local scope. Reading it off the resolved target is what keeps this
  // command from assuming a single spelling; pasting a Claude Code shape into
  // a VS Code file fails silently, which is the bug the table records.
  let container: unknown = parsed;
  for (const key of resolved.containerPath) {
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      container = undefined;
      break;
    }
    container = (container as Record<string, unknown>)[key];
  }
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    print(`\nNothing to import: no "${resolved.containerPath.join(".")}" object in ${displaySafe(resolved.absolute)}.`);
    return { exitCode: 0, written: [] };
  }

  // VS Code is the only client that declares its own variables in the file
  // being read (the `inputs` block), so it is the only one whose `${...}`
  // spans are interpreted here -- see toEntry.
  const isVsCode = target.clientId === "vscode";
  const vars: ClientVars | null = isVsCode ? { workspaceFolder: site.projectDir } : null;
  const inputs = isVsCode ? readVsCodeInputs(parsed as Record<string, unknown>) : new Map<string, string>();

  const candidates: ImportCandidate[] = [];
  const skippedSelf: string[] = [];
  const unusable: string[] = [];
  /** Servers refused over a `${...}` this importer cannot resolve, already
   *  rendered as "  <key>: <spans>" lines. */
  const unresolvable: string[] = [];
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    if (isSelfEntry(key)) {
      skippedSelf.push(key);
      continue;
    }
    const built = toEntry(key, value, vars);
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
  // looking at. Two things come out of it that the candidate cannot know on
  // its own: the namespace the file will hold (a stored entry matched by NAME
  // keeps its own, so printing the derived one named a namespace that would
  // never exist) and the launch command this write would replace.
  for (const c of candidates) {
    try {
      const preview = await previewUpsertUserBundle(c.entry, { home });
      for (const w of preview.warnings) warnOnce(w);
      c.plannedNamespace = preview.namespace ?? c.namespace;
      c.replacing = preview.replaced ? preview.replacing : undefined;
    } catch (e) {
      // A bundles.json that is present but unparseable. The write below throws
      // the same error and reports it per candidate; the plan just falls back
      // to the derived namespace rather than aborting a run that has not
      // touched anything yet.
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
    // client's copy winning. Naming what the write would overwrite is the only
    // thing standing between "adopt the servers I already had" and "replace
    // the launch command of one of them", which is arbitrary command execution
    // on the next activate.
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

  if (opts.dryRun) {
    print("\n--- dry run: nothing was written ---");
    return { exitCode: 0, written: [] };
  }

  const written: string[] = [];
  const results: ImportedEntry[] = [];
  /** Namespaces THIS run has already written, so a collision is not counted as
   *  an update of something that was there beforehand. */
  const writtenNamespaces = new Set<string>();
  let updated = 0;
  for (const c of candidates) {
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

  // Where a yaw-mcp entry could be. A client with more than one scope reads
  // more than one container -- Claude Code's user-scope `mcpServers` and its
  // local-scope `projects[<dir>].mcpServers` are both inside ~/.claude.json --
  // so searching only the container the servers came from reported "no yaw-mcp
  // entry" at a non-user scope while one sat in the same file, and the remedy
  // it printed (`yaw-mcp install <client>`, which writes the USER scope) fixed
  // nothing the message was about.
  //
  // The imported container is FIRST and is the copy already in memory, so the
  // single-scope clients read no extra files at all.
  const searched: ContainerRef[] = [{ absolute: resolved.absolute, containerPath: resolved.containerPath }];
  for (const spec of target.scopes) {
    if (spec.scope === site.scope) continue;
    try {
      const other = resolveInstallPath({
        clientId: target.clientId,
        scope: spec.scope,
        os: site.os,
        home,
        appData: resolveAppDataDir({ appData: opts.appData, home }),
        // The project the user is standing in -- the same resolution
        // resolveInstallSite would have made had that scope been the target.
        projectDir: spec.requiresProjectDir
          ? (site.projectDir ?? resolvePath(opts.cwd ?? process.cwd(), "."))
          : undefined,
        claudeConfigDir: opts.claudeConfigDir,
      });
      const already = searched.some(
        (r) => r.absolute === other.absolute && r.containerPath.join(".") === other.containerPath.join("."),
      );
      if (!already) searched.push({ absolute: other.absolute, containerPath: other.containerPath });
    } catch {
      // A scope this machine cannot resolve a path for is one the client is
      // not reading either, so it is simply not searched.
    }
  }
  let wiredIn: ContainerRef | null = null;
  for (let i = 0; i < searched.length; i++) {
    const found = i === 0 ? (container as Record<string, unknown>) : await readContainer(searched[i]);
    if (found && hasYawMcpEntry(found)) {
      wiredIn = searched[i];
      break;
    }
  }

  if (!wiredIn) {
    // The one case where removing is never right: with no yaw-mcp entry in the
    // client config, dropping the originals leaves the client unable to reach
    // ANY of them, and the import would read as a success while taking every
    // server offline. The containers are NAMED rather than the claim being
    // made about the client as a whole: "it has no entry" was a statement
    // about one container, made as though it covered every file the client
    // reads.
    printErr(
      `Not removing the originals: no yaw-mcp entry in ${searched.map(describeContainer).join(" or ")}, so ${target.label} would be left with no way to reach them. Run \`yaw-mcp install ${target.clientId}\` first, then re-run this with --remove-originals.`,
    );
    return { exitCode: 0, written };
  }
  if (wiredIn !== searched[0]) {
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

  // Peel the entries out of the RAW BYTES with jsonc-parser, one key at a
  // time, exactly as `uninstall` and `try-cleanup` do. A parse-and-reserialize
  // would take the user's comments -- and, in ~/.claude.json, the rest of
  // their Claude Code state -- with it.
  //
  // Each key is isolated. removeJsoncEntry refuses a key it cannot address (an
  // empty-string key is the shape that reaches it), and one loop-wide catch
  // meant that single key aborted the removal for EVERY other imported server,
  // under a message that named no key at all.
  let next = raw;
  let removed = 0;
  const unremovable: string[] = [];
  for (const r of imported) {
    try {
      const after = removeJsoncEntry(next, resolved.containerPath, r.candidate.key);
      if (after !== next) removed++;
      next = after;
    } catch (e) {
      unremovable.push(`${displayArg(r.candidate.key)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (unremovable.length > 0) {
    printErr(
      `yaw-mcp import: could not be removed from ${displaySafe(resolved.absolute)}: ${unremovable.join("; ")}. Remove ${unremovable.length === 1 ? "that entry" : "those entries"} by hand; ${target.label} would otherwise keep launching ${unremovable.length === 1 ? "it" : "them"} alongside yaw-mcp.`,
    );
  }
  if (removed === 0) {
    printErr(
      `yaw-mcp import: nothing was removed from ${displaySafe(resolved.absolute)}; it was left unchanged. The servers are imported either way.`,
    );
    return { exitCode: 0, written };
  }
  try {
    await atomicWriteFile(resolved.absolute, next.endsWith("\n") ? next : `${next}\n`);
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
