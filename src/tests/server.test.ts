import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing the module under test
vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { CONFIG_DIRNAME } from "../paths.js";
import { buildToolList, buildToolRoutes, isRoutingFaultResult } from "../proxy.js";
import {
  ConnectServer,
  computeToolOverlaps,
  DEFAULT_IDLE_CALL_THRESHOLD,
  isAutoActivateEnabled,
  isAutoLoadEnabled,
  isRoutingFaultText,
  ROUTING_FAULT_DISCONNECTED,
  ROUTING_FAULT_UNKNOWN_TOOL,
  resolveIdleThreshold,
  resolveToolExposure,
} from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, type DownstreamClientBridge, disconnectFromUpstream } from "../upstream.js";

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

function makeConnection(
  namespace: string,
  tools: string[] = [],
  status: "connected" | "error" = "connected",
): UpstreamConnection {
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
    status,
  } as UpstreamConnection;
}

// Access private members for testing
function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("ConnectServer", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  describe("handleDiscover", () => {
    it("returns empty message when no config", () => {
      const priv = getPrivate(server);
      priv.config = null;
      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("returns empty message when no servers", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("lists active servers with status", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      const conn = makeConnection("gh", ["create_issue", "list_prs"]);
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("gh — GitHub [loaded (2 tools)]");
      expect(text).toContain("slack — Slack [ready]");
      expect(text).toContain("1 loaded in this session, 2 tools in context");
    });

    it("shows disabled servers separately", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", isActive: true }),
        makeServerConfig({ namespace: "old", name: "Old Server", isActive: false }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Disabled servers:");
      expect(text).toContain('old — Old Server ("isActive": false in bundles.json)');
    });

    it("shows cached tools for inactive connections", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.toolCache.set("gh", [{ name: "create_issue" }, { name: "list_prs" }]);

      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("known tools: create_issue, list_prs");
    });

    it("surfaces a token-cost estimate per server line", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      // gh is loaded — live tool count, no tilde. slack has cached tools
      // only — cached estimate, tilde prefix.
      priv.connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
      priv.toolCache.set("slack", [{ name: "post" }, { name: "list_channels" }, { name: "dm" }]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // Connected: "N tools, M tokens" (no tilde prefix on the count).
      expect(text).toMatch(/gh — GitHub.*?— 2 tools, \d+ tokens/);
      // Cached: "N tools, ~M tokens" with tilde.
      expect(text).toMatch(/slack — Slack.*?— 3 tools, ~\d+ tokens/);
      // Session summary also mentions approximate total tokens.
      expect(text).toMatch(/1 loaded in this session, 2 tools in context \(~\d+ tokens\)/);
    });

    it("omits the cost label when there's nothing to estimate", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "nothing", name: "Nothing" })]);
      // No connection, no toolCache — label should be suppressed so the
      // line doesn't read "— 0 tools, 0 tokens".
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("nothing — Nothing [ready]");
      expect(text).not.toMatch(/nothing — Nothing.*0 tools/);
    });

    it("surfaces a health warning when recent calls are failing", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      // 4/10 failed = 40% → above the 30% warning threshold.
      conn.health = { totalCalls: 10, errorCount: 4, totalLatencyMs: 0, lastErrorMessage: "502 bad gateway" };
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("warn: 4 of last 10 calls failed: 502 bad gateway");
    });

    it("surfaces a recent activation failure as a discover warning", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // No live connection; activation failure stashed in the map.
      priv.activationFailures.set("gh", { at: Date.now() - 60_000, message: "spawn ENOENT" });

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toMatch(/warn: last activation failed \d+m ago: spawn ENOENT/);
    });

    it("sorts servers by relevance when context provided", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "slack", name: "Slack" }),
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
      ]);

      const result = priv.handleDiscover("github issues");
      const text = result.content[0].text;
      // GitHub should come first due to relevance
      const ghIndex = text.indexOf("gh —");
      const slackIndex = text.indexOf("slack —");
      expect(ghIndex).toBeLessThan(slackIndex);
    });

    it("shows error status for disconnected connections", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("ERROR (disconnected, will auto-reconnect on use)");
    });

    it("surfaces the marketplace URL hint when the user has a sparse config", () => {
      // Threshold is 5 installed servers; 2 is well below. Hint should
      // point to the publicly-browsable catalog at /explore — there is
      // no JSON API for the catalog, so this is an URL pointer, not a
      // programmatic surface.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("https://yaw.sh/mcp/catalog/");
      expect(text).toContain("yaw-mcp add <slug>");
    });

    it("omits the marketplace hint once the user has plenty of servers", () => {
      // Five or more installed servers is a power-user config — the hint
      // would just be noise. Verify the URL pointer is absent.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
        makeServerConfig({ namespace: "pg", name: "Postgres" }),
        makeServerConfig({ namespace: "s3", name: "S3" }),
        makeServerConfig({ namespace: "redis", name: "Redis" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("https://yaw.sh/mcp/catalog/");
    });

    it("includes the marketplace pointer in the empty-state message", () => {
      // A fresh user with zero servers sees the empty-state branch —
      // that message also needs the catalog link so they can get started.
      const priv = getPrivate(server);
      priv.config = makeConfig([]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("No servers installed");
      expect(text).toContain("https://yaw.sh/mcp/catalog/");
    });
  });

  describe("getProfiledActiveServers toolCache merge", () => {
    // The merge in getProfiledActiveServers feeds the in-memory toolCache into
    // formatShadowLine so unknown namespaces with learned/persisted tools can
    // surface a heuristic shadow hint. These tests pin the merge contract.
    it("surfaces a heuristic shadow hint for an unknown namespace with a learned toolCache", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "my-npm-proxy", name: "npm proxy" })]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);

      const text = priv.handleDiscover().content[0].text;
      expect(text).toContain("prefer over local CLI: `npm`");
    });

    it("preserves object identity when no in-memory cache exists", () => {
      // mergeToolCache (server.ts) promises to return `server` unchanged
      // when there is nothing to merge, so downstream consumers keyed on
      // reference equality are unaffected. Pin that.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([serverConfig]);

      const merged = priv.getProfiledActiveServers();
      expect(merged[0]).toBe(serverConfig); // same reference, not a clone
    });

    it("does not leak a namespace's cache to a sibling", () => {
      // gh and github share a prefix but no shared cache — github's output
      // must not see gh's tools. (The heuristic would also reject this case
      // via the namespace-name test, but the merge itself keys on namespace.)
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "github", name: "GitHub alias" }),
      ]);
      priv.toolCache.set("gh", [{ name: "gh_create_issue" }, { name: "gh_list_prs" }, { name: "gh_search" }]);

      const merged = priv.getProfiledActiveServers();
      const github = merged.find((s: UpstreamServerConfig) => s.namespace === "github");
      expect(github?.toolCache).toBeUndefined();
    });

    it("narrows by profile BEFORE merging cache", () => {
      // Filter-then-merge and merge-then-filter produce the same OUTPUT
      // (mergeToolCache is side-effect-free and profileAllows keys only on
      // namespace), so the returned array can't pin the order. Spy on the
      // merge instead: a profile-excluded server must never reach it — the
      // flipped order would clone caches for servers the profile drops.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      priv.toolCache.set("gh", [{ name: "gh_create" }, { name: "gh_list" }, { name: "gh_search" }]);
      priv.profile = { servers: ["gh"] };

      const mergeSpy = vi.spyOn(priv, "mergeToolCache");
      const merged = priv.getProfiledActiveServers();
      expect(merged.map((s: UpstreamServerConfig) => s.namespace)).toEqual(["gh"]);
      // And the surviving gh still got its cache merged.
      expect(merged[0].toolCache).toBeDefined();
      expect(merged[0].toolCache.length).toBe(3);
      // The ordering pin: only the profile-surviving server reaches the merge.
      expect(mergeSpy.mock.calls.map((c: any[]) => c[0].namespace)).toEqual(["gh"]);
    });

    it("treats an empty-array cache the same as no cache (object identity preserved)", () => {
      // Guards the `sessionCache.length > 0` check. A regression that drops
      // the guard would always-spread and fragment identity for dormant
      // servers — every consumer keyed on reference equality breaks silently.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([serverConfig]);
      priv.toolCache.set("gh", []); // learned entry that points at nothing

      const merged = priv.getProfiledActiveServers();
      expect(merged[0]).toBe(serverConfig);
    });

    it("prefers the in-memory sessionCache over the server's own toolCache on collision", () => {
      // When both `server.toolCache` (the path bundles.json / state.json
      // hydration would have taken) and `this.toolCache.get(namespace)`
      // (the live in-memory map, updated as servers activate) have entries,
      // the in-memory one wins. Pin the precedence so a regression that
      // flips the ternary can't silently let a stale persisted list
      // shadow fresh learning.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({
        namespace: "my-npm-proxy",
        name: "npm proxy",
        toolCache: [{ name: "persisted_old" }, { name: "persisted_stale" }, { name: "persisted_gone" }],
      });
      priv.config = makeConfig([serverConfig]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);

      const merged = priv.getProfiledActiveServers();
      expect(merged[0].toolCache).toEqual([{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);
    });

    it("exposes the merged cache to the guide auto-section via getBuiltinResources", () => {
      // cli-shadows.ts:166 promises "discover + guide see learned tools".
      // The discover path is covered above; the guide resource reads the
      // same merged list inside renderGuide and renders an "Active servers"
      // block. Pin the guide path so a regression that splits
      // getProfiledActiveServers between the two callers (or caches the
      // guide body past toolCache changes) breaks this test rather than
      // silently dropping the heuristic hint from the guide resource.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "my-npm-proxy", name: "npm proxy" })]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);
      priv.guides = {
        user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "user guide" },
        project: null,
      };

      const builtin = priv.getBuiltinResources()[0];
      const text = builtin.read().contents[0].text;
      expect(text).toContain("my-npm-proxy");
      expect(text).toContain("prefer over local CLI: `npm`");
    });
  });

  describe("discover tool overlaps", () => {
    it("surfaces a bare tool name shared by two connected servers", () => {
      // fs and github both expose `read_file` — the LLM needs a nudge
      // toward dispatch to pick the right one, so the overlap line lists
      // both namespaces and points at mcp_connect_dispatch.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "fs", name: "FS" }),
        makeServerConfig({ namespace: "github", name: "GitHub" }),
      ]);
      priv.connections.set("fs", makeConnection("fs", ["read_file", "write_file"]));
      priv.connections.set("github", makeConnection("github", ["read_file", "list_repos"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Overlapping tools (same bare name in multiple servers):");
      expect(text).toContain("read_file — available in: fs, github");
      expect(text).toContain("use mcp_connect_dispatch to disambiguate");
    });

    it("suppresses the overlaps block when no bare names collide", () => {
      // One connected server, no collisions — the block should not even
      // print its header, otherwise we're adding noise to the common case.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "fs", name: "FS" })]);
      priv.connections.set("fs", makeConnection("fs", ["read_file", "write_file"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("Overlapping tools");
    });

    it("lists all namespaces alphabetically when three or more share a name", () => {
      // Three-way overlap — every namespace shows up on the line, sorted
      // alphabetically so the output is deterministic across runs.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "linear", name: "Linear" }),
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "jira", name: "Jira" }),
      ]);
      priv.connections.set("linear", makeConnection("linear", ["list_issues"]));
      priv.connections.set("gh", makeConnection("gh", ["list_issues"]));
      priv.connections.set("jira", makeConnection("jira", ["list_issues"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("list_issues — available in: gh, jira, linear");
    });

    it("caps the overlaps block at the top 5", () => {
      // Seven distinct overlapping bare names, all with the same pair
      // count — the block must stop at 5 and tie-break alphabetically
      // so the rendered list stays bounded. `toolA` through `toolE`
      // should be kept; `toolF` and `toolG` should be dropped.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "x", name: "X" }),
        makeServerConfig({ namespace: "y", name: "Y" }),
      ]);
      const overlapping = ["toolG", "toolA", "toolC", "toolE", "toolB", "toolF", "toolD"];
      priv.connections.set("x", makeConnection("x", overlapping));
      priv.connections.set("y", makeConnection("y", overlapping));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      for (const kept of ["toolA", "toolB", "toolC", "toolD", "toolE"]) {
        expect(text).toContain(`${kept} — available in: x, y`);
      }
      expect(text).not.toContain("toolF — available in");
      expect(text).not.toContain("toolG — available in");
    });

    it("ignores disconnected servers when computing overlaps", () => {
      // A dormant server whose tool cache would otherwise collide must
      // not count — we don't have a live schema for it, so claiming an
      // overlap would be a lie. computeToolOverlaps only sees the
      // connected connection, so no overlap is emitted.
      const conn = makeConnection("fs", ["read_file"]);
      const errored = makeConnection("github", ["read_file"], "error");
      const result = computeToolOverlaps([conn, errored]);
      expect(result).toEqual([]);
    });
  });

  describe("discover bundle completions", () => {
    it("surfaces a bundle-completion nudge when a curated bundle is partially installed", () => {
      // Install github only. pr-review needs github + linear, so the
      // inline block must surface it as a partial with linear missing.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "github", name: "GitHub" })]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Bundle completions (install to unlock curated stacks):");
      expect(text).toContain("pr-review");
      expect(text).toContain("have: github");
      expect(text).toContain("add: linear");
    });

    it("suppresses the bundle-completions block when no bundle has any overlap", () => {
      // Install only a namespace that matches no seeded bundle — the
      // block should not even print its header.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "nonsense-ns", name: "NS" })]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).not.toContain("Bundle completions");
    });

    it("suppresses the block when every matching bundle is fully installed", () => {
      // github + linear fully satisfies pr-review, and no other curated
      // bundle shares just those two namespaces — so partial is empty.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // pr-review is fully installed; nothing to "complete" for it.
      // Other bundles may still be partial (share github/linear), so we
      // only assert that pr-review doesn't appear as a completion target.
      const completionsBlock = text.split("Bundle completions")[1] ?? "";
      expect(completionsBlock).not.toMatch(/^\s+pr-review/m);
    });

    it("caps the bundle-completions block at 3 entries", () => {
      // Install slack — overlaps with devops-incident, growth-stack,
      // product-release, support-ops. All 4 are partial; the block must
      // cap at 3.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "slack", name: "Slack" })]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      const completionLines = text.split("\n").filter((l: string) => l.startsWith("  ") && l.includes("have: slack"));
      expect(completionLines.length).toBeLessThanOrEqual(3);
    });
  });

  describe("handleActivate", () => {
    it("returns error when no namespaces provided", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleActivate([]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("server namespace is required");
    });

    it("returns error when namespace not in config", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleActivate(["unknown"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not installed");
      // No lookalikes in an empty config — fall back to discover nudge.
      expect(result.content[0].text).toContain("mcp_connect_discover");
    });

    it("surfaces a 'Did you mean?' when the namespace is a near-miss of an installed one", async () => {
      // User typed "githu" when "github" is installed — one-edit typo.
      // closestNames is intentionally quiet on wild misses, so this also
      // proves we emit the suggestion only when signal is high.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      const result = await priv.handleActivate(["githu"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('"githu" is not installed');
      expect(text).toContain("Did you mean: github");
    });

    it("distinguishes an installed-but-disabled server from an unknown one", async () => {
      // Disabled-in-dashboard case gets its own message so the model
      // doesn't tell the user to install something they already have.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })]);
      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("installed but disabled");
      expect(text).toContain('"isActive": true');
      expect(text).toContain("~/.yaw-mcp/bundles.json");
    });

    it("skips already-active servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.content[0].text).toContain("already loaded");
      expect(connectToUpstream).not.toHaveBeenCalled();
    });

    it("activates server and updates tool cache", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(priv.connections.has("gh")).toBe(true);
      expect(priv.toolCache.has("gh")).toBe(true);
      expect(priv.idleCallCounts.get("gh")).toBe(0);
    });

    it("retries on first failure", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("connection refused")).mockResolvedValueOnce(conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(connectToUpstream).toHaveBeenCalledTimes(2);
    });

    it("reports failure after both attempts fail", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      vi.mocked(connectToUpstream).mockRejectedValue(new Error("timeout"));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to load "gh": timeout');
    });

    it("activates multiple servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);

      vi.mocked(connectToUpstream)
        .mockResolvedValueOnce(makeConnection("gh", ["create_issue"]))
        .mockResolvedValueOnce(makeConnection("slack", ["send_message"]));

      const result = await priv.handleActivate(["gh", "slack"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.size).toBe(2);
    });

    it("fix#3: all-failed activation still sets isError true", async () => {
      // anyError=true and anyChanged=false. The old code's condition was
      // `anyError && !anyChanged ? true : undefined`; the current one is
      // `anyError || (anyCapped && !anyChanged) ? true : undefined`, so a
      // real failure ALWAYS surfaces (the anyChanged conjunct is gone) and
      // a cap refusal only errors when nothing loaded at all.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "bad" })]);
      vi.mocked(connectToUpstream).mockRejectedValue(new Error("bad server down"));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("bad server down");
    });

    it("fix#3: compliance-refusal partial success also sets isError true", async () => {
      // Compliance refusal is synchronous (no retry delay). Use it to
      // exercise the anyError && anyChanged=true branch without a 1s wait.
      const { default: process } = await import("node:process");
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "bad", complianceGrade: "D" }),
      ]);
      // Only gh will be activated (bad is blocked by compliance).
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));
      process.env.YAW_MCP_MIN_COMPLIANCE = "B";
      try {
        const result = await priv.handleActivate(["gh", "bad"]);
        // anyError=true (bad refused), anyChanged=true (gh loaded).
        // Old logic: isError = anyError && !anyChanged = false -> undefined.
        // Current logic: anyError alone forces true, regardless of
        // anyChanged (the anyCapped clause is the only one that still
        // consults it).
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Refused");
      } finally {
        delete process.env.YAW_MCP_MIN_COMPLIANCE;
      }
    });
  });

  describe("compliance-aware routing", () => {
    // vi.unstubAllEnvs() restores every stubbed env var after each case so
    // an errant YAW_MCP_MIN_COMPLIANCE can't leak into later suites.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("refuses to activate a below-grade server with a clear error", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "D" })]);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("grade D");
      expect(text).toContain("YAW_MCP_MIN_COMPLIANCE=B");
      expect(text).toContain("Unset YAW_MCP_MIN_COMPLIANCE");
      // No upstream spawn — the gate must short-circuit before activation.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("dispatch honors the compliance floor via the shared activate path (not just handleActivate)", async () => {
      // The floor gate lives inside runActivateOne now, so a dispatch that
      // ranks a below-grade server first must refuse it before any spawn.
      // handleActivate's own early check does NOT cover the dispatch path —
      // this pins that the gate moved down into the shared activate flow.
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "D" })]);

      const result = await priv.handleDispatch("github issue", 1);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("grade D");
      // Gate short-circuits before connectToUpstream — no below-grade spawn.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("reports an unrecognized grade distinctly from a below-min grade", async () => {
      // passesMinCompliance fails closed on a garbled grade, but the message
      // must not call an unrecognized "Pass" grade "below B".
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      // "Pass" is intentionally off the Grade union: it simulates a backend
      // emitting a grade format yaw-mcp doesn't recognize (the case A6 fixes).
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "Pass" as never }),
      ]);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("unrecognized compliance grade");
      expect(text).toContain('"Pass"');
      expect(text).not.toContain("grade Pass is below");
    });

    it("allows activation when the grade meets the minimum", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("allows activation for ungraded servers even when the filter is on (don't punish unknown)", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "A");
      const priv = getPrivate(server);
      // No complianceGrade on this config — mirrors today's backend.
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("does not filter anything when YAW_MCP_MIN_COMPLIANCE is unset", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      // Even an F-grade server is activatable with the filter disabled.
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad", complianceGrade: "F" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("bad", ["t"]));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("bad")).toBe(true);
    });

    it("annotates below-grade servers in discover output and emits a filter header", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" }),
        makeServerConfig({ namespace: "bad", name: "Bad Server", complianceGrade: "D" }),
        makeServerConfig({ namespace: "raw", name: "Ungraded" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Compliance filter active: YAW_MCP_MIN_COMPLIANCE=B");
      // Passing grade is surfaced inline as `[A]`.
      expect(text).toMatch(/gh — GitHub.*\[A\]/);
      // Failing server is surfaced in place with the refusal reason.
      expect(text).toContain("bad — Bad Server");
      expect(text).toContain("(grade D — below YAW_MCP_MIN_COMPLIANCE=B, won't auto-activate)");
      // Ungraded server gets no annotation — avoids cluttering every
      // current deploy where nothing is scored yet.
      expect(text).not.toMatch(/raw — Ungraded.*\[[A-F]\]/);
      expect(text).not.toMatch(/raw — Ungraded.*won't auto-activate/);
    });

    it("shows `[grade]` tags even when the filter env is unset (trust signal is always on)", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "B" })]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("Compliance filter active");
      // Grade tag surfaces unconditionally when the backend has scored
      // the server — a visible A-F mark on every discover output lets
      // the model factor trust into activation decisions without the
      // user having to pre-configure a floor.
      expect(text).toMatch(/gh — GitHub.*\[B\]/);
    });

    it("leaves ungraded servers unannotated with the filter unset", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      // No complianceGrade on this config — mirrors unscored catalog entries.
      priv.config = makeConfig([makeServerConfig({ namespace: "raw", name: "Ungraded" })]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // Ungraded stays clean — don't invent a placeholder that would
      // read as a grade to the model.
      expect(text).not.toMatch(/raw — Ungraded.*\[[A-F]\]/);
    });
  });

  // The grade cache written by `yaw-mcp audit` is the ONLY supplier of
  // `complianceGrade` in local mode: bundles.json entries never carry one
  // (validateEntry drops unknown fields). Until start() overlaid it, every
  // server was permanently ungraded — which made YAW_MCP_MIN_COMPLIANCE inert
  // (ungraded always passes) and blanked the discover badge. These pin the
  // overlay by its EFFECT on gating, not by the field being set.
  describe("compliance grades hydrated from grades.json", () => {
    let gradesHome: string;

    function writeGrades(entries: Record<string, { grade: string; score: number; gradedAt: string }>): void {
      mkdirSync(join(gradesHome, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(join(gradesHome, CONFIG_DIRNAME, "grades.json"), JSON.stringify(entries, null, 2), "utf8");
    }

    const GRADE_D = { grade: "D", score: 41.2, gradedAt: "2026-06-11T00:00:00.000Z" };

    beforeEach(() => {
      gradesHome = mkdtempSync(join(tmpdir(), "yaw-mcp-srv-grades-"));
    });

    afterEach(() => {
      rmSync(gradesHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("gates a cache-graded server behind YAW_MCP_MIN_COMPLIANCE", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      writeGrades({ bad: GRADE_D });
      const priv = getPrivate(server);
      // No complianceGrade in the config — exactly what bundles.json yields.
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad Server" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "bad"');
      expect(text).toContain("grade D");
      expect(text).toContain("YAW_MCP_MIN_COMPLIANCE=B");
      // The gate must short-circuit before any upstream spawn.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("bad")).toBe(false);
    });

    it("without the overlay the same server reads as ungraded and passes the floor", async () => {
      // Pins WHY the bug was silent: absent the overlay, passesMinCompliance
      // sees `undefined` and fails open. If this ever starts refusing, the
      // fail-open-on-genuinely-ungraded policy changed and the test above is
      // no longer proving the overlay did the work.
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      writeGrades({ bad: GRADE_D });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad Server" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("bad", ["t"]));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("bad")).toBe(true);
    });

    it("renders the [A]-[F] discover badge from a cached grade", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      writeGrades({ gh: { grade: "A", score: 97.7, gradedAt: "2026-06-11T00:00:00.000Z" } });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      expect(priv.handleDiscover().content[0].text).toMatch(/gh — GitHub.*\[A\]/);
    });

    it("leaves servers absent from the cache ungraded", async () => {
      writeGrades({ other: GRADE_D });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      expect(priv.config.servers[0].complianceGrade).toBeUndefined();
    });

    it("degrades to ungraded when the cache is missing or garbage", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      // Missing file.
      await priv.hydrateComplianceGrades(gradesHome);
      expect(priv.config.servers[0].complianceGrade).toBeUndefined();

      // Present but not JSON — must not throw and must not blank the list.
      mkdirSync(join(gradesHome, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(join(gradesHome, CONFIG_DIRNAME, "grades.json"), "{{{ not json", "utf8");
      await expect(priv.hydrateComplianceGrades(gradesHome)).resolves.toBeUndefined();
      expect(priv.config.servers).toHaveLength(1);
      expect(priv.config.servers[0].complianceGrade).toBeUndefined();
    });
  });

  // Before the tool cache was persisted, `server.toolCache` was permanently
  // undefined, so prewarm classified EVERY active server as dormant and
  // re-spawned all of them (an `npx -y <pkg>@latest` resolve each) on every
  // client start. These pin that a known tool list suppresses the spawn.
  describe("persisted tool cache", () => {
    it("prewarm skips a server whose tools were hydrated from state.json", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({
        gh: { tools: [{ name: "create_issue", description: "open an issue" }], learnedAt: Date.now() },
      });

      await priv.prewarmDormantServers();

      expect(connectToUpstream).not.toHaveBeenCalled();
    });

    it("prewarm still spawns a server whose tools are unknown to both sources", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      await priv.prewarmDormantServers();

      expect(connectToUpstream).toHaveBeenCalledTimes(1);
    });

    it("hydrated tools make an inactive server deferred on the first tools/list", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({ gh: { tools: [{ name: "create_issue" }], learnedAt: 1_000 } });

      const deferred = priv.getDeferredServers();
      expect(deferred.map((s: UpstreamServerConfig) => s.namespace)).toEqual(["gh"]);
      expect(deferred[0].toolCache).toEqual([{ name: "create_issue" }]);
    });

    it("exportToolCache preserves the hydrated learnedAt so entries still age out", () => {
      const priv = getPrivate(server);
      priv.hydrateToolCache({ gh: { tools: [{ name: "create_issue" }], learnedAt: 12_345 } });

      expect(priv.exportToolCache()).toEqual({ gh: { tools: [{ name: "create_issue" }], learnedAt: 12_345 } });
    });

    it("a live activation refreshes the cache and stamps it with a fresh learnedAt", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({ gh: { tools: [{ name: "stale_tool" }], learnedAt: 1_000 } });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const before = Date.now();
      await priv.handleActivate(["gh"]);

      const exported = priv.exportToolCache();
      expect(exported.gh.tools.map((t: { name: string }) => t.name)).toEqual(["create_issue"]);
      expect(exported.gh.learnedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("shadow-driven install nudge", () => {
    let nudgeHome: string;

    // Point the scan at a synthetic home with a controlled .bash_history,
    // and an env with no APPDATA so only the bash source is read. The state
    // file (suppression) also lands under this synthetic home, so tests
    // never touch the developer's real ~/.yaw-mcp/ or shell history.
    function primeHistory(server: ConnectServer, lines: string[], extra: Record<string, string> = {}): void {
      writeFileSync(join(nudgeHome, ".bash_history"), `${lines.join("\n")}\n`, "utf8");
      const priv = getPrivate(server);
      priv.nudgeHome = nudgeHome;
      priv.nudgeEnv = { ...extra }; // no APPDATA -> PowerShell source skipped
      // The discover dedup cache is keyed on config/context/active-set, not
      // on nudge state — clear it so repeated handleDiscover() calls in one
      // test re-render instead of returning a stale cached block.
      priv.discoverCache = null;
    }

    // Repeat `tailscale` N times so its ShadowHit.count >= threshold (5).
    const HEAVY = (cli: string, n = 14): string[] => Array.from({ length: n }, () => `${cli} status`);

    beforeEach(() => {
      nudgeHome = mkdtempSync(join(tmpdir(), "yaw-mcp-srv-nudge-"));
    });

    afterEach(() => {
      rmSync(nudgeHome, { recursive: true, force: true });
    });

    it("OFF by default: scan never runs and output is byte-identical to a build without the feature", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Even with a heavy tailscale history present, the gate is off so
      // nothing is surfaced.
      primeHistory(server, HEAVY("tailscale"));
      priv.installNudge = false;

      const withFeatureOff = priv.handleDiscover().content[0].text;
      expect(withFeatureOff).not.toContain("Install candidates");
      expect(withFeatureOff).not.toContain("tailscale");

      // Byte-identical to a server whose nudgeHome points nowhere (scan
      // would find nothing) — proves the off path doesn't read history.
      priv.discoverCache = null;
      priv.nudgeHome = mkdtempSync(join(tmpdir(), "yaw-mcp-empty-"));
      const baseline = priv.handleDiscover().content[0].text;
      expect(withFeatureOff).toBe(baseline);
      rmSync(priv.nudgeHome, { recursive: true, force: true });
    });

    it("ON: surfaces a heavily-used first-party CLI as an install candidate", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      const text = priv.handleDiscover().content[0].text;
      expect(text).toContain("Install candidates (from your recent shell usage; history stays local):");
      expect(text).toContain("tailscale");
      expect(text).toContain("ran 14x recently");
      expect(text).toContain("install @yawlabs/tailscale-mcp");
      // The nudge points at the CLI, not a meta-tool: `yaw-mcp add <slug>`
      // is what actually writes ~/.yaw-mcp/bundles.json.
      expect(text).toContain("run: yaw-mcp add tailscale");
      expect(text).not.toContain("mcp_connect_install");
    });

    it("never leaks a raw history line / argument into the nudge output", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      // Put a secret-looking argument in the history lines.
      const SECRET = "SUPERSECRETAUTHKEY-9f3a";
      primeHistory(
        server,
        Array.from({ length: 14 }, () => `tailscale up --authkey=${SECRET}`),
      );

      const text = priv.handleDiscover().content[0].text;
      // The CLI is surfaced …
      expect(text).toContain("tailscale");
      // … but the argument / raw command text NEVER appears.
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("--authkey");
      expect(text).not.toContain("tailscale up");
    });

    it("does NOT nudge a heavily-used CLI with no first-party target (kubectl/npm/ssh)", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, [...HEAVY("kubectl"), ...HEAVY("npm"), ...HEAVY("ssh")]);

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
      expect(text).not.toContain("kubectl");
    });

    it("does NOT nudge below the count threshold", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      // 4 runs < threshold of 5.
      primeHistory(server, HEAVY("tailscale", 4));

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
    });

    it("skips a CLI whose namespace is already installed (they already have it)", () => {
      const priv = getPrivate(server);
      // tailscale server IS installed/active — no nudge even with heavy usage.
      priv.config = makeConfig([makeServerConfig({ namespace: "tailscale", name: "Tailscale" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
    });

    it("per-CLI suppression: a second discover within the cooldown does not re-nudge", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      // First call surfaces it (and records the nudge to the state file).
      const first = priv.buildInstallCandidatesLines(priv.getProfiledActiveServers()).join("\n");
      expect(first).toContain("tailscale");

      // Second call within the cooldown is suppressed.
      const second = priv.buildInstallCandidatesLines(priv.getProfiledActiveServers()).join("\n");
      expect(second).toBe("");
    });
  });

  describe("per-tool load", () => {
    // `tools/list` is constructed by buildToolList(this.connections, …,
    // this.toolFilters). These tests drive handleToolCall so the full
    // activate → filter-apply → routes rebuild → list path is exercised
    // end-to-end, matching what a real MCP client would see.
    function listedUpstreamToolNames(priv: any): string[] {
      return buildToolList(priv.connections, priv.getDeferredServers(), priv.toolFilters)
        .map((t: { name: string }) => t.name)
        .filter((n: string) => !n.startsWith("mcp_connect_"));
    }

    it("activate without tools exposes every upstream tool (baseline)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.isError).toBeUndefined();
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_baz", "gh_foo"]);
    });

    it("activate with tools: ['foo'] only surfaces that one tool (others hidden)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      // Filter is persisted on the server for subsequent tools/list calls.
      expect(priv.toolFilters.get("gh")).toEqual(new Set(["foo"]));
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
    });

    it("re-activating the same namespace without tools clears the filter", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      // Both calls go through handleToolCall → activateOne; the second
      // hits the "already connected" early return but still has to
      // clear the filter so the list re-expands.
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);

      await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_foo"]);
    });

    it("dispatch path still routes filtered-out tools (raw upstream reachable)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["foo", "bar"]);
      // The filtered-out tool `bar` must still reach the upstream.
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "bar called" }] });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      // `gh_bar` is absent from tools/list …
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
      // … but the route map still carries it (dispatch path unchanged).
      expect(priv.toolRoutes.has("gh_bar")).toBe(true);

      // And handleToolCall on the hidden tool dispatches to the upstream.
      const callResult = await priv.handleToolCall("gh_bar", {});
      expect(callResult.isError).toBeUndefined();
      expect(callResult.content[0].text).toBe("bar called");
      expect(conn.client.callTool).toHaveBeenCalledWith({ name: "bar", arguments: {} });
    });

    it("discover() surfaces a 'filtered: K of N' indicator for filtered servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      const text = priv.handleDiscover().content[0].text;
      // Count reflects the filtered (exposed) tool set …
      expect(text).toContain("loaded (1 tools)");
      // … and the indicator shows how many are hidden behind the filter.
      expect(text).toContain("filtered: 1 of 3");
      // Session summary counts only exposed tools, not the full upstream.
      expect(text).toContain("1 loaded in this session, 1 tools in context");
    });

    it("multi-server activate ignores tools and clears any existing filter", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      // Pre-seed a filter on gh from an earlier single-server activate.
      priv.connections.set("gh", makeConnection("gh", ["foo", "bar"]));
      priv.toolFilters.set("gh", new Set(["foo"]));
      // Re-activate multi-server → filter must clear.
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("slack", ["send"]));

      await priv.handleToolCall("mcp_connect_activate", { servers: ["gh", "slack"], tools: ["foo"] });

      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(priv.toolFilters.has("slack")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_foo", "slack_send"]);
    });

    it("deactivating a server also drops its filter", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh", ["foo", "bar"]));
      priv.toolFilters.set("gh", new Set(["foo"]));

      await priv.handleDeactivate(["gh"]);
      expect(priv.toolFilters.has("gh")).toBe(false);
    });
  });

  describe("handleDeactivate", () => {
    it("returns error when no namespaces provided", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate([]);
      expect(result.isError).toBe(true);
    });

    it("reports when server is not loaded (idempotent -- not an error)", async () => {
      // Already-unloaded is a no-op success, not an error, so idempotent
      // callers don't have to special-case "wasn't loaded" responses.
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate(["unknown"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("wasn't loaded");
    });

    it("unloads a loaded server", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.idleCallCounts.set("gh", 5);

      const result = await priv.handleDeactivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Unloaded "gh"');
      expect(priv.connections.has("gh")).toBe(false);
      expect(priv.idleCallCounts.has("gh")).toBe(false);
      expect(disconnectFromUpstream).toHaveBeenCalledWith(conn);
    });

    it("deactivates multiple servers", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const result = await priv.handleDeactivate(["gh", "slack"]);
      expect(priv.connections.size).toBe(0);
      expect(result.content[0].text).toContain("gh");
      expect(result.content[0].text).toContain("slack");
    });

    it("fix#4: deactivating a mix of loaded and already-unloaded succeeds (idempotent)", async () => {
      // The tool is annotated idempotent; returning isError for an
      // already-unloaded namespace breaks retry loops. A mixed call
      // (one loaded, one not) must succeed overall.
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      // "slack" is not loaded.

      const result = await priv.handleDeactivate(["gh", "slack"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Unloaded");
      expect(result.content[0].text).toContain("wasn't loaded");
    });

    it("fix#4: deactivating only already-unloaded namespaces succeeds (idempotent)", async () => {
      const priv = getPrivate(server);
      // Nothing is loaded.
      const result = await priv.handleDeactivate(["ghost"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("wasn't loaded");
    });
  });

  describe("trackUsageAndAutoDeactivate", () => {
    it("resets idle count for called server", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.idleCallCounts.set("gh", 5);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.idleCallCounts.get("gh")).toBe(0);
    });

    it("increments idle count for other servers", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      priv.idleCallCounts.set("slack", 0);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.idleCallCounts.get("gh")).toBe(0);
      expect(priv.idleCallCounts.get("slack")).toBe(1);
    });

    it("auto-deactivates servers at idle threshold", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      // Set slack to threshold - 1; the next increment will trigger deactivation
      priv.idleCallCounts.set("slack", resolveIdleThreshold() - 1);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(false);
      expect(priv.idleCallCounts.has("slack")).toBe(false);
      expect(disconnectFromUpstream).toHaveBeenCalled();
    });

    it("does not deactivate servers below threshold", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      priv.idleCallCounts.set("slack", 3);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(true);
    });

    it("records called namespace in rolling history", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.recentToolCalls.length).toBe(1);
      expect(priv.recentToolCalls[0].namespace).toBe("gh");
      expect(typeof priv.recentToolCalls[0].at).toBe("number");
    });

    it("gives a bursty namespace adaptive patience past the baseline", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const baseline = resolveIdleThreshold();
      const now = Date.now();
      // Seed history with recent slack activity so slack has earned
      // adaptive patience. 5 recent calls → bonus 10 → threshold 20.
      for (let i = 0; i < 5; i++) {
        priv.recentToolCalls.push({ namespace: "slack", at: now - i * 1000 });
      }
      // Push slack one tick away from the STATIC baseline.
      priv.idleCallCounts.set("slack", baseline - 1);

      await priv.trackUsageAndAutoDeactivate("gh");

      // Slack now sits at exactly baseline idle calls, but the
      // adaptive threshold is higher — it should stay connected.
      expect(priv.connections.has("slack")).toBe(true);
      expect(priv.idleCallCounts.get("slack")).toBe(baseline);
    });

    it("still deactivates a bursty namespace once idle exceeds adaptive cap", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const now = Date.now();
      // Give slack some recent activity (earns adaptive patience).
      for (let i = 0; i < 3; i++) {
        priv.recentToolCalls.push({ namespace: "slack", at: now - i * 1000 });
      }
      // Set slack way over the adaptive ceiling (50) so it's definitely toast.
      priv.idleCallCounts.set("slack", 60);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(false);
    });
  });

  describe("handleHealth", () => {
    it("returns empty message when no connections", () => {
      const priv = getPrivate(server);
      const result = priv.handleHealth();
      expect(result.content[0].text).toContain("No servers loaded in this session");
    });

    it("shows health stats for active connections", () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.health = { totalCalls: 10, errorCount: 2, totalLatencyMs: 500 };
      priv.connections.set("gh", conn);
      priv.idleCallCounts.set("gh", 3);

      const result = priv.handleHealth();
      const text = result.content[0].text;
      expect(text).toContain("gh [connected]");
      expect(text).toContain("calls: 10, errors: 2 (20%)");
      expect(text).toContain("avg latency: 50ms");
      expect(text).toContain("idle: 3/");
    });

    it("shows last error when present", () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh");
      conn.health = {
        totalCalls: 5,
        errorCount: 1,
        totalLatencyMs: 100,
        lastErrorMessage: "timeout",
        lastErrorAt: "2026-01-01T00:00:00Z",
      };
      priv.connections.set("gh", conn);

      const result = priv.handleHealth();
      expect(result.content[0].text).toContain("last error: timeout at 2026-01-01T00:00:00Z");
    });

    describe("cross-session reliability block", () => {
      it("surfaces a flaky dormant namespace from persisted learning", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          flaky: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() - 60_000 },
        });

        const result = priv.handleHealth();
        const text = result.content[0].text;
        expect(text).toContain("Cross-session reliability (dormant, <80% success):");
        expect(text).toContain("flaky — 10 calls, 50% success, last used");
      });

      it("skips namespaces currently loaded (in-session block covers them)", () => {
        const priv = getPrivate(server);
        const conn = makeConnection("gh");
        conn.health = { totalCalls: 10, errorCount: 5, totalLatencyMs: 100 };
        priv.connections.set("gh", conn);
        priv.learning.loadSnapshot({
          gh: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("skips namespaces with fewer than 3 dispatches", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          rare: { dispatched: 2, succeeded: 0, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("skips namespaces at or above 80% success", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          solid: { dispatched: 10, succeeded: 9, lastUsedAt: Date.now() },
          perfect: { dispatched: 5, succeeded: 5, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("sorts worst success rate first, then highest dispatched, then alpha", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          zeta: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
          alpha: { dispatched: 20, succeeded: 10, lastUsedAt: Date.now() },
          worst: { dispatched: 5, succeeded: 1, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        const text = result.content[0].text;
        const worstIdx = text.indexOf("worst ");
        const alphaIdx = text.indexOf("alpha ");
        const zetaIdx = text.indexOf("zeta ");
        expect(worstIdx).toBeGreaterThan(-1);
        expect(worstIdx).toBeLessThan(alphaIdx);
        expect(alphaIdx).toBeLessThan(zetaIdx);
      });

      it("caps the list at 5 entries", () => {
        const priv = getPrivate(server);
        const snapshot: Record<string, { dispatched: number; succeeded: number; lastUsedAt: number }> = {};
        for (let i = 0; i < 8; i++) {
          snapshot[`ns${i}`] = { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() };
        }
        priv.learning.loadSnapshot(snapshot);

        const result = priv.handleHealth();
        const text = result.content[0].text;
        const matches = text.match(/^ {2}ns\d+ — /gm) ?? [];
        expect(matches).toHaveLength(5);
      });

      it("stays silent when no dormant namespace qualifies", () => {
        const priv = getPrivate(server);
        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });
    });
  });

  describe("discover usage hints", () => {
    it("surfaces a success count from the learning store", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Three successful dispatches — enough for the hint to show.
      priv.learning.recordSuccess("gh");
      priv.learning.recordSuccess("gh");
      priv.learning.recordSuccess("gh");

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("usage: used 3x");
    });

    it("surfaces co-usage peers from the pack detector", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      // Two bursts of (gh, linear) — enough for a detected pack.
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain('often loaded with "linear"');
      expect(result.content[0].text).toContain('often loaded with "gh"');
    });

    it("stays silent when neither signal has evidence", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("usage:");
    });

    it("surfaces a reliability warning for a flaky dormant server", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.learning.loadSnapshot({
        gh: { dispatched: 10, succeeded: 3, lastUsedAt: Date.now() },
      });

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("reliability: 30% success across 10 past calls");
    });

    it("suppresses the reliability warning for currently-loaded servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.learning.loadSnapshot({
        gh: { dispatched: 10, succeeded: 3, lastUsedAt: Date.now() },
      });
      priv.connections.set("gh", makeConnection("gh"));

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("reliability:");
    });
  });

  describe("discover recurring-packs block", () => {
    it("surfaces an actionable pack with a ready-to-run activate call", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      // Two bursts of (gh, linear) → one detected pack.
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      const text = result.content[0].text;
      expect(text).toContain("Recurring packs");
      expect(text).toContain("seen 2x");
      // Both namespaces appear, ready-to-run namespaces=["..","..."] verbatim.
      expect(text).toMatch(/namespaces=\[.*"gh".*"linear".*\]|namespaces=\[.*"linear".*"gh".*\]/);
    });

    it("omits the block when every pack is already fully loaded", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);
      // Already connected — no action for the LLM to take.
      priv.connections.set("gh", { ...makeConnection("gh"), status: "connected" });
      priv.connections.set("linear", { ...makeConnection("linear"), status: "connected" });

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("Recurring packs");
    });

    it("omits the block when any pack namespace isn't installed", async () => {
      const priv = getPrivate(server);
      // `linear` is NOT in the installed set, so the {gh, linear} pack
      // can't be activated as a whole — don't advertise it.
      priv.config = makeConfig([makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" })]);
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "t", t0);
      priv.packDetector.recordCall("linear", "t", t0 + 1000);
      priv.packDetector.recordCall("gh", "t", t0 + 300_000);
      priv.packDetector.recordCall("linear", "t", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("Recurring packs");
    });
  });

  describe("concurrent server cap", () => {
    it("refuses a new activation when already at cap", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      priv.connections.set("b", makeConnection("b"));

      const result = await priv.handleActivate(["c"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot load "c"');
      expect(result.content[0].text).toContain("2-server concurrent cap");
      // The blocked server must not have spawned an upstream.
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(priv.connections.has("c")).toBe(false);
    });

    it("cap refusal beside a successful load is informational (isError undefined)", async () => {
      // One namespace loads (filling the last cap slot), the next is
      // cap-refused. The call did useful work, so the cap message stays
      // informational -- only an all-refused call signals isError.
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      vi.mocked(connectToUpstream).mockResolvedValue(makeConnection("b"));

      const result = await priv.handleActivate(["b", "c"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Cannot load "c"');
      expect(priv.connections.has("b")).toBe(true);
      expect(priv.connections.has("c")).toBe(false);
    });

    it("allows reactivating an already-loaded namespace even at cap", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      priv.connections.set("b", makeConnection("b"));

      const result = await priv.handleActivate(["a"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('"a" is already loaded');
    });

    it("ignores error-state connections when counting slots", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      // "b" is in error-state — it's not contributing tools, so it must
      // NOT count toward the cap. Otherwise a one-time connection
      // failure permanently burns a slot.
      priv.connections.set("b", makeConnection("b", [], "error"));
      const connC = makeConnection("c", ["t"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(connC);

      const result = await priv.handleActivate(["c"]);
      expect(result.isError).toBeUndefined();
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    });

    it("permits unlimited loads when cap is 0", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 0;
      priv.config = makeConfig([makeServerConfig({ id: "99", namespace: "big" })]);
      // Pre-load 20 servers. Cap of 0 should not care.
      for (let i = 0; i < 20; i++) {
        priv.connections.set(`pre${i}`, makeConnection(`pre${i}`));
      }
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("big", ["t"]));

      const result = await priv.handleActivate(["big"]);
      expect(result.isError).toBeUndefined();
    });

    it("two distinct namespaces activating concurrently do not overshoot the cap", async () => {
      // TOCTOU guard: the existing cap tests pre-seed connections
      // synchronously, so they never exercise the pendingActivations
      // reservation. Here "a" is held mid-`await connectToUpstream` (its
      // connect promise stays pending), so its slot only exists as a
      // reservation in pendingActivations — not yet in this.connections.
      // With cap=1, "b" racing the check must see that reservation and be
      // refused. Without the pendingActivations counting (server.ts
      // 2077-2084) both would pass the check against the same empty
      // connected set and connect, overshooting the cap.
      const priv = getPrivate(server);
      priv.serverCap = 1;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
      ]);

      // Hold "a"'s upstream connect open so its reservation sits in
      // pendingActivations while "b" races the cap check.
      let resolveA: (conn: UpstreamConnection) => void = () => {};
      const aPromise = new Promise<UpstreamConnection>((r) => {
        resolveA = r;
      });
      vi.mocked(connectToUpstream).mockReturnValueOnce(aPromise);

      const pA = priv.activateOne("a");
      // "a" reserved its slot synchronously — before the first await —
      // even though no connection exists in the map yet.
      expect(priv.pendingActivations.has("a")).toBe(true);
      expect(priv.connections.has("a")).toBe(false);

      // "b" races against a full cap (the pending reservation occupies the
      // single slot) and must be refused as capped.
      const rB = await priv.activateOne("b");
      expect(rB.ok).toBe(false);
      expect(rB.capped).toBe(true);
      // "b" never spawned an upstream — only "a"'s connect fired.
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.has("b")).toBe(false);

      // Let "a" finish; it claims the one and only slot.
      resolveA(makeConnection("a", ["t"]));
      const rA = await pA;
      expect(rA.ok).toBe(true);
      expect(priv.connections.has("a")).toBe(true);

      // Total connected never exceeded the cap of 1.
      const connectedCount = [...priv.connections.values()].filter(
        (c: UpstreamConnection) => c.status === "connected",
      ).length;
      expect(connectedCount).toBe(1);
    });
  });

  describe("handleReadTool", () => {
    it("rejects a missing server arg", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleReadTool("", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`server` is required");
    });

    it("rejects a missing tool arg", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleReadTool("gh", "");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`tool` is required");
    });

    it("returns a helpful error when the server is not installed", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("is not in ~/.yaw-mcp/bundles.json");
    });

    it("reads the schema from a loaded server without reconnecting", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.tools[0].description = "Create a new issue.";
      priv.connections.set("gh", conn);

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
      expect(result.content[0].text).toContain("Server: GitHub (gh)");
      expect(result.content[0].text).toContain("Create a new issue.");
      // Loaded-server path must NOT trigger a transient connect.
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
    });

    it("accepts the namespaced tool form", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      const result = await priv.handleReadTool("gh", "gh_create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
    });

    it("reports tool-not-found with available tools as a hint", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["close_issue", "create_issue"]));

      const result = await priv.handleReadTool("gh", "nope");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('"nope" not found on "gh"');
      expect(result.content[0].text).toContain("close_issue");
      expect(result.content[0].text).toContain("create_issue");
    });

    it("transiently connects when the server is installed but not loaded, then disconnects", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const transient = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(transient);

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
      expect(result.content[0].text).toContain("not currently loaded");
      // The transient connection must be torn down and never registered.
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("surfaces a clean error when the transient connect fails", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("spawn ENOENT npx"));

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("spawn ENOENT npx");
      expect(priv.connections.has("gh")).toBe(false);
    });
  });

  describe("handleToolCall", () => {
    it("routes meta-tool discover", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("routes meta-tool health", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("mcp_connect_health", {});
      expect(result.content[0].text).toContain("No servers loaded in this session");
    });

    it("routes meta-tool activate", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.content[0].text).toContain('Loaded "gh"');
    });

    it("routes meta-tool deactivate", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      const result = await priv.handleToolCall("mcp_connect_deactivate", { server: "gh" });
      expect(result.content[0].text).toContain('Unloaded "gh"');
    });

    it("routes meta-tool read_tool", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      const result = await priv.handleToolCall("mcp_connect_read_tool", { server: "gh", tool: "create_issue" });
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
    });

    it("routes upstream tool calls and tracks health", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Issue created" }],
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("gh_create_issue", { title: "test" });
      expect(result.content[0].text).toBe("Issue created");
      expect(conn.health.totalCalls).toBe(1);
      expect(conn.health.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks error health on failed tool calls", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockRejectedValue(new Error("upstream failed"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(conn.health.errorCount).toBe(1);
      expect(conn.health.lastErrorMessage).toBeDefined();
    });

    it("attempts auto-reconnect for errored connections", async () => {
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const freshConn = makeConnection("gh", ["create_issue"]);
      freshConn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Success after reconnect" }],
      });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(freshConn);

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(disconnectFromUpstream).toHaveBeenCalledWith(errorConn);
      expect(connectToUpstream).toHaveBeenCalled();
      expect(result.content[0].text).toBe("Success after reconnect");
    });

    it("returns error when auto-reconnect fails", async () => {
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      vi.mocked(connectToUpstream)
        .mockRejectedValueOnce(new Error("still down"))
        .mockRejectedValueOnce(new Error("still down"));

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("auto-reconnect failed");
      expect(result.content[0].text).toContain("still down");
      // The structural brand is what keeps this fault out of the health /
      // learning booking -- pin it on the REAL result, not a typed string.
      expect(isRoutingFaultResult(result)).toBe(true);
    });

    it("returns error for unknown tools", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("nonexistent_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("every routing-fault message is recognized by isRoutingFaultText", async () => {
      // handleExec attributes step blame by substring-matching these
      // markers. Two of the four messages are produced in proxy.ts, so a
      // reword there (out of server.ts's reach) would silently start
      // penalizing an upstream for yaw-mcp's own routing miss. Pin the
      // real strings, not the constants alone.
      const priv = getPrivate(server);

      // 1. Unknown tool (proxy.ts). Both the pinned text AND the
      // structural brand (the authoritative booking signal) must hold.
      const unknown = await priv.handleToolCall("nonexistent_tool", {});
      expect(unknown.content[0].text).toContain(ROUTING_FAULT_UNKNOWN_TOOL);
      expect(isRoutingFaultText(unknown.content[0].text)).toBe(true);
      expect(isRoutingFaultResult(unknown)).toBe(true);

      // 2. Route survives but the connection is gone (proxy.ts).
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      priv.rebuildRoutes();
      priv.connections.delete("gh");
      const gone = await priv.handleToolCall("gh_create_issue", {});
      expect(gone.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(isRoutingFaultText(gone.content[0].text)).toBe(true);
      expect(isRoutingFaultResult(gone)).toBe(true);

      // 3. Auto-reconnect exhausted (server.ts) -- covered by the
      // "returns error when auto-reconnect fails" case above; assert the
      // marker predicate agrees with the phrasing it asserts.
      expect(isRoutingFaultText('Server "gh" disconnected and auto-reconnect failed: still down.')).toBe(true);

      // 4. Deferred first-call load failure (server.ts). An activation
      // result, which is deliberately never a learning signal -- without
      // this marker, an exec step landing on a deferred route whose load
      // fails (including a server-cap or compliance refusal) was booked
      // as a 0.0 outcome against a server that never got to run.
      expect(isRoutingFaultText('Server "gh" could not be loaded on first call: spawn failed.')).toBe(true);

      // Negative control: a genuine upstream failure is NOT a routing fault.
      expect(isRoutingFaultText("GITHUB_TOKEN is invalid")).toBe(false);
    });

    it("a routing-fault error on the direct path books no learning outcome or redispatch reply", async () => {
      // Reproduce the reaper/prewarm teardown window: the route snapshot
      // still resolves but the connection is gone, so routeToolCall
      // returns the ROUTING_FAULT_DISCONNECTED text. That is yaw-mcp's
      // own fault -- booking it as a 0.0 outcome (the old behavior) sank
      // a healthy server's reliability for a fault the ROUTING_FAULT_*
      // comment promises is never counted against it.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      priv.rebuildRoutes();
      priv.connections.delete("gh");
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const markUse = vi.spyOn(priv.redispatch, "markUse");
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(priv.learning.get("gh")).toBeUndefined();
      expect(markReply).not.toHaveBeenCalled();
      // Not graded, but still USAGE: markUse keeps a graded-clean record
      // from freezing into a detectMiss "loser" over yaw-mcp's own fault.
      expect(markUse).toHaveBeenCalledWith("gh");
    });

    it("a routing fault on a still-registered connection is a health NON-observation", async () => {
      // The connection is still in the map (status "error") but its config
      // entry is gone, so the reconnect branch is skipped and routeToolCall
      // returns the branded DISCONNECTED fault while connForHealth is
      // non-null. The fault must book NOTHING on health: not an error (the
      // original bug), and not a call either -- a call-without-error is a
      // success-shaped observation that dilutes a flaky server's error
      // rate and drags its latency toward 0ms.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      priv.config = makeConfig([]);
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(conn.health.totalCalls).toBe(0);
      expect(conn.health.errorCount).toBe(0);
      expect(conn.health.totalLatencyMs).toBe(0);
      expect(conn.health.lastErrorMessage).toBeUndefined();
    });

    it("tool-gone-after-activation carries the routing-fault brand", async () => {
      // A deferred route for a tool the (already-connected) upstream no
      // longer exposes: activation is a no-op, the rebuild drops the stale
      // route, and the TOOL_GONE fault is emitted. It is yaw-mcp's stale
      // cache, not the upstream's failure -- brand + no booking.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.toolRoutes = new Map([
        ["gh_renamed_tool", { namespace: "gh", originalName: "renamed_tool", deferred: true }],
      ]);
      const result = await priv.handleToolCall("gh_renamed_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no longer available");
      // Only the brand is asserted here: this fault returns BEFORE the
      // direct-path booking block, so "no booking" is vacuous on the direct
      // path. Where the brand is load-bearing for an early-return fault is
      // exec's step attribution -- see the two exec tests below.
      expect(isRoutingFaultResult(result)).toBe(true);
    });

    it("exec step attribution skips a branded early-return fault (tool gone after activation)", async () => {
      // handleExec books its OWN outcome per step after handleToolCall
      // returns, so an early-return fault that never reaches the direct-path
      // booking block IS booked here unless the brand says otherwise. This
      // test fails only if the exec brand check is DROPPED outright -- every
      // branded fault's text also carries a marker phrase, so a revert to
      // the old text sniff ALSO skips booking here and passes. The
      // text-sniff revert is caught by the next test (an upstream error
      // that merely CONTAINS a marker phrase must still book); the two
      // tests are a pair and both must stay.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.toolRoutes = new Map([
        ["gh_renamed_tool", { namespace: "gh", originalName: "renamed_tool", deferred: true }],
      ]);
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_renamed_tool", args: {} }],
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.failedStep).toBe("a");
      expect(parsed.error).toContain("no longer available");
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("concurrent calls during auto-reconnect share ONE activation (no spurious error, no double spawn)", async () => {
      // The reconnect now routes through activateOne, whose in-flight dedup
      // is the guarantee the old inline connectToUpstream path lacked: two
      // tool calls landing on an error-state upstream used to each spawn a
      // child (or, in production, the second got a spurious "no longer
      // connected" error while yaw-mcp was itself mid-reconnect).
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      let release!: (c: ReturnType<typeof makeConnection>) => void;
      const gate = new Promise<ReturnType<typeof makeConnection>>((r) => {
        release = r;
      });
      const fresh = makeConnection("gh", ["create_issue"]);
      fresh.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      vi.mocked(connectToUpstream).mockImplementation(() => gate as never);
      // Mirror the PRODUCTION disconnect: flip status synchronously
      // (upstream.ts does exactly this before awaiting close). With the old
      // disconnect-first ordering, this flip made every concurrent caller
      // skip the reconnect branch and take a spurious "no longer connected"
      // fault -- the default resolved-undefined mock could never catch that.
      vi.mocked(disconnectFromUpstream).mockImplementation(async (c: UpstreamConnection) => {
        c.status = "disconnected";
      });
      const refresh = vi.spyOn(priv, "refreshRoutesAndNotify");
      const p1 = priv.handleToolCall("gh_create_issue", {});
      const p2 = priv.handleToolCall("gh_create_issue", {});
      // Let both callers reach the reconnect await before the spawn lands,
      // then fire a THIRD caller mid-spawn: the stale entry must still read
      // status "error" (the disconnect happens after activation), so it
      // joins the shared inflight instead of erroring.
      await new Promise((r) => setTimeout(r, 20));
      const p3 = priv.handleToolCall("gh_create_issue", {});
      await new Promise((r) => setTimeout(r, 20));
      release(fresh);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(r3.isError).toBeFalsy();
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      // The orphaned stale transport was closed (idempotently -- each
      // caller's identity check sees the map already holds the fresh conn).
      expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledWith(errorConn);
      // And the live connection was never closed.
      expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalledWith(fresh);
      // ONE routes rebuild serves all sharers: rebuilding per sharer
      // emitted N x three list_changed notifications for one reconnect.
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("an activate landing in a teardown window (status disconnected) gets no cap self-allowance", async () => {
      // "disconnected" only exists mid-teardown (prewarm teardown, idle
      // reaper, deactivate all flip it and then await the close before
      // deleting the map entry): the slot is being RELEASED, so an
      // activate in that window must queue behind the cap like a fresh
      // activation. Only an "error" entry -- a granted slot whose
      // transport died -- rides the self-allowance (see the reconnect-at-
      // full-cap test).
      const priv = getPrivate(server);
      priv.serverCap = 1;
      priv.connections.set("busy", makeConnection("busy", ["t"])); // holds the only slot
      const tearingDown = makeConnection("gh", ["create_issue"]);
      tearingDown.status = "disconnected" as never;
      priv.connections.set("gh", tearingDown);
      priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
      const result = await priv.activateOne("gh");
      expect(result.ok).toBe(false);
      expect(result.capped).toBe(true);
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    });

    it("auto-reconnect succeeds at a FULL cap (the namespace already owns its slot)", async () => {
      // A dead connection represents a slot that was already granted:
      // refusing the respawn at a full cap would strand a legitimately
      // loaded server in its error state, with a refusal message pointing
      // at mcp_connect_activate -- which would refuse identically.
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.connections.set("other", makeConnection("other", ["t"]));
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "other" }), makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const fresh = makeConnection("gh", ["create_issue"]);
      fresh.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(fresh);
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("ok");
    });

    it("auto-reconnect refuses after shutdown has latched (no spawn)", async () => {
      // The old inline path ignored the shuttingDown latch; through
      // activateOne a reconnect during shutdown is refused before any
      // child is spawned into the torn-down bookkeeping.
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      priv.shuttingDown = true;
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("auto-reconnect failed");
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    });

    it("a non-string discover context is ignored instead of throwing", async () => {
      // The low-level Server never validates input against inputSchema, so
      // a misbehaving client can send context: 123. It must degrade to an
      // unranked discover, not a TypeError inside the BM25 tokenizer
      // surfacing as a raw JSON-RPC internal error.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const result = await priv.handleToolCall("mcp_connect_discover", { context: 123 });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("gh");
    });

    it("tool-gone-after-RECONNECT carries the routing-fault brand", async () => {
      // The fifth emitter: auto-reconnect SUCCEEDS but the fresh upstream
      // no longer exposes the requested tool ("no longer available after
      // reconnecting"). Removing brandRoutingFault from that emitter left
      // the whole suite green -- this pins it on the real result.
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["other_tool"]));
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("after reconnecting");
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("exec step attribution still books an upstream error that merely CONTAINS a marker phrase", async () => {
      // The exec counterpart of the direct-path brand test: a genuine
      // upstream error whose text includes "no longer available" carries no
      // brand, so the step is the server's own failure and books 0.0.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["get_resource"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "This resource is no longer available (deleted by owner)." }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_get_resource", args: {} }],
      });
      expect(result.isError).toBe(true);
      expect(priv.learning.get("gh")).toMatchObject({ dispatched: 1, succeeded: 0 });
    });

    it("an upstream error that merely CONTAINS a marker phrase is still booked (brand, not text)", async () => {
      // The routing-fault guard is structural: only results yaw-mcp's own
      // routing layer constructed carry the brand. A genuine upstream
      // error whose text happens to include "no longer available" must
      // still count against the upstream's health and learning -- a text
      // sniff here would let real failures accumulate invisibly.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["get_resource"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "This resource is no longer available (deleted by owner)." }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const result = await priv.handleToolCall("gh_get_resource", {});
      expect(result.isError).toBe(true);
      expect(isRoutingFaultResult(result)).toBe(false);
      expect(priv.learning.get("gh")).toMatchObject({ dispatched: 1, succeeded: 0 });
      expect(conn.health.errorCount).toBe(1);
      expect(markReply).toHaveBeenCalledWith("gh", false);
    });

    it('exportToolCache preserves a "__proto__" namespace as an own key', () => {
      // sanitizeToolCache/hydrateToolCache preserve a "__proto__" toolCache
      // namespace on load; the export side must not undo that one flush
      // later via the inherited setter (same shape as learning's
      // exportSnapshot hardening).
      const priv = getPrivate(server);
      priv.toolCache.set("__proto__", [{ name: "t", namespacedName: "__proto___t", inputSchema: {} }]);
      priv.toolCacheLearnedAt.set("__proto__", 123);
      const out = priv.exportToolCache();
      expect(Object.hasOwn(out, "__proto__")).toBe(true);
      const roundTripped = JSON.parse(JSON.stringify(out));
      expect(Object.getOwnPropertyDescriptor(roundTripped, "__proto__")?.value.learnedAt).toBe(123);
    });

    it("exec steps mark redispatch replies on the dispatched namespace", async () => {
      // markReply must run OUTSIDE the deferLearning guard: exec steps are
      // real usage even though their learning credit is attributed per
      // step by handleExec. When they were skipped, a direct-call-then-
      // exec sequence left the namespace's dispatch record frozen as
      // cleanReply-without-furtherUse, and detectMiss flagged the server
      // as an abandoned "loser" on the next similar dispatch.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "created #1" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_create_issue", args: {} }],
      });
      expect(result.isError).toBeFalsy();
      expect(markReply).toHaveBeenCalledWith("gh", true);
    });

    it("auto-activates a deferred upstream on first tools/call and re-dispatches", async () => {
      // v0.13: the LLM sees gh_create_issue in tools/list because we
      // advertised it from toolCache before activation. When the LLM
      // calls it, we activate gh, rebuild routes, notify list_changed,
      // then re-dispatch through the fresh (non-deferred) route.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", toolCache: [{ name: "create_issue", description: "cached" }] }),
      ]);
      priv.rebuildRoutes();
      // Pre-call sanity: the route is a deferred placeholder.
      expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBe(true);

      const freshConn = makeConnection("gh", ["create_issue"]);
      freshConn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "issue created post-activation" }],
      });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(freshConn);

      const result = await priv.handleToolCall("gh_create_issue", { title: "hi" });
      expect(connectToUpstream).toHaveBeenCalled();
      expect(result.content[0].text).toBe("issue created post-activation");
      // Post-activation the route is live (no deferred flag).
      expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
    });

    it("surfaces activation failure when a deferred tool can't connect", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", toolCache: [{ name: "create_issue" }] })]);
      priv.rebuildRoutes();

      vi.mocked(connectToUpstream)
        .mockRejectedValueOnce(new Error("spawn failed"))
        .mockRejectedValueOnce(new Error("spawn failed"));

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("could not be loaded");
      // Activation is never a learning signal: the deferred-load failure
      // must carry the routing-fault brand so exec's step attribution and
      // the direct-path booking both skip it.
      expect(isRoutingFaultResult(result)).toBe(true);
    });

    it("records successful proxied calls into the pack detector", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      const history = priv.packDetector.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].namespace).toBe("gh");
      expect(history[0].toolName).toBe("create_issue");
    });

    it("does not record errored proxied calls into the pack detector", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockRejectedValue(new Error("upstream failed"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      expect(priv.packDetector.getHistory().length).toBe(0);
    });

    it("does not record meta-tool calls into the pack detector", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      await priv.handleToolCall("mcp_connect_discover", {});
      await priv.handleToolCall("mcp_connect_health", {});
      expect(priv.packDetector.getHistory().length).toBe(0);
    });

    it("records each successful proxied tool call as dispatched + succeeded in learning", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      await priv.handleToolCall("gh_create_issue", {});
      const usage = priv.learning.get("gh");
      expect(usage?.dispatched).toBe(2);
      expect(usage?.succeeded).toBe(2);
    });

    it("counts upstream isError responses toward dispatched but NOT succeeded", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      // Upstream returns a structured error response (not a transport
      // throw) — isError: true is the upstream's own assessment.
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "validation failed" }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      const usage = priv.learning.get("gh");
      expect(usage?.dispatched).toBe(1);
      expect(usage?.succeeded).toBe(0);
    });

    it("does not record activation alone as a learning signal", async () => {
      // handleDispatch activates a winner; previously that incremented
      // both dispatched and succeeded, masking flaky tool-call paths.
      // Tool-call success is now the only learning input.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      await priv.handleDispatch("github issue", 1);
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("dispatch records loaded namespaces in sessionActivated so gateway mode advertises them", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      expect(priv.sessionActivated.has("gh")).toBe(false);
      await priv.handleDispatch("github issue", 1);
      // Without this, the tools/list_changed dispatch fires changes nothing
      // under the default gateway exposure: the loaded tools stay
      // unadvertised, and the response's "tools are now callable" promise
      // is false for any client that can only invoke advertised tools.
      expect(priv.sessionActivated.has("gh")).toBe(true);
    });

    it("dispatch does NOT record a namespace whose activation failed", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Persistent rejection: runActivateOne retries once, and a
      // ...Once mock would hand the retry a default-resolved undefined.
      vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

      await priv.handleDispatch("github issue", 1);
      // Success-only, mirroring handleActivate.
      expect(priv.sessionActivated.has("gh")).toBe(false);
    });

    it("discover auto-warm records the warmed namespace in sessionActivated", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Rank decisively so the auto-warm gate fires without depending on
      // BM25 scoring internals.
      vi.spyOn(priv, "twoStageRank").mockResolvedValue([{ namespace: "gh", score: 5 }]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      await priv.handleDiscoverWithAutoWarm("github issue");
      // Auto-warm exists so a one-shot discover(context) is enough to
      // start calling tools -- which requires the warmed namespace to be
      // advertised under the default gateway exposure.
      expect(priv.sessionActivated.has("gh")).toBe(true);
    });

    it("routes meta-tool suggest and returns friendly message with no patterns", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("mcp_connect_suggest", {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("No recurring multi-server patterns yet");
    });

    it("routes meta-tool suggest and lists detected packs ranked by frequency", async () => {
      const priv = getPrivate(server);
      const t0 = 1_000_000;
      // Seed two bursts that each contain {gh, linear}
      priv.packDetector.recordCall("gh", "a", t0);
      priv.packDetector.recordCall("linear", "b", t0 + 1_000);
      priv.packDetector.recordCall("gh", "c", t0 + 5 * 60_000);
      priv.packDetector.recordCall("linear", "d", t0 + 5 * 60_000 + 1_000);

      const result = await priv.handleToolCall("mcp_connect_suggest", {});
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Detected 1 recurring server pack");
      expect(text).toContain("gh");
      expect(text).toContain("linear");
      expect(text).toContain("seen 2 times");
      // Must nudge toward `activate` (the loading meta-tool) and embed
      // the concrete namespaces from the top pack so the caller can run
      // it verbatim. `dispatch` is for invoking tools on already-active
      // servers — suggesting it here mis-directs the model.
      expect(text).toContain("mcp_connect_activate");
      expect(text).not.toContain("mcp_connect_dispatch");
      expect(text).toMatch(/namespaces=\[.*"gh".*"linear".*\]|namespaces=\[.*"linear".*"gh".*\]/);
    });

    it("routes meta-tool bundles and separates ready vs partial against installed servers", async () => {
      const priv = getPrivate(server);
      // Install github + linear + slack. pr-review (github+linear) must
      // surface as ready; devops-incident (github+pagerduty+slack) must
      // surface as partial with pagerduty missing.
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github" }),
        makeServerConfig({ namespace: "linear" }),
        makeServerConfig({ namespace: "slack" }),
      ]);
      const result = await priv.handleToolCall("mcp_connect_bundles", { action: "match" });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Bundles ready to activate now:");
      expect(text).toContain("pr-review");
      expect(text).toContain('activate: mcp_connect_activate({ servers: ["github","linear"] })');
      expect(text).toContain("Bundles partially installed:");
      expect(text).toContain("devops-incident");
      expect(text).toContain("missing: pagerduty");
      expect(text).toContain("yaw-mcp add ");
    });

    it("routes meta-tool exec through a two-step pipeline with $ref binding", async () => {
      // Exec threads the first tool's parsed output into the second
      // tool's args via {"$ref": "first"}. After fix #2 the step binding
      // holds the PARSED payload, not the raw MCP wrapper -- so a single-
      // text-item response whose text is a plain string binds as that
      // string directly, not as {content:[{type,text}]}.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      const callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: "42" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "PR #42 body" }] });
      conn.client.callTool = callTool;
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "first", tool: "gh_list_prs", args: {} },
          {
            id: "second",
            tool: "gh_get_pr",
            // After parseStepPayload: "first" is the string "42", not the
            // MCP wrapper. Ref directly to the step id.
            args: { number: { $ref: "first" } },
          },
        ],
        return: "second",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      // "second" step output: single text item -> parsed as string.
      expect(parsed.result).toBe("PR #42 body");
      // Both steps should have landed in the output map.
      expect(Object.keys(parsed.steps).sort()).toEqual(["first", "second"]);
      // The second upstream call must have received the resolved value,
      // not the raw $ref marker -- otherwise the resolver never fired.
      // "42" parses as the number 42 via JSON.parse, so number (not string).
      expect(callTool).toHaveBeenNthCalledWith(2, {
        name: "get_pr",
        arguments: { number: 42 },
      });
    });

    it("fails the whole pipeline and surfaces partial outputs when a step errors", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      conn.client.callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok step 1" }] })
        .mockRejectedValueOnce(new Error("upstream boom"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "first", tool: "gh_list_prs", args: {} },
          { id: "second", tool: "gh_get_pr", args: {} },
        ],
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.failedStep).toBe("second");
      expect(parsed.error).toContain("upstream boom");
      // The first step ran and its output survives in `partial` so the
      // caller knows how far the pipeline got before the failure.
      // After fix #2 the binding holds the parsed payload (string), not
      // the MCP wrapper.
      expect(parsed.partial.first).toBe("ok step 1");
      expect(parsed.partial.second).toBeUndefined();
    });

    it("enforces the MAX_EXEC_STEPS cap", async () => {
      const priv = getPrivate(server);
      // 17 steps — one over the cap of 16. Must reject before any call.
      const steps = Array.from({ length: 17 }, (_, i) => ({
        id: `s${i}`,
        tool: "gh_list_prs",
        args: {},
      }));
      const result = await priv.handleToolCall("mcp_connect_exec", { steps });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("too many steps");
    });

    it("fix#1: return can point to a positional-index key for unnamed steps", async () => {
      // validateExecRequest was only tracking explicit ids in seenIds, so
      // `return: "0"` for a step without an `id` always failed with
      // "unknown step id". The fix adds String(i) to allBindingKeys for
      // unnamed steps.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      // No `id` on the step; `return: "0"` uses the positional key.
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ tool: "gh_list_prs", args: {} }],
        return: "0",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("fix#2: parseStepPayload -- JSON text binds as parsed value", async () => {
      // When the upstream returns a single text item whose text is valid
      // JSON, the binding should hold the parsed object, not the wrapper.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      conn.client.callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify([{ number: 7 }]) }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ title: "bug fix" }) }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "list", tool: "gh_list_prs", args: {} },
          { id: "get", tool: "gh_get_pr", args: { number: { $ref: "list[0].number" } } },
        ],
        return: "get",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      // The parsed object from the second call.
      expect(parsed.result).toEqual({ title: "bug fix" });
      // The upstream received the resolved number from the first step.
      expect(conn.client.callTool).toHaveBeenNthCalledWith(2, {
        name: "get_pr",
        arguments: { number: 7 },
      });
    });

    it("fix#2: parseStepPayload -- non-JSON text binds as string", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "plain text" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_list_prs", args: {} }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.steps.a).toBe("plain text");
    });

    it("fix#2: parseStepPayload -- multi-content result binds as content array", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_list_prs", args: {} }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.steps.a)).toBe(true);
      expect(parsed.steps.a).toHaveLength(2);
    });
  });

  describe("shutdown", () => {
    it("disconnects all upstream connections", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      await server.shutdown();
      expect(disconnectFromUpstream).toHaveBeenCalledTimes(2);
      expect(priv.connections.size).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Concurrency and atomicity regression tests. These cover the races
// exposed by the review:
//   1. activateOne — two concurrent callers for the same namespace must
//      share one spawn, not race to double-spawn.
//   2. handleToolCall — the routes map captured at method entry must be
//      used for the actual call, even if rebuildRoutes fires during
//      the auto-reconnect awaits.
// ─────────────────────────────────────────────────────────────────────────
describe("activateOne dedup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("dedupes two concurrent activations of the same namespace to one spawn", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    // Hold the connectToUpstream promise open so both activateOne
    // callers can enqueue before the first resolves.
    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    const connectPromise = new Promise<UpstreamConnection>((r) => {
      resolveConnect = r;
    });
    vi.mocked(connectToUpstream).mockReturnValueOnce(connectPromise);

    const p1 = priv.activateOne("gh");
    const p2 = priv.activateOne("gh");

    // Both should be awaiting the same in-flight promise at this point.
    expect(priv.activationInflight.has("gh")).toBe(true);

    resolveConnect(makeConnection("gh", ["create_issue"]));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Critical: only ONE spawn happened despite two parallel activations.
    expect(connectToUpstream).toHaveBeenCalledTimes(1);
    // Map entry cleared after settle.
    expect(priv.activationInflight.has("gh")).toBe(false);
  });

  it("clears the inflight entry after failure so a later call can retry", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    vi.mocked(connectToUpstream).mockRejectedValue(new Error("down"));

    const r1 = await priv.activateOne("gh");
    expect(r1.ok).toBe(false);
    expect(priv.activationInflight.has("gh")).toBe(false);

    // Second call should retry, not return the failed promise from #1.
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["x"]));
    const r2 = await priv.activateOne("gh");
    expect(r2.ok).toBe(true);
  });
});

describe("exec step-level split-blame attribution", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("splits blame when a $ref-consuming step fails with a validation error", async () => {
    // A two-step pipeline across DISTINCT namespaces: producer "prod"
    // succeeds and feeds its output into consumer "cons" via {$ref:"p"}.
    // "cons" then fails with an input-shaped (validation) error. The
    // split-blame logic (server.ts 3745-3758) must:
    //   - leave the producer's dispatch count at 1 (it already booked its
    //     own dispatch on success) and only DOCK its earned credit by 0.5
    //     via delta-only adjustSucceeded — NOT re-book a fresh dispatch.
    //   - book the failing consumer its own half-credit recordOutcome(0.5).
    // A revert of the producer line to recordOutcome(depNs, 0.5) would
    // push prod.dispatched to 2 (and succeeded to 1.5), failing the
    // assertions below.
    const priv = getPrivate(server);

    const prodConn = makeConnection("prod", ["make"]);
    // Plain non-JSON, non-error-shaped success -> computeOutcomeReward 1.0.
    prodConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "prod-ok" }] });

    const consConn = makeConnection("cons", ["use"]);
    // Upstream self-validation failure: structured isError body carrying
    // the -32602 code, so classifyError -> validation_error (inputShaped).
    consConn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "MCP error -32602: Input validation error" }],
      isError: true,
    });

    priv.connections.set("prod", prodConn);
    priv.connections.set("cons", consConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "prod" }), makeServerConfig({ namespace: "cons" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "p", tool: "prod_make", args: {} },
        { id: "c", tool: "cons_use", args: { x: { $ref: "p" } } },
      ],
      return: "c",
    });

    // The pipeline fails on the consumer step and surfaces the error.
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.failedStep).toBe("c");
    expect(parsed.error).toContain("-32602");

    // Producer: dispatch booked ONCE on its success, credit docked 0.5 by
    // the delta-only adjustSucceeded. A recordOutcome revert would make
    // dispatched=2 / succeeded=1.5 and fail here.
    const prod = priv.learning.get("prod");
    expect(prod?.dispatched).toBe(1);
    expect(prod?.succeeded).toBeCloseTo(0.5, 5);

    // Consumer: booked its own fresh half-credit dispatch.
    const cons = priv.learning.get("cons");
    expect(cons?.dispatched).toBe(1);
    expect(cons?.succeeded).toBeCloseTo(0.5, 5);
  });
});

describe("handleToolCall route snapshot", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("uses the route snapshot even if toolRoutes is swapped mid-call", async () => {
    const priv = getPrivate(server);
    const errorConn = makeConnection("gh", ["create_issue"], "error");
    priv.connections.set("gh", errorConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const freshConn = makeConnection("gh", ["create_issue"]);
    freshConn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok after reconnect" }],
    });

    // Simulate an unrelated rebuild swapping this.toolRoutes during
    // the reconnect await. With the old code, the subsequent
    // routeToolCall would run against the empty Map and return an
    // "Unknown tool" error. With the snapshot, it still resolves.
    vi.mocked(connectToUpstream).mockImplementationOnce(async () => {
      priv.toolRoutes = new Map();
      return freshConn;
    });

    const result = await priv.handleToolCall("gh_create_issue", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("ok after reconnect");
  });
});

describe("guide resource + session tracking", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("lists no builtins when no guide is loaded", () => {
    const priv = getPrivate(server);
    priv.guides = { user: null, project: null };
    expect(priv.getBuiltinResources()).toEqual([]);
  });

  it("surfaces yaw-mcp://guide when either guide is present", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const builtins = priv.getBuiltinResources();
    expect(builtins.length).toBe(1);
    expect(builtins[0].uri).toBe("yaw-mcp://guide");
    expect(builtins[0].mimeType).toBe("text/markdown");
    expect(builtins[0].name).toBe("yaw-mcp guide");
  });

  it("builtin read() returns the rendered body and flips guideRead", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
      project: { scope: "project", path: "/p/.yaw-mcp/YAW-MCP.md", content: "p-body" },
    };
    expect(priv.guideRead).toBe(false);
    const builtin = priv.getBuiltinResources()[0];
    const result = builtin.read();
    expect(priv.guideRead).toBe(true);
    const text = result.contents[0].text;
    expect(text).toContain("u-body");
    expect(text).toContain("p-body");
    // Project goes last so its guidance has the final word (see renderGuide).
    expect(text.indexOf("p-body")).toBeGreaterThan(text.indexOf("u-body"));
  });

  it("builtin map exposes the same guide entry by URI", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const map = priv.getBuiltinResourceMap();
    expect(map.size).toBe(1);
    expect(map.get("yaw-mcp://guide")?.uri).toBe("yaw-mcp://guide");
  });

  it("attaches a one-shot guide nudge to meta-tool responses when guide is loaded but unread", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const res1 = priv.attachGuideNudge({ content: [{ type: "text", text: "discover-body" }] });
    // The nudge rides as its OWN content block — the original body stays
    // byte-identical (exec/secrets return JSON.stringify text that must
    // survive JSON.parse).
    expect(res1.content[0].text).toBe("discover-body");
    expect(res1.content).toHaveLength(2);
    expect(res1.content[1].text).toContain("yaw-mcp://guide");
    expect(res1.content[1].text).toContain("/h/.yaw-mcp/YAW-MCP.md");
    // One-shot: a second call does NOT add the nudge again.
    const res2 = priv.attachGuideNudge({ content: [{ type: "text", text: "second-body" }] });
    expect(res2.content).toHaveLength(1);
    expect(res2.content[0].text).toBe("second-body");
  });

  it("keeps a JSON body parseable when the nudge fires (exec/secrets contract)", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const body = JSON.stringify({ ok: true, result: { hits: 3 }, steps: [] });
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: body }] });
    expect(res.content).toHaveLength(2);
    // The documented payload block still parses — the nudge did not append
    // trailing prose to it.
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, result: { hits: 3 }, steps: [] });
    expect(res.content[1].text).toContain("yaw-mcp://guide");
  });

  it("does not bake the one-shot nudge into the cached discover result", async () => {
    // attachGuideNudge used to mutate result.content in place. The object
    // it received from buildDiscoverOutput is the SAME object stored in
    // discoverCache, so the once-per-session hint got replayed on every
    // cache hit for the rest of the 3s TTL.
    const priv = getPrivate(server);
    priv.config = { servers: [], configVersion: "v1" };
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };

    const first = await priv.handleToolCall("mcp_connect_discover", {});
    expect(first.content).toHaveLength(2);
    expect(first.content[1].text).toContain("yaw-mcp://guide");

    // Second call inside the cache TTL: same body, no nudge block.
    const second = await priv.handleToolCall("mcp_connect_discover", {});
    expect(second.content).toHaveLength(1);
    expect(second.content[0].text).not.toContain("yaw-mcp://guide");
    // ...and the cache itself is still clean.
    expect(priv.discoverCache.result.content).toHaveLength(1);
    expect(priv.discoverCache.result.content[0].text).not.toContain("yaw-mcp://guide");
  });

  it("does NOT nudge when no guide is loaded", () => {
    const priv = getPrivate(server);
    priv.guides = { user: null, project: null };
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "plain" }] });
    expect(res.content[0].text).toBe("plain");
  });

  it("does NOT nudge once the guide has been read", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    priv.guideRead = true;
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "body" }] });
    expect(res.content[0].text).toBe("body");
  });

  it("reading the guide via the builtin flips guideRead and suppresses the nudge", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    expect(priv.guideRead).toBe(false);
    priv.getBuiltinResources()[0].read();
    expect(priv.guideRead).toBe(true);
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "body" }] });
    // guideRead gates the nudge, so even with a guide loaded we shouldn't nudge.
    expect(res.content[0].text).toBe("body");
  });
});

describe("resources/templates/list", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("registers a handler so a probing client gets an empty list, not -32601", async () => {
    // The constructor declares the resources capability, which implies
    // resources/templates/list; the SDK ships no default handler, so
    // without an explicit registration a probe errors with Method not
    // found. Empty is honest today: buildResourceRoutes only ever sees
    // concrete conn.resources, so a templated URI could not be read
    // through the proxy anyway.
    const priv = getPrivate(server);
    const handler = priv.server._requestHandlers.get("resources/templates/list");
    expect(handler).toBeDefined();
    const res = await handler({ method: "resources/templates/list", params: {} }, {} as never);
    expect(res).toEqual({ resourceTemplates: [] });
  });
});

describe("prewarmDormantServers", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("activates dormant servers, persists toolCache, and disconnects", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "slack-id", namespace: "slack", name: "Slack" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    // Both servers were connected once and disconnected once.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(2);
    // No live connections held after prewarm.
    expect(priv.connections.size).toBe(0);
    // toolCache populated for both so getDeferredServers() can surface them.
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);
    expect(priv.toolCache.get("slack")).toEqual([{ name: "slack_tool", description: undefined }]);
  });

  it("is exempt from the server cap in BOTH directions", async () => {
    // The cap bounds the LLM's context; prewarm contributes nothing to it
    // (never advertised, torn down within milliseconds). So (a) a prewarm
    // activation must not be refused by a full cap -- the refusal was
    // SILENT and left the namespace invisible in tools/list all session --
    // and (b) a prewarm-claimed connection must not occupy a slot that
    // refuses a concurrent real activation (the startup race with
    // autoLoadRecurringPack).
    const priv = getPrivate(server);
    priv.serverCap = 1;
    // (a) One real connected server holds the only slot; prewarm still runs.
    priv.connections.set("busy", makeConnection("busy", ["t"]));
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );
    await priv.prewarmDormantServers();
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);

    // (b) A prewarm-claimed connection does not block a real activation.
    priv.connections.delete("busy");
    priv.connections.set("warm", makeConnection("warm", ["t"]));
    priv.prewarmNamespaces.add("warm");
    priv.config = makeConfig([makeServerConfig({ namespace: "warm" }), makeServerConfig({ namespace: "slack" })]);
    const result = await priv.activateOne("slack");
    expect(result.ok).toBe(true);
    expect(result.capped).toBeUndefined();
  });

  it("an explicit claim of an in-flight prewarm activation is cap-checked (no bypass)", async () => {
    // The prewarm activation itself skips the cap (it never advertises
    // tools) -- but an explicit activate that CLAIMS it converts the
    // connection into a real, advertised one, so the claim must pass the
    // cap a fresh activation would. On refusal the prewarm claim is
    // restored so prewarm's teardown proceeds normally.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.connections.set("busy", makeConnection("busy", ["t"])); // holds the only slot
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    let release!: (c: ReturnType<typeof makeConnection>) => void;
    const gate = new Promise<ReturnType<typeof makeConnection>>((r) => {
      release = r;
    });
    vi.mocked(connectToUpstream).mockImplementation(() => gate as never);
    // Prewarm starts activating "gh" (cap skipped) and stalls mid-spawn.
    const prewarmP = priv.activateOne("gh", undefined, /* fromPrewarm */ true);
    // An explicit activate lands while the prewarm spawn is in flight.
    const claim = await priv.activateOne("gh");
    expect(claim.ok).toBe(false);
    expect(claim.capped).toBe(true);
    // The claim was refused, so the prewarm claim is back in place and the
    // prewarm teardown still owns the connection.
    expect(priv.prewarmNamespaces.has("gh")).toBe(true);
    release(makeConnection("gh", ["t"]));
    await prewarmP;
  });

  it("a prewarm activation that elicits credentials keeps its cap exemption on the retry", async () => {
    // maybeElicitAndRetry re-enters runActivateOne; dropping fromPrewarm
    // there re-ran the cap check prewarm is exempt from, so a prewarm spawn
    // that elicited credentials could be refused at a full cap -- and the
    // namespace stayed invisible in tools/list, the exact UX the exemption
    // exists to prevent.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.connections.set("busy", makeConnection("busy", ["t"])); // cap full
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    // First spawn fails naming a missing credential; the elicited retry
    // succeeds. Elicitation needs the client capability + a bridge answer.
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { GITHUB_TOKEN: "ghp_x" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));
    const result = await priv.activateOne("gh", undefined, /* fromPrewarm */ true);
    expect(result.ok).toBe(true);
    // The retry ran cap-exempt: toolCache learned, namespace visible.
    expect(priv.toolCache.get("gh")).toBeDefined();
  });

  it("skips servers that already have a persisted toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          toolCache: [{ name: "list_issues", description: "List issues" }],
        }),
        makeServerConfig({ id: "slack-id", namespace: "slack", name: "Slack" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    // Only slack (no toolCache) got activated; gh was skipped.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("slack");
  });

  it("re-warms a server whose learned toolCache is older than the refresh window", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };
    // Learned in a prior session, 8 days ago -- past the 7-day refresh
    // window. Installs resolve @latest, so the upstream may have renamed
    // tools since; hasKnownTools alone would keep skipping this server
    // until the 30-day persistence TTL finally dropped the entry.
    priv.toolCache.set("gh", [{ name: "renamed_away" }]);
    priv.toolCacheLearnedAt.set("gh", Date.now() - 8 * 24 * 60 * 60 * 1000);
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    // The stale list was replaced and re-stamped.
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);
    expect(Date.now() - priv.toolCacheLearnedAt.get("gh")).toBeLessThan(60_000);
  });

  it("does not re-warm a fresh learned list or a curated bundles.json toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({
          id: "slack-id",
          namespace: "slack",
          name: "Slack",
          toolCache: [{ name: "post_message" }],
        }),
      ],
    };
    // gh: learned yesterday -- inside the refresh window.
    priv.toolCache.set("gh", [{ name: "list_issues" }]);
    priv.toolCacheLearnedAt.set("gh", Date.now() - 24 * 60 * 60 * 1000);
    // slack: curated bundles.json cache only -- carries no learnedAt and is
    // never refreshed here (that would reintroduce the per-session
    // `npx -y <pkg>@latest` resolve pre-warm exists to avoid).

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("is a no-op when every server already has a toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          toolCache: [{ name: "list_issues" }],
        }),
      ],
    };

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
  });

  it("survives individual activation failures without aborting the batch", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "broken-id", namespace: "broken", name: "Broken" }),
        makeServerConfig({ id: "ok-id", namespace: "ok", name: "Ok" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "broken") throw new Error("spawn ENOENT");
      return makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]);
    });

    await priv.prewarmDormantServers();

    // "ok" still populated its cache even though "broken" threw.
    expect(priv.toolCache.get("ok")).toEqual([{ name: "ok_tool", description: undefined }]);
    expect(priv.toolCache.get("broken")).toBeUndefined();
    expect(priv.connections.size).toBe(0);
  });
});

describe("isAutoActivateEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults ON when unset or empty, and honors an explicit disable", () => {
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "");
    expect(isAutoActivateEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0");
    expect(isAutoActivateEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "false");
    expect(isAutoActivateEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "true");
    expect(isAutoActivateEnabled()).toBe(true);
  });

  it("trims the value -- `set YAW_MCP_AUTO_ACTIVATE=1 && ...` from cmd.exe stores '1 '", () => {
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "1 ");
    expect(isAutoActivateEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0 ");
    expect(isAutoActivateEnabled()).toBe(false);
    // Whitespace-only reads as unset -> default ON.
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "  ");
    expect(isAutoActivateEnabled()).toBe(true);
  });
});

describe("auto-load on startup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("is disabled by default when YAW_MCP_AUTO_LOAD is unset", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("accepts '1' and 'true' but not other values", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "true");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "TRUE");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "0");
    expect(isAutoLoadEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "yes");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("trims the value -- cmd.exe's `set VAR=1 && npx ...` stores '1 '", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1 ");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", " true");
    expect(isAutoLoadEnabled()).toBe(true);
    // Whitespace-only reads as unset -> default OFF.
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "  ");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("activates every namespace in the top recurring pack when all are installed", async () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "linear-id", namespace: "linear", name: "Linear" }),
      ],
    };
    // Three bursts of (gh, linear) → one detected pack at frequency 3.
    const t0 = 1_000_000;
    priv.packDetector.recordCall("gh", "create_issue", t0);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 600_000);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 601_000);

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.autoLoadRecurringPack();

    // Both namespaces got activated sequentially.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
    const activatedNs = vi.mocked(connectToUpstream).mock.calls.map((c) => (c[0] as UpstreamServerConfig).namespace);
    expect(activatedNs).toContain("gh");
    expect(activatedNs).toContain("linear");
    expect(priv.connections.get("gh")?.status).toBe("connected");
    expect(priv.connections.get("linear")?.status).toBe("connected");
  });

  it("does not activate anything when some pack namespaces aren't installed", async () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    // Only `gh` is installed — the {gh, slack} pack can't be activated
    // as a whole, so we must skip it entirely. Activating just `gh`
    // would be a partial load that the caller didn't ask for.
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };
    const t0 = 1_000_000;
    priv.packDetector.recordCall("gh", "create_issue", t0);
    priv.packDetector.recordCall("slack", "post_message", t0 + 1000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
    priv.packDetector.recordCall("slack", "post_message", t0 + 301_000);

    await priv.autoLoadRecurringPack();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(priv.connections.size).toBe(0);
  });

  it("is a silent no-op when pack history is empty", async () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };

    await priv.autoLoadRecurringPack();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  describe("fix#5: dispatch budget schema declares default: 1", () => {
    it("budget property carries default: 1 in the JSON schema", async () => {
      // The description text says 'Default budget is 1' but the JSON schema
      // property had no `default` annotation. Both must agree with the
      // runtime behaviour (server.ts line 795: defaults to 1 when omitted).
      const { META_TOOLS } = await import("../meta-tools.js");
      const budgetProp = (META_TOOLS.dispatch.inputSchema.properties as Record<string, unknown>).budget as Record<
        string,
        unknown
      >;
      expect(budgetProp).toBeDefined();
      expect(budgetProp.default).toBe(1);
    });
  });

  describe("fix#6: deferred-route miss error names mcp_connect_discover", () => {
    it("names mcp_connect_discover in the 'tool vanished' error message", async () => {
      // When a deferred-route activation succeeds but the tool is no
      // longer in the live schema, the error must name the recovery call
      // so the model knows what to do next.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      // Set up a deferred route for gh_stale_tool.
      priv.toolRoutes = new Map([
        [
          "gh_stale_tool",
          {
            namespace: "gh",
            originalName: "stale_tool",
            namespacedName: "gh_stale_tool",
            deferred: true,
          },
        ],
      ]);
      // connectToUpstream succeeds but returns a connection without stale_tool.
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleToolCall("gh_stale_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("mcp_connect_discover");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #2: prewarm race -- explicit activate during prewarm inflight must
// claim the connection so prewarm skips its teardown disconnect.
// ─────────────────────────────────────────────────────────────────────────
describe("prewarm race: explicit activate during prewarm inflight", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("connection survives when an explicit activate joins the prewarm inflight promise", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

    // Hold the connect open so the explicit activate can enqueue before it resolves.
    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    const connectPromise = new Promise<UpstreamConnection>((r) => {
      resolveConnect = r;
    });
    vi.mocked(connectToUpstream).mockReturnValueOnce(connectPromise);

    // Launch prewarm -- this starts the inflight, marks gh as prewarm-only.
    const prewarmPromise = priv.prewarmDormantServers();

    // Explicit activate joins before the connect resolves -- this should
    // claim the namespace (remove it from prewarmNamespaces).
    const activatePromise = priv.activateOne("gh");

    // Resolve the upstream -- both waiters see ok=true.
    resolveConnect(makeConnection("gh", ["create_issue"]));
    await Promise.all([prewarmPromise, activatePromise]);

    // Prewarm must NOT have disconnected the connection that the explicit
    // activate claimed -- the user's next tool call must still work.
    expect(priv.connections.has("gh")).toBe(true);
    // Only one actual spawn happened (dedup guarantee still holds).
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
  });

  it("prewarm still disconnects when it is the sole caller (no explicit activate)", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    await priv.prewarmDormantServers();

    // No explicit activate was called, so prewarm should disconnect.
    expect(priv.connections.has("gh")).toBe(false);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
  });

  it("does not delete a connection that was replaced while its predecessor closed", async () => {
    // The other half of the same race: disconnectFromUpstream marks the old
    // connection dead synchronously, so an explicit activate that starts
    // during the close sees a dead entry, spawns a fresh child, and
    // re-registers under the same key. Deleting unconditionally after the
    // await orphans that child -- live, unreferenced, invisible to
    // shutdown() -- and the user's next tool call gets "no longer
    // connected" for a server that is actually running.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    const prewarmed = makeConnection("gh", ["create_issue"]);
    const replacement = makeConnection("gh", ["create_issue"]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(prewarmed);
    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async () => {
      priv.connections.set("gh", replacement);
    });

    await priv.prewarmDormantServers();

    expect(priv.connections.get("gh")).toBe(replacement);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #3: upstream.ts fetchToolsFromUpstream listTools failure must
// surface as ActivationError(category="protocol_error").
// ─────────────────────────────────────────────────────────────────────────
describe("fetchToolsFromUpstream propagates protocol_error on listTools failure", () => {
  it("throws ActivationError with category=protocol_error when listTools rejects", async () => {
    // Import directly from the module -- the vi.mock at the top of this file
    // replaces connectToUpstream/disconnectFromUpstream but leaves
    // fetchToolsFromUpstream is the real implementation (the mock uses
    // importOriginal and spreads the actual module). The thrown error is
    // asserted by name/category below, so the class itself isn't bound here.
    const { fetchToolsFromUpstream } = await import("../upstream.js");
    const client = { listTools: vi.fn().mockRejectedValue(new Error("JSON-RPC parse error")) } as any;

    await expect(fetchToolsFromUpstream(client, "testns")).rejects.toMatchObject({
      name: "ActivationError",
      category: "protocol_error",
      message: expect.stringContaining("JSON-RPC parse error"),
    });
  });

  it("includes the namespace in the error message for context", async () => {
    const { fetchToolsFromUpstream } = await import("../upstream.js");
    const client = { listTools: vi.fn().mockRejectedValue(new Error("timeout")) } as any;

    let caught: Error | null = null;
    try {
      await fetchToolsFromUpstream(client, "my-ns");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("my-ns");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #6: ConnectServer.parseStepPayload unit tests (three branches).
// ─────────────────────────────────────────────────────────────────────────
describe("ConnectServer.parseStepPayload", () => {
  // Access the private static via cast.
  function parseStepPayload(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): unknown {
    return (ConnectServer as any).parseStepPayload(result);
  }

  it("branch 1: single text item whose text is valid JSON -> the parsed JSON value", () => {
    const input = { content: [{ type: "text", text: '{"id":42,"name":"test"}' }] };
    expect(parseStepPayload(input)).toEqual({ id: 42, name: "test" });
  });

  it("branch 1b: JSON array is also parsed and returned as-is", () => {
    const input = { content: [{ type: "text", text: "[1,2,3]" }] };
    expect(parseStepPayload(input)).toEqual([1, 2, 3]);
  });

  it("branch 2: single text item (non-JSON) -> the raw text string", () => {
    const input = { content: [{ type: "text", text: "plain text result" }] };
    expect(parseStepPayload(input)).toBe("plain text result");
  });

  it("branch 3a: multi-item content -> the content array itself", () => {
    const input = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(parseStepPayload(input)).toBe(input.content);
  });

  it("branch 3b: empty content array -> the empty array itself", () => {
    const input = { content: [] };
    expect(parseStepPayload(input)).toEqual([]);
  });

  it("branch 3c: no content field -> empty array fallback", () => {
    const input = {};
    expect(parseStepPayload(input)).toEqual([]);
  });

  it("branch 3d: single non-text item -> the content array", () => {
    const input = { content: [{ type: "image" }] };
    expect(parseStepPayload(input)).toBe(input.content);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review follow-ups: activation without a route rebuild, the idle reaper
// racing an in-flight call, read_tool bypassing the policy gates, and a
// per-tool filter that outlived the activation it was set for.
// ─────────────────────────────────────────────────────────────────────────
describe("idle threshold env knob", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 10 with neither env var set", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("reads YAW_MCP_IDLE_THRESHOLD", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "25");
    expect(resolveIdleThreshold()).toBe(25);
  });

  it("still honors the legacy MCP_CONNECT_IDLE_THRESHOLD spelling", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "7");
    expect(resolveIdleThreshold()).toBe(7);
  });

  it("prefers the YAW_MCP_ name when both are set", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "3");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "40");
    expect(resolveIdleThreshold()).toBe(3);
  });

  it("falls back to the default on garbage or out-of-range values", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "banana");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "0");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("is re-read per call, not latched at import", async () => {
    const s = new ConnectServer();
    const priv = getPrivate(s);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("slack", makeConnection("slack"));
    // Baseline 1 clamps to the adaptive floor of 5, so an idle count of 4
    // tips over on the next call. Under the default baseline of 10 it does
    // not -- which is what makes this a test of the env read.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "1");
    priv.idleCallCounts.set("slack", 4);

    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("slack")).toBe(false);
    await s.shutdown();
  });
});

describe("activation always refreshes the routing table", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("deferred first call rebuilds routes even when the server was already connected", async () => {
    // The wedge: discover's auto-warm (or dispatch) connected gh while
    // toolRoutes still held the deferred entry built from its toolCache.
    // activateOne then returns isChanged:false, so gating the rebuild on
    // isChanged left the stale route in place and the call dead-ended on
    // "no longer available" with no recovery path.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "issue #1" }] });
    priv.connections.set("gh", conn);
    // Stale routes: gh is connected but its route still says deferred.
    priv.toolRoutes = new Map([
      [
        "gh_create_issue",
        { namespace: "gh", originalName: "create_issue", namespacedName: "gh_create_issue", deferred: true },
      ],
    ]);

    const result = await priv.handleToolCall("gh_create_issue", {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("issue #1");
    // No re-spawn: the server was already connected.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // Routes were refreshed, so the deferred entry is gone.
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
  });

  it("auto-load rebuilds routes for the pack it just activated", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ id: "gh-id", namespace: "gh" }),
      makeServerConfig({ id: "linear-id", namespace: "linear", name: "Linear" }),
    ]);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      priv.packDetector.recordCall("gh", "create_issue", t0 + i * 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + i * 300_000 + 1000);
    }
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.autoLoadRecurringPack();

    // Without the rebuild the routing table keeps whatever start() left
    // behind and the first call on an auto-loaded tool misses entirely.
    expect(priv.toolRoutes.has("gh_gh_tool")).toBe(true);
    expect(priv.toolRoutes.has("linear_linear_tool")).toBe(true);
  });
});

describe("idle reaper vs in-flight tool calls", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("does not disconnect a namespace with a call still in flight", async () => {
    const priv = getPrivate(server);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("slack", makeConnection("slack"));
    priv.idleCallCounts.set("slack", resolveIdleThreshold() - 1);
    // slack is mid-call: killing it here rejects the user's own pending
    // callTool and then books the rejection against slack.
    priv.inflightCalls.set("slack", 1);

    await priv.trackUsageAndAutoDeactivate("gh");

    expect(priv.connections.has("slack")).toBe(true);
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();

    // Once the call drains, the next completion reaps it as usual.
    priv.inflightCalls.delete("slack");
    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("slack")).toBe(false);
  });

  it("re-checks the guard before each disconnect, not only when listing candidates", async () => {
    const priv = getPrivate(server);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("b", makeConnection("b"));
    priv.connections.set("c", makeConnection("c"));
    // b and c both tick past the threshold on this one completion, so they
    // land in the same deactivation batch -- b first.
    priv.idleCallCounts.set("b", resolveIdleThreshold() - 1);
    priv.idleCallCounts.set("c", resolveIdleThreshold() - 1);

    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async (conn: UpstreamConnection) => {
      expect(conn.config.namespace).toBe("b");
      // A tool call for c lands while b's transport is still closing. This is
      // real event-loop time, not a microtask -- the SDK's stdio close races
      // a 2s timer twice -- so the snapshot taken when the batch was built is
      // stale by the time c's turn comes up.
      priv.inflightCalls.set("c", 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await priv.trackUsageAndAutoDeactivate("gh");

    expect(priv.connections.has("b")).toBe(false);
    // Closing c here would reject the user's own pending callTool and then
    // book a 0.0 reliability hit against a server we killed ourselves.
    expect(priv.connections.has("c")).toBe(true);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);

    // Once the call drains, the next completion reaps c as usual.
    priv.inflightCalls.delete("c");
    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("c")).toBe(false);
  });

  it("counts a live proxied call as in-flight for the duration of the call", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    let seenDuringCall: number | undefined;
    conn.client.callTool = vi.fn().mockImplementation(async () => {
      seenDuringCall = priv.inflightCalls.get("gh");
      return { content: [{ type: "text", text: "ok" }] };
    });
    priv.connections.set("gh", conn);
    priv.rebuildRoutes();

    await priv.handleToolCall("gh_create_issue", {});

    expect(seenDuringCall).toBe(1);
    // ...and the marker is released afterwards, not leaked.
    expect(priv.inflightCalls.has("gh")).toBe(false);
  });

  it("releases the in-flight marker on the error path too", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    conn.client.callTool = vi.fn().mockRejectedValue(new Error("transport closed"));
    priv.connections.set("gh", conn);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("gh_create_issue", {});
    expect(result.isError).toBe(true);
    expect(priv.inflightCalls.has("gh")).toBe(false);
  });
});

describe("read_tool honors the same policy gates as activate", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("refuses a profile-blocked server instead of spawning it", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "prod-db", name: "Prod DB" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", blocked: ["prod-db"] };

    const result = await priv.handleReadTool("prod-db", "query");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed by the project profile");
    // The transient inspect path spawns the real command with its resolved
    // env (vault secrets included) -- a deny-listed server must never
    // reach it just because we disconnect afterwards.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("refuses a server outside an allow-list profile", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["slack"] };

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("refuses a below-floor server under YAW_MCP_MIN_COMPLIANCE", async () => {
    vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", complianceGrade: "D" })]);

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Refused to load "gh"');
    expect(result.content[0].text).toContain("grade D");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("still inspects an allowed, in-grade server", async () => {
    vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", complianceGrade: "A" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["gh"] };
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tool: gh_create_issue");
  });
});

describe("per-tool filter rollback on a failed activation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("drops the filter when the activation it was set for fails", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

    const result = await priv.handleActivate(["gh"], undefined, ["foo"]);
    expect(result.isError).toBe(true);
    // A surviving filter would silently narrow a LATER successful load --
    // dispatch and the deferred path never touch toolFilters.
    expect(priv.toolFilters.has("gh")).toBe(false);
  });

  it("restores the previous filter rather than clearing it outright", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.toolFilters.set("gh", new Set(["create_issue"]));
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

    await priv.handleActivate(["gh"], undefined, ["close_issue"]);

    expect([...(priv.toolFilters.get("gh") ?? [])]).toEqual(["create_issue"]);
  });

  it("leaves no filter behind for a namespace that isn't installed at all", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([]);

    const result = await priv.handleActivate(["ghost"], undefined, ["x"]);
    expect(result.isError).toBe(true);
    expect(priv.toolFilters.has("ghost")).toBe(false);
  });

  it("keeps the filter when the activation succeeds", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue", "close_issue"]));

    await priv.handleActivate(["gh"], undefined, ["create_issue"]);
    expect([...(priv.toolFilters.get("gh") ?? [])]).toEqual(["create_issue"]);
  });
});

describe("discover cache invalidation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("a failed activation invalidates the memoized discover body", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

    const first = priv.handleDiscover();
    expect(first.content[0].text).not.toContain("last activation failed");

    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));
    await priv.activateOne("gh");

    // Same cache key, still inside the 3s TTL -- but the failure warning
    // must show up. This is the exact "discover, failed activate, discover
    // again" sequence the cache comment names as its motivating case.
    const second = priv.handleDiscover();
    expect(second.content[0].text).toContain("last activation failed");
  });
});

describe("shutdown drains and refuses activations", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  it("refuses a new activation once shutdown has started", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    await server.shutdown();

    const result = await priv.activateOne("gh");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("shutting down");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("waits for an in-flight activation and disconnects what it registered", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    vi.mocked(connectToUpstream).mockReturnValueOnce(
      new Promise<UpstreamConnection>((r) => {
        resolveConnect = r;
      }),
    );
    const activation = priv.activateOne("gh");

    const shutdownPromise = server.shutdown();
    // The child finishes its handshake AFTER shutdown started: without the
    // drain its connection lands in a map nobody will ever disconnect.
    resolveConnect(makeConnection("gh", ["create_issue"]));
    await Promise.all([activation, shutdownPromise]);

    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
    expect(priv.connections.size).toBe(0);
  });

  it("gives up on a hanging activation instead of outliving the force-exit timer", async () => {
    vi.useFakeTimers();
    try {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

      // A cold npx handshake that never comes back. upstream.ts would give up
      // after a 15s connect timeout retried once -- already well past the 10s
      // force-exit timer in index.ts, which exits(1) instead of 0.
      vi.mocked(connectToUpstream).mockReturnValueOnce(new Promise<UpstreamConnection>(() => {}));
      void priv.activateOne("gh");
      expect(priv.activationInflight.has("gh")).toBe(true);

      let done = false;
      const shutdownPromise = server.shutdown().then(() => {
        done = true;
      });

      // Nothing can settle the activation, so only the drain budget elapsing
      // lets shutdown() through -- and it must elapse well inside 10s.
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdownPromise;
      expect(done).toBe(true);

      // We tore down without it: the activation is still hung.
      expect(priv.activationInflight.has("gh")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears session-elicited credentials, as the field contract promises", async () => {
    const priv = getPrivate(server);
    priv.elicitedEnv.set("gh", { GITHUB_TOKEN: "ghp_secret" });

    await server.shutdown();

    expect(priv.elicitedEnv.size).toBe(0);
  });
});

describe("resolveToolExposure", () => {
  const prev = process.env.YAW_MCP_TOOL_EXPOSURE;
  afterEach(() => {
    if (prev === undefined) delete process.env.YAW_MCP_TOOL_EXPOSURE;
    else process.env.YAW_MCP_TOOL_EXPOSURE = prev;
  });

  it("defaults to gateway when unset or blank", () => {
    delete process.env.YAW_MCP_TOOL_EXPOSURE;
    expect(resolveToolExposure()).toBe("gateway");
    process.env.YAW_MCP_TOOL_EXPOSURE = "   ";
    expect(resolveToolExposure()).toBe("gateway");
  });

  it("honors an explicit full opt-out, case-insensitively", () => {
    process.env.YAW_MCP_TOOL_EXPOSURE = "FULL";
    expect(resolveToolExposure()).toBe("full");
  });

  it("falls back to gateway on an unrecognized value, not to the full surface", () => {
    // A typo must not silently restore the ~27,000-token catalog; failing
    // toward the smaller surface is the recoverable direction.
    process.env.YAW_MCP_TOOL_EXPOSURE = "gatway";
    expect(resolveToolExposure()).toBe("gateway");
  });
});

describe("session activation lifetime (gateway mode)", () => {
  let server: ConnectServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });
  afterEach(async () => {
    await server.shutdown();
  });

  function listed(priv: any): string[] {
    return buildToolList(
      priv.connections,
      priv.getDeferredServers(),
      priv.toolFilters,
      "gateway",
      priv.sessionActivated,
    )
      .map((t: { name: string }) => t.name)
      .filter((n: string) => !n.startsWith("mcp_connect_"));
  }

  it("advertises a namespace only after an explicit activate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    expect(listed(priv)).toEqual([]);
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(listed(priv)).toEqual(["gh_foo"]);
  });

  it("stops advertising it after deactivate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await priv.handleToolCall("mcp_connect_deactivate", { server: "gh" });
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });

  it("clears activation when the idle reaper unloads the namespace", async () => {
    // The regression: the reaper cleared toolFilters but not sessionActivated,
    // so a later DISPATCH-driven reload re-advertised a namespace the client
    // had never asked for.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(priv.sessionActivated.has("gh")).toBe(true);

    // Drive the real reaper: trackUsageAndAutoDeactivate unloads namespaces
    // whose idle-call count is past the adaptive threshold.
    priv.idleCallCounts.set("gh", 9999);
    await priv.trackUsageAndAutoDeactivate("other");
    expect(priv.connections.has("gh")).toBe(false);
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });

  it("does not advertise a namespace that failed to activate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("nope"));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });
});

describe("gateway activation contract (what a client observes)", () => {
  let server: ConnectServer;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });
  afterEach(async () => {
    await server.shutdown();
  });

  function list(priv: any) {
    return buildToolList(
      priv.connections,
      priv.getDeferredServers(),
      priv.toolFilters,
      "gateway",
      priv.sessionActivated,
    );
  }

  it("serves only the meta-tools before any activation", () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const names = list(priv).map((t) => t.name);
    expect(names.every((n) => n.startsWith("mcp_connect_"))).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });

  it("replaces nothing with a placeholder: an activated tool carries its REAL schema", async () => {
    // The deferred placeholder is {type:object, properties:{}, additionalProperties:true}.
    // A client that activated a server must get the upstream's actual contract,
    // or it validates arguments against a schema that accepts anything.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    const foo = list(priv).find((t) => t.name === "gh_foo");
    expect(foo?.inputSchema).toEqual({ type: "object" });
    expect(foo?.inputSchema).not.toHaveProperty("additionalProperties");
  });

  it("notifies list_changed on activate, so a client refreshes without polling", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const spy = vi.spyOn(priv.server, "sendToolListChanged").mockResolvedValue(undefined);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(spy).toHaveBeenCalled();
  });

  it("keeps a route to an unadvertised tool, so dispatch can still reach it", () => {
    // The guarantee that makes withholding the catalog safe.
    const priv = getPrivate(server);
    const inactive = [{ ...makeServerConfig({ namespace: "tailscale" }), toolCache: [{ name: "status" }] }];
    const routes = buildToolRoutes(priv.connections, inactive as any);
    expect(routes.has("tailscale_status")).toBe(true);
    expect(list(priv).some((t) => t.name === "tailscale_status")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Downstream client bridge threading -- every connectToUpstream call site must
// hand over the bridge that forwards elicitation/sampling/roots to the REAL
// downstream client via this.server. Without it, upstream.ts declares
// `capabilities: {}` and the SDK refuses those requests for proxied servers
// even when the downstream client supports all three.
// ---------------------------------------------------------------------------

describe("downstream client bridge", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("threads a bridge into activation connects that reads capabilities and forwards elicitation/sampling/roots off this.server", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    await priv.handleActivate(["gh"]);

    const bridge = vi.mocked(connectToUpstream).mock.calls[0][3] as DownstreamClientBridge;
    expect(bridge).toBeDefined();

    // The bridge reads LAZILY off this.server, so stubs installed after the
    // connect still answer -- mirroring "the declaration is only known after
    // the downstream initialize".
    const caps = { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } };
    priv.server.getClientCapabilities = () => caps;
    expect(bridge.getClientCapabilities()).toBe(caps);

    const elicitResult = { action: "accept", content: { TOKEN: "x" } };
    priv.server.elicitInput = vi.fn().mockResolvedValue(elicitResult);
    const elicitParams = { message: "m", requestedSchema: { type: "object", properties: {} } } as any;
    await expect(bridge.elicitInput(elicitParams, {})).resolves.toBe(elicitResult);
    expect(priv.server.elicitInput).toHaveBeenCalledWith(elicitParams, {});

    const sampleResult = { model: "m", role: "assistant", content: { type: "text", text: "ok" } };
    priv.server.createMessage = vi.fn().mockResolvedValue(sampleResult);
    const sampleParams = { messages: [], maxTokens: 8 } as any;
    await expect(bridge.createMessage(sampleParams, {})).resolves.toBe(sampleResult);
    expect(priv.server.createMessage).toHaveBeenCalledWith(sampleParams, {});

    const rootsResult = { roots: [{ uri: "file:///repo" }] };
    priv.server.listRoots = vi.fn().mockResolvedValue(rootsResult);
    await expect(bridge.listRoots(undefined, {})).resolves.toBe(rootsResult);
    expect(priv.server.listRoots).toHaveBeenCalledWith(undefined, {});

    // A downstream rejection surfaces verbatim -- no invented default.
    priv.server.elicitInput = vi.fn().mockRejectedValue(new Error("client declined"));
    await expect(bridge.elicitInput(elicitParams)).rejects.toThrow("client declined");
  });

  it("threads the same bridge into the transient read_tool connect", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);

    await priv.handleReadTool("gh", "create_issue", undefined);

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][3]).toBe(priv.clientBridge);
  });
});
