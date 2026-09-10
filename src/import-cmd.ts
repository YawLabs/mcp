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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
} from "./install-targets.js";
import { parseJsonc, removeJsoncEntry } from "./jsonc.js";
import { BundleCollisionError, deriveNamespace, upsertUserBundle } from "./local-bundles.js";
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

  AFTER AN IMPORT THE CLIENT STILL LAUNCHES THOSE SERVERS ITSELF, so you would
  be running each of them twice -- once directly, once through yaw-mcp. This
  command offers to remove the originals from the client config. On a terminal
  it asks (a bare Enter is NO); off one it leaves them alone and tells you the
  flag. It refuses to remove them at all if the client has no yaw-mcp entry,
  since that is the only way it would still reach them.

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
  namespace: string;
  entry: Partial<UpstreamServerConfig>;
  /** env / header key NAMES for the transcript. Never their values. */
  credentialKeys: string[];
}

/** String-valued entries of a raw map, or undefined when the field is absent
 *  or is not a plain object. Mirrors the loader's own tolerance: a garbage
 *  value is dropped rather than laundered into a well-formed one. */
function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
  return Object.keys(out).length > 0 ? out : undefined;
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
 */
function toEntry(
  key: string,
  value: unknown,
): { entry: Partial<UpstreamServerConfig>; credentialKeys: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const command = typeof v.command === "string" && v.command.trim() !== "" ? v.command : undefined;
  const url = typeof v.url === "string" && v.url.trim() !== "" ? v.url : undefined;
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
    const headers = stringMap(v.headers);
    // VS Code's `"type": "sse"`. Anything else (including "http") takes
    // yaw-mcp's own streamable-http default, which validateEntry applies when
    // the field is absent -- so it is left absent rather than being stamped,
    // keeping the entry the shortest true description of itself.
    const transport = v.type === "sse" ? ("sse" as const) : undefined;
    return {
      entry: { ...base, type: "remote", url, ...(transport ? { transport } : {}), ...(headers ? { headers } : {}) },
      credentialKeys: Object.keys(headers ?? {}),
    };
  }

  const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : undefined;
  const env = stringMap(v.env);
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
  };
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

export async function runImport(opts: ImportCommandOptions): Promise<ImportCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const errOut = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => errOut(`${s}\n`);

  const home = opts.home ?? homedir();
  const site = resolveInstallSite("import", { ...opts, home }, printErr);
  if (!site) return { exitCode: 2, written: [] };
  const { target, resolved } = site;

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

  const candidates: ImportCandidate[] = [];
  const skippedSelf: string[] = [];
  const unusable: string[] = [];
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    if (isSelfEntry(key)) {
      skippedSelf.push(key);
      continue;
    }
    const built = toEntry(key, value);
    if (!built) {
      unusable.push(key);
      continue;
    }
    candidates.push({
      key,
      namespace: built.entry.namespace as string,
      entry: built.entry,
      credentialKeys: built.credentialKeys,
    });
  }

  if (candidates.length === 0) {
    print(`\nNothing to import: no servers in ${displaySafe(resolved.absolute)} beyond yaw-mcp's own entry.`);
    if (unusable.length > 0) {
      printErr(`Skipped (no command or url to launch): ${unusable.map(displayArg).join(", ")}`);
    }
    return { exitCode: 0, written: [] };
  }

  // Two client keys can derive ONE namespace ("my-tool" and "My Tool" both
  // land on "mytool"), and the second write silently replaces the first. The
  // old cloud-era import reported this and it is worth keeping: the user
  // cannot otherwise tell which of the two survived.
  const byNamespace = new Map<string, string[]>();
  for (const c of candidates) byNamespace.set(c.namespace, [...(byNamespace.get(c.namespace) ?? []), c.key]);
  const collisions = [...byNamespace.entries()].filter(([, keys]) => keys.length > 1);

  print("");
  print(`Servers to import (${candidates.length}):`);
  for (const c of candidates) {
    const launch =
      c.entry.command !== undefined
        ? `$ ${[c.entry.command, ...(c.entry.args ?? [])].map(displayArg).join(" ")}`
        : `HTTP ${displaySafe(c.entry.url ?? "")}`;
    print(`  ${displayArg(c.key)} -> ${c.namespace}`);
    print(`    ${launch}`);
    // Key NAMES only. A client config is where the credentials are, and this
    // transcript goes on a terminal and into bug reports.
    if (c.credentialKeys.length > 0) {
      print(`    carries: ${c.credentialKeys.map(displayArg).join(", ")} (values copied, not shown)`);
    }
  }
  if (skippedSelf.length > 0) print(`\nSkipped yaw-mcp's own entries: ${skippedSelf.map(displayArg).join(", ")}`);
  if (unusable.length > 0) {
    printErr(`Skipped (no command or url to launch): ${unusable.map(displayArg).join(", ")}`);
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
  const imported: ImportCandidate[] = [];
  let updated = 0;
  for (const c of candidates) {
    try {
      const res = await upsertUserBundle(c.entry, { home });
      for (const w of res.warnings) printErr(`warning: ${w}`);
      if (res.replaced) updated++;
      imported.push(c);
      if (!written.includes(res.path)) written.push(res.path);
    } catch (e) {
      // A cross-slug collision against a CATALOG server already in the file.
      // Reported and skipped rather than fatal: the remaining candidates are
      // unrelated and importing them is still the right outcome.
      const message = e instanceof BundleCollisionError ? e.message : (e as Error).message;
      printErr(`yaw-mcp import: skipped "${displayArg(c.key)}": ${message}`);
    }
  }

  if (imported.length === 0) {
    printErr("yaw-mcp import: nothing was imported.");
    return { exitCode: 1, written };
  }

  print("");
  print(
    `Imported ${imported.length} server${imported.length === 1 ? "" : "s"} into ${displaySafe(written[0] ?? "bundles.json")}${updated > 0 ? ` (${updated} updated, ${imported.length - updated} added)` : ""}.`,
  );
  if (imported.some((c) => c.credentialKeys.length > 0)) {
    const names = [...new Set(imported.flatMap((c) => c.credentialKeys))];
    print(
      `Credentials came across as plain values: ${names.map(displayArg).join(", ")}. Move each one into the vault with \`yaw-mcp secrets set NAME\`, then \`yaw-mcp set <server> env.KEY='\${secret:NAME}'\`.`,
    );
  }

  // ----- the duplicate-run trap -----------------------------------------
  //
  // The client is STILL launching every one of these directly. Nothing about
  // the import changed that, so without this step the user now runs each
  // imported server twice: once from the client, once from yaw-mcp.
  const containerRecord = container as Record<string, unknown>;
  const wiredToYawMcp = ENTRY_NAME in containerRecord || LEGACY_ENTRY_NAMES.some((n) => n in containerRecord);
  print("");
  print(
    `${target.label} still launches ${imported.length === 1 ? "that server" : "those servers"} itself, so ${imported.length === 1 ? "it" : "they"} would now run twice -- once directly, once through yaw-mcp.`,
  );

  if (opts.keepOriginals) {
    print(`Left ${displaySafe(resolved.absolute)} alone (--keep-originals).`);
    return { exitCode: 0, written };
  }

  if (!wiredToYawMcp) {
    // The one case where removing is never right: with no yaw-mcp entry in the
    // client config, dropping the originals leaves the client unable to reach
    // ANY of them, and the import would read as a success while taking every
    // server offline.
    printErr(
      `Not removing the originals: ${target.label} has no yaw-mcp entry, so it would be left with no way to reach them. Run \`yaw-mcp install ${target.clientId}\` first, then re-run this with --remove-originals.`,
    );
    return { exitCode: 0, written };
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
  let next = raw;
  try {
    for (const c of imported) next = removeJsoncEntry(next, resolved.containerPath, c.key);
  } catch (e) {
    printErr(
      `yaw-mcp import: could not remove the entries from ${displaySafe(resolved.absolute)} (${(e as Error).message}). It was left unchanged; the servers are imported either way.`,
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
    `Removed ${imported.length} entr${imported.length === 1 ? "y" : "ies"} from ${displaySafe(resolved.absolute)}. Restart ${target.label} so it picks up the change.`,
  );
  return { exitCode: 0, written };
}
