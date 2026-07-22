import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { defaultRuntime } from "./default-runtime.js";
import { log } from "./logger.js";
import { probeOam, resolveOamSpawn } from "./oam-spawn.js";
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
async function resolveServerEnv(env: Record<string, string>, namespace: string): Promise<Record<string, string>> {
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
  for (const [k, v] of Object.entries(env)) {
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

function categorizeSpawnError(err: unknown): ActivationFailureCategory {
  const msg = err instanceof Error ? err.message : String(err);
  // Node's child_process surfaces ENOENT as the most common spawn failure —
  // binary isn't on PATH. Other codes (EACCES, EPERM) are rare enough to
  // bucket under spawn_failure too.
  if (/ENOENT|not found|cannot find|command failed to start/i.test(msg)) return "spawn_failure";
  if (/EACCES|permission denied/i.test(msg)) return "spawn_failure";
  return "unknown";
}

/** Per-attempt spawn facts, threaded out of connectToUpstreamOnce so the
 *  wrapper can decide whether a failure qualifies for the oam->node
 *  downgrade (and log the oam version it downgraded from). */
interface SpawnAttempt {
  /** True when resolveOamSpawn actually CHANGED the launch (oam installed,
   *  command was node/npx, package resolved). False for plain node spawns
   *  and for oam opt-ins that already fell back inside resolveOamSpawn. */
  oamRewritten: boolean;
  oamVersion: string | null;
}

/** Namespaces whose oam-hosted boot already failed once this session. The
 *  rewrite gate skips these so the downgrade STICKS: without the memo,
 *  callers with their own retry loops (runActivateOne's two attempts, the
 *  auto-reconnect path) would re-pay the oam boot failure on every outer
 *  attempt and on every later reconnect. Cleared only by process restart --
 *  matching the "for this session" wording of the downgrade log. */
const oamDowngradedNamespaces = new Set<string>();

/** Reset the session-scoped oam downgrade memo (test hook). */
export function resetOamDowngrades(): void {
  oamDowngradedNamespaces.clear();
}

export async function connectToUpstream(
  config: UpstreamServerConfig,
  onDisconnect?: (namespace: string) => void,
  onListChanged?: (namespace: string) => void,
): Promise<UpstreamConnection> {
  const attempt: SpawnAttempt = { oamRewritten: false, oamVersion: null };
  try {
    return await connectToUpstreamOnce(config, onDisconnect, onListChanged, attempt, false);
  } catch (err) {
    // Boot-probe fallback: when the spawn was oam-rewritten and the boot
    // failed (spawn error, connect/initialize handshake failure, or the
    // child dying during the initial capability fetch -- all surfaced as
    // ActivationError), respawn ONCE with the original pre-rewrite command.
    // Exactly one downgrade per call, no retry ladder: a second failure
    // propagates; the namespace memo above makes the downgrade stick for
    // the rest of the session. Non-oam spawns and non-activation errors
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
    if (!attempt.oamRewritten || !(err instanceof ActivationError)) throw err;
    oamDowngradedNamespaces.add(config.namespace);
    log("warn", "oam-hosted server failed to boot; downgrading to node for this session", {
      namespace: config.namespace,
      oamVersion: attempt.oamVersion,
      category: err.category,
      error: err.message,
    });
    return await connectToUpstreamOnce(config, onDisconnect, onListChanged, attempt, true);
  }
}

async function connectToUpstreamOnce(
  config: UpstreamServerConfig,
  onDisconnect: ((namespace: string) => void) | undefined,
  onListChanged: ((namespace: string) => void) | undefined,
  attempt: SpawnAttempt,
  disableOamRewrite: boolean,
): Promise<UpstreamConnection> {
  const client = new Client(
    { name: "yaw-mcp", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev" },
    { capabilities: {} },
  );

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

    // Strip yaw-mcp-internal secrets from the child env. These are for
    // THIS process only and must never leak into spawned upstream servers:
    //   YAW_MCP_TOKEN            — backend auth token
    //   YAW_MCP_VAULT_PASSPHRASE — unlocks the local secret vault
    // Everything else from process.env (PATH, HOME, proxy vars, etc.) is
    // intentionally forwarded so the child spawns/runs in the user's
    // normal environment; server-specific secrets come via serverEnv,
    // resolved from the vault above.
    const {
      YAW_MCP_TOKEN: _excludedToken,
      YAW_MCP_VAULT_PASSPHRASE: _excludedVaultPassphrase,
      ...parentEnv
    } = process.env;
    // Rewrite `uv`/`uvx` to our managed binary when the user doesn't
    // have one on PATH. No-op for every other command. Any failure
    // here (unsupported platform, download/checksum failure) bubbles
    // out and is caught by the ActivationError handler below — the
    // stderr tail will be empty, so we fall through to the
    // categorizeSpawnError path with the actual error message.
    let resolved = await resolveUvSpawn(config.command, config.args ?? []);
    // Host on the oam runtime when this server opted in (config.runtime ===
    // "oam") or the config-level default says so (YAW_MCP_DEFAULT_RUNTIME /
    // bundles.json `defaultRuntime`) -- per-server "node" stays an escape
    // hatch. Applied AFTER resolveUvSpawn so uv/uvx stay on their managed
    // binary; resolveOamSpawn only rewrites node/npx and otherwise (incl. when
    // oam is absent or below min version) returns the command unchanged -- a
    // pure optimization. disableOamRewrite is the boot-probe downgrade path:
    // the wrapper re-runs this function once with the rewrite suppressed so
    // the ORIGINAL node/npx command spawns.
    const effectiveRuntime = config.runtime ?? (await defaultRuntime());
    if (effectiveRuntime === "oam" && !disableOamRewrite && !oamDowngradedNamespaces.has(config.namespace)) {
      const rewritten = resolveOamSpawn(resolved.command, resolved.args);
      if (rewritten.command !== resolved.command) {
        attempt.oamRewritten = true;
        attempt.oamVersion = probeOam().version;
        resolved = rewritten;
      }
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
      message = `Server "${config.namespace}" failed to start. stderr: ${safe.slice(-500)}`;
    } else {
      category = categorizeSpawnError(err);
      if (category === "spawn_failure") {
        message = `Command '${config.command}' is not on PATH or is not executable. Verify the runtime is installed (e.g. Node.js for npx, Python for uvx).`;
      } else {
        message = err instanceof Error ? err.message : String(err);
      }
    }

    // Append a deep-link to the dashboard so the LLM can render a
    // clickable "fix this here" pointer rather than a generic "edit
    // your server config." The dashboard reads the #server-<id> hash
    // on mount and scrolls to + highlights the matching card.
    if (config.id) {
      message = `${message} → Edit at https://yaw.sh/mcp/dashboard/connect#server-${config.id}`;
    }

    const redactedTail = trimmedStderr ? redactSecretsInOutput(trimmedStderr, resolvedServerEnv) : undefined;
    throw new ActivationError(message, category, redactedTail, err);
  }

  // Name the runtime that actually won: "oam" (with the probed oam version)
  // when the rewrite applied, an explicit downgrade marker when the boot-probe
  // fallback respawned on node, and nothing extra for plain node spawns.
  const runtimeFields = attempt.oamRewritten
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

    // Detect unexpected disconnects
    client.onclose = () => {
      if (connection.status === "connected") {
        connection.status = "error";
        connection.error = "Upstream disconnected unexpectedly";
        log("warn", "Upstream disconnected unexpectedly", { namespace: config.namespace });
        if (onDisconnect) onDisconnect(config.namespace);
      }
    };

    const tools = await fetchToolsFromUpstream(client, config.namespace);
    const resources = await fetchResourcesFromUpstream(client, config.namespace);
    const prompts = await fetchPromptsFromUpstream(client, config.namespace);

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
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        resourcesChain = resourcesChain.then(async () => {
          try {
            connection.resources = await fetchResourcesFromUpstream(client, config.namespace);
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
            connection.prompts = await fetchPromptsFromUpstream(client, config.namespace);
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

export async function fetchResourcesFromUpstream(client: Client, namespace: string): Promise<UpstreamResourceDef[]> {
  try {
    const result = await client.listResources({}, { timeout: LIST_TIMEOUT });
    const raw = result.resources ?? [];
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
  } catch {
    // Server may not support resources — that's fine
    return [];
  }
}

export async function fetchPromptsFromUpstream(client: Client, namespace: string): Promise<UpstreamPromptDef[]> {
  try {
    const result = await client.listPrompts({}, { timeout: LIST_TIMEOUT });
    const raw = result.prompts ?? [];
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
  } catch {
    // Server may not support prompts — that's fine
    return [];
  }
}

export async function fetchToolsFromUpstream(client: Client, namespace: string): Promise<UpstreamToolDef[]> {
  let result: Awaited<ReturnType<typeof client.listTools>>;
  try {
    result = await client.listTools({}, { timeout: LIST_TIMEOUT });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ActivationError(
      `"${namespace}" returned an error on tools/list: ${message}`,
      "protocol_error",
      undefined,
      err,
    );
  }
  const raw = result.tools ?? [];
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
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: tool.annotations as Record<string, unknown> | undefined,
  }));
}
