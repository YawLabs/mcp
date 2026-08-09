import { log } from "./logger.js";
import { META_TOOLS } from "./meta-tools.js";
import type { UpstreamConnection, UpstreamServerConfig } from "./types.js";

export interface ToolRoute {
  namespace: string;
  originalName: string;
  // True when this route points at a server that isn't currently
  // connected but has a persisted toolCache — the call handler is
  // expected to activate the upstream on first tools/call, rebuild
  // routes, and re-dispatch. Not set (or false) for routes backed by
  // an active connection.
  deferred?: boolean;
}

// Permissive placeholder schema for deferred tools. We don't have the
// upstream's real inputSchema until it's been activated; clients that
// validate locally need *something*, and `additionalProperties: true`
// lets any shape through. The real schema takes over after activation
// via list_changed.
const DEFERRED_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

function deferredDescription(server: UpstreamServerConfig, cachedDesc: string | undefined): string {
  const base = cachedDesc?.trim();
  const suffix = `[yaw-mcp: server "${server.namespace}" not yet connected — first call activates it]`;
  return base ? `${base}\n\n${suffix}` : suffix;
}

export interface ResourceRoute {
  namespace: string;
  originalUri: string;
}

export interface PromptRoute {
  namespace: string;
  originalName: string;
}

export type ResourceContents = {
  contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
};

// A resource yaw-mcp itself provides — not proxied from an upstream server.
// Today the only one is `yaw-mcp://guide` (rendered YAW-MCP.md), but the shape
// is general so future hosts like `yaw-mcp://config` or `yaw-mcp://health`
// can slot in the same way. Keeping the read side as a closure means
// callers (e.g. server.ts) can capture session state without yaw-mcp
// having to thread request context into proxy.ts.
export interface BuiltinResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<ResourceContents> | ResourceContents;
}

/**
 * How much of the catalog `tools/list` advertises.
 *
 * - `gateway` (default): the meta-tools, plus the tools of namespaces
 *   activated THIS SESSION. Nothing else — no deferred placeholders.
 * - `full`: the historical behavior — meta-tools, every active upstream's
 *   tools, and a deferred placeholder for every cached-but-inactive one.
 *
 * WHY GATEWAY IS THE DEFAULT. Deferring only the SCHEMA is not enough to make
 * a large catalog affordable. Measured 2026-08-09 against this install:
 * `tools/list` returned 252 tools / 108,025 chars (~27,000 tokens), of which
 * only 10 were meta-tools -- and the other 242 were ALREADY deferred, each
 * carrying the 61-char placeholder schema. The bytes were in the NAMES and
 * DESCRIPTIONS, which schema-deferral never removed. That payload is ~13% of a
 * 200K context and does not fit a 32K one at all: it failed every turn of a
 * 32,768-token local model with a hard 400 before the user's first token.
 *
 * Clients like Claude Code hide those descriptions themselves, which is why
 * this stayed invisible -- but that is a client-side compensation, and yaw-mcp
 * is used by clients with no such mechanism. Withholding the catalog at the
 * SERVER makes the gateway pattern work everywhere: discovery moves to
 * mcp_connect_discover / _suggest / _bundles, activation is explicit, and
 * mcp_connect_dispatch still reaches any tool by name without it ever having
 * been advertised.
 */
export type ToolExposure = "gateway" | "full";

export function buildToolList(
  activeConnections: Map<string, UpstreamConnection>,
  inactiveWithCache: UpstreamServerConfig[] = [],
  // Optional per-namespace filter: when a namespace has an entry, only
  // tools whose BARE name is in the set are advertised via tools/list.
  // Routes (buildToolRoutes) stay complete regardless, so the filter
  // only affects surfacing — mcp_connect_dispatch can still reach
  // hidden tools by name.
  toolFilters?: Map<string, Set<string>>,
  // Defaults to "full" so this function's contract is unchanged for any
  // caller that does not pass it. The POLICY default (gateway) lives in
  // resolveToolExposure() and is applied by the server -- keeping it out of
  // here means a helper or test calling buildToolList directly cannot
  // silently lose its tools.
  exposure: ToolExposure = "full",
  // Namespaces the client explicitly activated this session. Only consulted
  // in gateway mode; `full` advertises everything regardless.
  exposedNamespaces?: ReadonlySet<string>,
): Array<{
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}> {
  const tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }> = [];
  const seen = new Set<string>();

  // Meta-tools first
  for (const meta of Object.values(META_TOOLS)) {
    tools.push({
      name: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema as Record<string, unknown>,
      annotations: meta.annotations as Record<string, unknown>,
    });
    seen.add(meta.name);
  }

  // Active upstream tools. The `seen` guard is load-bearing: the
  // namespaced name is `${namespace}_${tool}`, so (ns=`gh`,
  // tool=`actions_list`) and (ns=`gh_actions`, tool=`list`) both render as
  // `gh_actions_list`. Without the check the SAME name would be emitted
  // twice in tools/list (MCP names must be unique; clients dedupe
  // arbitrarily or error). First writer wins here, matching the meta-tool
  // precedence above; buildToolRoutes logs the collision.
  for (const conn of activeConnections.values()) {
    // Gateway mode advertises a namespace only once the client has asked for
    // it. A server that is merely CONNECTED does not qualify: yaw-mcp
    // pre-warms dormant servers on its own (prewarmDormantServers), so
    // keying on connectedness would re-advertise the whole catalog through
    // the back door and undo the point of the mode.
    if (exposure === "gateway" && !exposedNamespaces?.has(conn.config.namespace)) continue;
    const filter = toolFilters?.get(conn.config.namespace);
    for (const tool of conn.tools) {
      if (filter && !filter.has(tool.name)) continue;
      if (seen.has(tool.namespacedName)) continue;
      tools.push({
        name: tool.namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      });
      seen.add(tool.namespacedName);
    }
  }

  // Deferred tools from inactive-but-configured servers. Active entries
  // above win any collision — a tool the client just saw backed by a
  // live connection must not be silently swapped for a placeholder.
  //
  // The per-namespace filter applies here too: a namespace with a live
  // filter but no connection would otherwise advertise its FULL cached
  // tool set, so a filtered-out tool reappears the moment its server goes
  // idle. Filters key on the BARE tool name, same as the active branch.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    // These placeholders ARE the ~27,000 tokens gateway mode exists to
    // remove. Withholding them costs nothing in reach: buildToolRoutes
    // ignores exposure, so mcp_connect_dispatch and a first tools/call
    // still activate the server and re-dispatch.
    if (exposure === "gateway") continue;
    const filter = toolFilters?.get(server.namespace);
    for (const cached of server.toolCache) {
      if (filter && !filter.has(cached.name)) continue;
      const namespacedName = `${server.namespace}_${cached.name}`;
      if (seen.has(namespacedName)) continue;
      tools.push({
        name: namespacedName,
        description: deferredDescription(server, cached.description),
        inputSchema: DEFERRED_INPUT_SCHEMA,
      });
      seen.add(namespacedName);
    }
  }

  return tools;
}

export function buildToolRoutes(
  activeConnections: Map<string, UpstreamConnection>,
  inactiveWithCache: UpstreamServerConfig[] = [],
): Map<string, ToolRoute> {
  const routes = new Map<string, ToolRoute>();

  // Active routes. The namespaced name is `${namespace}_${tool}` and the
  // separator is `_` -- combinations like (ns=`gh`, tool=`actions_list`)
  // and (ns=`gh_actions`, tool=`list`) both produce `gh_actions_list`.
  // Last writer used to win silently; warn once per collision so the
  // operator can rename one of the upstreams.
  for (const conn of activeConnections.values()) {
    for (const tool of conn.tools) {
      const existing = routes.get(tool.namespacedName);
      if (existing && existing.namespace !== conn.config.namespace) {
        // FIRST writer wins, and the `continue` below is load-bearing.
        // buildToolList skips a duplicate namespacedName (see the `seen`
        // guard), so the schema the model is shown belongs to the FIRST
        // upstream. Letting routes.set fall through here made dispatch
        // last-writer-wins, so a collision meant the client validated
        // against one upstream's inputSchema and the call executed a
        // DIFFERENT upstream's tool -- and a later-activated server could
        // silently capture an earlier one's traffic. The two surfaces must
        // agree on the winner; first is the safe direction to agree on.
        log("warn", "Tool route collision; keeping the first upstream, ignoring the later one", {
          tool: tool.namespacedName,
          keptNamespace: existing.namespace,
          ignoredNamespace: conn.config.namespace,
        });
        continue;
      }
      routes.set(tool.namespacedName, {
        namespace: conn.config.namespace,
        originalName: tool.name,
      });
    }
  }

  // Deferred routes. Skip names that already route to an active
  // connection — the active route is authoritative, and that shadowing is
  // intended (no warn). A deferred-vs-DEFERRED collision is different:
  // two idle servers whose cached names flatten to the same string, first
  // one wins, and the loser's tool is unreachable until the operator
  // renames a namespace. Warn on that so it isn't silent.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    for (const cached of server.toolCache) {
      const namespacedName = `${server.namespace}_${cached.name}`;
      const existing = routes.get(namespacedName);
      if (existing) {
        if (existing.deferred && existing.namespace !== server.namespace) {
          log("warn", "Deferred tool route collision; earlier cached server wins", {
            tool: namespacedName,
            winningNamespace: existing.namespace,
            shadowedNamespace: server.namespace,
          });
        }
        continue;
      }
      routes.set(namespacedName, {
        namespace: server.namespace,
        originalName: cached.name,
        deferred: true,
      });
    }
  }

  return routes;
}

// Builtins come FIRST in the list — they come from yaw-mcp itself and are
// always present regardless of which servers are activated, so clients
// that scan the list top-down (Claude Code does) see the guide before
// the upstream noise.
export function buildResourceList(
  activeConnections: Map<string, UpstreamConnection>,
  builtins: BuiltinResource[] = [],
): Array<{ uri: string; name?: string; description?: string; mimeType?: string }> {
  const resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> = [];
  for (const b of builtins) {
    resources.push({ uri: b.uri, name: b.name, description: b.description, mimeType: b.mimeType });
  }
  for (const conn of activeConnections.values()) {
    for (const r of conn.resources) {
      resources.push({
        uri: r.namespacedUri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      });
    }
  }
  return resources;
}

export function buildResourceRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, ResourceRoute> {
  const routes = new Map<string, ResourceRoute>();
  for (const conn of activeConnections.values()) {
    for (const r of conn.resources) {
      routes.set(r.namespacedUri, { namespace: conn.config.namespace, originalUri: r.uri });
    }
  }
  return routes;
}

export function buildPromptList(activeConnections: Map<string, UpstreamConnection>): Array<{
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}> {
  const prompts: Array<{
    name: string;
    description?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }> = [];
  // Same `seen` guard, and for the same reason, as buildToolList: prompts
  // flatten to `${namespace}_${prompt}` too, so (ns=`gh`, prompt=`review_pr`)
  // and (ns=`gh_review`, prompt=`pr`) both render as `gh_review_pr`. MCP
  // prompt names must be unique; without the check the SAME name is emitted
  // twice in prompts/list and clients dedupe arbitrarily or error. First
  // writer wins, and buildPromptRoutes agrees on that winner.
  const seen = new Set<string>();
  for (const conn of activeConnections.values()) {
    for (const p of conn.prompts) {
      if (seen.has(p.namespacedName)) continue;
      prompts.push({
        name: p.namespacedName,
        description: p.description,
        arguments: p.arguments,
      });
      seen.add(p.namespacedName);
    }
  }
  return prompts;
}

export function buildPromptRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, PromptRoute> {
  const routes = new Map<string, PromptRoute>();
  for (const conn of activeConnections.values()) {
    for (const p of conn.prompts) {
      const existing = routes.get(p.namespacedName);
      if (existing && existing.namespace !== conn.config.namespace) {
        // FIRST writer wins, mirroring buildToolRoutes -- and the `continue`
        // is load-bearing for the same reason. buildPromptList skips a
        // duplicate namespacedName, so the prompt (description + argument
        // list) the client was shown belongs to the FIRST upstream. Letting
        // routes.set fall through made prompts/get last-writer-wins, so a
        // collision meant the client picked one upstream's prompt and got a
        // DIFFERENT upstream's -- and a later-activated server could silently
        // capture an earlier one's traffic. Both surfaces must agree on the
        // winner; first is the safe direction to agree on.
        log("warn", "Prompt route collision; keeping the first upstream, ignoring the later one", {
          prompt: p.namespacedName,
          keptNamespace: existing.namespace,
          ignoredNamespace: conn.config.namespace,
        });
        continue;
      }
      routes.set(p.namespacedName, { namespace: conn.config.namespace, originalName: p.name });
    }
  }
  return routes;
}

export async function routeResourceRead(
  uri: string,
  resourceRoutes: Map<string, ResourceRoute>,
  activeConnections: Map<string, UpstreamConnection>,
  builtins?: Map<string, BuiltinResource>,
): Promise<ResourceContents> {
  // Builtin resources are served directly by yaw-mcp and never route to an
  // upstream — check them first. A builtin's URI intentionally SHADOWS
  // an upstream URI with the same string, since the builtin is the
  // canonical answer for yaw-mcp-namespaced content (e.g. `yaw-mcp://guide`).
  const builtin = builtins?.get(uri);
  if (builtin) {
    try {
      return await builtin.read();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "Builtin resource read failed", { uri, error: message });
      return { contents: [{ uri, text: `Error: ${message}` }] };
    }
  }

  const route = resourceRoutes.get(uri);
  if (!route) {
    return { contents: [{ uri, text: `Unknown resource: ${uri}` }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (connection?.status !== "connected") {
    return { contents: [{ uri, text: `Server "${route.namespace}" is not connected.` }] };
  }

  try {
    const result = await connection.client.readResource({ uri: route.originalUri });
    return result as ResourceContents;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Resource read failed", { uri, namespace: route.namespace, error: message });
    return { contents: [{ uri, text: `Error: ${message}` }] };
  }
}

export async function routePromptGet(
  name: string,
  args: Record<string, string> | undefined,
  promptRoutes: Map<string, PromptRoute>,
  activeConnections: Map<string, UpstreamConnection>,
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  const route = promptRoutes.get(name);
  if (!route) {
    return { messages: [{ role: "user", content: { type: "text", text: `Unknown prompt: ${name}` } }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (connection?.status !== "connected") {
    return {
      messages: [{ role: "user", content: { type: "text", text: `Server "${route.namespace}" is not connected.` } }],
    };
  }

  try {
    const result = await connection.client.getPrompt({ name: route.originalName, arguments: args });
    return result as { messages: Array<{ role: string; content: { type: string; text: string } }> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Prompt get failed", { name, namespace: route.namespace, error: message });
    return { messages: [{ role: "user", content: { type: "text", text: `Error: ${message}` } }] };
  }
}

export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  toolRoutes: Map<string, ToolRoute>,
  activeConnections: Map<string, UpstreamConnection>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const route = toolRoutes.get(toolName);

  if (!route) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${toolName}. Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.`,
        },
      ],
      isError: true,
    };
  }

  const connection = activeConnections.get(route.namespace);

  if (connection?.status !== "connected") {
    return {
      content: [
        {
          type: "text",
          text: `Server "${route.namespace}" is no longer connected. Use mcp_connect_activate with server "${route.namespace}" to reconnect.`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await connection.client.callTool({
      name: route.originalName,
      arguments: args,
    });

    return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } catch (err) {
    // Transport-level errors (timeouts, JSON-RPC errors, disconnects)
    // come through here; structured upstream errors (`isError: true` in
    // the result) flow back through the success path above. Include the
    // MCP error code if present so the LLM can tell "args were wrong"
    // (-32602) from "the upstream is down" (transport) and decide
    // whether retrying makes sense.
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "number"
        ? (err as { code: number }).code
        : undefined;
    log("error", "Tool call failed", { tool: toolName, namespace: route.namespace, error: message, code });
    const codeTag = code !== undefined ? ` [code=${code}]` : "";
    return {
      content: [{ type: "text", text: `Error calling ${toolName}${codeTag}: ${message}` }],
      isError: true,
    };
  }
}
