// Prewarm teardown safety + gateway advertise-growth notifications.
//
// Two interlocking regressions around the prewarm/activate/advertise path:
//
// 1. prewarmDormantServers put already-connected namespaces (auto-loaded
//    recurring-pack members, early explicit activates with a stale learned
//    cache) into its dormant list; activateOne(fromPrewarm) then hit
//    runActivateOne's already-connected early return (ok:true,
//    isChanged:false) AFTER prewarmNamespaces.add, and the teardown --
//    gated only on prewarmNamespaces membership -- disconnected a LIVE
//    connection prewarm never spawned.
//
// 2. handleActivate/handleDispatch/discover recorded an already-connected
//    winner in sessionActivated (growing the gateway-advertised surface)
//    but only notified on isChanged, so a list_changed-driven client never
//    learned the "now callable" tools exist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process boundary before importing the module under test.
vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

function makeConfig(servers: UpstreamServerConfig[]) {
  return { servers, configVersion: "v1" };
}

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

function makeConnection(namespace: string, tools: string[] = []): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
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

const EIGHT_DAYS_AGO = () => Date.now() - 8 * 24 * 60 * 60 * 1000;

let server: ConnectServer;
let priv: any;

beforeEach(() => {
  vi.clearAllMocks();
  server = new ConnectServer();
  priv = getPrivate(server);
});

afterEach(async () => {
  await server.shutdown();
});

describe("prewarmDormantServers -- teardown safety", () => {
  it("never lists an already-connected namespace as dormant, even with a stale learned cache", async () => {
    // The auto-load shape: a recurring-pack member connected at startup
    // whose learned toolCache is past the 7-day refresh window. Before the
    // connected-check it landed in the dormant list, and prewarm then
    // disconnected the live connection it never spawned.
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    const live = makeConnection("gh", ["create_issue"]);
    priv.connections.set("gh", live);
    priv.toolCache.set("gh", [{ name: "create_issue" }]);
    priv.toolCacheLearnedAt.set("gh", EIGHT_DAYS_AGO());

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
    expect(priv.connections.get("gh")).toBe(live);
  });

  it("leaves a connection alive that appeared between the dormant snapshot and its batch turn", async () => {
    // The residual race the isChanged gate covers: the dormant list is
    // snapshotted once, batches run 3 at a time, and a namespace in a
    // LATER batch can get connected (auto-load, explicit activate) while
    // batch 1 is in flight. Prewarm's activateOne then hits the
    // already-connected early return (ok:true, isChanged:false) after
    // registering its prewarm claim -- and must NOT tear down the live
    // connection it did not create.
    priv.config = makeConfig([
      makeServerConfig({ id: "a", namespace: "a", name: "A" }),
      makeServerConfig({ id: "b", namespace: "b", name: "B" }),
      makeServerConfig({ id: "c", namespace: "c", name: "C" }),
      makeServerConfig({ id: "d", namespace: "d", name: "D" }),
    ]);
    const liveD = makeConnection("d", ["d_tool"]);
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "a") {
        // Simulate a connection for "d" landing while batch 1 is in flight.
        priv.connections.set("d", liveD);
      }
      return makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]);
    });

    await priv.prewarmDormantServers();

    // Batch 1 (a, b, c) was spawned and torn down normally; "d" was never
    // spawned and its live connection survived.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(3);
    expect(priv.connections.get("d")).toBe(liveD);
    const disconnected = vi.mocked(disconnectFromUpstream).mock.calls.map((c) => c[0]);
    expect(disconnected).not.toContain(liveD);
    // The prewarm claim registered for "d" was cleaned up, not leaked.
    expect(priv.prewarmNamespaces.size).toBe(0);
  });
});

describe("gateway advertise growth -- notify without a connection change", () => {
  it("handleActivate notifies when an already-connected namespace is newly advertised", async () => {
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
    const notify = vi.spyOn(priv, "notifyAllListsChanged").mockResolvedValue(undefined);
    const refresh = vi.spyOn(priv, "refreshRoutesAndNotify").mockResolvedValue(undefined);

    const result = await priv.handleActivate(["gh"]);

    // The winner was already connected (isChanged:false) so no route
    // rebuild -- but the advertised surface grew and the client must be
    // told to re-list or the "now callable" tools stay invisible.
    expect(result.isError).toBeUndefined();
    expect(priv.sessionActivated.has("gh")).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);

    // Re-activating an already-advertised namespace moves nothing --
    // no spurious list_changed.
    await priv.handleActivate(["gh"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("handleDispatch notifies when an already-connected winner is newly advertised", async () => {
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
    priv.twoStageRank = async () => [{ namespace: "gh", score: 5 }];
    const notify = vi.spyOn(priv, "notifyAllListsChanged").mockResolvedValue(undefined);
    const refresh = vi.spyOn(priv, "refreshRoutesAndNotify").mockResolvedValue(undefined);

    const result = await priv.handleDispatch("github issue", 1);

    expect(result.content[0].text).toContain("already loaded");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(priv.sessionActivated.has("gh")).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);

    // Second dispatch to the same, now-advertised winner: no growth, no
    // notification.
    await priv.handleDispatch("github issue", 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("discover auto-warm advertises and names an already-connected winner, notifying only on growth", async () => {
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
    priv.twoStageRank = async () => [{ namespace: "gh", score: 5 }];
    const notify = vi.spyOn(priv, "notifyAllListsChanged").mockResolvedValue(undefined);

    const first = await priv.handleDiscoverWithAutoWarm("github issue");

    // One-shot promise: the intent-driven winner is advertised and the
    // banner names it even though nothing needed spawning.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(priv.sessionActivated.has("gh")).toBe(true);
    expect(first.content[0].text).toContain('Auto-loaded "gh"');
    expect(notify).toHaveBeenCalledTimes(1);

    // Already advertised: the banner still names the match, but the
    // advertised surface did not move, so no second list_changed.
    const second = await priv.handleDiscoverWithAutoWarm("github issue");
    expect(second.content[0].text).toContain('Auto-loaded "gh"');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
