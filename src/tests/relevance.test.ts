import { beforeEach, describe, expect, it } from "vitest";
import { rankServers, relevanceCacheStats, resetRelevanceCache, scoreRelevance } from "../relevance.js";

describe("scoreRelevance (single-server wrapper)", () => {
  const server = { name: "GitHub", namespace: "gh", description: "Repos, issues, pull requests" };

  it("returns 0 for empty context", () => {
    expect(scoreRelevance("", server, [])).toBe(0);
  });

  it("returns 0 for context with only short words", () => {
    expect(scoreRelevance("go do it", server, [])).toBe(0);
  });

  it("scores server name matches", () => {
    const score = scoreRelevance("use github", server, []);
    expect(score).toBeGreaterThan(0);
  });

  it("scores namespace matches on multi-char namespaces", () => {
    const slackServer = { name: "Slack", namespace: "slack", description: "Team chat" };
    const score = scoreRelevance("check slack messages", slackServer, []);
    expect(score).toBeGreaterThan(0);
  });

  it("matches snake_case tool names from space-separated query", () => {
    const tools = [{ name: "create_issue", description: "Create a new issue" }];
    const score = scoreRelevance("create issue on github", server, tools);
    expect(score).toBeGreaterThan(0);
  });

  it("scores tool description matches", () => {
    const tools = [{ name: "run_query", description: "Execute a database query" }];
    const score = scoreRelevance(
      "database query needed",
      { name: "DB", namespace: "db", description: "SQL access" },
      tools,
    );
    expect(score).toBeGreaterThan(0);
  });

  it("deduplicates query terms so repeats don't inflate score", () => {
    const singleScore = scoreRelevance("github tools", server, []);
    const repeatedScore = scoreRelevance("github github github tools", server, []);
    expect(repeatedScore).toBe(singleScore);
  });

  it("is case-insensitive", () => {
    const lower = scoreRelevance("github", server, []);
    const upper = scoreRelevance("GITHUB", server, []);
    expect(lower).toBe(upper);
  });

  it("returns 0 when no words match", () => {
    const score = scoreRelevance("completely unrelated query", server, []);
    expect(score).toBe(0);
  });

  it("strips punctuation from query tokens", () => {
    const score = scoreRelevance("use (github)!", server, []);
    expect(score).toBeGreaterThan(0);
  });
});

describe("rankServers (corpus-wide BM25)", () => {
  const gh = {
    namespace: "gh",
    name: "GitHub",
    description: "Repos, issues, and pull requests",
    tools: [
      { name: "create_issue", description: "Create a new issue in a repo" },
      { name: "list_pull_requests", description: "List open pull requests" },
    ],
  };
  const slack = {
    namespace: "slack",
    name: "Slack",
    description: "Team chat and direct messages",
    tools: [{ name: "send_message", description: "Post a message to a channel" }],
  };
  const postgres = {
    namespace: "pg",
    name: "Postgres",
    description: "SQL queries against a Postgres database",
    tools: [{ name: "run_query", description: "Execute a SQL query" }],
  };
  const corpus = [gh, slack, postgres];

  it("returns empty array for empty query", () => {
    expect(rankServers("", corpus)).toEqual([]);
  });

  it("returns empty array for empty corpus", () => {
    expect(rankServers("github issues", [])).toEqual([]);
  });

  it("ranks the obvious winner first", () => {
    const ranked = rankServers("create a github issue", corpus);
    expect(ranked[0]?.namespace).toBe("gh");
  });

  it("ranks slack first for messaging queries", () => {
    const ranked = rankServers("send a message to the team", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
  });

  it("ranks postgres first for database queries", () => {
    const ranked = rankServers("run a sql query against the database", corpus);
    expect(ranked[0]?.namespace).toBe("pg");
  });

  it("omits servers with zero score", () => {
    const ranked = rankServers("pull request review", corpus);
    // gh should match; slack and postgres shouldn't have any matching terms
    expect(ranked.map((r) => r.namespace)).toEqual(["gh"]);
  });

  it("boosts servers whose name exactly matches the query", () => {
    const ranked = rankServers("slack", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
    // IDF is high because "slack" appears in only one server
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });

  it("returns a stable order when scores tie", () => {
    // Query that matches no server should give empty result (not flaky)
    const a = rankServers("", corpus);
    const b = rankServers("", corpus);
    expect(a).toEqual(b);
  });

  it("does not rank a server that lacks both description and tools when query misses name", () => {
    const mystery = { namespace: "mystery", name: "Thing", description: undefined, tools: [] };
    const ranked = rankServers("database query", [...corpus, mystery]);
    expect(ranked.find((r) => r.namespace === "mystery")).toBeUndefined();
  });

  it("scores common terms lower than rare terms (IDF signal)", () => {
    // Every server in this mini-corpus mentions "server" in description
    const big = [
      { namespace: "a", name: "A", description: "server server server", tools: [] },
      { namespace: "b", name: "B", description: "server server server", tools: [] },
      { namespace: "c", name: "C", description: "unique rarely-used thing server", tools: [] },
    ];
    const commonQuery = rankServers("server", big);
    const rareQuery = rankServers("unique", big);
    // "unique" appears in 1/3 servers → higher IDF → higher top score
    expect(rareQuery[0]?.score).toBeGreaterThan(commonQuery[0]?.score ?? 0);
  });

  // Fix 5: bm25Score no longer accepts the dead `idf: Map<string,string>` param.
  // rankServers must still produce correct scores after the signature cleanup.
  it("produces the same scores before and after idf param removal (fix 5)", () => {
    // Regression guard: removing the dead parameter must not change output.
    const servers = [
      {
        namespace: "gh",
        name: "GitHub",
        description: "Repos and issues",
        tools: [{ name: "create_issue", description: "Create an issue" }],
      },
      {
        namespace: "slack",
        name: "Slack",
        description: "Team messaging",
        tools: [{ name: "send_message", description: "Post a message" }],
      },
    ];
    const ranked = rankServers("create github issue", servers);
    // gh should rank first — create/issue both match gh fields.
    expect(ranked[0]?.namespace).toBe("gh");
    // Both scores must be finite positive numbers (not NaN from a voided arg).
    for (const r of ranked) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("rankServers scores are purely driven by idfValues, not the removed idf param (fix 5)", () => {
    // A term unique to one server should score that server highly,
    // confirming idfValues (the real Map<string,number>) is the active path.
    const servers = [
      { namespace: "only", name: "OnlyMatch", description: "xyzplonk unique term", tools: [] },
      { namespace: "other", name: "Other", description: "completely different", tools: [] },
    ];
    const ranked = rankServers("xyzplonk", servers);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].namespace).toBe("only");
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

// The BM25 index (per-field token counts, document frequency, IDF, average
// field lengths) is a pure function of the corpus, but it used to be rebuilt
// on every call. Profiling put that rebuild at ~90% of the cost of a single
// rankServers() call, and it is paid on every discover and every dispatch.
//
// These tests assert the caching behaviour via build counters rather than
// wall-clock timings, so they fail deterministically on a regression instead
// of flaking on a loaded CI box.
describe("ranking index cache", () => {
  beforeEach(() => {
    resetRelevanceCache();
  });

  const corpus = () => [
    {
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, pull requests",
      tools: [
        { name: "create_issue", description: "Open a new issue" },
        { name: "list_pull_requests", description: "List open pull requests" },
      ],
    },
    {
      namespace: "slack",
      name: "Slack",
      description: "Team messaging",
      tools: [{ name: "send_message", description: "Post a message to a channel" }],
    },
  ];

  it("builds the index once across repeated ranking of the same corpus", () => {
    for (let i = 0; i < 25; i++) {
      rankServers("create an issue", corpus());
    }
    // One build total -- not one per call -- even though every call passes a
    // freshly constructed array (which is what ConnectServer.rankableFor does).
    expect(relevanceCacheStats().indexBuilds).toBe(1);
    expect(relevanceCacheStats().docBuilds).toBe(2);
  });

  it("returns identical rankings on cached and uncached calls", () => {
    const first = rankServers("create an issue", corpus());
    const second = rankServers("create an issue", corpus());
    expect(second).toEqual(first);
    expect(relevanceCacheStats().indexBuilds).toBe(1);
  });

  it("varies scoring by query while reusing one index", () => {
    const issues = rankServers("create an issue", corpus());
    const chat = rankServers("post a message to the channel", corpus());
    expect(issues[0]?.namespace).toBe("gh");
    expect(chat[0]?.namespace).toBe("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(1);
  });

  it("rebuilds when a server description changes", () => {
    rankServers("kubernetes deploys", corpus());
    const edited = corpus();
    edited[1].description = "Team messaging and kubernetes deploy alerts";
    const after = rankServers("kubernetes deploys", edited);
    // The edit must be visible -- a stale index would still score slack at 0.
    expect(after.map((r) => r.namespace)).toContain("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(2);
  });

  it("rebuilds when a tool is added", () => {
    rankServers("upload attachment", corpus());
    const edited = corpus();
    edited[1].tools.push({ name: "upload_attachment", description: "Upload a file" });
    const after = rankServers("upload attachment", edited);
    expect(after.map((r) => r.namespace)).toContain("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(2);
  });

  it("reuses per-server fields for the servers that did not change", () => {
    rankServers("create an issue", corpus());
    expect(relevanceCacheStats().docBuilds).toBe(2);
    const edited = corpus();
    edited[1].description = "Team messaging, now with threads";
    rankServers("create an issue", edited);
    // Only the edited server is re-tokenized; gh's fields come from the cache.
    expect(relevanceCacheStats().docBuilds).toBe(3);
  });

  it("does not collide corpora that differ only in where a field boundary falls", () => {
    // Guards the signature separator: joining fields with a printable
    // character would sign these two corpora identically, silently serving
    // one the other's index. Namespace and name carry different BM25 weights,
    // so a collision would also produce a wrong score.
    const a = [{ namespace: "alpha beta", name: "gamma", description: "", tools: [] }];
    const b = [{ namespace: "alpha", name: "beta gamma", description: "", tools: [] }];
    const rankedA = rankServers("beta", a);
    const rankedB = rankServers("beta", b);
    expect(relevanceCacheStats().indexBuilds).toBe(2);
    // beta sits in `namespace` (weight 2.0) for a, and in `name` (weight 3.0)
    // for b, so the scores must differ.
    expect(rankedA[0]?.score).not.toBe(rankedB[0]?.score);
  });

  it("bounds the index cache instead of growing without limit", () => {
    for (let i = 0; i < 40; i++) {
      rankServers("create an issue", [
        { namespace: `ns${i}`, name: `Server ${i}`, description: "unique corpus", tools: [] },
      ]);
    }
    // Every corpus is distinct, so every call builds -- the point is that the
    // cache evicts rather than retaining all 40.
    expect(relevanceCacheStats().indexBuilds).toBe(40);
    // Re-ranking the FIRST corpus must miss (it was evicted), proving the cap.
    rankServers("create an issue", [{ namespace: "ns0", name: "Server 0", description: "unique corpus", tools: [] }]);
    expect(relevanceCacheStats().indexBuilds).toBe(41);
  });

  it("evicts least-recently-used, so a churning server cannot flush its stable neighbours", () => {
    // FIFO eviction would let one server whose content changes every call
    // push out the neighbours that never change -- exactly the reuse the doc
    // cache exists to provide, since a stable entry is inserted once and then
    // stays permanently "oldest". Measured before the fix on a 100-server
    // corpus: 798 doc builds over 600 calls against an ideal of 699.
    const STABLE = 20;
    const CALLS = 600; // STABLE + CALLS must exceed MAX_CACHED_DOCS (512)
    const withChurn = (v: number) => [
      ...Array.from({ length: STABLE }, (_, i) => ({
        namespace: `stable${i}`,
        name: `Stable ${i}`,
        description: `unchanging server ${i}`,
        tools: [{ name: `tool_${i}`, description: `does thing ${i}` }],
      })),
      { namespace: "churn", name: "Churn", description: `version ${v}`, tools: [] },
    ];
    for (let v = 0; v < CALLS; v++) rankServers("thing", withChurn(v));
    // One build per stable server plus the churner, then one per new version:
    // the stable 20 are re-tokenized zero times.
    expect(relevanceCacheStats().docBuilds).toBe(STABLE + 1 + (CALLS - 1));
  });

  it("does not let scoreRelevance evict the cached corpus index", () => {
    rankServers("create an issue", corpus());
    expect(relevanceCacheStats().indexBuilds).toBe(1);
    // Each scoreRelevance call is its own distinct one-server corpus. Routing
    // those through the shared index cache (cap 4) would evict the corpus
    // index above on every iteration, silently undoing the caching for the
    // discover/dispatch path that needs it.
    for (let i = 0; i < 12; i++) {
      scoreRelevance("issue tracker", { name: `Server ${i}`, namespace: `ns${i}` }, []);
    }
    const beforeReRank = relevanceCacheStats().indexBuilds;
    rankServers("create an issue", corpus());
    expect(relevanceCacheStats().indexBuilds).toBe(beforeReRank);
  });

  it("cannot be made to collide by control characters inside a field", () => {
    // Tool names and descriptions come from third-party upstream servers over
    // JSON-RPC, where NUL and SOH are legal string content -- so any
    // "this character cannot occur" assumption in a delimiter scheme is
    // supplied by the untrusted side. Length-prefixing removes the assumption.
    const embedded = [{ namespace: "ns", name: "Name", description: "alpha beta ", tools: [] }];
    const split = [{ namespace: "ns", name: "Name", description: "alpha", tools: [{ name: "beta", description: "" }] }];
    const a = rankServers("beta", embedded);
    const b = rankServers("beta", split);
    expect(relevanceCacheStats().indexBuilds).toBe(2);
    // "beta" lands in `description` (weight 1.5) for one and `toolName`
    // (weight 2.0) for the other, so a collision would also misscore.
    expect(a[0]?.score).not.toBe(b[0]?.score);
  });

  it("cannot be made to collide across the server boundary of the index key", () => {
    const two = [
      { namespace: "alpha", name: "Alpha", description: "widget", tools: [] },
      { namespace: "bravo", name: "Bravo", description: "widget", tools: [] },
    ];
    // Under a separator-joined index key this single server signs identically
    // to the two-server corpus above, so it would be served a 2-doc index --
    // wrong N, wrong IDF, and a ranked namespace the caller never passed in.
    const forged = [
      {
        namespace: "alpha",
        name: "Alpha",
        description: "widgetbravo Bravo widget",
        tools: [],
      },
    ];
    rankServers("widget", two);
    expect(rankServers("widget", forged).map((r) => r.namespace)).toEqual(["alpha"]);
  });

  it("still saturates term frequency after the counts refactor", () => {
    // FieldStats stores per-term counts instead of a token array; BM25's k1
    // saturation must still apply, so 5 repeats scores below 5x a single hit.
    const once = rankServers("widget", [{ namespace: "one", name: "One", description: "widget", tools: [] }]);
    const many = rankServers("widget", [
      { namespace: "one", name: "One", description: "widget widget widget widget widget", tools: [] },
    ]);
    expect(many[0].score).toBeGreaterThan(once[0].score);
    expect(many[0].score).toBeLessThan(once[0].score * 5);
  });
});
