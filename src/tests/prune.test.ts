import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPruneEnabled, pruneContent } from "../prune.js";

// ═══════════════════════════════════════════════════════════════════════
// Response pruner — the F1 token-saver. Pins the conservative rules
// so a future edit can't silently start dropping data the LLM needs:
//   * nulls / undefined / empty collections go
//   * false / 0 / "" stay (load-bearing in many tool APIs)
//   * text-mode only collapses whitespace, never removes content
//   * refuses to apply if savings are below MIN_SAVINGS_RATIO
// ═══════════════════════════════════════════════════════════════════════

describe("isPruneEnabled", () => {
  const originalEnv = process.env.YAW_MCP_PRUNE_RESPONSES;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.YAW_MCP_PRUNE_RESPONSES;
    else process.env.YAW_MCP_PRUNE_RESPONSES = originalEnv;
  });

  it("defaults to enabled when env is unset", () => {
    delete process.env.YAW_MCP_PRUNE_RESPONSES;
    expect(isPruneEnabled()).toBe(true);
  });

  it("disables on '0'", () => {
    process.env.YAW_MCP_PRUNE_RESPONSES = "0";
    expect(isPruneEnabled()).toBe(false);
  });

  it("disables on 'false' (case-insensitive)", () => {
    process.env.YAW_MCP_PRUNE_RESPONSES = "False";
    expect(isPruneEnabled()).toBe(false);
  });

  it("enables on '1'", () => {
    process.env.YAW_MCP_PRUNE_RESPONSES = "1";
    expect(isPruneEnabled()).toBe(true);
  });
});

describe("pruneContent", () => {
  const originalEnv = process.env.YAW_MCP_PRUNE_RESPONSES;
  beforeEach(() => {
    delete process.env.YAW_MCP_PRUNE_RESPONSES;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.YAW_MCP_PRUNE_RESPONSES;
    else process.env.YAW_MCP_PRUNE_RESPONSES = originalEnv;
  });

  it("strips null keys from a JSON body", () => {
    const raw = JSON.stringify({
      results: [{ id: 1, title: "First" }],
      nextCursor: null,
      previousCursor: null,
      meta: { ratelimit: null, remaining: null },
    });
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nextCursor).toBeUndefined();
    expect(parsed.previousCursor).toBeUndefined();
    expect(parsed.meta).toBeUndefined();
    expect(parsed.results).toEqual([{ id: 1, title: "First" }]);
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("strips empty arrays and objects", () => {
    const raw = JSON.stringify({ data: [1, 2], errors: [], warnings: [], config: {} });
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.data).toEqual([1, 2]);
    expect(parsed.errors).toBeUndefined();
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  it("keeps false, 0, and empty strings (load-bearing values)", () => {
    const raw = JSON.stringify({
      completed: false,
      count: 0,
      error: "",
      name: "real name",
    });
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.completed).toBe(false);
    expect(parsed.count).toBe(0);
    expect(parsed.error).toBe("");
    expect(parsed.name).toBe("real name");
  });

  it("prunes nested structures recursively", () => {
    const raw = JSON.stringify({
      user: { id: "u1", email: null, phone: null, name: "Jeff" },
      audit: { created: null, updated: null },
    });
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.user).toEqual({ id: "u1", name: "Jeff" });
    expect(parsed.audit).toBeUndefined();
  });

  it("collapses trailing whitespace and runs of blank lines in non-JSON text", () => {
    const raw = "line one   \nline two\t\t\n\n\n\nline three";
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toBe("line one\nline two\n\nline three");
  });

  it("prunes CRLF text the same way (Windows-hosted servers)", () => {
    // The LF-only rules were a silent no-op here: `[ \t]+$` never matched
    // before a \r, and `\n{3,}` never saw three consecutive \n in
    // \r\n\r\n\r\n. Line endings are preserved as CRLF.
    const raw = "line one   \r\nline two\t\t\r\n\r\n\r\n\r\nline three";
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toBe("line one\r\nline two\r\n\r\nline three");
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("keeps LF-only collapse output LF (no CRLF introduced)", () => {
    const raw = "a   \n\n\n\n\nb                    ";
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toBe("a\n\nb");
  });

  it("returns original content when a REAL prune saves less than 2%", () => {
    // The gate is about savings, not about there being nothing to prune: a
    // 2 KB string next to one droppable null prunes by ~9 bytes, which is a
    // genuine prune and still far under MIN_SAVINGS_RATIO, so the original
    // comes back with the null intact. Input with nothing prunable at all
    // (the previous shape of this test) passes identically with the gate
    // deleted, so it pinned nothing.
    const raw = JSON.stringify({ pad: "x".repeat(2000), dropMe: null });
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toBe(raw);
    expect(JSON.parse(r.content[0].text).dropMe).toBeNull();
    expect(r.bytesPruned).toBe(r.bytesRaw);
  });

  it("passes through when YAW_MCP_PRUNE_RESPONSES=0", () => {
    process.env.YAW_MCP_PRUNE_RESPONSES = "0";
    const raw = JSON.stringify({
      data: [1],
      nothing: null,
      nobody: null,
    });
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toBe(raw);
    expect(r.bytesPruned).toBe(r.bytesRaw);
  });

  it("survives malformed JSON (falls back to text-mode pruning)", () => {
    const raw = "{ not, actually: json;;;\n\n\n\ntrailing    ";
    const r = pruneContent([{ type: "text", text: raw }]);
    // Not JSON — and text-mode cleanup actually RAN on it: the trailing run of
    // spaces is gone and the four-newline run collapsed to two. Asserting only
    // `typeof === "string"` also passed when the fallback did nothing at all.
    expect(r.content[0].text).toBe("{ not, actually: json;;;\n\ntrailing");
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("skips non-text content entries untouched", () => {
    const r = pruneContent([
      { type: "image", text: "", mimeType: "image/png", data: "AAA" } as any,
      { type: "text", text: JSON.stringify({ a: null, b: "keep" }) },
    ]);
    expect((r.content[0] as any).data).toBe("AAA");
    expect(JSON.parse(r.content[1].text)).toEqual({ b: "keep" });
  });

  it("reports bytesRaw and bytesPruned in utf8 bytes, not chars", () => {
    const raw = JSON.stringify({ emoji: "🚀🚀🚀", junk: null });
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.bytesRaw).toBe(Buffer.byteLength(JSON.stringify([{ type: "text", text: raw }]), "utf8"));
    // Pruned should be strictly smaller once the null is gone.
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("bails safely past the 2MB parse threshold without parsing as JSON", () => {
    // The droppable nulls are what make this pin the SIZE GUARD rather than
    // the savings gate: ~100 KB of them against a ~2.1 MB document is 4.8%, so
    // with the guard deleted the JSON path would prune them and clear
    // MIN_SAVINGS_RATIO. They survive only because JSON mode was skipped
    // outright. (A lone 3 MB string prunes to a 1-byte-shorter string that the
    // gate then rejects, which looks identical from the outside.)
    const source: Record<string, unknown> = { big: "x".repeat(2_000_000) };
    for (let i = 0; i < 6000; i++) source[`empty${i}`] = null;
    const huge = JSON.stringify(source);
    expect(huge.length).toBeGreaterThan(2_000_000);
    const r = pruneContent([{ type: "text", text: huge }]);
    // No crash, no JSON mangling, and every null still there.
    expect(r.content[0].text.length).toBe(huge.length);
    expect(r.content[0].text).toContain('"empty0":null');
    expect(r.content[0].text).toContain('"empty5999":null');
    expect(r.bytesPruned).toBe(r.bytesRaw);
  });

  // Fix 4: array elements that prune to "empty" must NOT be dropped --
  // dropping shifts indices and breaks positional list data returned to
  // the model. They become null placeholders instead.
  it("keeps array positions stable when elements prune to empty (fix 4)", () => {
    const raw = JSON.stringify([
      { id: 1, name: "first", extras: null },
      { id: 2, name: "second", extras: null },
      { id: 3, name: "third", extras: null },
    ]);
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    // All three elements must still be present at indices 0, 1, 2.
    expect(parsed).toHaveLength(3);
    expect(parsed[0].id).toBe(1);
    expect(parsed[1].id).toBe(2);
    expect(parsed[2].id).toBe(3);
    // The null field should be pruned from each object.
    expect(parsed[0].extras).toBeUndefined();
  });

  it("preserves an OBJECT element that prunes to empty as {}, not null (fix 6)", () => {
    // An object element whose every value prunes away keeps its object shape
    // as `{}` (so a list of rows stays a list of objects), and stays in place.
    const raw = JSON.stringify([{ keep: "value" }, { drop: null }, { keep: "another" }]);
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ keep: "value" });
    // Index 1 was an object that pruned to empty -> {} (shape preserved), NOT null.
    expect(parsed[1]).toEqual({});
    expect(parsed[2]).toEqual({ keep: "another" });
  });

  it("replaces fully-pruned NON-object array elements with null (fix 6)", () => {
    // Non-object elements (null, empty array) that prune away still become
    // null placeholders so indices stay stable. The first element carries
    // droppable fields so the overall result still clears the min-savings
    // gate (null is wider than [], so without real savings elsewhere the
    // pruner would keep the original unchanged).
    const raw = JSON.stringify([{ keep: "value", a: null, b: null, c: null }, null, []]);
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ keep: "value" });
    expect(parsed[1]).toBeNull();
    expect(parsed[2]).toBeNull();
  });

  it("still returns undefined for a zero-length array (empty array = no info, fix 4)", () => {
    // An empty input array has no positional data to preserve — drop it.
    const raw = JSON.stringify({ results: [], meta: "ok" });
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.results).toBeUndefined();
    expect(parsed.meta).toBe("ok");
  });

  // Number fidelity. Pruning re-serializes through JSON.parse +
  // JSON.stringify, and JSON numbers are IEEE-754 doubles: a round-trip
  // rewrites 12345678901234567890 as 12345678901234567000. int64 row ids
  // are ordinary in SQL and REST MCP servers, so JSON mode is skipped for
  // the whole document whenever a literal would come back changed.
  it("returns the original bytes rather than truncating an int64 id", () => {
    const raw = '{"id": 12345678901234567890, "nextCursor": null, "prevCursor": null, "meta": null, "name": "row"}';
    const r = pruneContent([{ type: "text", text: raw }]);
    // Would otherwise clear the savings gate (136 bytes -> 73) and reach the
    // model with the id silently mangled.
    expect(r.content[0].text).toBe(raw);
    expect(r.content[0].text).toContain("12345678901234567890");
    expect(r.bytesPruned).toBe(r.bytesRaw);
  });

  it("leaves 2^53+1 alone — the first integer a double cannot hold", () => {
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"id": 9007199254740993, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toContain("9007199254740993");
    // Proof the whole document was skipped, not merely returned by the
    // savings gate: the droppable nulls are still there.
    expect(r.content[0].text).toContain("empty0");
  });

  it("leaves the '.0' spelling of 2^53+1 alone too", () => {
    // Same lost digit as the integer case, one character apart -- and the
    // fractional branch is the one that used to wave it through: a 17-digit
    // bound is the double->decimal direction, so 9007199254740993.0 was
    // declared faithful and the model got 9007199254740992 with nothing
    // logged. NUMERIC columns serialize in exactly this shape.
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"id": 9007199254740993.0, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toContain("9007199254740993.0");
    // Whole document skipped, not merely returned by the savings gate.
    expect(r.content[0].text).toContain("empty0");
  });

  it("leaves a 17-significant-digit fraction alone (0.12345678901234567)", () => {
    // Re-serializes as 0.12345678901234566 -- the last digit CHANGES, so the
    // document keeps its original bytes. A high-precision measurement is the
    // everyday shape here; the '.0' case above is its integer twin.
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"reading": 0.12345678901234567, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toContain("0.12345678901234567");
    expect(r.content[0].text).toContain("empty0");
  });

  it("leaves a literal that underflows to zero alone (1e-400)", () => {
    // The digits are GONE, not rounded: JSON.stringify emits 0, so a
    // measurement below the double's range would reach the model as nothing
    // at all.
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"tiny": 1e-400, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toContain("1e-400");
    expect(r.content[0].text).toContain("empty0");
  });

  it("still prunes a computed double that needs all 17 digits (0.30000000000000004)", () => {
    // The counterweight to the three cases above. JSON.stringify reproduces
    // this literal byte for byte, so it is faithful -- but a mantissa bound of
    // 15 (the decimal->double->decimal guarantee) would call it unfaithful,
    // and ONE unfaithful literal costs the WHOLE document its pruning. Sums,
    // averages, and lat/lon land here constantly, so that bound would be a
    // savings regression on very ordinary responses.
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"sum": 0.30000000000000004, "lon": -122.41941550000001, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.sum).toBe(0.30000000000000004);
    expect(parsed.lon).toBe(-122.41941550000001);
    expect(parsed.empty0).toBeUndefined();
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("still prunes when a fractional literal is only REFORMATTED (19.90 -> 19.9)", () => {
    // 19.90 -> 19.9, 1.0 -> 1, 0.0000001 -> 1e-7: the double is unchanged and
    // only the spelling moves, which the module explicitly sanctions. Bailing
    // on these would disable pruning for every response carrying a
    // trailing-zero money column.
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"price": 19.90, "whole": 1.0, "tiny": 0.0000001, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.price).toBe(19.9);
    expect(parsed.whole).toBe(1);
    expect(parsed.tiny).toBe(1e-7);
    expect(parsed.empty0).toBeUndefined();
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("leaves a literal that overflows to Infinity alone (JSON.stringify emits null)", () => {
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const raw = `{"huge": 1e400, ${nulls}}`;
    const r = pruneContent([{ type: "text", text: raw }]);
    expect(r.content[0].text).toContain("1e400");
    expect(r.content[0].text).not.toContain('"huge": null');
  });

  it("still prunes when the long digit run is inside a STRING, not a number", () => {
    // String-quoted ids are the safe shape and must not lose their savings:
    // the scanner is one regex alternating string-literal | number with the
    // STRING form first, so a quoted run of digits is consumed as part of that
    // string match and never reaches the number test.
    const source: Record<string, unknown> = { id: "12345678901234567890", keep: "value" };
    for (let i = 0; i < 40; i++) source[`empty${i}`] = null;
    const r = pruneContent([{ type: "text", text: JSON.stringify(source) }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.id).toBe("12345678901234567890");
    expect(parsed.keep).toBe("value");
    expect(parsed.empty0).toBeUndefined();
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("does not mistake digits inside an escaped-quote string for a number", () => {
    // The fidelity scan is one regex alternating string-literal | number, with
    // the string form first, instead of blanking strings into a full second
    // copy of the response. Escapes are where that ordering earns its keep: if
    // the string branch stopped at the escaped quote, the digits after it would
    // be read as a bare number, the document would bail, and a perfectly
    // safe response would lose all its savings.
    const source: Record<string, unknown> = {
      note: 'he said "12345678901234567890" out loud',
      path: "C:\\logs\\",
      keep: "value",
    };
    for (let i = 0; i < 40; i++) source[`empty${i}`] = null;
    const r = pruneContent([{ type: "text", text: JSON.stringify(source) }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.note).toBe('he said "12345678901234567890" out loud');
    expect(parsed.path).toBe("C:\\logs\\");
    expect(parsed.empty0).toBeUndefined();
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });

  it("re-scans each content item from the start after an early bail", () => {
    // The scan returns the moment it sees an unfaithful literal, which leaves
    // the module-level /g regex with a non-zero lastIndex. Without an explicit
    // reset the NEXT item is scanned from that offset -- here past its end, so
    // it would be declared faithful without a single number being looked at,
    // and reach the model with 9007199254740993 rewritten to ...992.
    const bailsLate = `{"pad": "${"x".repeat(500)}", "id": 12345678901234567890}`;
    const nulls = Array.from({ length: 40 }, (_, i) => `"empty${i}": null`).join(", ");
    const r = pruneContent([
      { type: "text", text: bailsLate },
      { type: "text", text: `{"id": 9007199254740993, ${nulls}}` },
    ]);
    expect(r.content[0].text).toContain("12345678901234567890");
    expect(r.content[1].text).toContain("9007199254740993");
    // Proof the second item was actually scanned and skipped, not pruned.
    expect(r.content[1].text).toContain("empty0");
  });

  it("still prunes ordinary-sized numbers", () => {
    const source: Record<string, unknown> = { id: 9007199254740991, price: 19.9, keep: "value" };
    for (let i = 0; i < 40; i++) source[`empty${i}`] = null;
    const r = pruneContent([{ type: "text", text: JSON.stringify(source) }]);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.id).toBe(9007199254740991);
    expect(parsed.price).toBe(19.9);
    expect(parsed.empty0).toBeUndefined();
    expect(r.bytesPruned).toBeLessThan(r.bytesRaw);
  });
});

// Same footgun as resolveArgs in exec-engine.ts: JSON.parse yields
// "__proto__" as an OWN property, but rebuilding the tree with `out[k] = v`
// hits Object.prototype's setter instead of creating an own key, so the
// field an upstream server actually returned disappears from the pruned
// result handed back to the model.
describe("pruneJson __proto__ handling", () => {
  const originalEnv = process.env.YAW_MCP_PRUNE_RESPONSES;
  beforeEach(() => {
    delete process.env.YAW_MCP_PRUNE_RESPONSES;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.YAW_MCP_PRUNE_RESPONSES;
    else process.env.YAW_MCP_PRUNE_RESPONSES = originalEnv;
  });

  it("keeps a __proto__ key that survives pruning", () => {
    // Padding nulls make the prune clear MIN_SAVINGS_RATIO so the result is
    // actually applied rather than falling back to the original content.
    const source = JSON.parse('{"__proto__": {"nested": "data"}, "keep": "value"}');
    for (let i = 0; i < 40; i++) source[`empty${i}`] = null;
    const result = pruneContent([{ type: "text", text: JSON.stringify(source) }]);
    const out = JSON.parse((result.content[0] as { text: string }).text);

    expect(result.bytesPruned).toBeLessThan(result.bytesRaw);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(out.keep).toBe("value");
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse('{"__proto__": {"nested": "data"}, "keep": "value"}'));
  });

  it("never pollutes Object.prototype while pruning", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "keep": "value"}');
    for (let i = 0; i < 40; i++) source[`empty${i}`] = null;
    pruneContent([{ type: "text", text: JSON.stringify(source) }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
