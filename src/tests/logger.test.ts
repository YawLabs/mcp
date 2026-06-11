import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";

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
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrWrites.push(chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
