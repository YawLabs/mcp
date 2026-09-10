// `yaw-mcp reset-learning` — delete ~/.yaw-mcp/state.json so cross-session
// learning starts fresh. Pairs with the doctor RELIABILITY section (see
// doctor-cmd.ts) and the dispatch penalty branch (learning.ts):
// once doctor has flagged a namespace as flaky, its penalty keeps
// suppressing routing to it until enough new successes pile up.
// If the user fixed the underlying issue (rotated the token, swapped
// the upstream, rotated its credentials) the history is now stale and
// that penalty has overstayed its welcome — this command wipes it.
//
// IMPORTANT: this deletes the file on disk, it does NOT reach into a
// running session. `yaw-mcp serve` holds the learning store in memory and
// flushes a full snapshot (server.ts flushStateSave, on a ~1s debounce
// after every recorded outcome/miss/exec step, plus once on shutdown)
// without ever re-reading the file first -- so a serve process attached to
// an MCP client will recreate state.json with every pre-reset entry on its
// next proxied tool call. That is the NORMAL configuration, so the success
// report says so explicitly and tells the user to restart the client.
//
// Scope is intentionally "all or nothing." A per-namespace flag feels
// nice but the failure mode is a footgun (user clears one namespace,
// forgets about three others, keeps getting silently mis-ranked).
// If finer granularity is ever needed we can add `--namespace <ns>`
// as an additive flag without breaking the current contract.
//
// The delete is IRREVERSIBLE -- a rebuilt learning store costs the user every
// success they have accumulated -- so it is confirmed, on the pattern `set`
// and `remove` already use: preview what is about to go, prompt on a TTY,
// refuse off one, and take --force / -y / --yes as the bypass. The gate fires
// only when there is really something to delete; a missing file, or a run
// under YAW_MCP_DISABLE_PERSISTENCE, stays the exit-0 no-op it has always been
// so the cleanup scripts that run this unconditionally keep working.
//
// Exit codes:
//   0    normal: file removed, nothing to remove, or persistence disabled
//   1    I/O error (file existed but couldn't be removed), or the
//        confirmation was declined
//   2    a confirmation was required and stdin/stdout is not a TTY -- the code
//        every other destructive verb here uses for that refusal (`remove`,
//        `set`, `uninstall`, `secrets remove`)
//   130  Ctrl+C at the prompt

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { userConfigDir } from "./paths.js";
import { isFileNotFound, isPersistenceDisabled, loadStateClassified, statePath } from "./persistence.js";
import { QUESTION_CANCELLED, questionOrEmpty } from "./readline-question.js";

export const RESET_LEARNING_USAGE = `Usage: yaw-mcp reset-learning

  Delete ~/.yaw-mcp/state.json so cross-session learning starts fresh.
  Use this after fixing the root cause of a flaky upstream (token
  rotated, account swapped, server replaced) so the routing penalty
  doesn't keep suppressing it.

  Restart your MCP client afterwards: a running "yaw-mcp serve" keeps
  the learning it has in memory and re-saves it over the deleted file
  on its next tool call.

  The delete cannot be undone, so when there IS something to remove you
  are shown what the file holds and asked to confirm. A bare Enter is NO.

  --force, -y, --yes  Skip the confirmation. Required when stdin or
                      stdout is not a TTY (there is nothing to ask on).
  -h, --help          Show this help.`;

// Printed on every path that actually removed the file. The delete is a
// pure filesystem operation with no channel to a live serve process, and
// that process re-saves its in-memory snapshot without consulting the file
// first -- so without this the user watches "cleared persisted state" and
// then keeps getting the exact routing penalty they just cleared, with
// nothing on screen connecting the two.
const RUNNING_SERVE_NOTE = [
  "  note: a running yaw-mcp serve process still holds this learning in",
  "        memory and re-saves it over the deleted file within a second of",
  "        the next tool call. Restart your MCP client (or stop that serve",
  "        process) for the reset to take effect.",
];

export type ParsedResetLearning =
  | { kind: "help" }
  | { kind: "error"; error: string }
  | { kind: "ok"; options: { force?: boolean } };

// Argv parser. Crucially, this exists so `yaw-mcp reset-learning --help`
// doesn't fall through to runResetLearning() and silently delete state.
//
// The switches are -h/--help and the confirmation bypass -- --force / -y /
// --yes, both spellings its destructive siblings accept (`remove` takes both,
// so a user never has to remember which verb took which). Anything else is an
// error naming the offending argument.
//
// EVERY argument is inspected, not just the first. The old shape returned on
// argv[0] alone, which was harmless while the only switch was --help; with a
// bypass flag in the set, `reset-learning --force --nope` would have run the
// delete and ignored the typo.
export function parseResetLearningArgs(argv: string[]): ParsedResetLearning {
  let force = false;
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--force" || a === "-y" || a === "--yes") {
      force = true;
      continue;
    }
    return {
      kind: "error",
      error: `yaw-mcp reset-learning: unknown argument "${a}"\n\n${RESET_LEARNING_USAGE}`,
    };
  }
  return { kind: "ok", options: force ? { force: true } : {} };
}

export interface ResetLearningOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip the confirmation. Required off a TTY.
   *
   *  This shipped UNREACHABLE for one commit and the gap is worth keeping in
   *  view: `reset-learning` is hand-rolled rather than riding index.ts's
   *  generic `run(...)` tail, which is what threads parsed options into a
   *  runner, and the branch called `runResetLearning()` with no arguments --
   *  so a `--force` the parser accepted was dropped before it arrived, leaving
   *  the confirmation with no bypass and the command unusable off a TTY. The
   *  dispatcher passes `parsed.options` now, and a CLI-level test drives the
   *  real dispatch rather than the runner directly, because a unit test that
   *  calls `runResetLearning({force: true})` passes either way. Any future
   *  hand-rolled branch here has the same hazard. */
  force?: boolean;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. */
  err?: (s: string) => void;
  /** Test hooks, spelled exactly as `remove` and `set` spell them so all three
   *  confirmations are driven the same way. */
  isTTY?: boolean;
  promptAnswer?: string;
  io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; terminal?: boolean };
}

export interface ResetLearningResult {
  exitCode: number;
  /** Lines printed to stdout/stderr, in order — exposed for tests. */
  lines: string[];
  /** True when the state file was actually deleted. */
  removed: boolean;
  /** Absolute path we targeted — useful for the "nothing to reset" message. */
  path: string;
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Same predicate (and the same test seams) as `remove` and `set`. */
function isInteractive(opts: ResetLearningOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- only an explicit y/yes proceeds, so
 *  a bare Enter, a stray keystroke, or EOF (^D, a piped stdin running dry)
 *  leaves state.json where it is. EOF is questionOrEmpty's job: a bare
 *  rl.question() never settles once its input closes, which would leave this
 *  hanging with no answer and no exit. */
async function askYesNo(opts: ResetLearningOptions, question: string): Promise<string | typeof QUESTION_CANCELLED> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const rl = createInterface({ input, output, terminal: opts.io?.terminal });
  try {
    const raw = await questionOrEmpty(rl, question);
    // Ctrl+C is not "no": it is the user leaving, and the exit code says so.
    return raw === QUESTION_CANCELLED ? raw : raw.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export async function runResetLearning(opts: ResetLearningOptions = {}): Promise<ResetLearningResult> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  // statePath(), not a hand-rolled join: the canonical builder lives in
  // persistence.ts next to the writer, and a second spelling here is a
  // path this command could delete while a running broker kept saving to
  // another.
  const filePath = statePath(userConfigDir(home));

  // When persistence is disabled, the running yaw-mcp session isn't
  // reading or writing state.json anyway. A stale file on disk could
  // still exist from a prior session when the env wasn't set — we
  // leave it alone. Rationale: the env flag is usually a temporary
  // opt-out (CI, sandbox, debug); wiping real history every time
  // someone runs this command under the flag would surprise users who
  // expected their opt-out to be non-destructive. If they really want
  // the file gone they can unset the flag and re-run.
  //
  // The predicate is persistence.ts's -- this command used to open-code the
  // same expression, and a divergence would have it deleting the file a
  // running broker still believed it owned (or refusing to when the broker had
  // already stopped writing).
  if (isPersistenceDisabled(env)) {
    // ASCII dash on purpose: this line reaches a terminal, and a non-ASCII
    // dash renders as mojibake under a non-UTF-8 Windows console codepage.
    print("yaw-mcp reset-learning: persistence is disabled (YAW_MCP_DISABLE_PERSISTENCE) -- nothing to clear.");
    return { exitCode: 0, lines, removed: false, path: filePath };
  }

  // Peek before deleting so we can report what was cleared. loadState
  // is tolerant — missing file, malformed JSON, and version mismatch
  // all collapse to emptyState (0/0), so its counts alone can't tell a
  // genuinely-empty file from an unreadable one. loadStateClassified
  // returns that classification from the SAME read+parse, so the report
  // doesn't claim "0 entries removed" when a non-trivial file was
  // actually deleted -- and the classifier cannot drift from the loader
  // the way a separate peek did (it hand-rolled its own JSON.parse and
  // rejected the BOM loadState strips).
  //
  // This is a peek/delete TOCTOU by nature: the counts come from the
  // pre-delete read, so a concurrent serve-write between the peek and the
  // unlink can make them slightly stale. That's acceptable — the delete
  // is correct regardless, and reset-learning is a manual, one-shot admin
  // command, not something racing a live writer in practice. The counts
  // are advisory reporting, not a contract.
  //
  // rawCounts, not the sanitized state: this report is about what the FILE
  // held and the unlink destroyed, not about what yaw-mcp would have been
  // willing to use. The sanitized numbers say "0 entries removed" for a file
  // whose tool caches had all aged past TOOLCACHE_TTL_MS, or whose learning
  // rows were hand-edited into invalid shapes -- real content, really deleted,
  // reported as nothing.
  const { parsedCleanly, rawCounts } = await loadStateClassified(filePath);
  const learningCount = rawCounts.learning;
  const packCount = rawCounts.packHistory;
  // The v2 file's third section. Deleting it silently was the report
  // claiming to account for the file while omitting a whole category:
  // every namespace whose learned tool list is dropped costs one extra
  // upstream handshake on the next session, which is exactly the kind of
  // consequence someone running a reset wants to see up front.
  const toolCacheCount = rawCounts.toolCache;

  // ----- destructive-action confirmation --------------------------------
  // Gated on the file actually being there. A missing one falls through to the
  // unlink below, whose ENOENT branch keeps the exit-0 "nothing to reset"
  // no-op: refusing to no-op off a TTY would break every cleanup script that
  // runs this unconditionally, for no safety gain (the same rule `remove`
  // follows). The existsSync/unlink race is the same advisory TOCTOU the
  // counts above already document -- either way the delete is correct.
  if (existsSync(filePath) && !opts.force) {
    print("yaw-mcp reset-learning: this deletes your cross-session learning.");
    print(`  path: ${filePath}`);
    // The SAME numbers the success report prints, from the same peek, so the
    // preview cannot promise a different delete than the one that happens.
    // An unparseable file gets the honest line instead of "0, 0, 0": those
    // counts were never read, and printing them would talk a user into
    // deleting a file they were told was empty.
    if (parsedCleanly) {
      print(`  learning entries:     ${learningCount}`);
      print(`  pack history entries: ${packCount}`);
      print(`  tool caches:          ${toolCacheCount}`);
    } else {
      print("  contents unreadable -- it will be deleted as it is.");
    }
    print("  This cannot be undone.");
    if (!isInteractive(opts)) {
      printErr(
        `yaw-mcp reset-learning: refusing to delete ${filePath} without a confirmation -- stdin/stdout is not a TTY.`,
      );
      printErr("  Re-run with --force (or -y).");
      return { exitCode: 2, lines, removed: false, path: filePath };
    }
    const answer = await askYesNo(opts, "Delete it? [y/N] ");
    if (answer === QUESTION_CANCELLED) {
      // Ctrl+C at the prompt: exit 130, like every other prompt in the product.
      printErr("yaw-mcp reset-learning: Cancelled. Nothing was deleted.");
      return { exitCode: 130, lines, removed: false, path: filePath };
    }
    if (answer !== "y" && answer !== "yes") {
      printErr("yaw-mcp reset-learning: Aborted. Nothing was deleted.");
      return { exitCode: 1, lines, removed: false, path: filePath };
    }
  }

  try {
    await unlink(filePath);
  } catch (err) {
    if (isFileNotFound(err)) {
      print("yaw-mcp reset-learning: no persisted state to reset.");
      print(`  path: ${filePath}`);
      return { exitCode: 0, lines, removed: false, path: filePath };
    }
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`yaw-mcp reset-learning: failed to remove ${filePath}: ${msg}`);
    return { exitCode: 1, lines, removed: false, path: filePath };
  }

  // A file existed (unlink succeeded) but loadState couldn't parse it into
  // a current-version state — malformed JSON or a version mismatch. The
  // 0/0 counts would be misleading, so report that the file was cleared
  // without claiming an entry count we never actually read.
  if (!parsedCleanly) {
    print("yaw-mcp reset-learning: cleared persisted state (contents unreadable).");
    print(`  path: ${filePath}`);
    for (const line of RUNNING_SERVE_NOTE) print(line);
    return { exitCode: 0, lines, removed: true, path: filePath };
  }

  print("yaw-mcp reset-learning: cleared persisted state.");
  print(`  path: ${filePath}`);
  print(`  learning entries removed:     ${learningCount}`);
  print(`  pack history entries removed: ${packCount}`);
  print(`  tool caches removed:          ${toolCacheCount}`);
  for (const line of RUNNING_SERVE_NOTE) print(line);
  return { exitCode: 0, lines, removed: true, path: filePath };
}
