import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SAMPLES,
  bestOfNViaSampling,
  buildCandidates,
  buildTiebreakPrompt,
  computeAmbiguity,
  parseRouteEffort,
  parseTiebreakResponse,
  shouldSample,
  shouldTiebreak,
  tiebreakViaSampling,
} from "../sampling-rank.js";

const candidates = [
  { namespace: "github", score: 1.0, tools: [{ name: "create_issue" }] },
  { namespace: "gitlab", score: 0.95, tools: [{ name: "create_mr" }] },
];

describe("shouldTiebreak", () => {
  it("returns false for single candidate", () => {
    expect(shouldTiebreak([{ namespace: "a", score: 1 }])).toBe(false);
  });

  it("returns false when the top score dominates", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 10 },
        { namespace: "b", score: 1 },
      ]),
    ).toBe(false);
  });

  it("returns true when top-2 are within the default ratio", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 1.0 },
        { namespace: "b", score: 0.95 },
      ]),
    ).toBe(true);
  });

  it("returns false when top score is zero", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 0 },
        { namespace: "b", score: 0 },
      ]),
    ).toBe(false);
  });
});

describe("buildTiebreakPrompt", () => {
  it("includes intent and each candidate", () => {
    const prompt = buildTiebreakPrompt("create a PR", candidates);
    expect(prompt).toContain("create a PR");
    expect(prompt).toContain("github");
    expect(prompt).toContain("gitlab");
    expect(prompt).toContain("create_issue");
  });

  it("tells the LLM to reply with just the namespace", () => {
    const prompt = buildTiebreakPrompt("x", candidates);
    expect(prompt.toLowerCase()).toContain("namespace");
  });
});

describe("parseTiebreakResponse", () => {
  it("accepts a bare namespace", () => {
    expect(parseTiebreakResponse("github", candidates)).toBe("github");
  });

  it("strips quotes and backticks", () => {
    expect(parseTiebreakResponse("`github`", candidates)).toBe("github");
    expect(parseTiebreakResponse('"gitlab"', candidates)).toBe("gitlab");
  });

  it("finds namespace inside prose", () => {
    expect(parseTiebreakResponse("I pick github because it fits best.", candidates)).toBe("github");
  });

  it("returns null when no candidate is named", () => {
    expect(parseTiebreakResponse("I don't know", candidates)).toBeNull();
  });

  it("prefers first line that names a candidate", () => {
    expect(parseTiebreakResponse("github\ngitlab", candidates)).toBe("github");
  });

  it("within a single line, picks the candidate at the earliest position (LLM's lexical choice wins)", () => {
    // "I prefer gitlab over github" -- the LLM is naming gitlab first;
    // we must not return github just because it iterates first.
    expect(parseTiebreakResponse("I prefer gitlab over github", candidates)).toBe("gitlab");
    expect(parseTiebreakResponse("github vs gitlab -- pick github", candidates)).toBe("github");
  });
});

describe("buildCandidates", () => {
  it("attaches description and tool metadata", () => {
    const servers = new Map([
      [
        "github",
        {
          id: "1",
          name: "GitHub",
          namespace: "github",
          type: "local" as const,
          isActive: true,
          description: "GitHub API wrapper",
        },
      ],
    ]);
    const tools = new Map([["github", [{ name: "create_issue" }]]]);
    const out = buildCandidates([{ namespace: "github", score: 1.0 }], servers, tools);
    expect(out).toHaveLength(1);
    expect(out[0]?.description).toBe("GitHub API wrapper");
    expect(out[0]?.tools).toEqual([{ name: "create_issue" }]);
  });

  it("skips servers not in the map", () => {
    const out = buildCandidates([{ namespace: "missing", score: 1 }], new Map(), new Map());
    expect(out).toEqual([]);
  });
});

describe("tiebreakViaSampling", () => {
  function mockServer(
    caps: { sampling?: object } | undefined,
    createMessage?: (params: unknown) => Promise<unknown>,
  ): Server {
    return {
      getClientCapabilities: () => caps,
      createMessage: createMessage ?? (async () => ({})),
    } as unknown as Server;
  }

  it("returns null when client does not support sampling", async () => {
    const server = mockServer(undefined);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });

  it("returns null with fewer than 2 candidates", async () => {
    const server = mockServer({ sampling: {} });
    const out = await tiebreakViaSampling(server, "intent", [candidates[0]!]);
    expect(out).toBeNull();
  });

  it("returns the picked namespace when sampling succeeds", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "github" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("handles array-shaped content", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "gitlab is better" }],
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBe("gitlab");
  });

  it("returns null when the LLM names no candidate", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "I don't know" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });

  it("swallows createMessage errors and returns null", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("upstream refused"));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });
});

// =============================================================================
// Effort dial (idea 5)
// =============================================================================

describe("parseRouteEffort", () => {
  it("defaults to auto when unset", () => {
    expect(parseRouteEffort(undefined)).toBe("auto");
  });

  it("defaults to auto for empty string", () => {
    expect(parseRouteEffort("")).toBe("auto");
  });

  it("parses each known value, case- and whitespace-insensitively", () => {
    expect(parseRouteEffort("off")).toBe("off");
    expect(parseRouteEffort("OFF")).toBe("off");
    expect(parseRouteEffort("auto")).toBe("auto");
    expect(parseRouteEffort("aggressive")).toBe("aggressive");
    expect(parseRouteEffort("  Aggressive  ")).toBe("aggressive");
  });

  it("falls back to auto for unknown values", () => {
    expect(parseRouteEffort("turbo")).toBe("auto");
    expect(parseRouteEffort("1")).toBe("auto");
  });
});

describe("computeAmbiguity", () => {
  it("returns 0 for fewer than 2 candidates", () => {
    expect(computeAmbiguity([])).toBe(0);
    expect(computeAmbiguity([{ namespace: "a", score: 1 }])).toBe(0);
  });

  it("returns 0 when the leader score is non-positive", () => {
    expect(
      computeAmbiguity([
        { namespace: "a", score: 0 },
        { namespace: "b", score: 0 },
      ]),
    ).toBe(0);
    expect(
      computeAmbiguity([
        { namespace: "a", score: -1 },
        { namespace: "b", score: -2 },
      ]),
    ).toBe(0);
  });

  it("returns ~1 for tied scores", () => {
    expect(
      computeAmbiguity([
        { namespace: "a", score: 1 },
        { namespace: "b", score: 1 },
      ]),
    ).toBeCloseTo(1, 5);
  });

  it("returns ~0 for a dominant clear winner", () => {
    const a = computeAmbiguity([
      { namespace: "a", score: 10 },
      { namespace: "b", score: 0.1 },
    ]);
    expect(a).toBeLessThan(0.15);
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it("stays within [0,1]", () => {
    const vals = [
      computeAmbiguity([
        { namespace: "a", score: 5 },
        { namespace: "b", score: 4 },
        { namespace: "c", score: 3 },
      ]),
      computeAmbiguity([
        { namespace: "a", score: 1 },
        { namespace: "b", score: 0.95 },
      ]),
    ];
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldSample", () => {
  const tied = [
    { namespace: "a", score: 1 },
    { namespace: "b", score: 0.95 },
  ];
  // Dominant winner relative to runner-up, but not so wide that even the
  // entropy signal vanishes -- sits in the band aggressive samples, auto does
  // not (ambiguity ~0.78).
  const moderate = [
    { namespace: "a", score: 1 },
    { namespace: "b", score: 0.3 },
  ];
  // Clear winner below every threshold.
  const clear = [
    { namespace: "a", score: 10 },
    { namespace: "b", score: 0.2 },
  ];

  it("off never samples, even when fully tied", () => {
    expect(shouldSample(tied, "off")).toBe(false);
    expect(shouldSample(moderate, "off")).toBe(false);
  });

  it("auto samples on genuine ambiguity but not a clear winner", () => {
    expect(shouldSample(tied, "auto")).toBe(true);
    expect(shouldSample(moderate, "auto")).toBe(false);
    expect(shouldSample(clear, "auto")).toBe(false);
  });

  it("aggressive samples on milder ambiguity than auto", () => {
    expect(shouldSample(tied, "aggressive")).toBe(true);
    expect(shouldSample(moderate, "aggressive")).toBe(true);
    expect(shouldSample(clear, "aggressive")).toBe(false);
  });

  it("never samples with a single candidate at any effort", () => {
    const one = [{ namespace: "a", score: 1 }];
    expect(shouldSample(one, "auto")).toBe(false);
    expect(shouldSample(one, "aggressive")).toBe(false);
  });
});

describe("bestOfNViaSampling", () => {
  function mockServer(
    caps: { sampling?: object } | undefined,
    createMessage?: (params: unknown) => Promise<unknown>,
  ): Server {
    return {
      getClientCapabilities: () => caps,
      createMessage: createMessage ?? (async () => ({})),
    } as unknown as Server;
  }

  it("returns null without sampling capability (no calls made)", async () => {
    const createMessage = vi.fn();
    const server = mockServer(undefined, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("returns null with fewer than 2 candidates", async () => {
    const createMessage = vi.fn();
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", [candidates[0]!], 3);
    expect(out).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("clamps N up to MAX_SAMPLES", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "github" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 99);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(MAX_SAMPLES);
  });

  it("clamps N up to at least 1", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "github" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 0);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("majority-votes across N samples", async () => {
    // 3 calls: gitlab, gitlab, github -> gitlab wins 2-1.
    const replies = ["gitlab", "gitlab", "github"];
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => ({
      content: { type: "text", text: replies[i++] },
    }));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBe("gitlab");
    expect(createMessage).toHaveBeenCalledTimes(3);
  });

  it("breaks vote ties by ranker order (first candidate wins)", async () => {
    // 2 calls split 1-1; github is first in `candidates`, so it wins the tie.
    const replies = ["gitlab", "github"];
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => ({
      content: { type: "text", text: replies[i++] },
    }));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 2);
    expect(out).toBe("github");
  });

  it("returns null when no sample names a candidate", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "no idea" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBeNull();
  });

  it("never throws; a failing sample is dropped from the vote", async () => {
    // First call rejects, remaining two vote github.
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => {
      if (i++ === 0) throw new Error("upstream refused");
      return { content: { type: "text", text: "github" } };
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBe("github");
  });
});
