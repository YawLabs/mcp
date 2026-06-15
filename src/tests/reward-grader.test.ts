import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGraderPrompt,
  firstResultText,
  gradeOutcomeViaSampling,
  isRewardGraderEnabled,
  isUncertainReward,
  parseGrade,
} from "../reward-grader.js";

function mockServer(
  caps: Record<string, unknown> | undefined,
  createMessage?: (params: unknown) => Promise<unknown>,
): Server {
  return {
    getClientCapabilities: () => caps,
    createMessage: createMessage ?? (async () => ({})),
  } as unknown as Server;
}

describe("isRewardGraderEnabled", () => {
  const orig = process.env.YAW_MCP_REWARD_GRADER;
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var needs delete, not "= undefined" (which would leave "undefined" as the string value)
    if (orig === undefined) delete process.env.YAW_MCP_REWARD_GRADER;
    else process.env.YAW_MCP_REWARD_GRADER = orig;
  });

  it("is disabled by default (unset)", () => {
    // biome-ignore lint/performance/noDelete: unsetting an env var needs delete, not "= undefined" (which would leave "undefined" as the string value)
    delete process.env.YAW_MCP_REWARD_GRADER;
    expect(isRewardGraderEnabled()).toBe(false);
  });

  it('is enabled for "1" and "true" (trimmed, case-insensitive)', () => {
    for (const v of ["1", "true", " TRUE "]) {
      process.env.YAW_MCP_REWARD_GRADER = v;
      expect(isRewardGraderEnabled()).toBe(true);
    }
  });

  it('is disabled for "0" / "false" / garbage', () => {
    for (const v of ["0", "false", "yes", "nope"]) {
      process.env.YAW_MCP_REWARD_GRADER = v;
      expect(isRewardGraderEnabled()).toBe(false);
    }
  });
});

describe("isUncertainReward", () => {
  it("is true only on the 0.2 / 0.3 heuristic bands", () => {
    expect(isUncertainReward(0.2)).toBe(true);
    expect(isUncertainReward(0.3)).toBe(true);
  });
  it("is false on the confident bands and outside the range", () => {
    for (const r of [0.0, 0.19, 0.31, 0.5, 1.0]) {
      expect(isUncertainReward(r)).toBe(false);
    }
  });
});

describe("firstResultText", () => {
  it("returns the first NON-EMPTY text block", () => {
    expect(
      firstResultText({
        content: [
          { type: "text", text: "  " },
          { type: "text", text: "actual content" },
        ],
      }),
    ).toBe("actual content");
  });

  it('returns "(empty result)" when there is no usable text', () => {
    expect(firstResultText({})).toBe("(empty result)");
    expect(firstResultText({ content: [] })).toBe("(empty result)");
    expect(firstResultText({ content: [{ type: "text", text: "   " }] })).toBe("(empty result)");
  });

  it("truncates long bodies", () => {
    const long = "x".repeat(1000);
    const out = firstResultText({ content: [{ type: "text", text: long }] });
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });
});

describe("buildGraderPrompt", () => {
  it("includes the goal line when an intent is present", () => {
    const p = buildGraderPrompt({ intent: "find open PRs", toolName: "list_prs", resultText: "[]" });
    expect(p).toContain("Goal: find open PRs");
    expect(p).toContain("Tool called: list_prs");
    expect(p).toContain("YES, PARTIAL, or NO");
  });

  it("omits the goal line when no intent is known", () => {
    const p = buildGraderPrompt({ toolName: "list_prs", resultText: "[]" });
    expect(p).not.toContain("Goal:");
  });
});

describe("parseGrade", () => {
  it("maps YES/PARTIAL/NO (case-insensitive) and handles stray prose", () => {
    expect(parseGrade("YES")).toBe(1.0);
    expect(parseGrade("partial")).toBe(0.5);
    expect(parseGrade("NO")).toBe(0.0);
    expect(parseGrade("No, it returned nothing")).toBe(0.0);
  });
  it("returns null when no verdict word appears", () => {
    expect(parseGrade("maybe?")).toBeNull();
    expect(parseGrade("")).toBeNull();
  });
});

describe("gradeOutcomeViaSampling", () => {
  const ctx = { toolName: "t", resultText: "r" };

  it("returns null when the client has no sampling capability", async () => {
    const server = mockServer({}); // no sampling
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("grades YES -> 1.0 / PARTIAL -> 0.5 / NO -> 0.0", async () => {
    for (const [word, expected] of [
      ["YES", 1.0],
      ["PARTIAL", 0.5],
      ["NO", 0.0],
    ] as const) {
      const server = mockServer({ sampling: {} }, async () => ({ content: { type: "text", text: word } }));
      expect(await gradeOutcomeViaSampling(server, ctx)).toBe(expected);
    }
  });

  it("reads text from an array content block", async () => {
    const server = mockServer({ sampling: {} }, async () => ({ content: [{ type: "text", text: "NO" }] }));
    expect(await gradeOutcomeViaSampling(server, ctx)).toBe(0.0);
  });

  it("returns null when the reply names no verdict", async () => {
    const server = mockServer({ sampling: {} }, async () => ({ content: { type: "text", text: "hmm" } }));
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("returns null (never throws) when createMessage rejects", async () => {
    const server = mockServer({ sampling: {} }, async () => {
      throw new Error("declined");
    });
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("returns null on timeout", async () => {
    vi.useFakeTimers();
    try {
      const server = mockServer({ sampling: {} }, () => new Promise(() => {})); // never resolves
      const p = gradeOutcomeViaSampling(server, ctx);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
