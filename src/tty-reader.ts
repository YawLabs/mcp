// The one raw-mode line reader behind every interactive prompt in the CLI.
//
// `yaw-mcp secrets` reads its passphrases, its secret value and its
// destructive-action confirmation here; `yaw-mcp trust` reads its approval
// prompt here (readAnswerFromTTY). One reader means ^C / ^D / Backspace / a
// stray ESC behave identically at every prompt in the product -- the fix for
// an arrow key at a [y/N] prompt (a raw ESC echoed back is EXECUTED by the
// terminal, and "\x1by" is not "y", so the answer silently flipped) landed
// here once instead of in a copy per command.
//
// A LEAF module on purpose: it imports nothing from the rest of the CLI, so
// trust-cmd.ts can share the reader without pulling the secret-vault graph
// (secrets-cmd.ts and everything under it) into a command that never opens
// the vault.
//
// Nothing here ever calls process.exit(): the streams are injectable, so a
// test or an embedder must not be able to kill the host process by feeding
// it a 0x03 byte. The reader resolves CANCELLED and the caller owns the exit.

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

/** Control bytes the raw-mode reader reacts to. Spelled as escapes: the
 *  literal bytes are invisible in an editor and get mangled by tooling. */
const CTRL_C = "\x03"; // ETX -- cancel the whole command
const CTRL_D = "\x04"; // EOT -- cancel this entry (resolves as an empty one)
const TAB = "\x09"; // HT -- kept only at the secret-value prompt (keepTab)
const DEL = "\x7f"; // what most terminals send for Backspace
const ESC = "\x1b"; // opens a key sequence (arrow, Alt chord) -- never input

/** Raw-mode line reader for the controlling TTY. Shared by the passphrase
 *  prompts (echo OFF -- the default), the destructive-action confirmation
 *  (echo ON, so the user can see the y/n they typed), and -- via
 *  readAnswerFromTTY below -- `yaw-mcp trust`'s approval prompt.
 *
 *  A no-echo read that cannot enter raw mode resolves NO_ECHO without
 *  writing the prompt or reading a byte. An echo read carries on
 *  line-buffered: its answer was going to be shown anyway.
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
  return new Promise<string | Cancelled | NoEcho>((resolve) => {
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
    stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding("utf8");
    // Single teardown path: detach the listener, restore the previous raw
    // mode, pause stdin, then settle. Every exit from onData goes through it.
    const finish = (value: string | Cancelled): void => {
      stdout.write("\n");
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // ignore
      }
      stdin.pause();
      resolve(value);
    };
    // Escape-sequence parser state, carried ACROSS chunks: a terminal can
    // split an arrow key's bytes over two reads, and the tail of one must
    // not be taken for typed text.
    let esc: "none" | "esc" | "seq" = "none";
    // Hoisted declaration so `finish` above can name it.
    function onData(chunk: string): void {
      let consumed = 0;
      // Settle, then RE-BUFFER whatever follows the byte that ended this
      // read. A terminal paste arrives as one chunk, so without this,
      // pasting "passphrase\nvalue\n" consumed the passphrase and silently
      // dropped the value line -- the next prompt then hung waiting for
      // input the user believes they already gave. unshift() puts the
      // residual at the head of the stream (finish() has already paused
      // it), so the NEXT reader's resume() picks it up. Optional call: the
      // injectable io contract only promises a ReadableStream shape.
      const finishAndRebuffer = (value: string | Cancelled): void => {
        finish(value);
        const rest = chunk.slice(consumed);
        if (rest.length > 0) (stdin as { unshift?: (c: string) => void }).unshift?.(rest);
      };
      for (const ch of chunk) {
        consumed += ch.length;
        // ESC "[" (CSI) and ESC "O" (SS3) open a key sequence the terminal
        // sent on the user's behalf -- an arrow, Home/End, a function key --
        // and NONE of its bytes is input: it runs through a final byte in
        // 0x40-0x7e. Dropping only the 0x1b byte and buffering the rest
        // inserted "[D" / "[A" into the NO-ECHO value and passphrase prompts,
        // where the user could not see the corruption: a Left arrow to fix a
        // typo in a pasted token stored `ghp_abc[D`, and the server later
        // failed auth with nothing pointing at the vault. Any OTHER byte
        // after an ESC is handled as typed: the ESC was a lone Escape key,
        // or the meta prefix of an Alt chord, and neither is a reason to
        // lose the keystroke that follows -- so Escape-then-Enter still
        // submits, and Escape-then-y at a [y/N] prompt is still a y. A
        // control byte never continues a sequence either.
        if (esc === "esc") {
          esc = "none";
          if (ch === "[" || ch === "O") {
            esc = "seq";
            continue;
          }
        } else if (esc === "seq") {
          if (ch >= " ") {
            if (ch >= "@" && ch <= "~") esc = "none";
            continue;
          }
          esc = "none";
        }
        if (ch === ESC) {
          esc = "esc";
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          // A pasted CRLF is ONE Enter: swallow the \n so it cannot be
          // re-buffered and submit the next prompt as empty.
          if (ch === "\r" && chunk[consumed] === "\n") consumed += 1;
          finishAndRebuffer(chunks.join(""));
          return;
        }
        if (ch === CTRL_D) {
          // Cancel this entry. Resolve to "", an empty submission -- the
          // no-echo prompts (passphrase and value) re-prompt on it, and a
          // y/N or RESET confirmation reads it as no. Never a line
          // terminator that would submit a partial entry.
          finishAndRebuffer("");
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
            if (echo) stdout.write("\b \b");
          }
          continue;
        }
        // Drop every remaining control byte instead of buffering + echoing
        // it. On the echo path (the y/n confirmation) a raw control byte
        // written back is EXECUTED by the terminal rather than displayed.
        // Everything else meaningful (\n \r ^C ^D \b ESC) is handled above.
        // The one byte kept is a Tab at the secret-VALUE prompt (keepTab): a
        // pasted token can carry one, and dropping it stored a different
        // secret behind a green "Stored secret", with nothing on the no-echo
        // line to show it (a piped value always kept it). The passphrase
        // prompts still drop it, deliberately: a vault created by typing a
        // Tab there is keyed under the Tab-less string, and keeping the byte
        // now would stop the same keystrokes opening that vault.
        if (ch < " " && !(keepTab && ch === TAB)) continue;
        chunks.push(ch);
        if (echo) stdout.write(ch);
      }
    }
    stdin.on("data", onData);
  });
}

/**
 * Ask a one-line question on the terminal and hand back what was typed
 * (trimmed, lowercased by the caller). Returns null when the user hit ^C.
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
): Promise<string | null> {
  const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, question, true);
  return answer === CANCELLED ? null : answer;
}
