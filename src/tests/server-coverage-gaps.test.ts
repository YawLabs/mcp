// Coverage gaps in server.ts that the main suite left open: a refused or
// thrown background revalidation of a learned tool list, the fire-and-forget
// close of a displaced error-state connection, discover's pre-warm warning
// for an aged-but-valid list, and bundle remedies when every missing member
// is installed but disabled.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn(async (c: UpstreamConnection) => {
      c.status = "disconnected";
    }),
  };
});

import { ConnectServer, toolCacheConfigKey } from "../server.js";
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
  vi.mocked(disconnectFromUpstream).mockImplementation(async (c: UpstreamConnection) => {
    c.status = "disconnected";
  });
  server = new ConnectServer();
  priv = server as any;
  // No real 1 s sleep before the single activation retry.
  priv.activationRetryDelayMs = 0;
});

afterEach(async () => {
  await server.shutdown();
});

/** gh configured, with a list learned under the current config but past the
 *  refresh window: a revalidation candidate, not a cold learn. */
function seedAgedGhList(): UpstreamServerConfig {
  const cfg = makeServerConfig({ namespace: "gh" });
  priv.config = { servers: [cfg], configVersion: "v1" };
  priv.hydrateToolCache({
    gh: { tools: [{ name: "get_me" }], learnedAt: Date.now() - 8 * DAY_MS, configKey: toolCacheConfigKey(cfg) },
  });
  return cfg;
}

describe("background revalidation of an aged learned list", () => {
  it("a shutdown mid-revalidation is a refusal and banks no pre-warm failure", async () => {
    seedAgedGhList();
    let release: () => void = () => {};
    vi.mocked(connectToUpstream).mockImplementationOnce(
      () =>
        new Promise<UpstreamConnection>((resolve) => {
          release = () => resolve(makeConnection("gh", ["get_me"]));
        }),
    );

    const sweep = priv.prewarmDormantServers();
    await vi.waitFor(() => expect(connectToUpstream).toHaveBeenCalledTimes(1));
    const closing = server.shutdown();
    release();
    await Promise.all([sweep, closing]);

    expect(priv.exportPrewarmFailures()).toEqual({});
  });

  it("a thrown revalidation is banked, keeps the served list, and is not retried by the next sweep", async () => {
    seedAgedGhList();
    priv.runActivateOne = vi.fn().mockRejectedValue(new Error("elicitation transport closed"));

    await priv.prewarmDormantServers();

    const attempts = priv.runActivateOne.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    expect(priv.exportPrewarmFailures().gh?.message).toBe("elicitation transport closed");
    expect(priv.toolCache.get("gh")).toEqual([{ name: "get_me" }]);

    await priv.prewarmDormantServers();

    expect(priv.runActivateOne.mock.calls.length).toBe(attempts);
  });
});

describe("activating over an error-state entry whose close never finishes", () => {
  it("does not wait for the displaced connection's close", async () => {
    priv.config = { servers: [makeServerConfig({ namespace: "gh" })], configVersion: "v1" };
    const dead = makeConnection("gh", ["get_me"], "error");
    const fresh = makeConnection("gh", ["get_me"]);
    priv.connections.set("gh", dead);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(fresh);
    vi.mocked(disconnectFromUpstream).mockImplementationOnce(() => new Promise<void>(() => {}));

    let sentinel: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      priv.activateOne("gh"),
      new Promise((resolve) => {
        sentinel = setTimeout(() => resolve("still waiting on the close"), 1000);
      }),
    ]);
    clearTimeout(sentinel);

    expect(outcome).toMatchObject({ ok: true });
    expect(priv.connections.get("gh")).toBe(fresh);
    expect(vi.mocked(disconnectFromUpstream).mock.calls[0]?.[0]).toBe(dead);
  });
});

describe("discover with an aged-but-valid list and a banked failure", () => {
  it("lists the learned tools and prints no pre-warm failure warning", () => {
    const cfg = seedAgedGhList();
    priv.hydratePrewarmFailures({
      gh: { failedAt: Date.now() - 5 * 60_000, configKey: toolCacheConfigKey(cfg), message: "daemon not running" },
    });

    const text = textOf(priv.handleDiscover());

    expect(text).toContain("get_me");
    expect(text).not.toContain("startup pre-warm failed");
    expect(text).not.toContain("may be stale");
    expect(text).not.toContain("daemon not running");
  });
});

describe("a bundle whose missing members are all installed but disabled", () => {
  // devops-incident is github + pagerduty + slack.
  beforeEach(() => {
    priv.config = {
      servers: [
        makeServerConfig({ namespace: "github" }),
        makeServerConfig({ id: "2", namespace: "pagerduty", isActive: false }),
        makeServerConfig({ id: "3", namespace: "slack", isActive: false }),
      ],
      configVersion: "v1",
    };
  });

  it("match: prints the enable remedy and no missing/add line", async () => {
    const text = textOf(await priv.handleToolCall("mcp_connect_bundles", { action: "match" }));
    // The devops-incident entry runs until the next bundle's header line.
    const block = text.slice(text.indexOf("devops-incident"));
    const end = block.search(/\n {2}\S/);
    const entry = end === -1 ? block : block.slice(0, end);

    expect(entry).toContain(
      "disabled: pagerduty, slack (installed; enable with: yaw-mcp enable pagerduty && yaw-mcp enable slack)",
    );
    expect(entry).not.toContain("missing:");
    expect(entry).not.toContain("yaw-mcp add");
  });

  it("discover: the completions line has no add part", () => {
    const text = textOf(priv.handleDiscover());
    const line = text.split("\n").find((l: string) => l.includes("devops-incident —")) ?? "";

    expect(line).toContain("enable (installed, disabled): pagerduty, slack");
    expect(line).not.toContain("add:");
  });
});
