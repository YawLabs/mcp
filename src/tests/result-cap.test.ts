import { describe, expect, it } from "vitest";
import { type CapContent, capContent, DEFAULT_MAX_RESULT_BYTES, resolveMaxResultBytes } from "../result-cap.js";

const text = (s: string): CapContent => ({ type: "text", text: s });

describe("resolveMaxResultBytes", () => {
  it("defaults to the documented ceiling", () => {
    expect(resolveMaxResultBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_RESULT_BYTES);
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(100_000);
  });

  it("reads a plain digit run", () => {
    expect(resolveMaxResultBytes({ YAW_MCP_MAX_RESULT_BYTES: "4096" } as NodeJS.ProcessEnv)).toBe(4096);
  });

  it("takes 0 as the disable sentinel", () => {
    expect(resolveMaxResultBytes({ YAW_MCP_MAX_RESULT_BYTES: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("falls back to the ceiling rather than DISABLING it on a typo", () => {
    // The failure that matters: parseInt reads all three of these as 0, which
    // is the disable sentinel -- so a typo would silently remove the ceiling
    // while looking like it set one.
    for (const raw of ["0x1000", "100_000", "1e5", "abc", "  "]) {
      expect(resolveMaxResultBytes({ YAW_MCP_MAX_RESULT_BYTES: raw } as NodeJS.ProcessEnv)).toBe(
        DEFAULT_MAX_RESULT_BYTES,
      );
    }
  });
});

describe("capContent", () => {
  it("passes an ordinary result through untouched, by reference", () => {
    const content = [text("hello"), text("world")];
    const r = capContent(content, 100_000);
    expect(r.capped).toBe(false);
    expect(r.content).toBe(content);
  });

  it("is a no-op when the ceiling is disabled, however large the result", () => {
    const content = [text("x".repeat(5_000_000))];
    const r = capContent(content, 0);
    expect(r.capped).toBe(false);
    expect(r.content).toBe(content);
  });

  it("is a no-op on empty content", () => {
    const r = capContent([], 10);
    expect(r.capped).toBe(false);
    expect(r.content).toEqual([]);
  });

  it("cuts an oversized result and says so", () => {
    const r = capContent([text("x".repeat(50_000))], 4_000);
    expect(r.capped).toBe(true);
    const notice = r.content[r.content.length - 1];
    expect(notice?.text).toContain("over the 4000-byte ceiling");
    expect(notice?.text).toContain("TRUNCATED");
    expect(notice?.text).toContain("Do not treat what you received as the whole answer");
  });

  // The payload shapes this ceiling actually meets. The FIXTURE is the whole
  // point of this table: JSON escaping is multiplicative, so plain "xxxx..."
  // is the one input that cannot detect an over-cut -- it escapes to nothing.
  // A previous version of this test used exactly that and passed while the
  // real result ran 66% over on ANSI-coloured output.
  const ESC = String.fromCharCode(27);
  const SHAPES: Array<[string, string]> = [
    ["plain, escapes to nothing", "x".repeat(500_000)],
    ["log lines, newline-heavy", "2026-09-10 INFO something happened\n".repeat(20_000)],
    ["JSON-ish, quote-heavy", '{"key":"value","n":123},'.repeat(30_000)],
    ["ANSI-coloured, control bytes", `${ESC}[32mgreen${ESC}[0m `.repeat(40_000)],
    ["multi-byte, no escaping", "日本語テキスト".repeat(50_000)],
  ];

  it.each(SHAPES)("keeps the WHOLE RETURNED RESULT under the ceiling: %s", (_label, body) => {
    // Measures the array actually handed back, not `bytesKept` -- that field
    // counts only content blocks, so asserting on it passed while the notice
    // pushed the real payload over.
    for (const cap of [1_000, 4_000, 10_000, 100_000]) {
      const r = capContent([text(body)], cap);
      expect(r.capped).toBe(true);
      const actual = Buffer.byteLength(JSON.stringify(r.content), "utf8");
      expect(actual, `cap=${cap} returned ${actual} bytes`).toBeLessThanOrEqual(cap);
    }
  });

  it("still returns something USEFUL, not just the notice, on escape-heavy text", () => {
    // The ceiling is easy to satisfy by cutting everything. Pin that the
    // binary search actually keeps content: a 100000-byte budget on ANSI text
    // should still carry a substantial prefix, not collapse to the marker.
    const body = `${ESC}[32mgreen${ESC}[0m `.repeat(40_000);
    const r = capContent([text(body)], 100_000);
    expect(r.content.length).toBe(2); // the cut block plus the notice
    expect(r.bytesKept).toBeGreaterThan(50_000);
  });

  it("stays under the ceiling with many blocks, not just one oversized one", () => {
    // A different shape reaching the same budget: the loop keeps whole blocks
    // until one crosses, so the accounting has to hold across iterations too.
    const many = Array.from({ length: 200 }, (_, i) => text(`block ${i} ${"y".repeat(300)}`));
    const r = capContent(many, 8_000);
    expect(r.capped).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.content), "utf8")).toBeLessThanOrEqual(8_000);
  });

  it("reports bytesKept as the CONTENT it kept, excluding the notice", () => {
    // The field is still useful and still means what it says -- it is just
    // not the ceiling check. Pinned so the two do not get conflated again.
    const r = capContent([text("x".repeat(50_000))], 4_000);
    expect(r.bytesKept).toBeLessThan(4_000);
    expect(r.bytesRaw).toBeGreaterThan(40_000);
  });

  it("keeps whole leading blocks and drops the tail", () => {
    const r = capContent([text("head"), text("y".repeat(50_000)), text("tail")], 4_000);
    expect(r.content[0]?.text).toBe("head");
    // The middle block is cut, and the block after it is gone.
    expect(r.content.some((c) => c.text === "tail")).toBe(false);
    expect(r.content[r.content.length - 1]?.text).toContain("content block(s) were dropped");
  });

  it("does not split a multi-byte character", () => {
    // The budget has to make the cut land MID-SEQUENCE or this proves
    // nothing: with two-byte characters and an even text budget the slice
    // lands on a boundary by luck. 2001 is odd, and capContent subtracts an
    // even envelope allowance from it, so the byte cut falls between the two
    // halves of an "é" -- which a naive Buffer.subarray decodes to U+FFFD and
    // hands the model as a corrupted final token.
    const r = capContent([text("é".repeat(5_000))], 2_001);
    expect(r.capped).toBe(true);
    const cut = r.content[0]?.text ?? "";
    expect(cut).not.toContain("�");
    // Every kept character survived whole.
    expect([...cut].every((ch) => ch === "é")).toBe(true);
  });

  it("drops a non-text block whole rather than cutting it in half", () => {
    const image: CapContent = { type: "image", data: "A".repeat(50_000), mimeType: "image/png" };
    const r = capContent([text("caption"), image], 4_000);
    expect(r.capped).toBe(true);
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(r.content[0]?.text).toBe("caption");
  });

  it("drops a block it cannot even measure", () => {
    // A cyclic block cannot be serialized, so its size is unknown. Treating
    // an unmeasurable block as free would let exactly the payload this
    // ceiling exists to stop through on every call.
    const cyclic: CapContent = { type: "resource" };
    (cyclic as Record<string, unknown>).self = cyclic;
    const r = capContent([text("fine"), cyclic], 100_000);
    expect(r.capped).toBe(true);
    expect(r.content.some((c) => c.type === "resource")).toBe(false);
  });

  it("still emits the notice when the budget is too small to keep any text", () => {
    const r = capContent([text("z".repeat(10_000))], 10);
    expect(r.capped).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.text).toContain("has been CUT");
  });

  it("exceeds a sub-notice ceiling rather than cutting silently -- the one exception", () => {
    // A ceiling smaller than the notice cannot be honoured AND still say the
    // result was cut. Reporting the cut wins: a silently truncated log reads
    // to the model as a complete one, which is the failure this whole module
    // exists to prevent. Pinned so the exception stays deliberate and known
    // rather than turning up later as a surprise.
    const r = capContent([text("z".repeat(10_000))], 10);
    const actual = Buffer.byteLength(JSON.stringify(r.content), "utf8");
    expect(actual).toBeGreaterThan(10);
    // And it is ONLY the notice -- no content rode along past the budget.
    expect(r.content).toHaveLength(1);
    expect(r.bytesKept).toBe(0);
  });

  it("names the ops escape hatch so the ceiling is not a dead end", () => {
    const r = capContent([text("q".repeat(50_000))], 1_000);
    expect(r.content[r.content.length - 1]?.text).toContain("YAW_MCP_MAX_RESULT_BYTES");
  });

  it("tells the model how to get the rest rather than only that it is missing", () => {
    const r = capContent([text("q".repeat(50_000))], 4_000);
    const notice = r.content[r.content.length - 1]?.text ?? "";
    expect(notice).toContain("narrower arguments");
    expect(notice).toContain("mcp_connect_exec");
  });

  it("reports the true raw size, not the kept size", () => {
    const r = capContent([text("w".repeat(30_000)), text("w".repeat(30_000))], 4_000);
    expect(r.bytesRaw).toBeGreaterThan(60_000);
    expect(r.content[r.content.length - 1]?.text).toContain(String(r.bytesRaw));
  });

  it("does not cap a result that sits exactly on the ceiling", () => {
    // Measured PER BLOCK, the way capContent sums it. Measuring the array
    // instead adds two bytes for the brackets, which put this fixture two
    // under the ceiling -- where an off-by-one in the comparison is
    // invisible.
    const one = text("a".repeat(100));
    const size = Buffer.byteLength(JSON.stringify(one), "utf8");
    expect(capContent([one], size).capped).toBe(false);
    // And one byte under it does cap, which pins the boundary from the other
    // side.
    expect(capContent([one], size - 1).capped).toBe(true);
  });
});
