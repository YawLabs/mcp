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

  it("returns original content when savings are below 2%", () => {
    const raw = JSON.stringify({ a: 1, b: 2, c: 3 });
    const r = pruneContent([{ type: "text", text: raw }]);
    // Nothing to prune — original should come back unchanged.
    expect(r.content[0].text).toBe(raw);
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
    // Not JSON — text-mode runs without throwing.
    expect(typeof r.content[0].text).toBe("string");
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

  it("bails safely on 3MB+ text blocks without parsing them as JSON", () => {
    const huge = `{"big": "${"x".repeat(3_000_000)}"}`;
    const r = pruneContent([{ type: "text", text: huge }]);
    // Over the 2MB parse threshold — falls through to text-mode only.
    // No crash, no JSON mangling; bytes stay ~identical.
    expect(r.content[0].text.length).toBeGreaterThan(2_999_000);
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
});
