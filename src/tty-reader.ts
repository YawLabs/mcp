// The raw-mode line reader behind the `secrets` and `trust` prompts.
//
// `yaw-mcp secrets` reads its passphrases, its secret value and its
// destructive-action confirmation here; `yaw-mcp trust` reads its approval
// prompt and its two build prompts here (readAnswerFromTTY). Every other
// prompt in the CLI goes through node:readline instead (readline-question.ts).
// One reader for these two commands means Backspace and a stray ESC behave
// identically at all of their prompts -- the fix for an arrow key at a [y/N]
// prompt (a raw ESC echoed back is EXECUTED by the terminal, and "\x1by" is
// not "y", so the answer silently flipped) landed here once instead of in a
// copy per command.
//
// A LEAF module on purpose: it imports nothing from the rest of the CLI, so
// trust-cmd.ts can share the reader without pulling the secret-vault graph
// (secrets-cmd.ts and everything under it) into a command that never opens
// the vault.
//
// Nothing here ever calls process.exit(): the streams are injectable, so a
// test or an embedder must not be able to kill the host process by feeding
// it a 0x03 byte. The reader resolves CANCELLED and the caller owns the exit.

import { StringDecoder } from "node:string_decoder";

/** Returned by the readers when the user hits ^C at a prompt. Distinct from
 *  "" (empty submission -> the caller re-prompts or takes its default) and
 *  from null (no prompt was possible). secrets-cmd maps it to exitCode 130
 *  (128 + SIGINT); readAnswerFromTTY hands it on as null. */
export const CANCELLED: unique symbol = Symbol("yaw-mcp:passphrase-cancelled");
export type Cancelled = typeof CANCELLED;

/** Returned by the no-echo reads when the terminal could not be switched to
 *  raw mode. Raw mode is what turns echo OFF: without it the read would be
 *  line-buffered by the terminal, which ECHOES every character -- the secret
 *  on screen, in plain text, for anyone walking by. So the no-echo prompts
 *  refuse instead (secrets-cmd's noEchoRefusal). Distinct from CANCELLED (the
 *  user did nothing) and from null (no prompt was possible at all). */
export const NO_ECHO: unique symbol = Symbol("yaw-mcp:no-echo-unavailable");
export type NoEcho = typeof NO_ECHO;

/** Returned by readAnswerFromTTY when the user hit ^D at the prompt, or the
 *  stream ended under it (what ^D becomes when raw mode was refused). Distinct
 *  from "" (a bare Enter), because a [Y/n] prompt takes a bare Enter as YES
 *  and ^D must never be consent. readLineFromTTY does not hand this out: its
 *  callers all want ^D as the empty entry. */
export const ANSWER_EOF: unique symbol = Symbol("yaw-mcp:answer-eof");
export type AnswerEof = typeof ANSWER_EOF;

/** Control bytes the raw-mode reader reacts to. Spelled as escapes: the
 *  literal bytes are invisible in an editor and get mangled by tooling. */
const CTRL_C = "\x03"; // ETX -- cancel the whole command
const CTRL_D = "\x04"; // EOT -- cancel this entry (resolves as an empty one)
const TAB = "\x09"; // HT -- kept only at the secret-value prompt (keepTab)
const DEL = "\x7f"; // what most terminals send for Backspace
const ESC = "\x1b"; // opens a key sequence (arrow, Alt chord) -- never input

/**
 * Everything a terminal may act on rather than print, as a regex character
 * class: C0 (incl. ESC, BEL, BS, CR), DEL, the C1 block (0x9b is CSI in its
 * 8-bit form), the zero-width and line/paragraph separators, and the bidi
 * overrides / isolates, which can visually reorder text without changing a
 * byte of it.
 *
 * Declared here, in the leaf, and imported by trust-cmd.ts for its review
 * rendering: the reader's echo path below and the review are the two places
 * these commands write untrusted text to a terminal, and they must agree on
 * what counts as a control.
 */
export const DISPLAY_CONTROL_SOURCE =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]";
const DISPLAY_CONTROL_RE = new RegExp(DISPLAY_CONTROL_SOURCE);

/** Raw-mode line reader for the controlling TTY. Shared by the passphrase
 *  prompts (echo OFF -- the default), the destructive-action confirmation
 *  (echo ON, so the user can see the y/n they typed), and -- via
 *  readAnswerFromTTY below -- `yaw-mcp trust`'s approval and build prompts.
 *
 *  A no-echo read that cannot enter raw mode resolves NO_ECHO without
 *  writing the prompt or reading a byte. An echo read carries on
 *  line-buffered: its answer was going to be shown anyway, and the terminal
 *  echoes it there, so the reader writes nothing back but the prompt.
 *
 *  `keepTab` (no-echo reads only) buffers a Tab instead of dropping it with
 *  the other control bytes; only the secret-value prompt sets it -- see the
 *  drop below. */
export function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt: string,
  echo: true,
): Promise<string | Cancelled>;
export function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt?: string,
  echo?: false,
  keepTab?: boolean,
): Promise<string | Cancelled | NoEcho>;
export function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt = "Vault passphrase: ",
  echo = false,
  keepTab = false,
): Promise<string | Cancelled | NoEcho> {
  return readLine(stdin, stdout, prompt, echo, keepTab).then((value) => (value === ANSWER_EOF ? "" : value));
}

/** Streams whose last read submitted on a \r that was the FINAL byte of its
 *  chunk, on a stream that was NOT in raw mode (a pipe, or the cooked echo
 *  fallback). A writer there can send the CRLF of one line as "\r" in one
 *  read and "\n" at the head of the next; the next read swallows that
 *  leading \n instead of taking it for an empty submission -- but only when
 *  it is the first byte of the very next chunk. Never armed in raw mode: a
 *  raw TTY sends a lone \r for every Enter, so the flag would be set after
 *  nearly every prompt and eat a Ctrl+J (\n) typed first at the next one.
 *  Weak, so a stream that goes away takes its flag with it. */
const crAwaitingLf = new WeakSet<object>();

/** How many leading bytes of `bytes` decode to the first `chars` UTF-16
 *  code units of their UTF-8 decoding. Decodes one byte at a time, so a
 *  malformed sequence maps to the bytes that really carried it rather than
 *  to the 3-byte re-encoding of the U+FFFD it decoded as. `chars` always ends
 *  on an ASCII terminator here, which the decoder emits on its own byte. */
function byteOffsetOfChars(bytes: Buffer, chars: number): number {
  const decoder = new StringDecoder("utf8");
  let decoded = 0;
  for (let i = 0; i < bytes.length; i++) {
    decoded += decoder.write(bytes.subarray(i, i + 1)).length;
    if (decoded >= chars) return i + 1;
  }
  return bytes.length;
}

/** How many trailing bytes of `buf` are the start of a UTF-8 sequence whose
 *  remaining bytes have not arrived yet -- the bytes a StringDecoder holds
 *  back. Tracked so the next chunk can be mapped back to its bytes. */
function incompleteUtf8Tail(buf: Buffer): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = b >= 0xf8 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** The reader itself. Resolves ANSWER_EOF for ^D, and for a stream that ends
 *  or closes before a line is submitted, so readAnswerFromTTY can tell it
 *  from a bare Enter; readLineFromTTY folds it into "". Rejects only when
 *  writing the prompt, resuming stdin, or writing the closing newline in
 *  finish() throws -- in every case after raw mode has been restored. */
function readLine(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt: string,
  echo: boolean,
  keepTab: boolean,
): Promise<string | Cancelled | NoEcho | AnswerEof> {
  return new Promise<string | Cancelled | NoEcho | AnswerEof>((resolve, reject) => {
    // The entry is collected as JS strings, one per character, and joined at
    // the end. JS strings are immutable and garbage-collected: none of these
    // (nor the joined passphrase handed to the caller) can be zeroed, so a
    // typed passphrase or secret value stays in the heap until the GC reuses
    // that memory. A Buffer could be wiped, but every consumer downstream
    // (scrypt's password argument, the vault cache) takes a string anyway, so
    // wiping here alone would buy nothing. A known limitation, not an oversight.
    const chunks: string[] = [];
    const wasRaw = stdin.isRaw === true;
    // Raw mode BEFORE the prompt is written, so a refused no-echo read leaves
    // no dangling "Vault passphrase: " on the line. A stream with no
    // setRawMode at all is treated as a failure on the no-echo path too:
    // every no-echo caller reads only when stdin.isTTY is true, and a TTY
    // that cannot be put in raw mode echoes.
    let raw = false;
    try {
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
        raw = true;
      }
    } catch {
      // Raw mode refused; handled just below.
    }
    if (!raw && !echo) {
      resolve(NO_ECHO);
      return;
    }
    // Write typed bytes back (and the closing newline) only in raw mode. On
    // the cooked fallback the terminal's line discipline has already echoed
    // every keystroke and the Enter before the line reaches us, so echoing
    // again showed the answer twice.
    const echoBack = echo && raw;
    // Decoded here rather than with stdin.setEncoding("utf8"): setEncoding
    // cannot be undone, and it left the CALLER's stdin in string mode after
    // the prompt. The decoder keeps the split-UTF-8 safety (a character whose
    // bytes straddle two reads is held until it is complete). A stream that
    // already delivers strings (the caller set an encoding, or a test pushes
    // them) is taken as is.
    const decoder = new StringDecoder("utf8");
    // The undecoded bytes the decoder is holding, tracked so they can be
    // re-buffered with the rest of the chunk when this read ends.
    let held: Buffer = Buffer.alloc(0);
    // The previous read on this stream submitted on a \r that ended its
    // chunk: a \n that is the FIRST byte of the first chunk here is that
    // Enter's other half. onData clears it after that one chunk.
    let swallowLeadingLf = crAwaitingLf.delete(stdin);
    // Undo everything the read set up: detach the listeners, restore the
    // previous raw mode, pause stdin. Never throws, so it can run on the
    // failure path below as well as on every settle.
    // No signal handler is installed here, on purpose. A SIGTERM or SIGINT
    // during a prompt already restores the terminal: on POSIX, node's own
    // default handler (SignalExit in src/node.cc) calls ResetStdio(), which
    // re-applies the termios captured at startup, then re-raises the signal;
    // and ResetStdio also runs atexit, so a JS handler that exits does too.
    // SIGHUP means the terminal itself is gone, so there is nothing to
    // restore. A listener here would only replace node's handler with a
    // weaker copy of it.
    const teardown = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
    };
    // Single settle path: the closing newline, teardown, then settle. Every
    // exit from onData goes through it, and so does a stream that ends
    // (onEnd). `endedOnCr` marks a submit on a \r that was the last byte of
    // its chunk (see crAwaitingLf).
    let settled = false;
    const finish = (value: string | Cancelled | AnswerEof, endedOnCr = false): void => {
      if (settled) return;
      settled = true;
      try {
        if (raw) stdout.write("\n");
      } catch (err) {
        teardown();
        reject(err);
        return;
      }
      if (endedOnCr && !raw) crAwaitingLf.add(stdin);
      teardown();
      resolve(value);
    };
    // Setup after raw mode is ON: a throw from either call used to escape
    // the executor with the terminal still in raw mode (the promise rejected,
    // but nothing restored the mode). Now it runs the same teardown first.
    try {
      stdout.write(prompt);
      stdin.resume();
    } catch (err) {
      settled = true;
      teardown();
      reject(err);
      return;
    }
    // Escape-sequence parser state, carried ACROSS chunks: a terminal can
    // split an arrow key's bytes over two reads, and the tail of one must
    // not be taken for typed text.
    let esc: "none" | "esc" | "seq" = "none";
    // The stream ended with no terminating byte: the same outcome as ^D.
    // Without this the promise never settled. A terminal in cooked mode (the
    // echo fallback above) turns ^D into a stream end instead of a 0x04 byte,
    // and a stream can close under a prompt; either way the caller hung, the
    // event loop drained, and the process exited 0 with nothing decided.
    // Anything typed before the end is dropped, as it is for the ^D byte.
    function onEnd(): void {
      finish(ANSWER_EOF);
    }
    // Hoisted declaration so `teardown` above can name it.
    function onData(chunk: string | Buffer): void {
      let text: string;
      // For a Buffer chunk: the decoder's held bytes from the previous chunk
      // followed by this one -- exactly the bytes `text` (plus the new held
      // tail) decodes from, so a char offset in `text` maps back into it.
      let bytes: Buffer | null = null;
      if (typeof chunk === "string") {
        text = chunk;
      } else {
        bytes = held.length > 0 ? Buffer.concat([held, chunk]) : chunk;
        held = Buffer.from(bytes.subarray(bytes.length - incompleteUtf8Tail(bytes)));
        text = decoder.write(chunk);
      }
      let consumed = 0;
      // The split-CRLF swallow applies to the first byte of this one chunk
      // only; whatever this chunk holds, the flag does not outlive it.
      const lfMayLead = swallowLeadingLf;
      swallowLeadingLf = false;
      if (lfMayLead && text.startsWith("\n")) consumed = 1;
      // Settle, then RE-BUFFER whatever follows the byte that ended this
      // read. A terminal paste arrives as one chunk, so without this,
      // pasting "passphrase\nvalue\n" consumed the passphrase and silently
      // dropped the value line -- the next prompt then hung waiting for
      // input the user believes they already gave. unshift() puts the
      // residual at the head of the stream (finish() has already paused
      // it), so the NEXT reader's resume() picks it up. A string chunk is
      // handed back as a string. A Buffer chunk is handed back as the
      // ORIGINAL bytes past the terminator (sliced, never re-encoded from the
      // decoded text, so an invalid byte is not turned into EF BF BD), the
      // decoder's held-back partial character included. Optional call: the
      // injectable io contract only promises a ReadableStream shape.
      const finishAndRebuffer = (value: string | Cancelled | AnswerEof, endedOnCr = false): void => {
        finish(value, endedOnCr);
        const back: string | Buffer =
          bytes === null ? text.slice(consumed) : bytes.subarray(byteOffsetOfChars(bytes, consumed));
        if (back.length > 0) (stdin as { unshift?: (c: string | Buffer) => void }).unshift?.(back);
      };
      for (const ch of text.slice(consumed)) {
        consumed += ch.length;
        // ESC "[" (CSI) and ESC "O" (SS3) open a key sequence the terminal
        // sent on the user's behalf -- an arrow, Home/End, a function key --
        // and NONE of its bytes is input. Dropping only the 0x1b byte and
        // buffering the rest inserted "[D" / "[A" into the NO-ECHO value and
        // passphrase prompts, where the user could not see the corruption: a
        // Left arrow to fix a typo in a pasted token stored `ghp_abc[D`, and
        // the server later failed auth with nothing pointing at the vault.
        // Per ECMA-48 a sequence is parameter/intermediate bytes 0x20-0x3f,
        // then ONE final byte 0x40-0x7e; anything else (a control byte, DEL,
        // a non-ASCII character) ends the sequence and is handled as typed.
        // Dropping every byte >= 0x20 until a final byte lost an Alt+[ chord
        // followed by a non-ASCII passphrase. Any OTHER byte after an ESC is
        // handled as typed too: the ESC was a lone Escape key, or the meta
        // prefix of an Alt chord, and neither is a reason to lose the
        // keystroke that follows -- so Escape-then-Enter still submits, and
        // Escape-then-y at a [y/N] prompt is still a y.
        if (esc === "esc") {
          esc = "none";
          if (ch === "[" || ch === "O") {
            esc = "seq";
            continue;
          }
        } else if (esc === "seq") {
          if (ch >= " " && ch <= "?") continue; // parameter / intermediate byte
          esc = "none";
          if (ch >= "@" && ch <= "~") continue; // final byte: the sequence is over
        }
        if (ch === ESC) {
          esc = "esc";
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          // A pasted CRLF is ONE Enter: swallow the \n so it cannot be
          // re-buffered and submit the next prompt as empty. When the \r is
          // the last byte of the chunk, the \n may still be on its way: the
          // next read on this stream swallows it (crAwaitingLf).
          let endedOnCr = false;
          if (ch === "\r") {
            if (text[consumed] === "\n") consumed += 1;
            else endedOnCr = consumed === text.length && held.length === 0;
          }
          finishAndRebuffer(chunks.join(""), endedOnCr);
          return;
        }
        if (ch === CTRL_D) {
          // Cancel this entry. Never a line terminator that would submit a
          // partial entry. readLineFromTTY's callers get "", an empty
          // submission: the no-echo prompts (passphrase and value) re-prompt
          // on it, and the secrets y/N and RESET confirmations read it as
          // no. readAnswerFromTTY hands ANSWER_EOF on, so a [Y/n] prompt
          // cannot take it for the bare Enter that means yes.
          finishAndRebuffer(ANSWER_EOF);
          return;
        }
        if (ch === CTRL_C) {
          // Cancel the command. We deliberately do NOT process.exit() here:
          // the io streams are injectable, so a fed 0x03 must not be able to
          // kill the host process. The caller maps CANCELLED to exit 130.
          finishAndRebuffer(CANCELLED);
          return;
        }
        if (ch === "\b" || ch === DEL) {
          if (chunks.length > 0) {
            chunks.pop();
            if (echoBack) stdout.write("\b \b");
          }
          continue;
        }
        // Drop every remaining C0 control byte instead of buffering + echoing
        // it. On the echo path (the y/n confirmation) a raw control byte
        // written back is EXECUTED by the terminal rather than displayed.
        // Everything else meaningful (\n \r ^C ^D \b ESC) is handled above.
        // The echo reads go further, just below: C0 is not the whole set a
        // terminal acts on.
        // The one byte kept is a Tab at the secret-VALUE prompt (keepTab): a
        // pasted token can carry one, and dropping it stored a different
        // secret behind a green "Stored secret", with nothing on the no-echo
        // line to show it (a piped value always kept it). The passphrase
        // prompts still drop it, deliberately: a vault created by typing a
        // Tab there is keyed under the Tab-less string, and keeping the byte
        // now would stop the same keystrokes opening that vault.
        if (ch < " " && !(keepTab && ch === TAB)) continue;
        // An ECHO read also drops the rest of the display-control class: the
        // C1 block (U+009B is an 8-bit CSI, so a pasted one opens a sequence
        // the terminal runs when it is written back) and the zero-width and
        // bidi controls, which make the echoed answer read as something other
        // than what was buffered. Echo reads only: a no-echo read writes
        // nothing back, and a passphrase or secret value is kept exactly as
        // typed beyond the C0 drop above -- stripping more there would stop
        // the same keystrokes opening a vault keyed under them.
        if (echo && DISPLAY_CONTROL_RE.test(ch)) continue;
        chunks.push(ch);
        if (echoBack) stdout.write(ch);
      }
    }
    stdin.on("data", onData);
    // `on`, not `once`: finish() detaches both, and the injectable stream
    // contract here only promises on/removeListener.
    stdin.on("end", onEnd);
    stdin.on("close", onEnd);
    // A stream that ended BEFORE this read emits neither event again, so the
    // re-prompt after an end-of-stream would wait forever; this is what lets
    // the callers' retry caps actually run out on a closed stream.
    if (stdin.readableEnded || stdin.destroyed) onEnd();
  });
}

/**
 * Ask a one-line question on the terminal and hand back what was typed
 * (trimmed, lowercased by the caller). Returns null when the user hit ^C and
 * ANSWER_EOF when they hit ^D or the stream ended -- neither is an answer,
 * and ^D in particular must not come back as the "" a bare Enter produces.
 *
 * Exists so `yaw-mcp trust` and `yaw-mcp secrets` share ONE prompt reader
 * instead of two. trust-cmd used node:readline, secrets-cmd used the raw-mode
 * reader above, and the fix for an ESC/arrow key at a [y/N] prompt landed in
 * only one of them. Two implementations of "read one confirmation" drift;
 * this is the one.
 *
 * Echo is ON: a y/n answer is not a secret, and the user has to see it.
 */
export async function readAnswerFromTTY(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  question: string,
): Promise<string | AnswerEof | null> {
  // echo is true, so NO_ECHO (the refusal of a no-echo read) cannot come back.
  const answer = (await readLine(stdin as NodeJS.ReadStream, stdout, question, true, false)) as
    | string
    | Cancelled
    | AnswerEof;
  return answer === CANCELLED ? null : answer;
}
