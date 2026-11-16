// Regressions from a full read of server.ts. Each case pins one behaviour
// that was wrong on a path the main suite did not drive: overlapping
// teardowns, a failed background revalidation, inspection calls ageing the
// server they inspect, blank optional args, bundle remedies, the exec echo
// budget's unit, a displaced error-state connection, and health's tool list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    // Flips the status synchronously and only then awaits, like the real one.
    disconnectFromUpstream: vi.fn(async (c: UpstreamConnection) => {
      c.status = "disconnected";
    }),
  };
});

import { ConnectServer, EXEC_ECHO_BUDGET_BYTES, toolCacheConfigKey } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

const ZERO_BYTES = { resultBytesUpstream: 0, resultBytesDownstream: 0 };
const DAY_MS = 24 * 60 * 60 * 1000;

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "1",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(
  namespace: string,
  tools: string[] = [],
  status: "connected" | "error" = "connected",
): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((name) => ({ name, namespacedName: `${namespace}_${name}`, inputSchema: { type: "object" } })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, ...ZERO_BYTES },
    status,
  } as UpstreamConnection;
}

const textOf = (result: { content: Array<{ text: string }> }): string => result.content.map((c) => c.text).join("\n");

let server: ConnectServer;
let priv: any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(disconnectFromUpstream).mockReset();
  server = new ConnectServer();
  priv = server as any;
  // No real 1 s sleep before the single activation retry.
  priv.activationRetryDelayMs = 0;
});

afterEach(async () => {
  await server.shutdown();
});

describe("overlapping teardowns of one connection", () => {
  it("both report the unload; neither claims the server was re-loaded", async () => {
    // Two teardowns holding the SAME connection (a deactivate arriving while
    // another is mid-close): the first forgets it, and the second used to
    // read the now-absent entry as "a newer connection holds the key".
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    priv.connections.set("gh", makeConnection("gh", ["get_me"]));

    const [first, second] = await Promise.all([priv.handleDeactivate(["gh"]), priv.handleDeactivate(["gh"])]);

    expect(priv.connections.has("gh")).toBe(false);
    expect(textOf(first)).toBe('Unloaded "gh". Tools removed from context.');
    expect(textOf(second)).toBe('Unloaded "gh". Tools removed from context.');
  });

  it("still reports a supersede when a DIFFERENT connection took the key during the close", async () => {
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    const old = makeConnection("gh", ["get_me"]);
    const fresh = makeConnection("gh", ["get_me"]);
    priv.connections.set("gh", old);
    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async (c: UpstreamConnection) => {
      c.status = "disconnected";
      priv.connections.set("gh", fresh);
    });

    const result = await priv.handleDeactivate(["gh"]);

    expect(textOf(result)).toContain("was re-loaded while it was being unloaded");
    expect(priv.connections.get("gh")).toBe(fresh);
  });
});

describe("a failed background revalidation", () => {
  it("is banked, so the next pre-warm does not spawn the same broken server again", async () => {
    const cfg = makeServerConfig({ namespace: "gh" });
    priv.config = { servers: [cfg], configVersion: "v1" };
    // Learned under the current config, but past the refresh window: a
    // revalidation candidate, not a cold learn.
    priv.hydrateToolCache({
      gh: { tools: [{ name: "get_me" }], learnedAt: Date.now() - 8 * DAY_MS, configKey: toolCacheConfigKey(cfg) },
    });
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("docker daemon not running"));

    await priv.prewarmDormantServers();

    const attempts = vi.mocked(connectToUpstream).mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    expect(priv.exportPrewarmFailures().gh?.message).toContain("docker daemon not running");
    // The served list is untouched by the failure.
    expect(priv.toolCache.get("gh")).toEqual([{ name: "get_me" }]);

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream).mock.calls.length).toBe(attempts);
  });
});

describe("inspection calls and the idle clock", () => {
  beforeEach(() => {
    priv.config = {
      servers: [makeServerConfig({ namespace: "gh" }), makeServerConfig({ id: "2", namespace: "slack" })],
      configVersion: "v1",
    };
    priv.connections.set("gh", makeConnection("gh", ["get_me"]));
    priv.connections.set("slack", makeConnection("slack", ["post"]));
    priv.rebuildRoutes();
    priv.idleCallCounts.set("gh", 3);
    priv.idleCallCounts.set("slack", 3);
  });

  it("read_tool on a loaded server credits it and ages the others", async () => {
    const result = await priv.handleToolCall("mcp_connect_read_tool", { server: "gh", tool: "get_me" });

    expect(result.isError).toBeUndefined();
    expect(priv.idleCallCounts.get("gh")).toBe(0);
    expect(priv.idleCallCounts.get("slack")).toBe(4);
  });

  it("a focused discover credits the loaded server it focuses on", async () => {
    await priv.handleToolCall("mcp_connect_discover", { server: "gh" });

    expect(priv.idleCallCounts.get("gh")).toBe(0);
    expect(priv.idleCallCounts.get("slack")).toBe(4);
  });

  it("an unfocused discover still ages every loaded server", async () => {
    await priv.handleToolCall("mcp_connect_discover", {});

    expect(priv.idleCallCounts.get("gh")).toBe(4);
    expect(priv.idleCallCounts.get("slack")).toBe(4);
  });
});

describe("discover with a blank server arg", () => {
  it.each(["", "   "])("treats server: %j as no focus and renders the listing", async (blank) => {
    priv.config = { servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })], configVersion: "v1" };

    for (const args of [{ server: blank }, { server: blank, listOnly: true }]) {
      const text = textOf(await priv.handleToolCall("mcp_connect_discover", args));
      expect(text).not.toContain("is not in");
      expect(text).toContain("gh");
      expect(text).toContain("GitHub");
    }
  });
});

describe("bundle gaps name the remedy each member needs", () => {
  // devops-incident is github + pagerduty + slack.
  it("match: a disabled member is enabled, not added", async () => {
    priv.config = {
      servers: [
        makeServerConfig({ namespace: "github" }),
        makeServerConfig({ id: "2", namespace: "pagerduty", isActive: false }),
      ],
      configVersion: "v1",
    };

    const text = textOf(await priv.handleToolCall("mcp_connect_bundles", { action: "match" }));
    const block = text.slice(text.indexOf("devops-incident"));
    const lines = block.split("\n").slice(0, 4).join("\n");

    expect(lines).toContain("missing: slack (add with: yaw-mcp add slack)");
    expect(lines).toContain("disabled: pagerduty (installed; enable with: yaw-mcp enable pagerduty)");
    expect(text).not.toContain("yaw-mcp add pagerduty");
  });

  it("match: a profile-blocked member is reported as blocked, not missing", async () => {
    priv.config = {
      servers: [makeServerConfig({ namespace: "github" }), makeServerConfig({ id: "2", namespace: "pagerduty" })],
      configVersion: "v1",
    };
    priv.profile = { path: "/p/.yaw-mcp.json", blocked: ["pagerduty"] };

    const text = textOf(await priv.handleToolCall("mcp_connect_bundles", { action: "match" }));

    expect(text).toContain("blocked: pagerduty (installed; not allowed by the project profile in effect)");
    expect(text).not.toContain("yaw-mcp add pagerduty");
    expect(text).not.toMatch(/missing: [^\n]*pagerduty/);
  });

  it("discover: the completions line separates add from enable", () => {
    priv.config = {
      servers: [
        makeServerConfig({ namespace: "github" }),
        makeServerConfig({ id: "2", namespace: "pagerduty", isActive: false }),
      ],
      configVersion: "v1",
    };

    const text = textOf(priv.handleDiscover());
    const line = text.split("\n").find((l: string) => l.includes("devops-incident —")) ?? "";

    expect(line).toContain("add: slack");
    expect(line).toContain("enable (installed, disabled): pagerduty");
    expect(line).not.toMatch(/add: [^;]*pagerduty/);
  });
});

describe("exec echo budget", () => {
  it("is measured in bytes, so multi-byte step output over the budget is not echoed", async () => {
    // 2,000 CJK characters: a UTF-16 length of ~2,000 (under the budget) but
    // ~6,000 UTF-8 bytes (over it).
    const wide = "漢".repeat(2000);
    expect(wide.length).toBeLessThan(EXEC_ECHO_BUDGET_BYTES);
    expect(Buffer.byteLength(wide, "utf8")).toBeGreaterThan(EXEC_ECHO_BUDGET_BYTES);
    const conn = makeConnection("gh", ["list_prs", "get_pr"]);
    conn.client.callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: wide }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PR body" }] });
    priv.connections.set("gh", conn);
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "a", tool: "gh_list_prs", args: {} },
        { id: "b", tool: "gh_get_pr", args: {} },
      ],
      return: "b",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.result).toBe("PR body");
    expect(parsed.stepKeys).toEqual(["a", "b"]);
    expect(parsed.steps).toBeUndefined();
  });
});

describe("activating over an error-state entry", () => {
  it("closes the connection the new one displaces", async () => {
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    const dead = makeConnection("gh", ["get_me"], "error");
    const fresh = makeConnection("gh", ["get_me"]);
    priv.connections.set("gh", dead);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(fresh);

    const result = await priv.activateOne("gh");

    expect(result.ok).toBe(true);
    expect(priv.connections.get("gh")).toBe(fresh);
    expect(vi.mocked(disconnectFromUpstream).mock.calls.map(([c]) => c)).toEqual([dead]);
    expect(fresh.status).toBe("connected");
  });

  it("closes nothing on a first activation", async () => {
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["get_me"]));

    expect((await priv.activateOne("gh")).ok).toBe(true);
    expect(disconnectFromUpstream).not.toHaveBeenCalled();
  });
});

describe("health tool list", () => {
  it("caps the names per loaded server, keeps the exact count, and still counts hidden blocked tools", () => {
    const names = Array.from({ length: 8 }, (_, i) => `tool_${i + 1}`);
    priv.profile = { path: "/h/.yaw-mcp/config.json", blockedTools: ["gh_tool_2", "gh_tool_7"] };
    priv.connections.set("gh", makeConnection("gh", names));

    const text = textOf(priv.handleHealth());

    expect(text).toContain("tools: 8 — tool_1, tool_2 [blocked], tool_3, tool_4, tool_5 (+3 more, 1 [blocked])");
    expect(text).not.toContain("tool_6");
    expect(text).toContain('call mcp_connect_discover(server: "<namespace>") for one server\'s full list.');
  });

  it("prints a short list in full, with no footer", () => {
    priv.connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));

    const text = textOf(priv.handleHealth());

    expect(text).toContain("tools: 2 — create_issue, list_prs");
    expect(text).not.toContain("Tool lists show the first");
  });
});
