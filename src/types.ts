import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  namespace: string;
  type: "local" | "remote";
  transport?: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  isActive: boolean;
  /**
   * Per-server connect timeout in milliseconds, as set in bundles.json.
   * Overrides the global MCP_CONNECT_TIMEOUT env var for this specific server.
   * Absent means "use the global default".
   */
  connectTimeoutMs?: number;
  // Free-text summary used by the BM25 ranker for dispatch + context-aware
  // discover. Optional in bundles.json; absent on most entries.
  description?: string;
  // Tools yaw-mcp reported back after the first activation in some earlier
  // session — used to rank servers that aren't currently connected, so
  // the ranker doesn't need to cold-start every dispatch by activating
  // every candidate.
  toolCache?: Array<{ name: string; description?: string }>;
  /**
   * A–F grade reported by the Yaw MCP compliance pipeline. Absent
   * on older backends or servers that haven't been scored yet. When
   * absent, the server is treated as "ungraded" and passes filters by
   * default (we don't punish unknown).
   */
  complianceGrade?: "A" | "B" | "C" | "D" | "F";
  /**
   * Opt this server into being hosted on the oam runtime (`oam run <entry>`)
   * instead of node/npx. "oam" = prefer oam when it's installed, falling back
   * to node/npx if oam is absent, below the minimum supported version, or the
   * package can't be resolved on disk.
   *
   * Absent = oam when it is installed and meets MIN_OAM_VERSION, else node (see
   * default-runtime.ts for the full resolution order). An explicit "node" is
   * the escape hatch that keeps a server off oam.
   *
   * Per-server -- set in bundles.json. See oam-spawn.ts.
   */
  runtime?: "oam" | "node";
}

export interface ConnectConfig {
  servers: UpstreamServerConfig[];
  configVersion: string;
}

export interface UpstreamToolDef {
  name: string;
  namespacedName: string;
  // Human-readable display name (MCP 2025-06-18). Forwarded downstream so
  // proxied tools keep their intended presentation.
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  // Structured-output contract (MCP 2025-06-18). Forwarding it is what lets
  // a downstream client validate the structuredContent that routeToolCall
  // already passes through verbatim; dropping it would hand clients
  // structured payloads for tools they were told have no output schema.
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface UpstreamResourceDef {
  uri: string;
  namespacedUri: string;
  name?: string;
  // Human-readable display name (MCP 2025-06-18), carried for the same
  // reason UpstreamToolDef carries it: a client rendering the proxied
  // resource must see the presentation the upstream intended. Dropping it
  // silently downgraded every titled upstream resource to its raw `name`.
  title?: string;
  description?: string;
  mimeType?: string;
  // Passthrough metadata (MCP 2025-06-18). Opaque to yaw-mcp -- forwarded
  // verbatim so an upstream/client pair that agrees on a _meta convention
  // keeps working through the proxy.
  _meta?: Record<string, unknown>;
}

export interface UpstreamPromptDef {
  name: string;
  namespacedName: string;
  // Same MCP 2025-06-18 display-name / metadata passthrough as
  // UpstreamResourceDef above -- prompts carry both fields too.
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  _meta?: Record<string, unknown>;
}

export interface ConnectionHealth {
  totalCalls: number;
  errorCount: number;
  totalLatencyMs: number;
  lastErrorMessage?: string;
  lastErrorAt?: string;
}

export type ConnectionStatus = "disconnected" | "connected" | "error";

export interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  tools: UpstreamToolDef[];
  resources: UpstreamResourceDef[];
  prompts: UpstreamPromptDef[];
  health: ConnectionHealth;
  status: ConnectionStatus;
  error?: string;
}
