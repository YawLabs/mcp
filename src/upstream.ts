import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ClientCapabilities,
  type CreateMessageRequest,
  CreateMessageRequestSchema,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  type ListRootsRequest,
  ListRootsRequestSchema,
  type ListRootsResult,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { defaultRuntime } from "./default-runtime.js";
import { log } from "./logger.js";
import { oamHeapOomHint, probeOam, resolveOamSpawn } from "./oam-spawn.js";
import { appendAuditEvent } from "./secrets-audit.js";
import { hasSecretRefs, loadVault, resolveSecretRefs, SECRET_REF_RE, unlock, vaultPath } from "./secrets-vault.js";
import type {
  UpstreamConnection,
  UpstreamPromptDef,
  UpstreamResourceDef,
  UpstreamServerConfig,
  UpstreamToolDef,
} from "./types.js";
import { resolveUvSpawn } from "./uv-bootstrap.js";

/**
 * Resolve `${secret:NAME}` references in an upstream server's env
 * against the local secret vault. Fail-closed:
 *   - No refs in env: pass through unchanged (free path, no vault load).
 *   - Refs present but no vault file / locked / unlock fails / missing
 *     values: THROW. Passing literal `${secret:NAME}` to the child would
 *     leak the placeholder into logs or be interpreted as a real token
 *     by some servers, which is worse than refusing to spawn.
 *
 * Phase 6c ships passphrase-from-env only (YAW_MCP_VAULT_PASSPHRASE)
 * because the spawn happens in a non-interactive MCP-server context
 * where prompting on stdin would corrupt the parent's transport.
 * Per-server prompting would require a separate `yaw-mcp unlock`
 * step that pre-seeds the derived key into a session file -- that
 * is deferred to a follow-up.
 */
export async function resolveServerEnv(
  env: Record<string, string>,
  namespace: string,
): Promise<Record<string, string>> {
  if (!hasSecretRefs(env)) return env;
  const refKeys = Object.entries(env)
    .filter(([, v]) => typeof v === "string" && v.includes("${secret:"))
    .map(([k]) => k);
  const passphrase = process.env.YAW_MCP_VAULT_PASSPHRASE;
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    log("warn", "Server env carries ${secret:...} refs but YAW_MCP_VAULT_PASSPHRASE is not set", { keys: refKeys });
    throw new Error("vault locked: server env references ${secret:...} but YAW_MCP_VAULT_PASSPHRASE is not set");
  }
  const vault = await loadVault(vaultPath()).catch((err) => {
    log("warn", "Failed to load vault for env resolution", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!vault) {
    throw new Error("vault locked: server env references ${secret:...} but no vault exists yet");
  }
  const key = await unlock(vault, passphrase);
  const { resolved, missing } = resolveSecretRefs(env, vault, key);
  // Audit which secrets were consumed for this spawn -- NAME + namespace
  // only, never a value. Wrapped in try/catch (and each append is itself
  // fail-open) so a broken audit log can never block the spawn.
  //
  // Recorded BEFORE the missing-refs throw below: a FAILED spawn is exactly
  // the case an operator goes looking for in `yaw-mcp secrets audit`, and
  // the "missing" event kind is already advertised by that renderer. Audit
  // first, then refuse. recordResolveAudit itself suppresses "injected" on
  // the refusal path -- nothing reaches a child env when the spawn is
  // refused, so "injected" would be a lie (see its doc comment).
  try {
    await recordResolveAudit(namespace, env, missing);
  } catch (auditErr) {
    log("warn", "Failed to record secret-resolve audit (non-fatal)", {
      namespace,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }
  if (missing.length > 0) {
    throw new Error(`vault: missing or undecryptable secret refs: ${missing.join(", ")}`);
  }
  return resolved;
}

/**
 * Append one audit event per secret reference this spawn touched:
 *   - "missing" for each name the vault lacked,
 *   - "injected" for each distinct secret NAME that was referenced AND
 *     actually reaches the child env.
 * Names only -- the value is never read here, let alone written.
 *
 * The two kinds are mutually exclusive per call, and that is the whole
 * point: resolution is all-or-nothing. When ANY ref is missing, the caller
 * refuses the spawn, so NOTHING is injected -- not even the refs that
 * resolved fine. Recording those as "injected" anyway told an operator
 * asking "did this server ever receive my prod token?" a false yes.
 * So: missing refs present -> record ONLY the "missing" events (a refused
 * spawn must still leave a trail); otherwise -> record "injected", which
 * keeps meaning "went into a spawn env".
 */
async function recordResolveAudit(namespace: string, env: Record<string, string>, missing: string[]): Promise<void> {
  if (missing.length > 0) {
    for (const name of new Set(missing)) {
      await appendAuditEvent({ server: namespace, secret: name, event: "missing" });
    }
    return;
  }
  for (const name of collectSecretNames(env)) {
    await appendAuditEvent({ server: namespace, secret: name, event: "injected" });
  }
}

/** Distinct `${secret:NAME}` names referenced across an env map. */
function collectSecretNames(env: Record<string, string>): string[] {
  const names = new Set<string>();
  // Single source of truth for the ref shape is secrets-vault's
  // SECRET_REF_RE. It carries /g and is module-shared, and matchAll seeds
  // its internal clone from the source's lastIndex -- so build a fresh
  // instance from it rather than scanning with the shared object, which a
  // stale lastIndex elsewhere could make silently skip leading matches.
  const re = new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags);
  for (const v of Object.values(env)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(re)) names.add(m[1]);
  }
  return [...names];
}

declare const __VERSION__: string;

/** Default connect timeout. Per-server `config.connectTimeoutMs` wins
 *  when present; this is the fallback used otherwise. Env override
 *  (MCP_CONNECT_TIMEOUT) tunes the FALLBACK only -- per-server config
 *  always takes precedence so a slow server can be tuned independently
 *  of the global default. */
const DEFAULT_CONNECT_TIMEOUT = (() => {
  const env = process.env.MCP_CONNECT_TIMEOUT;
  if (!env) return 15_000;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

// Bound on per-request listTools/listResources/listPrompts after the
// initial handshake. Without this, a server that completes connect but
// then hangs on an inventory call would lock up activation forever (the
// CONNECT_TIMEOUT timer above is already cleared by the time we reach
// the listX calls). 15s matches the connect ceiling -- if a server
// can't list its own tools in 15s, surface it as a real failure.
const LIST_TIMEOUT = (() => {
  const env = process.env.MCP_LIST_TIMEOUT;
  if (!env) return 15_000;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

// Cap captured stderr so a chatty server can't balloon yaw-mcp's memory.
// 8KB tail is plenty to see the last error message — servers that emit
// multi-megabyte output to stderr before crashing are doing something
// pathological anyway.
const STDERR_RING_CAP = 8 * 1024;

// Per-category cap on how many entries we'll accept from a single
// upstream server. Without this a buggy or malicious server could
// return millions of tools and balloon yaw-mcp's memory. 1000 is well
// above what any real MCP server exposes today, and we log+truncate
// rather than reject so a slightly-over-cap server still works.
export const MAX_TOOLS_PER_SERVER = 1000;
export const MAX_RESOURCES_PER_SERVER = 1000;
export const MAX_PROMPTS_PER_SERVER = 1000;

// Bound on how many cursor'd pages a single list fetch will follow. Each
// page gets a fresh LIST_TIMEOUT, so bounding pages only by the item caps
// would let a misbehaving upstream dribble one slow item per page and hold
// a single activation for up to 1000 sequential requests -- and
// connectToUpstreamOnce runs three such fetches back to back. 50 pages is
// plenty for any legitimate inventory under the item caps (real servers
// paginate in the tens-to-hundreds of items per page), and it bounds the
// worst case to pages x LIST_TIMEOUT per category instead of hours.
export const MAX_LIST_PAGES = 50;

// Error categories surfaced to the caller. The dispatch/activate handlers
// use these to compose actionable messages rather than leaking raw SDK
// error strings.
export type ActivationFailureCategory =
  | "spawn_failure" // command not found / ENOENT
  | "install_failure" // process spawned but exited non-zero before handshake
  | "init_timeout" // process running but didn't complete init within CONNECT_TIMEOUT
  | "protocol_error" // handshake completed but something downstream failed
  | "unknown";

export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly category: ActivationFailureCategory,
    public readonly stderrTail?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ActivationError";
  }
}

/**
 * Redact secret values out of captured stderr before embedding it in error
 * messages. A server that crashes during init often echoes the bad value
 * back ("invalid token: ghp_abc123..."), and that string flows up into the
 * ActivationError -- which is logged, surfaced to the LLM, and often
 * pasted into bug reports. We never want the resolved cleartext to land
 * there.
 *
 * Strategy: for each env value that came from a `${secret:NAME}` ref
 * (i.e. anything that wasn't a literal at config time -- we approximate
 * by redacting EVERY env value of meaningful length), replace exact
 * occurrences with `***ENVKEY***`, where ENVKEY is the env var the value
 * was bound to (e.g. a leaked GITHUB_TOKEN value becomes
 * `***GITHUB_TOKEN***`). Naming the key keeps the message actionable --
 * the reader learns WHICH credential the server rejected without ever
 * seeing it. We also drop ${secret:NAME} literals themselves to
 * `${secret:***}` in case any leaked unresolved.
 *
 * The redactor is conservative: short values (<8 chars) are skipped to
 * avoid mangling unrelated substrings; the goal is to catch the high-
 * entropy tokens that look like secrets, not redact the entire output.
 */
function redactSecretsInOutput(text: string, env: Record<string, string>): string {
  let out = text;
  // Replace longest values first. When one secret value is a substring of
  // another (e.g. a token and that same token with a suffix), a short-first
  // pass can redact the inner value and leave a real-secret suffix exposed.
  // Descending-by-length order guarantees the containing value is redacted
  // whole before any of its substrings is considered.
  const entries = Object.entries(env).sort(
    ([, a], [, b]) => (typeof b === "string" ? b.length : 0) - (typeof a === "string" ? a.length : 0),
  );
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.length < 8) continue;
    // Skip values that are themselves an unresolved ${secret:...} literal.
    if (v.startsWith("${secret:") && v.endsWith("}")) continue;
    // Escape regex metacharacters in the secret value.
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), `***${k}***`);
  }
  // Catch unresolved literals too (defense in depth).
  out = out.replace(/\$\{secret:([a-zA-Z0-9_.-]+)\}/g, "${secret:***}");
  return out;
}

/**
 * Point the reader at the config they can actually edit. Shared by the
 * resolver-failure path and the connect-failure path so both carry the same
 * suffix -- a failure that skips it reads as an unclassified transport error
 * with nowhere to go. This used to append a dashboard deep-link
 * (#server-<id>); that dashboard is gone and the URL 404s, so naming the local
 * file and namespace is both accurate and more actionable -- the LLM can tell
 * the user exactly what to open.
 */
function withConfigPointer(message: string, config: UpstreamServerConfig): string {
  if (!config.namespace) return message;
  return `${message} → Fix in ~/.yaw-mcp/bundles.json under "${config.namespace}", then restart this MCP client.`;
}

function categorizeSpawnError(err: unknown): ActivationFailureCategory {
  const msg = err instanceof Error ? err.message : String(err);
  // Node's child_process surfaces ENOENT as the most common spawn failure —
  // binary isn't on PATH. Other codes (EACCES, EPERM) are rare enough to
  // bucket under spawn_failure too.
  if (/ENOENT|not found|cannot find|command failed to start/i.test(msg)) return "spawn_failure";
  if (/EACCES|permission denied/i.test(msg)) return "spawn_failure";
  return "unknown";
}

/** Spawn facts for one connectToUpstream CALL (not one attempt), threaded out
 *  of connectToUpstreamOnce so the wrapper can decide whether a failure
 *  qualifies for the oam->node downgrade (and log the oam version it
 *  downgraded from).
 *
 *  The SAME object is handed to the downgrade respawn on purpose and is NOT
 *  reset between the two attempts -- see oamRewriteApplied. */
interface SpawnAttempt {
  /** True when resolveOamSpawn actually CHANGED the launch (oam installed,
   *  command was node/npx, package resolved) -- i.e. "the oam rewrite was
   *  applied on this call", NOT "this connection is hosted on oam". A
   *  hand-written `command: "oam"` entry is returned unchanged by
   *  rewriteForOam, so it spawns on oam with this flag false and is reported
   *  as a plain node spawn. False for plain node spawns and for oam opt-ins
   *  that already fell back inside resolveOamSpawn.
   *
   *  SURVIVES THE DOWNGRADE ATTEMPT ON PURPOSE: it stays true while the second
   *  launch is plain node, and the runtime log at the end of
   *  connectToUpstreamOnce keys `downgradedFromOam` on exactly that pair
   *  (flag true + disableOamRewrite true). Resetting it at the top of
   *  connectToUpstreamOnce -- which reads like a correct cleanup -- would
   *  silently turn the post-downgrade success line into an ordinary node line
   *  and erase the only trace that a server left oam. */
  oamRewriteApplied: boolean;
  oamVersion: string | null;
}

/** Namespaces whose oam-hosted boot failed this session AND whose node
 *  respawn produced a different outcome (booted fine, or failed a different
 *  way) -- i.e. the ones where oam is actually implicated. The rewrite gate
 *  skips these so a CONFIRMED downgrade STICKS: without the memo, callers
 *  with their own retry loops (runActivateOne's two attempts, the
 *  auto-reconnect path, the transient read_tool connect) would re-pay the oam
 *  boot failure on every outer attempt and on every later reconnect. Nothing
 *  removes an entry short of a process restart, which is why the add is gated
 *  on evidence -- see connectToUpstream. */
const oamDowngradedNamespaces = new Set<string>();

/** Reset the session-scoped oam downgrade memo (test hook). */
export function resetOamDowngrades(): void {
  oamDowngradedNamespaces.clear();
}

/** Forwarding surface for the DOWNSTREAM MCP client (the LLM host connected
 *  to yaw-mcp), supplied by server.ts which owns the downstream SDK Server.
 *  connectToUpstream uses it to mirror the downstream client's declared
 *  capabilities onto each upstream Client and to proxy the server->client
 *  requests those capabilities allow (elicitation/create,
 *  sampling/createMessage, roots/list) back to the real client. Without it
 *  every upstream sees `capabilities: {}` and the SDK's capability assert
 *  refuses those requests up front even when the real client supports them.
 *  Omitted by callers with no downstream to forward to. */
export interface DownstreamClientBridge {
  /** The capabilities the downstream client declared at initialize. Read
   *  lazily at connect time -- upstream connects always happen after the
   *  downstream initialize, so the declaration is known by then. */
  getClientCapabilities(): ClientCapabilities | undefined;
  elicitInput(params: ElicitRequest["params"], options?: { signal?: AbortSignal }): Promise<ElicitResult>;
  createMessage(
    params: CreateMessageRequest["params"],
    options?: { signal?: AbortSignal },
  ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
  listRoots(params?: ListRootsRequest["params"], options?: { signal?: AbortSignal }): Promise<ListRootsResult>;
}

export async function connectToUpstream(
  config: UpstreamServerConfig,
  onDisconnect?: (namespace: string) => void,
  onListChanged?: (namespace: string) => void,
  bridge?: DownstreamClientBridge,
): Promise<UpstreamConnection> {
  const attempt: SpawnAttempt = { oamRewriteApplied: false, oamVersion: null };
  try {
    return await connectToUpstreamOnce(config, onDisconnect, onListChanged, bridge, attempt, false);
  } catch (err) {
    // Boot-probe fallback: when the spawn was oam-rewritten and the boot
    // failed (spawn error, connect/initialize handshake failure, or the
    // child dying during the initial capability fetch -- all surfaced as
    // ActivationError), respawn ONCE with the original pre-rewrite command.
    // Exactly one downgrade per call, no retry ladder: a second failure
    // propagates; the namespace memo above makes a CONFIRMED downgrade stick
    // for the rest of the session. Non-oam spawns and non-activation errors
    // (e.g. vault refusals, which would fail identically on node) rethrow
    // untouched. A child that dies AFTER a healthy boot still gets no
    // auto-fallback (see oam-spawn.ts).
    //
    // Accepted tradeoff: ANY ActivationError qualifies, including a
    // protocol_error from the initial tools/list. That's deliberate -- a
    // child that dies right after the handshake surfaces there too, and
    // cheaply distinguishing "dead child" from "healthy server returning a
    // JSON-RPC error" isn't possible at this layer. Worst case is one extra
    // node boot before the same error propagates (bounded by the memo).
    if (!attempt.oamRewriteApplied || !(err instanceof ActivationError)) throw err;
    log("warn", "oam-hosted server failed to boot; downgrading to node for this session", {
      namespace: config.namespace,
      oamVersion: attempt.oamVersion,
      category: err.category,
      error: err.message,
    });
    // The memo is deliberately NOT written before this respawn. Nothing clears
    // it for the life of the process, so adding it up front pins the namespace
    // to node even when the node attempt fails IDENTICALLY -- and an identical
    // failure is evidence oam was never the cause (a server missing
    // GITHUB_TOKEN fails install_failure on both runtimes). server.ts's
    // maybeElicitAndRetry then supplies the credential and re-connects
    // IN-PROCESS: that retry, and every later reconnect, would run on node
    // while doctor still reports "oam". The respawn itself does not need the
    // memo -- it passes disableOamRewrite = true, which bypasses the gate
    // directly.
    try {
      const connection = await connectToUpstreamOnce(config, onDisconnect, onListChanged, bridge, attempt, true);
      // node booted where oam did not: oam IS implicated, so make it stick.
      oamDowngradedNamespaces.add(config.namespace);
      return connection;
    } catch (nodeErr) {
      // A DIFFERENT ActivationError category still points at something
      // oam-specific, so keep the cost saving for those. The SAME category --
      // or anything not classifiable as an ActivationError at all -- leaves the
      // memo untouched so a later connect may try oam again: one wasted oam
      // boot is far cheaper than silently disabling oam hosting for the rest of
      // the process on evidence that never implicated it.
      if (nodeErr instanceof ActivationError && nodeErr.category !== err.category) {
        oamDowngradedNamespaces.add(config.namespace);
      } else {
        log("warn", "node respawn also failed; not pinning this server to node (oam was likely not the cause)", {
          namespace: config.namespace,
          category: err.category,
          error: nodeErr instanceof Error ? nodeErr.message : String(nodeErr),
        });
      }
      throw nodeErr;
    }
  }
}

// Env keys that are for THIS process only and must never leak into spawned
// upstream servers:
//   YAW_MCP_TOKEN                — backend auth token
//   YAW_MCP_VAULT_PASSPHRASE     — unlocks the local secret vault
//   YAW_MCP_VAULT_PASSPHRASE_NEW — the incoming passphrase during a rotate
//     (secrets-cmd.ts), i.e. the LIVE passphrase once the rotate lands
export const INTERNAL_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "YAW_MCP_TOKEN",
  "YAW_MCP_VAULT_PASSPHRASE",
  "YAW_MCP_VAULT_PASSPHRASE_NEW",
]);

/** Delete yaw-mcp's own secrets from THIS process's env, in place. For the
 *  one-shot CLI paths that hand `process.env` to a third party that spawns a
 *  server with it (`yaw-mcp audit` -> @yawlabs/mcp-compliance spreads
 *  process.env into the child): the broker's spawn path strips these via
 *  stripInternalSecretsFromEnv, and a CLI that requires the passphrase to be
 *  SET (audit resolving vault refs) must not then forward it to the audited
 *  server. Same case-insensitive match, for the same Windows reason. */
export function scrubInternalSecretsFromProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (INTERNAL_SECRET_ENV_KEYS.has(key.toUpperCase())) delete process.env[key];
  }
}

/** `process.env` minus yaw-mcp's own secrets, for spawning upstream servers.
 *
 *  Matched case-INSENSITIVELY, and that is load-bearing on Windows: env
 *  lookups there are case-insensitive, so `process.env.YAW_MCP_VAULT_PASSPHRASE`
 *  happily reads a `yaw_mcp_vault_passphrase=` set in PowerShell or Git Bash
 *  — the vault unlocks fine — while a byte-exact strip (the previous
 *  rest-destructure) would miss the lowercase key and hand the passphrase to
 *  every spawned child. POSIX env IS case-sensitive, but these names are
 *  yaw-internal enough that stripping a differently-cased twin there costs
 *  nothing and keeps one code path on every platform.
 *
 *  Exported for tests. */
export function stripInternalSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (INTERNAL_SECRET_ENV_KEYS.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
}

async function connectToUpstreamOnce(
  config: UpstreamServerConfig,
  onDisconnect: ((namespace: string) => void) | undefined,
  onListChanged: ((namespace: string) => void) | undefined,
  bridge: DownstreamClientBridge | undefined,
  attempt: SpawnAttempt,
  disableOamRewrite: boolean,
): Promise<UpstreamConnection> {
  // Mirror the DOWNSTREAM client's declared capabilities onto this upstream
  // client, and register a forwarding handler below for each one mirrored.
  // The two must move together: declaring a capability WITHOUT a handler
  // turns the SDK's clean "client does not support X" refusal into a
  // MethodNotFound at call time, so a capability is declared IFF its handler
  // is registered. Capabilities the downstream client did not declare stay
  // undeclared -- no invented defaults for a client that can't answer.
  // elicitation/sampling sub-capabilities (form/url, tools) are mirrored
  // verbatim: the forwarded request lands on the client that declared them.
  // roots is mirrored WITHOUT listChanged because yaw-mcp does not forward
  // notifications/roots/list_changed -- advertising it would promise change
  // notifications the upstream would never receive.
  const downstreamCaps = bridge?.getClientCapabilities();
  const capabilities: ClientCapabilities = {};
  if (downstreamCaps?.elicitation) capabilities.elicitation = downstreamCaps.elicitation;
  if (downstreamCaps?.sampling) capabilities.sampling = downstreamCaps.sampling;
  if (downstreamCaps?.roots) capabilities.roots = {};

  const client = new Client(
    { name: "yaw-mcp", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev" },
    { capabilities },
  );

  // Forwarding handlers for exactly the capabilities declared above. Results
  // and rejections pass through verbatim (a downstream McpError re-surfaces
  // to the upstream as the same JSON-RPC error); the abort signal is
  // forwarded so an upstream cancel tears down the downstream request too.
  if (bridge && capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      bridge.elicitInput(request.params, { signal: extra.signal }),
    );
  }
  if (bridge && capabilities.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, (request, extra) =>
      bridge.createMessage(request.params, { signal: extra.signal }),
    );
  }
  if (bridge && capabilities.roots) {
    client.setRequestHandler(ListRootsRequestSchema, (request, extra) =>
      bridge.listRoots(request.params, { signal: extra.signal }),
    );
  }

  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  // Rolling 8KB tail of the child's stderr — captured so activation
  // errors can surface the actual failure reason ("GITHUB_TOKEN is
  // required", "npm ERR! 404") instead of a generic "handshake timed
  // out". Only populated for local/stdio transports.
  let stderrRing = "";
  // Resolved env (post-vault substitution) -- kept so the stderr-tail
  // redactor can strip CLEARTEXT secret values out of error messages
  // before they're embedded in ActivationError / logs. The original
  // config.env still carries `${secret:NAME}` literals; the child sees
  // the cleartext and may echo it on failure.
  let resolvedServerEnv: Record<string, string> = {};

  if (config.type === "local") {
    if (!config.command) {
      throw new Error("command is required for local servers");
    }

    // Strip yaw-mcp-internal secrets from the child env — see
    // stripInternalSecretsFromEnv for the key list and why the match is
    // case-insensitive. Everything else from process.env (PATH, HOME, proxy
    // vars, etc.) is intentionally forwarded so the child spawns/runs in the
    // user's normal environment; server-specific secrets come via serverEnv,
    // resolved from the vault above.
    const parentEnv = stripInternalSecretsFromEnv(process.env);
    // Resolve the launch command: `uv`/`uvx` to our managed binary, then
    // node/npx onto the oam runtime. BOTH resolvers can throw (unsupported
    // platform, download/checksum failure, a wedged oam binary), and the
    // try/catch further down wraps client.connect() ONLY -- so classify and
    // wrap here. Without this the failure escapes connectToUpstreamOnce as a
    // bare Error: no category, no stderr tail, and none of the
    // `→ Fix in ~/.yaw-mcp/bundles.json` pointer every other local spawn
    // failure carries (server.ts's activation handler adds nothing on the
    // raw-Error branch).
    let resolved: { command: string; args: string[] };
    try {
      resolved = await resolveUvSpawn(config.command, config.args ?? []);
      // Host on the oam runtime when this server opted in (config.runtime ===
      // "oam") or the config-level default says so (YAW_MCP_DEFAULT_RUNTIME /
      // bundles.json `defaultRuntime`) -- per-server "node" stays an escape
      // hatch. Applied AFTER resolveUvSpawn so uv/uvx stay on their managed
      // binary; resolveOamSpawn only rewrites node/npx and otherwise (incl. when
      // oam is absent or below min version) returns the command unchanged -- a
      // pure optimization. disableOamRewrite is the boot-probe downgrade path:
      // the wrapper re-runs this function once with the rewrite suppressed so
      // the ORIGINAL node/npx command spawns.
      // `optedIn` is the difference between "the user asked for oam" and "oam is
      // simply the default now". Both spawn on oam when it is available, but only
      // the former warrants a warning when it isn't -- see default-runtime.ts.
      //
      // DEFAULT-ON, and that is load-bearing: `configured ?? "oam"` means an
      // UNSET runtime hosts on oam, so on any machine with a recent-enough oam
      // installed EVERY node/npx sidecar runs on oam. There is no
      // package-compat gate or allowlist anywhere in this codebase, and the
      // only recovery is BOOT-scoped -- the downgrade in connectToUpstream
      // fires on an ActivationError during connect or the initial capability
      // fetch. A sidecar that boots clean on oam and breaks only later (a
      // bundled browser that fails when a tool call launches it, a native addon
      // loaded lazily) gets no automatic fallback: every reconnect re-hosts it
      // on oam until someone sets `runtime: "node"` for that server in
      // ~/.yaw-mcp/bundles.json or flips the config-level default.
      const configured = config.runtime ?? (await defaultRuntime());
      const optedIn = configured !== null;
      const effectiveRuntime = configured ?? "oam";
      if (effectiveRuntime === "oam" && !disableOamRewrite && !oamDowngradedNamespaces.has(config.namespace)) {
        // Awaited since issue #91: the oam probe is async so a wedged oam binary
        // cannot block the event loop here. The probe result is cached, so only
        // the first connect of the process actually waits on it.
        const rewritten = await resolveOamSpawn(resolved.command, resolved.args, optedIn);
        if (rewritten.command !== resolved.command) {
          attempt.oamRewriteApplied = true;
          attempt.oamVersion = (await probeOam()).version;
          resolved = rewritten;
        }
      }
    } catch (err) {
      if (err instanceof ActivationError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ActivationError(
        withConfigPointer(`Server "${config.namespace}" could not resolve its launch command. ${message}`, config),
        categorizeSpawnError(err),
        undefined,
        err,
      );
    }

    // Resolve ${secret:NAME} references in the server's env against the
    // local secret vault. Fail-CLOSED: when the env carries refs and
    // YAW_MCP_VAULT_PASSPHRASE is unset (or no vault exists, or a name is
    // missing/undecryptable), resolveServerEnv THROWS and the server never
    // spawns -- the literal `${secret:NAME}` is NOT passed through to the
    // child. A ref-free env skips the vault entirely and passes through
    // unchanged. The throw is a plain Error, so the oam boot-probe
    // downgrade below deliberately does not retry it.
    const serverEnv = await resolveServerEnv(config.env ?? {}, config.namespace);
    resolvedServerEnv = serverEnv;
    const stdioTransport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: { ...parentEnv, ...serverEnv } as Record<string, string>,
      stderr: "pipe",
    });
    // Attach the stderr listener *before* the transport is started so we
    // never lose the earliest output (install errors, missing-env errors,
    // etc. that get written before the server crashes on init).
    stdioTransport.stderr?.on("data", (chunk: Buffer) => {
      stderrRing = (stderrRing + chunk.toString("utf8")).slice(-STDERR_RING_CAP);
    });
    transport = stdioTransport;
  } else {
    if (!config.url) {
      throw new Error("url is required for remote servers");
    }

    const url = new URL(config.url);
    if (config.transport === "sse") {
      transport = new SSEClientTransport(url);
    } else {
      transport = new StreamableHTTPClientTransport(url);
    }
  }

  // Connect with timeout — clear timer on success, close client on timeout.
  // Per-server config.connectTimeoutMs wins over the module default so a
  // slow upstream can be tuned without globally raising the ceiling.
  // Errors are categorized (spawn/install/timeout/protocol) so the caller
  // can produce an actionable message for the LLM. stderr tail is included
  // when available — it's the part that usually explains the real failure.
  const connectTimeoutMs =
    typeof config.connectTimeoutMs === "number" && config.connectTimeoutMs > 0
      ? config.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Connection timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
  });
  try {
    // Capture the connect promise so that, on timeout, the orphaned
    // connect() promise (which Promise.race abandons) has a no-op catch
    // attached — otherwise a later rejection surfaces as an unhandled
    // rejection and can kill the process.
    const connectP = client.connect(transport);
    connectP.catch(() => {});
    await Promise.race([connectP, timeoutPromise]);
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {}

    // Classify the failure. If the child wrote anything to stderr, we
    // almost certainly have the real reason — install failures from
    // npx/uvx, missing env vars, typo'd package names all surface there.
    const trimmedStderr = stderrRing.trim();
    let category: ActivationFailureCategory;
    let message: string;

    if (config.type !== "local") {
      category = timedOut ? "init_timeout" : "protocol_error";
      message = timedOut
        ? `Remote server at ${config.url} did not respond within ${connectTimeoutMs / 1000}s. Verify the URL is reachable.`
        : `Remote server at ${config.url} refused the connection.`;
    } else if (timedOut) {
      category = "init_timeout";
      message = `Server "${config.namespace}" started but didn't complete the MCP handshake within ${connectTimeoutMs / 1000}s.${
        trimmedStderr ? ` stderr tail: ${redactSecretsInOutput(trimmedStderr, resolvedServerEnv).slice(-500)}` : ""
      }`;
    } else if (trimmedStderr.length > 0) {
      // Non-timeout error with stderr → the child likely exited before
      // the handshake (install failure, missing env var, bad args).
      category = "install_failure";
      const safe = redactSecretsInOutput(trimmedStderr, resolvedServerEnv);
      // An oam heap-cap death IS "exited non-zero before handshake", so the
      // category is already right and the downgrade logic above needs no new
      // branch -- what it lacks is a message naming the one env var that fixes
      // it, instead of leaving the banner buried in the tail.
      const oomHint = oamHeapOomHint(trimmedStderr);
      message = oomHint
        ? `Server "${config.namespace}" ran out of memory. ${oomHint} stderr: ${safe.slice(-500)}`
        : `Server "${config.namespace}" failed to start. stderr: ${safe.slice(-500)}`;
    } else {
      category = categorizeSpawnError(err);
      if (category === "spawn_failure") {
        message = `Command '${config.command}' is not on PATH or is not executable. Verify the runtime is installed (e.g. Node.js for npx, Python for uvx).`;
      } else {
        message = err instanceof Error ? err.message : String(err);
      }
    }

    message = withConfigPointer(message, config);

    const redactedTail = trimmedStderr ? redactSecretsInOutput(trimmedStderr, resolvedServerEnv) : undefined;
    throw new ActivationError(message, category, redactedTail, err);
  }

  // Name the runtime that actually won: "oam" (with the probed oam version)
  // when the rewrite applied, an explicit downgrade marker when the boot-probe
  // fallback respawned on node, and nothing extra for plain node spawns.
  const runtimeFields = attempt.oamRewriteApplied
    ? disableOamRewrite
      ? { runtime: "node", downgradedFromOam: true }
      : { runtime: "oam", oamVersion: attempt.oamVersion }
    : {};
  log("info", "Connected to upstream", {
    name: config.name,
    namespace: config.namespace,
    type: config.type,
    ...runtimeFields,
  });

  // Fetch tools, resources, prompts — clean up client on failure
  try {
    const connection: UpstreamConnection = { status: "disconnected" } as UpstreamConnection;

    // Detect unexpected disconnects. Before the connection is marked ready
    // below, status is still "disconnected", so a close in the initial fetch
    // window can only mean the child died mid-init. fetchResources/Prompts
    // swallow errors (they return []), so without a flag a child dying in
    // that window would slip through and be returned as a live "connected"
    // connection over a dead client. Record it and reject after the fetches.
    let closedBeforeReady = false;
    client.onclose = () => {
      if (connection.status === "connected") {
        connection.status = "error";
        connection.error = "Upstream disconnected unexpectedly";
        log("warn", "Upstream disconnected unexpectedly", { namespace: config.namespace });
        if (onDisconnect) onDisconnect(config.namespace);
      } else {
        closedBeforeReady = true;
      }
    };

    const tools = await fetchToolsFromUpstream(client, config.namespace);
    const resources = await fetchResourcesFromUpstream(client, config.namespace);
    const prompts = await fetchPromptsFromUpstream(client, config.namespace);

    // Client closed while we were still fetching capabilities -- treat it as
    // a boot failure rather than returning a dead "connected" connection.
    if (closedBeforeReady) {
      throw new ActivationError(`Server "${config.namespace}" disconnected during initialization`, "protocol_error");
    }

    // Populate the connection object (referenced by onclose handler above)
    Object.assign(connection, {
      config,
      client,
      transport,
      tools,
      resources,
      prompts,
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
      status: "connected" as const,
    });

    // Subscribe to upstream list changes so we pick up dynamic tools/resources/prompts.
    //
    // Each handler serializes onto a per-category chain so two rapid
    // notifications from the same upstream can't race fetchXFromUpstream
    // in parallel. Without this, back-to-back ToolListChanged events
    // would launch two concurrent listTools() calls; whichever resolves
    // last wins connection.tools, and onListChanged fires twice (each
    // rebuilding routes). The chain preserves ordering and bounds
    // in-flight fetches to one per category.
    if (onListChanged) {
      let toolsChain: Promise<void> = Promise.resolve();
      let resourcesChain: Promise<void> = Promise.resolve();
      let promptsChain: Promise<void> = Promise.resolve();

      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        toolsChain = toolsChain.then(async () => {
          try {
            connection.tools = await fetchToolsFromUpstream(client, config.namespace);
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh tools from upstream", { namespace: config.namespace, error: err.message });
          }
        });
        return toolsChain;
      });
      // throwOnError on all three refreshes: a failed fetch must leave the
      // PREVIOUS inventory standing. Without it the resources/prompts fetchers
      // return [] on any transport error or LIST_TIMEOUT, so one blip mid-
      // session assigned [] here, rebuilt routes off it, and made every
      // resource/prompt of a healthy server vanish from the client until some
      // future list_changed that may never arrive. The assignment is inside
      // the try precisely so the throw skips both it and onListChanged --
      // matching what the tools branch already gets for free from
      // fetchToolsFromUpstream's rethrow.
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        resourcesChain = resourcesChain.then(async () => {
          try {
            connection.resources = await fetchResourcesFromUpstream(client, config.namespace, { throwOnError: true });
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh resources from upstream", {
              namespace: config.namespace,
              error: err.message,
            });
          }
        });
        return resourcesChain;
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        promptsChain = promptsChain.then(async () => {
          try {
            connection.prompts = await fetchPromptsFromUpstream(client, config.namespace, { throwOnError: true });
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh prompts from upstream", {
              namespace: config.namespace,
              error: err.message,
            });
          }
        });
        return promptsChain;
      });
    }

    return connection;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

export async function disconnectFromUpstream(connection: UpstreamConnection): Promise<void> {
  connection.status = "disconnected";
  try {
    await connection.client.close();
  } catch (err: any) {
    log("warn", "Error disconnecting from upstream", {
      namespace: connection.config.namespace,
      error: err.message,
    });
  }
  log("info", "Disconnected from upstream", { namespace: connection.config.namespace });
}

/** How a resources/prompts list failure is reported.
 *
 *  Default (initial connect): SWALLOW and return [] -- a server that simply
 *  doesn't implement the capability answers with an error, and that is not a
 *  boot failure.
 *
 *  `throwOnError` (the list_changed refresh path): THROW instead, so the
 *  caller can leave the previous inventory in place. Swallowing on refresh
 *  meant one transient transport error or LIST_TIMEOUT replaced a live
 *  inventory with [] and silently un-published every resource/prompt the
 *  client had. The tools fetcher is already immune because it rethrows; this
 *  flag is how the other two opt into the same protection without changing
 *  what "unsupported capability" means at connect time. */
export interface FetchListOptions {
  throwOnError?: boolean;
}

/** Follow MCP list-endpoint pagination (`nextCursor`) and return the
 *  concatenated inventory. The spec defines cursors for resources/list,
 *  prompts/list and tools/list alike; a server that paginates would
 *  otherwise have everything past page 1 silently dropped.
 *
 *  Three bounds keep a misbehaving server from holding activation hostage.
 *  Each page gets its own LIST_TIMEOUT via the caller's request options, so
 *  the page count is the only thing standing between one fetch and
 *  pages x LIST_TIMEOUT of wall time:
 *  - the fetch stops one page after the item cap is exceeded (the caller
 *    truncates there anyway, and the overshoot is what lets its truncation
 *    warning fire);
 *  - a page that returns zero items but still hands back a cursor ends the
 *    loop -- that shape is an empty-page dribble, not pagination;
 *  - the page count is capped at MAX_LIST_PAGES, far below the item cap.
 *  The latter two log a warning so the operator can see the early stop. */
async function fetchAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  cap: number,
  context: { namespace: string; endpoint: string },
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (nextCursor === undefined || all.length > cap) return all;
    if (items.length === 0) {
      // A cursor on a zero-item page is a dribble, not pagination -- a
      // legitimate inventory always makes progress. Stop rather than burn
      // another LIST_TIMEOUT-bounded round trip on it.
      log("warn", "Upstream returned an empty page with a cursor; stopping pagination", {
        namespace: context.namespace,
        endpoint: context.endpoint,
        pagesFetched: page + 1,
        items: all.length,
      });
      return all;
    }
    cursor = nextCursor;
  }
  // Loop ran out with a live cursor still in hand: the page cap truncated.
  log("warn", "Upstream pagination exceeded page cap; truncating", {
    namespace: context.namespace,
    endpoint: context.endpoint,
    pageCap: MAX_LIST_PAGES,
    items: all.length,
  });
  return all;
}

export async function fetchResourcesFromUpstream(
  client: Client,
  namespace: string,
  opts: FetchListOptions = {},
): Promise<UpstreamResourceDef[]> {
  try {
    const raw = await fetchAllPages(
      async (cursor) => {
        const result = await client.listResources(cursor === undefined ? {} : { cursor }, { timeout: LIST_TIMEOUT });
        return { items: result.resources ?? [], nextCursor: result.nextCursor };
      },
      MAX_RESOURCES_PER_SERVER,
      { namespace, endpoint: "resources/list" },
    );
    if (raw.length > MAX_RESOURCES_PER_SERVER) {
      log("warn", "Upstream returned more resources than cap; truncating", {
        namespace,
        reported: raw.length,
        cap: MAX_RESOURCES_PER_SERVER,
      });
    }
    return raw.slice(0, MAX_RESOURCES_PER_SERVER).map((r) => ({
      uri: r.uri,
      namespacedUri: `connect://${namespace}/${r.uri}`,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch (err) {
    // Server may not support resources — that's fine at connect time.
    if (!opts.throwOnError) return [];
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`"${namespace}" returned an error on resources/list: ${message}`);
  }
}

export async function fetchPromptsFromUpstream(
  client: Client,
  namespace: string,
  opts: FetchListOptions = {},
): Promise<UpstreamPromptDef[]> {
  try {
    const raw = await fetchAllPages(
      async (cursor) => {
        const result = await client.listPrompts(cursor === undefined ? {} : { cursor }, { timeout: LIST_TIMEOUT });
        return { items: result.prompts ?? [], nextCursor: result.nextCursor };
      },
      MAX_PROMPTS_PER_SERVER,
      { namespace, endpoint: "prompts/list" },
    );
    if (raw.length > MAX_PROMPTS_PER_SERVER) {
      log("warn", "Upstream returned more prompts than cap; truncating", {
        namespace,
        reported: raw.length,
        cap: MAX_PROMPTS_PER_SERVER,
      });
    }
    return raw.slice(0, MAX_PROMPTS_PER_SERVER).map((p) => ({
      name: p.name,
      namespacedName: `${namespace}_${p.name}`,
      description: p.description,
      arguments: p.arguments as UpstreamPromptDef["arguments"],
    }));
  } catch (err) {
    // Server may not support prompts — that's fine at connect time.
    if (!opts.throwOnError) return [];
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`"${namespace}" returned an error on prompts/list: ${message}`);
  }
}

export async function fetchToolsFromUpstream(client: Client, namespace: string): Promise<UpstreamToolDef[]> {
  let all: Awaited<ReturnType<typeof client.listTools>>["tools"];
  try {
    all = await fetchAllPages(
      async (cursor) => {
        const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: LIST_TIMEOUT });
        return { items: result.tools ?? [], nextCursor: result.nextCursor };
      },
      MAX_TOOLS_PER_SERVER,
      { namespace, endpoint: "tools/list" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ActivationError(
      `"${namespace}" returned an error on tools/list: ${message}`,
      "protocol_error",
      undefined,
      err,
    );
  }

  // Tools that DEMAND task-based execution can never succeed through this
  // proxy: the SDK client refuses a plain tools/call for them before
  // sending anything (Client.callTool throws "requires task-based
  // execution"), and yaw-mcp has no task path of its own. Republishing one
  // downstream would advertise a tool whose every call errors — withhold it
  // and log which ones instead.
  const raw = all.filter((tool) => tool.execution?.taskSupport !== "required");
  if (raw.length < all.length) {
    log("warn", "Withholding tools that require task-based execution (unsupported through the proxy)", {
      namespace,
      tools: all.filter((tool) => tool.execution?.taskSupport === "required").map((tool) => tool.name),
    });
  }

  if (raw.length > MAX_TOOLS_PER_SERVER) {
    log("warn", "Upstream returned more tools than cap; truncating", {
      namespace,
      reported: raw.length,
      cap: MAX_TOOLS_PER_SERVER,
    });
  }

  return raw.slice(0, MAX_TOOLS_PER_SERVER).map((tool) => ({
    name: tool.name,
    namespacedName: `${namespace}_${tool.name}`,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
    annotations: tool.annotations as Record<string, unknown> | undefined,
    // `execution` is deliberately NOT carried: the proxy always calls
    // upstream in plain (non-task) mode, so advertising task support
    // downstream would be a false claim.
    _meta: tool._meta as Record<string, unknown> | undefined,
  }));
}
