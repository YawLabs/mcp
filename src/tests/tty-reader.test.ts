// tty-reader.ts in isolation: the raw-mode reader `secrets` and `trust` share.
//
// secrets-cmd.test.ts and trust-cmd.test.ts drive the same reader through
// their commands; this file pins the reader's OWN contract -- the ESC/CSI
// state machine in particular -- against injected streams, so a regression
// is named here before it surfaces as "the passphrase prompt stored `[D`".

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ANSWER_EOF, CANCELLED, NO_ECHO, readAnswerFromTTY, readLineFromTTY } from "../tty-reader.js";

/** Minimal controllable fake of a TTY ReadStream. Each `resume()` (one per
 *  prompt) flushes the next queued chunk to the registered "data" listener on
 *  the next microtask, so a sequence split across chunks arrives the way a
 *  terminal splits an arrow key over two reads. */
class FakeTTYStdin {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];
  private listener: ((chunk: string | Buffer) => void) | null = null;
  private queue: (string | Buffer)[];
  setRawMode?: (v: boolean) => this = (v) => {
    this.isRaw = v;
    this.rawModeCalls.push(v);
    return this;
  };
  constructor(chunks: (string | Buffer)[]) {
    this.queue = [...chunks];
  }
  get queued(): readonly (string | Buffer)[] {
    return this.queue;
  }
  get pending(): number {
    return this.queue.length;
  }
  setEncodingCalls = 0;
  setEncoding(): this {
    this.setEncodingCalls += 1;
    return this;
  }
  on(event: string, cb: (chunk: string | Buffer) => void): this {
    if (event === "data") this.listener = cb;
    return this;
  }
  removeListener(event: string, cb: (chunk: string | Buffer) => void): this {
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
  unshift(chunk: string | Buffer): void {
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

  it("an echo read drops C1 and bidi controls too, so none is written back to the terminal", async () => {
    // U+009B is the 8-bit CSI and U+202E a right-to-left override: both are
    // past the C0 block, and both used to be buffered AND echoed.
    // U+200B (zero-width space) rides along. All three are built from their
    // code points so no invisible character sits in this source.
    const csi = String.fromCharCode(0x9b);
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const stdin = new FakeTTYStdin([`${rlo}y${csi}8m${zwsp}\n`]);
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "? ", true)).toBe("y8m");
    expect(text()).toBe("? y8m\n");
  });

  it("a no-echo read keeps what lies past C0: a passphrase is stored as typed", async () => {
    // Zero-width space, built from its code point (see the case above).
    const zwsp = String.fromCharCode(0x200b);
    const stdin = new FakeTTYStdin([`a${zwsp}b\n`]);
    const { stream } = fakeStdout();
    const line = await readLineFromTTY(asStream(stdin), stream);
    expect(line).toBe(`a${zwsp}b`);
    expect(line).toHaveLength(3);
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
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "? ", true)).toBe("y");
    // Cooked mode: the terminal already echoed "y" and the Enter, so the
    // reader writes only the prompt -- echoing again showed the answer twice.
    expect(text()).toBe("? ");
  });

  it("an echo read in raw mode still writes the answer and the newline back", async () => {
    const stdin = new FakeTTYStdin(["y\r"]);
    const { stream, text } = fakeStdout();
    expect(await readLineFromTTY(asStream(stdin), stream, "? ", true)).toBe("y");
    expect(text()).toBe("? y\n");
  });
});

// A real stream, because the fake above never ends. PassThrough has no
// setRawMode, which is the cooked fallback an echo read carries on in -- the
// mode where a terminal turns ^D into a stream end instead of a 0x04 byte.
describe("a stream that ends without a terminating byte", () => {
  it("settles an echo read instead of hanging: '' from readLineFromTTY, ANSWER_EOF from readAnswerFromTTY", async () => {
    const line = new PassThrough();
    const pendingLine = readLineFromTTY(line as unknown as NodeJS.ReadStream, fakeStdout().stream, "? ", true);
    line.end();
    expect(await pendingLine).toBe("");

    const answer = new PassThrough();
    const pendingAnswer = readAnswerFromTTY(answer, fakeStdout().stream, "? ");
    answer.end("y");
    // Typed-but-unsubmitted text is dropped, as it is for the ^D byte: a
    // [Y/n] prompt must not take a half-typed line as an answer.
    expect(await pendingAnswer).toBe(ANSWER_EOF);
  });

  it("settles at once on a stream that had ALREADY ended, so a re-prompt loop runs out", async () => {
    const stdin = new PassThrough();
    const first = readLineFromTTY(stdin as unknown as NodeJS.ReadStream, fakeStdout().stream, "? ", true);
    stdin.end();
    expect(await first).toBe("");
    expect(await readLineFromTTY(stdin as unknown as NodeJS.ReadStream, fakeStdout().stream, "? ", true)).toBe("");
    expect(stdin.listenerCount("data") + stdin.listenerCount("end") + stdin.listenerCount("close")).toBe(0);
  });

  it("settles a raw-mode no-echo read when the stream closes under the prompt", async () => {
    const stdin = Object.assign(new PassThrough(), { isRaw: false, setRawMode: () => undefined });
    const read = readLineFromTTY(stdin as unknown as NodeJS.ReadStream, fakeStdout().stream);
    stdin.destroy();
    expect(await read).toBe("");
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

  it("hands back ANSWER_EOF for ^D and '' for a bare Enter, so a [Y/n] prompt can tell them apart", async () => {
    // Both used to be "", and a [Y/n] prompt takes "" as yes.
    const eof = new FakeTTYStdin(["\x04"]);
    expect(await readAnswerFromTTY(eof as unknown as NodeJS.ReadableStream, fakeStdout().stream, "? ")).toBe(
      ANSWER_EOF,
    );
    const typedThenEof = new FakeTTYStdin(["y\x04\n"]);
    expect(await readAnswerFromTTY(typedThenEof as unknown as NodeJS.ReadableStream, fakeStdout().stream, "? ")).toBe(
      ANSWER_EOF,
    );
    const enter = new FakeTTYStdin(["\n"]);
    expect(await readAnswerFromTTY(enter as unknown as NodeJS.ReadableStream, fakeStdout().stream, "? ")).toBe("");
  });
});

describe("readLineFromTTY -- setup failure restores raw mode", () => {
  it("rejects and restores raw mode when stdin.resume() throws after raw mode is on", async () => {
    const stdin = new FakeTTYStdin(["x\n"]);
    stdin.resume = () => {
      throw new Error("EBADF: resume");
    };
    await expect(readLineFromTTY(asStream(stdin), fakeStdout().stream)).rejects.toThrow("EBADF: resume");
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
  });

  it("rejects and restores raw mode when writing the prompt throws", async () => {
    const stdin = new FakeTTYStdin(["x\n"]);
    const stdout = {
      write: () => {
        throw new Error("EPIPE: write");
      },
    } as unknown as NodeJS.WritableStream;
    await expect(readLineFromTTY(asStream(stdin), stdout, "? ", true)).rejects.toThrow("EPIPE: write");
    expect(stdin.rawModeCalls).toEqual([true, false]);
    // Nothing was read: the queued input is still there for whoever asks next.
    expect(stdin.pending).toBe(1);
  });

  it("rejects and restores raw mode when writing the closing newline throws", async () => {
    const stdin = new FakeTTYStdin(["x\n"]);
    const stdout = {
      write: (s: string) => {
        if (s === "\n") throw new Error("EPIPE: newline");
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    await expect(readLineFromTTY(asStream(stdin), stdout)).rejects.toThrow("EPIPE: newline");
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });
});

describe("readLineFromTTY -- decoding without setEncoding", () => {
  it("never calls setEncoding, so the caller's stdin is not left in string mode", async () => {
    const stdin = new FakeTTYStdin(["x\n"]);
    await readLineFromTTY(asStream(stdin), fakeStdout().stream);
    expect(stdin.setEncodingCalls).toBe(0);
  });

  it("a real stream keeps its (null) encoding after a read", async () => {
    const stdin = Object.assign(new PassThrough(), { isRaw: false, setRawMode: () => undefined });
    const read = readLineFromTTY(stdin as unknown as NodeJS.ReadStream, fakeStdout().stream);
    stdin.write(Buffer.from("pw\n"));
    expect(await read).toBe("pw");
    expect(stdin.readableEncoding).toBe(null);
  });

  it("decodes a UTF-8 character whose bytes are split across two Buffer chunks", async () => {
    const bytes = Buffer.from("aéb\n", "utf8"); // 61 c3 a9 62 0a
    const stdin = new FakeTTYStdin([bytes.subarray(0, 2), bytes.subarray(2)]);
    const read = readLineFromTTY(asStream(stdin), fakeStdout().stream);
    await new Promise((r) => setTimeout(r, 0));
    stdin.resume();
    expect(await read).toBe("aéb");
  });

  it("re-buffers the rest of a Buffer chunk as bytes, including a held-back partial character", async () => {
    const euro = Buffer.from("€", "utf8"); // e2 82 ac
    // One chunk: the first line, then "x" and the first two bytes of a euro sign.
    const stdin = new FakeTTYStdin([Buffer.concat([Buffer.from("one\nx"), euro.subarray(0, 2)]), euro.subarray(2)]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("one");
    const back = stdin.queued[0];
    expect(Buffer.isBuffer(back)).toBe(true);
    expect((back as Buffer).equals(Buffer.concat([Buffer.from("x"), euro.subarray(0, 2)]))).toBe(true);
    // The second read gets the held bytes back and completes the character.
    const second = readLineFromTTY(asStream(stdin), fakeStdout().stream);
    await new Promise((r) => setTimeout(r, 0));
    stdin.unshift("\n");
    stdin.unshift(euro.subarray(2));
    stdin.resume();
    await new Promise((r) => setTimeout(r, 0));
    stdin.resume();
    expect(await second).toBe("x€");
  });

  it("re-buffers invalid UTF-8 after Enter as the original bytes, not as a re-encoded U+FFFD", async () => {
    const stdin = new FakeTTYStdin([Buffer.concat([Buffer.from("y\n"), Buffer.from([0xff]), Buffer.from("z")])]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("y");
    const back = stdin.queued[0];
    expect(Buffer.isBuffer(back)).toBe(true);
    expect([...(back as Buffer)]).toEqual([0xff, 0x7a]);
  });

  it("maps the byte offset past invalid UTF-8 BEFORE Enter too", async () => {
    // 0xc3 is a lead byte cut off by "a": it decodes as one U+FFFD plus "a".
    const stdin = new FakeTTYStdin([
      Buffer.concat([Buffer.from([0xc3]), Buffer.from("a\r\n"), Buffer.from([0xfe, 0x62])]),
    ]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("\ufffda");
    expect([...(stdin.queued[0] as Buffer)]).toEqual([0xfe, 0x62]);
  });

  it("hands a string chunk's leftover back as a string", async () => {
    const stdin = new FakeTTYStdin(["a\nb"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("a");
    expect(stdin.queued[0]).toBe("b");
  });

  it("still accepts string chunks", async () => {
    const stdin = new FakeTTYStdin(["str\n"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("str");
  });
});

describe("readLineFromTTY -- ECMA-48 sequence bounds", () => {
  it("a non-ASCII character after ESC [ ends the sequence and is kept (Alt+[ then a passphrase)", async () => {
    const stdin = new FakeTTYStdin(["\x1b[été\n"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("été");
  });

  it("parameter and intermediate bytes (0x20-0x3f) stay in the sequence; the final byte ends it", async () => {
    const stdin = new FakeTTYStdin(["a\x1b[1;5 ~b\n"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("ab");
  });

  it("DEL after ESC [ ends the sequence and still erases", async () => {
    const stdin = new FakeTTYStdin(["ab\x1b[\x7fc\n"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("ac");
  });
});

describe("readLineFromTTY -- CRLF split across reads", () => {
  // The split-CRLF swallow is armed only off raw mode: a pipe, or the cooked
  // echo fallback. No setRawMode is the cooked fallback, so these are echo reads.
  const cooked = (chunks: (string | Buffer)[]): FakeTTYStdin => {
    const stdin = new FakeTTYStdin(chunks);
    stdin.setRawMode = undefined;
    return stdin;
  };
  const read = (stdin: FakeTTYStdin) => readLineFromTTY(asStream(stdin), fakeStdout().stream, "? ", true);

  it("a \\r ending one chunk and a \\n starting the next is one Enter, not an empty next submission", async () => {
    const stdin = cooked(["first\r", "\nsecond\n"]);
    expect(await read(stdin)).toBe("first");
    expect(await read(stdin)).toBe("second");
  });

  it("only a LEADING \\n is swallowed: a \\r then another key leaves the next read intact", async () => {
    const stdin = cooked(["first\r", "b\n", "\n"]);
    expect(await read(stdin)).toBe("first");
    expect(await read(stdin)).toBe("b");
    // The flag was consumed by the second read: this bare Enter submits "".
    expect(await read(stdin)).toBe("");
  });

  it("re-buffered leftover ending in \\r carries the flag to the read after it", async () => {
    const stdin = cooked(["one\rtwo\r", "\nthree\n"]);
    expect(await read(stdin)).toBe("one");
    expect(await read(stdin)).toBe("two");
    expect(await read(stdin)).toBe("three");
  });

  it("a submit on \\n sets no flag: a following bare Enter still submits empty", async () => {
    const stdin = cooked(["x\n", "\n"]);
    expect(await read(stdin)).toBe("x");
    expect(await read(stdin)).toBe("");
  });

  it("is never armed in raw mode: a raw TTY's lone \\r Enter does not eat a Ctrl+J at the next prompt", async () => {
    // A raw TTY sends "\r" alone for every Enter. Arming the flag there ate a
    // \n (Ctrl+J) typed first at the next prompt, which then took "x".
    const stdin = new FakeTTYStdin(["abc\r", "\nx\r"]);
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("abc");
    expect(await readLineFromTTY(asStream(stdin), fakeStdout().stream)).toBe("");
  });

  it("the flag covers only the very next chunk: a \\n after an intervening (empty) chunk is a real Enter", async () => {
    const stdin = cooked(["first\r", Buffer.alloc(0), "\nx\n"]);
    expect(await read(stdin)).toBe("first");
    const second = read(stdin);
    await new Promise((r) => setTimeout(r, 0));
    stdin.resume();
    expect(await second).toBe("");
  });
});

describe("readLineFromTTY -- signals", () => {
  it("installs no SIGTERM/SIGHUP/SIGINT listener during a prompt, leaving node's own terminal reset in charge", async () => {
    // node's default SIGINT/SIGTERM handler resets the tty and re-raises; a
    // JS listener would replace it. See the teardown comment in tty-reader.ts.
    const counts = () => ["SIGTERM", "SIGHUP", "SIGINT"].map((s) => process.listenerCount(s));
    const before = counts();
    const stdin = new FakeTTYStdin([]);
    const read = readLineFromTTY(asStream(stdin), fakeStdout().stream);
    expect(counts()).toEqual(before);
    stdin.unshift("\x03");
    stdin.resume();
    expect(await read).toBe(CANCELLED);
    expect(counts()).toEqual(before);
  });
});
