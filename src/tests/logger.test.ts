import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamWriter, log, setLogSurface } from "../logger.js";

// -----------------------------------------------------------------------
// logger.ts: spread-order pin (logger.ts:9)
//
// The JSON line is built as: { ...data, level, msg, ts }
// That means the envelope's own level/msg/ts ALWAYS appear last and
// clobber any same-named key in `data`. This test pins that contract so
// a refactor that swaps the spread order (e.g. { level, msg, ts, ...data })
// would be caught immediately.
// -----------------------------------------------------------------------

describe("log() spread-order: envelope fields win over data keys", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    // log() resolves LOG_LEVEL per call, so a developer shell or CI runner
    // exporting LOG_LEVEL=warn (or error) would suppress the info lines these
    // tests read back -- two would fail and the warn-level one would pass
    // vacuously. Pin the threshold below every level used here.
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrWrites.push(chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("envelope level/msg/ts survive when data carries the same keys", () => {
    // Call log() with data that tries to override the envelope fields.
    // Use "info" (not "debug") so the minLevel filter does not suppress the line.
    log("info", "real-msg", { level: "INJECTED_LEVEL", msg: "INJECTED_MSG", ts: "INJECTED_TS" });

    expect(stderrWrites.length).toBeGreaterThan(0);
    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    // The envelope's own values must win.
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("real-msg");
    // ts is an ISO string; it must NOT be the injected literal.
    expect(parsed.ts).not.toBe("INJECTED_TS");
    expect(typeof parsed.ts).toBe("string");
  });

  it("data keys that do NOT clash with envelope fields appear in the JSON line", () => {
    log("info", "hello", { foo: "bar", count: 42 });

    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.foo).toBe("bar");
    expect(parsed.count).toBe(42);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
  });

  it("log() with no data still emits a valid JSON line with level/msg/ts", () => {
    log("warn", "something-happened");

    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("something-happened");
    expect(typeof parsed.ts).toBe("string");
  });
});

// -----------------------------------------------------------------------
// logger.ts robustness: the log line must never take the process (or the
// caller's own work) down with it, and LOG_LEVEL must be readable per call.
// -----------------------------------------------------------------------

describe("log() failure containment", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    // Same reason as the describe above: these assert on emitted lines at
    // warn / error / info, so an inherited LOG_LEVEL must not decide the
    // threshold.
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrWrites.push(chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("still emits the line when data carries a BigInt JSON.stringify cannot serialize", () => {
    // JSON.stringify throws a TypeError on a BigInt. Before the fix that
    // throw escaped log() and surfaced as a failure of whatever the caller
    // was doing -- a diagnostic taking down the operation it was diagnosing.
    expect(() => log("warn", "bigint-payload", { size: BigInt(7) })).not.toThrow();

    expect(stderrWrites.length).toBe(1);
    const parsed = JSON.parse(stderrWrites[0].trim()) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("bigint-payload");
    // The payload is dropped, and the entry says so rather than lying by
    // omission about what the caller passed.
    expect(parsed.dataOmitted).toBe(true);
    expect(parsed.size).toBeUndefined();
  });

  it("still emits the line when data is circular", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => log("error", "circular-payload", circular)).not.toThrow();
    const parsed = JSON.parse(stderrWrites[0].trim()) as Record<string, unknown>;
    expect(parsed.msg).toBe("circular-payload");
    expect(parsed.dataOmitted).toBe(true);
  });

  it("swallows a synchronous stderr write failure (closed pipe) instead of throwing", () => {
    // A host that closed our stderr makes write() throw EPIPE/EBADF
    // synchronously. That must not propagate into the caller.
    vi.mocked(process.stderr.write).mockImplementation(() => {
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });

    expect(() => log("info", "into-the-void")).not.toThrow();
  });

  it("attaches an 'error' listener to stderr so an async EPIPE is not an unhandled event", () => {
    log("info", "arm-the-guard");
    // With no listener Node treats a stream 'error' as unhandled and kills
    // the process. Emitting here must be inert.
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(0);
    expect(() => process.stderr.emit("error", new Error("late EPIPE"))).not.toThrow();
  });
});

describe("log() reads LOG_LEVEL per call, not once at import", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("suppresses an info line when LOG_LEVEL is raised after import", () => {
    // The threshold used to be latched in a module-scope const, so this
    // env change could not take effect for the life of the process.
    vi.stubEnv("LOG_LEVEL", "error");
    log("info", "should-be-filtered");
    expect(stderrWrites).toEqual([]);
  });

  it("emits a debug line when LOG_LEVEL is lowered after import", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    log("debug", "now-visible");
    expect(stderrWrites.length).toBe(1);
    expect(JSON.parse(stderrWrites[0].trim()).msg).toBe("now-visible");
  });

  it("falls back to info when LOG_LEVEL is set to something unrecognized", () => {
    vi.stubEnv("LOG_LEVEL", "chatty");
    log("debug", "still-filtered");
    log("info", "still-shown");
    expect(stderrWrites.length).toBe(1);
    expect(JSON.parse(stderrWrites[0].trim()).msg).toBe("still-shown");
  });
});

// -----------------------------------------------------------------------
// logger.ts CLI surface: the structured envelope is for the stdio server,
// whose only channel is stderr. A person running `yaw-mcp list` against a
// hand-broken bundles.json was shown the raw record --
// {"level":"warn","msg":"bundles.json is not valid JSON; ignoring",...} --
// stacked on top of the sentence the command itself prints. These pin the
// split, including the half that must NOT be silenced.
// -----------------------------------------------------------------------

describe("log() on the CLI surface", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    // Deliberately UNSET, not "debug": the whole gate is "did the operator
    // ask for the structured stream", and stubbing a level would answer yes
    // for every case below.
    vi.stubEnv("LOG_LEVEL", undefined);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    });
    setLogSurface("cli");
  });

  afterEach(() => {
    // Back to the module default. A leaked "cli" would quietly change what
    // every later test in this process sees on stderr.
    setLogSurface("server");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("drops an info record entirely -- it is server telemetry with no reader here", () => {
    log("info", "Loaded bundles", { path: "/x/bundles.json", serverCount: 3 });
    expect(stderrWrites).toEqual([]);
  });

  it("renders a warning as a plain sentence rather than a JSON envelope", () => {
    log("warn", "bundles.json is not valid JSON; ignoring", { path: "/x/bundles.json", code: "EJSON" });
    expect(stderrWrites).toHaveLength(1);
    const line = stderrWrites[0];
    expect(line).toBe(
      "yaw-mcp: warning: bundles.json is not valid JSON; ignoring (path=/x/bundles.json; code=EJSON)\n",
    );
    // The shape the CLI user must never see again.
    expect(line).not.toContain('"level"');
    expect(line).not.toContain('"msg"');
  });

  it("keeps errors too, labelled as errors", () => {
    // Not silenced: several warn/error records (an invalid
    // YAW_MCP_DEFAULT_RUNTIME, an unreadable trust store) have no other
    // surface, so dropping them would trade noise for a missing warning.
    log("error", "Failed to save yaw-mcp state");
    expect(stderrWrites).toEqual(["yaw-mcp: error: Failed to save yaw-mcp state\n"]);
  });

  it("restores the structured stream when LOG_LEVEL asks for it", () => {
    // The documented support path: LOG_LEVEL=debug is what --help tells a
    // user to set when asking why a server did not load.
    vi.stubEnv("LOG_LEVEL", "debug");
    log("info", "yaw-mcp startup");
    expect(stderrWrites).toHaveLength(1);
    expect(JSON.parse(stderrWrites[0].trim()).msg).toBe("yaw-mcp startup");
  });

  it("does not treat an unrecognized LOG_LEVEL as an opt-in", () => {
    // minLevel() already falls back to info for a typo, so honoring it as
    // "the operator asked for JSON" would turn `LOG_LEVEL=chatty` into a
    // wall of envelopes.
    vi.stubEnv("LOG_LEVEL", "chatty");
    log("info", "still-dropped");
    log("warn", "still-plain");
    expect(stderrWrites).toEqual(["yaw-mcp: warning: still-plain\n"]);
  });

  it("still emits the line when data cannot be serialized", () => {
    // Same containment contract as the structured path: a diagnostic must
    // never take down the operation it is diagnosing.
    expect(() => log("warn", "bigint-payload", { size: BigInt(7) })).not.toThrow();
    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("yaw-mcp: warning: bigint-payload");
  });
});

describe("index.ts wiring for the CLI surface", () => {
  it("switches the surface for any subcommand, and only for a subcommand", async () => {
    // index.ts dispatches at import time and cannot be imported, so the
    // source is the only place this wiring is visible. Without the call the
    // module above is correct and never reached; with it applied
    // unconditionally the stdio server would lose its structured stream.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(src).toContain('if (subcommand !== undefined) setLogSurface("cli");');
  });
});

// -----------------------------------------------------------------------
// createStreamWriter: an early-exiting consumer must not kill the process
//
// `yaw-mcp call ... | head -1` closes the read end of stdout after the
// first line. The next write emits 'error' (EPIPE) on the stream, and with
// no listener Node treats that as an unhandled 'error' event and takes the
// process down mid-await -- which SKIPS the `finally` in
// transient-upstream.ts, so the spawned upstream is never disconnected and
// the child is orphaned. Reproduced against a built binary:
// `call fake med {} | head -1` logged "Disconnected from upstream" zero
// times, the unpiped run logged it once.
// -----------------------------------------------------------------------
describe("createStreamWriter", () => {
  /** Minimal writable: an EventEmitter with a `write` that records, plus an
   *  optional failure mode. Not a PassThrough, because the two failure shapes
   *  under test are exactly the ones a real pipe produces and a PassThrough
   *  produces neither on demand. */
  function fakeStream(mode: "ok" | "emit" | "throw"): NodeJS.WritableStream & { written: string[] } {
    const emitter = new EventEmitter() as unknown as NodeJS.WritableStream & { written: string[] };
    emitter.written = [];
    (emitter as { write: (s: string) => boolean }).write = (s: string): boolean => {
      emitter.written.push(s);
      if (emitter.written.length === 1) {
        // "emit" is the real pipe shape: the write RETURNS, and the error
        // lands a tick later. Emitting it synchronously here would be caught
        // by the writer's own try/catch, which stops the listener from being
        // tested at all -- a mutation run with the listener removed still
        // went green until this was deferred.
        if (mode === "emit") {
          setImmediate(() =>
            emitter.emit("error", Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" })),
          );
        }
        if (mode === "throw") throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
      }
      return true;
    };
    return emitter;
  }

  it("survives an EPIPE that arrives as an 'error' EVENT, not a throw", async () => {
    // The shape an unguarded stream dies on, and the one a try/catch cannot
    // reach: the write returns normally and Node emits 'error' a tick later.
    // An EventEmitter with no 'error' listener RETHROWS what is emitted, out
    // of a timer callback and into nobody's hands -- which IS the process
    // going down. The listener count is asserted directly because it is the
    // whole mechanism, and without it a regression here surfaces as an
    // unhandled error rather than as a readable failure.
    const stream = fakeStream("emit");
    const write = createStreamWriter(stream);
    expect(stream.listenerCount("error")).toBe(1);
    write("first\n");
    await new Promise((resolve) => setImmediate(resolve));
    // And nothing more is written: the consumer is gone, so every later line
    // would just re-emit the same error.
    write("second\n");
    write("third\n");
    expect(stream.written).toEqual(["first\n"]);
  });

  it("survives an EPIPE that arrives as a synchronous THROW", () => {
    const stream = fakeStream("throw");
    const write = createStreamWriter(stream);
    expect(() => write("first\n")).not.toThrow();
    write("second\n");
    expect(stream.written).toEqual(["first\n"]);
  });

  it("writes everything while the consumer is still there", () => {
    const stream = fakeStream("ok");
    const write = createStreamWriter(stream);
    write("a");
    write("b");
    expect(stream.written).toEqual(["a", "b"]);
  });

  it("shares one verdict across two writers over the SAME stream", async () => {
    // `call` builds one writer for stdout and one for stderr, and `2>&1`
    // hands both the same fd -- the second must not keep writing after the
    // first learned the consumer had gone. One listener for the two of them,
    // not two: ten stacked on process.stdout would trip Node's
    // MaxListenersExceededWarning.
    const stream = fakeStream("emit");
    const a = createStreamWriter(stream);
    const b = createStreamWriter(stream);
    expect(stream.listenerCount("error")).toBe(1);
    a("first\n");
    await new Promise((resolve) => setImmediate(resolve));
    b("second\n");
    expect(stream.written).toEqual(["first\n"]);
  });
});
