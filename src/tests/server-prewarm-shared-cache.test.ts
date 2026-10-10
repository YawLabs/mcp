// Pre-warm across many brokers. Every Claude Code / typed pane starts its own
// yaw-mcp, and each one pre-warms at startup. These pin the two things that
// keep a new pane's broker from re-listing (or re-failing) a server another
// broker already dealt with:
//
//   * a learned list carries the launch-config fingerprint it was learned
//     under, so it is trusted while the config is unchanged and re-learned the
//     moment the config moves (a pinned version, an image tag, a flag);
//   * a FAILED pre-warm is recorded, so the next broker skips the same doomed
//     spawn (Docker daemon down, a declined credential prompt) for the backoff
//     window -- unless the config changed -- and discover says why the tools
//     are missing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { PREWARM_FAILURE_BACKOFF_MS } from "../persistence.js";
import { ConnectServer, toolCacheConfigKey } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream } from "../upstream.js";

const ZERO_BYTES = { resultBytesUpstream: 0, resultBytesDownstream: 0 };
const V2_ARGS = ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server:v2"];
// Built at runtime so no literal token shape sits in the source.
const FAKE_TOKEN = ["ghp", "Z".repeat(36)].join("_");

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "1",
    name: "GitHub",
    namespace: "gh",
    type: "local",
    command: "docker",
    args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server:v1"],
    isActive: true,
    ...overrides,
  };
}

function makeConnection(namespace: string, tools: string[], version?: string): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace }),
    client: {
      callTool: vi.fn(),
      close: vi.fn(),
      getServerVersion: () => (version === undefined ? undefined : { name: namespace, version }),
    } as any,
    transport: {} as any,
    tools: tools.map((name) => ({ name, namespacedName: `${namespace}_${name}`, inputSchema: { type: "object" } })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, ...ZERO_BYTES },
    status: "connected",
  } as UpstreamConnection;
}

let server: ConnectServer;
let priv: any;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset implementations too: a Once value a failing test never consumed
  // must not leak into the next one.
  vi.mocked(connectToUpstream).mockReset();
  server = new ConnectServer();
  priv = server as any;
  // No real 1 s sleep before the single activation retry.
  priv.activationRetryDelayMs = 0;
});

afterEach(async () => {
  await server.shutdown();
});

describe("toolCacheConfigKey", () => {
  it("moves with what decides the tool list and ignores env/header VALUES", () => {
    const base = makeServerConfig({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "value-one" } });
    const key = toolCacheConfigKey(base);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    // A rotated credential is not a different server, and must not be
    // hashed into state.json at all.
    expect(toolCacheConfigKey({ ...base, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "value-two" } })).toBe(key);
    // Presentation and ranking metadata do not move it either.
    expect(toolCacheConfigKey({ ...base, name: "Renamed", description: "x" })).toBe(key);
    // What the list depends on does.
    expect(toolCacheConfigKey({ ...base, args: V2_ARGS })).not.toBe(key);
    expect(toolCacheConfigKey({ ...base, env: { ...base.env, GITHUB_TOOLSETS: "repos" } })).not.toBe(key);
    expect(toolCacheConfigKey({ ...base, runtime: "node" })).not.toBe(key);
  });
});

describe("learned list fingerprint", () => {
  it("trusts a fresh list learned under the CURRENT config (no spawn)", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydrateToolCache({
      gh: { tools: [{ name: "get_me" }], learnedAt: Date.now(), configKey: toolCacheConfigKey(cfg) },
    });

    await priv.prewarmDormantServers();

    expect(connectToUpstream).not.toHaveBeenCalled();
  });

  it("re-learns a fresh list whose config changed since (a new image tag)", async () => {
    const old = makeServerConfig();
    const cfg = makeServerConfig({ args: V2_ARGS });
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydrateToolCache({
      gh: { tools: [{ name: "old_tool" }], learnedAt: Date.now(), configKey: toolCacheConfigKey(old) },
    });
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["get_me"], "2.0.0"));

    await priv.prewarmDormantServers();

    expect(connectToUpstream).toHaveBeenCalledTimes(1);
    expect(priv.toolCache.get("gh")).toEqual([{ name: "get_me", description: undefined }]);
    // The new list carries the new fingerprint and the upstream's version.
    expect(priv.exportToolCache().gh).toMatchObject({ configKey: toolCacheConfigKey(cfg), serverVersion: "2.0.0" });
  });

  it("keeps trusting a legacy entry with no fingerprint until it ages out", async () => {
    priv.config = { servers: [makeServerConfig()], configVersion: "v1" };
    priv.hydrateToolCache({ gh: { tools: [{ name: "get_me" }], learnedAt: Date.now() } });

    await priv.prewarmDormantServers();

    expect(connectToUpstream).not.toHaveBeenCalled();
  });
});

describe("persisted pre-warm failures", () => {
  it("records a failed pre-warm with the config it failed under, scrubbed", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    vi.mocked(connectToUpstream).mockRejectedValue(
      new Error(`docker: error during connect: daemon not running; token ${FAKE_TOKEN}`),
    );

    await priv.prewarmDormantServers();

    const failures = priv.exportPrewarmFailures();
    expect(failures.gh.configKey).toBe(toolCacheConfigKey(cfg));
    expect(failures.gh.message).toContain("daemon not running");
    expect(failures.gh.message).not.toContain(FAKE_TOKEN);
  });

  it("a second broker skips a server another broker failed to pre-warm moments ago", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydratePrewarmFailures({
      gh: { failedAt: Date.now() - 60_000, configKey: toolCacheConfigKey(cfg), message: "daemon not running" },
    });

    await priv.prewarmDormantServers();

    expect(connectToUpstream).not.toHaveBeenCalled();
    // find_tool's "wait for pre-warm" must not wait on a server it skips.
    expect(priv.prewarmStillLearning()).toBe(false);
  });

  it("retries at once when the config changed since the failure", async () => {
    const old = makeServerConfig();
    priv.config = { servers: [makeServerConfig({ args: V2_ARGS })], configVersion: "v1" };
    priv.hydratePrewarmFailures({ gh: { failedAt: Date.now(), configKey: toolCacheConfigKey(old), message: "m" } });
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["get_me"]));

    await priv.prewarmDormantServers();

    expect(connectToUpstream).toHaveBeenCalledTimes(1);
    expect(priv.exportPrewarmFailures()).toEqual({});
  });

  it("retries once the backoff has elapsed", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydratePrewarmFailures({
      gh: {
        failedAt: Date.now() - PREWARM_FAILURE_BACKOFF_MS - 1000,
        configKey: toolCacheConfigKey(cfg),
        message: "m",
      },
    });
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["get_me"]));

    await priv.prewarmDormantServers();

    expect(connectToUpstream).toHaveBeenCalledTimes(1);
  });

  it("an explicit activate is never gated by the backoff, and success clears the failure", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydratePrewarmFailures({ gh: { failedAt: Date.now(), configKey: toolCacheConfigKey(cfg), message: "m" } });
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["get_me"]));

    const result = await priv.activateOne("gh");

    expect(result.ok).toBe(true);
    expect(priv.exportPrewarmFailures()).toEqual({});
  });

  it("discover says why a backed-off server has no tool names, and how to retry", () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydratePrewarmFailures({
      gh: { failedAt: Date.now() - 5 * 60_000, configKey: toolCacheConfigKey(cfg), message: "daemon not running" },
    });

    const text = priv
      .handleDiscover()
      .content.map((c: { text: string }) => c.text)
      .join("\n");

    expect(text).toContain(
      "warn: tools unknown, startup pre-warm failed 5m ago: daemon not running; activate it to retry",
    );
  });

  it("discover flags a served list as possibly stale when its config-changed re-learn is backed off", () => {
    const old = makeServerConfig();
    const cfg = makeServerConfig({ args: V2_ARGS });
    priv.config = { servers: [cfg], configVersion: "v1" };
    priv.hydrateToolCache({
      gh: { tools: [{ name: "old_tool" }], learnedAt: Date.now(), configKey: toolCacheConfigKey(old) },
    });
    priv.hydratePrewarmFailures({
      gh: { failedAt: Date.now() - 5 * 60_000, configKey: toolCacheConfigKey(cfg), message: "no such image" },
    });

    const text = priv
      .handleDiscover()
      .content.map((c: { text: string }) => c.text)
      .join("\n");

    expect(text).toContain(
      "warn: tools listed may be stale (learned under a previous config); re-learn failed 5m ago: no such image; activate it to retry",
    );
    // The sweep will not spawn it, so nothing waits on it.
    expect(priv.prewarmStillLearning()).toBe(false);
  });

  it("a shutdown mid-sweep is a refusal, not the server's failure: nothing is banked for other panes", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
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

  it("a thrown activation releases the pre-warm claim and is recorded as a failure", async () => {
    const cfg = makeServerConfig();
    priv.config = { servers: [cfg], configVersion: "v1" };
    // activateOne takes the claim, then runActivateOne throws past every
    // `!result.ok` branch straight into the sweep's catch.
    priv.runActivateOne = vi.fn().mockRejectedValue(new Error("elicitation transport closed"));

    await priv.prewarmDormantServers();

    // The claim must not outlive the attempt: left behind, evaluateCapFor
    // would skip this namespace's slot for the rest of the session.
    expect(priv.prewarmNamespaces.has("gh")).toBe(false);
    expect(priv.activationInflight.has("gh")).toBe(false);
    expect(priv.exportPrewarmFailures().gh?.message).toBe("elicitation transport closed");
  });

  it("a spawn-gate refusal (disabled entry) is not banked as a failure either", async () => {
    const cfg = makeServerConfig({ isActive: false });
    priv.config = { servers: [cfg], configVersion: "v1" };

    const result = await priv.activateOne("gh", undefined, true);

    expect(result.ok).toBe(false);
    expect(result.refused).toBe(true);
    expect(connectToUpstream).not.toHaveBeenCalled();
  });
});
