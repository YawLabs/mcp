import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Rerank client + two-stage retrieval coverage
//
// Pins three things:
//   1. The rerank client degrades silently on 503, 5xx, timeout, or
//      malformed response — never throws, always returns null.
//   2. handleDispatch's two-stage path uses rerank order when the
//      backend replies, and BM25 order when it returns null.
//   3. Reordering is correct when rerank bumps a BM25 also-ran ahead
//      of the BM25 winner (the whole reason we added rerank).
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({ servers: [], configVersion: "v1" }),
  };
});

vi.mock("../analytics.js", () => ({
  initAnalytics: vi.fn(),
  recordConnectEvent: vi.fn(),
  shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tool-report.js", () => ({
  initToolReport: vi.fn(),
  reportTools: vi.fn().mockResolvedValue(undefined),
}));

// Mock team-sync so we can spy on getCachedCookie without disk I/O.
// Important: getSession must always return a thenable (Promise) because
// rerank.ts calls it as `getSession().catch(...)`. A vi.fn() reset by
// vi.clearAllMocks() returns undefined which breaks .catch(). We use a
// stable default implementation that always returns a resolved Promise.
vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    getSession: vi.fn().mockImplementation(() => Promise.resolve(null)),
    getCachedCookie: vi.fn().mockReturnValue(null),
  };
});

import { request } from "undici";
import { log } from "../logger.js";
import { initRerank, rerank } from "../rerank.js";
import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream } from "../upstream.js";

function mockOkResponse(body: unknown) {
  return {
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue(body) },
  };
}

function mockStatusResponse(statusCode: number, body: unknown = {}) {
  return {
    statusCode,
    body: {
      text: vi.fn().mockResolvedValue(""),
      json: vi.fn().mockResolvedValue(body),
    },
  };
}

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "srv-id",
    name: "Test",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(
  namespace: string,
  tools: Array<{ name: string; description?: string }> = [],
): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((t) => ({
      name: t.name,
      namespacedName: `${namespace}_${t.name}`,
      description: t.description,
      inputSchema: { type: "object" },
    })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as UpstreamConnection;
}

function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("rerank client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initRerank("https://yaw.sh/mcp", "test-token");
  });

  it("returns null when intent is empty", async () => {
    const result = await rerank("", ["a", "b"]);
    expect(result).toBeNull();
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("returns null when candidateIds is empty", async () => {
    const result = await rerank("github issue", []);
    expect(result).toBeNull();
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("returns null on 503 (key absent on backend)", async () => {
    vi.mocked(request).mockResolvedValue(mockStatusResponse(503) as any);
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns null on 429 / other 4xx", async () => {
    vi.mocked(request).mockResolvedValue(mockStatusResponse(429) as any);
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns null on 500", async () => {
    vi.mocked(request).mockResolvedValue(mockStatusResponse(500) as any);
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns null when the body is malformed", async () => {
    vi.mocked(request).mockResolvedValue(mockOkResponse({ garbage: true }) as any);
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns null when results array is empty", async () => {
    vi.mocked(request).mockResolvedValue(mockOkResponse({ results: [] }) as any);
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(request).mockRejectedValue(new Error("timeout"));
    const result = await rerank("github issue", ["id-1"]);
    expect(result).toBeNull();
  });

  it("returns the parsed results on 200", async () => {
    vi.mocked(request).mockResolvedValue(
      mockOkResponse({
        results: [
          { id: "id-2", score: 0.9 },
          { id: "id-1", score: 0.7 },
        ],
      }) as any,
    );
    const result = await rerank("github issue", ["id-1", "id-2"]);
    expect(result).toEqual([
      { id: "id-2", score: 0.9 },
      { id: "id-1", score: 0.7 },
    ]);
  });

  it("calls the backend with just intent when candidateIds is omitted (global mode)", async () => {
    vi.mocked(request).mockResolvedValue(
      mockOkResponse({
        results: [{ id: "top", score: 0.88 }],
      }) as any,
    );
    const result = await rerank("file a github issue");
    expect(result).toEqual([{ id: "top", score: 0.88 }]);

    // Body should have intent only — no candidateIds, no limit.
    const call = vi.mocked(request).mock.calls[0];
    const body = JSON.parse((call[1] as any).body);
    expect(body).toEqual({ intent: "file a github issue" });
  });

  it("passes limit to the backend when provided", async () => {
    vi.mocked(request).mockResolvedValue(mockOkResponse({ results: [{ id: "a", score: 0.9 }] }) as any);
    await rerank("query", undefined, 10);
    const call = vi.mocked(request).mock.calls[0];
    const body = JSON.parse((call[1] as any).body);
    expect(body).toEqual({ intent: "query", limit: 10 });
  });

  it("omits limit when non-positive", async () => {
    vi.mocked(request).mockResolvedValue(mockOkResponse({ results: [{ id: "a", score: 0.9 }] }) as any);
    await rerank("query", undefined, 0);
    const call = vi.mocked(request).mock.calls[0];
    const body = JSON.parse((call[1] as any).body);
    expect(body).toEqual({ intent: "query" });
  });

  // Path-A / Path-B fallback-blocking contract:
  // When a session exists but callTeamRerank returns null (Voyage
  // unavailable or cookie missing), rerank() returns null immediately --
  // it must NOT fall through to Path B (the legacy MCPH_TOKEN endpoint).
  it("does not fall back to Path B when session exists but callTeamRerank returns null", async () => {
    const teamSync = await import("../team-sync.js");
    // Session is present -> Path A runs.
    vi.mocked(teamSync.getSession).mockImplementationOnce(() =>
      Promise.resolve({
        email: "u@example.com",
        role: "member" as const,
        order_id: "ord",
        exp: Date.now() + 86400_000,
      }),
    );
    // No cookie -> callTeamRerank returns null without hitting the network.
    vi.mocked(teamSync.getCachedCookie).mockReturnValueOnce(null);

    // initRerank is called in beforeEach, so legacyApiUrl / legacyToken are set.
    // If Path B ran, request() would be called for the legacy endpoint.
    const result = await rerank("test intent", ["srv-id"]);

    expect(result).toBeNull();
    // request() must NOT have been called -- Path B was blocked.
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  // 401 from callTeamRerank must log at "debug" level (not "warn"),
  // because an expired session cookie is a normal operating condition,
  // not a backend error worth alarming on.
  it("callTeamRerank 401 logs at debug level and returns null", async () => {
    const teamSync = await import("../team-sync.js");
    vi.mocked(teamSync.getSession).mockImplementationOnce(() =>
      Promise.resolve({
        email: "u@example.com",
        role: "member" as const,
        order_id: "ord",
        exp: Date.now() + 86400_000,
      }),
    );
    vi.mocked(teamSync.getCachedCookie).mockReturnValueOnce("stale-cookie");

    vi.mocked(request).mockResolvedValueOnce(mockStatusResponse(401) as any);

    const result = await rerank("test intent", ["srv-id"]);

    expect(result).toBeNull();
    // Must have logged at "debug", not "warn".
    expect(vi.mocked(log)).toHaveBeenCalledWith("debug", expect.stringContaining("401"), expect.anything());
    expect(vi.mocked(log)).not.toHaveBeenCalledWith("warn", expect.stringContaining("401"), expect.anything());
  });
});

describe("handleDispatch two-stage ranking", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://yaw.sh/mcp", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("uses rerank order when the backend returns results", async () => {
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests",
    });
    const linearConfig = makeServerConfig({
      id: "linear-id",
      namespace: "linear",
      name: "Linear",
      description: "Issues, projects, and engineering tracking",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, linearConfig] };

    // Both match BM25 on "issues", but rerank flips the order so linear
    // (lower BM25 score due to shorter matching text) wins overall.
    vi.mocked(request).mockImplementation(async (url: any) => {
      if (String(url).endsWith("/api/connect/rerank")) {
        return mockOkResponse({
          results: [
            { id: "linear-id", score: 0.95 },
            { id: "gh-id", score: 0.6 },
          ],
        }) as any;
      }
      return mockOkResponse({}) as any;
    });
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "list_issues" }]),
    );

    const result = await priv.handleDispatch("log issues", 1);
    expect(result.isError).toBeUndefined();
    // Budget is 1; Linear should be the winner after rerank
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("linear");
  });

  it("falls back to BM25 order when rerank is unavailable (503)", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos, issues, and pull requests",
        }),
        makeServerConfig({
          id: "slack-id",
          namespace: "slack",
          name: "Slack",
          description: "Team chat and direct messages",
        }),
      ],
    };

    vi.mocked(request).mockImplementation(async (url: any) => {
      if (String(url).endsWith("/api/connect/rerank")) {
        return mockStatusResponse(503) as any;
      }
      return mockOkResponse({}) as any;
    });
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, []),
    );

    const result = await priv.handleDispatch("create a github issue", 1);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    // BM25 wins "github" for gh
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
  });

  it("falls back to BM25 when rerank network errors out", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos and issues",
        }),
      ],
    };
    vi.mocked(request).mockRejectedValue(new Error("ECONNRESET"));
    vi.mocked(connectToUpstream).mockResolvedValue(makeConnection("gh", []));

    const result = await priv.handleDispatch("github issue", 1);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
  });

  // ---------------------------------------------------------------
  // Fix: readTeamCookie uses getCachedCookie (no duplicate disk read)
  // ---------------------------------------------------------------
  it("readTeamCookie calls getCachedCookie (not a second readFile) after getSession warms the cache", async () => {
    // team-sync is mocked at module level (vi.mock above). Both getSession
    // and getCachedCookie are vi.fn() on the same mock instance that
    // rerank.ts's lazy import("./team-sync.js") resolves to.
    //
    // The fixed rerank.ts path:
    //   rerank() calls getSession() [static import] -> session truthy
    //   -> callTeamRerank() -> readTeamCookie() -> getCachedCookie() [dynamic import]
    //   NO second getSession() inside readTeamCookie.
    const teamSync = await import("../team-sync.js");

    // getSession returns a valid session so Path A runs.
    // Use mockImplementationOnce so the default (null) is restored for the
    // next test -- vi.clearAllMocks() preserves implementations, not results.
    vi.mocked(teamSync.getSession).mockImplementationOnce(() =>
      Promise.resolve({
        email: "u@example.com",
        role: "member" as const,
        order_id: "ord",
        exp: Date.now() + 86400_000,
      }),
    );
    // getCachedCookie returns a real cookie so callTeamRerank proceeds.
    vi.mocked(teamSync.getCachedCookie).mockReturnValueOnce("test-cookie");

    // Stub the team-rerank HTTP call (Path A hits yaw.sh/api/team/rerank).
    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 200,
      body: {
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({ results: [{ id: "srv-id", score: 0.9 }] }),
      },
    } as any);

    await rerank("test intent", ["srv-id"]);

    // getCachedCookie must have been called (the new code path)
    // rather than a raw readFile inside readTeamCookie.
    expect(vi.mocked(teamSync.getCachedCookie)).toHaveBeenCalled();
  });

  it("sorts reranked candidates above non-reranked BM25 survivors", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "a-id",
          namespace: "a",
          name: "Alpha",
          description: "issues issues issues",
        }),
        makeServerConfig({
          id: "b-id",
          namespace: "b",
          name: "Bravo",
          description: "issues tracker",
        }),
        makeServerConfig({
          id: "c-id",
          namespace: "c",
          name: "Charlie",
          description: "issues management",
        }),
      ],
    };

    // Rerank only returns b — a and c didn't have embeddings yet. The
    // code path should promote b above a and c regardless of BM25
    // scores, because reranked entries beat non-reranked ones.
    vi.mocked(request).mockImplementation(async (url: any) => {
      if (String(url).endsWith("/api/connect/rerank")) {
        return mockOkResponse({ results: [{ id: "b-id", score: 0.88 }] }) as any;
      }
      return mockOkResponse({}) as any;
    });
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, []),
    );

    const result = await priv.handleDispatch("issues", 1);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("b");
  });
});
