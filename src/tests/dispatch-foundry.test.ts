import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The opt-in foundry trace that mcp_connect_dispatch writes (server.ts
// handleDispatch -> foundry.ts appendFoundryTrace). `chosen` is the ranker's
// pick; `loaded` is the namespace that actually served the call. The two
// differ exactly when the pick fails to start and a runner-up is loaded in
// its place -- the case a trace naming only `chosen` used to misreport.

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

// Keep the real redactor and the real env gate; capture the write so the test
// never touches a real ~/.yaw-mcp.
vi.mock("../foundry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, appendFoundryTrace: vi.fn().mockResolvedValue(undefined) };
});

import { appendFoundryTrace } from "../foundry.js";
import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "../upstream.js";

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

function makeConnection(namespace: string): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: [{ name: "tool_one", namespacedName: `${namespace}_tool_one`, inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
    status: "connected",
  } as UpstreamConnection;
}

// Same name and description: the ranker cannot tell them apart, so a failed
// alpha is replaced by the runner-up beta (runnerUpCanReplace).
const TWINS = [
  makeServerConfig({ id: "a-id", namespace: "alpha", name: "GitHub", description: "Repos and issues" }),
  makeServerConfig({ id: "b-id", namespace: "beta", name: "GitHub", description: "Repos and issues" }),
];

describe("dispatch foundry trace", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    vi.mocked(appendFoundryTrace).mockResolvedValue(undefined);
    vi.stubEnv("YAW_MCP_FOUNDRY", "1");
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("records the runner-up that served a rescued dispatch as `loaded`, keeping the failed pick as `chosen`", async () => {
    const priv = server as any;
    priv.config = { configVersion: "v1", servers: TWINS };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "alpha") throw new ActivationError("docker daemon is not running", "install_failure");
      return makeConnection(cfg.namespace);
    });
    const result = await priv.handleDispatch("github issue", 1);
    // Precondition: this really was a rescue.
    expect(result.content[0].text).toContain("alpha failed to load; loaded runner-up beta instead.");
    expect(vi.mocked(appendFoundryTrace)).toHaveBeenCalledTimes(1);
    const trace = vi.mocked(appendFoundryTrace).mock.calls[0][0];
    expect(trace.chosen).toBe("alpha");
    expect(trace.loaded).toBe("beta");
    expect(trace.tokens).toEqual(["github", "issue"]);
  });

  it("records `loaded` equal to `chosen` when the pick itself loaded", async () => {
    const priv = server as any;
    priv.config = { configVersion: "v1", servers: TWINS };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace));
    await priv.handleDispatch("github issue", 1);
    const trace = vi.mocked(appendFoundryTrace).mock.calls[0][0];
    expect(trace.loaded).toBe(trace.chosen);
  });

  it("records `loaded: null` when nothing loaded", async () => {
    const priv = server as any;
    priv.config = { configVersion: "v1", servers: TWINS };
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("docker daemon is not running", "install_failure"),
    );
    const result = await priv.handleDispatch("github issue", 1);
    expect(result.isError).toBe(true);
    expect(vi.mocked(appendFoundryTrace)).toHaveBeenCalledTimes(1);
    const trace = vi.mocked(appendFoundryTrace).mock.calls[0][0];
    expect(typeof trace.chosen).toBe("string");
    expect(trace.loaded).toBeNull();
  });

  it("writes nothing when the harvest is off", async () => {
    vi.stubEnv("YAW_MCP_FOUNDRY", "");
    const priv = server as any;
    priv.config = { configVersion: "v1", servers: TWINS };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace));
    await priv.handleDispatch("github issue", 1);
    expect(vi.mocked(appendFoundryTrace)).not.toHaveBeenCalled();
  });
});
