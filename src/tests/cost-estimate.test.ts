import { describe, expect, it } from "vitest";
import { estimateFromConnectedTools, estimateFromToolCache, formatCostLabel } from "../cost-estimate.js";

// ═══════════════════════════════════════════════════════════════════════
// Context-cost estimator for discover()
//
// Pins the coarse contract the meta-tool caller relies on:
//   * cached estimates are flagged so the label's "~" is reliable
//   * connected estimates use the live inputSchema bytes, not pads
//   * label format is "<count> tool[s], [~]<N>[k] tokens"
//   * zero-tool input never produces a misleading non-empty label
// ═══════════════════════════════════════════════════════════════════════

describe("estimateFromToolCache", () => {
  it("returns zero-sample when cache is undefined or empty", () => {
    expect(estimateFromToolCache(undefined)).toEqual({ tools: 0, bytes: 0, tokens: 0, cached: true });
    expect(estimateFromToolCache([])).toEqual({ tools: 0, bytes: 0, tokens: 0, cached: true });
  });

  it("flags the result as cached so the caller knows to add a tilde", () => {
    const r = estimateFromToolCache([{ name: "x" }]);
    expect(r.cached).toBe(true);
  });

  it("counts name + description + a schema pad per tool", () => {
    const r = estimateFromToolCache([{ name: "t1", description: "hi" }]);
    // t1 (2) + hi (2) + schema pad (200) = 204 bytes → 51 tokens
    expect(r.bytes).toBe(204);
    expect(r.tokens).toBe(51);
    expect(r.tools).toBe(1);
  });

  it("substitutes a description pad when description is missing", () => {
    const r = estimateFromToolCache([{ name: "t1" }]);
    // t1 (2) + missing-desc pad (100) + schema pad (200) = 302
    expect(r.bytes).toBe(302);
  });

  it("scales roughly linearly with tool count", () => {
    const one = estimateFromToolCache([{ name: "t1", description: "hi" }]);
    const five = estimateFromToolCache(new Array(5).fill({ name: "t1", description: "hi" }));
    expect(five.bytes).toBe(one.bytes * 5);
  });
});

describe("estimateFromConnectedTools", () => {
  it("returns zero-sample for an empty list", () => {
    expect(estimateFromConnectedTools([])).toEqual({ tools: 0, bytes: 0, tokens: 0, cached: false });
  });

  it("measures JSON bytes of the live tool def, not padded cache bytes", () => {
    const tool = {
      name: "ls",
      description: "list files",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    };
    const r = estimateFromConnectedTools([tool]);
    const expectedBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    expect(r.bytes).toBe(expectedBytes);
    expect(r.cached).toBe(false);
  });

  it("falls back to cache formula for a single tool with a cyclic schema", () => {
    const cyclic: any = { type: "object" };
    cyclic.self = cyclic;
    const tool = { name: "bad", description: "cycles", inputSchema: cyclic };
    const r = estimateFromConnectedTools([tool]);
    // Fallback path: name (3) + desc (6) + schema pad (200) = 209
    expect(r.bytes).toBe(209);
    // Overall sample still reports cached: false — it's a live connection,
    // just one cyclic tool. We don't want to poison the whole estimate.
    expect(r.cached).toBe(false);
  });
});

describe("formatCostLabel", () => {
  it("returns empty when there are zero tools", () => {
    expect(formatCostLabel({ tools: 0, bytes: 0, tokens: 0, cached: true })).toBe("");
  });

  it("prepends a tilde for cached samples and omits it for connected ones", () => {
    expect(formatCostLabel({ tools: 3, bytes: 800, tokens: 200, cached: true })).toBe("3 tools, ~200 tokens");
    expect(formatCostLabel({ tools: 3, bytes: 800, tokens: 200, cached: false })).toBe("3 tools, 200 tokens");
  });

  it("singularizes the tool word at count=1", () => {
    expect(formatCostLabel({ tools: 1, bytes: 100, tokens: 25, cached: false })).toBe("1 tool, 25 tokens");
  });

  it("uses 'Xk' notation past 1000 and rounds at 10k+", () => {
    expect(formatCostLabel({ tools: 22, bytes: 11_200, tokens: 2_800, cached: true })).toBe("22 tools, ~2.8k tokens");
    expect(formatCostLabel({ tools: 50, bytes: 100_000, tokens: 25_000, cached: false })).toBe("50 tools, 25k tokens");
  });

  it("renders the 10k boundary consistently (9999 and 10000 both read '10k')", () => {
    // Regression: the one-decimal branch used to catch 9999 and render
    // "10.0k" while 10000 rendered "10k" -- a one-token difference that
    // flipped the notation. Both must land on the same shape.
    const at9999 = formatCostLabel({ tools: 40, bytes: 39_996, tokens: 9_999, cached: false });
    const at10000 = formatCostLabel({ tools: 40, bytes: 40_000, tokens: 10_000, cached: false });
    expect(at9999).toBe("40 tools, 10k tokens");
    expect(at10000).toBe("40 tools, 10k tokens");
    // Just below the rounding boundary still gets the decimal form.
    expect(formatCostLabel({ tools: 40, bytes: 39_000, tokens: 9_900, cached: false })).toBe("40 tools, 9.9k tokens");
    // And the low end of the k range is unchanged.
    expect(formatCostLabel({ tools: 4, bytes: 4_000, tokens: 1_000, cached: false })).toBe("4 tools, 1.0k tokens");
  });
});
