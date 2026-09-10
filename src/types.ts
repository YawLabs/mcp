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
  /**
   * REMOTE ONLY -- HTTP request headers sent on every request the transport
   * makes (the GET event stream, every POST, and the DELETE), for both the
   * streamable-http and SSE transports. Values may carry `${secret:NAME}`
   * refs, resolved through the same vault path `env` uses and fail-CLOSED in
   * exactly the same way: a locked vault, a missing name or a malformed ref
   * refuses the connect rather than sending the literal.
   *
   * Ignored (with a warn) on a local entry, where `env` is the equivalent.
   * Unlike `env` there is no ambient fallback for a header -- nothing
   * inherits one from the shell -- so a blank value would claim a credential
   * is configured while sending nothing, and is dropped at load.
   */
  headers?: Record<string, string>;
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
   * A–F grade for this server, overlaid from the LOCAL grades cache that
   * `yaw-mcp audit <namespace>` writes to ~/.yaw-mcp/grades.json --
   * hydrateComplianceGrades (server.ts) and runList (local-add-cmd.ts)
   * apply it. It never rides along in bundles.json: validateEntry drops
   * unknown fields, so the cache is the only supplier. Absent on any
   * server that has not been audited; absent means "ungraded" and passes
   * filters by default (we don't punish unknown). See compliance.ts.
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

/** Does this entry connect over HTTP rather than spawning a process?
 *
 *  Which decides WHICH map carries its credentials: a local server's ride in
 *  `env`, substituted into the child at spawn; a remote server's ride in
 *  `headers`, resolved immediately before the transport is built. Reading the
 *  wrong one either invents a cause or hides a real one.
 *
 *  `type` alone is not enough. validateEntry (local-bundles.ts) defaults
 *  anything without an explicit `"type": "remote"` to "local", so a
 *  hand-written url+headers entry that omits the field reads as local and its
 *  headers -- the only credential it has -- get treated as a channel nothing
 *  uses. The url fallback is the same shape test renderLaunch and pinGaps in
 *  trust-cmd.ts already apply.
 *
 *  It lives here, in the module that owns UpstreamServerConfig and imports
 *  nothing at runtime, so every surface that has to agree on the answer can
 *  reach it: local-bundles re-exports it for the CLI, and meta-tools reads it
 *  for the secrets report without taking on the bundles loader's whole
 *  dependency chain.
 *
 *  The url fallback and validateEntry now agree rather than merely coexisting:
 *  validateEntry INFERS `type: "remote"` for a command-less url entry, so by
 *  the time any reader sees a loaded config the two answers are the same one.
 *  The fallback still earns its place for callers holding an entry that never
 *  went through validateEntry -- `add`'s in-flight entry before it is written,
 *  and any hand-built object in a test. */
export function isRemoteEntry(entry: { type?: string; command?: string; url?: string }): boolean {
  return entry.type === "remote" || (!entry.command && entry.url !== undefined);
}

/** Everything about an entry that decides WHAT a fresh activation would
 *  start: the process (command/args/env/runtime) or the endpoint (url/headers/
 *  transport), plus the connect timeout the attempt would run under. Two
 *  entries with the same launch identity produce the same upstream, so a live
 *  connection to one is a live connection to the other.
 *
 *  Deliberately EXCLUDES `name`, `description`, `toolCache`, `complianceGrade`
 *  and `isActive`. The first four are presentation and ranking metadata -- a
 *  reworded description must never cost the user a running server -- and
 *  `isActive` is a separate question the caller asks on its own (a server
 *  switched to false has to come down even though its launch identity is
 *  untouched), so folding it in here would blur "the config for this server
 *  moved" into "the user turned it off".
 *
 *  `env` and `headers` are serialized with their keys SORTED. JSON.stringify
 *  preserves insertion order, so a bundles.json rewrite that emits the same
 *  pairs in a different order would otherwise read as a changed launch and
 *  tear down a healthy connection for nothing. Values are compared, not
 *  hashed: a `${secret:NAME}` ref is compared as the ref it is, so rotating
 *  the VALUE behind an unchanged ref does not read as a config change (the
 *  ref resolves at connect time, so a rotation is picked up by the next
 *  activation either way).
 *
 *  It lives here, beside isRemoteEntry, for the same reason that one does:
 *  this module owns UpstreamServerConfig and imports nothing at runtime, so
 *  every surface that has to agree on the answer can reach it. */
export function launchIdentity(entry: UpstreamServerConfig): string {
  const stableMap = (m: Record<string, string> | undefined): Array<[string, string]> =>
    m === undefined
      ? []
      : Object.keys(m)
          .sort()
          .map((k) => [k, m[k]] as [string, string]);
  return JSON.stringify([
    entry.type,
    entry.transport ?? null,
    entry.command ?? null,
    entry.args ?? null,
    stableMap(entry.env),
    entry.url ?? null,
    stableMap(entry.headers),
    entry.connectTimeoutMs ?? null,
    entry.runtime ?? null,
  ]);
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
  /**
   * Result bytes this connection has returned, booked as a PAIR because
   * neither number is the answer on its own.
   *
   * `resultBytesUpstream` is the body the upstream server sent;
   * `resultBytesDownstream` is the same body after pruneContent and
   * capContent have run, i.e. what handleToolCall handed back. The product
   * claims to spend less of the model's context than talking to the servers
   * directly, and the DELTA between these two is the only part of that claim
   * this process can measure -- upstream alone says how chatty a server is,
   * downstream alone says what a session cost, and neither says what was
   * saved. They are booked at one site, together, for that reason.
   *
   * Required, not optional, for the same reason the three counters above are:
   * every live connection is born with them at 0 (upstream.ts), so an
   * `undefined` would mean nothing a reader could act on while forcing a
   * `?? 0` on every consumer and making "returned no bytes" indistinguishable
   * from "never measured".
   *
   * Both count SERIALIZED body bytes (content, plus structuredContent when
   * the upstream sent one) -- the closest measurable proxy for context spend,
   * not a token count, and nothing here claims otherwise.
   *
   * Two known limits, named rather than implied. An exec step books what the
   * STEP returned, though exec's own envelope may forward less of it
   * downstream, so for exec-heavy sessions `resultBytesDownstream` is an
   * upper bound and the saving it implies is a lower bound. And a result
   * whose body cannot be serialized books NOTHING on either side, so the
   * pair can never record a trim that did not happen.
   */
  resultBytesUpstream: number;
  resultBytesDownstream: number;
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
  /**
   * The upstream's own `instructions` from its initialize response, already
   * sanitized and length-bounded by sanitizeUpstreamInstructions -- NOT the
   * raw field. Undefined when the server sent none, or sent nothing that
   * survived sanitizing.
   *
   * Stored in its safe form on purpose: this is untrusted third-party text
   * bound for an LLM context, and a raw copy sitting on the connection is a
   * copy some future reader renders without going through the fence. The
   * remaining step before it is shown is fenceUpstreamInstructions, which
   * attributes and delimits it. See upstream-instructions.ts for the threat
   * model both halves answer.
   */
  instructions?: string;
  status: ConnectionStatus;
  error?: string;
}
