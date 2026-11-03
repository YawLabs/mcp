import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// mcp_connect_dispatch + auto-warm discover coverage — server.ts
//
// NOT the CLI dispatcher, despite the file name. This sits between
// cli-dispatch.test.ts and index-dispatch.test.ts, which both cover argv
// routing in src/index.ts; the shared "dispatch" across the three names is
// a collision, not a family. What this file exercises is the MCP TOOL
// `mcp_connect_dispatch` and its sibling `mcp_connect_discover` — two
// handlers on ConnectServer in server.ts. Nothing below touches argv,
// process.exit, a subcommand, or the built CLI.
//
// Exercises the BM25-ranked routing surface:
//   mcp_connect_dispatch(intent, budget) — rank + activate top-N
//   mcp_connect_discover(context)        — auto-warm a decisive winner
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { queryCoverage } from "../relevance.js";
import {
  AUTO_ACTIVATE_COVERAGE_MIN_SERVERS,
  AUTO_ACTIVATE_MARGIN_BM25,
  AUTO_ACTIVATE_MIN_COVERAGE,
  ConnectServer,
  clientRelistsTools,
  DISPATCH_LOW_COVERAGE_MARGIN,
  DISPATCH_MAX_FALLBACKS,
  dispatchConfidenceNote,
  pickAutoWarmWinner,
  type RoutingCandidate,
} from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "../upstream.js";

// The result-byte counters every ConnectionHealth carries (types.ts). Spelled
// once, and spread into the fixtures below, so the health literals in this file
// stay about the thing each test is actually asserting.
const ZERO_BYTES = { resultBytesUpstream: 0, resultBytesDownstream: 0 };

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
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, ...ZERO_BYTES },
    status,
  } as UpstreamConnection;
}

function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("handleDispatch", () => {
  let server: ConnectServer;

  beforeEach(() => {
    // reset, not clear. clearAllMocks wipes call records but LEAVES
    // implementations in place, so the mockRejectedValue set in "surfaces
    // the ActivationError message" survived into every later test that did
    // not overwrite connectToUpstream itself -- a latent order dependence
    // that only stays green because the tests after it happen to set their
    // own. Reset also drops the mockResolvedValue the vi.mock factory gave
    // disconnectFromUpstream, so re-arm it here: afterEach's
    // server.shutdown() awaits it.
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
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

  it("errors when no servers are configured, naming the local add path", async () => {
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: [] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers installed");
    // dispatch is the documented FIRST call, so this is the fresh-install
    // path. The hosted add UI at yaw.sh/mcp it used to point at is gone
    // (control plane retired); the CLI that works and where its result
    // lands are the answer. Same text as discover's empty state, so the two
    // cannot drift apart again.
    expect(text).toContain("yaw-mcp add <slug>");
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    expect(text).not.toContain("Add servers at yaw.sh/mcp");
    expect(text).toEqual(priv.handleDiscover().content[0].text);
  });

  it("errors when every installed server is disabled, naming the bundles.json toggle", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })],
    };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers enabled");
    // "Enable servers at yaw.sh/mcp" named a hosted toggle that no longer
    // exists; the fix is a local edit.
    expect(text).toContain('"isActive": true');
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    expect(text).not.toContain("yaw.sh/mcp");
  });

  it("names the blocked namespace and the profile's allow list when the profile keeps every server out", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })],
    };
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["linear"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers enabled");
    expect(text).toContain("project profile at /proj/.yaw-mcp/config.json");
    expect(text).toContain('add "gh" to its "servers" allow list');
    // gh is already active. The old text sent the model to bundles.json to
    // flip a toggle that was already on, and to discover's disabled list,
    // where a profile-blocked server never appears.
    expect(text).not.toContain('"isActive": true');
    expect(text).not.toContain("installed but disabled");
    expect(text).not.toContain("yaw.sh/mcp");
  });

  it("points a block-listed namespace at the profile's blocked list, not its allow list", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })],
    };
    // An explicit "blocked" entry wins over the allow list (isAllowed), so
    // adding gh to "servers" would change nothing -- the edit is the removal.
    priv.profile = { path: "/proj/.yaw-mcp/config.json", blocked: ["gh"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("project profile at /proj/.yaw-mcp/config.json");
    expect(text).toContain('remove "gh" from its "blocked" list');
    expect(text).not.toContain("allow list");
    expect(text).not.toContain('"isActive": true');
  });

  it("names BOTH config files for a block-list edit when a user-global profile is layered under the project one", async () => {
    // `blocked` is the UNION across scopes (config-loader's unionBlocked)
    // while profile.path is only the primary file, so the entry that keeps
    // the server out can live in the user-global config. Naming just the
    // project file sent the model to edit a file with no "blocked" list in
    // it -- it adds one there, nothing changes, and the server stays
    // invisible.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })],
    };
    priv.profile = {
      path: "/proj/.yaw-mcp/config.json",
      userPath: "/h/.yaw-mcp/config.json",
      blocked: ["gh"],
    };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("/proj/.yaw-mcp/config.json");
    expect(text).toContain("/h/.yaw-mcp/config.json");
    expect(text).toContain("blocked lists merge across scopes");
  });

  it("names both fixes when one server is disabled and another is profile-blocked", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack", isActive: false }),
      ],
    };
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["linear"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('add "gh" to its "servers" allow list');
    expect(text).toContain('"isActive": true');
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    // slack is disabled, not profile-blocked: the profile sentence must not
    // name it, or the model edits the profile for a server bundles.json is
    // keeping out.
    expect(text).not.toContain('"slack"');
  });

  it("errors when no installed server matches the intent, pointing at the catalog + CLI", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("xylophone orchestration", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/No installed server matches/);
    // Same migration as the two empty states above: the browsable catalog
    // plus the CLI, not the retired hosted add flow.
    expect(text).toContain("https://yaw.sh/mcp/catalog/");
    expect(text).toContain("yaw-mcp add <slug>");
    expect(text).not.toContain("add a relevant server at yaw.sh/mcp");
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

  it("a fractional budget resolves to ONE winner and still reaches the sampling-tiebreak gate", async () => {
    // The gate keys on the CLAMPED budget: 1.5 (or 0, or 0.5) yields
    // exactly one primary, so the single-winner tiebreak must fire for it.
    // The old `budget === 1` test on the RAW value silently skipped the
    // tiebreak that exists precisely for the single-primary case. Two
    // servers with identical matched terms tie the BM25 scores, so
    // shouldSample("auto") fires. The client advertises sampling (the gate
    // now checks that first -- see the sibling below) but its createMessage
    // fails, so bestOfNViaSampling returns null and the ranker order stands
    // -- the observable is the progress line emitted at the gate.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "alpha", name: "Alpha", description: "manage github issues" }),
        makeServerConfig({ id: "b", namespace: "beta", name: "Beta", description: "manage github issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "Example" }]),
    );
    priv.server.getClientCapabilities = () => ({ sampling: {} });
    priv.server.createMessage = async () => {
      throw new Error("no transport in this test");
    };
    const progress = vi.fn();
    const result = await priv.handleDispatch("manage github issues", 1.5, progress);
    expect(result.isError).toBeUndefined();
    // One winner, not two: 1.5 floors to 1.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    // The tiebreak gate fired for the single-winner dispatch.
    expect(progress.mock.calls.some((c) => String(c[0]).includes("Top candidates close"))).toBe(true);
  });

  it("does not announce an LLM tiebreak to a client that cannot sample", async () => {
    // Same tie as above, but the client advertises no sampling capability.
    // bestOfNViaSampling would return null anyway; the point is the progress
    // line: "asking LLM to pick" promised a round-trip that was never going
    // to happen, and the silence after it read as the LLM picking nothing.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "alpha", name: "Alpha", description: "manage github issues" }),
        makeServerConfig({ id: "b", namespace: "beta", name: "Beta", description: "manage github issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "Example" }]),
    );
    priv.server.getClientCapabilities = () => ({});
    const progress = vi.fn();
    const result = await priv.handleDispatch("manage github issues", 1, progress);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.some((c) => String(c[0]).includes("Top candidates close"))).toBe(false);
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
    // Same reset-not-clear reasoning as handleDispatch above.
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
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

  it("focuses the render without changing which namespace auto-warms", async () => {
    // The executable form of "the top match auto-load behaviour must not
    // change". `server:` is a RENDER concern and never reaches the ranker, so
    // a focused call can render only fs's card while the banner reports that
    // gh was auto-loaded. That is correct rather than confusing: the banner
    // announces a session state change the model has to know about, and
    // suppressing it would hide an activation. Without this test, the focus
    // parameter passes within arm's reach of rankIntentCandidates uncovered.
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

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue", undefined, "fs");
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
    expect(priv.sessionActivated.has("gh")).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Auto-loaded "gh"');
    expect(text).toContain("Filesystem");
    expect(text).not.toContain("GitHub");
  });

  it("still reports the auto-load when the focus namespace does not resolve", async () => {
    // The miss returns early, and it used to return a bare "not in
    // bundles.json" line. But the auto-warm has already run by then: a server
    // was spawned, added to sessionActivated and announced via
    // tools/list_changed. Dropping the banner leaves the model holding tools it
    // was never told about -- the one thing the banner exists to prevent.
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

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue", undefined, "nope");
    expect(priv.sessionActivated.has("gh")).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('Auto-loaded "gh"');
    expect(text).toContain(
      '"nope" is not in the bundles.json in effect (~/.yaw-mcp/bundles.json, or a trusted project-local .yaw-mcp/bundles.json)',
    );
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

  it("does not spawn an already-connected winner, but still advertises and names it", async () => {
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
    // No new spawn -- the connection already exists.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // But under the default gateway exposure "connected" is not
    // "advertised": an auto-loaded winner the client never asked for is
    // invisible in tools/list, so the intent-driven pick must still reach
    // sessionActivated and the banner must still name it -- otherwise the
    // one-shot discover(context) promise breaks exactly when the server
    // was already warm.
    expect(priv.sessionActivated.has("gh")).toBe(true);
    expect(result.content[0].text).toContain('Auto-loaded "gh"');
  });

  it("claims an already-connected winner away from prewarm, like activate and dispatch do", async () => {
    // The already-connected shortcut bypasses activateOne, which is where an
    // explicit activation deletes the prewarm claim. If the winner is a
    // prewarm-owned connection at that instant (its teardown has not run
    // yet), prewarm would close the very server this response calls
    // "Auto-loaded".
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
    priv.prewarmNamespaces.add("gh");

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");

    expect(result.content[0].text).toContain('Auto-loaded "gh"');
    expect(priv.prewarmNamespaces.has("gh")).toBe(false);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
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

  it("rebuilds the routing table for the server it auto-warmed", async () => {
    // The auto-warm used to activate without rebuilding routes. With a
    // persisted toolCache the stale route stays `deferred`, so the very
    // next tools/call takes the deferred branch, finds gh already
    // connected (isChanged:false), and returns "no longer available" --
    // and neither a second discover nor an explicit activate can clear it.
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests on GitHub",
      toolCache: [{ name: "create_issue", description: "Open an issue" }],
    });
    priv.config = { configVersion: "v1", servers: [ghConfig] };
    // Cold-start shape: routes built from the cache, so gh_create_issue is
    // present but deferred.
    priv.rebuildRoutes();
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBe(true);

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );

    await priv.handleDiscoverWithAutoWarm("file a github issue");

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
  });

  it("names the namespace it actually warmed, not the head of the BM25 list", async () => {
    // The banner used to print sorted[0] from the ranking the list
    // rendering uses, while the server that got activated came from
    // rankIntentCandidates. When the two disagree the banner named a server that
    // was never loaded.
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
    // Scores are on the BM25 scale (unbounded positive) so they clear
    // AUTO_ACTIVATE_MIN_SCORE_BM25 / _MARGIN_BM25.
    priv.rankIntentCandidates = async () => [
      { namespace: "bravo", score: 9.0 },
      { namespace: "alpha", score: 1.0 },
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

describe("exec hint for a client that never re-lists tools (Codex)", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  /** Pose as the client whose initialize the SDK recorded. */
  function asClient(priv: any, name: string): void {
    priv.server.getClientVersion = () => ({ name, version: "0.0.0" });
  }

  function ghOnly(priv: any): void {
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
  }

  /** A gh connection whose tools carry the given schemas and annotations. */
  function ghWith(
    tools: Array<{ name: string; required?: string[]; readOnly?: boolean }>,
  ): (cfg: UpstreamServerConfig) => Promise<UpstreamConnection> {
    return async (cfg) => {
      const conn = makeConnection(
        cfg.namespace,
        tools.map((t) => ({ name: t.name })),
      );
      conn.tools.forEach((t, i) => {
        const spec = tools[i];
        if (spec.required) t.inputSchema = { type: "object", required: spec.required };
        if (spec.readOnly) t.annotations = { readOnlyHint: true };
      });
      return conn;
    };
  }

  it("rides along when discover(context) auto-loads a server", async () => {
    const priv = getPrivate(server);
    ghOnly(priv);
    asClient(priv, "codex-mcp-client");
    vi.mocked(connectToUpstream).mockImplementation(ghWith([{ name: "create_issue" }]));
    const text = (await priv.handleDiscoverWithAutoWarm("file a github issue")).content[0].text;
    expect(text).toContain('Auto-loaded "gh"');
    expect(text).toContain('{"steps":[{"tool":"gh_create_issue","args":{}}]}');
  });

  it("is absent from the same auto-load for a client that re-lists", async () => {
    const priv = getPrivate(server);
    ghOnly(priv);
    asClient(priv, "claude-code");
    vi.mocked(connectToUpstream).mockImplementation(ghWith([{ name: "create_issue" }]));
    const text = (await priv.handleDiscoverWithAutoWarm("file a github issue")).content[0].text;
    expect(text).toContain('Auto-loaded "gh"');
    expect(text).not.toContain("mcp_connect_exec instead");
  });

  it("names a read-only tool that needs no arguments, so the example runs as written", async () => {
    const priv = getPrivate(server);
    ghOnly(priv);
    asClient(priv, "codex-mcp-client");
    vi.mocked(connectToUpstream).mockImplementation(
      ghWith([
        { name: "create_issue", required: ["title"] },
        { name: "delete_cache" },
        { name: "list_issues", readOnly: true },
      ]),
    );
    const text = (await priv.handleActivate(["gh"])).content[0].text;
    expect(text).toContain('{"steps":[{"tool":"gh_list_issues","args":{}}]}');
    expect(text).not.toContain("own arguments");
  });

  it("says to fill in the arguments when every tool needs some", async () => {
    const priv = getPrivate(server);
    ghOnly(priv);
    asClient(priv, "codex-mcp-client");
    vi.mocked(connectToUpstream).mockImplementation(
      ghWith([
        { name: "create_issue", required: ["title"] },
        { name: "get_issue", required: ["number"] },
      ]),
    );
    const text = (await priv.handleActivate(["gh"])).content[0].text;
    expect(text).toContain('{"steps":[{"tool":"gh_create_issue","args":{}}]}');
    expect(text).toContain(`with the tool's own arguments in "args"`);
  });
});

describe("clientRelistsTools", () => {
  it("is false for exactly the clients that read tools/list once (Codex, Continue)", () => {
    expect(clientRelistsTools({ name: "codex-mcp-client" })).toBe(false);
    expect(clientRelistsTools({ name: "continue-client" })).toBe(false);
  });

  it("is true for every other client, a near-miss name, and no clientInfo at all", () => {
    expect(clientRelistsTools({ name: "claude-code" })).toBe(true);
    expect(clientRelistsTools({ name: "Codex-MCP-Client" })).toBe(true);
    expect(clientRelistsTools({})).toBe(true);
    expect(clientRelistsTools(undefined)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Routing confidence: the coverage floor on discover's auto-warm, the
// shared health-adjusted ranking, dispatch's low-confidence note and its
// runner-up fallback.
// ═══════════════════════════════════════════════════════════════════════

const cand = (namespace: string, score: number, coverage?: number, matched = 1, contentTerms = 4): RoutingCandidate =>
  coverage === undefined ? { namespace, score } : { namespace, score, coverage, matched, contentTerms };

describe("pickAutoWarmWinner", () => {
  it("withholds a decisive winner whose coverage is under the floor", () => {
    // Redis LRU vs LFU, the shape: one rare word scores the server high, the
    // rest of the question matches nothing anywhere.
    expect(pickAutoWarmWinner([cand("redis", 32.9, 0.3), cand("pg", 2, 0.1)])).toBeUndefined();
    expect(pickAutoWarmWinner([cand("redis", 32.9, AUTO_ACTIVATE_MIN_COVERAGE - 0.001)])).toBeUndefined();
  });

  it("warms at the floor, and still demands the score floor and margin", () => {
    expect(pickAutoWarmWinner([cand("pg", 9, AUTO_ACTIVATE_MIN_COVERAGE)])?.namespace).toBe("pg");
    expect(pickAutoWarmWinner([cand("pg", 0.9, 1)])).toBeUndefined();
    expect(pickAutoWarmWinner([cand("pg", 9, 1), cand("redis", 8, 1)])).toBeUndefined();
  });

  it("falls back to score floor and margin alone when coverage was not measured", () => {
    expect(pickAutoWarmWinner([cand("gh", 9), cand("fs", 1)])?.namespace).toBe("gh");
  });
});

describe("dispatchConfidenceNote", () => {
  const opts = { sampled: false, noSampling: false };

  it("is silent for a decisive, well-covered pick", () => {
    expect(dispatchConfidenceNote([cand("pg", 20, 0.9), cand("redis", 5, 0.2)], "pg", new Set(["pg"]), opts)).toBe(
      undefined,
    );
  });

  it("flags a close call and names the runners-up, best first", () => {
    const ranked = [cand("pg", 10, 0.9), cand("redis", 9, 0.5), cand("fs", 3, 0.2), cand("ssh", 2, 0.1)];
    const note = dispatchConfidenceNote(ranked, "pg", new Set(["pg"]), opts) ?? "";
    expect(note).toContain("close call (redis scored 9.00 vs 10.00)");
    expect(note).toContain("Runners-up: redis (9.00), fs (3.00).");
    expect(note).not.toContain("ssh");
    expect(note).toContain("answer it directly");
  });

  it("says the client cannot break the tie when it has no sampling", () => {
    const note = dispatchConfidenceNote([cand("pg", 10, 0.9), cand("redis", 9, 0.9)], "pg", new Set(["pg"]), {
      sampled: false,
      noSampling: true,
    });
    expect(note).toContain("this client cannot be asked to break the tie");
  });

  it("drops the close call an LLM tiebreak already settled, but keeps low coverage", () => {
    const ranked = [cand("pg", 10, 0.9), cand("redis", 9, 0.9)];
    expect(dispatchConfidenceNote(ranked, "pg", new Set(["pg"]), { sampled: true, noSampling: false })).toBe(undefined);
    const weak = [cand("pg", 10, 0.2, 1, 5), cand("redis", 9, 0.9)];
    const note = dispatchConfidenceNote(weak, "pg", new Set(["pg"]), { sampled: true, noSampling: false }) ?? "";
    expect(note).toContain("pg matches 1 of the request's 5 content words");
    expect(note).not.toContain("close call");
  });

  it("flags low coverage, but not when coverage was not measured", () => {
    expect(dispatchConfidenceNote([cand("pg", 20, 0.1, 1, 6)], "pg", new Set(["pg"]), opts)).toBe(
      "Low confidence: pg matches 1 of the request's 6 content words. If pg does not fit, mcp_connect_activate a runner-up or dispatch a more specific intent; if the request needs no tool, answer it directly.",
    );
    expect(dispatchConfidenceNote([cand("pg", 20)], "pg", new Set(["pg"]), opts)).toBeUndefined();
  });

  it("does not flag low coverage on a pick that matches several words and leads decisively", () => {
    // "create a github issue titled login button broken on safari": the title
    // words match nothing, but github matches three words and leads 2.6x.
    const decisive = [cand("gh", 19.65, 0.16, 3, 8), cand("vault", 7.61, 0.1, 1, 8)];
    expect(dispatchConfidenceNote(decisive, "gh", new Set(["gh"]), opts)).toBeUndefined();
    expect(19.65 / 7.61).toBeGreaterThanOrEqual(DISPATCH_LOW_COVERAGE_MARGIN);
    // ...but does when the lead is under DISPATCH_LOW_COVERAGE_MARGIN
    const thin = [cand("gh", 10, 0.16, 3, 8), cand("vault", 6, 0.1, 1, 8)];
    expect(dispatchConfidenceNote(thin, "gh", new Set(["gh"]), opts)).toContain(
      "gh matches 3 of the request's 8 content words",
    );
  });

  it("never offers a server this call already loaded or tried", () => {
    const ranked = [cand("gh", 10, 0.9), cand("slack", 9.5, 0.9), cand("fs", 9, 0.9)];
    // gh failed, slack was loaded as the fallback: fs is the only runner-up.
    const note = dispatchConfidenceNote(ranked, "slack", new Set(["gh", "slack"]), opts) ?? "";
    expect(note).toContain("close call (fs scored 9.00 vs 9.50)");
    expect(note).toContain("Runners-up: fs (9.00).");
  });
});

describe("routing confidence in the dispatch and discover handlers", () => {
  let server: ConnectServer;

  beforeEach(() => {
    // Same reset-not-clear reasoning as handleDispatch above.
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  const fiveServers = () => [
    makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub", description: "Repos, issues and pull requests" }),
    makeServerConfig({ id: "pg-id", namespace: "pg", name: "Postgres", description: "Query a postgres database" }),
    makeServerConfig({ id: "rd-id", namespace: "rd", name: "Redis", description: "Keys and caches in redis" }),
    makeServerConfig({ id: "fs-id", namespace: "fs", name: "Filesystem", description: "Read and write local files" }),
    makeServerConfig({ id: "sl-id", namespace: "sl", name: "Slack", description: "Team chat messages" }),
  ];

  it("measures coverage only from AUTO_ACTIVATE_COVERAGE_MIN_SERVERS servers up", async () => {
    const priv = getPrivate(server);
    const five = fiveServers();
    expect(five).toHaveLength(AUTO_ACTIVATE_COVERAGE_MIN_SERVERS);
    const full = await priv.rankIntentCandidates("query the postgres database", five);
    expect(full[0].namespace).toBe("pg");
    expect(full[0].coverage).toBeGreaterThan(0);
    expect(full[0].contentTerms).toBeGreaterThan(0);
    const small = await priv.rankIntentCandidates("query the postgres database", five.slice(0, 4));
    expect(small[0]).toEqual({ namespace: "pg", score: small[0].score });
  });

  it("does not measure coverage on a lone server, where IDF cannot tell a word's weight", async () => {
    // The reason for AUTO_ACTIVATE_COVERAGE_MIN_SERVERS: one GitHub server and
    // "file a github issue" covers under the floor, because "file" is the only
    // word it lacks and an unmatched word gets the highest weight there is.
    const gh = makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos, issues, and pull requests" });
    const priv = getPrivate(server);
    const lone = [priv.rankableFor(gh)];
    const [cov] = queryCoverage("file a github issue", lone);
    expect(cov.coverage).toBeCloseTo(0.29, 2);
    expect(cov.coverage).toBeLessThan(AUTO_ACTIVATE_MIN_COVERAGE);
    const ranked = await priv.rankIntentCandidates("file a github issue", [gh]);
    expect(ranked[0].coverage).toBeUndefined();
  });

  it("discover does not auto-warm a decisive winner that covers too little of the request", async () => {
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: fiveServers() };
    priv.rankIntentCandidates = async () => [cand("rd", 32.9, 0.3), cand("pg", 2, 0.1)];
    const result = await priv.handleDiscoverWithAutoWarm("how does redis lru eviction differ from lfu");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-loaded");
  });

  it("discover auto-warms the same winner dispatch picks: health applies to both", async () => {
    // Raw BM25 has gh ahead (10 vs 9, too close to warm). gh failed to
    // activate a moment ago, so routing halves it and pg leads 9 to 5 --
    // which is what dispatch would load, and now what discover warms.
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: fiveServers() };
    priv.rankIntentCandidates = async () => [cand("gh", 10, 0.9), cand("pg", 9, 0.9)];
    priv.activationFailures.set("gh", { at: Date.now(), message: "docker is not running" });
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "query" }]),
    );
    const routed = await priv.routingCandidates("anything", priv.config.servers);
    expect(routed.map((r: RoutingCandidate) => r.namespace)).toEqual(["pg", "gh"]);
    expect(routed[0].coverage).toBe(0.9);

    const result = await priv.handleDiscoverWithAutoWarm("anything");
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("pg");
    expect(result.content[0].text).toContain('Auto-loaded "pg"');
  });

  it("dispatch flags a close call it could not ask the client about, naming the runner-up", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "alpha", name: "Alpha", description: "manage github issues" }),
        makeServerConfig({ id: "b", namespace: "beta", name: "Beta", description: "manage github issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one" }]),
    );
    priv.server.getClientCapabilities = () => ({});
    const result = await priv.handleDispatch("manage github issues", 1);
    const text: string = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain('Dispatched "manage github issues" — tried the top 1 of the 2 servers ranked for it.');
    expect(text).not.toContain("matching server");
    expect(text).toMatch(/Low confidence: close call \(beta scored [0-9.]+ vs [0-9.]+; this client cannot be asked/);
    expect(text).toContain("Runners-up: beta");
  });

  it("dispatch reports no close call once the client's LLM picked between the two", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "alpha", name: "Alpha", description: "manage github issues" }),
        makeServerConfig({ id: "b", namespace: "beta", name: "Beta", description: "manage github issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one" }]),
    );
    priv.server.getClientCapabilities = () => ({ sampling: {} });
    priv.server.createMessage = async () => ({ role: "assistant", content: { type: "text", text: "beta" } });
    const result = await priv.handleDispatch("manage github issues", 1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("beta");
    expect(result.content[0].text).not.toContain("close call");
  });

  it("dispatch falls back to a close runner-up when the winner fails to start, and says so", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        // Same name and description: the ranker cannot tell them apart.
        makeServerConfig({ id: "a-id", namespace: "alpha", name: "GitHub", description: "Repos and issues" }),
        makeServerConfig({ id: "b-id", namespace: "beta", name: "GitHub", description: "Repos and issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "alpha") throw new ActivationError("docker daemon is not running", "install_failure");
      return makeConnection(cfg.namespace, [{ name: "tool_one" }]);
    });
    const result = await priv.handleDispatch("github issue", 1);
    const text: string = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain(
      'Dispatched "github issue" — tried 2 (the top 1, then 1 runner-up) of the 2 servers ranked for it. alpha failed to load; loaded runner-up beta instead.\n',
    );
    expect(text).toMatch(/^alpha \(score [0-9.]+\): .*docker daemon is not running/m);
    expect(text).toMatch(/^beta \(score [0-9.]+, runner-up tried because alpha failed to load\): Loaded "beta"/m);
    expect(priv.sessionActivated.has("beta")).toBe(true);
    expect(priv.sessionActivated.has("alpha")).toBe(false);
    expect(priv.lastIntentByNamespace.get("beta")).toBe("github issue");
  });

  it("does not swap a failed winner for a runner-up that scores far below it", async () => {
    // slack shares only "issues" with the request: well outside the
    // AUTO_ACTIVATE_MARGIN_BM25 of gh, so gh's failure stands and is an error.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub", description: "Repos and issues" }),
        makeServerConfig({ id: "sl-id", namespace: "slack", name: "Slack", description: "Issues and team messages" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "gh") throw new ActivationError("docker daemon is not running", "install_failure");
      return makeConnection(cfg.namespace, [{ name: "tool_one" }]);
    });
    const ranked = await priv.routingCandidates("github issue", priv.config.servers);
    expect(ranked.map((r: RoutingCandidate) => r.namespace)).toEqual(["gh", "slack"]);
    expect(ranked[1].score * AUTO_ACTIVATE_MARGIN_BM25).toBeLessThan(ranked[0].score);
    const result = await priv.handleDispatch("github issue", 1);
    expect(result.isError).toBe(true);
    expect(new Set(vi.mocked(connectToUpstream).mock.calls.map((c) => c[0].namespace))).toEqual(new Set(["gh"]));
    expect(result.content[0].text).not.toContain("runner-up tried");
    expect(priv.sessionActivated.has("slack")).toBe(false);
  });

  it("tries at most DISPATCH_MAX_FALLBACKS runners-up, and errors when none starts", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: ["a", "b", "c", "d", "e"].map((ns) =>
        makeServerConfig({ id: ns, namespace: ns, name: ns.toUpperCase(), description: `issues tracker ${ns}` }),
      ),
    };
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("docker daemon is not running", "install_failure"),
    );
    const result = await priv.handleDispatch("issues", 1);
    const tried = new Set(vi.mocked(connectToUpstream).mock.calls.map((c) => c[0].namespace));
    expect(tried.size).toBe(1 + DISPATCH_MAX_FALLBACKS);
    expect(result.isError).toBe(true);
    expect(result.content[0].text.match(/runner-up tried because/g)).toHaveLength(DISPATCH_MAX_FALLBACKS);
    expect(result.content[0].text).toContain(
      `tried ${1 + DISPATCH_MAX_FALLBACKS} (the top 1, then ${DISPATCH_MAX_FALLBACKS} runners-up) of the 5 servers ranked for it.\n`,
    );
    expect(result.content[0].text).not.toContain("Low confidence");
  });

  it("does not fall back from a cap refusal, or when nothing else scored", async () => {
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub", description: "Repos and issues" }),
        makeServerConfig({ id: "sl-id", namespace: "slack", name: "Slack", description: "Issues and team messages" }),
        makeServerConfig({ id: "fs-id", namespace: "fs", name: "Filesystem", description: "Local files" }),
      ],
    };
    priv.connections.set("other", makeConnection("other", [{ name: "t" }]));
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one" }]),
    );
    const capped = await priv.handleDispatch("github issue", 1);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(capped.content[0].text).not.toContain("runner-up tried");

    // fs shares no word with the intent, so it is not a candidate at all:
    // the gh failure stands alone rather than loading an unrelated server.
    priv.serverCap = 10;
    priv.connections.delete("other");
    priv.config.servers = priv.config.servers.filter((s: UpstreamServerConfig) => s.namespace !== "slack");
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("docker daemon is not running", "install_failure"),
    );
    const lone = await priv.handleDispatch("github issue", 1);
    expect(new Set(vi.mocked(connectToUpstream).mock.calls.map((c) => c[0].namespace))).toEqual(new Set(["gh"]));
    expect(lone.isError).toBe(true);
    expect(lone.content[0].text).not.toContain("runner-up tried");
  });
});
