// One EOF-safe, cancel-aware wrapper for every `rl.question()` in the CLI.
//
// `question()` from node:readline/promises never settles once its input
// closes: after Ctrl+D (or a piped stdin running dry) the interface reports
// `closed === true` and the promise stays pending forever (reproduced on Node
// v22.22.2). A yes/no prompt built directly on it therefore HANGS on EOF
// instead of taking the documented default -- `remove` never printed
// "Aborted", `install` never reached its collision default -- and the process
// ended via event-loop drain with status 0 rather than the documented 1.
//
// The wrapper aborts the pending question when the interface closes.
// questionOrEmpty then hands its caller "" -- the same thing a bare Enter
// produces -- so EOF takes whatever that prompt does on an empty answer. That
// is only safe where the empty answer is the cautious one; askYesNo cannot
// assume it (a [Y/n] prompt PROCEEDS on a bare Enter), so it reports EOF as
// QUESTION_EOF instead and no caller's "" branch ever sees it.
//
// Ctrl+C is NOT EOF. On a real terminal readline owns the keypress: with no
// `SIGINT` listener on the interface it closes the interface and raises no
// process-level signal, so a plain close handler would turn a cancel into the
// DEFAULT answer -- `install` answered its own collision prompt with "skip"
// and printed a success line at exit 0 when the user pressed Ctrl+C. The
// wrapper listens for the interface's `SIGINT` event and returns QUESTION_CANCELLED
// instead, a value no typed answer can equal, so callers map it to their
// cancel path (exit 130, the convention secrets-cmd's raw-mode reader set).
//
// It deliberately does NOT close the interface: the caller created it and
// owns its lifetime (each call site has its own `finally { rl.close() }`).
//
// askYesNo below is the yes/no confirmation the commands share, [y/N] and
// [Y/n] alike, built on the same wrapper: the promptAnswer test seam, the
// stdin/stdout defaults and the trimmed, lower-cased answer live here once
// rather than in a copy per command, so a change to the EOF or Ctrl+C mapping
// reaches every prompt that uses it.
//
// Who gets that mapping -- i.e. who reads with the DEFAULT (readline) reader:
// every askYesNo call that passes no third argument, and every direct
// questionOrEmpty call on an interface of the caller's own. No list of files
// is kept here (the last one went stale); grep src/ for `askYesNo(` and
// `questionOrEmpty(`. `yaw-mcp trust` is the one caller that passes its own
// reader -- tty-reader.ts's raw-mode readAnswerFromTTY, the module `secrets`
// reads its prompts through -- so NOTHING in questionOrEmpty runs for it: that
// reader does its own ^C (null, which trust-cmd maps to QUESTION_CANCELLED)
// and ^D (ANSWER_EOF, which trust-cmd maps to QUESTION_EOF) handling, and the
// two stay aligned by convention, not by code.

import { createInterface, type Interface } from "node:readline/promises";

/** The answer questionOrEmpty returns for Ctrl+C at the prompt. A symbol, so
 *  no string the user could type -- including "" -- collides with it. */
export const QUESTION_CANCELLED: unique symbol = Symbol("yaw-mcp:question-cancelled");
export type QuestionCancelled = typeof QUESTION_CANCELLED;

/** The answer askYesNo returns when the input ended with nothing answered: ^D
 *  at the prompt, or a piped stdin running dry. A symbol for the same reason
 *  as QUESTION_CANCELLED -- it equals neither "" nor "y", so a caller's
 *  comparison declines on it whichever way its prompt defaults. Without it a
 *  [Y/n] prompt took EOF for the bare Enter that means yes. */
export const QUESTION_EOF: unique symbol = Symbol("yaw-mcp:question-eof");
export type QuestionEof = typeof QUESTION_EOF;

/** questionOrEof below with EOF folded into "", for the callers that own
 *  their interface and whose empty answer is already the cautious one. */
export async function questionOrEmpty(rl: Interface, prompt: string): Promise<string | QuestionCancelled> {
  const answer = await questionOrEof(rl, prompt);
  return answer === QUESTION_EOF ? "" : answer;
}

/** One question on `rl`: the typed line, QUESTION_CANCELLED for Ctrl+C, or
 *  QUESTION_EOF when the interface closed (or was already closed) unanswered. */
async function questionOrEof(rl: Interface, prompt: string): Promise<string | QuestionCancelled | QuestionEof> {
  // A question on an already-closed interface rejects with ERR_USE_AFTER_CLOSE
  // rather than hanging; map that to the same "no answer" outcome so a caller
  // never has to distinguish "closed before" from "closed during".
  if ((rl as { closed?: boolean }).closed === true) return QUESTION_EOF;
  const ac = new AbortController();
  let cancelled = false;
  const onClose = (): void => ac.abort();
  const onSigint = (): void => {
    cancelled = true;
    ac.abort();
  };
  rl.once("close", onClose);
  rl.once("SIGINT", onSigint);
  try {
    return await rl.question(prompt, { signal: ac.signal });
  } catch (err) {
    if (cancelled) return QUESTION_CANCELLED;
    if (ac.signal.aborted) return QUESTION_EOF;
    throw err;
  } finally {
    rl.off("close", onClose);
    rl.off("SIGINT", onSigint);
  }
}

/** What askYesNo reads from a command's options. Every command that asks one
 *  has both fields on its own options type and passes its options through. */
export interface YesNoOptions {
  /** A canned answer, returned trimmed and lower-cased without reading or
   *  writing anything -- the commands' test seam. */
  promptAnswer?: string;
  /** The streams to ask on; process.stdin / process.stdout when absent.
   *  `terminal` is readline's own default (output.isTTY) unless a test forces
   *  it; on a real TTY that is what makes readline own the Ctrl+C keypress. */
  io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; terminal?: boolean };
}

/** Reads one answer to `question` for askYesNo. The default is readlineAnswer
 *  below; `trust` passes a reader built on tty-reader.ts's raw-mode one. */
export type AnswerReader = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  terminal: boolean | undefined,
) => Promise<string | QuestionCancelled | QuestionEof>;

/** askYesNo's default reader: one question on a readline interface of its
 *  own, closed again whatever the outcome. EOF comes back as QUESTION_EOF and
 *  Ctrl+C as QUESTION_CANCELLED -- both questionOrEof's doing; a bare
 *  rl.question() never settles once its input closes. */
async function readlineAnswer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  terminal: boolean | undefined,
): Promise<string | QuestionCancelled | QuestionEof> {
  const rl = createInterface({ input, output, terminal });
  try {
    return await questionOrEof(rl, question);
  } finally {
    rl.close();
  }
}

/** Ask a yes/no confirmation and hand back the answer trimmed and
 *  lower-cased, for the caller to compare against "y" / "yes" -- and against
 *  "" as well when its prompt is [Y/n], where a bare Enter means yes. Which
 *  way a prompt defaults is the caller's business; what is fixed here is that
 *  the two non-answers are never a string. EOF (^D, a piped stdin running
 *  dry) comes back as QUESTION_EOF and Ctrl+C as QUESTION_CANCELLED, so
 *  neither can match "" or "y" and a caller that only compares strings
 *  declines on both, whatever its default. The callers that tell a cancel
 *  from a decline test for QUESTION_CANCELLED and exit 130: it is the user
 *  leaving, not answering. `read` replaces only the reading; the promptAnswer
 *  short-circuit and the normalizing stay. */
export async function askYesNo(
  opts: YesNoOptions,
  question: string,
  read: AnswerReader = readlineAnswer,
): Promise<string | QuestionCancelled | QuestionEof> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const raw = await read(input, output, question, opts.io?.terminal);
  return typeof raw === "string" ? raw.trim().toLowerCase() : raw;
}
