import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type AnswerReader, askYesNo, QUESTION_CANCELLED, questionOrEmpty } from "../readline-question.js";

function makeRl(): { rl: ReturnType<typeof createInterface>; input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // never let the prompt echo back-pressure the test
  const rl = createInterface({ input, output });
  return { rl, input, output };
}

describe("questionOrEmpty", () => {
  it("returns the typed line when one arrives", async () => {
    const { rl, input } = makeRl();
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.write("y\n");
    await expect(pending).resolves.toBe("y");
    rl.close();
  });

  it("settles to an empty answer when the input hits EOF before any line", async () => {
    // The raw `rl.question()` promise stays pending forever here (Node 22:
    // the interface closes, the promise does not settle). The wrapper must
    // hand back "" so the caller's bare-Enter default applies.
    const { rl, input } = makeRl();
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.end();
    await expect(pending).resolves.toBe("");
    // `closed` is a runtime property of readline's Interface that the bundled
    // @types/node does not declare, hence the cast (same shape the helper uses).
    expect((rl as { closed?: boolean }).closed).toBe(true);
  });

  it("returns an empty answer immediately on an interface that is already closed", async () => {
    const { rl } = makeRl();
    rl.close();
    await expect(questionOrEmpty(rl, "Remove? [y/N] ")).resolves.toBe("");
  });

  it("does not leave a close listener behind after a normal answer", async () => {
    const { rl, input } = makeRl();
    const before = rl.listenerCount("close");
    const beforeSigint = rl.listenerCount("SIGINT");
    const pending = questionOrEmpty(rl, "? ");
    input.write("ok\n");
    await pending;
    expect(rl.listenerCount("close")).toBe(before);
    expect(rl.listenerCount("SIGINT")).toBe(beforeSigint);
    rl.close();
  });

  it("returns QUESTION_CANCELLED, not the empty default, on Ctrl+C at the prompt", async () => {
    // On a real terminal readline owns the keypress: with no SIGINT listener
    // on the interface it closes the interface and raises no process signal,
    // so a close-only handler turned a cancel into the DEFAULT answer --
    // `install` answered its own collision prompt with "skip" and printed a
    // success line at exit 0. terminal:true so the keypress path is live, as
    // it is on a TTY; ETX (code 3) is the byte the terminal delivers for
    // Ctrl+C, built from the code so no control byte sits in this source.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = createInterface({ input, output, terminal: true });
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.write(String.fromCharCode(3));
    await expect(pending).resolves.toBe(QUESTION_CANCELLED);
    rl.close();
  });

  it("still reads EOF as the empty default when no Ctrl+C was pressed", async () => {
    // Positive control for the cancel case: closing the input WITHOUT the
    // keypress must keep resolving "" -- EOF is the safe default, not a cancel.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = createInterface({ input, output, terminal: true });
    const pending = questionOrEmpty(rl, "Remove? [y/N] ");
    input.end();
    await expect(pending).resolves.toBe("");
  });
});

// The [y/N] confirmation import, remove, set, reset-learning, try-cleanup and
// trust all call. These pin the contract each of those commands relied on
// when it had its own copy.
describe("askYesNo", () => {
  function streams(): { input: PassThrough; output: PassThrough; written: () => string } {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (c: Buffer) => {
      text += c.toString("utf8");
    });
    return { input, output, written: () => text };
  }

  it("returns promptAnswer trimmed and lower-cased without asking anything", async () => {
    const { input, output, written } = streams();
    const read = vi.fn<AnswerReader>();
    await expect(
      askYesNo({ promptAnswer: "  YeS \n", io: { stdin: input, stdout: output } }, "Remove? [y/N] ", read),
    ).resolves.toBe("yes");
    expect(read).not.toHaveBeenCalled();
    expect(written()).toBe("");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("asks on the io streams and returns the typed line trimmed and lower-cased", async () => {
    const { input, output, written } = streams();
    const pending = askYesNo({ io: { stdin: input, stdout: output } }, "Remove? [y/N] ");
    input.write("  Y \n");
    await expect(pending).resolves.toBe("y");
    expect(written()).toContain("Remove? [y/N] ");
  });

  it("closes the interface it opened, whatever the answer", async () => {
    // A readline interface left open keeps its listeners on stdin, and on a
    // real stdin that holds the process open after the command is done.
    const { input, output } = streams();
    const pending = askYesNo({ io: { stdin: input, stdout: output } }, "? ");
    expect(input.listenerCount("data")).toBeGreaterThan(0);
    input.write("n\n");
    await expect(pending).resolves.toBe("n");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("reads EOF as the empty answer, which every caller takes as NO", async () => {
    const { input, output } = streams();
    const pending = askYesNo({ io: { stdin: input, stdout: output } }, "Remove? [y/N] ");
    input.end();
    await expect(pending).resolves.toBe("");
  });

  it("returns QUESTION_CANCELLED on Ctrl+C, not the empty default", async () => {
    // terminal:true so readline owns the keypress, as on a TTY; ETX (code 3)
    // is what the terminal delivers for Ctrl+C.
    const { input, output } = streams();
    const pending = askYesNo({ io: { stdin: input, stdout: output, terminal: true } }, "Remove? [y/N] ");
    input.write(String.fromCharCode(3));
    await expect(pending).resolves.toBe(QUESTION_CANCELLED);
    // Closed on this path too. A terminal-mode interface reads keypresses, and
    // its keypress listener is what close() removes; the byte decoder
    // emitKeypressEvents put on the stream's "data" stays by node's design.
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("hands a custom reader the streams, question and terminal flag, and normalizes its answer", async () => {
    const { input, output } = streams();
    const read = vi.fn<AnswerReader>(async () => "  YES ");
    await expect(
      askYesNo({ io: { stdin: input, stdout: output, terminal: false } }, "Approve? [y/N] ", read),
    ).resolves.toBe("yes");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(input, output, "Approve? [y/N] ", false);
  });

  it("passes a custom reader's QUESTION_CANCELLED through unchanged", async () => {
    const read = vi.fn<AnswerReader>(async () => QUESTION_CANCELLED);
    await expect(askYesNo({ io: { stdin: new PassThrough(), stdout: new PassThrough() } }, "? ", read)).resolves.toBe(
      QUESTION_CANCELLED,
    );
  });

  it("falls back to process.stdin and process.stdout when no io is given", async () => {
    // Through a stand-in reader, so nothing actually reads the test runner's stdin.
    const read = vi.fn<AnswerReader>(async () => "no");
    await expect(askYesNo({}, "? ", read)).resolves.toBe("no");
    expect(read).toHaveBeenCalledWith(process.stdin, process.stdout, "? ", undefined);
  });
});
