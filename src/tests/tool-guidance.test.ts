import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Tool-level guidance around find_tool, dispatch, activate and exec
// (server.ts):
//   * servers with no learned tool list -- the bundled fallback list
//     (fallback-tools.ts) in ranking, and find_tool naming what it could not
//     search;
//   * dispatch naming the loaded tools that fit the intent, with signatures;
//   * the exec line on load replies only for a client that never re-lists
//     tools (none for Claude Code), and exec really reaching a tool loaded a
//     moment ago;
//   * exec checking a step's args against the tool's inputSchema first.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { fallbackToolsFor } from "../fallback-tools.js";
import { ConnectServer, checkToolArgs, DISPATCH_TOOL_HINTS, formatToolSignature } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

const ZERO_BYTES = { resultBytesUpstream: 0, resultBytesDownstream: 0 };

function cfg(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return { id: "id", name: "Test", namespace: "test", type: "local", command: "echo", isActive: true, ...overrides };
}

const GH_IMAGE = { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"] };

interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function connection(config: UpstreamServerConfig, tools: ToolSpec[]): UpstreamConnection {
  return {
    config,
    client: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      close: vi.fn(),
    } as any,
    transport: {} as any,
    tools: tools.map((t) => ({
      name: t.name,
      namespacedName: `${config.namespace}_${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object" },
    })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, ...ZERO_BYTES },
    status: "connected",
  } as UpstreamConnection;
}

let server: ConnectServer;
const priv = () => server as any;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
  server = new ConnectServer();
});

afterEach(async () => {
  await server.shutdown();
});

describe("ranking a server whose tool list was never learned", () => {
  const gh = () => cfg({ id: "gh", namespace: "gh", name: "GitHub", description: "GitHub API", ...GH_IMAGE });

  it("ranks it on the bundled list matched by its image, and only then", () => {
    const p = priv();
    const bundled = fallbackToolsFor(GH_IMAGE);
    expect(p.rankableTools(gh())).toEqual({ tools: [...(bundled ?? [])], source: "bundled" });
    expect(p.rankableFor(gh()).tools.map((t: { name: string }) => t.name)).toContain("issue_write");
    // Not an observation: pre-warm must keep trying to learn the real list,
    // and the bundled one never becomes a deferred route.
    p.config = { configVersion: "v1", servers: [gh()] };
    expect(p.hasKnownTools(gh())).toBe(false);
    expect(p.getDeferredServers()).toEqual([]);
  });

  it("lets every real list win: learned, learned-but-empty, curated and live", () => {
    const p = priv();
    p.toolCache.set("gh", [{ name: "real_tool", description: "learned" }]);
    expect(p.rankableTools(gh())).toEqual({ tools: [{ name: "real_tool", description: "learned" }], source: "known" });

    p.toolCache.set("gh", []);
    expect(p.rankableTools(gh())).toEqual({ tools: [], source: "known" });

    p.toolCache.delete("gh");
    const curated = { ...gh(), toolCache: [{ name: "curated_tool" }] };
    expect(p.rankableTools(curated).source).toBe("known");
    expect(p.rankableFor(curated).tools).toEqual([{ name: "curated_tool" }]);

    p.connections.set("gh", connection(gh(), [{ name: "live_tool" }]));
    expect(p.rankableTools(gh())).toEqual({ tools: [{ name: "live_tool", description: undefined }], source: "live" });
  });

  it("gives an unknown server nothing, whatever it is named", () => {
    const p = priv();
    const named = cfg({ namespace: "github", name: "GitHub", command: "npx", args: ["-y", "some-github-thing"] });
    expect(p.rankableTools(named)).toEqual({ tools: [], source: "none" });
  });
});

describe("find_tool and servers it cannot search", () => {
  const servers = () => [
    cfg({ id: "ts", namespace: "tailscale", name: "Tailscale", description: "Tailnet devices and keys" }),
    cfg({ id: "gh", namespace: "github", name: "GitHub", description: "GitHub issues and pull requests" }),
  ];

  it("names a matching server with no tool list and points at dispatch, even when another tool ranks", async () => {
    const p = priv();
    p.config = { configVersion: "v1", servers: servers() };
    p.toolCache.set("tailscale", [{ name: "tailscale_create_key", description: "Create an auth key" }]);
    const text: string = (await p.handleFindTool("create a github issue")).content[0].text;
    expect(text).toContain("tailscale_tailscale_create_key");
    expect(text).toContain(
      'Not searched: github matches this request by name or description, but its tool list is unknown until it has loaded once. mcp_connect_dispatch {"intent":"create a github issue"} loads the best match',
    );
  });

  it("says so instead of 'no configured server' when only an unsearchable server matches", async () => {
    const p = priv();
    p.config = { configVersion: "v1", servers: servers() };
    p.toolCache.set("tailscale", [{ name: "list_devices", description: "List devices" }]);
    const text: string = (await p.handleFindTool("open a pull request")).content[0].text;
    expect(text).toMatch(/^No known tool matches "open a pull request"\. Not searched: github matches/);
    expect(text).not.toContain("No configured server");
  });

  it("keeps the old answer when every matching server's list is known", async () => {
    const p = priv();
    p.config = { configVersion: "v1", servers: servers() };
    p.toolCache.set("tailscale", [{ name: "list_devices", description: "List devices" }]);
    p.toolCache.set("github", [{ name: "list_repos", description: "List repositories" }]);
    const text: string = (await p.handleFindTool("open a pull request")).content[0].text;
    expect(text).toMatch(/^No configured server has a tool matching/);
    expect(text).not.toContain("Not searched");
  });

  it("finds a bundled-list tool and labels it unconfirmed", async () => {
    const p = priv();
    p.config = {
      configVersion: "v1",
      servers: [servers()[0], { ...servers()[1], ...GH_IMAGE }],
    };
    p.toolCache.set("tailscale", [{ name: "tailscale_create_key", description: "Create an auth key" }]);
    const text: string = (await p.handleFindTool("create a github issue")).content[0].text;
    const first = text.split("\n")[2];
    expect(first).toBe("  github_issue_write [bundled list]");
    expect(text).toContain("[bundled list]: github has never loaded on this machine");
    expect(text).not.toContain("Not searched");

    // Once the server has loaded, its real list replaces the bundled one.
    p.toolCache.set("github", [{ name: "create_issue", description: "Create a GitHub issue" }]);
    const after: string = (await p.handleFindTool("create a github issue")).content[0].text;
    expect(after).toContain("  github_create_issue\n");
    expect(after).not.toContain("bundled");
    expect(after).not.toContain("issue_write");
  });
});

describe("dispatch names the tools that fit, with their arguments", () => {
  const npm = () => cfg({ id: "npm", namespace: "npmjs", name: "npm", description: "npm registry packages" });
  const tools: ToolSpec[] = [
    {
      name: "npm_downloads",
      description: "Download counts for a package",
      inputSchema: {
        type: "object",
        properties: { period: { type: "string" }, name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "npm_search",
      description: "Search packages",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    { name: "npm_whoami", description: "Who is logged in" },
  ];

  it("lists the best-ranked loaded tools as signatures and uses the top one in the exec line", async () => {
    const p = priv();
    // A client that never re-lists, the one that still gets an exec line.
    p.server.getClientVersion = () => ({ name: "codex-mcp-client", version: "0.1.0" });
    p.config = { configVersion: "v1", servers: [npm()] };
    vi.mocked(connectToUpstream).mockImplementation(async (c: UpstreamServerConfig) => connection(c, tools));
    const text: string = (await p.handleDispatch("weekly downloads for the lodash package", 1)).content[0].text;
    expect(text).toContain(
      "Best tools for this request (arguments: required first, optional marked ?):\n  npmjs_npm_downloads(name: string, period?: string)",
    );
    expect(text).toContain(
      '{"steps":[{"tool":"npmjs_npm_downloads","args":{}}]} (with the tool\'s own arguments in "args"',
    );
    expect(text.match(/^ {2}npmjs_/gm)?.length ?? 0).toBeLessThanOrEqual(DISPATCH_TOOL_HINTS);
  });

  it("names no tools when none shares a word with the intent", async () => {
    const p = priv();
    p.server.getClientVersion = () => ({ name: "codex-mcp-client", version: "0.1.0" });
    p.config = { configVersion: "v1", servers: [npm()] };
    vi.mocked(connectToUpstream).mockImplementation(async (c: UpstreamServerConfig) => connection(c, tools));
    const text: string = (await p.handleDispatch("registry", 1)).content[0].text;
    expect(text).not.toContain("Best tools for this request");
    expect(text).toContain("Call them through mcp_connect_exec instead");
  });
});

describe("no exec line on load replies to a client that re-lists, and exec on a tool just loaded", () => {
  const gh = () => cfg({ id: "gh", namespace: "gh", name: "GitHub", description: "Repos and issues" });
  const ghTools: ToolSpec[] = [
    {
      name: "create_issue",
      description: "Create an issue",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
  ];

  it.each([
    // Claude Code calls a just-loaded tool directly once ToolSearch selects
    // it: no "No such tool available" in 60 live 1.1.7 sessions, so the line
    // it used to get cost ~350 characters a reply for nothing.
    ["Claude Code", { name: "claude-code", version: "2.1.317" }],
    ["a client that calls re-listed tools directly", { name: "cursor-vscode", version: "1.0" }],
    ["a client that sent no clientInfo", undefined],
  ])("adds no exec line for %s", async (_label, client) => {
    const p = priv();
    p.config = { configVersion: "v1", servers: [gh()] };
    p.server.getClientVersion = () => client;
    vi.mocked(connectToUpstream).mockImplementation(async (c: UpstreamServerConfig) => connection(c, ghTools));
    expect((await p.handleActivate(["gh"])).content[0].text).toBe('Loaded "gh" — 1 tool: gh_create_issue');
    await p.handleDeactivate(["gh"]);
    expect((await p.handleDispatch("create a github issue", 1)).content[0].text).not.toContain("mcp_connect_exec");
  });

  it("exec reaches a tool activated a moment ago, in the shape the line shows", async () => {
    const p = priv();
    p.config = { configVersion: "v1", servers: [gh()] };
    let conn: UpstreamConnection | undefined;
    vi.mocked(connectToUpstream).mockImplementation(async (c: UpstreamServerConfig) => {
      conn = connection(c, ghTools);
      return conn;
    });
    await p.handleDispatch("create a github issue", 1);
    const result = await p.handleExec({ steps: [{ tool: "gh_create_issue", args: { title: "login bug" } }] });
    expect(result.isError).toBeFalsy();
    const calls = vi.mocked(conn?.client.callTool as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ name: "create_issue", arguments: { title: "login bug" } });
  });
});

describe("exec checks a step's args against the tool's schema before anything runs", () => {
  const npm = () => cfg({ id: "npm", namespace: "npmjs", name: "npm", description: "npm registry" });
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, period: { type: "string" } },
    required: ["name"],
  };

  async function loaded(tools: ToolSpec[]): Promise<UpstreamConnection> {
    const p = priv();
    p.config = { configVersion: "v1", servers: [npm()] };
    let conn: UpstreamConnection | undefined;
    vi.mocked(connectToUpstream).mockImplementation(async (c: UpstreamServerConfig) => {
      conn = connection(c, tools);
      return conn;
    });
    await p.handleActivate(["npmjs"]);
    return conn as UpstreamConnection;
  }

  it("refuses a wrong key, names the one it meant and the full signature, and runs no step", async () => {
    const conn = await loaded([{ name: "npm_whoami" }, { name: "npm_downloads", inputSchema: schema }]);
    const result = await priv().handleExec({
      steps: [
        { id: "me", tool: "npmjs_npm_whoami", args: {} },
        { id: "dl", tool: "npmjs_npm_downloads", args: { package: "lodash" } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'exec: step "dl": the arguments do not fit "npmjs_npm_downloads"; no step ran. Missing required: name. Not in the schema: package (did you mean "name"?). Expected: npmjs_npm_downloads(name: string, period?: string)',
    );
    expect(conn.client.callTool).not.toHaveBeenCalled();
  });

  it("forwards args that fit, a $ref value, and anything for a tool with no usable schema", async () => {
    const conn = await loaded([
      { name: "npm_downloads", inputSchema: schema },
      {
        name: "npm_open",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
      },
      { name: "npm_any" },
    ]);
    const ok = await priv().handleExec({
      steps: [
        { id: "a", tool: "npmjs_npm_any", args: { whatever: 1 } },
        { id: "b", tool: "npmjs_npm_open", args: { q: "x", extra: true } },
        { id: "c", tool: "npmjs_npm_downloads", args: { name: { $ref: "a" } } },
        // no additionalProperties in `schema`: JSON Schema allows the extra key
        { id: "d", tool: "npmjs_npm_downloads", args: { name: "lodash", verbose: true } },
      ],
    });
    expect(ok.isError).toBeFalsy();
    expect(conn.client.callTool).toHaveBeenCalledTimes(4);
  });
});

describe("formatToolSignature", () => {
  it("puts required arguments first, marks optional ones and caps the list", () => {
    const schema = {
      type: "object",
      properties: {
        b: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        mode: { enum: ["a", "b"] },
        when: { type: ["string", "null"] },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        a: {},
      },
      required: ["a"],
    };
    expect(formatToolSignature("t", schema)).toBe(
      "t(a: any, b?: integer, tags?: string[], mode?: enum, when?: string, either?: string|number)",
    );
    expect(formatToolSignature("t", schema, 2)).toBe("t(a: any, b?: integer, +4 more)");
    expect(formatToolSignature("t", undefined)).toBe("t()");
  });
});

describe("checkToolArgs", () => {
  const schema = {
    type: "object",
    properties: { repo_name: { type: "string" }, owner: { type: "string" }, title: { type: "string" } },
    required: ["owner", "title"],
  };

  it("passes args that fit, and cannot judge a schema that lists nothing", () => {
    expect(checkToolArgs(schema, { owner: "o", title: "t" })).toBeNull();
    expect(checkToolArgs({ type: "object" }, { anything: 1 })).toBeNull();
    expect(checkToolArgs(undefined, { anything: 1 })).toBeNull();
  });

  it("reports missing required properties", () => {
    expect(checkToolArgs(schema, { owner: "o" })).toEqual({ missing: ["title"], unknown: [] });
  });

  it("suggests the same word spelled differently, then the lone missing property, then a close spelling", () => {
    const closed = { ...schema, additionalProperties: false };
    expect(checkToolArgs(closed, { owner: "o", title: "t", repoName: "r" })?.unknown).toEqual([
      { key: "repoName", suggestion: "repo_name" },
    ]);
    expect(checkToolArgs(closed, { owner: "o", heading: "t" })?.unknown).toEqual([
      { key: "heading", suggestion: "title" },
    ]);
    expect(checkToolArgs(closed, { owner: "o", title: "t", repo_nme: "x" })?.unknown).toEqual([
      { key: "repo_nme", suggestion: "repo_name" },
    ]);
    expect(checkToolArgs(closed, { owner: "o", title: "t", zzz: 1 })?.unknown).toEqual([{ key: "zzz" }]);
  });

  it("allows extra keys unless the schema says additionalProperties: false", () => {
    for (const extra of [
      {},
      { additionalProperties: true },
      { additionalProperties: { type: "string" } },
      { allOf: [] },
      { dependencies: {} },
      { unevaluatedProperties: false },
    ]) {
      expect(checkToolArgs({ ...schema, ...extra }, { owner: "o", title: "t", more: 1 })).toBeNull();
    }
    expect(checkToolArgs({ ...schema, additionalProperties: false }, { owner: "o", title: "t", more: 1 })).toEqual({
      missing: [],
      unknown: [{ key: "more" }],
    });
  });

  it("names an extra key as a hint when an open schema already fails on a missing property", () => {
    expect(checkToolArgs(schema, { owner: "o", heading: "t" })).toEqual({
      missing: ["title"],
      unknown: [{ key: "heading", suggestion: "title" }],
    });
  });
});
