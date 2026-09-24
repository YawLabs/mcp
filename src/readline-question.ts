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
// The wrapper aborts the pending question when the interface closes and hands
// the caller "" -- the same thing a bare Enter produces -- so every prompt's
// existing "empty answer means the safe default" branch handles EOF for free.
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
// askYesNo below is the [y/N] confirmation the commands share, built on it:
// the promptAnswer test seam, the stdin/stdout defaults and the trimmed,
// lower-cased answer live here once rather than in a copy per command, so a
// change to the EOF or Ctrl+C mapping reaches every prompt that uses it.

import { createInterface, type Interface } from "node:readline/promises";

/** The answer questionOrEmpty returns for Ctrl+C at the prompt. A symbol, so
 *  no string the user could type -- including "" -- collides with it. */
export const QUESTION_CANCELLED: unique symbol = Symbol("yaw-mcp:question-cancelled");
export type QuestionCancelled = typeof QUESTION_CANCELLED;

export async function questionOrEmpty(rl: Interface, prompt: string): Promise<string | QuestionCancelled> {
  // A question on an already-closed interface rejects with ERR_USE_AFTER_CLOSE
  // rather than hanging; map that to the same "no answer" outcome so a caller
  // never has to distinguish "closed before" from "closed during".
  if ((rl as { closed?: boolean }).closed === true) return "";
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
    if (ac.signal.aborted) return "";
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
 *  below; `trust` passes secrets-cmd's raw-mode reader instead. */
export type AnswerReader = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  terminal: boolean | undefined,
) => Promise<string | QuestionCancelled>;

/** askYesNo's default reader: one question on a readline interface of its
 *  own, closed again whatever the outcome. EOF comes back as "" and Ctrl+C as
 *  QUESTION_CANCELLED -- both questionOrEmpty's doing; a bare rl.question()
 *  never settles once its input closes. */
async function readlineAnswer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  terminal: boolean | undefined,
): Promise<string | QuestionCancelled> {
  const rl = createInterface({ input, output, terminal });
  try {
    return await questionOrEmpty(rl, question);
  } finally {
    rl.close();
  }
}

/** Ask a [y/N] confirmation and hand back the answer trimmed and lower-cased,
 *  for the caller to compare against "y" / "yes". The callers default to NO,
 *  so a bare Enter, a stray keystroke and EOF (^D, a piped stdin running dry)
 *  all decline. With the default reader Ctrl+C comes back as
 *  QUESTION_CANCELLED rather than a string: it is the user leaving, not
 *  answering, and the commands that use that reader exit 130 on it. `read`
 *  replaces only the reading; the promptAnswer short-circuit and the
 *  normalizing stay. */
export async function askYesNo(
  opts: YesNoOptions,
  question: string,
  read: AnswerReader = readlineAnswer,
): Promise<string | QuestionCancelled> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  const raw = await read(input, output, question, opts.io?.terminal);
  return raw === QUESTION_CANCELLED ? raw : raw.trim().toLowerCase();
}
