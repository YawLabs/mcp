import { describe, expect, it } from "vitest";
import {
  FOUNDRY_CORPUS_VERSION,
  buildCorpusFromTraces,
  loadFoundryCorpus,
  parseTraceLines,
  scoreCorpus,
  validateCorpus,
} from "../foundry-corpus.js";
import type { RankableServer } from "../relevance.js";

const SERVERS: RankableServer[] = [
  {
    namespace: "github",
    name: "GitHub",
    description: "issues pull requests repositories commits",
    tools: [{ name: "create_issue" }, { name: "list_pull_requests" }],
  },
  { namespace: "slack", name: "Slack", description: "channels messages threads", tools: [{ name: "post_message" }] },
  {
    namespace: "stripe",
    name: "Stripe",
    description: "charges customers subscriptions invoices",
    tools: [{ name: "create_charge" }],
  },
];

describe("parseTraceLines", () => {
  it("parses valid lines and skips blank / garbage / shape-invalid", () => {
    const text = [
      JSON.stringify({ tokens: ["issue", "repo"], chosen: "github" }),
      "",
      "{ not json",
      JSON.stringify({ tokens: ["x"] }), // no chosen
      JSON.stringify({ chosen: "slack" }), // no tokens array
      JSON.stringify({ tokens: ["message"], chosen: "slack" }),
    ].join("\n");
    const traces = parseTraceLines(text);
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => t.chosen)).toEqual(["github", "slack"]);
  });
});

describe("buildCorpusFromTraces", () => {
  it("dedups by (sorted tokens, chosen) and accumulates weight", () => {
    const c = buildCorpusFromTraces(
      [
        { tokens: ["repo", "issue"], chosen: "github" },
        { tokens: ["issue", "repo"], chosen: "github" }, // same after sort
        { tokens: ["message"], chosen: "slack" },
      ],
      SERVERS,
    );
    expect(c.version).toBe(FOUNDRY_CORPUS_VERSION);
    expect(c.entries).toHaveLength(2);
    const gh = c.entries.find((e) => e.chosen === "github");
    expect(gh?.weight).toBe(2);
    expect(gh?.tokens).toEqual(["issue", "repo"]); // sorted
  });

  it("drops traces whose chosen is not in the server catalog", () => {
    expect(buildCorpusFromTraces([{ tokens: ["a", "b", "c"], chosen: "unknown" }], SERVERS).entries).toHaveLength(0);
  });

  it("drops traces with empty tokens", () => {
    expect(buildCorpusFromTraces([{ tokens: [], chosen: "github" }], SERVERS).entries).toHaveLength(0);
  });

  it("caps entries, stratified across chosen servers", () => {
    const traces = [];
    for (let i = 0; i < 10; i++) traces.push({ tokens: [`gh${i}tok`, "alpha", "beta"], chosen: "github" });
    for (let i = 0; i < 10; i++) traces.push({ tokens: [`sl${i}tok`, "gamma", "delta"], chosen: "slack" });
    const c = buildCorpusFromTraces(traces, SERVERS, { cap: 4 });
    expect(c.entries).toHaveLength(4);
    const chosen = new Set(c.entries.map((e) => e.chosen));
    expect(chosen.has("github")).toBe(true);
    expect(chosen.has("slack")).toBe(true);
  });
});

describe("scoreCorpus", () => {
  it("computes weighted top-1 / top-3 accuracy via the BM25 floor", () => {
    const corpus = buildCorpusFromTraces(
      [
        { tokens: ["issue", "pull", "repositories"], chosen: "github" },
        { tokens: ["charges", "subscriptions", "invoices"], chosen: "stripe" },
      ],
      SERVERS,
    );
    const s = scoreCorpus(corpus);
    expect(s.totalWeight).toBe(2);
    expect(s.top3).toBe(1); // both lexically match their chosen server
    expect(s.top1).toBeGreaterThan(0);
  });

  it("counts a miss against the score", () => {
    // tokens lexically match github, but chosen claims slack -> not in top-1.
    const corpus = buildCorpusFromTraces([{ tokens: ["issue", "pull", "commits"], chosen: "slack" }], SERVERS);
    const s = scoreCorpus(corpus);
    expect(s.top1).toBe(0);
  });
});

describe("validateCorpus / loadFoundryCorpus", () => {
  it("rejects wrong version, non-arrays, and empty entries", () => {
    expect(validateCorpus(null)).toBeNull();
    expect(validateCorpus({ version: 99, servers: [], entries: [] })).toBeNull();
    expect(validateCorpus({ version: 1, servers: [], entries: [] })).toBeNull(); // empty
    expect(
      validateCorpus({ version: 1, servers: SERVERS, entries: [{ tokens: ["a"], chosen: "github", weight: 1 }] }),
    ).not.toBeNull();
  });

  it("loadFoundryCorpus returns null for a missing file", () => {
    expect(loadFoundryCorpus("/no/such/path/foundry-corpus.json")).toBeNull();
  });
});
