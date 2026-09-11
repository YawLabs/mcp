// YAW_MCP_PREWARM -- the opt-out for the startup pre-warm, and the two
// deliberate behaviours it exists to give users a way out of.
//
// Pre-warm learns a dormant server's tool list by spawning it and throwing
// the child away, so a session that LEARNS a server runs that server's
// startup twice: once here, once for the activate that follows. Rare rather
// than per-session -- the learned list persists and is re-learned only once
// it ages out -- but rare is not never. Idempotent startups do not
// care. One that takes a lock, binds a port, opens a DB session or writes a
// login audit event performs that side effect twice, and nothing used to let
// such a user decline. The second behaviour is a consequence of the same
// spawn: pre-warm is exempt from the concurrent-server cap in both
// directions (the cap bounds ADVERTISED servers, i.e. the model's context --
// see server-cap.ts), so a first session briefly runs more child processes
// than the cap allows loaded servers, including one the cap will refuse.
//
// Both are by design and stay the default. The tests below pin the design as
// well as the opt-out, so a future change that quietly stops pre-warming --
// and with it the "I enabled a server and its tools never showed up" fix
// pre-warm exists for -- fails here rather than in a user's session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn(),
  };
});
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { log } from "../logger.js";
import { ConnectServer, isPrewarmEnabled } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

const ZERO_BYTES = { resultBytesUpstream: 0, resultBytesDownstream: 0 };

function makeServerConfig(namespace: string): UpstreamServerConfig {
  return {
    id: namespace,
    name: namespace,
    namespace,
    type: "local",
    command: "echo",
    isActive: true,
  } as UpstreamServerConfig;
}

function makeConnection(namespace: string): UpstreamConnection {
  return {
    config: makeServerConfig(namespace),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: [{ name: "t", namespacedName: `${namespace}_t`, inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, ...ZERO_BYTES },
    status: "connected",
  } as UpstreamConnection;
}

let server: ConnectServer;
let priv: any;
// Live upstream CHILDREN, tracked the way the cap does not: +1 per spawn,
// -1 per close. The over-cap spike is what shows up in peakLive.
let live = 0;
let peakLive = 0;
let spawns: Record<string, number>;

beforeEach(() => {
  vi.clearAllMocks();
  live = 0;
  peakLive = 0;
  spawns = {};
  server = new ConnectServer();
  priv = server as any;
  (connectToUpstream as any).mockImplementation(async (cfg: UpstreamServerConfig) => {
    spawns[cfg.namespace] = (spawns[cfg.namespace] ?? 0) + 1;
    live += 1;
    peakLive = Math.max(peakLive, live);
    // A real handshake is not synchronous; without a turn of the event loop
    // the concurrent batch below would never actually overlap and the peak
    // would read 1 no matter what the code did.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return makeConnection(cfg.namespace);
  });
  (disconnectFromUpstream as any).mockImplementation(async () => {
    live -= 1;
  });
});

afterEach(async () => {
  await server.shutdown();
  vi.unstubAllEnvs();
});

describe("isPrewarmEnabled", () => {
  // The convention YAW_MCP_AUTO_UPGRADE and YAW_MCP_CONFIG_RELOAD set: two
  // off spellings, everything else on.
  it.each(["0", "false", "False", "FALSE"])("is off for %j", (value) => {
    vi.stubEnv("YAW_MCP_PREWARM", value);
    expect(isPrewarmEnabled()).toBe(false);
  });

  // cmd.exe's `set VAR=0 && yaw-mcp serve` delivers "0 ", trailing space and
  // all. A check that did not trim would ignore the opt-out on Windows --
  // silently, since the var reads as set everywhere the user can see it.
  it.each(["0 ", " 0", " false "])("is off for the padded spelling %j", (value) => {
    vi.stubEnv("YAW_MCP_PREWARM", value);
    expect(isPrewarmEnabled()).toBe(false);
  });

  // Including "00" and "0abc": near-misses stay ON. An opt-out that engaged
  // on anything vaguely zero-ish would turn a typo into an invisible loss of
  // the feature, which is the wrong direction to fail in.
  it.each(["1", "true", "", "00", "0abc", "no", "off"])("stays on for %j", (value) => {
    vi.stubEnv("YAW_MCP_PREWARM", value);
    expect(isPrewarmEnabled()).toBe(true);
  });

  it("stays on when the variable is not set at all", () => {
    vi.stubEnv("YAW_MCP_PREWARM", undefined as unknown as string);
    expect(isPrewarmEnabled()).toBe(true);
  });
});

describe("prewarmDormantServers -- YAW_MCP_PREWARM=0", () => {
  it("spawns nothing, and says so", async () => {
    vi.stubEnv("YAW_MCP_PREWARM", "0");
    priv.config = { servers: [makeServerConfig("gh"), makeServerConfig("db")], configVersion: "v1" };

    await priv.prewarmDormantServers();

    expect(connectToUpstream).not.toHaveBeenCalled();
    // Not silent: with pre-warm off, a server the user just enabled shows
    // none of its tools until they activate it, and this line is the only
    // thing connecting that surprise to the variable they set.
    const said = (log as any).mock.calls.filter((c: unknown[]) => String(c[1]).includes("YAW_MCP_PREWARM"));
    expect(said).toHaveLength(1);
  });

  it("declines before it even scans for dormant servers", async () => {
    vi.stubEnv("YAW_MCP_PREWARM", "0");
    priv.config = { servers: [makeServerConfig("gh")], configVersion: "v1" };
    const scan = vi.spyOn(priv, "getProfiledActiveServers");

    await priv.prewarmDormantServers();

    // "Off" means do nothing, not "scan, then decline".
    expect(scan).not.toHaveBeenCalled();
  });

  it("still pre-warms by default", async () => {
    // The inverted-gate guard. Without this, flipping the condition would
    // leave every assertion above green while silently disabling pre-warm
    // for everyone.
    vi.stubEnv("YAW_MCP_PREWARM", undefined as unknown as string);
    priv.config = { servers: [makeServerConfig("gh")], configVersion: "v1" };

    await priv.prewarmDormantServers();

    expect(spawns).toEqual({ gh: 1 });
    expect(priv.toolCache.get("gh")).toEqual([{ name: "t", description: undefined }]);
  });
});

describe("the first-session double spawn", () => {
  it("starts each server twice on a cold cache, and once with the opt-out", async () => {
    const namespaces = ["s1", "s2", "s3"];
    priv.config = { servers: namespaces.map(makeServerConfig), configVersion: "v1" };

    // Default: pre-warm learns the tools and discards the child, then the
    // explicit activate the client makes starts the server for real.
    await priv.prewarmDormantServers();
    for (const ns of namespaces) {
      expect((await priv.activateOne(ns)).ok).toBe(true);
    }
    expect(spawns).toEqual({ s1: 2, s2: 2, s3: 2 });

    // The same session shape with the opt-out: one startup per server, which
    // is the whole point of offering it to a non-idempotent upstream.
    await server.shutdown();
    vi.stubEnv("YAW_MCP_PREWARM", "0");
    server = new ConnectServer();
    priv = server as any;
    spawns = {};
    priv.config = { servers: namespaces.map(makeServerConfig), configVersion: "v1" };

    await priv.prewarmDormantServers();
    for (const ns of namespaces) {
      expect((await priv.activateOne(ns)).ok).toBe(true);
    }
    expect(spawns).toEqual({ s1: 1, s2: 1, s3: 1 });
  });
});

describe("the concurrent-server cap bounds loaded servers, not child processes", () => {
  it("pre-warms a server the cap would refuse, and refuses it anyway", async () => {
    const namespaces = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    priv.config = { servers: namespaces.map(makeServerConfig), configVersion: "v1" };
    priv.serverCap = 6;

    // start() fires pre-warm and does not await it, so the client's
    // activations land while it is still running.
    const prewarming = priv.prewarmDormantServers();
    const activated: Record<string, boolean> = {};
    for (const ns of namespaces) {
      activated[ns] = (await priv.activateOne(ns)).ok;
    }
    await prewarming;

    // The cap did its job: the seventh server is not loaded and advertises
    // nothing.
    expect(activated.s7).toBe(false);
    // ...and its process ran anyway, briefly, because pre-warm is exempt.
    // Seven live children under a cap of six. Deliberate -- the cap defends
    // the model's context, and a pre-warm child advertises nothing and is
    // closed within milliseconds -- but it is the reason a user who needs
    // the PROCESS count bounded has to turn pre-warm off rather than lower
    // the cap.
    expect(spawns.s7).toBe(1);
    expect(peakLive).toBeGreaterThan(priv.serverCap);
  });

  it("never exceeds the cap with the opt-out set", async () => {
    vi.stubEnv("YAW_MCP_PREWARM", "0");
    const namespaces = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    priv.config = { servers: namespaces.map(makeServerConfig), configVersion: "v1" };
    priv.serverCap = 6;

    const prewarming = priv.prewarmDormantServers();
    const activated: Record<string, boolean> = {};
    for (const ns of namespaces) {
      activated[ns] = (await priv.activateOne(ns)).ok;
    }
    await prewarming;

    expect(activated.s7).toBe(false);
    expect(spawns.s7).toBeUndefined();
    expect(peakLive).toBe(priv.serverCap);
  });
});
