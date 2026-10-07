// `yaw-mcp set <slug-or-namespace> <key=value> ...`, plus the `enable` /
// `disable` sugar over `isActive`.
//
// WHY THIS EXISTS. Until now nothing could change a per-server field from the
// CLI: `add` writes an entry, `remove` deletes one, and everything between was
// a hand edit of ~/.yaw-mcp/bundles.json -- a file `add`/`remove` then rewrite
// wholesale, dropping the comments the user put there. Two `add` output
// branches said so outright ("Set it to true there to enable it"), because
// there was no verb to point at.
//
// WHY IT DOES NOT USE THE EXISTING WRITE PATH. upsertUserBundle and
// removeUserBundle serialize the whole file with JSON.stringify, which is a
// LOSSY REWRITE: comments and unknown top-level keys go. That is an accepted
// trade for add/remove, which change what the file CONTAINS. `set` changes one
// field of one entry, so the same trade would mean losing a user's annotations
// to flip a boolean. It splices instead, through editJsoncPath.
//
// WHAT IS SETTABLE, AND WHY THE LIST IS SHORT. isActive, pinned, runtime,
// connectTimeoutMs, description and individual env keys. Not namespace,
// command, args, url, transport or type: those decide WHICH PROGRAM yaw-mcp
// spawns as the user, and they belong to `add`/`remove` or to a deliberate
// edit, not to a one-line set whose argument lands in shell history.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { atomicWriteFile } from "./atomic-write.js";
import { ENV_KEY_RE } from "./catalog.js";
import { editJsoncPath, parseJsonc } from "./jsonc.js";
import {
  deriveNamespace,
  findShadowingProjectBundles,
  isRemoteEntry,
  jsonErrorLocation,
  localBundlesPath,
  namespacesForStoredIdentity,
  STORED_TARGET_RE,
  serializeBundleWrite,
  withBundlesLock,
} from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { userConfigDir } from "./paths.js";
import { askYesNo, QUESTION_CANCELLED } from "./readline-question.js";
import { runSecrets } from "./secrets-cmd.js";
import { SECRET_NAME_RE, SECRET_REF_RE } from "./secrets-vault.js";
import { MAX_TIMEOUT_MS } from "./timeouts.js";
// The shadow note prints a path straight off the filesystem walk, like the
// one `add` prints -- same neutering, imported from the same place.
import { displaySafe } from "./trust-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

export const SET_USAGE = `Usage: yaw-mcp set <slug-or-namespace> <key=value> [<key=value> ...] [flags]
       yaw-mcp set <slug-or-namespace> env.KEY --secret [--secret-name NAME] [--stdin] [flags]

  Change per-server fields in your local ~/.yaw-mcp/bundles.json without
  hand-editing it. Only the entry you name is rewritten -- comments,
  formatting and every other entry keep their bytes.

  <slug-or-namespace> is the catalog slug the server was added with (e.g.
  "brave-search"), its namespace as shown by \`yaw-mcp list\` (e.g.
  "bravesearch"), or its NAME from that same listing (e.g. "Brave Search") --
  the same target \`yaw-mcp remove\` takes. The name is the handle an imported
  server has, since it carries no catalog slug.

Settable keys:
  isActive=true|false   Load this server, or keep it out of the set.
                        \`yaw-mcp enable\` / \`disable\` is the same edit.
  pinned=true|false     Exempt this server from the idle reaper, which
                        otherwise unloads an upstream that has sat through
                        ~10 tool calls aimed elsewhere. Worth setting on a
                        server that is expensive to START (a browser, a
                        language server, anything that indexes on boot),
                        where the re-spawn costs more than the memory.
                        Pinning keeps a LOADED server loaded; it does not
                        pre-load one. Default false.
  runtime=oam|node      Host this server on the oam runtime, or keep it on
                        node/npx. \`runtime=\` clears it, restoring the machine
                        default (see YAW_MCP_DEFAULT_RUNTIME).
  connectTimeoutMs=<n>  Whole milliseconds to wait for this server's MCP
                        handshake, overriding MCP_CONNECT_TIMEOUT.
                        \`connectTimeoutMs=\` clears it.
  description=<text>    Free text the ranker reads when routing. Stored
                        verbatim, so \`description=true\` stores the word.
                        \`description=\` clears it.
  env.KEY=<value>       Set ONE environment variable, leaving the rest of this
                        server's env alone. \`env.KEY=\` REMOVES that variable.
                        A stored value does not come back either way, so
                        REPLACING one is confirmed on a TTY just as clearing it
                        is. For a real credential, use \`env.KEY --secret\`
                        below instead: the vault resolves it at launch and
                        only the reference is written.
                        Local (stdio) servers only -- a remote server spawns no
                        process, so its credentials live in "headers" and this
                        key is refused on one.
  env.KEY --secret      Store a credential in the encrypted vault and point
                        env.KEY at it, in one step. The value is read the way
                        \`yaw-mcp secrets set\` reads it: a no-echo prompt at
                        a terminal, or a piped stdin read whole -- never from
                        argv, so \`env.KEY=<value> --secret\` is refused. The
                        vault entry is named, in order:
                          1. --secret-name NAME, when given;
                          2. the NAME env.KEY already references, when its
                             value is exactly '\${secret:NAME}' (so re-running
                             rotates the same entry);
                          3. otherwise <namespace>_<KEY>, lowercased -- e.g.
                             \`set gh env.GITHUB_TOKEN --secret\` stores
                             "gh_github_token". Two keys can derive one name
                             (GITHUB_TOKEN and github_token; namespace "a_b"
                             with KEY C and "a" with B_C), so a derived name
                             another env value or header in bundles.json
                             already references is refused: pass
                             --secret-name.
                        Then env.KEY='\${secret:NAME}' is written to the entry.
                        A vault name that already exists is REPLACED
                        (confirmed on a TTY; scripted runs proceed and say
                        "Replaced"). Takes exactly this one argument.

  Every other key is refused, including namespace, command, args, url,
  transport and type: those decide which program yaw-mcp spawns as you, and
  they belong to \`yaw-mcp add\` / \`remove\` or a deliberate edit of
  bundles.json, not to a one-line set. A value lands in your shell history
  and process argv like any argument.

Flags:
  --force, -y, --yes  Skip the confirmation for an edit that destroys a stored
                      env value -- a clear, or an overwrite. Required when
                      stdin or stdout is not a TTY. With --secret it also
                      skips the vault's replace confirmation, never the
                      vault passphrase.
  --secret            See env.KEY --secret above.
  --secret-name NAME  The vault entry name for --secret (letters, digits,
                      "_", "." or "-").
  --stdin             With --secret: read the value from stdin whole even at
                      a terminal, instead of the no-echo prompt.
  --json              Emit the result as JSON. env values are never printed.
                      A refused or declined confirmation emits an
                      {"ok":false,...} envelope on stderr, so a script never
                      has to read prose to tell why nothing was written.
`;

export const ENABLE_USAGE = `Usage: yaw-mcp enable <slug-or-namespace> [--json]

  Mark a server in ~/.yaw-mcp/bundles.json loadable ("isActive": true).
  Exactly \`yaw-mcp set <slug-or-namespace> isActive=true\`, and it takes the
  same target \`yaw-mcp remove\` does. Comments in the file survive.
`;

export const DISABLE_USAGE = `Usage: yaw-mcp disable <slug-or-namespace> [--json]

  Keep a server in ~/.yaw-mcp/bundles.json out of the loaded set
  ("isActive": false) without removing it -- the entry, and any env value
  stored on it, stay put. Exactly \`yaw-mcp set <slug-or-namespace>
  isActive=false\`. Re-enable with \`yaw-mcp enable\`. Comments survive.
`;

// The target shape is STORED_TARGET_RE (local-bundles.ts), the same constant
// `remove` gates on, and applied at the same point in the flow: only AFTER
// the identity lookup has failed, so an entry whose stored display NAME is
// the target still resolves (see runSet).

/** Scalar fields a `set` may touch. Deliberately not a superset of
 *  validateEntry's whitelist -- see the module header on why the launch
 *  fields are excluded. */
const SETTABLE_SCALARS = new Set(["isActive", "pinned", "runtime", "connectTimeoutMs", "description"]);

export interface SetCommandOptions {
  target?: string;
  /** Raw `key=value` arguments, in the order the user gave them. */
  assignments?: string[];
  json?: boolean;
  force?: boolean;
  /** `env.KEY --secret`: the one assignment is a bare `env.KEY`, its value
   *  goes to the vault and the entry gets the `${secret:NAME}` reference. */
  secret?: boolean;
  /** `--secret-name NAME`; derived when absent (see secretNameFor). */
  secretName?: string;
  /** `--stdin`: runSecrets's `fromStdin` -- read the value from stdin whole
   *  even at a terminal. Only with --secret. */
  fromStdin?: boolean;
  /** The vault passphrase, handed to runSecrets as its embedder/test hook.
   *  The CLI parser never sets it: the env var or the TTY prompt does. */
  passphrase?: string;
  home?: string;
  /** For the shadow check only -- `set` always writes the user-global file.
   *  A project bundles.json fully REPLACES that file on load, so an edit made
   *  while one is in effect is real on disk and invisible in the session. */
  cwd?: string;
  /** Passed explicitly to the shadow check rather than defaulted inside it:
   *  the verdict is trust-aware and YAW_MCP_TRUST_PROJECT is the documented
   *  bypass, so reading process.env there would answer for a different
   *  environment than the one this command was told to run under. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test seams, mirroring RemoveCommandOptions. */
  isTTY?: boolean;
  promptAnswer?: string;
  io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; terminal?: boolean };
  /** The verb the USER typed, for the message prefix. `enable` and `disable`
   *  are sugar that delegates to runSet, and every diagnostic here used to say
   *  `yaw-mcp set:` -- so `yaw-mcp enable nosuch` reported a failure of a
   *  command the user never ran. Defaults to "set", which is what a direct
   *  `yaw-mcp set` invocation (and any caller that omits it) gets. */
  verb?: "set" | "enable" | "disable";
}

export interface SetCommandResult {
  exitCode: number;
  written: string[];
}

/** One requested edit, parsed but not yet applied. */
interface Assignment {
  /** "isActive" | "pinned" | "runtime" | "connectTimeoutMs" | "description" | "env" */
  field: string;
  /** Present only for env: the variable name. */
  key?: string;
  /** The value to write, or undefined to CLEAR the field. */
  value?: string | number | boolean;
  /** The literal the user typed, for error text. */
  raw: string;
}

export function parseSetArgs(
  argv: string[],
): { ok: true; options: SetCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SetCommandOptions = { assignments: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--force" || a === "-y" || a === "--yes") opts.force = true;
    else if (a === "--secret") opts.secret = true;
    else if (a === "--stdin") opts.fromStdin = true;
    else if (a === "--secret-name") {
      const v = argv[++i];
      // A following flag is a MISSING name, not a vault entry called "--json"
      // -- the rule `secrets --value` applies to the same mistake.
      if (v === undefined || v.startsWith("-")) {
        return { ok: false, error: `yaw-mcp set: --secret-name requires a name.\n${SET_USAGE}` };
      }
      opts.secretName = v;
    }
    // help:true so the dispatcher routes usage to STDOUT and exits 0. Without
    // it, `yaw-mcp set --help` printed to stderr and exited 2 -- a help request
    // answered as an error.
    else if (a === "--help" || a === "-h") return { ok: false, error: SET_USAGE, help: true };
    else if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${SET_USAGE}` };
    else positional.push(a);
  }
  if (positional.length === 0) return { ok: false, error: SET_USAGE };
  opts.target = positional[0];
  opts.assignments = positional.slice(1);
  if (opts.assignments.length === 0) {
    return {
      ok: false,
      error: `yaw-mcp set: nothing to set -- pass at least one key=value${opts.secret ? " (or env.KEY with --secret)" : ""}.\n${SET_USAGE}`,
    };
  }
  // Checked HERE, before any prompt, as well as in runSet (the backstop for
  // a programmatic caller): a refusal after the passphrase and the value
  // prompt would cost the user both to hear the argument was never valid.
  const secretError = checkSecretArgs(opts);
  if (secretError) return { ok: false, error: secretError };
  return { ok: true, options: opts };
}

/** Why a `--secret` / `--secret-name` invocation is malformed, or null when it
 *  is fine (or not one). The value of a --secret write never comes from argv
 *  -- it would land in shell history and `ps`, the leak the vault exists to
 *  close -- so an inline `=value` is refused rather than stored. */
function checkSecretArgs(opts: SetCommandOptions): string | null {
  if (opts.secretName !== undefined && !opts.secret) {
    return "yaw-mcp set: --secret-name only applies with --secret.";
  }
  if (opts.fromStdin && !opts.secret) {
    return "yaw-mcp set: --stdin only applies with --secret -- a plain value is given as key=value.";
  }
  if (!opts.secret) return null;
  const assignments = opts.assignments ?? [];
  if (assignments.length !== 1) {
    return `yaw-mcp set: --secret takes exactly one env.KEY (got ${assignments.length} ${assignments.length === 1 ? "argument" : "arguments"}) -- set other fields in a separate run.`;
  }
  const raw = assignments[0];
  if (!raw.startsWith("env.")) {
    // header.NAME is not offered: `set` has no header path at all (a remote
    // server's headers go through `add --header`), see the remote refusal in
    // runSet.
    return `yaw-mcp set: --secret applies to an env.KEY only (got "${raw}").`;
  }
  if (raw.includes("=")) {
    return `yaw-mcp set: --secret reads the value from a prompt or stdin, never from the command line -- pass "${raw.slice(0, raw.indexOf("="))}" without "=<value>".`;
  }
  const key = raw.slice(4);
  if (!ENV_KEY_RE.test(key)) {
    return `yaw-mcp set: "${key}" is not a valid environment variable name (letters, digits and underscores, not starting with a digit).`;
  }
  if (opts.secretName !== undefined && !SECRET_NAME_RE.test(opts.secretName)) {
    return `yaw-mcp set: invalid secret name "${opts.secretName}" -- use letters, digits, "_", "." or "-" only.`;
  }
  return null;
}

/** `${secret:NAME}` and nothing else, anchored. Built from SECRET_REF_RE's
 *  own source rather than re-spelling the name class. */
const WHOLE_SECRET_REF_RE = new RegExp(`^${SECRET_REF_RE.source}$`);

/** The vault entry name for `env.KEY --secret`, by the rule SET_USAGE
 *  documents: an explicit --secret-name; else the name env.KEY already
 *  references, so a second run ROTATES that entry instead of minting a new
 *  one and orphaning the old; else `<namespace>_<key>` lowercased. That last
 *  one is qualified by the key even when the server has a single credential:
 *  a rule that keyed on how many credentials the entry carries would name the
 *  same key differently after a sibling was added. Null when the derived
 *  name is not a valid vault name (a hand-written namespace can carry
 *  anything) -- the caller asks for --secret-name. */
function secretNameFor(explicit: string | undefined, stored: unknown, namespace: string, key: string): string | null {
  if (explicit !== undefined) return explicit;
  if (typeof stored === "string") {
    const m = WHOLE_SECRET_REF_RE.exec(stored);
    if (m) return m[1];
  }
  const derived = `${namespace}_${key}`.toLowerCase();
  return SECRET_NAME_RE.test(derived) ? derived : null;
}

/** Every OTHER place in bundles.json that already references `ref`, as
 *  "<namespace> env.KEY" / "<namespace> header NAME". A derived name is not
 *  one-to-one -- GITHUB_TOKEN and github_token on one server, or namespace
 *  "a_b" + KEY C and "a" + KEY B_C, lowercase to the same name -- and a
 *  scripted replace proceeds without asking, so storing under a derived name
 *  something else points at would silently swap that credential too. */
function otherReferences(rawText: string, ref: string, namespace: string, key: string): string[] {
  let servers: unknown;
  try {
    servers = (parseJsonc(rawText) as { servers?: unknown } | null)?.servers;
  } catch {
    return [];
  }
  if (!Array.isArray(servers)) return [];
  const found: string[] = [];
  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    const ns = String((s as { namespace?: unknown }).namespace);
    for (const [field, label] of [
      ["env", "env."],
      ["headers", "header "],
    ] as const) {
      const map = (s as Record<string, unknown>)[field];
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [k, v] of Object.entries(map)) {
        if (field === "env" && ns === namespace && k === key) continue;
        if (typeof v === "string" && v.includes(ref)) found.push(`${ns} ${label}${k}`);
      }
    }
  }
  return found;
}

/** `enable` / `disable` take a TARGET and no assignment -- the verb IS the
 *  assignment. They cannot share parseSetArgs, which requires at least one
 *  `key=value` and so rejected every legitimate invocation of both verbs.
 *  They keep their own usage text for the same reason: SET_USAGE documents an
 *  argument these do not take. */
export function parseToggleArgs(
  argv: string[],
  enabled: boolean,
): { ok: true; options: SetCommandOptions & { enabled: boolean } } | { ok: false; error: string; help?: boolean } {
  const usage = enabled ? ENABLE_USAGE : DISABLE_USAGE;
  const verb = enabled ? "enable" : "disable";
  const opts: SetCommandOptions & { enabled: boolean } = { enabled, assignments: [] };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: usage, help: true };
    else if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${usage}` };
    else positional.push(a);
  }
  if (positional.length === 0) return { ok: false, error: usage };
  if (positional.length > 1) {
    return {
      ok: false,
      error: `yaw-mcp ${verb}: expected exactly one server, got ${positional.length}.\n${usage}`,
    };
  }
  opts.target = positional[0];
  return { ok: true, options: opts };
}

/** Parse one `key=value`, deciding the TYPE from the FIELD rather than from
 *  the shape of the text. `description=true` stores the word "true"; a bare
 *  `isActive=true` is a boolean. Guessing from the text would make the two
 *  disagree. */
function parseAssignment(raw: string): { ok: true; value: Assignment } | { ok: false; error: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    return { ok: false, error: `yaw-mcp set: "${raw}" is not a key=value pair.` };
  }
  const key = raw.slice(0, eq);
  const text = raw.slice(eq + 1);

  if (key.startsWith("env.")) {
    const name = key.slice(4);
    if (name === "") return { ok: false, error: `yaw-mcp set: "${raw}" names no environment variable.` };
    // The same shell-identifier rule `add --env` applies (ENV_KEY_RE): this
    // accepted any non-empty name, so `set gh env.9X=1` and `env.A-B=1` wrote
    // keys no shell can export, which then rode along to the spawn env.
    if (!ENV_KEY_RE.test(name)) {
      return {
        ok: false,
        error: `yaw-mcp set: "${name}" is not a valid environment variable name (letters, digits and underscores, not starting with a digit).`,
      };
    }
    // Trimmed, and a blank means CLEAR rather than "store an empty string":
    // the loader drops blank env values anyway, so storing one would write a
    // key that can never take effect.
    const trimmed = text.trim();
    return { ok: true, value: { field: "env", key: name, value: trimmed === "" ? undefined : trimmed, raw } };
  }

  if (!SETTABLE_SCALARS.has(key)) {
    return {
      ok: false,
      error: `yaw-mcp set: "${key}" is not settable. Settable: isActive, pinned, runtime, connectTimeoutMs, description, env.KEY.`,
    };
  }

  // isActive and pinned are the two booleans, and they take the same argument
  // shape for the same reason: absent already MEANS one of the two values
  // (isActive absent = true, pinned absent = false), so there is no third state
  // for a `key=` clear to express. The default each one falls back to is the
  // caller's business -- see the `current` computation in runSet.
  if (key === "isActive" || key === "pinned") {
    if (text === "true") return { ok: true, value: { field: key, value: true, raw } };
    if (text === "false") return { ok: true, value: { field: key, value: false, raw } };
    return { ok: false, error: `yaw-mcp set: ${key} must be exactly "true" or "false" (got "${text}").` };
  }

  if (key === "runtime") {
    if (text === "") return { ok: true, value: { field: key, value: undefined, raw } };
    if (text === "oam" || text === "node") return { ok: true, value: { field: key, value: text, raw } };
    return { ok: false, error: `yaw-mcp set: runtime must be "oam" or "node" (got "${text}").` };
  }

  if (key === "connectTimeoutMs") {
    if (text === "") return { ok: true, value: { field: key, value: undefined, raw } };
    if (!/^[0-9]+$/.test(text)) {
      return {
        ok: false,
        error: `yaw-mcp set: connectTimeoutMs must be a whole number of milliseconds (got "${text}").`,
      };
    }
    const n = Number(text);
    // Refused rather than accepted-and-clamped: the connect path silently caps
    // at MAX_TIMEOUT_MS, so writing a larger value would store a number the
    // spawn then quietly replaces.
    if (n < 1 || n > MAX_TIMEOUT_MS) {
      return { ok: false, error: `yaw-mcp set: connectTimeoutMs must be in 1..${MAX_TIMEOUT_MS} (got ${n}).` };
    }
    return { ok: true, value: { field: key, value: n, raw } };
  }

  // description: verbatim, untrimmed. A blank clears it.
  return { ok: true, value: { field: "description", value: text === "" ? undefined : text, raw } };
}

function isInteractive(opts: SetCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function render(value: unknown): string {
  return value === undefined ? "unset" : JSON.stringify(value);
}

/** English for the SHAPE of a value read out of the user's file, for an error
 *  about a field whose type is wrong. `typeof` alone calls null and an array
 *  "object", and those two are exactly the shapes a hand edit produces -- the
 *  reader needs to know WHICH one to go fix. */
function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t === "undefined") return "absent";
  return t === "object" ? "an object" : `a ${t}`;
}

export async function runSet(opts: SetCommandOptions): Promise<SetCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const verb = opts.verb ?? "set";

  const target = opts.target ?? "";
  // Shape-gated below, AFTER the file has been read, for the reason `remove`
  // gives at the same spot: a display name can carry spaces, capitals and dots
  // and is the only identity an imported server has, so refusing on shape
  // first would make every one of them unsettable. An empty target is refused
  // here, before any read -- nothing on disk answers to "".
  //
  // `verb`, not a hardcoded "set": this runner also serves `enable` and
  // `disable`, and naming a command the user did not type sends them reading
  // the wrong --help.
  if (target === "") {
    printErr(`yaw-mcp ${verb}: "${target}" is not a valid server name.`);
    return { exitCode: 2, written: [] };
  }

  // A --secret run's one argument is a bare `env.KEY`, which parseAssignment
  // would refuse as "not a key=value pair" -- so it is checked by its own rule
  // and turned into an assignment once the vault name is known.
  const secretError = checkSecretArgs(opts);
  if (secretError) {
    printErr(secretError);
    return { exitCode: 2, written: [] };
  }

  const assignments: Assignment[] = [];
  for (const raw of opts.secret ? [] : (opts.assignments ?? [])) {
    const parsed = parseAssignment(raw);
    if (!parsed.ok) {
      printErr(parsed.error);
      return { exitCode: 2, written: [] };
    }
    assignments.push(parsed.value);
  }

  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  if (!existsSync(path)) {
    printErr(
      `yaw-mcp ${verb}: no servers configured yet (${path} does not exist). Add one with \`yaw-mcp add <slug>\`.`,
    );
    return { exitCode: 1, written: [] };
  }

  const ctx: SetContext = { verb, target, path, home, print, printErr, err };
  if (opts.secret) return runSetSecret(opts, ctx);

  // Both serializers the write-path header in local-bundles.ts names: the
  // in-process chain (serializeBundleWrite) and the cross-process lock. The
  // lock alone left `set` able to interleave with an in-process upsert --
  // real for an embedded caller or a test that runs the verbs back to back.
  return serializeBundleWrite(() =>
    withBundlesLock(home, async () => {
      const loc = await locateEntry(ctx, assignments);
      if (!loc.ok) return loc.result;
      const projected = projectEnv(ctx, loc, assignments);
      if (!projected.ok) return projected.result;
      const refused = await confirmDestructive(opts, ctx, loc, projected.env, assignments);
      if (refused) return refused;
      return applyAssignments(opts, ctx, loc, assignments);
    }),
  );
}

/** What every phase of a `set` run shares: who is asking, about what, where
 *  the file is, and the two sinks. */
interface SetContext {
  verb: "set" | "enable" | "disable";
  target: string;
  path: string;
  home: string;
  print: (s?: string) => void;
  printErr: (s: string) => void;
  /** The raw stderr sink, for runSecrets, whose lines carry their own newline. */
  err: (s: string) => void;
}

/** The entry a run resolved to, read straight off the file. */
interface LocatedEntry {
  ok: true;
  rawText: string;
  idx: number;
  entry: Record<string, unknown>;
  namespace: string;
  /** PROTOTYPE-LESS copy of the entry's env -- see the note where it is built. */
  originalEnv: Record<string, unknown>;
}

type Refused = { ok: false; result: SetCommandResult };

/** Read and parse bundles.json, resolve the target, and refuse an entry the
 *  assignments cannot apply to (a remote server for env, a non-map env).
 *  Read-only: a --secret run calls it OUTSIDE the lock to refuse before any
 *  prompt, then again inside it. */
async function locateEntry(ctx: SetContext, assignments: Assignment[]): Promise<LocatedEntry | Refused> {
  const { verb, target, path, printErr } = ctx;
  const refuse = (exitCode: number): Refused => ({ ok: false, result: { exitCode, written: [] } });
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (e) {
    // A DIRECTORY at the bundles.json path is not a permissions problem, and
    // the raw errno ("EISDIR: illegal operation on a directory, read") reads
    // as one. `add` and `remove` already name the shape -- readRawUserBundles
    // in local-bundles.ts turns the same EISDIR into "is a directory, not a
    // file" -- so `set` says that sentence too rather than being a third
    // spelling of one fault. Every other read failure keeps the errno, which
    // is what a permissions problem actually needs.
    if ((e as NodeJS.ErrnoException).code === "EISDIR") {
      printErr(`yaw-mcp ${verb}: ${path} is a directory, not a file -- move or remove it, then re-run.`);
      return refuse(1);
    }
    printErr(`yaw-mcp ${verb}: ${path} could not be read (${(e as Error).message}).`);
    return refuse(1);
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(rawText);
  } catch (e) {
    // A position, never the parser's message: V8 quotes a slice of the source
    // around the bad token, and the usual bad token is a credential pasted in
    // unquoted. See jsonErrorLocation.
    printErr(
      `yaw-mcp ${verb}: ${path} could not be parsed -- fix the JSON before setting fields (invalid JSON ${jsonErrorLocation(rawText, e)}).`,
    );
    return refuse(1);
  }
  const servers = (parsed as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(servers)) {
    printErr(`yaw-mcp ${verb}: ${path} has no "servers" array.`);
    // Its sibling above (no file at all) ends on what to do; this one stopped
    // at the diagnosis. The fix is NOT "run `yaw-mcp add`": add refuses this
    // same file ("'servers' must be an array -- file ignored"), so pointing
    // there would hand the user a second failure. Repairing the array by hand
    // is what works, and deleting the file makes `add` recreate it from
    // scratch.
    printErr(
      `  Add a top-level "servers": [] to that file (or delete the file, and \`yaw-mcp add <slug>\` will recreate it).`,
    );
    return refuse(1);
  }

  // Same resolution order as `remove`, through the SAME helper: the literal
  // target, then any entry whose stored slug or display name matches, then
  // the namespace `add` would have derived. Two hand-written copies of that
  // scan is how the two verbs stopped taking the same target.
  const byIdentity = namespacesForStoredIdentity(target, servers);
  const candidates = [...new Set([target, ...byIdentity, deriveNamespace(target)])];
  let idx = -1;
  for (const cand of candidates) {
    idx = servers.findIndex((s) => (s as { namespace?: unknown } | null)?.namespace === cand);
    if (idx >= 0) break;
  }
  // Shape gate, demoted below the lookup exactly as `remove`'s is: an
  // odd-shaped target that no stored entry answers to is a usage error (exit
  // 2), while one that IS a stored display name resolves. Ordering it before
  // the read refused every imported server by its own name.
  if (idx < 0 && !STORED_TARGET_RE.test(target)) {
    // ${verb}, like the two sibling refusals in this runner. This one was
    // missed when those were fixed, so `enable`/`disable` still named `set`
    // here -- a command the user did not type, sending them to the wrong
    // --help. Three copies of one message is why it drifted; they are only
    // consistent because a test now asserts all three.
    printErr(`yaw-mcp ${verb}: "${target}" is not a valid server name.`);
    return refuse(2);
  }
  if (idx < 0) {
    printErr(
      `yaw-mcp ${verb}: no server named "${target}" in ${path}. Run \`yaw-mcp list\` to see what is configured.`,
    );
    return refuse(1);
  }

  const entry = servers[idx] as Record<string, unknown>;
  const namespace = String(entry.namespace);

  // A hand-edited or foreign-written entry can carry an "env" that is not a
  // map -- `null`, an array, a bare string. The LOADER tolerates it (a
  // non-object env is ignored, so the entry still loads), which is exactly
  // why one survives long enough to reach this command. Every env path below
  // assumes an object: the set branch hands ["servers", i, "env", KEY] to
  // jsonc-parser, whose setProperty throws `Can not add index to parent of
  // type null`, and the clear branch is no safer -- its guard only checks the
  // LIVE map's value, and the spread that builds that map turns a string env
  // into index keys, so `env.0=` on "oops" throws the same way. Reject it
  // ONCE here, naming the file and the field, the way the missing "servers"
  // array above is rejected: `set` exists to service hand-edited
  // bundles.json, so a bad shape in that file is the thing it should NAME
  // rather than surface a parser internal over. Scoped to runs that actually
  // target env -- a scalar edit on such an entry is well-defined, and
  // refusing it would make this guard a bigger change than the bug.
  const envAssignments = assignments.filter((a) => a.field === "env");

  // A REMOTE entry has no env to set. It spawns no process, so upstream.ts
  // ignores `env` on it outright -- and since the credential for such a
  // server travels in `headers`, `set <remote> env.KEY=` could never reach
  // the thing a user clearing a credential is aiming at. The old behaviour
  // wrote the key anyway and reported "env.KEY: set", which is the CLI
  // claiming an edit that changes nothing the server will ever see.
  //
  // REFUSED rather than redirected onto headers: a header is the remote
  // server's credential channel, and `add --header` (which validates the
  // field name, refuses a blank value, and rejects a CR/LF/NUL that Node's
  // Headers would throw on) is the vetted way in. A `set` that silently
  // rewrote `env.X` as a header would bypass all three checks.
  //
  // isRemoteEntry, not a local `url !== undefined` test: that predicate is
  // types.ts's, the one upstream.ts and doctor route on, so this refusal
  // cannot disagree with the reader about which entries have no env.
  if (envAssignments.length > 0 && isRemoteEntry(entry as Partial<UpstreamServerConfig>)) {
    const targeted = envAssignments.map((a) => `env.${a.key}`).join(", ");
    printErr(`yaw-mcp ${verb}: "${namespace}" is a remote server, so ${targeted} would never be read.`);
    printErr(
      `  A remote server spawns no process: its credentials travel in "headers". Re-add it with \`yaw-mcp add ${namespace} --url <url> --header 'Name: value'\`, or edit "headers" in ${path} by hand.`,
    );
    return refuse(1);
  }

  const envIsMap =
    entry.env === undefined || (typeof entry.env === "object" && entry.env !== null && !Array.isArray(entry.env));
  if (!envIsMap && envAssignments.length > 0) {
    const targeted = envAssignments.map((a) => `env.${a.key}`).join(", ");
    printErr(
      `yaw-mcp ${verb}: "${namespace}" in ${path} has an "env" that is ${describeJsonShape(entry.env)}, not an object of "NAME": "value" pairs.`,
    );
    printErr(`  Fix that field by hand (or delete it), then re-run to set ${targeted}.`);
    return refuse(1);
  }

  // The entry env, and every map derived from it below, is PROTOTYPE-LESS.
  // parseAssignment's name rule (ENV_KEY_RE) admits every Object.prototype
  // member name -- constructor, toString, valueOf, hasOwnProperty are all
  // valid shell identifiers -- so a bare lookup on a map that inherits that
  // prototype answers an ABSENT key named after one of them with a FUNCTION
  // rather than undefined. That made `set gh env.constructor=`
  // report a broken field in the user file ("is a function ... remove it by
  // hand") over a key that was never there: the same false-report class the
  // refusal below exists to prevent, produced by the refusal itself.
  // describeJsonShape answering "a function" is the tell -- no JSON parse
  // can produce one.
  //
  // Object.assign(Object.create(null), ...) at EACH map rather than a spread
  // of this one: `{ ...protoLess }` builds a fresh object, which gets
  // Object.prototype back. So the guarantee is re-established per map, and
  // the two that need it are the ones read by bare key -- projectedEnv and
  // liveEnv. (This one is copied FROM, and its only read tests === "string",
  // which no inherited member satisfies.)
  const originalEnv: Record<string, unknown> = Object.assign(
    Object.create(null),
    (entry.env as Record<string, unknown> | undefined) ?? {},
  );
  return { ok: true, rawText, idx, entry, namespace, originalEnv };
}

/** The entry's env as it will stand once `assignments` are applied in order,
 *  or a refusal for a clear the run could not make. Pure: no I/O. */
function projectEnv(
  ctx: SetContext,
  loc: LocatedEntry,
  assignments: Assignment[],
): { ok: true; env: Record<string, unknown> } | Refused {
  const { verb, path, printErr } = ctx;
  const { namespace, originalEnv } = loc;
  // A clear whose stored value is NOT a string is refused rather than
  // applied: the key is in the file and this run leaves it there, so
  // reporting success over it would be the CLI claiming an edit it had not
  // made. (The shape guard above rules out a non-map env; this is a
  // non-string VALUE inside a real map.)
  //
  // Decided HERE, above the confirmation gate, rather than in the apply loop:
  // down there a mixed run -- `env.A= env.B=`, A a string and B a number --
  // prompted for A irreversible clear, took the yes, and only THEN bailed on
  // B, leaving the user believing a drop they had just confirmed had
  // happened. Nothing is written before the loop single atomic write either
  // way, so only the order the user sees differs.
  //
  // Walked in assignment ORDER against a projected map rather than read off
  // the original, so an earlier edit in the SAME run counts: `env.B=x env.B=`
  // clears a value this run wrote, and is fine.
  const projectedEnv: Record<string, unknown> = Object.assign(Object.create(null), originalEnv);
  for (const a of assignments) {
    if (a.field !== "env") continue;
    const key = a.key as string;
    if (a.value !== undefined) {
      projectedEnv[key] = a.value;
      continue;
    }
    const current = projectedEnv[key];
    if (current !== undefined && typeof current !== "string") {
      printErr(
        `yaw-mcp ${verb}: env.${key} on "${namespace}" is ${describeJsonShape(current)} in ${path}, not a string -- remove it by hand.`,
      );
      printErr("  Nothing was written; re-run once that field is a string or gone.");
      return { ok: false, result: { exitCode: 1, written: [] } };
    }
    delete projectedEnv[key];
  }
  return { ok: true, env: projectedEnv };
}

/** The confirmation gate for an edit that destroys a stored env value. Null
 *  when the run may proceed; otherwise the result to hand back. */
async function confirmDestructive(
  opts: SetCommandOptions,
  ctx: SetContext,
  loc: LocatedEntry,
  projectedEnv: Record<string, unknown>,
  assignments: Assignment[],
): Promise<SetCommandResult | null> {
  const { verb, path, print, printErr } = ctx;
  const { namespace, originalEnv } = loc;
  // Any edit that DESTROYS a stored env value is confirmed -- a clear and an
  // overwrite alike. The gate used to cover only the clear, reasoning that
  // "the previous value is shown in the transcript either way" for a set.
  // It is not: nothing prints a stored value (this command redacts its own
  // env output, and so does `add --json` and the removal preview), so
  // `set gh env.TOKEN=<new>` replaced a credential nobody could read back,
  // with no prompt, no --force, and exit 0. Same irreversible act on the
  // same bytes as a clear, so it takes the same gate.
  //
  // Classified against projectedEnv -- the map the pre-flight walk above
  // built by applying THIS RUN's assignments in order -- rather than one
  // question per assignment. That is what makes a repeated key ask once, and
  // what makes `env.A=x env.A=t` (ending on the value already stored) ask
  // nothing at all: the file is unchanged, so nothing is lost.
  const destroyed = new Map<string, "cleared" | "overwritten">();
  for (const a of assignments) {
    if (a.field !== "env") continue;
    const key = a.key as string;
    const stored = originalEnv[key];
    // Only a stored STRING can be destroyed: an absent key has nothing to
    // lose, and a non-string one was refused by the walk above.
    if (typeof stored !== "string") continue;
    const final = projectedEnv[key];
    if (final === stored) continue;
    destroyed.set(key, final === undefined ? "cleared" : "overwritten");
  }
  if (destroyed.size > 0 && !opts.force) {
    const clearing = [...destroyed].filter(([, kind]) => kind === "cleared").map(([name]) => name);
    const overwriting = [...destroyed].filter(([, kind]) => kind === "overwritten").map(([name]) => name);
    // "clear A, B" / "overwrite C" / "clear A and overwrite C" -- ONE phrase
    // shared by the refusal and the prompt, so the two can never describe
    // different edits.
    const actions: string[] = [];
    if (clearing.length > 0) actions.push(`clear ${clearing.join(", ")}`);
    if (overwriting.length > 0) actions.push(`overwrite ${overwriting.join(", ")}`);
    const phrase = actions.join(" and ");
    // Under --json the envelope below is the WHOLE output, on stderr -- the
    // shape every `yaw-mcp secrets` failure already takes. A script that
    // asked for machine output used to get an exit code and prose it had to
    // scrape. stdout stays empty on this path either way: it carries exactly
    // one line, the success envelope, and never half of a refusal.
    if (!opts.json) {
      if (clearing.length > 0) printErr(`This clears a stored value on "${namespace}": ${clearing.join(", ")}`);
      if (overwriting.length > 0) {
        printErr(`This overwrites a stored value on "${namespace}": ${overwriting.join(", ")}`);
      }
      printErr("  The old value is gone -- re-adding the server will not bring it back.");
    }
    if (!isInteractive(opts)) {
      if (opts.json) {
        printErr(
          JSON.stringify({
            ok: false,
            error: `refusing to ${phrase} on "${namespace}" without a confirmation -- stdin/stdout is not a TTY. Re-run with --force (or -y).`,
            path,
            namespace,
            // Key NAMES only, like every other env surface here.
            destructive: [...destroyed.keys()],
          }),
        );
      } else {
        printErr(`yaw-mcp ${verb}: refusing to ${phrase} without a confirmation -- stdin/stdout is not a TTY.`);
        printErr("  Re-run with --force (or -y).");
      }
      return { exitCode: 2, written: [] };
    }
    const answer = await askYesNo(opts, `${phrase[0].toUpperCase()}${phrase.slice(1)} on "${namespace}"? [y/N] `);
    if (answer === QUESTION_CANCELLED) {
      if (opts.json) printErr(JSON.stringify({ ok: false, error: "Cancelled.", cancelled: true, path, namespace }));
      else printErr("Aborted.");
      return { exitCode: 130, written: [] };
    }
    if (answer !== "y" && answer !== "yes") {
      if (opts.json) printErr(JSON.stringify({ ok: false, error: "Aborted.", aborted: true, path, namespace }));
      else print("Aborted.");
      return { exitCode: 1, written: [] };
    }
  }

  return null;
}

/** What a --secret run did in the vault, for the summary line and the --json
 *  envelope. Never the value. */
interface SecretWrite {
  key: string;
  name: string;
  ref: string;
  replaced: boolean;
  freshVault: boolean;
}

/** Apply the edits to the text, write the file once, and report. */
async function applyAssignments(
  opts: SetCommandOptions,
  ctx: SetContext,
  loc: LocatedEntry,
  assignments: Assignment[],
  secret?: SecretWrite,
): Promise<SetCommandResult> {
  const { path, home, print, printErr } = ctx;
  const { rawText, idx, entry, namespace, originalEnv } = loc;
  // Apply one edit at a time against the RUNNING text: editJsoncPath returns
  // the whole text it is handed with its one edit applied, so two edits
  // against one source would each drop the other.
  let text = rawText;
  const applied: string[] = [];
  const jsonChanges: Array<Record<string, unknown>> = [];
  const jsonUnchanged: Array<Record<string, unknown>> = [];
  let isActiveTouched = false;
  // A LIVE copy of the entry's env, mutated as each edit is applied. Reading
  // the original for every assignment made a run that clears two keys see
  // the pre-run map both times, so the second clear still believed a sibling
  // survived and left an empty `"env": {}` husk behind.
  const liveEnv: Record<string, unknown> = Object.assign(Object.create(null), originalEnv);
  // Same reason, for the scalars: the loop below used to compare against
  // the pre-run entry while the TEXT it edits accumulates, so `set gh
  // runtime=oam runtime=node` decided the second edit was redundant and
  // left oam on disk while reporting node.
  const liveScalars: Record<string, unknown> = { ...entry };

  for (const a of assignments) {
    if (a.field === "env") {
      const current = liveEnv[a.key as string];
      if (a.value === undefined) {
        // Present-but-not-a-string was refused by the pre-flight walk above,
        // which projects these same assignments in the same order -- so by
        // here `current` is a string or absent, and the delete below cannot
        // meet a shape jsonc-parser would throw on.
        if (current === undefined) {
          applied.push(`env.${a.key}: already unset`);
          jsonUnchanged.push({ field: "env", key: a.key });
          continue;
        }
        // Deleting under a missing container throws rather than no-opping,
        // which the `typeof current !== "string"` guard above rules out. When
        // this was the last key, remove the whole map rather than leaving a
        // `"env": {}` husk the merge path deliberately avoids.
        delete liveEnv[a.key as string];
        const remaining = Object.keys(liveEnv);
        text =
          remaining.length === 0
            ? editJsoncPath(text, ["servers", idx, "env"], undefined)
            : editJsoncPath(text, ["servers", idx, "env", a.key as string], undefined);
        applied.push(`env.${a.key}: cleared`);
        jsonChanges.push({ field: "env", key: a.key, action: "cleared" });
        continue;
      }
      if (current === a.value) {
        applied.push(`env.${a.key}: already set (value not shown)`);
        jsonUnchanged.push({ field: "env", key: a.key });
        continue;
      }
      text = editJsoncPath(text, ["servers", idx, "env", a.key as string], a.value);
      liveEnv[a.key as string] = a.value;
      applied.push(`env.${a.key}: set (value not shown)`);
      jsonChanges.push({ field: "env", key: a.key, action: "set" });
      continue;
    }

    // An ABSENT isActive reads as true everywhere else (validateEntry
    // defaults it), so `set gh isActive=true` on an entry that never carried
    // the key is a semantic no-op. Writing it anyway would report a change
    // and dirty the file to say what it already said.
    //
    // `pinned` is the same rule with the opposite default: validateEntry
    // honours only an explicit `true`, so absent reads as NOT pinned and
    // `pinned=false` on an entry without the key is the same no-op. Absent
    // these two lines the file gets dirtied -- and the run reports a change
    // -- to write the value the loader was already using.
    const scalarDefaults: Record<string, unknown> = { isActive: true, pinned: false };
    const current =
      liveScalars[a.field] === undefined && a.field in scalarDefaults ? scalarDefaults[a.field] : liveScalars[a.field];
    if (current === a.value) {
      applied.push(`${a.field}: already ${render(a.value)}`);
      jsonUnchanged.push({ field: a.field });
      continue;
    }
    if (a.value === undefined && current === undefined) {
      applied.push(`${a.field}: already unset`);
      jsonUnchanged.push({ field: a.field });
      continue;
    }
    text = editJsoncPath(text, ["servers", idx, a.field], a.value);
    liveScalars[a.field] = a.value;
    applied.push(`${a.field}: ${render(current)} -> ${render(a.value)}`);
    jsonChanges.push({
      field: a.field,
      action: a.value === undefined ? "cleared" : "set",
      from: current,
      to: a.value,
    });
    if (a.field === "isActive") isActiveTouched = true;
  }

  const changed = jsonChanges.length > 0;
  if (changed) {
    await atomicWriteFile(path, text, "utf8", 0o600, 0o700);
  }

  if (opts.json) {
    print(
      JSON.stringify({
        ok: true,
        path,
        namespace,
        changed,
        changes: jsonChanges,
        unchanged: jsonUnchanged,
        // The vault side of a --secret run: its name and the reference,
        // which are not secret. The value never appears.
        ...(secret
          ? {
              secret: {
                name: secret.name,
                ref: secret.ref,
                replaced: secret.replaced,
                fresh_vault: secret.freshVault,
              },
            }
          : {}),
      }),
    );
    return { exitCode: 0, written: changed ? [path] : [] };
  }

  if (secret) {
    // ONE line for the whole two-store edit, naming the vault entry and
    // the reference -- the two things a user needs to find either half
    // again. The ref is printed bare, not quoted for a shell: it is what
    // landed in the file, not something to re-type.
    const stored = secret.replaced
      ? "Replaced secret"
      : secret.freshVault
        ? "Created the vault and stored secret"
        : "Stored secret";
    print(
      changed
        ? `${stored} "${secret.name}" and set env.${secret.key} to ${secret.ref} on "${namespace}" in ${path}`
        : `${stored} "${secret.name}"; env.${secret.key} on "${namespace}" already references it.`,
    );
  } else {
    print(changed ? `Updated "${namespace}" in ${path}` : `No change to "${namespace}" in ${path}`);
    for (const line of applied) print(`  ${line}`);
  }
  if (changed) {
    // An edit that lands on a DISABLED entry does nothing observable until
    // it is enabled, and saying so here is cheaper than the user restarting
    // their client to find out. Only when this run did not touch isActive
    // itself: a `disable` already says what it did, and an `enable` turned
    // the entry on.
    const stillDisabled = !isActiveTouched && entry.isActive === false;
    if (stillDisabled) {
      print(
        `Note: "${namespace}" is "isActive": false, so it will NOT load. Run \`yaw-mcp enable ${namespace}\` to turn it on.`,
      );
    }
    // A project bundles.json REPLACES the user-global file on load rather
    // than merging with it, so an edit made while one is in effect is real on
    // disk and invisible in the session. `add` and `remove` both say so; a
    // `set` that reported success and changed nothing observable was the
    // worst of the three, because there is no new entry to go looking for.
    const shadow = await findShadowingProjectBundles(opts.cwd ?? process.cwd(), home, opts.env ?? process.env).catch(
      () => null,
    );
    if (shadow) {
      printErr(
        `Note: ${displaySafe(shadow)} overrides your user-global bundles.json, so this change won't take effect until you make it there or remove that file.`,
      );
    }
    print("A running yaw-mcp applies it on its next mcp_connect_* call -- no client restart.");
  }
  return { exitCode: 0, written: changed ? [path] : [] };
}

/** runSecrets's stderr as `set --secret` passes it on. runSecrets prefixes
 *  its refusals `yaw-mcp secrets set:`, the verb the user did not type, so
 *  that prefix is swapped for this command's. Its other two `secrets set`
 *  wordings -- the "point an env value at it" hint and the --value remedy --
 *  are turned off at the source (referenceFollows, valueRemedy), not
 *  rewritten here. Every other line passes through as written. */
function vaultErr(s: string, verb: string, err: (s: string) => void): void {
  err(s.startsWith("yaw-mcp secrets set: ") ? `yaw-mcp ${verb}: ${s.slice("yaw-mcp secrets set: ".length)}` : s);
}

/** `set <server> env.KEY --secret`: the vault write and the reference in one
 *  run, so a user can no longer store the secret and forget to point the
 *  entry at it -- which left the vault entry unused and the plaintext in
 *  bundles.json.
 *
 *  ORDER. Everything that can refuse without a prompt runs first, OUTSIDE the
 *  bundles lock: the target, a remote entry, a non-map env, the vault name,
 *  and the overwrite confirmation for a stored env value. Then the vault
 *  write, which prompts for the passphrase and the value -- outside the lock
 *  too, since other writers give up on it after BUNDLES_LOCK_WAIT_MS and a
 *  human typing a passphrase takes longer. Then the reference, under the lock
 *  through the same apply path a plain `set` takes. A refusal before the
 *  vault write leaves both stores alone; a failure after it leaves the secret
 *  stored and says how to finish.
 *
 *  The vault half IS `yaw-mcp secrets set`: runSecrets, called with the same
 *  options its own CLI parser produces, so the no-echo prompt, the piped-stdin
 *  read, the replace confirmation and the "Replaced" wording are its code,
 *  not a copy of it. */
async function runSetSecret(opts: SetCommandOptions, ctx: SetContext): Promise<SetCommandResult> {
  const { verb, path, home, printErr, err } = ctx;
  const raw = (opts.assignments ?? [])[0];
  const key = raw.slice(4);
  // The placeholder value only has to be non-undefined: locateEntry's env
  // refusals look at which keys are assigned, never at the value. It is never
  // written.
  const pre = await locateEntry(ctx, [{ field: "env", key, value: "", raw }]);
  if (!pre.ok) return pre.result;

  // A refusal before the vault write: prose, or under --json ONE stderr
  // envelope in the shape confirmDestructive's refusal takes, so a script
  // that asked for machine output never has to scrape a prose line.
  const refuseEarly = (error: string, hint: string, fields: Record<string, unknown> = {}): SetCommandResult => {
    if (opts.json) {
      printErr(JSON.stringify({ ok: false, error, hint, path, namespace: pre.namespace, ...fields }));
    } else {
      printErr(`yaw-mcp ${verb}: ${error}`);
      printErr(`  ${hint}`);
    }
    return { exitCode: 2, written: [] };
  };

  const name = secretNameFor(opts.secretName, pre.originalEnv[key], pre.namespace, key);
  if (name === null) {
    return refuseEarly(
      `cannot derive a vault name from "${pre.namespace}" and ${key} (letters, digits, "_", "." or "-" only).`,
      "Name it yourself with --secret-name NAME.",
    );
  }
  const ref = `\${secret:${name}}`;
  // Only a DERIVED name is checked: an explicit --secret-name that another
  // key references is a deliberate share, and a name read off env.KEY's own
  // reference is a rotation.
  const storedRef =
    typeof pre.originalEnv[key] === "string" ? WHOLE_SECRET_REF_RE.exec(pre.originalEnv[key])?.[1] : undefined;
  if (opts.secretName === undefined && name !== storedRef) {
    const others = otherReferences(pre.rawText, ref, pre.namespace, key);
    if (others.length > 0) {
      return refuseEarly(
        `the derived vault name "${name}" is already referenced by ${others.join(", ")} in ${path} -- storing env.${key} under it would replace that credential too.`,
        "Name this one yourself with --secret-name NAME.",
        { referenced_by: others },
      );
    }
  }
  const assignment: Assignment = { field: "env", key, value: ref, raw };

  // Overwriting a stored PLAINTEXT value is the same irreversible act a plain
  // `set env.KEY=<v>` confirms, so it takes the same gate -- asked before the
  // vault prompts, so a "no" costs the user nothing and leaves no vault entry
  // behind.
  const projected = projectEnv(ctx, pre, [assignment]);
  if (!projected.ok) return projected.result;
  const refused = await confirmDestructive(opts, ctx, pre, projected.env, [assignment]);
  if (refused) return refused;

  // runSecrets's prompts read opts.io; its results and refusals go to the
  // sinks. Its success line is captured rather than passed through: the
  // summary below says what it said, plus the reference, in one line.
  const vaultOut: string[] = [];
  const stdin = opts.io?.stdin;
  const stdout = opts.io?.stdout;
  const vault = await runSecrets(
    {
      action: "set",
      name,
      json: opts.json,
      force: opts.force,
      fromStdin: opts.fromStdin,
      home,
      cwd: opts.cwd,
      passphrase: opts.passphrase,
      referenceFollows: true,
      valueRemedy: "Pipe the value in with --stdin.",
      io: stdin && stdout ? { stdin, stdout } : undefined,
    },
    { out: (s) => vaultOut.push(s), err: (s) => vaultErr(s, verb, err) },
  );
  if (vault.exitCode !== 0) {
    if (!opts.json) printErr(`  Nothing was written to ${path}.`);
    return { exitCode: vault.exitCode, written: [] };
  }
  // runSecrets says which case it was in its one success line: the --json
  // envelope's `replaced` / `fresh_vault`, or the prose "Replaced secret" /
  // "Created vault and Stored secret" (SECRETS_USAGE promises "Replaced"
  // for an overwrite). Read back here rather than re-derived from a second
  // vault load, which could disagree with what the write actually did.
  const vaultText = vaultOut.join("");
  let replaced = vaultText.startsWith("Replaced secret");
  let freshVault = vaultText.startsWith("Created vault");
  if (opts.json) {
    try {
      const env = JSON.parse(vaultText.trim()) as { replaced?: unknown; fresh_vault?: unknown };
      replaced = env.replaced === true;
      freshVault = env.fresh_vault === true;
    } catch {
      // Unparseable success output would be a runSecrets bug; the write
      // happened either way, so report it as a plain store.
    }
  }
  const secret: SecretWrite = { key, name, ref, replaced, freshVault };

  const finishCmd = `yaw-mcp set ${pre.namespace} env.${key}='${ref}'`;
  const finishHint = `  The secret "${name}" IS in the vault; finish with \`${finishCmd}\`.`;
  // Every failure past this point leaves the secret stored and the reference
  // unwritten. In prose that is the finish hint; under --json it is ONE stderr
  // envelope carrying `stored: true` and the secret's facts, so a script does
  // not read the non-zero exit as "nothing changed". `lines` are the prose
  // diagnostics, joined into the envelope's `error`.
  const failAfterVault = (exitCode: number, lines: string[]): SetCommandResult => {
    if (opts.json) {
      printErr(
        JSON.stringify({
          ok: false,
          error: lines
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .join(" "),
          hint: `The secret "${name}" IS in the vault; finish with \`${finishCmd}\`.`,
          path,
          namespace: pre.namespace,
          stored: true,
          secret: { name, ref, replaced, fresh_vault: freshVault },
        }),
      );
    } else {
      for (const l of lines) printErr(l);
      printErr(finishHint);
    }
    return { exitCode, written: [] };
  };
  try {
    return await serializeBundleWrite(() =>
      withBundlesLock(home, async () => {
        // locateEntry's refusals are captured rather than printed, so --json
        // can carry them in the one envelope instead of a prose line before it.
        const locErr: string[] = [];
        const loc = await locateEntry({ ...ctx, printErr: (s) => locErr.push(s) }, [assignment]);
        if (!loc.ok) return failAfterVault(loc.result.exitCode, locErr);
        // The overwrite was confirmed against the value read before the
        // prompts. If another writer changed it since, that confirmation was
        // for a different value -- refuse rather than destroy one the user
        // never saw a question about.
        // By the value's JSON text, not identity: a non-string value (a
        // hand-written object) is a fresh object on every parse, so `!==`
        // reported a change that never happened.
        if (
          loc.namespace !== pre.namespace ||
          JSON.stringify(loc.originalEnv[key]) !== JSON.stringify(pre.originalEnv[key])
        ) {
          return failAfterVault(1, [
            `yaw-mcp ${verb}: env.${key} on "${pre.namespace}" changed in ${path} while you were entering the secret.`,
          ]);
        }
        return applyAssignments(opts, ctx, loc, [assignment], secret);
      }),
    );
  } catch (e) {
    // The lock wait timing out (or the write failing) after the vault write
    // must not read as "nothing happened": the secret is stored.
    return failAfterVault(1, [`yaw-mcp ${verb}: ${(e as Error).message}`]);
  }
}

/** `enable` / `disable` are exactly `set <target> isActive=<bool>`. Written as
 *  a delegation rather than a copy so the two can never drift. */
export async function runEnableDisable(opts: SetCommandOptions & { enabled: boolean }): Promise<SetCommandResult> {
  // `verb` is what keeps the delegation invisible in the output: without it
  // every diagnostic named `set`, the one verb the user did not type.
  return runSet({ ...opts, verb: opts.enabled ? "enable" : "disable", assignments: [`isActive=${opts.enabled}`] });
}
