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
// WHAT IS SETTABLE, AND WHY THE LIST IS SHORT. isActive, runtime,
// connectTimeoutMs, description and individual env keys. Not namespace,
// command, args, url, transport or type: those decide WHICH PROGRAM yaw-mcp
// spawns as the user, and they belong to `add`/`remove` or to a deliberate
// edit, not to a one-line set whose argument lands in shell history.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { editJsoncPath, parseJsonc } from "./jsonc.js";
import { deriveNamespace, findShadowingProjectBundles, localBundlesPath, withBundlesLock } from "./local-bundles.js";
import { userConfigDir } from "./paths.js";
import { QUESTION_CANCELLED, type QuestionCancelled, questionOrEmpty } from "./readline-question.js";
import { MAX_TIMEOUT_MS } from "./upstream.js";

export const SET_USAGE = `Usage: yaw-mcp set <slug-or-namespace> <key=value> [<key=value> ...] [flags]

  Change per-server fields in your local ~/.yaw-mcp/bundles.json without
  hand-editing it. Only the entry you name is rewritten -- comments,
  formatting and every other entry keep their bytes.

  <slug-or-namespace> is the catalog slug the server was added with (e.g.
  "brave-search") or its namespace as shown by \`yaw-mcp list\` (e.g.
  "bravesearch") -- the same target \`yaw-mcp remove\` takes.

Settable keys:
  isActive=true|false   Load this server, or keep it out of the set.
                        \`yaw-mcp enable\` / \`disable\` is the same edit.
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
                        server's env alone. \`env.KEY=\` REMOVES that variable --
                        a stored value does not come back, so that clear is
                        confirmed on a TTY. For a real credential, store it
                        with \`yaw-mcp secrets set NAME\` and set
                        env.KEY='\${secret:NAME}' instead: the vault resolves it
                        at launch and only the reference is written.

  Every other key is refused, including namespace, command, args, url,
  transport and type: those decide which program yaw-mcp spawns as you, and
  they belong to \`yaw-mcp add\` / \`remove\` or a deliberate edit of
  bundles.json, not to a one-line set. A value lands in your shell history
  and process argv like any argument.

Flags:
  --force, -y, --yes  Skip the confirmation for a clear that drops a stored
                      env value. Required when stdin or stdout is not a TTY.
  --json              Emit the result as JSON. env values are never printed.
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

/** Same shape and the same case-SENSITIVITY as `remove`'s target: the slug
 *  lookup compares literally, so folding case here would make `set GitHub`
 *  resolve where `remove GitHub` does not. */
const SET_TARGET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Scalar fields a `set` may touch. Deliberately not a superset of
 *  validateEntry's whitelist -- see the module header on why the launch
 *  fields are excluded. */
const SETTABLE_SCALARS = new Set(["isActive", "runtime", "connectTimeoutMs", "description"]);

export interface SetCommandOptions {
  target?: string;
  /** Raw `key=value` arguments, in the order the user gave them. */
  assignments?: string[];
  json?: boolean;
  force?: boolean;
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
}

export interface SetCommandResult {
  exitCode: number;
  written: string[];
}

/** One requested edit, parsed but not yet applied. */
interface Assignment {
  /** "isActive" | "runtime" | "connectTimeoutMs" | "description" | "env" */
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
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--force" || a === "-y" || a === "--yes") opts.force = true;
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
    return { ok: false, error: `yaw-mcp set: nothing to set -- pass at least one key=value.\n${SET_USAGE}` };
  }
  return { ok: true, options: opts };
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
    // Trimmed, and a blank means CLEAR rather than "store an empty string":
    // the loader drops blank env values anyway, so storing one would write a
    // key that can never take effect.
    const trimmed = text.trim();
    return { ok: true, value: { field: "env", key: name, value: trimmed === "" ? undefined : trimmed, raw } };
  }

  if (!SETTABLE_SCALARS.has(key)) {
    return {
      ok: false,
      error: `yaw-mcp set: "${key}" is not settable. Settable: isActive, runtime, connectTimeoutMs, description, env.KEY.`,
    };
  }

  if (key === "isActive") {
    if (text === "true") return { ok: true, value: { field: key, value: true, raw } };
    if (text === "false") return { ok: true, value: { field: key, value: false, raw } };
    // No clear: absent reads as true, so there is no third state to express.
    return { ok: false, error: `yaw-mcp set: isActive must be exactly "true" or "false" (got "${text}").` };
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

/** Defaults to NO, and EOF is a decline rather than a hang -- the same
 *  contract `remove`'s confirmation documents. */
async function askYesNo(opts: SetCommandOptions, question: string): Promise<string | QuestionCancelled> {
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
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const target = opts.target ?? "";
  if (!SET_TARGET_RE.test(target)) {
    printErr(`yaw-mcp set: "${target}" is not a valid server name.`);
    return { exitCode: 2, written: [] };
  }

  const assignments: Assignment[] = [];
  for (const raw of opts.assignments ?? []) {
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
    printErr(`yaw-mcp set: no servers configured yet (${path} does not exist). Add one with \`yaw-mcp add <slug>\`.`);
    return { exitCode: 1, written: [] };
  }

  return withBundlesLock(home, async () => {
    let rawText: string;
    try {
      rawText = await readFile(path, "utf8");
    } catch (e) {
      printErr(`yaw-mcp set: ${path} could not be read (${(e as Error).message}).`);
      return { exitCode: 1, written: [] };
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(rawText);
    } catch (e) {
      printErr(
        `yaw-mcp set: ${path} could not be parsed -- fix the JSON before setting fields (${(e as Error).message}).`,
      );
      return { exitCode: 1, written: [] };
    }
    const servers = (parsed as { servers?: unknown } | null)?.servers;
    if (!Array.isArray(servers)) {
      printErr(`yaw-mcp set: ${path} has no "servers" array.`);
      return { exitCode: 1, written: [] };
    }

    // Same resolution order as `remove`: the literal target, then any entry
    // whose stored slug matches, then the namespace `add` would have derived.
    const bySlug: string[] = [];
    for (const s of servers) {
      const e = s as { slug?: unknown; namespace?: unknown } | null;
      if (e?.slug === target && typeof e?.namespace === "string") bySlug.push(e.namespace);
    }
    const candidates = [...new Set([target, ...bySlug, deriveNamespace(target)])];
    let idx = -1;
    for (const cand of candidates) {
      idx = servers.findIndex((s) => (s as { namespace?: unknown } | null)?.namespace === cand);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      printErr(`yaw-mcp set: no server named "${target}" in ${path}. Run \`yaw-mcp list\` to see what is configured.`);
      return { exitCode: 1, written: [] };
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
    const envIsMap =
      entry.env === undefined || (typeof entry.env === "object" && entry.env !== null && !Array.isArray(entry.env));
    if (!envIsMap && envAssignments.length > 0) {
      const targeted = envAssignments.map((a) => `env.${a.key}`).join(", ");
      printErr(
        `yaw-mcp set: "${namespace}" in ${path} has an "env" that is ${describeJsonShape(entry.env)}, not an object of "NAME": "value" pairs.`,
      );
      printErr(`  Fix that field by hand (or delete it), then re-run to set ${targeted}.`);
      return { exitCode: 1, written: [] };
    }

    // The entry env, and every map derived from it below, is PROTOTYPE-LESS.
    // parseAssignment puts no name rule on an env key, so a bare lookup on a
    // map that inherits Object.prototype answers an ABSENT key named after one
    // of its members -- constructor, toString, valueOf, hasOwnProperty -- with
    // a FUNCTION rather than undefined. That made `set gh env.constructor=`
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
          `yaw-mcp set: env.${key} on "${namespace}" is ${describeJsonShape(current)} in ${path}, not a string -- remove it by hand.`,
        );
        printErr("  Nothing was written; re-run once that field is a string or gone.");
        return { exitCode: 1, written: [] };
      }
      delete projectedEnv[key];
    }

    // A clear that DROPS a stored value is the one irreversible edit here, so
    // it is confirmed. Setting or overwriting is not: the previous value is
    // shown in the transcript either way.
    const droppingEnv = assignments.filter(
      (a) => a.field === "env" && a.value === undefined && typeof originalEnv[a.key as string] === "string",
    );
    if (droppingEnv.length > 0 && !opts.force) {
      const names = droppingEnv.map((a) => a.key).join(", ");
      // stderr, not stdout: this is a diagnostic about a prompt, and stdout
      // has to stay a single parseable line under --json.
      printErr(`This clears a stored value on "${namespace}": ${names}`);
      printErr("  Re-adding the server will not bring it back.");
      if (!isInteractive(opts)) {
        printErr(`yaw-mcp set: refusing to clear ${names} without a confirmation -- stdin/stdout is not a TTY.`);
        printErr("  Re-run with --force (or -y).");
        return { exitCode: 2, written: [] };
      }
      const answer = await askYesNo(opts, `Clear ${names} on "${namespace}"? [y/N] `);
      if (answer === QUESTION_CANCELLED) {
        printErr("Aborted.");
        return { exitCode: 130, written: [] };
      }
      if (answer !== "y" && answer !== "yes") {
        print("Aborted.");
        return { exitCode: 1, written: [] };
      }
    }

    // Apply one edit at a time against the RUNNING text: jsonc-parser computes
    // offsets against the text it is handed, so two edits against one source
    // corrupt each other.
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
      const current = a.field === "isActive" && liveScalars.isActive === undefined ? true : liveScalars[a.field];
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
        }),
      );
      return { exitCode: 0, written: changed ? [path] : [] };
    }

    print(changed ? `Updated "${namespace}" in ${path}` : `No change to "${namespace}" in ${path}`);
    for (const line of applied) print(`  ${line}`);
    if (changed) {
      // An edit that lands on a DISABLED entry does nothing observable until
      // it is enabled, and saying so here is cheaper than the user restarting
      // their client to find out.
      const stillDisabled = isActiveTouched
        ? assignments.some((a) => a.field === "isActive" && a.value === false)
        : entry.isActive === false;
      if (stillDisabled && !isActiveTouched) {
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
          `Note: ${shadow} overrides your user-global bundles.json, so this change won't take effect until you make it there or remove that file.`,
        );
      }
      print("A running yaw-mcp applies it on its next mcp_connect_* call -- no client restart.");
    }
    return { exitCode: 0, written: changed ? [path] : [] };
  });
}

/** `enable` / `disable` are exactly `set <target> isActive=<bool>`. Written as
 *  a delegation rather than a copy so the two can never drift. */
export async function runEnableDisable(opts: SetCommandOptions & { enabled: boolean }): Promise<SetCommandResult> {
  return runSet({ ...opts, assignments: [`isActive=${opts.enabled}`] });
}
