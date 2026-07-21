import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Dispatch + auto-warm discover coverage
//
// Exercises the new BM25-ranked routing surface:
//   mcp_connect_dispatch(intent, budget) — rank + activate top-N
//   mcp_connect_discover(context)        — auto-warm a decisive winner
//
// Also pins tool-report integration (success path calls reportTools).
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
  }),
}));

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

// recordDispatchEvent MUST be stubbed: server.ts calls it on every proxied
// tool call, and the production catch-all would swallow the TypeError a
// missing export throws -- the telemetry would silently stop firing.
vi.mock("../analytics.js", () => ({
  initAnalytics: vi.fn(),
  recordConnectEvent: vi.fn(),
  recordDispatchEvent: vi.fn(),
  shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tool-report.js", () => ({
  initToolReport: vi.fn(),
  reportTools: vi.fn().mockResolvedValue(undefined),
}));

import { ConnectServer } from "../server.js";
import { reportTools } from "../tool-report.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream } from "../upstream.js";

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
  status: "connected" | "error" = "connected",
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
    status,
  } as UpstreamConnection;
}

function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("handleDispatch", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://yaw.sh/mcp", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("rejects empty intent", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("intent is required");
  });

  it("errors when no servers are configured", async () => {
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: [] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No servers installed");
  });

  it("errors when no installed server matches the intent", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("xylophone orchestration", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No installed server matches/);
  });

  it("activates only the top 1 by default", async () => {
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Team chat and direct messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue", description: "Create an issue" }]),
    );

    const result = await priv.handleDispatch("create a github issue", 1);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
    expect(result.content[0].text).toContain('Loaded "gh"');
  });

  it("respects a budget larger than 1", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "gh", name: "GitHub", description: "Issues and pull requests" }),
        makeServerConfig({ id: "b", namespace: "slack", name: "Slack", description: "Issues and messages from team" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "Example" }]),
    );
    const result = await priv.handleDispatch("issues", 2);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
  });

  it("clamps an absurd budget request to 10", async () => {
    const priv = getPrivate(server);
    // Build a corpus where many servers share a term so rank returns many
    const servers = Array.from({ length: 15 }, (_, i) =>
      makeServerConfig({
        id: `id-${i}`,
        namespace: `ns${i}`,
        name: `Server${i}`,
        description: "common-term shared across all",
      }),
    );
    priv.config = { configVersion: "v1", servers };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, []),
    );
    const result = await priv.handleDispatch("common-term", 999);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("surfaces the ActivationError message when a server fails to connect", async () => {
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
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError(
        'Server "gh" failed to start. stderr: Error: GITHUB_TOKEN is required',
        "install_failure",
        "Error: GITHUB_TOKEN is required",
      ),
    );
    const result = await priv.handleDispatch("github issue", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GITHUB_TOKEN is required");
  });

  it("fires reportTools after a successful activation", async () => {
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
    vi.mocked(connectToUpstream).mockResolvedValue(
      makeConnection("gh", [{ name: "create_issue", description: "Create" }]),
    );
    await priv.handleDispatch("github issues", 1);
    // Fire-and-forget — awaiting the microtask queue is enough
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(reportTools)).toHaveBeenCalledWith("gh-id", [{ name: "create_issue", description: "Create" }]);
  });

  it("one winner loads, one is cap-refused -- result is not an error (isError undefined)", async () => {
    // When the budget allows 2 servers but the cap only admits 1 (the first),
    // the second activation returns capped:true. Since something DID load,
    // isError must be undefined (not true) -- same rule as handleActivate.
    const priv = getPrivate(server);
    // Pre-load one server to fill the cap (serverCap = 1 for this test).
    priv.serverCap = 1;
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Issues and team messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "issues" }]),
    );

    // budget=2 so dispatch tries both; cap=1 so only the top-ranked loads.
    const result = await priv.handleDispatch("issues", 2);
    // At least one loaded (gh), one refused (slack) -- isError must be undefined.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Loaded "gh"/);
  });

  it("ALL winners are cap-refused and nothing loads -- isError true", async () => {
    // Pre-fill the cap by seeding a connection that is already connected
    // (counts toward the slot), then set serverCap=1 so no new server can load.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Issues and team messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };
    // Pre-load a DIFFERENT server to fill the single slot so both winners are refused.
    priv.connections.set("other", makeConnection("other", [{ name: "t" }]));

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one" }]),
    );

    const result = await priv.handleDispatch("issues", 2);
    // Nothing loaded -- anyCapped && !anyChanged => isError true.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/concurrent.*cap|cap.*concurrent/i);
  });

  it("does not reactivate a server that is already connected", async () => {
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig] };
    priv.connections.set("gh", makeConnection("gh", [{ name: "create_issue" }]));

    const result = await priv.handleDispatch("github issue", 1);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("already loaded");
  });
});

describe("handleDiscoverWithAutoWarm", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://yaw.sh/mcp", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("auto-activates the decisive winner when context is provided", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos, issues, and pull requests on GitHub",
        }),
        makeServerConfig({
          id: "fs-id",
          namespace: "fs",
          name: "Filesystem",
          description: "Read and write local files",
        }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
    expect(result.content[0].text).toContain('Auto-loaded "gh"');
  });

  it("does not auto-activate when no context is provided", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issues" })],
    };
    const result = await priv.handleDiscoverWithAutoWarm(undefined);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // The banner string is "Auto-loaded" -- asserting on "Auto-activated"
    // (the old wording) passed vacuously no matter what the code did.
    expect(result.content[0].text).not.toContain("Auto-loaded");
  });

  it("does not auto-activate on an ambiguous query (top score below threshold)", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issues" }),
        makeServerConfig({ namespace: "slack", name: "Slack", description: "Messages" }),
      ],
    };
    // Query has no tokens that match anything — ranked[] empty → fallback
    const result = await priv.handleDiscoverWithAutoWarm("xyzzy");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-loaded");
  });

  it("does not auto-activate a server that is already connected", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos, issues, and pull requests on GitHub",
        }),
      ],
    };
    priv.connections.set("gh", makeConnection("gh", [{ name: "create_issue" }]));
    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-loaded");
  });

  it("YAW_MCP_AUTO_ACTIVATE=0 disables the auto-warm entirely", async () => {
    // The gate used to be a static initializer evaluated at import, so an
    // env change (or a test stub) after the first import of server.ts was
    // ignored. It is now read per call.
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0");
    try {
      const priv = getPrivate(server);
      priv.config = {
        configVersion: "v1",
        servers: [
          makeServerConfig({
            id: "gh-id",
            namespace: "gh",
            name: "GitHub",
            description: "Repos, issues, and pull requests on GitHub",
          }),
        ],
      };
      vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
        makeConnection(cfg.namespace, [{ name: "create_issue" }]),
      );

      const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain("Auto-loaded");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names the namespace it actually warmed, not the head of the BM25 list", async () => {
    // The banner used to print sorted[0] from the BM25-only ranking the
    // list rendering uses, while the server that got activated came from
    // twoStageRank. When rerank promotes a different namespace the two
    // disagree and the banner names a server that was never loaded.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a-id", namespace: "alpha", name: "Alpha", description: "issues issues issues" }),
        makeServerConfig({ id: "b-id", namespace: "bravo", name: "Bravo", description: "issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );
    // Force the auto-warm winner to be "bravo" regardless of BM25 order.
    priv.twoStageRank = async () => [
      { namespace: "bravo", score: 0.9, hasRerank: true },
      { namespace: "alpha", score: 0.1, hasRerank: true },
    ];

    const result = await priv.handleDiscoverWithAutoWarm("issues");
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("bravo");
    expect(result.content[0].text).toContain('Auto-loaded "bravo"');
    expect(result.content[0].text).not.toContain('Auto-loaded "alpha"');
  });
});

describe("ActivationError", () => {
  it("carries category and stderr tail", () => {
    const err = new ActivationError("boom", "install_failure", "Error: missing env");
    expect(err.category).toBe("install_failure");
    expect(err.stderrTail).toBe("Error: missing env");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("ActivationError");
  });

  it("works without an optional stderr tail", () => {
    const err = new ActivationError("timeout", "init_timeout");
    expect(err.stderrTail).toBeUndefined();
    expect(err.category).toBe("init_timeout");
  });
});
