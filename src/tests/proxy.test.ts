import { describe, expect, it } from "vitest";
import { META_TOOLS } from "../meta-tools.js";
import {
  type BuiltinResource,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  routeResourceRead,
} from "../proxy.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";

function makeInactiveServer(
  namespace: string,
  cachedTools: Array<{ name: string; description?: string }>,
): UpstreamServerConfig {
  return {
    id: `id-${namespace}`,
    name: namespace,
    namespace,
    type: "local",
    isActive: true,
    toolCache: cachedTools,
  };
}

function makeConnection(
  namespace: string,
  tools: string[],
  resources: string[] = [],
  prompts: string[] = [],
): UpstreamConnection {
  return {
    config: { id: "1", name: namespace, namespace, type: "local", isActive: true },
    client: {} as any,
    transport: {} as any,
    tools: tools.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
      inputSchema: { type: "object" },
    })),
    resources: resources.map((uri) => ({
      uri,
      namespacedUri: `connect://${namespace}/${uri}`,
      name: uri,
    })),
    prompts: prompts.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
    })),
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as UpstreamConnection;
}

describe("buildToolList", () => {
  it("includes meta-tools first", () => {
    const connections = new Map<string, UpstreamConnection>();
    const tools = buildToolList(connections);
    const metaNames = Object.values(META_TOOLS).map((m) => m.name);
    expect(tools.length).toBe(metaNames.length);
    for (const name of metaNames) {
      expect(tools.some((t) => t.name === name)).toBe(true);
    }
  });

  it("includes upstream tools after meta-tools", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
    const tools = buildToolList(connections);
    const metaCount = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(metaCount + 2);
    expect(tools[metaCount].name).toBe("gh_create_issue");
    expect(tools[metaCount + 1].name).toBe("gh_list_prs");
  });

  it("includes tools from multiple connections", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    connections.set("slack", makeConnection("slack", ["send_message"]));
    const tools = buildToolList(connections);
    const metaCount = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(metaCount + 2);
  });
});

describe("buildToolRoutes", () => {
  it("maps namespaced names to original names", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const routes = buildToolRoutes(connections);
    expect(routes.get("gh_create_issue")).toEqual({ namespace: "gh", originalName: "create_issue" });
  });

  it("handles multiple connections", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    connections.set("slack", makeConnection("slack", ["send_message"]));
    const routes = buildToolRoutes(connections);
    expect(routes.size).toBe(2);
    expect(routes.get("slack_send_message")).toEqual({ namespace: "slack", originalName: "send_message" });
  });
});

describe("buildToolList — deferred tools from inactive-but-cached servers", () => {
  it("emits deferred entries with a permissive placeholder schema", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue", description: "open a new issue" }])];
    const tools = buildToolList(connections, inactive);
    const entry = tools.find((t) => t.name === "gh_create_issue");
    expect(entry).toBeDefined();
    // Permissive placeholder — the upstream's real schema is unknown
    // until first activation, so any-object is the safest stand-in.
    expect(entry?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    // Cached description is preserved; a bracketed yaw-mcp note is appended
    // so the client knows activation hasn't happened yet.
    expect(entry?.description).toContain("open a new issue");
    expect(entry?.description).toContain("not yet connected");
  });

  it("an active connection with the same namespace wins over a deferred entry", () => {
    // Safety rail: if a server's real tool set exposes create_issue AND
    // its cached tools also include create_issue, the LIVE definition
    // (real inputSchema, real description) must not be shadowed by a
    // placeholder — clients would see their valid call fail validation.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue", description: "stale cached version" }])];
    const tools = buildToolList(connections, inactive);
    const ghTools = tools.filter((t) => t.name === "gh_create_issue");
    expect(ghTools.length).toBe(1);
    // The live schema { type: "object" } from makeConnection, not the
    // placeholder — ensures we didn't overwrite.
    expect(ghTools[0].inputSchema).toEqual({ type: "object" });
  });

  it("skips inactive servers whose toolCache is missing or empty", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive: UpstreamServerConfig[] = [
      { id: "a", name: "a", namespace: "a", type: "local", isActive: true },
      { id: "b", name: "b", namespace: "b", type: "local", isActive: true, toolCache: [] },
    ];
    const tools = buildToolList(connections, inactive);
    const meta = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(meta);
  });
});

describe("buildToolList — tool filters", () => {
  it("applies a namespace filter to ACTIVE tools", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, [], filters);
    expect(tools.some((t) => t.name === "gh_create_issue")).toBe(true);
    expect(tools.some((t) => t.name === "gh_list_prs")).toBe(false);
  });

  it("applies the SAME filter to deferred entries from an idle server", () => {
    // Without this, a filtered-out tool reappears in tools/list the moment
    // its server goes idle: the deferred branch would advertise the full
    // cached set while the filter still applies to the live one.
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }, { name: "list_prs" }])];
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, inactive, filters);
    expect(tools.some((t) => t.name === "gh_create_issue")).toBe(true);
    expect(tools.some((t) => t.name === "gh_list_prs")).toBe(false);
  });

  it("leaves an unfiltered namespace's deferred entries alone", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("slack", [{ name: "send_message" }])];
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, inactive, filters);
    expect(tools.some((t) => t.name === "slack_send_message")).toBe(true);
  });
});

describe("buildToolList — cross-namespace name collisions", () => {
  it("emits ONE entry when two active namespaces flatten to the same name", () => {
    // (ns=`gh`, tool=`actions_list`) and (ns=`gh_actions`, tool=`list`) both
    // render as `gh_actions_list`. MCP tool names must be unique, so the
    // list must not carry the name twice.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["actions_list"]));
    connections.set("gh_actions", makeConnection("gh_actions", ["list"]));
    const tools = buildToolList(connections);
    expect(tools.filter((t) => t.name === "gh_actions_list")).toHaveLength(1);
    expect(tools).toHaveLength(Object.keys(META_TOOLS).length + 1);
  });

  it("does not let an upstream tool duplicate a meta-tool name", () => {
    const metaName = Object.values(META_TOOLS)[0].name;
    const connections = new Map<string, UpstreamConnection>();
    // Craft a connection whose namespaced name IS a meta-tool name.
    const conn = makeConnection("ns", ["x"]);
    conn.tools[0].namespacedName = metaName;
    connections.set("ns", conn);
    const tools = buildToolList(connections);
    expect(tools.filter((t) => t.name === metaName)).toHaveLength(1);
  });
});

describe("buildToolRoutes — deferred routes", () => {
  it("marks deferred: true for routes generated from toolCache", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }])];
    const routes = buildToolRoutes(connections, inactive);
    const route = routes.get("gh_create_issue");
    expect(route).toEqual({ namespace: "gh", originalName: "create_issue", deferred: true });
  });

  it("an active route takes precedence over a deferred one for the same name", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }])];
    const routes = buildToolRoutes(connections, inactive);
    const route = routes.get("gh_create_issue");
    // No deferred flag — the active route wins. Without this rule a
    // tools/call on a live tool could get routed through the deferred
    // branch and activateOne would be called on an already-connected
    // server, racing with the real dispatch.
    expect(route?.deferred).toBeUndefined();
    expect(route?.namespace).toBe("gh");
    expect(route?.originalName).toBe("create_issue");
  });

  it("warns when two DEFERRED servers collide on the same namespaced name", () => {
    // First cached server wins; the loser's tool is unreachable until an
    // operator renames a namespace, so the collision must not be silent.
    // (The active-vs-deferred case above is intended shadowing -- no warn.)
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      const routes = buildToolRoutes(new Map(), [
        makeInactiveServer("gh", [{ name: "actions_list" }]),
        makeInactiveServer("gh_actions", [{ name: "list" }]),
      ]);
      // First writer wins.
      expect(routes.get("gh_actions_list")).toEqual({
        namespace: "gh",
        originalName: "actions_list",
        deferred: true,
      });
      expect(writes.some((w) => w.includes("Deferred tool route collision"))).toBe(true);
    } finally {
      process.stderr.write = original;
    }
  });

  it("does NOT warn when an active route shadows a deferred one", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      const connections = new Map<string, UpstreamConnection>();
      connections.set("gh", makeConnection("gh", ["actions_list"]));
      buildToolRoutes(connections, [makeInactiveServer("gh_actions", [{ name: "list" }])]);
      expect(writes.some((w) => w.includes("collision"))).toBe(false);
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("buildResourceList / buildResourceRoutes", () => {
  it("lists resources with namespaced URIs", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections);
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe("connect://db/db://tables");
  });

  it("builds resource routes", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const routes = buildResourceRoutes(connections);
    expect(routes.get("connect://db/db://tables")).toEqual({ namespace: "db", originalUri: "db://tables" });
  });
});

describe("buildResourceList — builtins", () => {
  const guideBuiltin: BuiltinResource = {
    uri: "yaw-mcp://guide",
    name: "yaw-mcp guide",
    description: "Project + user guidance from YAW-MCP.md",
    mimeType: "text/markdown",
    read: async () => ({ contents: [{ uri: "yaw-mcp://guide", text: "hello", mimeType: "text/markdown" }] }),
  };

  it("returns just builtins when no upstream connections exist", () => {
    const resources = buildResourceList(new Map(), [guideBuiltin]);
    expect(resources).toEqual([
      {
        uri: "yaw-mcp://guide",
        name: "yaw-mcp guide",
        description: "Project + user guidance from YAW-MCP.md",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("lists builtins BEFORE upstream resources", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections, [guideBuiltin]);
    expect(resources.length).toBe(2);
    expect(resources[0].uri).toBe("yaw-mcp://guide");
    expect(resources[1].uri).toBe("connect://db/db://tables");
  });

  it("omits builtins when none are passed (back-compat)", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections);
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe("connect://db/db://tables");
  });
});

describe("routeResourceRead — builtins", () => {
  it("serves a builtin from the builtins map without touching upstream", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "guide-body" }] }),
    });
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("guide-body");
  });

  it("awaits an async builtin reader", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { contents: [{ uri: "yaw-mcp://guide", text: "async-body" }] };
      },
    });
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("async-body");
  });

  it("returns a graceful error text when a builtin reader throws (does NOT propagate)", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => {
        throw new Error("read exploded");
      },
    });
    // An MCP client that gets a thrown exception here would see a
    // generic JSON-RPC failure; by returning a text body we can surface
    // the actual error to the user without crashing the session.
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("read exploded");
  });

  it("falls through to upstream routing when URI is not a builtin", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "builtin" }] }),
    });
    // No matching upstream route either → the "Unknown resource" text path.
    const result = await routeResourceRead("connect://unknown/x", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("works with undefined builtins (back-compat)", async () => {
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map());
    // No builtins, no upstream route → unknown resource.
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("builtin takes precedence even when an upstream resource has the same URI", async () => {
    // An upstream server accidentally registers `yaw-mcp://guide` as one of
    // its resources. The builtin should still win — yaw-mcp is canonical
    // for its own namespace.
    const connections = new Map<string, UpstreamConnection>();
    const fakeClient = {
      readResource: async () => ({ contents: [{ uri: "yaw-mcp://guide", text: "upstream-body" }] }),
    };
    const conn = makeConnection("evil", [], ["yaw-mcp://guide"]);
    (conn as any).client = fakeClient;
    connections.set("evil", conn);

    const routes = new Map();
    routes.set("yaw-mcp://guide", { namespace: "evil", originalUri: "yaw-mcp://guide" });

    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "builtin-body" }] }),
    });

    const result = await routeResourceRead("yaw-mcp://guide", routes, connections, builtins);
    expect(result.contents[0].text).toBe("builtin-body");
  });
});

describe("buildPromptList / buildPromptRoutes", () => {
  it("lists prompts with namespaced names", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", [], [], ["review_pr"]));
    const prompts = buildPromptList(connections);
    expect(prompts.length).toBe(1);
    expect(prompts[0].name).toBe("gh_review_pr");
  });

  it("builds prompt routes", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", [], [], ["review_pr"]));
    const routes = buildPromptRoutes(connections);
    expect(routes.get("gh_review_pr")).toEqual({ namespace: "gh", originalName: "review_pr" });
  });
});
