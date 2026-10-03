// tty-reader.ts in isolation: the raw-mode reader every CLI prompt shares.
//
// secrets-cmd.test.ts and trust-cmd.test.ts drive the same reader through
// their commands; this file pins the reader's OWN contract -- the ESC/CSI
// state machine in particular -- against injected streams, so a regression
// is named here before it surfaces as "the passphrase prompt stored `[D`".

import { describe, expect, it, vi } from "vitest";
import { CANCELLED, NO_ECHO, readAnswerFromTTY, readLineFromTTY } from "../tty-reader.js";

/** Minimal controllable fake of a TTY ReadStream. Each `resume()` (one per
 *  prompt) flushes the next queued chunk to the registered "data" listener on
 *  the next microtask, so a sequence split across chunks arrives the way a
 *  terminal splits an arrow key over two reads. */
class FakeTTYStdin {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];
  private listener: ((chunk: string) => void) | null = null;
  private queue: string[];
  setRawMode?: (v: boolean) => this = (v) => {
    this.isRaw = v;
    this.rawModeCalls.push(v);
    return this;
  };
  constructor(chunks: string[]) {
    this.queue = [...chunks];
  }
  get pending(): number {
    return this.queue.length;
  }
  setEncoding(): this {
    return this;
  }
  on(event: string, cb: (chunk: string) => void): this {
    if (event === "data") this.listener = cb;
    return this;
  }
  removeListener(event: string, cb: (chunk: string) => void): this {
    if (event === "data" && this.listener === cb) this.listener = null;
    return this;
  }
  resume(): this {
    const next = this.queue.shift();
    if (next !== undefined) queueMicrotask(() => this.listener?.(next));
    return this;
  }
  pause(): this {
    return this;
  }
  unshift(chunk: string): void {
    this.queue.unshift(chunk);
  }
}

function fakeStdout(): { stream: NodeJS.WritableStream; text: () => string } {
  const write = vi.fn();
  return {
    stream: { write } as unknown as NodeJS.WritableStream,
    text: () => write.mock.calls.map((c) => c[0] as string).join(""),
  };
}

const asStream = (s: FakeTTYStdin): NodeJS.ReadStream => s as unknown as NodeJS.ReadStream;

describe("readLineFromTTY -- ESC / CSI / SS3 state machine", () => {
  it("drops a whole CSI sequence (Left arrow) and keeps the typed text around it", async () => {
    const stdin = new FakeTTYStdin(["ab\x1b[Dc\n"]);
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("abc");
  });

  it("carries the parser state ACROSS chunks: an arrow split over two reads is still one arrow", async () => {
    // A terminal can hand over ESC in one read and "[D" in the next; the
    // tail must not be taken for typed text.
    const stdin = new FakeTTYStdin(["ab\x1b", "[Dc\n"]);
    const { stream } = fakeStdout();
    // The second chunk is delivered by the SAME listener: resume() only
    // flushes one chunk, so push the next by hand once the first lands.
    const read = readLineFromTTY(asStream(stdin), stream);
    await new Promise((r) => setTimeout(r, 0));
    stdin.resume();
    expect(await read).toBe("abc");
  });

  it("drops a parameterised CSI (ESC [ 1 ; 5 D) through its final byte", async () => {
    const stdin = new FakeTTYStdin(["x\x1b[1;5Dy\n"]);
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("xy");
  });

  it("drops an SS3 sequence (ESC O A -- an arrow in application mode)", async () => {
    const stdin = new FakeTTYStdin(["x\x1bOAy\n"]);
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("xy");
  });

  it("treats a lone Escape as nothing: Escape-then-y is y, Escape-then-Enter submits", async () => {
    const first = new FakeTTYStdin(["\x1by\n"]);
    expect(await readLineFromTTY(asStream(first), fakeStdout().stream, "? ", true)).toBe("y");
    const second = new FakeTTYStdin(["ab\x1b\n"]);
    expect(await readLineFromTTY(asStream(second), fakeStdout().stream)).toBe("ab");
  });

  it("a control byte never continues a sequence: ESC [ then Enter submits what came before", async () => {
    const stdin = new FakeTTYStdin(["ab\x1b[\n"]);
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("ab");
  });

  it("never echoes a sequence byte on the echo path, so the terminal cannot execute it", async () => {
    const stdin = new FakeTTYStdin(["y\x1b[A\n"]);
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "Q ", true)).toBe("y");
    expect(text()).toBe("Q y\n");
    expect(text()).not.toContain("\x1b");
  });
});

describe("readLineFromTTY -- control bytes and echo", () => {
  it("^C resolves CANCELLED and ^D resolves an empty entry, never a partial submit", async () => {
    const c = new FakeTTYStdin(["abc\x03rest\n"]);
    expect(await readLineFromTTY(asStream(c), fakeStdout().stream)).toBe(CANCELLED);
    const d = new FakeTTYStdin(["abc\x04\n"]);
    expect(await readLineFromTTY(asStream(d), fakeStdout().stream)).toBe("");
  });

  it("Backspace and DEL erase the previous character; on the echo path the screen is repainted", async () => {
    const stdin = new FakeTTYStdin(["ab\x7fc\bd\n"]);
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "> ", true)).toBe("ad");
    expect(text()).toBe("> ab\b \bc\b \bd\n");
  });

  it("no-echo reads write only the prompt and the newline", async () => {
    const stdin = new FakeTTYStdin(["secret\n"]);
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "Vault passphrase: ")).toBe("secret");
    expect(text()).toBe("Vault passphrase: \n");
  });

  it("drops other control bytes, keeping a Tab only when keepTab is set", async () => {
    const dropped = new FakeTTYStdin(["a\tb\x01c\n"]);
    expect(await readLineFromTTY(asStream(dropped), fakeStdout().stream)).toBe("abc");
    const kept = new FakeTTYStdin(["a\tb\x01c\n"]);
    expect(await readLineFromTTY(asStream(kept), fakeStdout().stream, "v: ", false, true)).toBe("a\tbc");
  });

  it("a pasted CRLF is one Enter, and what follows the terminator is re-buffered for the next read", async () => {
    const stdin = new FakeTTYStdin(["first\r\nsecond\n"]);
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("first");
    expect(stdin.pending).toBe(1);
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe("second");
  });

  it("restores the previous raw mode on every exit", async () => {
    const stdin = new FakeTTYStdin(["x\n"]);
    await readLineFromTTY(asStream(stdin), fakeStdout().stream);
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });
});

describe("readLineFromTTY -- raw mode unavailable", () => {
  it("a no-echo read resolves NO_ECHO without writing the prompt or reading a byte", async () => {
    const stdin = new FakeTTYStdin(["secret\n"]);
    stdin.setRawMode = undefined;
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream)).toBe(NO_ECHO);
    expect(text()).toBe("");
    expect(stdin.pending).toBe(1);
  });

  it("an echo read carries on line-buffered when setRawMode throws", async () => {
    const stdin = new FakeTTYStdin(["y\n"]);
    stdin.setRawMode = () => {
      throw new Error("EIO: i/o error, setRawMode");
    };
    const { stream } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "? ", true)).toBe("y");
  });
});

describe("readAnswerFromTTY", () => {
  it("hands back the typed answer untouched and null for ^C", async () => {
    const typed = new FakeTTYStdin([" Yes \n"]);
    expect(await readAnswerFromTTY(typed as unknown as NodeJS.ReadableStream, fakeStdout().stream, "? ")).toBe(" Yes ");
    const cancelled = new FakeTTYStdin(["\x03"]);
    expect(await readAnswerFromTTY(cancelled as unknown as NodeJS.ReadableStream, fakeStdout().stream, "? ")).toBe(
      null,
    );
  });
});
