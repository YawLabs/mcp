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
import {
  INTERNAL_SECRET_ENV_KEYS,
  scrubInternalSecretsFromProcessEnv,
  stripInternalSecretsFromEnv,
} from "./internal-secret-env.js";
import { log } from "./logger.js";
import { oamHeapOomHint, probeOam, resolveOamSpawn } from "./oam-spawn.js";
import { appendAuditEvent } from "./secrets-audit.js";
import {
  collectSecretRefNames,
  hasSecretRefs,
  loadVault,
  type MalformedSecretRef,
  resolveSecretRefs,
  unlock,
  VAULT_CHECK_CORRUPT_ERROR,
  vaultPath,
} from "./secrets-vault.js";
import type {
  UpstreamConnection,
  UpstreamPromptDef,
  UpstreamResourceDef,
  UpstreamServerConfig,
  UpstreamToolDef,
} from "./types.js";
import { resolveUvSpawn } from "./uv-bootstrap.js";

/**
 * Thrown when a server's env carries `${secret:...}` refs and NO passphrase
 * is available to unlock the vault with.
 *
 * Typed rather than a bare Error so the activation path can tell the two
 * "missing credential" cases apart. They must never be conflated: this one
 * means YAW-MCP ITSELF needs its vault passphrase, and is the only case that
 * may be answered by prompting for `YAW_MCP_VAULT_PASSPHRASE`. The other --
 * a CHILD server writing "SOME_TOKEN is required" to stderr -- is the child's
 * own missing credential, and a child must never be able to talk the user
 * into typing the vault passphrase into a prompt attributed to it.
 *
 * Deliberately NOT an ActivationError: that type carries a stderr tail from a
 * process that actually ran, and drives the spawn-failure categorisation. The
 * vault refusal happens BEFORE any child is spawned.
 *
 * The "missing" message is byte-identical to the plain Error this replaced --
 * callers, logs, and tests match on its text.
 */
export class VaultPassphraseRequiredError extends Error {
  constructor(
    message: string,
    public readonly namespace: string,
    public readonly refKeys: readonly string[],
    /** Which way the passphrase failed:
     *    "missing" -- none was available at all.
     *    "invalid" -- one WAS available and did not open the vault.
     *
     *  Both are answerable by asking the user, which is the whole reason
     *  "invalid" throws this type rather than falling through as a bare
     *  unlock error. Without it a WRONG `YAW_MCP_VAULT_PASSPHRASE` was a
     *  dead end: the unlock error went to the generic missing-credential
     *  path, where the INTERNAL_SECRET_ENV_KEYS filter (correctly) refuses
     *  to elicit yaw-mcp's own secrets, so nothing offered a correction and
     *  every vault-backed server failed for the life of the process. It is
     *  also what makes vaultPassphrase()'s session-over-env precedence
     *  reachable: only an "invalid" throw can produce a prompt while an env
     *  var is set, and the answer to it has to win over the value that just
     *  failed. */
    public readonly reason: "missing" | "invalid" = "missing",
  ) {
    super(message);
    this.name = "VaultPassphraseRequiredError";
  }
}

/** A resolved value the caller's own shape check rejected -- today, a header
 *  value that cannot be a legal HTTP header value.
 *
 *  Carries only the KEY. The message deliberately does not quote the value:
 *  it is a decrypted secret, and the runtime's own `Headers` TypeError quotes
 *  it, which is why that error is caught and discarded rather than wrapped. */
export class InvalidResolvedValueError extends Error {
  constructor(public readonly key: string) {
    super(`invalid resolved value for "${key}"`);
    this.name = "InvalidResolvedValueError";
  }
}

/** Vault passphrase captured from an in-session MCP elicitation.
 *
 *  Held in a module variable and NOT written back to `process.env`, which is
 *  load-bearing rather than stylistic: every local spawn builds its child env
 *  from `stripInternalSecretsFromEnv(process.env)`, so a passphrase parked in
 *  `process.env` would be one strip-list bug away from every upstream child.
 *  Keeping it here means the child env physically cannot carry it, whatever
 *  the strip list says. Session-scoped by construction -- the process exits,
 *  it is gone; nothing writes it to disk. */
let sessionVaultPassphrase: string | null = null;

/** Record a passphrase supplied by the user this session. Empty clears, so a
 *  declined or blank elicitation cannot install "" as the vault passphrase
 *  (deriving a key from "" is exactly what secrets-cmd refuses too). */
export function setSessionVaultPassphrase(passphrase: string): void {
  sessionVaultPassphrase = passphrase.length > 0 ? passphrase : null;
}

/** Drop the session passphrase. Exported for tests, which must not leak one
 *  case's passphrase into the next, and called from ConnectServer.shutdown so
 *  a second server in the same process does not inherit the first's. */
export function clearSessionVaultPassphrase(): void {
  sessionVaultPassphrase = null;
}

/** Does `passphrase` actually open the vault?
 *
 *  Exists so a passphrase typed at an elicitation prompt can be checked BEFORE
 *  setSessionVaultPassphrase commits it to module-global state that shadows
 *  the env var for the rest of the process. Verifying afterwards is not
 *  equivalent: by then a typo has already displaced a possibly-correct
 *  YAW_MCP_VAULT_PASSPHRASE.
 *
 *  Returns true when there is NO vault yet -- there is nothing to verify
 *  against, unlock() accepts any passphrase for an empty vault, and the real
 *  refusal for that case ("no vault exists yet") belongs to resolveServerEnv.
 *  Never throws: an unreadable or corrupt vault is not the typed passphrase's
 *  fault, so it verifies as true and lets the resolve path report the real
 *  error with its own wording. */
export async function verifyVaultPassphrase(passphrase: string): Promise<boolean> {
  if (passphrase.length === 0) return false;
  let vault: Awaited<ReturnType<typeof loadVault>>;
  try {
    vault = await loadVault(vaultPath());
  } catch {
    return true;
  }
  if (!vault) return true;
  try {
    await unlock(vault, passphrase);
    return true;
  } catch (err) {
    // The passphrase is right; the check marker is damaged. Not a reason to
    // reject what the user typed.
    return (err instanceof Error ? err.message : String(err)) === VAULT_CHECK_CORRUPT_ERROR;
  }
}

/** The passphrase to unlock the vault with, or undefined when there is none.
 *
 *  The session value wins over the env var, and the ordering matters in
 *  exactly one case: the env var is set but WRONG. The operator answers the
 *  "invalid" prompt with the right passphrase, and preferring the stale env
 *  value would make that correction unreachable for the rest of the session.
 *  That case is only REACHABLE because an unlock failure throws
 *  VaultPassphraseRequiredError with reason "invalid" -- see the throw in
 *  resolveServerEnv. While the only prompt fired on a wholly absent
 *  passphrase, a session value could never coexist with an env one and this
 *  ordering decided nothing.
 *
 *  An empty/absent session value falls through, so the plain env path is
 *  untouched. Case-insensitive on Windows via process.env's own lookup
 *  semantics -- the same property stripInternalSecretsFromEnv relies on. */
export function vaultPassphrase(): string | undefined {
  if (sessionVaultPassphrase !== null) return sessionVaultPassphrase;
  return process.env.YAW_MCP_VAULT_PASSPHRASE;
}

/**
 * Resolve `${secret:NAME}` references in an upstream server's env
 * against the local secret vault. Fail-closed:
 *   - No refs in env: pass through unchanged (free path, no vault load).
 *   - Refs present but no vault file / locked / unlock fails / missing
 *     values: THROW. Passing literal `${secret:NAME}` to the child would
 *     leak the placeholder into logs or be interpreted as a real token
 *     by some servers, which is worse than refusing to spawn.
 *
 * The spawn happens in a non-interactive MCP-server context, so there is
 * no stdin to prompt on -- writing one would corrupt the parent's JSON-RPC
 * transport. The passphrase therefore comes from the env, or from an
 * in-session MCP elicitation the server layer answers on our behalf when
 * the client supports one (see VaultPassphraseRequiredError and
 * setSessionVaultPassphrase below).
 */
export async function resolveServerEnv(
  env: Record<string, string>,
  namespace: string,
  // What this map IS, in the operator's words -- the only thing that differs
  // between a local server's env and a remote server's headers, both of which
  // resolve through this exact function. It is ONE parameter rather than two
  // (a noun and a capitalized noun) so the two spellings cannot drift apart.
  // The default reproduces the previous message bytes EXACTLY: callers, logs
  // and tests match on that text (see the VaultPassphraseRequiredError doc
  // above, and src/tests/server.test.ts's verbatim assertion).
  subject: string = "server env",
  /** Shape check on the RESOLVED values, run before anything is audited.
   *  Returns the offending KEY name, or undefined when every value is usable.
   *  Exists so a caller that will reject a value can do so before the audit
   *  claims the secret was injected. */
  validate?: (resolved: Record<string, string>) => string | undefined,
  /** Receives every DECRYPTED value keyed by secret name, so the caller can
   *  redact the bare token as well as the string it was composed into. Not
   *  called when the map carries no refs -- there is nothing to decrypt. */
  onSecretValues?: (values: Record<string, string>) => void,
): Promise<Record<string, string>> {
  // A ref-free map skips the vault entirely, so there is nothing to audit and
  // nothing decrypted -- but the caller's shape check still has to run, or an
  // unusable LITERAL value would sail past it.
  if (!hasSecretRefs(env)) {
    const bad = validate?.(env);
    if (bad) throw new InvalidResolvedValueError(bad);
    return env;
  }
  const refKeys = Object.entries(env)
    .filter(([, v]) => typeof v === "string" && v.includes("${secret:"))
    .map(([k]) => k);
  const lead = subject.charAt(0).toUpperCase() + subject.slice(1);
  const passphrase = vaultPassphrase();
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    log("warn", `${lead} carries \${secret:...} refs but YAW_MCP_VAULT_PASSPHRASE is not set`, { keys: refKeys });
    throw new VaultPassphraseRequiredError(
      `vault locked: ${subject} references \${secret:...} but YAW_MCP_VAULT_PASSPHRASE is not set`,
      namespace,
      refKeys,
      "missing",
    );
  }
  // A vault that EXISTS but cannot be READ is a different failure from having
  // no vault at all, and collapsing the two told the operator to create a vault
  // they already have while the real reason (bad JSON, a truncated write,
  // EACCES) survived only in the warn line below. Keep "no vault exists yet"
  // for the null result and surface the read error on its own throw.
  let vault: Awaited<ReturnType<typeof loadVault>>;
  try {
    vault = await loadVault(vaultPath());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Failed to load vault for env resolution", { error: msg });
    throw new Error(`vault unreadable: ${msg}`);
  }
  if (!vault) {
    throw new Error(`vault locked: ${subject} references \${secret:...} but no vault exists yet`);
  }
  // A passphrase that does not open the vault is a question for the user, not
  // a dead end -- so it throws the SAME typed error as no passphrase at all,
  // tagged "invalid". Without this a wrong YAW_MCP_VAULT_PASSPHRASE was
  // unrecoverable in-session: the raw unlock error fell through to the generic
  // missing-credential path, which (correctly) refuses to elicit yaw-mcp's own
  // secrets, so nothing could offer the correction.
  //
  // VAULT_CHECK_CORRUPT_ERROR is deliberately re-thrown untouched: that error
  // means the passphrase IS correct and the check marker is damaged, so a
  // prompt would ask the user to re-type a passphrase that was never wrong and
  // then fail identically. Anything else here is a decrypt failure, which is
  // what a wrong passphrase looks like.
  let key: Buffer;
  try {
    key = await unlock(vault, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === VAULT_CHECK_CORRUPT_ERROR) throw err;
    log("warn", "Vault passphrase did not unlock the vault", { namespace, keys: refKeys });
    throw new VaultPassphraseRequiredError(
      `vault locked: the passphrase available to yaw-mcp does not unlock the vault (${msg})`,
      namespace,
      refKeys,
      "invalid",
    );
  }
  const { resolved, missing, malformed, values } = resolveSecretRefs(env, vault, key);
  // Hand the caller every decrypted value, keyed by secret NAME, so it can arm
  // the redactor with those as well as the composed strings. `resolved` holds
  // `Bearer <token>` for the documented `"Bearer ${secret:linear}"` shape, so
  // an upstream echoing only the bare token matched nothing -- the redactor
  // replaces exact substrings. A callback rather than a return field or a
  // module variable: the return type is consumed in several places, and a
  // module variable would be shared across concurrent connects.
  onSecretValues?.(values);

  // Caller-supplied shape check on the RESOLVED values, run before the audit
  // below. The remote branch uses it to reject a value that cannot be an HTTP
  // header: without it, that refusal happened after resolveServerEnv returned,
  // so the audit had already written "injected" for a secret that reached no
  // request and no transport. Nothing is recorded on this path -- the value was
  // decrypted and then discarded, which is neither "injected" nor "missing".
  const invalid = missing.length === 0 && malformed.length === 0 ? validate?.(resolved) : undefined;

  // Audit which secrets were consumed for this spawn -- NAME + namespace
  // only, never a value. Wrapped in try/catch (and each append is itself
  // fail-open) so a broken audit log can never block the spawn.
  //
  // Recorded BEFORE the refusal below: a FAILED spawn is exactly the case
  // an operator goes looking for in `yaw-mcp secrets audit`, and the
  // "missing" event kind is already advertised by that renderer. Audit
  // first, then refuse. recordResolveAudit itself suppresses "injected" on
  // the refusal path -- nothing reaches a child env when the spawn is
  // refused, so "injected" would be a lie (see its doc comment).
  if (!invalid) {
    try {
      await recordResolveAudit(namespace, env, missing, malformed);
    } catch (auditErr) {
      log("warn", "Failed to record secret-resolve audit (non-fatal)", {
        namespace,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }
  // Thrown after the audit decision above so the two orderings stay in one
  // place; the caller turns the key name into its own error, where the config
  // pointer lives.
  if (invalid) throw new InvalidResolvedValueError(invalid);
  // A malformed ref refuses exactly like an absent name -- the literal must
  // never reach a child -- but it is reported in its own clause and in its
  // bounded `display` form: `missing` holds NAMES, while a malformed span is a
  // slice of an env VALUE (an unterminated `${secret:` runs to the end of the
  // value), so it goes through secrets-vault's sanitizer, never raw.
  if (missing.length > 0 || malformed.length > 0) {
    const problems: string[] = [];
    if (missing.length > 0) problems.push(`missing or undecryptable secret refs: ${missing.join(", ")}`);
    if (malformed.length > 0) problems.push(`malformed secret refs: ${malformed.map((m) => m.display).join(", ")}`);
    throw new Error(`vault: ${problems.join("; ")}`);
  }
  return resolved;
}

/**
 * Append one audit event per secret reference this spawn touched:
 *   - "missing" for each name the vault lacked, and for each reference that
 *     could not be PARSED -- recorded under its `auditName`, which is the
 *     marker plus whatever prefix of the span was legal name text
 *     (`<malformed ref> gh` for `${secret:gh token}`), never the span
 *     itself. The audit log's `secret` field is a names-only contract
 *     (secrets-audit.ts), and a malformed span is env-VALUE text that can
 *     carry a URL or a password past the typo. The schema has no
 *     "malformed" event kind, so the marker is what tells the two apart.
 *   - "injected" for each distinct secret NAME that was referenced AND
 *     actually reaches the child env.
 * Names only -- the value is never read here, let alone written.
 *
 * The two kinds are mutually exclusive per call, and that is the whole
 * point: resolution is all-or-nothing. When ANY ref is missing or malformed,
 * the caller refuses the spawn, so NOTHING is injected -- not even the refs
 * that resolved fine. Recording those as "injected" anyway told an operator
 * asking "did this server ever receive my prod token?" a false yes.
 * So: refused -> record ONLY the "missing" events (a refused spawn must
 * still leave a trail); otherwise -> record "injected", which keeps meaning
 * "went into a spawn env".
 */
async function recordResolveAudit(
  namespace: string,
  env: Record<string, string>,
  missing: string[],
  malformed: MalformedSecretRef[],
): Promise<void> {
  if (missing.length > 0 || malformed.length > 0) {
    for (const name of new Set([...missing, ...malformed.map((m) => m.auditName)])) {
      await appendAuditEvent({ server: namespace, secret: name, event: "missing" });
    }
    return;
  }
  // Single source of truth for the ref shape AND for the scan itself is
  // secrets-vault's collectSecretRefNames -- this file used to keep its own
  // byte-equivalent copy of that loop (as did meta-tools.ts and doctor-cmd.ts),
  // each re-deriving the fresh-RegExp rule the shared /g object demands.
  for (const name of collectSecretRefNames(env)) {
    await appendAuditEvent({ server: namespace, secret: name, event: "injected" });
  }
}

declare const __VERSION__: string;

/** Node's timer ceiling. setTimeout stores its delay in a signed 32-bit int,
 *  so ANY delay above 2^31-1 ms (~24.9 days) silently becomes 1ms and fires
 *  almost immediately. A `connectTimeoutMs` past that -- a typo'd extra digit
 *  in bundles.json, which the loader's `> 0` check happily accepts -- would
 *  therefore fail the connect instantly while the error message quoted a
 *  multi-day ceiling. That per-server CONFIG value is clamped at the connect
 *  site so the value used and the value reported match.
 *
 *  For the operator-facing ENV knobs it is the top of the ACCEPTED RANGE
 *  rather than a clamp target -- see resolveTimeoutEnv for why the two
 *  differ. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Shared parser for the three timeout env knobs -- MCP_CONNECT_TIMEOUT here,
 *  MCP_LIST_TIMEOUT below, MCP_CALL_TIMEOUT in proxy.ts. Every one of them
 *  ends up as a setTimeout delay (ours for the handshake, the SDK's for the
 *  inventory and tools/call legs), so both halves of this matter.
 *
 *  STRICT DIGIT-RUN PARSE -- the shape resolveServerCap (server-cap.ts) and
 *  the idle-threshold resolver (server.ts) already use. Number.parseInt PREFIX
 *  parses, so "3e9" is 3, "30s" is 30 and "1_000" is 1: a 3ms ceiling from a
 *  value that reads like a generous one. Every call on that leg then fails
 *  instantly, and a timeout is NOT branded a routing fault, so server.ts books
 *  each one against the upstream's health and error rate.
 *
 *  REJECT OUT-OF-RANGE RATHER THAN CLAMP. Clamping to MAX_TIMEOUT_MS turns an
 *  absurd knob into an effectively infinite one (~24.8 days): the call never
 *  settles, so the namespace's inflightCalls marker is never cleared and the
 *  namespace stops being deactivatable or idle-reapable. Falling back to the
 *  documented default is what the junk branch already does, and it is the
 *  right answer for both.
 *
 *  Trimmed first for the cmd.exe `set VAR= && ...` idiom other resolvers in
 *  this repo already document; a value that is empty once trimmed reads as
 *  unset and takes the default silently. Anything else we refuse gets one warn
 *  naming the rejected value, the ceiling, and the number actually in effect
 *  -- otherwise the operator's knob is ignored with no diagnostic at all. */
export function resolveTimeoutEnv(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultMs;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultMs;
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n > 0 && n <= MAX_TIMEOUT_MS) return n;
  }
  log("warn", `${name} ignored: expected a whole number of milliseconds in 1..${MAX_TIMEOUT_MS}`, {
    value: raw,
    maxMs: MAX_TIMEOUT_MS,
    usingMs: defaultMs,
  });
  return defaultMs;
}

/** Default connect timeout. Per-server `config.connectTimeoutMs` wins
 *  when present; this is the fallback used otherwise. Env override
 *  (MCP_CONNECT_TIMEOUT) tunes the FALLBACK only -- per-server config
 *  always takes precedence so a slow server can be tuned independently
 *  of the global default. */
const DEFAULT_CONNECT_TIMEOUT = resolveTimeoutEnv("MCP_CONNECT_TIMEOUT", 15_000);

// Bound on per-request listTools/listResources/listPrompts after the
// initial handshake. Without this, a server that completes connect but
// then hangs on an inventory call would lock up activation forever (the
// CONNECT_TIMEOUT timer above is already cleared by the time we reach
// the listX calls). 15s matches the connect ceiling -- if a server
// can't list its own tools in 15s, surface it as a real failure.
const LIST_TIMEOUT = resolveTimeoutEnv("MCP_LIST_TIMEOUT", 15_000);

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

/** True for a value that is itself an unresolved `${secret:NAME}` reference
 *  rather than a resolved credential. Shared by the variant builder and the
 *  replace loop so the two cannot drift: the loop SKIPS such a value (the
 *  catch-all rewrite at the end of redactSecretsInOutput is what handles it,
 *  and it hides the vault entry's NAME instead of naming the env key), and the
 *  builder must not spend variants on it either -- a percent-encoded
 *  `${secret:...}` is not a shape any credential takes. */
function isUnresolvedSecretRef(value: string): boolean {
  return value.startsWith("${secret:") && value.endsWith("}");
}

/** The length a value has to clear before it is matched against output at all.
 *  It gates BOTH ends on purpose -- the replace loop skips anything shorter,
 *  and secretMatchVariants refuses to DERIVE an encoded form from a shorter
 *  base -- so it is one constant rather than two literals: a threshold that
 *  moved in one place and not the other is exactly how a value the design skips
 *  as too short creeps back in through a longer encoding of itself. */
const SECRET_MATCH_MIN_LENGTH = 8;

/** The value as an HTML-escaping serializer would print it. A LIST rather than
 *  one string because the encoders agree on four characters and disagree on the
 *  fifth: `&` -> `&amp;`, `<` -> `&lt;`, `>` -> `&gt;` and `"` -> `&quot;` are
 *  universal, while the apostrophe comes out as `&#39;` (escape-html, lodash),
 *  `&#x27;` (Handlebars, Python's html.escape) or `&apos;` (XML-shaped
 *  serializers). Exact matching cannot pick a winner, so a value carrying an
 *  apostrophe emits all three and a value without one collapses to a single
 *  entry in the caller's dedupe. `&` is replaced FIRST so the ampersands the
 *  later replacements introduce are not escaped a second time (`<` would
 *  otherwise become `&lt;` and then `&amp;lt;`). */
function htmlEscapeVariants(base: string): string[] {
  const escaped = base.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (!escaped.includes("'")) return [escaped];
  return ["&#39;", "&#x27;", "&apos;"].map((apostrophe) => escaped.replace(/'/g, apostrophe));
}

/** Every FORM one resolved value can plausibly take by the time an upstream
 *  ECHOES it back, so exact-substring matching still finds it. The caller keys
 *  every variant of a value to the SAME env or secret name, so a hit still
 *  names the credential to rotate.
 *
 *  Two bases, then a transform per base:
 *
 *  - RAW and TRIMMED. undici strips leading and trailing HTTP whitespace from
 *    every header value, so a vault entry carrying edge whitespace is SENT as
 *    `Bearer tok` while the map holds `Bearer tok ` -- and the exact-substring
 *    match then finds nothing in the echo. Reachable shapes, checked rather
 *    than assumed: a LEADING space (nothing strips it), a trailing SPACE, and
 *    a doubled trailing newline. Note what is NOT one -- `secrets set --stdin`
 *    strips a single trailing newline itself (secrets-cmd.ts, the piped-stdin
 *    branch: `.replace(/\r?\n$/, "")`), so the tidiest-looking example is the
 *    one that path cannot produce; it strips ONE, so a doubled newline still
 *    arrives here. A child that reads an injected var usually trims it before
 *    echoing it back too.
 *
 *  - JSON-ESCAPED, the one that matters most. MCP servers speak JSON-RPC and
 *    the common Node loggers (pino, winston) default to JSON lines, so a value
 *    an upstream echoes is escaped the moment it lands in a document: a newline
 *    becomes a literal \n, a quote a \", a backslash a \\. A multi-line PEM, or
 *    a token carrying a quote or backslash (`Headers` accepts both, so both
 *    reach the wire), therefore comes back sharing no substring with the stored
 *    value -- and one JSON.parse on the logged line recovers the credential
 *    byte-for-byte. `JSON.stringify(v).slice(1, -1)` is exactly what the value
 *    looks like embedded IN a JSON string, minus the quotes the document adds.
 *
 *  - PERCENT-ENCODED. encodeURIComponent rewrites 24 printable-ASCII
 *    characters; the three that fall INSIDE the base64 alphabet are `+`, `/`
 *    and `=`, which is what makes a base64-shaped credential the shape worth
 *    covering here. So a gateway that bounces the failed request
 *    through a login redirect, or quotes back the query string it received,
 *    echoes %2B / %2F / %3D and matches nothing.
 *
 *  - HTML-ESCAPED. A remote answering with an HTML error page is ordinary -- an
 *    auth proxy, a WAF, a load balancer in front of the endpoint -- and the
 *    streamable-http transport puts `response.text()` straight into the error
 *    it throws, so that page reaches the redactor whole. NOT covered by the
 *    JSON variant: on the one character the two encoders share, JSON emits `\"`
 *    and HTML emits `&quot;`, which are different byte strings, so a token
 *    carrying a quote rides out of an HTML echo intact and with no ***NAME***
 *    marker to say a credential was involved at all. The other four characters
 *    (`&`, `<`, `>`, `'`) are rare in token alphabets but ordinary in a
 *    password, which is a credential this map holds just as often. See
 *    htmlEscapeVariants for why the apostrophe costs three entries.
 *
 *  - CASE-FOLDED, but ONLY for an all-hex value. An upstream that normalizes a
 *    token before printing it (a case-insensitive compare path logging its
 *    normalized form) echoes a case this map does not hold. Deliberately NOT
 *    applied to every value: this function is handed the whole resolved env,
 *    most of which is ordinary configuration, and a case-insensitive pass would
 *    replace a Windows path or a URL merely MENTIONED in the output in another
 *    case -- costing the reader the path the error was actually about while
 *    hiding no credential. Hex is the carve-out because folding it is LOSSLESS,
 *    so the folded echo IS still the credential; for a mixed-alphabet token it
 *    is not, and there is nothing to recover. The gate is /^[0-9a-f]+$/i, which
 *    also admits digit-only runs -- a date, a timestamp -- and those DO collide
 *    with prose. Harmless rather than fixed: for a digit-only value both folds
 *    are the identity, so they add no variant the raw match did not already
 *    carry. It is the losslessness that earns the carve-out, not any claim that
 *    hex cannot appear in ordinary text.
 *
 *  NOT EXHAUSTIVE. The gap is other ENCODERS of shapes already in the list, not
 *  shapes nobody thought of, so the four above are "the common encoders" rather
 *  than "every encoder". Each of these was reproduced; none is covered:
 *
 *  - Other runtimes' JSON differs from Node's. Python's `json.dumps` defaults
 *    to `ensure_ascii=True` and escapes every non-ASCII character as `\uXXXX`;
 *    Go's `encoding/json` escapes `&`, `<` and `>` as `\u0026`, `\u003c`
 *    and `\u003e`. A non-ASCII password -- an ordinary shape for a credential --
 *    echoed by a Python upstream therefore still leaks whole.
 *  - `URLSearchParams` / form-urlencoded, which is the standard OAuth redirect
 *    encoder, differs from encodeURIComponent: a space becomes `+` rather than
 *    `%20`, and `~`, `!`, `'`, `(` and `)` are percent-encoded where
 *    encodeURIComponent leaves them alone.
 *  - Double percent-encoding across a redirect chain (`%2F` -> `%252F`), which
 *    a second hop that re-encodes what it received produces.
 *
 *  Each is one more replace chain, so the reason to stop is not cost: every
 *  entry widens the map matched against arbitrary output, and these are
 *  progressively rarer than the four above.
 *
 *  REJECTED:
 *
 *  - BASE64 re-encoding of the value. Not a false-match risk -- a base64 blob
 *    of a high-entropy value collides with nothing -- but it cannot be done
 *    honestly. base64 of a SUBSTRING appears in the output only when that
 *    substring starts on a 3-byte boundary, so the realistic shape,
 *    `base64("user:" + token)`, does not contain `base64(token)`. It would
 *    cover the whole-value re-encode alone while reading like coverage of
 *    re-encoding. It is also the wrong CLASS: JSON escaping and percent
 *    encoding are applied by the echo to whatever string it holds, whereas
 *    base64 is applied to a credential before USE -- which would mean the map
 *    should be holding the encoded form in the first place.
 *
 *  - Unicode normalization, shell quoting, regex escaping: no reproduced shape,
 *    so they would be guesses paid for on every call.
 *
 *  The floor (SECRET_MATCH_MIN_LENGTH) is enforced HERE as well as in the
 *  caller's replace loop, and the two are not redundant. No transform above
 *  SHORTENS its base (several are the identity on a value with nothing to
 *  escape, and the hex fold is equal-length by construction), so a floor
 *  checked only at match time is a floor on the
 *  ENCODED string rather than on the credential: a 7-char config snippet the
 *  design deliberately skips clears the bar as a 9-char JSON escape, and a
 *  6-char path clears it percent-encoded -- and the redactor then mangles
 *  exactly the ordinary output the floor exists to keep readable. So a base
 *  under the floor emits no derived form at all: a value too short to match raw
 *  cannot match encoded either. The base itself is still emitted, and still
 *  floored by the loop, which is what keeps the TRIMMED base -- the one
 *  transform that can SHORTEN a value -- honest.
 *
 *  For an ordinary non-hex token (letters, digits, `_`, `-`) every transform IS
 *  the identity, so the caller's dedupe collapses the list back to the single
 *  entry this function used to produce -- the list only grows for a value that
 *  actually needs escaping, or for hex. */
function secretMatchVariants(value: string): string[] {
  const bases = [value];
  const trimmed = value.trim();
  if (trimmed !== value) bases.push(trimmed);
  if (isUnresolvedSecretRef(trimmed)) return bases;

  const variants: string[] = [];
  for (const base of bases) {
    variants.push(base);
    // Gate the DERIVED forms on the BASE, not on what they produce. Everything
    // below lengthens its input, so a base under the floor would otherwise
    // re-enter matching as a longer encoding of itself -- see the floor
    // paragraph above. The raw base pushed on the line above is still emitted
    // and still floored by the caller.
    if (base.length < SECRET_MATCH_MIN_LENGTH) continue;
    variants.push(JSON.stringify(base).slice(1, -1));
    try {
      variants.push(encodeURIComponent(base));
    } catch {
      // encodeURIComponent throws URIError on a lone surrogate, which a value
      // decoded from a truncated buffer can carry. Skip that one variant
      // rather than letting a redactor that runs ONLY on the failure path
      // throw and replace the ActivationError with a URIError.
    }
    variants.push(...htmlEscapeVariants(base));
    if (/^[0-9a-f]+$/i.test(base)) {
      variants.push(base.toLowerCase(), base.toUpperCase());
    }
  }
  return variants;
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
 * The redactor is conservative: short values (under SECRET_MATCH_MIN_LENGTH,
 * 8 chars) are skipped to avoid mangling unrelated substrings; the goal is to
 * catch the high-entropy tokens that look like secrets, not redact the entire
 * output. That floor is on the STORED value, so a value below it does not
 * re-enter matching through a longer encoding of itself either.
 *
 * Matching is against a VARIANT LIST per value (secretMatchVariants, defined
 * directly above), not the single stored string, because the transform that
 * defeats an exact match is applied by the ECHO -- a JSON logger, a redirect
 * builder -- not by anything on this side. That list is not exhaustive either;
 * its own doc block names the encoders it does not cover.
 *
 * STILL NOT COVERED, and not fixable by adding more variants. These are limits
 * of substring matching itself, so the list below is not a coverage claim:
 *
 *   - A value BROKEN across lines. Reads exotic if you picture a fixed-width
 *     logger, but the dominant trigger is Node's OWN default object formatting:
 *     util.inspect, which is what a plain `console.error({ key })` in a child
 *     goes through, renders a long MULTI-LINE string as one quoted chunk per
 *     line joined with ` +`. So a PEM -- the exact credential shape the
 *     JSON-escaped variant exists for -- comes back as
 *     `'-----BEGIN PRIVATE KEY-----\n' +` / `'MIIB...'`, and NEITHER the raw
 *     value nor its JSON escape is a contiguous run of that output (measured on
 *     Node 22, which splits only once the rendering also exceeds the 80-column
 *     breakLength; a short two-line value stays on one line and still matches).
 *     A single-line token is not split by inspect at any length -- that one
 *     does need a fixed-width formatter, and is the rarer case of the two.
 *   - A token straddling the stderr-ring cut. The ring is the `stderrRing`
 *     accumulator on the local-spawn path, whose `.slice(-STDERR_RING_CAP)`
 *     keeps only the newest 8K of decoded stderr, so a token written across
 *     that boundary survives into the tail as a SUFFIX, and a suffix matches
 *     nothing.
 *   - An upstream that echoes only a PREFIX ("key lin_api_9f... was
 *     rejected"). Same shape, other end.
 *
 * Each of those leaks a PARTIAL credential -- worth less than the whole one,
 * but worth something, and none of them emits a ***NAME*** marker, so nothing
 * in the message even says a credential was involved. Closing them means
 * leaving exact substrings for a fuzzy or entropy-based matcher, which trades
 * away this function's most important property: it cannot mangle output that
 * does not contain the secret. That trade has not been made here.
 *
 * SCOPE -- documented rather than widened. Every call site hands this the
 * RESOLVED SERVER ENV only (the values yaw-mcp itself injected from bundles.json
 * and the vault). The child ALSO receives the whole inherited parent env
 * (`stripInternalSecretsFromEnv(process.env)`, spread under serverEnv at the
 * spawn), and nothing here scans that: a credential the user exported in their
 * shell or put in the CLIENT's env block (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY,
 * NPM_TOKEN) that a crashing child echoes on stderr reaches the
 * ActivationError -- and so the LLM and the log -- unredacted. That is the
 * contract README promises (redaction of what yaw-mcp injects), not an
 * oversight in the loop below. The natural hardening, should it be wanted, is
 * to pass a merged map: resolvedServerEnv plus the parent entries whose KEY
 * matches /(TOKEN|SECRET|PASS|API_?KEY|CREDENTIAL)/i, keeping the >=8-char
 * guard so PATH / HOME are never mangled.
 */
function redactSecretsInOutput(text: string, env: Record<string, string>): string {
  let out = text;
  // Expand each value into its variant list (secretMatchVariants) and treat
  // every variant as a plain extra entry under the SAME key, so a hit still
  // names the credential to rotate rather than reporting an anonymous match.
  // Fixed here rather than at the header call site because this is the choke
  // point every caller goes through, and the local/stdio path meets the same
  // encoded-echo shapes the remote one does.
  //
  // Deduped by the variant STRING. Most transforms are the identity for an
  // ordinary token, so without this the same regex would run three or four
  // times per value; and when two DIFFERENT env keys hold the same value, one
  // entry is what already happened in practice (the first replace consumed
  // every occurrence and the second found nothing) -- the set just makes that
  // explicit and keeps a key naming it.
  //
  // TWO passes, RAW values first, because the marker names the credential to
  // ROTATE and pointing at the wrong entry is worse than an anonymous match.
  // One value's derived variant can equal a DIFFERENT value's raw string (a
  // path's JSON escape is a plausible token; a path's percent-encoding is a
  // plausible value of the _URL twin sitting next to it in the same env). With
  // a single pass the winner is whichever env key Object.entries happened to
  // yield first, so a real credential in the output gets reported under the
  // path's key. Claiming every raw string before any derived one makes the rule
  // "the value that IS this string owns it" instead of "whoever got there
  // first", and a raw string too short to matter still only blocks the identical
  // string, which the floor below would have skipped anyway.
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  const claim = (k: string, variant: string): void => {
    if (seen.has(variant)) return;
    seen.add(variant);
    entries.push([k, variant]);
  };
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    claim(k, v);
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    for (const variant of secretMatchVariants(v)) claim(k, variant);
  }
  // Replace longest values first. When one secret value is a substring of
  // another (e.g. a token and that same token with a suffix), a short-first
  // pass can redact the inner value and leave a real-secret suffix exposed.
  // Descending-by-length order guarantees the containing value is redacted
  // whole before any of its substrings is considered.
  //
  // ONE flat sort over every (key, variant) pair, not a sort per secret --
  // that is what makes CONTAINMENT hold ACROSS secrets, which is where the
  // variants make it harder. A variant can now be LONGER than another secret's
  // raw value (a token containing a quote is shorter than its own JSON-escaped
  // form, which in turn can contain a second secret's raw value whole), so
  // grouping by secret, or sorting the env entries before expanding them, would
  // let a short raw value redact the inside of a longer escaped one and leave
  // the tail of a real credential in the clear.
  //
  // What longest-first buys is exactly CONTAINMENT: whenever one entry contains
  // another, the container is replaced first, so no later pass can strand a real
  // tail. It does NOT make two DISTINCT secrets that OVERLAP in the echoed text
  // both come out whole -- where A's escaped form ends INSIDE B's raw span,
  // replacing the longer A first eats the shared bytes and B stops matching,
  // leaving B's remainder in the clear (A=`aaaa"bbbb`, B=`bbbbCCCC`, echoed
  // JSON-escaped, strands `CCCC`).
  //
  // Measured rather than assumed, 4000 pairs each way: two INDEPENDENT random
  // values echoed back to back never strand a byte (0/4000 -- adjacency is not
  // overlap, since B is still whole after A is replaced), while values built to
  // share bytes at the boundary strand every time (4000/4000). So this is not a
  // dice roll the ordering could win: it needs two secrets whose values actually
  // overlap in the output, and no ordering of a substring replacer survives that
  // -- whereas every ordering other than longest-first loses containment, which
  // is the case that shows up in practice.
  entries.sort(([, a], [, b]) => b.length - a.length);
  for (const [k, v] of entries) {
    // The other end of the floor secretMatchVariants gates emission on. This
    // one catches what still reaches the loop under it: a TRIMMED base (the one
    // transform that shortens) and a raw value that was always too short. That
    // floor is what keeps the regex off unrelated substrings.
    if (v.length < SECRET_MATCH_MIN_LENGTH) continue;
    // Skip values that are themselves an unresolved ${secret:...} literal.
    if (isUnresolvedSecretRef(v)) continue;
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
  // ASCII arrow on purpose: this suffix rides every activation error into the
  // stderr log, and a `->` survives a Windows console codepage where the
  // Unicode arrow renders as mojibake and then gets pasted into bug reports.
  return `${message} -> Fix in ~/.yaw-mcp/bundles.json under "${config.namespace}", then restart this MCP client.`;
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

/** One-line reason for a failed REMOTE connect, appended after the verbatim
 *  "refused the connection." sentence.
 *
 *  Without it every non-timeout remote failure read as "the server is down":
 *  an unauthenticated 401 against a hosted MCP, a typo'd host (ENOTFOUND), a
 *  wrong path (404) and a self-signed certificate all produced that one
 *  sentence while the SDK error carrying the actual reason was discarded --
 *  steering the reader away from the real fix (auth, URL, TLS).
 *
 *  Assembled rather than lifted from `err.message` because the fetch-based
 *  transports report EVERY network failure as the useless "fetch failed" (the
 *  real reason hangs off `err.cause`) and expose the HTTP status only as a
 *  numeric `.code`. Codes outside the HTTP range are skipped: a JSON-RPC
 *  error code (-32000 and friends) is not a status and must not be printed as
 *  one. Truncated because a streamable-http failure can carry a whole HTML
 *  error page from `response.text()`. */
function remoteFailureDetail(err: unknown, resolved: Record<string, string>): string {
  const parts: string[] = [];
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "number" && code >= 100 && code <= 599) parts.push(`HTTP ${code}`);
  const cause = err instanceof Error ? err.cause : undefined;
  const message = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  if (message) parts.push(message);
  // Redact BEFORE the whitespace collapse and BEFORE the 200-char cut, and
  // both orderings are load-bearing. redactSecretsInOutput matches exact
  // substrings, so a resolved value containing a newline stops matching once
  // /\s+/g has flattened it; and a secret sitting past the cut has to be
  // REMOVED rather than merely hidden -- the same scrub-then-truncate
  // reasoning health-score.ts already spells out for its own truncation.
  //
  // This is the remote leak path, and it is the whole reason the resolved
  // headers are assigned into resolvedServerEnv: the stderr ring is empty for
  // a remote, so nothing else on this branch ever reaches the redactor. A
  // gateway that echoes the request headers in its 401 body would otherwise
  // put the bearer token into an ActivationError that is logged, recorded in
  // activationFailures, AND rendered into discover() output for the model.
  return redactSecretsInOutput(parts.join(": "), resolved).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Attach the child's stderr tail to an ActivationError raised AFTER the
 *  handshake -- the inventory-fetch window, where a child that dies mid-fetch
 *  surfaces either as "disconnected during initialization" or as a tools/list
 *  error, and where nothing used to carry the reason it printed on the way
 *  out. The pre-handshake catch already does this; without it here the
 *  elicitation haystack (server.ts scans `stderrTail` for "SOME_TOKEN is
 *  required") and the oam heap-cap hint both lost their input exactly where
 *  the comment on the boot-probe downgrade says such deaths surface.
 *
 *  Deliberately narrow: only an ActivationError that has NO tail yet and only
 *  when something was actually captured. message, category and cause are
 *  carried over verbatim so the downgrade gate (which compares categories) and
 *  server.ts's instanceof branches behave exactly as before -- the tail and the
 *  appended reason are additive. Remote connections never populate the ring,
 *  so this is a no-op for them. */
/** Redact resolved secret values out of an ActivationError's own MESSAGE.
 *
 *  withStderrTail below redacts only the tail it APPENDS, and returns the
 *  error untouched when there is no tail -- which is always, for a remote,
 *  since nothing writes the stderr ring on that branch. That left the whole
 *  post-handshake path unredacted: a `tools/list` failure carries the SDK's
 *  `Error POSTing to endpoint: <response body>` verbatim, so a gateway that
 *  echoes the request headers in a 401 body put the bearer token into an
 *  error that is logged to stderr AND returned to the model in the activate
 *  result. The pre-handshake branch was already covered; this is the same
 *  leak one phase later.
 *
 *  Applied unconditionally rather than only for remotes: on a local server
 *  the same map holds the child's resolved env, so an upstream that echoes an
 *  injected value in a JSON-RPC error leaks it identically.
 *
 *  Category, tail and cause are carried over verbatim so the oam boot-probe
 *  downgrade gate and server.ts's instanceof branches are unaffected. */
function redactActivationMessage(err: unknown, env: Record<string, string>): unknown {
  if (!(err instanceof ActivationError)) return err;
  const safe = redactSecretsInOutput(err.message, env);
  if (safe === err.message) return err;
  return new ActivationError(safe, err.category, err.stderrTail, err.cause);
}

function withStderrTail(err: unknown, stderrRing: string, env: Record<string, string>): unknown {
  if (!(err instanceof ActivationError) || err.stderrTail) return err;
  const trimmed = stderrRing.trim();
  if (trimmed.length === 0) return err;
  const safe = redactSecretsInOutput(trimmed, env);
  // The hint goes in the MESSAGE, ahead of the tail: buried in 500 characters
  // of banner it is invisible, and the message is the only part the user reads.
  const oomHint = oamHeapOomHint(trimmed);
  const message = `${err.message}${oomHint ? ` ${oomHint}` : ""} stderr tail: ${safe.slice(-500)}`;
  return new ActivationError(message, err.category, safe, err.cause);
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
    //
    // The respawn runs the WHOLE of connectToUpstreamOnce again, resolveServerEnv
    // included, so `yaw-mcp secrets audit` records a second "injected" event per
    // secret name for this one logical activation. Accepted, not threaded
    // around: two child envs really did receive the value (the oam child and
    // the node child), and "injected" is defined as "went into a spawn env" --
    // suppressing the second event would make the audit under-report exactly
    // the spawn that ended up serving traffic.
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

// The internal-secret strip (INTERNAL_SECRET_ENV_KEYS and the two helpers
// built on it) lives in internal-secret-env.ts now, so the self-upgrade spawns
// in auto-upgrade.ts / upgrade-cmd.ts can share it without loading the MCP
// SDK. Re-exported under the same names: server.ts, audit-cmd.ts and the tests
// import them from here.
export { INTERNAL_SECRET_ENV_KEYS, scrubInternalSecretsFromProcessEnv, stripInternalSecretsFromEnv };

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
  //
  // On a REMOTE entry this same map holds the resolved request HEADERS,
  // keyed by header name (so a leaked bearer token redacts to
  // `***Authorization***`). A remote has no child and therefore no stderr
  // ring: its leak path is the HTTP response body that remoteFailureDetail
  // lifts out of the SDK error, which is why that function takes this map.
  let resolvedServerEnv: Record<string, string> = {};
  // The command that is ACTUALLY handed to the transport, post uv/oam rewrite.
  // config.command is what the operator typed (`npx`, `uvx`); the process that
  // fails to spawn may be yaw-mcp's managed uv binary or the oam runtime, and
  // the spawn_failure message names both so "not on PATH" points at the file
  // the OS could not find as well as the entry to edit.
  let spawnedCommand = config.command;

  if (config.type === "local") {
    if (!config.command) {
      throw new Error("command is required for local servers");
    }

    // Strip yaw-mcp-internal secrets from the child env — see
    // stripInternalSecretsFromEnv for the key list and why the match is
    // case-insensitive. Everything else from process.env (PATH, HOME, proxy
    // vars, etc.) is intentionally forwarded so the child spawns/runs in the
    // user's normal environment; server-specific secrets come via serverEnv,
    // which resolveServerEnv resolves from the vault BELOW -- after the uv and
    // oam resolvers, so a locked vault pays a uv bootstrap and an oam probe
    // before it refuses.
    const parentEnv = stripInternalSecretsFromEnv(process.env);
    // Resolve the launch command: `uv`/`uvx` to our managed binary, then
    // node/npx onto the oam runtime. BOTH resolvers can throw (unsupported
    // platform, download/checksum failure, a wedged oam binary), and the
    // try/catch further down wraps client.connect() ONLY -- so classify and
    // wrap here. Without this the failure escapes connectToUpstreamOnce as a
    // bare Error: no category, no stderr tail, and none of the
    // `-> Fix in ~/.yaw-mcp/bundles.json` pointer every other local spawn
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
    spawnedCommand = resolved.command;

    // Resolve ${secret:NAME} references in the server's env against the
    // local secret vault. Fail-CLOSED: when the env carries refs and
    // YAW_MCP_VAULT_PASSPHRASE is unset (or no vault exists, or a name is
    // missing/undecryptable), resolveServerEnv THROWS and the server never
    // spawns -- the literal `${secret:NAME}` is NOT passed through to the
    // child. A ref-free env skips the vault entirely and passes through
    // unchanged. The throw is a plain Error, so the oam boot-probe
    // downgrade below deliberately does not retry it.
    // Mirror image of the remote branch's env warning below. A local server
    // has no HTTP request to put a header on, so `headers` here is the same
    // silent drop this field exists to fix, pointing the other way. Keys
    // only in the structured field -- never values.
    if (config.headers && Object.keys(config.headers).length > 0) {
      log("warn", "Ignoring headers on a local server: headers apply only to remote (HTTP/SSE) upstreams", {
        namespace: config.namespace,
        keys: Object.keys(config.headers),
      });
    }

    // The bare decrypted values ride alongside the composed ones in the
    // redaction map. A child that echoes only the token -- not the whole
    // `Bearer <token>` string it was spliced into -- would otherwise match
    // nothing, the redactor being exact-substring.
    let secretValues: Record<string, string> = {};
    const serverEnv = await resolveServerEnv(config.env ?? {}, config.namespace, undefined, undefined, (v) => {
      secretValues = v;
    });
    resolvedServerEnv = { ...serverEnv, ...secretValues };
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

    // Remote entries never spawn a child, so there is no process env to fill
    // and `env` still goes nowhere -- but the credential now has a home:
    // `headers`, resolved through the same vault a few lines below. An entry
    // that still carries its token in `env` would connect unauthenticated and
    // get a 401, so the warning stays and now names the fix.
    //
    // The PREFIX of this message is load-bearing: callers and tests filter on
    // "Ignoring env on a remote server". Append to it, never reword it.
    // It stays a WARN rather than becoming an error deliberately -- an
    // existing entry with a stale `env` block still connects to whatever
    // works today, and an upgrade must not turn that into a hard failure.
    if (config.env && Object.keys(config.env).length > 0) {
      log(
        "warn",
        'Ignoring env on a remote server: env (and ${secret:...} refs in it) is never sent to remote upstreams -- put the credential in "headers" instead',
        { namespace: config.namespace, keys: Object.keys(config.env) },
      );
    }

    // bundles.json validation accepts "stdio" as a transport on ANY entry, so
    // a remote entry can declare a transport this branch cannot honour -- it
    // falls through to streamable-http below. Without a warning the operator
    // sees only a confusing HTTP-shaped connect failure against a URL they
    // thought was speaking stdio.
    if (config.transport === "stdio") {
      log(
        "warn",
        'Remote server declares transport "stdio", which only applies to local servers; using streamable-http',
        { namespace: config.namespace },
      );
    }

    // A scheme-less or otherwise malformed url ("localhost:3000", a stray
    // space) makes the URL constructor throw a bare TypeError("Invalid URL"):
    // no category, no namespace, no url, and none of the "Fix in ..." pointer
    // every other connect failure carries -- and server.ts spends its retry on
    // what is a permanent config error. Classify it here instead.
    let url: URL;
    try {
      url = new URL(config.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ActivationError(
        withConfigPointer(`Server "${config.namespace}" has an invalid url "${config.url}": ${message}`, config),
        "unknown",
        undefined,
        err,
      );
    }
    // Resolve the headers AFTER the url parse, not before. A malformed url is
    // a permanent config error; resolving first would fire a vault-passphrase
    // elicitation round-trip (up to a 60s modal in the client) before
    // reporting a failure no passphrase could ever fix.
    //
    // Fail-CLOSED exactly like the local env path: a locked vault, a missing
    // name or a malformed ref THROWS here and no transport is ever
    // constructed, so the literal `${secret:NAME}` can never reach a request.
    const rawHeaders = config.headers ?? {};
    let requestHeaders: Record<string, string> | undefined;
    if (Object.keys(rawHeaders).length > 0) {
      // Validate with the runtime's own parser rather than a hand-rolled
      // regex, one key at a time so the refusal can name WHICH header. The
      // TypeError that `Headers` throws QUOTES the offending value, which here
      // is the secret, so it is caught and discarded rather than wrapped. A
      // merely trailing newline is fine (Headers strips leading and trailing
      // HTTP whitespace), which matters because `yaw-mcp secrets set --stdin`
      // is documented as raw and multi-line.
      //
      // Passed INTO resolveServerEnv rather than run after it: the resolve
      // audits what it decrypted, so a check that ran afterwards left the log
      // claiming the secret was injected into a server that never received it
      // and for which no transport was ever built.
      const validateHeaders = (resolved: Record<string, string>): string | undefined => {
        const probe = new Headers();
        for (const [name, value] of Object.entries(resolved)) {
          try {
            probe.append(name, value);
          } catch {
            return name;
          }
        }
        return undefined;
      };

      let resolvedHeaders: Record<string, string>;
      let headerSecretValues: Record<string, string> = {};
      try {
        resolvedHeaders = await resolveServerEnv(
          rawHeaders,
          config.namespace,
          "remote server headers",
          validateHeaders,
          (v) => {
            headerSecretValues = v;
          },
        );
      } catch (err) {
        if (err instanceof InvalidResolvedValueError) {
          throw new ActivationError(
            withConfigPointer(
              `Server "${config.namespace}" has an invalid value for header "${err.key}" -- an HTTP header value cannot contain a line break or a control character (the value is not shown).`,
              config,
            ),
            "unknown",
            undefined,
            undefined,
          );
        }
        throw err;
      }
      // Assigning into the redaction map is what arms redactSecretsInOutput
      // for this branch -- see remoteFailureDetail. The bare decrypted values
      // go in beside the composed headers: the documented shape is
      // `"Authorization": "Bearer ${secret:linear}"`, and a gateway that
      // answers with `{"error":"invalid_api_key","key":"<token>"}` echoes only
      // the token, which the composed string does not match.
      resolvedServerEnv = { ...resolvedHeaders, ...headerSecretValues };
      requestHeaders = resolvedHeaders;
    }

    // Pass the PLAIN OBJECT the operator wrote, not the probe Headers
    // instance, and pass `undefined` when there is nothing to send so the
    // zero-header path stays byte-identical to before this field existed.
    //
    // requestInit is correct for BOTH transports and is all that is needed:
    // the SSE transport's _commonHeaders merges requestInit.headers into the
    // initial GET stream as well as every POST, despite a stale doc comment
    // saying it only customizes POSTs. Deliberately NOT eventSourceInit --
    // supplying that hands the SDK a fetch that wins over the header-injecting
    // one -- and deliberately not authProvider, which is the interactive
    // OAuth flow and would try to open a browser from inside a stdio server.
    const transportOpts = requestHeaders ? { requestInit: { headers: requestHeaders } } : undefined;
    if (config.transport === "sse") {
      transport = new SSEClientTransport(url, transportOpts);
    } else {
      transport = new StreamableHTTPClientTransport(url, transportOpts);
    }
  }

  // Connect with timeout — clear timer on success, close client on timeout.
  // Per-server config.connectTimeoutMs wins over the module default so a
  // slow upstream can be tuned without globally raising the ceiling.
  // Errors are categorized (spawn/install/timeout/protocol) so the caller
  // can produce an actionable message for the LLM. stderr tail is included
  // when available — it's the part that usually explains the real failure.
  // Clamped to MAX_TIMEOUT_MS: an out-of-range delay makes setTimeout fire
  // after 1ms, so an absurd config value would fail the connect instantly
  // while every message below quoted the absurd ceiling back at the reader.
  const connectTimeoutMs = Math.min(
    typeof config.connectTimeoutMs === "number" && config.connectTimeoutMs > 0
      ? config.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT,
    MAX_TIMEOUT_MS,
  );
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
      // The refusal sentence stays verbatim and the underlying reason is
      // APPENDED: on its own it reads as "server down" for failures that are
      // nothing of the kind (401, 404, ENOTFOUND, a self-signed certificate),
      // and the SDK error carrying the truth was discarded entirely.
      const detail = timedOut ? "" : remoteFailureDetail(err, resolvedServerEnv);
      message = timedOut
        ? `Remote server at ${config.url} did not respond within ${connectTimeoutMs / 1000}s. Verify the URL is reachable.`
        : `Remote server at ${config.url} refused the connection.${detail ? ` ${detail}` : ""}`;
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
        // Name the CONFIG command first (it is the line the operator has to
        // edit) but do not stop there: after a uv/oam rewrite the binary that
        // actually ENOENT'd is one the user never typed, and advising them to
        // install a runtime that is not the missing thing sends them the wrong
        // way. When the two differ, say which file the OS could not find.
        message = `Command '${config.command}' is not on PATH or is not executable. Verify the runtime is installed (e.g. Node.js for npx, Python for uvx).${
          spawnedCommand && spawnedCommand !== config.command
            ? ` The binary that actually failed to spawn was '${spawnedCommand}'.`
            : ""
        }`;
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
  // fallback respawned on node, that same marker plus `oamPinned` when the
  // session memo skipped the rewrite for a namespace an EARLIER downgrade
  // pinned to node, and nothing extra for plain node spawns.
  //
  // The pinned case is why this is not a two-way branch: a memo-served connect
  // never sets oamRewriteApplied, so it used to log as an ordinary node spawn
  // and the only trace that the server had left oam was the warn line from the
  // connect that pinned it -- invisible to anyone reading a later reconnect,
  // and the exact question doctor output raises ("why is this on node?").
  let runtimeFields: Record<string, unknown> = {};
  if (attempt.oamRewriteApplied) {
    runtimeFields = disableOamRewrite
      ? { runtime: "node", downgradedFromOam: true }
      : { runtime: "oam", oamVersion: attempt.oamVersion };
  } else if (config.type === "local" && oamDowngradedNamespaces.has(config.namespace)) {
    runtimeFields = { runtime: "node", downgradedFromOam: true, oamPinned: true };
  }
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

    // Subscribe to upstream list changes so we pick up dynamic tools/resources/prompts.
    //
    // Registered BEFORE the initial inventory fetch, on purpose. When the
    // three setNotificationHandler calls came after the fetches there was a
    // window -- from connect() to the last fetch -- in which a
    // notifications/*/list_changed had no handler, and the SDK DROPS an
    // unhandled notification. An upstream that publishes a dynamic tool right
    // after initialize therefore left the inventory frozen at whatever the
    // initial fetch happened to see, until some later list_changed that may
    // never arrive. Registering first turns that drop into a queued refresh.
    //
    // Each handler serializes onto a per-category chain so two rapid
    // notifications from the same upstream can't race fetchXFromUpstream
    // in parallel. Without this, back-to-back ToolListChanged events
    // would launch two concurrent listTools() calls; whichever resolves
    // last wins connection.tools, and onListChanged fires twice (each
    // rebuilding routes). The chain preserves ordering and bounds
    // in-flight fetches to one per category.
    //
    // Every chain STARTS from chainsGate, which is resolved only once the
    // initial fetches have landed and the connection object is populated.
    // That gate is load-bearing twice over: a queued refresh must not race
    // the initial fetch it would otherwise clobber, and each handler body
    // writes connection.<category>, which does not exist until the
    // Object.assign below. On a FAILED connect the gate is never resolved,
    // so a queued refresh never fires against the client the catch closes.
    let releaseChains: () => void = () => {};
    const chainsGate = new Promise<void>((resolve) => {
      releaseChains = resolve;
    });

    if (onListChanged) {
      // A chain carries at most TWO steps: the one at its head (in flight, or
      // about to be) plus ONE queued behind it. Serializing alone did not
      // coalesce, so an upstream that fires a burst of list_changed -- a
      // gateway republishing its catalogue tool-by-tool -- queued one full
      // inventory fetch AND one downstream route rebuild per notification, all
      // of them fetching the same final state. Beyond the queued step the
      // notification is folded into it: the queued fetch has not started yet,
      // so it will observe the newest inventory anyway and nothing is lost.
      type RefreshState = { chain: Promise<void>; outstanding: number };
      const queueRefresh = (state: RefreshState, run: () => Promise<void>): Promise<void> => {
        if (state.outstanding >= 2) return state.chain;
        state.outstanding += 1;
        state.chain = state.chain.then(async () => {
          try {
            await run();
          } finally {
            state.outstanding -= 1;
          }
        });
        return state.chain;
      };

      const toolsRefresh: RefreshState = { chain: chainsGate, outstanding: 0 };
      const resourcesRefresh: RefreshState = { chain: chainsGate, outstanding: 0 };
      const promptsRefresh: RefreshState = { chain: chainsGate, outstanding: 0 };

      client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
        queueRefresh(toolsRefresh, async () => {
          try {
            connection.tools = await fetchToolsFromUpstream(client, config.namespace);
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh tools from upstream", { namespace: config.namespace, error: err.message });
          }
        }),
      );
      // throwOnError on all three refreshes: a failed fetch must leave the
      // PREVIOUS inventory standing. Without it the resources/prompts fetchers
      // return [] on any transport error or LIST_TIMEOUT, so one blip mid-
      // session assigned [] here, rebuilt routes off it, and made every
      // resource/prompt of a healthy server vanish from the client until some
      // future list_changed that may never arrive. The assignment is inside
      // the try precisely so the throw skips both it and onListChanged --
      // matching what the tools branch already gets for free from
      // fetchToolsFromUpstream's rethrow.
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        queueRefresh(resourcesRefresh, async () => {
          try {
            connection.resources = await fetchResourcesFromUpstream(client, config.namespace, { throwOnError: true });
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh resources from upstream", {
              namespace: config.namespace,
              error: err.message,
            });
          }
        }),
      );
      client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        queueRefresh(promptsRefresh, async () => {
          try {
            connection.prompts = await fetchPromptsFromUpstream(client, config.namespace, { throwOnError: true });
            onListChanged(config.namespace);
          } catch (err: any) {
            log("warn", "Failed to refresh prompts from upstream", {
              namespace: config.namespace,
              error: err.message,
            });
          }
        }),
      );
    }

    // allowMissingToolsCapability on the INITIAL fetch only: a resources-only
    // or prompts-only upstream answers tools/list with -32601, which is a
    // zero-tool server rather than a boot failure. The refresh path keeps the
    // throw -- see fetchToolsFromUpstream.
    const tools = await fetchToolsFromUpstream(client, config.namespace, { allowMissingToolsCapability: true });
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

    // Inventory in place and connection.<category> now exists -- release any
    // refresh that queued during the connect/fetch window.
    releaseChains();

    return connection;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    // Everything raised inside this try happens AFTER a successful handshake --
    // the closedBeforeReady guard above and the tools/list rethrow both land
    // here -- and a child that died mid-fetch has usually said why on stderr.
    // withStderrTail attaches (and redacts) that tail, so the credential
    // elicitation and the oam heap-cap hint get the same input they would have
    // had if the child had died a moment earlier, before the handshake.
    //
    // The message itself is redacted FIRST, and separately: withStderrTail
    // scrubs only the tail it appends and returns the error untouched when
    // there is no tail -- which is always, on a remote. Without this the
    // response body of a post-handshake failure reached the log and the model
    // verbatim, carrying whatever header the far end echoed back.
    throw withStderrTail(redactActivationMessage(err, resolvedServerEnv), stderrRing, resolvedServerEnv);
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
 *  Four bounds keep a misbehaving server from holding activation hostage.
 *  Each page gets its own LIST_TIMEOUT via the caller's request options, so
 *  the page count is the only thing standing between one fetch and
 *  pages x LIST_TIMEOUT of wall time:
 *  - the fetch stops one page after the item cap is exceeded (the caller
 *    truncates there anyway, and the overshoot is what lets its truncation
 *    warning fire);
 *  - a page that returns zero items but still hands back a cursor ends the
 *    loop -- that shape is an empty-page dribble, not pagination;
 *  - a server that echoes back the cursor it was just sent (or hands back an
 *    empty one) ends the loop too: the next request would re-fetch the page
 *    just read, so every further round trip is a duplicate;
 *  - the page count is capped at MAX_LIST_PAGES, far below the item cap.
 *  The last three log a warning so the operator can see the early stop. */
async function fetchAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  cap: number,
  context: { namespace: string; endpoint: string },
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    // Appended one at a time rather than `all.push(...items)`: spreading a
    // single page of ~100k+ entries blows the argument limit and throws
    // RangeError, turning the documented log-and-truncate path for an absurd
    // inventory into a hard activation failure.
    for (const item of items) all.push(item);
    if (nextCursor === undefined || all.length > cap) return all;
    if (nextCursor.length === 0 || nextCursor === cursor) {
      // The server handed back the cursor it was just sent (or an empty one),
      // so the next request would return the SAME page: every further round
      // trip is a duplicate, and up to MAX_LIST_PAGES of them would be
      // concatenated into the inventory. Stop with what we have.
      log("warn", "Upstream repeated its pagination cursor; stopping pagination", {
        namespace: context.namespace,
        endpoint: context.endpoint,
        pagesFetched: page + 1,
        items: all.length,
      });
      return all;
    }
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
      // title / _meta forwarded for the same reason the tools fetcher below
      // forwards them (MCP 2025-06-18): the proxied resource must reach the
      // client with the display name and metadata the upstream published.
      title: r.title,
      description: r.description,
      mimeType: r.mimeType,
      _meta: r._meta as Record<string, unknown> | undefined,
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
      // Same MCP 2025-06-18 passthrough as the resources fetcher above.
      title: p.title,
      description: p.description,
      arguments: p.arguments as UpstreamPromptDef["arguments"],
      _meta: p._meta as Record<string, unknown> | undefined,
    }));
  } catch (err) {
    // Server may not support prompts — that's fine at connect time.
    if (!opts.throwOnError) return [];
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`"${namespace}" returned an error on prompts/list: ${message}`);
  }
}

/** JSON-RPC "Method not found" (-32601), matched on the numeric code rather
 *  than the message text: the SDK's McpError carries the code verbatim from
 *  the wire while the human-readable half is whatever the server chose to
 *  write, so text matching would both miss servers and catch tool errors that
 *  merely mention the phrase. */
function isMethodNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === -32601;
}

/** How a tools/list failure is reported. */
export interface FetchToolsOptions {
  /** INITIAL connect only: treat a -32601 from tools/list as a zero-tool
   *  server rather than a failed activation. A resources-only or prompts-only
   *  upstream (an McpServer with no tool registered) answers the method it
   *  never implemented that way, and failing activation on it made such a
   *  server impossible to load at all -- one wasted retry, one wasted oam->node
   *  respawn, then a down-ranked namespace whose resources and prompts were
   *  never proxied. NOT set on the list_changed refresh: returning [] there
   *  would clear a live inventory the caller's catch currently preserves, and
   *  a server that answered tools/list once does not stop implementing it. A
   *  server that DECLARES tools and then errors still fails, whatever the
   *  flag: only -32601 is forgiven. */
  allowMissingToolsCapability?: boolean;
}

export async function fetchToolsFromUpstream(
  client: Client,
  namespace: string,
  opts: FetchToolsOptions = {},
): Promise<UpstreamToolDef[]> {
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
    if (opts.allowMissingToolsCapability && isMethodNotFound(err)) {
      log("info", "Upstream does not implement tools/list; loading it as a zero-tool server", { namespace });
      return [];
    }
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
