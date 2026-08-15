import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { maybeAutoUpgrade } from "./auto-upgrade.js";
import { bundleActivateHint, CURATED_BUNDLES, matchBundles, topPartialBundles } from "./bundles.js";
import { formatShadowLine, installTargetForCli } from "./cli-shadows.js";
import { type ComplianceGrade, classifyGrade, parseMinCompliance, passesMinCompliance } from "./compliance.js";
import { loadYawMcpConfig, type Profile, profileAllows, toProfile } from "./config-loader.js";
import { estimateFromConnectedTools, estimateFromToolCache, formatCostLabel } from "./cost-estimate.js";
import { detectMissingCredentials } from "./credentials.js";
import { formatRelativeAge, scanShellHistoryForShadows } from "./doctor-cmd.js";
import { classifyError } from "./error-category.js";
import {
  collectRefDeps,
  type ExecStepInput,
  RefError,
  resolveArgs,
  stepBindingKey,
  validateExecRequest,
} from "./exec-engine.js";
import { appendFoundryTrace, isFoundryEnabled, redactIntent } from "./foundry.js";
import { closestNames } from "./fuzzy.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import { type LoadedGuides, loadGuides, renderGuide } from "./guide.js";
import { type ActivationFailure, formatHealthWarning, healthFactor } from "./health-score.js";
import { adaptiveThreshold, HISTORY_LIMIT, pushToolCall, type ToolCallRecord } from "./idle-ttl.js";
import { INSTALL_NUDGE_MIN_COUNT, installNudgeEnabled, recordNudge, shouldNudge } from "./install-nudge.js";
import { LearningStore } from "./learning.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { computeSecretsReport, META_TOOL_NAMES, META_TOOLS } from "./meta-tools.js";
import { PackDetector } from "./pack-detect.js";
import { isPersistenceDisabled, loadState, type PersistedToolCacheEntry, saveState } from "./persistence.js";
import { createProgressReporter, type ProgressReporter } from "./progress.js";
import {
  type BuiltinResource,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  type PromptRoute,
  type ResourceRoute,
  routePromptGet,
  routeResourceRead,
  routeToolCall,
  type ToolExposure,
  type ToolRoute,
} from "./proxy.js";
import { type Content, pruneContent } from "./prune.js";
import { findTool, formatReadToolOutput, formatToolNotFound, normalizeToolName } from "./read-tool.js";
import { RedispatchTracker } from "./redispatch.js";
import { type RankableServer, rankServers, tokenize } from "./relevance.js";
import { computeOutcomeReward } from "./reward.js";
import {
  firstResultText,
  type GraderContext,
  gradeOutcomeViaSampling,
  isRewardGraderEnabled,
  isUncertainReward,
} from "./reward-grader.js";
import {
  bestOfNViaSampling,
  buildCandidates,
  parseRouteEffort,
  sampleCountForEffort,
  shouldSample,
} from "./sampling-rank.js";
import { listKeys, loadVault, vaultPath } from "./secrets-vault.js";
import { evaluateServerCap, type LoadedSlot, resolveServerCap } from "./server-cap.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "./upstream.js";
import { buildCoUsageMap, formatReliabilityWarning, formatUsageHint, selectFlakyNamespaces } from "./usage-hints.js";
import { ensureUv } from "./uv-bootstrap.js";

declare const __VERSION__: string;

// The YAW_MCP_DISABLE_PERSISTENCE opt-out lives in persistence.ts (the module
// it disables) and is imported above. This file used to define its own copy;
// the shared one reads process.env by default, which is exactly what the call
// site below wants.

// Current minimum compliance filter, parsed from YAW_MCP_MIN_COMPLIANCE.
// Re-read on every call so tests can stub the env between cases. Null
// means "filter disabled" — every server passes regardless of grade.
// Invalid values log a one-shot warning (see parseMinCompliance) and
// fall back to disabled so a typo never hides the user's whole catalog.
export function resolveMinCompliance(): ComplianceGrade | null {
  return parseMinCompliance(process.env.YAW_MCP_MIN_COMPLIANCE);
}

// Human-readable reason a server is refused under a compliance floor.
// passesMinCompliance returns a single boolean for both "unrecognized
// grade" and "recognized grade below the minimum", so a naive message
// would call an unrecognized "Pass" grade "below B". classifyGrade
// splits the two so the refusal names the real problem. Ungraded servers
// never reach here (they pass the floor).
function complianceRefusalReason(grade: string | undefined | null, min: ComplianceGrade): string {
  const c = classifyGrade(grade);
  if (c.kind === "unrecognized") {
    return `unrecognized compliance grade "${c.raw}" (not A-F); failing closed under YAW_MCP_MIN_COMPLIANCE=${min}`;
  }
  return `compliance grade ${grade ?? "unknown"} is below YAW_MCP_MIN_COMPLIANCE=${min}`;
}

// Opt-in auto-load. Set YAW_MCP_AUTO_LOAD=1 (or "true") to pre-activate the
// top recurring pack from persisted history on startup — no LLM round
// trip required. Default off: auto-activation normally rides on an
// explicit discover() call (see YAW_MCP_AUTO_ACTIVATE). This is for users
// who know their workflow starts the same way every session and want
// to skip the discover step entirely.
export function isAutoLoadEnabled(): boolean {
  const raw = process.env.YAW_MCP_AUTO_LOAD;
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

// How much of the catalog tools/list advertises. Gateway by default -- see
// ToolExposure in proxy.ts for the measurement that made it the default.
// YAW_MCP_TOOL_EXPOSURE=full restores the previous behavior for a client that
// genuinely wants the whole catalog inlined. Re-read per call, same discipline
// as resolveMinCompliance, so a mid-session change lands on the next
// tools/list instead of needing a restart.
export function resolveToolExposure(): ToolExposure {
  const raw = process.env.YAW_MCP_TOOL_EXPOSURE?.trim().toLowerCase();
  if (raw === "full") return "full";
  if (raw === undefined || raw === "" || raw === "gateway") return "gateway";
  // Unknown value: an operator who mistyped should not silently get the
  // 27,000-token surface back.
  log("warn", `unrecognized YAW_MCP_TOOL_EXPOSURE "${raw}"; using "gateway"`, { raw });
  return "gateway";
}

// Baseline number of non-matching tool calls a namespace tolerates before
// the idle reaper unloads it. adaptiveThreshold() (idle-ttl.ts) stacks a
// per-namespace bonus on top of this and clamps the result to [5, 50].
export const DEFAULT_IDLE_CALL_THRESHOLD = 10;

// Live idle-threshold baseline. YAW_MCP_IDLE_THRESHOLD is the current
// name; MCP_CONNECT_IDLE_THRESHOLD is the pre-rename spelling and stays
// honored as a fallback so existing setups keep working. Re-read on every
// call (same discipline as resolveMinCompliance / isAutoActivateEnabled)
// rather than latched in a static initializer, so a mid-session env change
// — or a test stubbing the env between cases — takes effect immediately.
// A non-numeric or <1 value falls back to the default instead of
// silently disabling the reaper.
export function resolveIdleThreshold(): number {
  // An empty value counts as unset for BOTH names, so `YAW_MCP_IDLE_THRESHOLD=`
  // falls through to the legacy spelling rather than swallowing it.
  const current = process.env.YAW_MCP_IDLE_THRESHOLD;
  const raw = current !== undefined && current !== "" ? current : process.env.MCP_CONNECT_IDLE_THRESHOLD;
  if (!raw) return DEFAULT_IDLE_CALL_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_IDLE_CALL_THRESHOLD;
}

// Auto-warm gate for discover(context): when one candidate clearly wins,
// activate it in the same call instead of making the LLM follow up with an
// explicit activate. Default ON; set YAW_MCP_AUTO_ACTIVATE=0 to disable.
// Re-read on every call (same discipline as resolveMinCompliance /
// isAutoLoadEnabled) so a mid-session env change -- or a test stubbing the
// env between cases -- takes effect without restarting the process.
export function isAutoActivateEnabled(): boolean {
  const raw = process.env.YAW_MCP_AUTO_ACTIVATE;
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw.toLowerCase() === "true";
}

// Marker phrases that identify an INTERNAL routing/cache fault rather than
// a genuine upstream failure. handleExec substring-matches an errored
// step's text against these to decide whether to sink the namespace's
// reliability score, so the phrases MUST stay byte-identical between the
// message that produces them and the check that reads them -- hence the
// shared constants instead of two copies of a string literal.
// TOOL_GONE / RECONNECT_FAILED are emitted by handleToolCall below;
// DISCONNECTED / UNKNOWN_TOOL are emitted by routeToolCall in proxy.ts
// (see the guard test in tests/server.test.ts that pins those two).
export const ROUTING_FAULT_TOOL_GONE = "no longer available";
export const ROUTING_FAULT_DISCONNECTED = "no longer connected";
export const ROUTING_FAULT_RECONNECT_FAILED = "auto-reconnect failed";
export const ROUTING_FAULT_UNKNOWN_TOOL = "Unknown tool:";
export const ROUTING_FAULT_MARKERS: readonly string[] = [
  ROUTING_FAULT_TOOL_GONE,
  ROUTING_FAULT_DISCONNECTED,
  ROUTING_FAULT_RECONNECT_FAILED,
  ROUTING_FAULT_UNKNOWN_TOOL,
];

/** True when an error text came from yaw-mcp's own routing layer (stale
 *  toolCache, dropped connection, failed auto-reconnect, unknown tool)
 *  rather than from the upstream server itself. */
export function isRoutingFaultText(text: string): boolean {
  return ROUTING_FAULT_MARKERS.some((marker) => text.includes(marker));
}

/** Namespaces from an activate/deactivate meta-tool args bag. `servers`
 *  (array) wins over the single `server` form; empty when neither is
 *  usable. Exported so tests exercise the real resolver, not a copy. */
export function resolveNamespaces(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.servers)) {
    // Filter to non-empty strings before trusting the array — the raw
    // value is untyped tool input, so a `servers: [1, null, ""]` bag must
    // not flow through as namespaces. Mirrors the `tools` filter in
    // handleToolCall. A present-but-all-invalid array falls through to the
    // single `server` form, and an all-invalid bag yields no namespaces.
    const filtered = args.servers.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (filtered.length > 0) return filtered;
  }
  if (typeof args.server === "string" && args.server) {
    return [args.server];
  }
  return [];
}

/** Shallow value-equality for two env maps (undefined == undefined). */
export function envEqual(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function argsEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * True if `p` settled within `ms`, false if the budget expired first.
 * Never rejects — the caller only wants to know whether to keep waiting.
 * The timer is cleared on the fast path and unref'd on the slow one, so a
 * bounded wait can neither leak a handle nor hold an embedded host's event
 * loop open past the wait itself.
 */
export function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === "function") timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}

// Tokenizer for the discover "matches" summary. Mirrors relevance.ts's
// split-on-non-alphanumeric behavior so the summary's per-tool match
// logic lines up with BM25's ranking logic. Kept local rather than
// exported from relevance.ts because the MIN_TOKEN_LEN of 3 used
// there would drop short but meaningful query words like "pr" / "ci"
// here — the summary is cosmetic, so a looser threshold is fine.
function tokenizeForSummary(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2),
  );
}

// Detect tools with the same BARE name across multiple currently-connected
// servers. Dormant or disconnected namespaces don't count — we don't have
// their live tool schemas and can't be certain they'd collide. Returns
// entries sorted by namespace count desc, tie-break by bare-name asc;
// each entry's `namespaces` array is alphabetically sorted for stable output.
// Exported for unit tests.
export function computeToolOverlaps(
  connections: Iterable<UpstreamConnection>,
): Array<{ bareName: string; namespaces: string[] }> {
  const byName = new Map<string, Set<string>>();
  for (const conn of connections) {
    if (conn.status !== "connected") continue;
    const ns = conn.config.namespace;
    for (const tool of conn.tools) {
      let set = byName.get(tool.name);
      if (!set) {
        set = new Set<string>();
        byName.set(tool.name, set);
      }
      set.add(ns);
    }
  }
  const overlaps: Array<{ bareName: string; namespaces: string[] }> = [];
  for (const [bareName, nsSet] of byName) {
    if (nsSet.size < 2) continue;
    overlaps.push({ bareName, namespaces: [...nsSet].sort() });
  }
  overlaps.sort((a, b) => {
    if (b.namespaces.length !== a.namespaces.length) return b.namespaces.length - a.namespaces.length;
    return a.bareName.localeCompare(b.bareName);
  });
  return overlaps;
}

export class ConnectServer {
  private server: Server;
  private connections = new Map<string, UpstreamConnection>();
  private config: ConnectConfig | null = null;
  private configVersion: string | null = null;
  private toolRoutes = new Map<string, ToolRoute>();
  private resourceRoutes = new Map<string, ResourceRoute>();
  private promptRoutes = new Map<string, PromptRoute>();
  private idleCallCounts = new Map<string, number>();
  // Rolling history of recent tool calls (namespace + timestamp) used to
  // compute the adaptive idle threshold per-namespace. Bounded to
  // HISTORY_LIMIT entries so long sessions don't grow memory unbounded.
  private recentToolCalls: ToolCallRecord[] = [];
  // Track which namespaces have already had their adaptive-patience
  // skip logged this session — we only want the "see the mechanism in
  // action" log once per namespace, not every single idle tick.
  private adaptiveSkipLogged = new Set<string>();
  // Tool lists learned from a live upstream handshake, keyed by namespace.
  // Hydrated from ~/.yaw-mcp/state.json at start() and re-written there
  // whenever a server's tools are learned, so a fresh session already knows
  // what an inactive server offers: getDeferredServers() can surface its
  // tools cold, and prewarmDormantServers() skips re-spawning it. Before
  // this was persisted, every session re-spawned every active server.
  private toolCache = new Map<string, Array<{ name: string; description?: string }>>();
  // When each namespace's toolCache entry was learned. Carried through the
  // persistence round-trip so a hydrated entry keeps its original age and
  // still ages out under the TTL rather than being refreshed for free on
  // every save.
  private toolCacheLearnedAt = new Map<string, number>();
  // Per-namespace tool filters set by mcp_connect_activate({ tools: [...] }).
  // When a namespace has an entry, only those BARE tool names surface in
  // tools/list; routing tables stay complete so mcp_connect_dispatch can
  // still reach unlisted tools. Cleared on activate-without-tools of the
  // same namespace, on deactivate, and on config reconcile.
  private toolFilters = new Map<string, Set<string>>();
  // Namespaces the CLIENT explicitly activated this session. In gateway mode
  // (the default) this is the entire surface tools/list advertises beyond the
  // meta-tools. Deliberately NOT the same question as "is it connected":
  // prewarmDormantServers spawns dormant servers on its own, so keying on
  // connectedness would re-advertise the whole catalog and defeat the mode.
  // Session-scoped on purpose -- it is not persisted, so a new session starts
  // at the meta-tools again and the client re-asks for what it needs.
  private sessionActivated = new Set<string>();
  private profile: Profile | null = null;
  // Shadow-driven install-nudge gate. Resolved once at start() from the
  // env override (YAW_MCP_INSTALL_NUDGE=1) OR config (installNudge: true);
  // off by default. When false, discover NEVER runs the shell-history scan
  // and its output is byte-identical to today (the load-bearing privacy
  // property). See install-nudge.ts. Stays false in unit tests that skip
  // start(), so the nudge block is opt-in there too.
  private installNudge = false;
  // home / env used by the install-nudge shell-history scan. Default to the
  // real process values; overridable so tests can point the scan at a
  // synthetic home + stubbed env without touching the developer's real
  // shell history or ~/.yaw-mcp/ state file.
  private nudgeHome: string = homedir();
  private nudgeEnv: NodeJS.ProcessEnv = process.env;
  // Loaded YAW-MCP.md guides (user-global + project-local). Null until
  // start() has run the loader; fail-open if either file is missing,
  // unreadable, or empty.
  private guides: LoadedGuides = { user: null, project: null };
  // Tracks whether the client has actually READ `yaw-mcp://guide` this
  // session. meta-tools.ts uses this to fire a one-shot nudge in the
  // next tool response reminding the client to read the guide — but
  // only if (a) at least one guide is present and (b) the client
  // hasn't read it yet. Cleared on startup; no persistence.
  private guideRead = false;
  // One-shot latch for the guide nudge. Flips true the first time a
  // meta-tool response includes the nudge, so we don't spam the same
  // hint on every subsequent call — the client had its chance.
  private guideNudgeFired = false;
  // Short-term memory of activation failures; used by dispatch to
  // down-rank recently-flaky servers. Cleared on successful activation.
  private activationFailures = new Map<string, ActivationFailure>();
  // Session-scoped credential overrides supplied by the user via MCP
  // elicitation when a server's stderr indicated a missing env var.
  // Cleared on shutdown — persistence belongs in the Yaw MCP
  // bundles.json, these are a "get me running now" shortcut.
  private elicitedEnv = new Map<string, Record<string, string>>();
  // In-flight activation promises, keyed by namespace. Dedupes
  // concurrent activation attempts for the same namespace so that two
  // tool calls landing on a disconnected upstream don't each spawn
  // their own child process. Second and subsequent callers await the
  // same promise as the first; the entry is cleared when the promise
  // settles (success or failure).
  private activationInflight = new Map<
    string,
    Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }>
  >();
  // Tracks namespaces whose current activationInflight was initiated by
  // prewarmDormantServers. An explicit mcp_connect_activate clears the
  // namespace from this set, which prevents prewarm from disconnecting a
  // connection the user just claimed. Without this, the prewarm race is:
  //   1. prewarm activateOne("foo") -> inflight P1
  //   2. user activateOne("foo") -> joins P1 (same promise)
  //   3. P1 resolves ok=true for both callers
  //   4. prewarm disconnects "foo" — user's next tool call fails
  // With this set: prewarm only disconnects when the namespace was NOT
  // claimed by an explicit activate while P1 was in flight.
  private prewarmNamespaces = new Set<string>();
  // Slot reservations for the concurrent-server cap. A namespace is added
  // here synchronously (before the first `await connectToUpstream`) once it
  // clears the cap check, and removed when its activation settles. Counting
  // these pending reservations alongside connected servers closes a TOCTOU
  // gap: two DISTINCT namespaces activating concurrently would otherwise
  // both pass the cap check against the same connected set and overshoot
  // YAW_MCP_SERVER_CAP. Distinct from activationInflight (which dedupes
  // repeat activations of the SAME namespace) — this bounds the TOTAL count.
  private pendingActivations = new Set<string>();
  // Per-namespace count of tool calls currently awaiting an upstream
  // response. Incremented immediately before routeToolCall and decremented
  // in a finally, so it is accurate across concurrent calls. Read by
  // trackUsageAndAutoDeactivate: the idle reaper runs on OTHER calls'
  // completions, so without this a long call to B can be killed mid-flight
  // by a burst of short calls to A (and then booked as B's failure).
  private inflightCalls = new Map<string, number>();
  // Latched by shutdown() before it drains anything. activateOne refuses
  // while set, so a connection can't be registered into this.connections
  // after the teardown snapshot and leak a live child process.
  private shuttingDown = false;
  // Usage learning — nudges dispatch toward namespaces that have been
  // genuinely useful. Counts persist across yaw-mcp restarts via state.json
  // (see persistence.ts). YAW_MCP_DISABLE_PERSISTENCE=1 makes it session
  // -scoped only. See learning.ts.
  private readonly learning = new LearningStore();
  // Session-scoped chain detection — watches proxied tool calls across
  // namespaces and surfaces recurring multi-server patterns as suggested
  // "packs". Observation-only; never activates anything. Meta-tool calls
  // are deliberately excluded because they aren't user workflow.
  private readonly packDetector = new PackDetector();
  // Session-scoped re-dispatch tracking — watches for the model abandoning
  // one server and re-routing a similar intent to another, which is
  // evidence the first route was wrong. Feeds a negative learning signal
  // (LearningStore.recordMiss). Not persisted: a re-dispatch window that
  // spans a restart is meaningless. See redispatch.ts.
  private readonly redispatch = new RedispatchTracker();
  // Last dispatch intent per namespace (session-scoped, not persisted). Lets
  // the optional reward grader (reward-grader.ts) judge a tool call against the
  // goal the server was routed for. Bounded by the number of namespaces.
  private readonly lastIntentByNamespace = new Map<string, string>();

  // Short-TTL dedup cache for discover output. Agents often call
  // discover twice in quick succession (e.g. once to list, again after
  // a failed activate) — the second call returns the same text if
  // nothing has changed. Keyed on (configVersion, context, autoWarmed,
  // active-namespace-set) so activate/deactivate naturally invalidates.
  private discoverCache: {
    key: string;
    result: { content: Array<{ type: string; text: string }> };
    expires: number;
  } | null = null;
  private static readonly DISCOVER_CACHE_TTL_MS = 3000;

  // Baseline idle-call threshold lives in resolveIdleThreshold() (module
  // scope, re-read per call) rather than in a static initializer here: a
  // static latches the env at import, which is exactly the pattern the
  // isAutoActivateEnabled comment above calls out as the one to avoid.

  // Concurrent-load ceiling. See server-cap.ts — checked in
  // runActivateOne before a new upstream is spawned so we refuse at
  // the door instead of over-inflating the LLM's context. Instance
  // field (not static) so tests can override per-instance without
  // poisoning other instances or re-importing the module.
  private serverCap = resolveServerCap();

  // Cross-session persistence state (learning + pack history).
  // `persistenceReady` gates the save path so unit tests — which
  // never call start() — don't write to ~/.yaw-mcp/state.json. The
  // debounced timer collapses bursts of record*/recordCall into a
  // single write; flushed synchronously on shutdown.
  private persistenceReady = false;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_SAVE_DEBOUNCE_MS = 1000;

  // How long shutdown() will wait for in-flight activations before it
  // stops caring and tears down anyway. Sized against index.ts's 10s
  // force-exit timer — see the drain comment in shutdown() for the
  // arithmetic.
  private static readonly SHUTDOWN_DRAIN_MS = 2000;

  constructor() {
    this.server = new Server(
      { name: "yaw-mcp", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
      },
    );
    // yaw-mcp itself does not handle elicitation or sampling requests; it
    // originates them. The capability declaration for originated features
    // is implicit -- the client advertises whether IT supports receiving
    // them, which we check via getClientCapabilities() before prompting.
    this.setupHandlers();
  }

  // Builtin resources served directly by yaw-mcp (not proxied from an
  // upstream). Today: just `yaw-mcp://guide`. Rebuilt each request so the
  // list reflects the latest loaded guides — start() populates
  // `this.guides` once, but tests and future hot-reload code paths may
  // mutate it, and the cost of rebuilding is negligible.
  private getBuiltinResources(): BuiltinResource[] {
    const body = renderGuide(this.guides, this.getProfiledActiveServers());
    if (!body) return [];
    return [
      {
        uri: "yaw-mcp://guide",
        name: "yaw-mcp guide",
        description:
          "Project + user guidance from YAW-MCP.md. Read this to learn how THIS user/project routes MCP work (which servers to prefer, where credentials live, gotchas).",
        mimeType: "text/markdown",
        read: () => {
          // Flip the session flag — the meta-tools one-shot nudge keys
          // off this so we only remind the client to read the guide if
          // they haven't yet. Re-render at read time so the auto
          // "Active servers" section reflects the current connection
          // set, not the one at list time.
          this.guideRead = true;
          const text = renderGuide(this.guides, this.getProfiledActiveServers()) ?? "";
          return { contents: [{ uri: "yaw-mcp://guide", text, mimeType: "text/markdown" }] };
        },
      },
    ];
  }

  private getBuiltinResourceMap(): Map<string, BuiltinResource> {
    const map = new Map<string, BuiltinResource>();
    for (const b of this.getBuiltinResources()) map.set(b.uri, b);
    return map;
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildToolList(
        this.connections,
        this.getDeferredServers(),
        this.toolFilters,
        resolveToolExposure(),
        this.sessionActivated,
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      return this.handleToolCall(name, args ?? {}, extra);
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: buildResourceList(
        this.connections,
        this.getBuiltinResources(),
        resolveToolExposure(),
        this.sessionActivated,
      ),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return routeResourceRead(request.params.uri, this.resourceRoutes, this.connections, this.getBuiltinResourceMap());
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: buildPromptList(this.connections, resolveToolExposure(), this.sessionActivated),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return routePromptGet(
        request.params.name,
        request.params.arguments as Record<string, string> | undefined,
        this.promptRoutes,
        this.connections,
      );
    });
  }

  private readonly onUpstreamDisconnect = (ns: string) => {
    log("warn", "Upstream disconnected, will auto-reconnect on next use", { namespace: ns });
  };

  private readonly onUpstreamListChanged = (ns: string) => {
    log("info", "Upstream list changed, rebuilding routes", { namespace: ns });
    this.refreshRoutesAndNotify().catch((err: Error) => {
      // Logged rather than silenced — a failure here means the client
      // won't know tools/resources/prompts just changed, which cascades
      // into confusing "unknown tool" errors on the next call. Worth
      // surfacing so the failure isn't invisible.
      log("warn", "Failed to notify client of upstream list change", {
        namespace: ns,
        error: err?.message ?? String(err),
      });
    });
  };

  private rebuildRoutes(): void {
    this.toolRoutes = buildToolRoutes(this.connections, this.getDeferredServers());
    this.resourceRoutes = buildResourceRoutes(this.connections);
    this.promptRoutes = buildPromptRoutes(this.connections);
  }

  // The obligatory pair after ANY change to the connected set: rebuild the
  // routing tables, then tell the client its lists moved. Every activation
  // and deactivation site funnels through here because doing only half of
  // it is the bug that keeps recurring — a namespace lands in
  // this.connections while toolRoutes still holds its `deferred` entry, so
  // the next tools/call takes the deferred branch, finds the server already
  // connected (isChanged:false), and returns the misleading "no longer
  // available after loading X" error with no way for the model to recover.
  private async refreshRoutesAndNotify(): Promise<void> {
    this.rebuildRoutes();
    await this.notifyAllListsChanged();
  }

  // Active servers, narrowed by the project profile if one is loaded.
  // Centralizing this here means discover/dispatch/auto-warm all see the
  // same set — no accidental bypass of the profile via a second code path.
  // The merge in mergeToolCache feeds the in-memory toolCache (hydrated
  // from state.json at startup, updated as servers activate) into each
  // server so callers like formatShadowLine can see learned tools.
  // bundles.json doesn't carry toolCache (validateEntry's fixed whitelist
  // drops it), and without this merge the tool-prefix heuristic in
  // resolveShadowedClis is inert on a real run — see the KNOWN_CLI_PREFIXES
  // comment in cli-shadows.ts.
  private getProfiledActiveServers(): UpstreamServerConfig[] {
    const all = (this.config?.servers ?? []).filter((s) => s.isActive);
    const profiled = this.profile ? all.filter((s) => profileAllows(this.profile, s.namespace)) : all;
    return profiled.map((server) => this.mergeToolCache(server));
  }

  // Configured-but-not-currently-connected servers that have a persisted
  // toolCache. Fed into buildToolList/buildToolRoutes so the LLM can see
  // their tools in tools/list before activation; first tools/call on any
  // of those tools triggers lazy activation via activateOne in
  // handleToolCall. Merges in any in-session toolCache (this.toolCache)
  // that hasn't yet been persisted to bundles.json, so recently-used
  // servers that got idle-evicted still appear as deferred.
  private getDeferredServers(): UpstreamServerConfig[] {
    const out: UpstreamServerConfig[] = [];
    for (const server of this.getProfiledActiveServers()) {
      if (this.connections.has(server.namespace)) continue;
      if (!server.toolCache || server.toolCache.length === 0) continue;
      out.push(server);
    }
    return out;
  }

  // Return `server` with its in-memory toolCache applied. The in-memory
  // entry (this.toolCache) wins over server.toolCache when both exist —
  // the persisted copy can be stale relative to a fresh activation, and
  // the in-memory map is what tools/list and formatShadowLine should
  // actually see.
  //
  // Identity preservation: when both sides resolve to the same array
  // reference — which in practice means BOTH are undefined (server.ts
  // has no toolCache and this.toolCache has no entry for this namespace)
  // — we return `server` unchanged. The `===` guard pins that, so
  // downstream consumers keyed on reference equality (the identity-
  // preservation tests in server.test.ts) keep working. In production,
  // server.toolCache is almost always undefined: bundles.json validation
  // drops the field (local-bundles.ts), and hydrateToolCache (below)
  // writes the persisted array into this.toolCache rather than back into
  // server.toolCache. So the commonly-fired path is the
  // "spread a clone" branch — the identity guard mostly catches the
  // dormant-namespace case.
  private mergeToolCache(server: UpstreamServerConfig): UpstreamServerConfig {
    const sessionCache = this.toolCache.get(server.namespace);
    const cache = sessionCache && sessionCache.length > 0 ? sessionCache : server.toolCache;
    return cache === server.toolCache ? server : { ...server, toolCache: cache };
  }

  // Does this server's tool list already exist somewhere we trust — the
  // toolCache shipped in bundles.json, or the one we learned in a previous
  // session and hydrated from state.json? Gates pre-warm: a `false` here
  // means the only way to find out what the server offers is to spawn it.
  private hasKnownTools(server: UpstreamServerConfig): boolean {
    if (server.toolCache && server.toolCache.length > 0) return true;
    const cached = this.toolCache.get(server.namespace);
    return cached !== undefined && cached.length > 0;
  }

  // Seed the in-memory tool cache from the persisted snapshot. Runs before
  // reconcileConfig so the first tools/list of the session can already
  // include deferred servers' tools. Entries for namespaces no longer in
  // bundles.json are harmless — every reader iterates the CONFIGURED
  // servers — and age out via the persistence-layer TTL.
  private hydrateToolCache(persisted: Record<string, PersistedToolCacheEntry>): void {
    let restored = 0;
    for (const [namespace, entry] of Object.entries(persisted)) {
      if (entry.tools.length === 0) continue;
      this.toolCache.set(namespace, entry.tools);
      this.toolCacheLearnedAt.set(namespace, entry.learnedAt);
      restored++;
    }
    if (restored > 0) log("info", "Restored learned tool lists", { namespaces: restored });
  }

  // Snapshot the in-memory tool cache for persistence. The persistence layer
  // owns the caps/TTL, so this just pairs each list with the timestamp it
  // was learned at (falling back to now for a list learned before the
  // timestamp map existed — belt-and-braces; runActivateOne always sets it).
  private exportToolCache(): Record<string, PersistedToolCacheEntry> {
    const out: Record<string, PersistedToolCacheEntry> = {};
    for (const [namespace, tools] of this.toolCache) {
      if (tools.length === 0) continue;
      out[namespace] = { tools, learnedAt: this.toolCacheLearnedAt.get(namespace) ?? Date.now() };
    }
    return out;
  }

  // Overlay the A-F grades `yaw-mcp audit` cached in ~/.yaw-mcp/grades.json
  // onto the loaded server list. That cache is the ONLY supplier of
  // `complianceGrade` in local mode — validateEntry drops unknown fields, so
  // a grade never rides along in bundles.json. Without this overlay every
  // server is permanently ungraded, which silently disables the
  // YAW_MCP_MIN_COMPLIANCE gate (ungraded always passes) and blanks the
  // `[A]`-`[F]` badge in discover. Mirrors the same overlay `yaw-mcp list`
  // applies (local-add-cmd.ts runList) so the CLI and the server agree.
  //
  // `home` is a parameter rather than a field so tests can point it at a
  // synthetic ~/.yaw-mcp without running the whole of start().
  private async hydrateComplianceGrades(home: string = homedir()): Promise<void> {
    if (!this.config) return;
    // readGradesCache never throws (missing/garbled cache -> {}), but the
    // catch keeps a surprise I/O rejection from aborting startup: an
    // unreadable grade cache must degrade to "ungraded", not to "no server".
    const grades: GradesCache = await readGradesCache(home).catch(() => ({}));
    if (Object.keys(grades).length === 0) return;
    let applied = 0;
    this.config.servers = this.config.servers.map((server) => {
      const cached = grades[server.namespace];
      if (!cached) return server;
      applied++;
      return { ...server, complianceGrade: cached.grade };
    });
    if (applied > 0) log("info", "Applied cached compliance grades", { graded: applied });
  }

  private async notifyAllListsChanged(): Promise<void> {
    // Each send is independent — one failure shouldn't cancel the
    // others. Log so the failure is visible without throwing, since
    // callers treat this as a fire-and-forget notification.
    await this.server.sendToolListChanged().catch((err: Error) => {
      log("warn", "sendToolListChanged failed", { error: err?.message ?? String(err) });
    });
    await this.server.sendResourceListChanged().catch((err: Error) => {
      log("warn", "sendResourceListChanged failed", { error: err?.message ?? String(err) });
    });
    await this.server.sendPromptListChanged().catch((err: Error) => {
      log("warn", "sendPromptListChanged failed", { error: err?.message ?? String(err) });
    });
  }

  async start(): Promise<void> {
    // Hydrate learning + pack-history state from ~/.yaw-mcp/state.json
    // before anything else so subsequent record* writes land on top of
    // the restored signal rather than replacing it. loadState() never
    // throws — missing/corrupt files yield an empty snapshot.
    //
    // YAW_MCP_DISABLE_PERSISTENCE=1 keeps `persistenceReady` false, which
    // silently no-ops both the debounced scheduleStateSave() and the
    // shutdown flush — the whole pathway disappears in one toggle.
    if (isPersistenceDisabled()) {
      log("info", "Cross-session persistence disabled via YAW_MCP_DISABLE_PERSISTENCE");
    } else {
      const persisted = await loadState();
      if (Object.keys(persisted.learning).length > 0 || persisted.packHistory.length > 0) {
        this.learning.loadSnapshot(persisted.learning);
        this.packDetector.loadSnapshot(persisted.packHistory);
        log("info", "Restored yaw-mcp state", {
          learningEntries: Object.keys(persisted.learning).length,
          packHistoryEntries: persisted.packHistory.length,
        });
      }
      this.hydrateToolCache(persisted.toolCache);
      this.persistenceReady = true;
    }

    // Load the effective config (allow/deny lists + the install-nudge flag)
    // from .yaw-mcp/config.* files. Walks up from cwd for a project-local
    // .yaw-mcp/ dir and also consults ~/.yaw-mcp/config.json (user-global).
    // Local beats project beats global for the allow-list; denies union.
    // Failure is silent — fail-open so a bad config doesn't brick the
    // session. One read here derives BOTH the profile and the nudge gate
    // (previously loadEffectiveProfile re-read the config just for the
    // profile slice).
    const resolvedConfig = await loadYawMcpConfig({ cwd: process.cwd() }).catch(() => null);
    this.profile = resolvedConfig ? toProfile(resolvedConfig) : null;
    if (this.profile) {
      log("info", "Loaded profile", {
        path: this.profile.path,
        userPath: this.profile.userPath,
        allow: this.profile.servers,
        block: this.profile.blocked,
      });
    }
    // Resolve the shadow-driven install-nudge gate once, from the env
    // override OR the resolved config flag (either enables it; off by
    // default). Gating here means a fresh load per session picks up a
    // config change on restart. When this stays false, buildDiscoverOutput
    // never runs the shell-history scan.
    this.installNudge = installNudgeEnabled(process.env, resolvedConfig);
    if (this.installNudge) {
      log("info", "Shadow-driven install nudge enabled");
    }

    // Load YAW-MCP.md guides (user-global + project-local). Fail-open:
    // loadGuides() swallows I/O errors internally, so the worst case
    // is `this.guides` stays { user: null, project: null } and the
    // `yaw-mcp://guide` builtin simply isn't listed.
    this.guides = await loadGuides(process.cwd()).catch(() => ({ user: null, project: null }));
    if (this.guides.user || this.guides.project) {
      log("info", "Loaded YAW-MCP.md guide", {
        user: this.guides.user?.path ?? null,
        project: this.guides.project?.path ?? null,
      });
    }

    // Load config from bundles.json -- the only config source. Non-fatal
    // errors allow startup with an empty config.
    const result = await loadLocalBundles({ cwd: process.cwd() }).catch((err: Error) => {
      log("warn", "loadLocalBundles failed; starting with empty config", { error: err?.message });
      return { config: null, path: null, warnings: [] };
    });
    for (const w of result.warnings) log("warn", "bundles.json warning", { warning: w });
    this.config = result.config ?? { servers: [], configVersion: "" };
    // Deduplicate by namespace -- keep first occurrence. reconcileConfig
    // and the routing state assume one server per namespace, so a
    // duplicate in bundles.json has to be filtered before either sees it.
    const seenNs = new Set<string>();
    this.config.servers = this.config.servers.filter((s) => {
      if (seenNs.has(s.namespace)) {
        log("warn", "Duplicate namespace in bundles.json, skipping", { namespace: s.namespace });
        return false;
      }
      seenNs.add(s.namespace);
      return true;
    });
    this.configVersion = this.config.configVersion;
    log("info", "Loaded bundles", {
      path: result.path,
      serverCount: this.config.servers.length,
    });
    // Overlay cached compliance grades BEFORE reconcile, so the routing
    // state and every downstream grade reader see the same graded config.
    await this.hydrateComplianceGrades();
    // Reconcile so the loaded servers populate the routing state.
    await this.reconcileConfig(this.config);

    // Prewarm the uv bootstrap if any configured server needs it. Fire
    // and forget — ensureUv() is memoized, so the first activation
    // awaits the same in-flight promise rather than triggering a
    // second download. This moves the 2–10s first-run cost off the
    // activation path (where it could collide with CONNECT_TIMEOUT)
    // and onto startup, where it's expected.
    if (this.config?.servers.some((s) => s.command === "uv" || s.command === "uvx")) {
      ensureUv().catch((err: Error) => log("warn", "uv prewarm failed", { error: err?.message }));
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Dormant servers (isActive but no persisted toolCache yet) are
    // invisible in tools/list because getDeferredServers() filters on
    // toolCache presence. That breaks the "I toggled it on in the
    // bundles.json and it disappeared" user experience. Pre-warm each one
    // in the background: activate → populate the in-memory toolCache
    // → disconnect so we're not holding 9 upstream processes idle.
    // Fire-and-forget so this doesn't gate transport readiness.
    this.prewarmDormantServers().catch((err: Error) => log("warn", "Pre-warm failed", { error: err?.message }));

    // Self-upgrade check: if this install is stale, upgrade it in the
    // background so the next client restart runs the latest version.
    // Fire-and-forget -- never awaited, never gates transport readiness.
    maybeAutoUpgrade().catch((err: Error) => log("warn", "Auto-upgrade check failed", { error: err?.message }));

    // Opt-in auto-load of the top recurring pack. Requires persistence
    // (so there IS a history to learn from) AND YAW_MCP_AUTO_LOAD=1. Runs
    // after prewarm so both paths see the same config snapshot; they're
    // independent (prewarm populates toolCache for newly-enabled
    // servers, this one spins up the recurring workflow's servers for
    // real). Fire-and-forget — startup shouldn't block on it.
    if (isAutoLoadEnabled() && this.persistenceReady) {
      this.autoLoadRecurringPack().catch((err: Error) => log("warn", "Auto-load failed", { error: err?.message }));
    }

    log("info", "yaw-mcp started", {
      servers: this.config?.servers.length ?? 0,
    });
  }

  // Auto-activate the single highest-ranked pack whose every namespace
  // is installed. Opt-in via YAW_MCP_AUTO_LOAD. Silent no-op when there's
  // no history or no matching pack — the value is "skip discover when
  // my workflow starts the same way every time," not "noisy on every
  // startup." Sequential activateOne (not parallel) so the cap logic
  // and dedup map see consistent state between loads.
  private async autoLoadRecurringPack(): Promise<void> {
    const installedNamespaces = new Set(this.getProfiledActiveServers().map((s) => s.namespace));
    if (installedNamespaces.size === 0) return;

    const chains = this.packDetector.detectChains();
    if (chains.length === 0) return;

    const candidates = chains
      .filter((pack) => pack.namespaces.every((ns) => installedNamespaces.has(ns)))
      .sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency;
        return b.lastSeenAt - a.lastSeenAt;
      });
    if (candidates.length === 0) return;

    const top = candidates[0];
    const loaded: string[] = [];
    const refused: { namespace: string; message: string }[] = [];
    for (const namespace of top.namespaces) {
      try {
        const result = await this.activateOne(namespace);
        if (result.ok) {
          loaded.push(namespace);
        } else {
          // activateOne returns ok:false on cap rejection, profile
          // refusal, "not installed", etc. -- not an exception path.
          refused.push({ namespace, message: result.message });
        }
      } catch (err) {
        refused.push({ namespace, message: (err as Error)?.message ?? "unknown error" });
      }
    }

    // Same obligation prewarm has: the namespaces we just activated are in
    // this.connections but toolRoutes still carries whatever start() built
    // (deferred entries, or nothing at all for a server with no toolCache).
    // Without this the first call on an auto-loaded tool takes the deferred
    // branch, sees the server already connected, and dead-ends on
    // "no longer available" — for a server that loaded fine seconds ago.
    if (loaded.length > 0) {
      await this.refreshRoutesAndNotify();
    }

    log("info", "Auto-loaded recurring pack", {
      loaded,
      refusedCount: refused.length,
      frequency: top.frequency,
    });
    if (refused.length > 0) {
      // Single aggregate warn so a SERVER_CAP=6 user with a 9-server
      // recurring pack gets one actionable line, not N silent ok:false
      // returns disappearing into the void.
      const message =
        loaded.length === 0
          ? "Auto-load could not activate any namespace in the pack"
          : "Auto-load could not activate every namespace in the pack";
      log("warn", message, {
        serverCap: this.serverCap,
        loadedCount: loaded.length,
        refused,
      });
    }
  }

  // Populate toolCache for any isActive server whose tools we don't know
  // yet, so Claude's tools/list shows the full toggled set on first run.
  // "Don't know yet" spans BOTH sources — the toolCache in bundles.json and
  // the one hydrated from state.json — so this is a one-time cost per
  // server rather than a per-session `npx -y <pkg>@latest` resolve for
  // every active server (which is what it degenerated into while the
  // learned cache had nowhere to persist).
  private async prewarmDormantServers(): Promise<void> {
    const dormant = this.getProfiledActiveServers().filter((s) => !this.hasKnownTools(s));
    if (dormant.length === 0) return;

    log("info", "Pre-warming dormant servers", {
      count: dormant.length,
      namespaces: dormant.map((s) => s.namespace),
    });

    const CONCURRENCY = 3;
    let anyPopulated = false;
    for (let i = 0; i < dormant.length; i += CONCURRENCY) {
      const batch = dormant.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (server) => {
          try {
            const result = await this.activateOne(server.namespace, undefined, /* fromPrewarm */ true);
            if (!result.ok) return;
            // Only disconnect if no explicit activate claimed this namespace
            // while the inflight promise was in flight. If an explicit activate
            // joined our shared promise, prewarmNamespaces will no longer
            // contain this namespace (activateOne with fromPrewarm=false clears
            // it), so we leave the connection alive for the user.
            if (!this.prewarmNamespaces.has(server.namespace)) {
              log("info", "Pre-warm skipping disconnect — namespace claimed by explicit activate", {
                namespace: server.namespace,
              });
              anyPopulated = true;
              return;
            }
            this.prewarmNamespaces.delete(server.namespace);
            // Immediately disconnect — the tool list is already in
            // this.toolCache, so getDeferredServers() surfaces the
            // server without us holding the upstream process alive.
            const conn = this.connections.get(server.namespace);
            if (conn) {
              await disconnectFromUpstream(conn).catch(() => {});
              // Re-read the map after the await and only drop the entry when
              // it is still OUR connection. disconnectFromUpstream marks the
              // old connection "disconnected" synchronously, so an explicit
              // activate that starts during the close sees a dead connection,
              // spawns a fresh child, and re-registers under the same key.
              // An unconditional delete here would orphan that child: live,
              // unreferenced, and invisible to shutdown().
              if (this.connections.get(server.namespace) === conn) {
                this.connections.delete(server.namespace);
                this.idleCallCounts.delete(server.namespace);
              }
            }
            anyPopulated = true;
          } catch (err) {
            log("warn", "Pre-warm of server failed", {
              namespace: server.namespace,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    }

    if (anyPopulated) {
      await this.refreshRoutesAndNotify();
    }
  }

  // One-shot nudge: if an YAW-MCP.md guide was loaded at startup but the
  // client hasn't read `yaw-mcp://guide` yet, append a short reminder to
  // the next meta-tool response. We only fire once per session — after
  // that the flag latches and we shut up. This is deliberately gentle
  // (a hint, not an error) because the guide is advisory; clients that
  // ignore it still work fine.
  private attachGuideNudge<T extends { content: Array<{ type: string; text: string }> }>(result: T): T {
    if (this.guideNudgeFired) return result;
    if (this.guideRead) return result;
    if (!this.guides.user && !this.guides.project) return result;
    this.guideNudgeFired = true;
    const sources = [this.guides.user?.path, this.guides.project?.path].filter(Boolean).join(", ");
    const text = `\n\n[yaw-mcp] Tip: read the \`yaw-mcp://guide\` resource for project-specific routing & credential guidance (from ${sources}). This hint appears once per session.`;
    // Clone before appending. Some callers hand us a result that is ALSO
    // held elsewhere -- buildDiscoverOutput stores its result in
    // discoverCache -- so mutating content in place would bake this
    // once-per-session hint into the cached body and replay it on every
    // cache hit for the rest of the TTL. Copy the array (and the one
    // element we rewrite) so the cached object is untouched.
    const content = [...result.content];
    const last = content[content.length - 1];
    if (last && last.type === "text") {
      content[content.length - 1] = { ...last, text: `${last.text}${text}` };
    } else {
      content.push({ type: "text", text: text.trimStart() });
    }
    return { ...result, content };
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    extra?: { sendNotification?: any; _meta?: Record<string, unknown> },
    // When deferLearning is set (exec steps), the proxy path does NOT record
    // the cross-session learning signal — handleExec records step-level,
    // cascading-blame credit instead so a failing consumer doesn't wrongly
    // sink the upstream that fed it.
    opts?: { deferLearning?: boolean },
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const progress = createProgressReporter(extra);
    if (name === META_TOOLS.discover.name) {
      // When the LLM supplies task context, automatically warm the top
      // confident candidate so a one-shot discover() is enough to start
      // calling tools. Ambiguous queries fall through to the manual list.
      return this.attachGuideNudge(await this.handleDiscoverWithAutoWarm(args.context as string | undefined, progress));
    }
    if (name === META_TOOLS.dispatch.name) {
      const intent = typeof args.intent === "string" ? args.intent : "";
      const budget = typeof args.budget === "number" && Number.isFinite(args.budget) ? args.budget : 1;
      // Per-call override of the routing effort dial (off|auto|aggressive);
      // falls back to YAW_MCP_ROUTE_EFFORT when absent. See sampling-rank.ts.
      const routeEffort = typeof args.routeEffort === "string" ? args.routeEffort : undefined;
      return this.attachGuideNudge(await this.handleDispatch(intent, budget, progress, routeEffort));
    }
    if (name === META_TOOLS.activate.name) {
      const namespaces = resolveNamespaces(args);
      // `tools` is only meaningful when activating a single server —
      // a flat list of bare names has no unambiguous mapping to a
      // multi-server call. For any other shape the filter is reset
      // (see handleActivate), matching the "activate without tools
      // clears the filter" rule.
      const toolsFilter =
        namespaces.length === 1 && Array.isArray(args.tools) && args.tools.every((t) => typeof t === "string")
          ? (args.tools as string[])
          : undefined;
      const result = await this.handleActivate(namespaces, progress, toolsFilter);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.deactivate.name) {
      const namespaces = resolveNamespaces(args);
      const result = await this.handleDeactivate(namespaces);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.health.name) {
      return this.attachGuideNudge(this.handleHealth());
    }
    if (name === META_TOOLS.read_tool.name) {
      const serverArg = typeof args.server === "string" ? args.server : "";
      const toolArg = typeof args.tool === "string" ? args.tool : "";
      const result = await this.handleReadTool(serverArg, toolArg, progress);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.suggest.name) {
      return this.attachGuideNudge(this.handleSuggest());
    }
    if (name === META_TOOLS.exec.name) {
      const result = await this.handleExec(args);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.bundles.name) {
      const action = args.action === "match" ? "match" : "list";
      return this.attachGuideNudge(this.handleBundles(action));
    }
    if (name === META_TOOLS.secrets.name) {
      const serverArg = typeof args.server === "string" ? args.server : undefined;
      return this.attachGuideNudge(await this.handleSecretsReport(serverArg));
    }

    // Snapshot routes at method entry. rebuildRoutes() may fire during
    // the auto-reconnect awaits below (via onUpstreamListChanged from
    // any other connection, or via trackUsageAndAutoDeactivate on a
    // concurrent tool call) and replace this.toolRoutes with a fresh
    // Map. Re-reading this.toolRoutes later would dispatch against a
    // map whose contents don't match the route we already captured —
    // so use the snapshot consistently from lookup through call.
    let routes = this.toolRoutes;
    let route = routes.get(name);

    // Deferred route: the server was advertised in tools/list from its
    // cached tool set but isn't connected yet. Activate now, rebuild
    // routes, notify the client that the list changed (so the real
    // inputSchema supersedes the placeholder), then re-dispatch through
    // the fresh routes. activateOne dedupes concurrent activations and
    // handles elicitation + retries.
    if (route?.deferred) {
      // Capture the namespace before the re-snapshot below reassigns
      // `route` (which can go undefined). The messages downstream must
      // name the namespace we activated, matching the reconnect path.
      const deferredNs = route.namespace;
      progress?.(`Loading "${deferredNs}" on first tools/call…`);
      const activation = await this.activateOne(deferredNs, progress);
      if (!activation.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Server "${deferredNs}" could not be loaded on first call: ${activation.message}`,
            },
          ],
          isError: true,
        };
      }
      // Rebuild unconditionally on a successful activation, NOT only when
      // isChanged. We got here holding a `deferred` route, so toolRoutes is
      // stale by construction; isChanged is false whenever the namespace was
      // already connected (auto-warmed by discover, loaded by dispatch, or
      // activated concurrently), and gating on it left the deferred entry in
      // place — which then fails the re-snapshot below with the misleading
      // "no longer available" error that no retry can clear.
      await this.refreshRoutesAndNotify();
      // Re-snapshot against fresh routes. If the upstream no longer
      // exposes a tool by this name (cache was stale), fall through to
      // the routes.get(name) miss path below with a clear message.
      routes = this.toolRoutes;
      route = routes.get(name);
      if (!route || route.deferred) {
        return {
          content: [
            {
              type: "text",
              text: `Tool "${name}" is ${ROUTING_FAULT_TOOL_GONE} after loading "${deferredNs}" — the upstream's tool set changed. Call mcp_connect_discover to list the current tools for that namespace.`,
            },
          ],
          isError: true,
        };
      }
    }

    if (route) {
      // Capture the namespace once: `route` is reassigned by the re-snapshot
      // below (and is captured in the .find closure), which widens it back to
      // Route | undefined for the rest of this block. The namespace being
      // reconnected is invariant across the re-snapshot, so a stable local
      // keeps the in-block references correctly typed.
      const ns = route.namespace;
      const conn = this.connections.get(ns);
      if (conn && conn.status === "error") {
        const serverConfig = this.config?.servers.find((s) => s.namespace === ns);
        if (serverConfig) {
          let reconnected = false;
          let lastErr: unknown;
          // Retry once with a 1s delay between attempts. Two attempts is
          // intentional (we don't want a slow upstream to stall a tool call
          // for a long time -- after this, surface the error and let the
          // user re-activate manually).
          const RECONNECT_ATTEMPTS = 2;
          const RECONNECT_DELAY_MS = 1000;
          for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
            try {
              await disconnectFromUpstream(conn);
              // Re-inject any session-elicited credentials for this namespace
              // before re-spawning — otherwise the reconnect uses the raw
              // configured env and re-trips the same missing-credential error
              // the user already supplied a value for this session.
              const elicitedForReconnect = this.elicitedEnv.get(ns);
              const reconnectConfig = elicitedForReconnect
                ? { ...serverConfig, env: { ...serverConfig.env, ...elicitedForReconnect } }
                : serverConfig;
              const newConn = await connectToUpstream(
                reconnectConfig,
                this.onUpstreamDisconnect,
                this.onUpstreamListChanged,
              );
              this.connections.set(ns, newConn);
              await this.refreshRoutesAndNotify();
              log("info", "Auto-reconnected to upstream", { namespace: ns });
              reconnected = true;
              // rebuildRoutes() replaced this.toolRoutes; re-snapshot so the
              // dispatch below routes against the fresh map, not the stale
              // one captured at method entry. If the reconnected upstream no
              // longer exposes a tool by this name (its tool set changed),
              // fall through to the same clear "no longer available" message
              // the deferred path emits above.
              routes = this.toolRoutes;
              route = routes.get(name);
              if (!route || route.deferred) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Tool "${name}" is ${ROUTING_FAULT_TOOL_GONE} after reconnecting "${serverConfig.namespace}" — the upstream's tool set changed. Call mcp_connect_discover to list the current tools for that namespace.`,
                    },
                  ],
                  isError: true,
                };
              }
              break;
            } catch (err) {
              lastErr = err;
              if (attempt < RECONNECT_ATTEMPTS - 1) {
                log("warn", "Auto-reconnect attempt failed, retrying", {
                  namespace: ns,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          if (!reconnected) {
            conn.status = "error";
            const lastErrMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
            log("error", "Auto-reconnect failed", { namespace: ns, error: lastErrMsg });
            return {
              content: [
                {
                  type: "text",
                  text: `Server "${ns}" disconnected and ${ROUTING_FAULT_RECONNECT_FAILED}: ${lastErrMsg}. Use mcp_connect_activate with server "${ns}" to reload it manually.`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    // Capture connection ref before the await to avoid race with config reconciliation
    const connForHealth = route ? this.connections.get(route.namespace) : undefined;

    // Mark the namespace busy for the duration of the upstream call. The
    // idle reaper (trackUsageAndAutoDeactivate) runs on OTHER calls'
    // completions, and this namespace's idle counter is only reset AFTER
    // this call returns — so without the marker a burst of short calls to A
    // can tip a slow, still-in-flight B over its threshold, close B's
    // transport, reject the user's pending call, and book the rejection as
    // B's own 0.0 reward.
    const callNamespace = route?.namespace;
    if (callNamespace !== undefined) {
      this.inflightCalls.set(callNamespace, (this.inflightCalls.get(callNamespace) ?? 0) + 1);
    }
    const startMs = Date.now();
    // Route against the snapshot, not this.toolRoutes, so a rebuild
    // between the initial lookup and this call can't misdirect us.
    let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
    try {
      result = await routeToolCall(name, args, routes, this.connections);
    } finally {
      if (callNamespace !== undefined) {
        const remaining = (this.inflightCalls.get(callNamespace) ?? 1) - 1;
        if (remaining > 0) this.inflightCalls.set(callNamespace, remaining);
        else this.inflightCalls.delete(callNamespace);
      }
    }
    const latencyMs = Date.now() - startMs;

    if (route) {
      if (connForHealth) {
        connForHealth.health.totalCalls++;
        connForHealth.health.totalLatencyMs += latencyMs;
        if (result.isError) {
          connForHealth.health.errorCount++;
          connForHealth.health.lastErrorMessage = result.content[0]?.text;
          connForHealth.health.lastErrorAt = new Date().toISOString();
        }
      }

      // Prune the response before it hits the LLM. Rules are
      // conservative (drop null / undefined / empty collections,
      // collapse runs of blank lines) so we trim obvious dead weight
      // without changing meaning. Disable with YAW_MCP_PRUNE_RESPONSES=0
      // if a caller needs the exact upstream bytes through.
      //
      // Error responses skip pruning entirely — the text IS the error
      // message, and stripping nulls or collapsing whitespace could
      // obscure it.
      if (!result.isError && Array.isArray(result.content)) {
        try {
          const pr = pruneContent(result.content as Content[]);
          // Only swap in the pruned body when it's actually smaller,
          // per the MIN_SAVINGS_RATIO check inside pruneContent.
          if (pr.bytesPruned < pr.bytesRaw) result.content = pr.content;
        } catch (err: any) {
          // Pruner should never throw; if it does, pass the upstream
          // content through untouched rather than failing the call.
          log("warn", "pruneContent failed", { error: err?.message });
        }
      }
      // Cross-session learning signal — GRADED, not binary. recordOutcome
      // records both the dispatch (denominator) and a quality-weighted
      // credit in [0,1]: a clean-but-empty or error-shaped 200 no longer
      // banks full credit (see reward.ts/computeOutcomeReward). This is the
      // ground truth that boostFactor + formatReliabilityWarning + the
      // cross-session reliability block in handleHealth all read — activation
      // success is deliberately NOT counted here (see handleDispatch). Exec
      // steps defer it (opts.deferLearning) for step-level attribution.
      if (!opts?.deferLearning) {
        const reward = computeOutcomeReward(result);
        this.learning.recordOutcome(route.namespace, reward);
        this.scheduleStateSave();
        // The learning counters feed discover's `usage:` / `reliability:`
        // lines, which the cache key doesn't cover — drop the memo so the
        // next discover reflects the call that just happened.
        this.invalidateDiscoverCache();
        // Optional LLM grader (opt-in, YAW_MCP_REWARD_GRADER): on the uncertain
        // heuristic bands only, ask the client LLM whether the call actually
        // accomplished the goal and revise the credit in the BACKGROUND. The
        // tool result is not held up -- the correction lands when the grade does.
        if (isRewardGraderEnabled() && isUncertainReward(reward)) {
          void this.refineRewardInBackground(route.namespace, reward, {
            intent: this.lastIntentByNamespace.get(route.namespace),
            toolName: route.originalName,
            resultText: firstResultText(result),
          });
        }
        // Re-dispatch routing-miss tracking: record whether the server the
        // model most recently dispatched to produced a clean reply. An
        // abandoned clean reply becomes a negative signal when a similar
        // intent later re-routes elsewhere (detectMiss in handleDispatch).
        this.redispatch.markReply(route.namespace, !result.isError);
      }

      // Only count successful calls toward chain detection. An errored
      // call isn't a real usage signal — the user likely abandons or
      // retries on a different server. Meta-tools were short-circuited
      // above so they never reach this point.
      if (!result.isError) {
        this.packDetector.recordCall(route.namespace, route.originalName, Date.now());
      }
      await this.trackUsageAndAutoDeactivate(route.namespace);
    }

    return result;
  }

  // Build RankableServer inputs for BM25 — uses live tool metadata when
  // the server is connected in this session, otherwise falls back to the
  // in-memory toolCache (populated from prior activations this session)
  // and finally the persistent toolCache shipped in the config payload.
  // Pick up to five tool names from the server whose own tokens overlap
  // with the query tokens. Falls back to the first three cached tool
  // names when nothing overlaps (the server scored on name/description,
  // not tools — still useful to surface the shape of what's available).
  // Used by the discover "Matches your query" summary only.
  private matchedToolNames(server: UpstreamServerConfig, queryTokens: Set<string>): string[] {
    const tools = this.rankableFor(server).tools;
    if (tools.length === 0) return [];
    const hits: string[] = [];
    for (const tool of tools) {
      const nameTokens = tool.name.toLowerCase().split(/[^a-z0-9]+/);
      const descTokens = (tool.description ?? "").toLowerCase().split(/[^a-z0-9]+/);
      if (nameTokens.some((t) => queryTokens.has(t)) || descTokens.some((t) => queryTokens.has(t))) {
        hits.push(tool.name);
        if (hits.length >= 5) break;
      }
    }
    if (hits.length > 0) return hits;
    return tools.slice(0, 3).map((t) => t.name);
  }

  private rankableFor(server: UpstreamServerConfig): RankableServer {
    const connection = this.connections.get(server.namespace);
    const liveTools = connection?.tools.map((t) => ({ name: t.name, description: t.description }));
    const sessionCache = this.toolCache.get(server.namespace);
    const persistedCache = server.toolCache;
    return {
      namespace: server.namespace,
      name: server.name,
      description: server.description,
      tools: liveTools ?? sessionCache ?? persistedCache ?? [],
    };
  }

  // BM25 shortlist cap — wider than the budget so downstream re-sorts
  // (health penalty, learning boost, sampling tiebreak) have room to
  // promote a server BM25 ranked below the head of the list.
  private static readonly BM25_TOP_K = 25;

  // Local BM25 ranking over the profiled active servers. Shared by
  // discover's auto-warm gate and dispatch so both pick the same winner
  // for the same intent.
  private async twoStageRank(
    context: string,
    servers: UpstreamServerConfig[],
  ): Promise<Array<{ namespace: string; score: number }>> {
    const bm25Input = servers.map((s) => this.rankableFor(s));
    const bm25 = rankServers(context, bm25Input);
    if (bm25.length === 0) return [];
    return bm25.slice(0, ConnectServer.BM25_TOP_K);
  }

  // Auto-warm confidence gate — applied to discover(context) so a single
  // clearly-winning server gets activated without the LLM needing to
  // follow up with a separate activate call. Default ON; flip off with
  // YAW_MCP_AUTO_ACTIVATE=0 if it causes surprise. The env read lives in
  // the module-level isAutoActivateEnabled() (re-read per call) rather
  // than a static initializer, which would latch the value at import.
  //
  // Top score must clear this floor AND the gap over the runner-up must
  // be convincing before we auto-activate. BM25 scores are unbounded
  // positive numbers. Tuned by intuition; revisit when we have real
  // usage data.
  private static readonly AUTO_ACTIVATE_MIN_SCORE_BM25 = 1.0;
  private static readonly AUTO_ACTIVATE_MARGIN_BM25 = 1.3;

  // Below this installed-server count, discover() appends a one-line
  // marketplace pointer so sparse-config users see where to add more.
  // At or above the threshold we stay silent — power users already know
  // the score, and the line would just be chat noise.
  private static readonly MARKETPLACE_HINT_THRESHOLD = 5;

  private handleDiscover(context?: string): { content: Array<{ type: string; text: string }> } {
    return this.buildDiscoverOutput(context, /* warmedNamespace */ null);
  }

  private async handleDiscoverWithAutoWarm(
    context?: string,
    progress?: ProgressReporter,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!context || !isAutoActivateEnabled()) return this.handleDiscover(context);

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) return this.handleDiscover(context);

    // Use the same ranker dispatch uses so discover + dispatch pick the
    // same winner for the same intent.
    const ranked = await this.twoStageRank(context, activeServers);
    if (ranked.length === 0) return this.handleDiscover(context);

    // Only auto-warm if one candidate dominates: top score clears the
    // floor and either stands alone or beats the runner-up by the
    // margin.
    const top = ranked[0];
    const second = ranked[1];
    const minScore = ConnectServer.AUTO_ACTIVATE_MIN_SCORE_BM25;
    const margin = ConnectServer.AUTO_ACTIVATE_MARGIN_BM25;
    const topWinsDecisively =
      top !== undefined &&
      top.score >= minScore &&
      (second === undefined || top.score / (second.score || 1e-6) >= margin);

    if (!topWinsDecisively || !top) return this.handleDiscover(context);

    // Already active — nothing to warm. Surface that fact in the output.
    const existing = this.connections.get(top.namespace);
    if (existing && existing.status === "connected") return this.handleDiscover(context);

    progress?.(`Auto-warming top candidate "${top.namespace}"`);
    const result = await this.activateOne(top.namespace, progress);
    if (result.ok) {
      // The namespace is connected now, so its `deferred` route (built from
      // the persisted toolCache) is stale. Every other activation site
      // rebuilds + notifies; skipping it here wedged the very next
      // tools/call on this server behind a "no longer available" error.
      await this.refreshRoutesAndNotify();
      log("info", "Auto-warmed top-ranked server on discover", { namespace: top.namespace, score: top.score });
    }

    // Pass the namespace we ACTUALLY warmed, not a bare boolean: the
    // banner below must name the server twoStageRank picked, which is
    // not necessarily the head of the list the output renders.
    return this.buildDiscoverOutput(context, result.ok ? top.namespace : null);
  }

  // Drop the memoized discover body. The cache key only covers
  // (configVersion, context, warmedNamespace, connected set), so state that
  // discover RENDERS but the key does not see -- activation failures
  // (formatHealthWarning) and learning counters (usage:/reliability: lines)
  // -- has to invalidate explicitly. Without this the exact case the cache
  // was built for ("discover, failed activate, discover again") replays the
  // pre-failure text and the model retries the dead server.
  private invalidateDiscoverCache(): void {
    this.discoverCache = null;
  }

  private discoverCacheKey(context: string | undefined, warmedNamespace: string | null): string {
    const activeNamespaces = [...this.connections.entries()]
      .filter(([, c]) => c.status === "connected")
      .map(([ns]) => ns)
      .sort()
      .join(",");
    return `${this.configVersion ?? ""}|${context ?? ""}|${warmedNamespace ?? ""}|${activeNamespaces}`;
  }

  private buildDiscoverOutput(
    context: string | undefined,
    warmedNamespace: string | null,
  ): { content: Array<{ type: string; text: string }> } {
    const key = this.discoverCacheKey(context, warmedNamespace);
    const now = Date.now();
    const cached = this.discoverCache;
    if (cached && cached.key === key && cached.expires > now) {
      return cached.result;
    }
    const result = this.buildDiscoverOutputImpl(context, warmedNamespace);
    this.discoverCache = { key, result, expires: now + ConnectServer.DISCOVER_CACHE_TTL_MS };
    return result;
  }

  private buildDiscoverOutputImpl(
    context: string | undefined,
    warmedNamespace: string | null,
  ): { content: Array<{ type: string; text: string }> } {
    if (!this.config || this.config.servers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No servers installed. Browse the catalog at https://yaw.sh/mcp/catalog/ and add one with `yaw-mcp add <slug>` — it lands in ~/.yaw-mcp/bundles.json. Restart this MCP client afterwards; yaw-mcp reads bundles.json once at startup.",
          },
        ],
      };
    }

    const activeServers = this.getProfiledActiveServers();

    // Score and sort using corpus-wide BM25 when context is provided.
    // Servers that don't match any query term simply fall out of the
    // ranked list; we append them at the end so the LLM still sees what's
    // available without them cluttering the top of the list.
    const scores = new Map<string, number>();
    let sorted: typeof activeServers;
    if (context) {
      const ranked = rankServers(
        context,
        activeServers.map((s) => this.rankableFor(s)),
      );
      for (const r of ranked) scores.set(r.namespace, r.score);
      // Index by namespace once rather than re-scanning activeServers for
      // every ranked entry (that was a linear find inside a map -- O(N^2)).
      const byNamespace = new Map(activeServers.map((s) => [s.namespace, s]));
      const matched = ranked
        .map((r) => byNamespace.get(r.namespace))
        .filter((s): s is UpstreamServerConfig => s !== undefined);
      const rankedSet = new Set(ranked.map((r) => r.namespace));
      const rest = activeServers.filter((s) => !rankedSet.has(s.namespace));
      sorted = [...matched, ...rest];
    } else {
      sorted = activeServers;
    }

    const lines: string[] = [context ? "Servers ranked by relevance:\n" : "Installed MCP servers:\n"];
    if (warmedNamespace) {
      lines.push(`Auto-loaded "${warmedNamespace}" — top match for your query.\n`);
    }

    // Compliance filter banner. When YAW_MCP_MIN_COMPLIANCE is active, the
    // per-server lines below will annotate any below-grade server with a
    // "won't auto-activate" marker; this header tells the model WHY
    // those markers are there so it doesn't try to activate them and
    // get a refusal surprise.
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null) {
      lines.push(`Compliance filter active: YAW_MCP_MIN_COMPLIANCE=${minCompliance}\n`);
    }

    // Compact "Matches your query" summary. Prepended when context is
    // given AND at least one server scored above zero, so the model
    // sees the short answer before the long list. Without this block
    // the relevance signal is easy to skim past — the per-server lines
    // carry a numeric score but no summary of WHY each matched.
    if (context) {
      const matchedServers = sorted.filter((s) => {
        const score = scores.get(s.namespace);
        return score !== undefined && score > 0;
      });
      if (matchedServers.length > 0) {
        lines.push("Matches for your query:");
        const queryTokens = tokenizeForSummary(context);
        for (const server of matchedServers.slice(0, 5)) {
          const tools = this.matchedToolNames(server, queryTokens);
          const toolStr = tools.length > 0 ? ` → ${tools.join(", ")}` : "";
          lines.push(`  • ${server.namespace}${toolStr}`);
        }
        lines.push("");
      }
    }

    // Precompute the co-usage map once per discover call. Derived from
    // the PackDetector's current history — same signal `suggest` surfaces,
    // but delivered inline so the LLM doesn't need a second meta-tool
    // roundtrip to see "often used with X."
    const chains = this.packDetector.detectChains();
    const coUsageMap = buildCoUsageMap(chains);

    // Inline "Suggested packs" block. Surfaces recurring co-activation
    // history from chains at the top of the output so the LLM can take
    // action in this call rather than needing a separate mcp_connect_suggest
    // round-trip. Filter: every namespace in the pack must be installed
    // (so `activate` can actually load them) AND at least one must not
    // be connected yet (otherwise the pack is already loaded — no action
    // to take). Ranked by frequency desc, tie-break by recency.
    const installedNamespaces = new Set(activeServers.map((s) => s.namespace));
    const connectedNamespaces = new Set(
      [...this.connections.entries()].filter(([, c]) => c.status === "connected").map(([ns]) => ns),
    );
    const actionablePacks = chains
      .filter((pack) => pack.namespaces.every((ns) => installedNamespaces.has(ns)))
      .filter((pack) => pack.namespaces.some((ns) => !connectedNamespaces.has(ns)))
      .sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency;
        return b.lastSeenAt - a.lastSeenAt;
      });
    if (actionablePacks.length > 0) {
      lines.push("Recurring packs (activate together — seen before):");
      for (const pack of actionablePacks.slice(0, 3)) {
        const nsJson = JSON.stringify(pack.namespaces);
        lines.push(`  {${pack.namespaces.join(", ")}} — seen ${pack.frequency}x; activate with namespaces=${nsJson}`);
      }
      lines.push("");
    }

    let totalContextTokens = 0;
    for (const server of sorted) {
      const connection = this.connections.get(server.namespace);
      // Apply per-tool filter to the advertised count so discover matches
      // what tools/list actually surfaces. Raw upstream tool count is
      // still shown as the denominator so the model sees what's hidden.
      const filter = this.toolFilters.get(server.namespace);
      const total = connection?.tools.length ?? 0;
      const exposed = connection ? (filter ? connection.tools.filter((t) => filter.has(t.name)).length : total) : 0;
      const filterSuffix = connection && filter ? ` (filtered: ${exposed} of ${total})` : "";
      const status = connection
        ? connection.status === "error"
          ? "ERROR (disconnected, will auto-reconnect on use)"
          : `loaded (${exposed} tools)${filterSuffix}`
        : "ready";

      const score = scores.get(server.namespace);
      const relevance = score && score > 0 ? ` (relevance: ${score.toFixed(2)})` : "";

      // Token-cost estimate — live for connected servers, tool-cache-
      // padded for dormant ones. Guides the LLM's activate/skip choice
      // when context budget is tight. Suppressed when we have nothing
      // to measure (no cache, no connection yet). When a filter is
      // active the cost reflects the EXPOSED tools only — hidden tools
      // don't surface in tools/list and therefore don't spend context.
      let costLabel = "";
      if (connection && connection.tools.length > 0) {
        const visible = filter ? connection.tools.filter((t) => filter.has(t.name)) : connection.tools;
        if (visible.length > 0) {
          const sample = estimateFromConnectedTools(visible);
          totalContextTokens += sample.tokens;
          costLabel = ` — ${formatCostLabel(sample)}`;
        }
      } else {
        const cached = this.toolCache.get(server.namespace) ?? server.toolCache;
        if (cached && cached.length > 0) {
          costLabel = ` — ${formatCostLabel(estimateFromToolCache(cached))}`;
        }
      }

      // Compliance annotation — the grade is a trust signal, so it's
      // shown unconditionally whenever the backend has scored this
      // server (A–F). Passing graded server → `[A]` tag. When
      // YAW_MCP_MIN_COMPLIANCE is set and the grade is below it, replace
      // the tag with an inline refusal reason so the model knows why
      // the line is surfaced but won't be activated. Ungraded servers
      // stay unannotated — don't punish unknown on a catalog where
      // many entries aren't scored yet.
      let complianceLabel = "";
      if (server.complianceGrade) {
        if (minCompliance !== null && !passesMinCompliance(server.complianceGrade, minCompliance)) {
          // Distinguish an unrecognized grade string from a recognized
          // grade that ranks below the floor — both fail the filter, but
          // calling an unrecognized "Pass" grade "below B" is misleading.
          const label =
            classifyGrade(server.complianceGrade).kind === "unrecognized"
              ? `unrecognized, won't auto-activate`
              : `below YAW_MCP_MIN_COMPLIANCE=${minCompliance}, won't auto-activate`;
          complianceLabel = ` (grade ${server.complianceGrade} — ${label})`;
        } else {
          complianceLabel = ` [${server.complianceGrade}]`;
        }
      }

      lines.push(
        `  ${server.namespace} — ${server.name} [${status}] (${server.type})${relevance}${costLabel}${complianceLabel}`,
      );

      const shadow = formatShadowLine(server);
      if (shadow) lines.push(`    ${shadow}`);

      // Surface recent unreliability so the LLM can prefer a healthier
      // alternative. Session-local; activation failures take precedence
      // over per-call error rate (see formatHealthWarning).
      const warning = formatHealthWarning(connection?.health, this.activationFailures.get(server.namespace));
      if (warning) lines.push(`    ${warning}`);

      // Dormant-reliability warning — pulls from persisted learning when
      // this server isn't currently loaded, so the LLM sees flaky history
      // before it tries to activate. Suppressed for loaded servers (the
      // live health warning above already covers them with fresher data).
      if (!connection) {
        const reliability = formatReliabilityWarning(this.learning.get(server.namespace));
        if (reliability) lines.push(`    ${reliability}`);
      }

      // Inline usage hint — cumulative success count + who tends to
      // get loaded alongside this server. Counts come from state.json
      // (persistence.ts) so they carry across yaw-mcp restarts. Silent
      // when neither signal has evidence yet. See usage-hints.ts.
      const usageHint = formatUsageHint(this.learning.get(server.namespace), coUsageMap.get(server.namespace) ?? []);
      if (usageHint) lines.push(`    ${usageHint}`);

      // Show cached tool names for servers that aren't currently connected
      if (!connection) {
        const cached = this.toolCache.get(server.namespace) ?? server.toolCache;
        if (cached && cached.length > 0) {
          const toolNames = cached.map((t) => t.name).join(", ");
          lines.push(`    known tools: ${toolNames}`);
        }
      }
    }

    // Overlapping tools block — detect bare tool names that appear in
    // ≥2 currently-connected servers. Dormant/installed-but-not-connected
    // servers are excluded; we only have live schemas for connected ones.
    // Capped at the top 5 overlaps (by namespace count desc, bare-name
    // alphabetical tie-break) to keep output bounded. Suppressed entirely
    // when no overlaps exist.
    const overlaps = computeToolOverlaps(this.connections.values());
    if (overlaps.length > 0) {
      lines.push("\nOverlapping tools (same bare name in multiple servers):");
      const top = overlaps.slice(0, 5);
      for (let i = 0; i < top.length; i++) {
        const o = top[i];
        const suffix = i === 0 ? " (use mcp_connect_dispatch to disambiguate)" : "";
        lines.push(`  ${o.bareName} — available in: ${o.namespaces.join(", ")}${suffix}`);
      }
    }

    // Bundle completions — inline install nudge for curated stacks where
    // the user already has ≥1 member installed. Top 3 by fewest-missing-
    // first (cheapest to complete), ties broken by most-momentum then id.
    // Suppressed when every bundle is either fully installed or entirely
    // absent. Same data source as mcp_connect_bundles action="match" but
    // surfaced here so the model can act without the extra round-trip.
    const allInstalled = this.config.servers.map((s) => s.namespace);
    const bundleGaps = topPartialBundles(allInstalled, 3);
    if (bundleGaps.length > 0) {
      lines.push("\nBundle completions (install to unlock curated stacks):");
      for (const { bundle, have, missing } of bundleGaps) {
        lines.push(`  ${bundle.id} — have: ${have.join(", ")}; add: ${missing.join(", ")}`);
      }
    }

    const inactive = this.config.servers.filter((s) => !s.isActive);
    if (inactive.length > 0) {
      lines.push("\nDisabled servers:");
      for (const server of inactive) {
        lines.push(`  ${server.namespace} — ${server.name} ("isActive": false in bundles.json)`);
      }
    }

    // Shadow-driven install candidates — its OWN section, gated OFF by
    // default. Only runs the offline shell-history scan when the gate is
    // on (env or config); otherwise this is a no-op and the output above
    // is byte-identical to a build without the feature. See
    // buildInstallCandidatesLines + install-nudge.ts.
    lines.push(...this.buildInstallCandidatesLines(activeServers));

    const activeCount = this.connections.size;
    // Count EXPOSED tools (post-filter) so the summary matches what
    // tools/list actually hands the client — hidden tools don't spend
    // context even though the upstream exposes them.
    const totalTools = Array.from(this.connections.values()).reduce((sum, c) => {
      const f = this.toolFilters.get(c.config.namespace);
      return sum + (f ? c.tools.filter((t) => f.has(t.name)).length : c.tools.length);
    }, 0);
    const tokenSummary = totalContextTokens > 0 ? ` (~${totalContextTokens.toLocaleString()} tokens)` : "";
    lines.push(`\n${activeCount} loaded in this session, ${totalTools} tools in context${tokenSummary}.`);
    lines.push(
      context
        ? "Use mcp_connect_dispatch(intent) to load the best server in one step, or mcp_connect_activate to pick explicitly."
        : "Use mcp_connect_activate to load a server's tools by namespace.",
    );

    // Marketplace hint — steer sparse-config users to the catalog without
    // nagging power users. Threshold counts installed servers (active +
    // inactive) in the user's bundles.json; anyone under the cutoff gets a
    // one-line pointer at the public catalog. No API is hit — the catalog
    // is a static browsable surface, so this is a URL hint, not a full
    // meta-tool.
    if (this.config.servers.length < ConnectServer.MARKETPLACE_HINT_THRESHOLD) {
      lines.push(
        "Browse the catalog at https://yaw.sh/mcp/catalog/ and add servers with `yaw-mcp add <slug>` — they land in ~/.yaw-mcp/bundles.json and load on the next client restart.",
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Build the opt-in "Install candidates" block from the offline shell-
  // history shadow scan. Returns [] (no lines, byte-identical output) when
  // the gate is off — the load-bearing privacy property: with the gate
  // unset the scan never runs and nothing about shell history is read.
  //
  // When ON, for each heavily-used CLI the scan found:
  //   - skip unless count >= INSTALL_NUDGE_MIN_COUNT (noise floor),
  //   - skip unless a FIRST-PARTY install target exists (installTargetForCli;
  //     a CLI like kubectl/npm/ssh with no target produces no nudge),
  //   - skip if ANY namespace the CLI maps to is already installed (the user
  //     already has a server that covers it — intersect the hit's namespaces
  //     with the installed set),
  //   - skip if the per-CLI cooldown hasn't elapsed (shouldNudge).
  // Surviving CLIs are recorded (recordNudge) so they stay suppressed for
  // the cooldown, and rendered as one line + the `yaw-mcp add <slug>` CLI
  // command that installs the server. The nudge points at the CLI rather
  // than a meta-tool: adding a server writes ~/.yaw-mcp/bundles.json, which
  // is the CLI's job, and the model can surface the command to the user.
  //
  // Privacy: the only data emitted is the aggregate integer count + the
  // first-party package / namespace / name. No raw history line, command
  // text, or argument ever reaches this output, and nothing here is sent to
  // analytics — scanShellHistoryForShadows is local-only and returns just
  // { cli, count, namespaces }.
  private buildInstallCandidatesLines(activeServers: UpstreamServerConfig[]): string[] {
    if (!this.installNudge) return [];

    // Namespaces the user already has installed (active, profile-narrowed).
    // A CLI whose shadow maps onto any of these is already covered — no nudge.
    const installedNamespaces = new Set(activeServers.map((s) => s.namespace));

    const hits = scanShellHistoryForShadows({ home: this.nudgeHome, env: this.nudgeEnv });

    const candidates: Array<{
      cli: string;
      count: number;
      target: { package: string; namespace: string; name: string };
    }> = [];
    for (const hit of hits) {
      if (hit.count < INSTALL_NUDGE_MIN_COUNT) continue;
      // Already covered by an installed server for any namespace this CLI
      // shadows — they have it; don't nudge.
      if (hit.namespaces.some((ns) => installedNamespaces.has(ns))) continue;
      const target = installTargetForCli(hit.cli);
      if (!target) continue;
      // Defense in depth: never nudge toward a target whose own namespace is
      // already installed, even if the shadow registry didn't list it.
      if (installedNamespaces.has(target.namespace)) continue;
      if (!shouldNudge(hit.cli, this.nudgeHome)) continue;
      candidates.push({ cli: hit.cli, count: hit.count, target });
    }

    if (candidates.length === 0) return [];

    const lines: string[] = ["\nInstall candidates (from your recent shell usage; history stays local):"];
    for (const { cli, count, target } of candidates) {
      lines.push(`  ${cli.padEnd(10)} (ran ${count}x recently) -> install ${target.package}`);
      lines.push(`     run: yaw-mcp add ${target.namespace}`);
      // Suppress this CLI for the cooldown now that we've surfaced it.
      recordNudge(cli, this.nudgeHome);
    }
    return lines;
  }

  // Activate a single server by namespace. Shared by handleActivate,
  // handleDispatch, and handleDiscoverWithAutoWarm so error handling,
  // retries, and caching live in one place.
  //
  // Dedup guarantee: two concurrent callers for the same namespace
  // share one in-flight activation. Without this, a tool call landing
  // on a disconnected upstream while another tool call was already
  // trying to reactivate the same namespace would spawn a duplicate
  // child process; the second set() would win and the first would leak
  // until its transport noticed. See activationInflight.
  //
  // `fromPrewarm` marks the inflight as prewarm-initiated so that
  // prewarmDormantServers can safely disconnect when it is the sole
  // caller, but skip the disconnect when an explicit activate has also
  // joined the inflight promise. An explicit call (fromPrewarm=false)
  // removes the namespace from prewarmNamespaces so prewarm's teardown
  // code sees it as "claimed" and leaves the connection alive.
  //
  // Returns:
  //   { ok: true, message } — already connected or newly connected
  //   { ok: false, message, isChanged: false } — failed or not in config
  private activateOne(
    namespace: string,
    progress?: ProgressReporter,
    fromPrewarm = false,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }> {
    // Refuse once shutdown() has latched. Anything spawned from here would
    // land in this.connections after the teardown snapshot and outlive the
    // process's own bookkeeping — a live child nothing will ever close.
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        isChanged: false,
        message: `"${namespace}" was not loaded — yaw-mcp is shutting down.`,
      });
    }

    // An explicit (non-prewarm) activation claims the namespace: prewarm
    // must not tear down a connection the user asked for.
    if (!fromPrewarm) {
      this.prewarmNamespaces.delete(namespace);
    }

    const inflight = this.activationInflight.get(namespace);
    if (inflight) {
      progress?.(`"${namespace}" load already in flight — awaiting existing attempt`);
      return inflight;
    }

    if (fromPrewarm) {
      this.prewarmNamespaces.add(namespace);
    }

    const promise = this.runActivateOne(namespace, progress).finally(() => {
      // Clear only if this promise is still the registered one. If a
      // retry path (maybeElicitAndRetry → activateOne) has already
      // registered a follow-up, leave that one in place.
      if (this.activationInflight.get(namespace) === promise) {
        this.activationInflight.delete(namespace);
      }
    });
    this.activationInflight.set(namespace, promise);
    return promise;
  }

  private async runActivateOne(
    namespace: string,
    progress?: ProgressReporter,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }> {
    const existing = this.connections.get(namespace);
    if (existing && existing.status === "connected") {
      progress?.(`"${namespace}" already loaded`);
      return {
        ok: true,
        isChanged: false,
        message: `"${namespace}" is already loaded with ${existing.tools.length} tools.`,
        serverId: existing.config.id,
      };
    }

    const anyMatch = this.config?.servers.find((s) => s.namespace === namespace);
    if (!anyMatch) {
      // Split "not found" from "disabled" so the caller knows whether to
      // (a) fix a typo / install the server or (b) flip the toggle at
      // Yaw MCP. Fuzzy suggestions only when the input is a clear
      // near-miss — noise-free by construction (closestNames returns []
      // otherwise).
      const allNamespaces = this.config?.servers.map((s) => s.namespace) ?? [];
      const suggestions = closestNames(namespace, allNamespaces, 3);
      const hint =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(", ")}?`
          : " Use mcp_connect_discover to see installed servers.";
      return { ok: false, isChanged: false, message: `"${namespace}" is not installed.${hint}` };
    }
    if (!anyMatch.isActive) {
      return {
        ok: false,
        isChanged: false,
        message: `"${namespace}" is installed but disabled. Set "isActive": true for it in ~/.yaw-mcp/bundles.json and restart this MCP client to activate.`,
      };
    }
    const serverConfig = anyMatch;

    if (!profileAllows(this.profile, namespace)) {
      return {
        ok: false,
        isChanged: false,
        message: `"${namespace}" is not allowed by the project profile at ${this.profile?.path}.`,
      };
    }

    // Compliance floor gate. Refuse to spawn an upstream whose reported
    // grade is below YAW_MCP_MIN_COMPLIANCE. This is the ONLY copy of the
    // gate, so EVERY activation path — activate, dispatch, discover auto-
    // warm, deferred lazy-activation, autoLoadRecurringPack — honors the
    // floor before connectToUpstream with one refusal string and one
    // precedence order (not-installed, then disabled, then profile, then
    // compliance). Ungraded servers pass (see passesMinCompliance).
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null && !passesMinCompliance(serverConfig.complianceGrade, minCompliance)) {
      return {
        ok: false,
        isChanged: false,
        message: `Refused to load "${namespace}": ${complianceRefusalReason(serverConfig.complianceGrade, minCompliance)}. Unset YAW_MCP_MIN_COMPLIANCE (or lower it) to override.`,
      };
    }

    // Concurrent-load cap. Connected servers count; error-state
    // connections don't, because they aren't contributing tools to
    // the LLM's context. We compute the slot list fresh here — it's
    // cheap (Map iteration) and guaranteed to reflect state after
    // any auto-unloads that fired between the check and this call.
    // Pending reservations (pendingActivations) count too: a DIFFERENT
    // namespace mid-`await connectToUpstream` occupies a slot even though
    // its connection isn't in this.connections yet. Without this, two
    // concurrent activations of distinct namespaces both pass the check
    // against the same connected set and overshoot the cap (TOCTOU).
    const loadedSlots: LoadedSlot[] = [];
    const counted = new Set<string>();
    for (const [ns, conn] of this.connections) {
      if (conn.status === "connected") {
        loadedSlots.push({ namespace: ns, idleCount: this.idleCallCounts.get(ns) ?? 0 });
        counted.add(ns);
      }
    }
    for (const ns of this.pendingActivations) {
      // Skip self (not reserved yet) and anything already counted as a
      // live connection, so a reservation never double-occupies a slot.
      if (ns !== namespace && !counted.has(ns)) {
        loadedSlots.push({ namespace: ns, idleCount: this.idleCallCounts.get(ns) ?? 0 });
        counted.add(ns);
      }
    }
    const capDecision = evaluateServerCap(namespace, loadedSlots, this.serverCap);
    if (!capDecision.allow) {
      return {
        ok: false,
        isChanged: false,
        capped: true,
        message: capDecision.message ?? "Concurrent server cap reached.",
      };
    }

    // Reserve our slot synchronously — before the first `await` below — so
    // a concurrent activation of a different namespace sees us in the count
    // above. Released in the finally regardless of outcome; on success the
    // namespace lives in this.connections (counted there), so there is no
    // gap. maybeElicitAndRetry re-enters runActivateOne for the SAME
    // namespace, which the Set makes idempotent (and evaluateServerCap
    // treats a self-reservation as "already counts", so it never blocks).
    this.pendingActivations.add(namespace);
    try {
      // Merge any session-elicited env over the server's configured env.
      // Elicited values only apply inside this yaw-mcp process lifetime.
      const elicited = this.elicitedEnv.get(namespace);
      const effectiveConfig = elicited ? { ...serverConfig, env: { ...serverConfig.env, ...elicited } } : serverConfig;

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          progress?.(
            attempt === 0 ? `Spawning "${namespace}" upstream…` : `Retrying "${namespace}" (attempt ${attempt + 1})…`,
          );
          const connection = await connectToUpstream(
            effectiveConfig,
            this.onUpstreamDisconnect,
            this.onUpstreamListChanged,
          );
          progress?.(`"${namespace}" loaded ${connection.tools.length} tools`);
          this.connections.set(namespace, connection);
          this.idleCallCounts.set(namespace, 0);
          const toolMeta = connection.tools.map((t) => ({ name: t.name, description: t.description }));
          this.toolCache.set(namespace, toolMeta);
          this.toolCacheLearnedAt.set(namespace, Date.now());
          // Persist the learned list so the NEXT session skips the pre-warm
          // spawn for this namespace. Debounced + best-effort; a failed save
          // just means we re-learn next time.
          this.scheduleStateSave();

          const toolNames = connection.tools.map((t) => t.namespacedName).join(", ");
          // Activation succeeded — clear any stale penalty so a recovered
          // server isn't permanently demoted for a transient past failure.
          this.activationFailures.delete(namespace);
          return {
            ok: true,
            isChanged: true,
            serverId: serverConfig.id,
            message: `Loaded "${namespace}" — ${connection.tools.length} tools: ${toolNames}`,
          };
        } catch (err) {
          lastError = err;
          if (attempt === 0) {
            const msg = err instanceof Error ? err.message : String(err);
            log("warn", "Activation attempt failed, retrying", { namespace, error: msg });
            // Fixed 1s delay before the single retry. The expression `1000 * 2 ** attempt`
            // evaluates to 1000ms here (attempt=0, 2^0=1) -- this is NOT exponential
            // backoff; it is one fixed step.
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
        }
      }

      // Before giving up, see if the failure looks like a missing credential
      // and the client supports elicitation. If both hold, ask the user for
      // the missing values and retry exactly once — one round-trip max.
      //
      // Guarded by the haven't-just-tried-this-credential check: if elicited
      // values are already present for every detected name, don't ask twice.
      const elicitedRetry = await this.maybeElicitAndRetry(namespace, lastError, progress);
      if (elicitedRetry) return elicitedRetry;

      log("error", "Failed to activate upstream", {
        namespace,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });

      // Record the failure so dispatch down-ranks this namespace for a
      // few minutes. The TTL is short enough that a fixed server (user
      // edited bundles.json env, for example) recovers on the next client restart.
      this.activationFailures.set(namespace, {
        at: Date.now(),
        message: lastError instanceof Error ? lastError.message : String(lastError),
      });
      // discover renders this failure as a `warn: last activation failed ...`
      // line, but the failure touches nothing in the discover cache key, so
      // a re-discover inside the 3s TTL would hand back the pre-failure text.
      this.invalidateDiscoverCache();

      // Prefer the ActivationError's message (includes stderr tail + category
      // hint) over the raw SDK error. Falls back cleanly for transport errors.
      const message =
        lastError instanceof ActivationError
          ? `Failed to load "${namespace}": ${lastError.message}`
          : `Failed to load "${namespace}": ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      return { ok: false, isChanged: false, message };
    } finally {
      this.pendingActivations.delete(namespace);
    }
  }

  // If the activation error names a missing credential (e.g. "GITHUB_TOKEN
  // is required") AND the client supports elicitation, ask the user for
  // the values inline and retry activation once. Returns the retry result
  // on success, or null when we can't/shouldn't elicit. Single-round only —
  // we don't want to pester the user with a loop on every retry failure.
  private async maybeElicitAndRetry(
    namespace: string,
    lastError: unknown,
    progress?: ProgressReporter,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string } | null> {
    const stderr = lastError instanceof ActivationError ? lastError.stderrTail : undefined;
    const errMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const haystack = [stderr, errMessage].filter(Boolean).join("\n");
    const missing = detectMissingCredentials(haystack);
    if (missing.length === 0) return null;

    // Skip if we've already elicited these exact values — that means we
    // already tried with the user's input and it still failed, so more
    // prompting won't help.
    const alreadyElicited = this.elicitedEnv.get(namespace);
    if (alreadyElicited && missing.every((k) => k in alreadyElicited)) return null;

    const caps = this.server.getClientCapabilities();
    if (!caps?.elicitation) {
      log("info", "Detected missing credentials but client does not support elicitation", {
        namespace,
        missing,
      });
      return null;
    }

    // Build an object-schema elicitation with one string field per missing
    // credential. Descriptions are minimal on purpose — we don't know the
    // semantic purpose of each env var.
    const properties: Record<string, { type: "string"; title: string; description: string }> = {};
    for (const key of missing) {
      properties[key] = {
        type: "string",
        title: key,
        description: `The value for ${key} required by "${namespace}". Stored only for this yaw-mcp session.`,
      };
    }

    progress?.(`Asking for ${missing.length === 1 ? "credential" : "credentials"}: ${missing.join(", ")}`);

    let result: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      result = await this.server.elicitInput({
        message: `"${namespace}" can't start without ${missing.join(", ")}. Provide ${missing.length === 1 ? "it" : "them"} to retry, or decline to cancel.`,
        requestedSchema: {
          type: "object",
          properties,
          required: missing,
        },
      });
    } catch (err) {
      log("warn", "Elicitation request failed", {
        namespace,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (result.action !== "accept" || !result.content) {
      log("info", "User declined credential elicitation", { namespace, action: result.action });
      return null;
    }

    const values: Record<string, string> = {};
    for (const key of missing) {
      const v = result.content[key];
      if (typeof v === "string" && v.length > 0) values[key] = v;
    }
    if (Object.keys(values).length === 0) return null;

    this.elicitedEnv.set(namespace, { ...alreadyElicited, ...values });
    progress?.("Got credentials — retrying load");
    // Recurse — runActivateOne merges elicitedEnv on this attempt.
    // Call runActivateOne directly (not activateOne) because we're
    // already inside the in-flight activation promise registered by
    // activateOne; going through the wrapper again would deadlock on
    // our own entry in activationInflight.
    return this.runActivateOne(namespace, progress);
  }

  private async handleActivate(
    namespaces: string[],
    progress?: ProgressReporter,
    toolsFilter?: string[],
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (namespaces.length === 0) {
      return {
        content: [
          { type: "text", text: "server namespace is required. Use mcp_connect_discover to see installed servers." },
        ],
        isError: true,
      };
    }

    // Apply per-tool filter rules BEFORE activation so the first
    // list-changed notification reflects the intended filtered surface.
    //   - tools provided + exactly 1 namespace → replace filter for it.
    //   - tools not provided (or multi-server activate) → clear the
    //     filter for each touched namespace so re-activating without
    //     `tools` always exposes the full set.
    //
    // A filter SET this way is rolled back below when the activation it was
    // meant for fails: leaving it behind means a later successful load of
    // the same namespace (via dispatch, or a deferred first call — neither
    // touches toolFilters) silently advertises only the tools the FAILED
    // call asked for. The clear-filter branch needs no rollback: it widens
    // the surface back to the documented default.
    let filtersChanged = false;
    // Set when this call INSTALLED a filter, so a failed activation can put
    // the previous state back. `prev: undefined` means "there was none".
    let installedFilter: { namespace: string; prev: Set<string> | undefined } | null = null;
    if (toolsFilter && namespaces.length === 1) {
      const ns = namespaces[0];
      // Dedup + drop empty strings. If the resulting set is empty we
      // clear the filter rather than hide EVERYTHING — an empty array
      // is almost certainly the model meaning "no filter".
      const names = new Set(toolsFilter.map((t) => t.trim()).filter((t) => t.length > 0));
      const prev = this.toolFilters.get(ns);
      if (names.size === 0) {
        if (prev) {
          this.toolFilters.delete(ns);
          filtersChanged = true;
        }
      } else {
        // Compare sets by size + membership to decide whether the
        // tools/list surface actually moved. Prevents a spurious
        // list_changed notification when the same filter is re-sent.
        const same = prev && prev.size === names.size && [...names].every((n) => prev.has(n));
        if (!same) {
          this.toolFilters.set(ns, names);
          filtersChanged = true;
          installedFilter = { namespace: ns, prev };
        }
      }
    } else {
      for (const ns of namespaces) {
        if (this.toolFilters.delete(ns)) filtersChanged = true;
      }
    }

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;
    let anyCapped = false;

    // NB: no compliance pre-check here. The YAW_MCP_MIN_COMPLIANCE floor is
    // enforced once, inside runActivateOne, so every activation path shares
    // one gate and one refusal string. The duplicate that used to live here
    // produced identical text for the common case but silently REORDERED
    // precedence for a server failing two gates: a below-grade server that
    // is also disabled or profile-blocked reported the compliance reason to
    // `activate` and the disabled/blocked reason to `dispatch`. Refusals are
    // still errors (not cap-style budgeting) because a failed activateOne
    // returns ok:false with capped unset, which sets anyError below.
    const total = namespaces.length;
    let i = 0;
    for (const namespace of namespaces) {
      i += 1;
      progress?.(`Loading ${namespace} (${i}/${total})`, i - 1, total);
      const r = await this.activateOne(namespace, progress);
      results.push(r.message);
      if (r.isChanged) anyChanged = true;
      // Gateway mode advertises a namespace only after the client asks for
      // it BY NAME, which is here -- not in activateOne, which dispatch and
      // the deferred first-call path also route through. Those two reach a
      // tool without the client having chosen the server, so surfacing the
      // whole namespace off them would grow the tool list as a side effect
      // of one call. Recorded on success only.
      if (r.ok) this.sessionActivated.add(namespace);
      // Cap refusals are tracked separately: alongside successes they are
      // informational (the per-namespace message says what to unload), but
      // when NOTHING loads the call did no work and must signal an error.
      if (!r.ok) {
        if (r.capped) anyCapped = true;
        else anyError = true;
        // Roll back a filter we installed for a namespace that never came
        // up. Otherwise the entry outlives this call and narrows the tool
        // surface of a LATER, successful activation nobody filtered — and
        // for a namespace that isn't installed at all it is permanent.
        if (installedFilter && installedFilter.namespace === namespace) {
          if (installedFilter.prev) this.toolFilters.set(namespace, installedFilter.prev);
          else this.toolFilters.delete(namespace);
          installedFilter = null;
          // The surface never actually moved, so don't announce that it did.
          filtersChanged = false;
        }
      }
    }
    // NB: no trailing "Done" progress notification here. MCP clients
    // delete the progress token synchronously when the response arrives,
    // but notification handlers run as microtasks — so a progress sent
    // right before the response loses a race with _onresponse cleanup
    // and arrives at a token the client has already freed. That looks
    // like a fatal "unknown token" error to Claude Code and drops the
    // whole transport. The response itself IS the completion signal;
    // the tail-end progress would be redundant anyway.

    if (anyChanged) {
      await this.refreshRoutesAndNotify();
    } else if (filtersChanged) {
      // Filter changed on an already-connected server — routes are
      // unchanged (dispatch still reaches hidden tools) but the
      // tools/list surface moved, so notify the client to re-list.
      await this.notifyAllListsChanged();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
      isError: anyError || (anyCapped && !anyChanged) ? true : undefined,
    };
  }

  // Smart-routing meta-tool. The LLM describes the task in plain English
  // ("create a github issue for this bug"); yaw-mcp ranks configured servers
  // with BM25 and activates the top N, then lets the LLM call the now-
  // exposed tools normally. Default budget is 1 because over-activating
  // pollutes the tool list in the LLM's context with noise.
  // Is A -> B a designed multi-server flow rather than a routing miss? True
  // when both namespaces co-occur in a curated bundle or a detected usage
  // pack — those A-then-B sequences are intentional, so re-dispatch from A
  // to B must NOT penalize A. Used as detectMiss's exclusion predicate.
  // Background refinement of a just-recorded heuristic reward via the optional
  // LLM grader. Fire-and-forget: the tool result has already returned. If the
  // grader returns a verdict different from the heuristic, revise the credit by
  // the delta (recordOutcome already counted the dispatch). Never throws.
  private async refineRewardInBackground(namespace: string, heuristic: number, ctx: GraderContext): Promise<void> {
    try {
      const graded = await gradeOutcomeViaSampling(this.server, ctx);
      if (graded === null || graded === heuristic) return;
      this.learning.adjustSucceeded(namespace, graded - heuristic);
      this.scheduleStateSave();
      this.invalidateDiscoverCache();
    } catch {
      // Refinement is best-effort; it must never surface to the caller.
    }
  }

  private isLegitChain(a: string, b: string): boolean {
    for (const bundle of CURATED_BUNDLES) {
      if (bundle.namespaces.includes(a) && bundle.namespaces.includes(b)) return true;
    }
    for (const pack of this.packDetector.detectChains()) {
      if (pack.namespaces.includes(a) && pack.namespaces.includes(b)) return true;
    }
    return false;
  }

  private async handleDispatch(
    intent: string,
    budget: number,
    progress?: ProgressReporter,
    routeEffortOverride?: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const trimmed = intent?.trim?.() ?? "";
    if (trimmed.length === 0) {
      return {
        content: [{ type: "text", text: "intent is required. Describe the task you want to accomplish." }],
        isError: true,
      };
    }
    if (!this.config || this.config.servers.length === 0) {
      return {
        content: [{ type: "text", text: "No servers installed. Add servers at yaw.sh/mcp to get started." }],
        isError: true,
      };
    }

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) {
      const note = this.profile
        ? ` (project profile at ${this.profile.path} restricts which servers are available)`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `No servers enabled${note}. Enable servers at yaw.sh/mcp or re-run mcp_connect_discover.`,
          },
        ],
        isError: true,
      };
    }

    progress?.(`Ranking ${activeServers.length} servers…`);
    const rankedRaw = await this.twoStageRank(trimmed, activeServers);
    // Apply health-aware penalty: recent activation failures and high
    // error rates shrink the score so dispatch prefers working servers
    // when multiple match. Never boosts above raw score — all else
    // equal, prefer the one that works.
    const ranked = rankedRaw
      .map((r) => ({
        namespace: r.namespace,
        score:
          r.score *
          healthFactor(this.connections.get(r.namespace)?.health, this.activationFailures.get(r.namespace)) *
          this.learning.boostFactor(r.namespace),
      }))
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No installed server matches "${trimmed}". Use mcp_connect_discover to see what's installed, or add a relevant server at yaw.sh/mcp.`,
          },
        ],
        isError: true,
      };
    }

    // Sampling tiebreak: when BM25+health rank the top-2
    // candidates within a close margin, ask the client LLM to choose.
    // Uses the same model the user is already running — no extra
    // provider key, no extra cost from yaw-mcp's side. Silently skips if
    // the client doesn't advertise the sampling capability.
    // budget === 1 is intentional: the tiebreak only matters when a single
    // primary is returned. A multi-load (budget>1) tolerates a wrong primary
    // because the close runner-up is also in the returned slice — paying the
    // sampling round-trip there buys nothing. Do not "fix" this to fire for
    // budget>1.
    // The effort dial generalizes the old fixed 10%-tiebreak into an
    // ambiguity-aware gate (off|auto|aggressive). auto preserves today's
    // behavior (one sample on genuine ambiguity); aggressive samples
    // best-of-3 on milder ambiguity. budget>1 still skips — a multi-load
    // tolerates a wrong primary, so paying the round-trip buys nothing.
    const effort = parseRouteEffort(routeEffortOverride ?? process.env.YAW_MCP_ROUTE_EFFORT);
    if (budget === 1 && shouldSample(ranked, effort)) {
      progress?.("Top candidates close — asking LLM to pick…");
      const serversByNamespace = new Map(activeServers.map((s) => [s.namespace, s]));
      const candidates = buildCandidates(ranked.slice(0, 3), serversByNamespace, this.toolCache);
      const samples = sampleCountForEffort(effort);
      const picked = await bestOfNViaSampling(this.server, trimmed, candidates, samples);
      if (picked) {
        const winner = ranked.find((r) => r.namespace === picked);
        if (winner) {
          // Re-sort so the LLM's pick sits at position 0; preserve the
          // rest of the order so budget>1 callers still see a stable list.
          const rest = ranked.filter((r) => r.namespace !== picked);
          ranked.length = 0;
          ranked.push(winner, ...rest);
          progress?.(`LLM chose ${picked}`);
        }
      }
    }

    const safeBudget = Math.max(1, Math.min(10, Math.floor(budget)));
    const winners = ranked.slice(0, safeBudget);

    // Re-dispatch routing-miss + opt-in foundry harvest. The primary winner
    // is the server this dispatch actually routed to. If a token-similar
    // intent was recently routed to a DIFFERENT, then-abandoned server, that
    // earlier choice was the wrong route — penalize it (recordMiss). Then
    // record this dispatch so a future re-route can be judged against it.
    const primary = winners[0]?.namespace;
    if (primary) {
      // Remember the intent each activated server was routed for, so the
      // optional LLM reward grader can judge later tool calls against the goal.
      for (const w of winners) this.lastIntentByNamespace.set(w.namespace, trimmed);
      const intentTokens = tokenize(trimmed);
      const now = Date.now();
      const miss = this.redispatch.detectMiss(primary, intentTokens, now, (a, b) => this.isLegitChain(a, b));
      if (miss) {
        this.learning.recordMiss(miss.loser);
        this.scheduleStateSave();
      }
      this.redispatch.push(primary, intentTokens, now);
      // Privacy-safe, opt-in routing-eval harvest (the "environment foundry").
      // Disabled unless YAW_MCP_FOUNDRY is set; only a REDACTED token bag plus
      // candidate namespaces ever leave memory — never the raw intent string.
      if (isFoundryEnabled()) {
        const redacted = redactIntent(trimmed);
        void appendFoundryTrace({
          tokens: redacted.tokens,
          redactedCount: redacted.redactedCount,
          candidates: ranked.slice(0, 5).map((r) => ({ ns: r.namespace, score: r.score })),
          chosen: primary,
        });
      }
    }

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;
    let anyCapped = false;

    let i = 0;
    for (const winner of winners) {
      i += 1;
      progress?.(`Loading ${winner.namespace} (${i}/${winners.length})`, i - 1, winners.length);
      const r = await this.activateOne(winner.namespace, progress);
      results.push(`${winner.namespace} (score ${winner.score.toFixed(2)}): ${r.message}`);
      if (r.isChanged) anyChanged = true;
      // Cap refusals are expected when the budget exceeds the concurrent
      // server cap -- informational alongside successes, but if NOTHING
      // loaded the dispatch did no work and must signal (same rule as
      // handleActivate).
      if (!r.ok) {
        if (r.capped) anyCapped = true;
        else anyError = true;
      }
      // Activation success is NOT recorded as a learning signal — that
      // would inflate "this server worked" into "every activation
      // counts as a successful tool call," which collapses the
      // dispatched/succeeded ratio that boostFactor and the flaky-
      // namespace warnings rely on. The ground truth is tool-call
      // success, recorded in handleToolCall on the proxy path.
    }
    // No trailing "Dispatch complete" progress — see handleActivate for
    // the client-side race this avoids.

    if (anyChanged) {
      await this.refreshRoutesAndNotify();
    }

    const header = `Dispatched "${trimmed}" — loaded top ${winners.length} of ${ranked.length} matching server${ranked.length === 1 ? "" : "s"}.\n`;
    return {
      content: [{ type: "text", text: header + results.join("\n") }],
      isError: anyError || (anyCapped && !anyChanged) ? true : undefined,
    };
  }

  private async handleDeactivate(
    namespaces: string[],
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (namespaces.length === 0) {
      return {
        content: [{ type: "text", text: "server namespace is required." }],
        isError: true,
      };
    }

    const results: string[] = [];
    let anyChanged = false;

    for (const namespace of namespaces) {
      const connection = this.connections.get(namespace);
      if (!connection) {
        results.push(`"${namespace}" wasn't loaded.`);
        continue;
      }

      await disconnectFromUpstream(connection);
      this.connections.delete(namespace);
      this.idleCallCounts.delete(namespace);
      this.adaptiveSkipLogged.delete(namespace);
      this.toolFilters.delete(namespace);
      // Without this the namespace stays advertised in gateway mode after
      // being unloaded, and the message below ("Tools removed from context")
      // would be a lie.
      this.sessionActivated.delete(namespace);
      anyChanged = true;
      results.push(`Unloaded "${namespace}". Tools removed from context.`);
    }

    if (anyChanged) {
      await this.refreshRoutesAndNotify();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
    };
  }

  private async trackUsageAndAutoDeactivate(calledNamespace: string): Promise<void> {
    // Record this call in the rolling history BEFORE computing per-ns
    // thresholds — so adaptive bonuses reflect the fact we just called
    // this namespace (protects it from deactivation on a back-to-back
    // burst where another ns happens to tick over the baseline).
    pushToolCall(this.recentToolCalls, { namespace: calledNamespace, at: Date.now() }, HISTORY_LIMIT);
    // Reset idle count for the server that was just called, and forget
    // any previous "we already logged the patience message for you"
    // marker — the next time it goes idle we want a fresh log.
    this.idleCallCounts.set(calledNamespace, 0);
    this.adaptiveSkipLogged.delete(calledNamespace);

    // Increment idle count for all OTHER active servers
    for (const ns of this.connections.keys()) {
      if (ns !== calledNamespace) {
        this.idleCallCounts.set(ns, (this.idleCallCounts.get(ns) ?? 0) + 1);
      }
    }

    // Auto-deactivate servers that have been idle too long, using an
    // adaptive per-namespace threshold so bursty upstreams get more
    // patience. The baseline comes from resolveIdleThreshold() (env
    // var-overridable, re-read per call); the adaptive function adds a
    // bonus based on that namespace's recent activity.
    const baseline = resolveIdleThreshold();
    const toDeactivate: string[] = [];
    for (const [ns, idleCount] of this.idleCallCounts) {
      if (!this.connections.has(ns)) continue;
      const threshold = adaptiveThreshold(ns, this.recentToolCalls, baseline);
      if (idleCount >= threshold) {
        // Never reap a namespace with a tool call still in flight: the
        // close would reject the user's own pending callTool, which the
        // proxy turns into an isError result and handleToolCall then books
        // as a 0.0 reward against a server WE killed. Leaving it connected
        // costs one more idle tick — it is re-evaluated on the next
        // completion, by which point the call has drained.
        if ((this.inflightCalls.get(ns) ?? 0) > 0) {
          log("info", "Skipping idle deactivation — tool call in flight", {
            namespace: ns,
            idleCalls: idleCount,
          });
          continue;
        }
        toDeactivate.push(ns);
      } else if (idleCount >= baseline && !this.adaptiveSkipLogged.has(ns)) {
        // We would have deactivated under the baseline threshold but the
        // adaptive bonus is keeping this ns alive. Log once per ns so
        // users can see the mechanism doing its job, then stay quiet.
        log("info", "Adaptive idle patience keeping bursty upstream alive", {
          namespace: ns,
          idleCalls: idleCount,
          baseline,
          adaptiveThreshold: threshold,
        });
        this.adaptiveSkipLogged.add(ns);
      }
    }

    let deactivated = 0;
    for (const ns of toDeactivate) {
      const connection = this.connections.get(ns);
      if (!connection) continue;
      // Re-check the in-flight guard immediately before the close, not just
      // when the list was built: this loop awaits per namespace, and each
      // disconnectFromUpstream burns real event-loop time (the SDK's stdio
      // close races a 2s timer twice), so a tools/call for a LATER entry can
      // be routed and started in that window. The snapshot taken above is
      // stale by then, and closing under a live call is exactly the 0.0
      // reliability hit against our own kill that the guard exists to stop.
      if ((this.inflightCalls.get(ns) ?? 0) > 0) {
        log("info", "Skipping idle deactivation — tool call landed during teardown", {
          namespace: ns,
          idleCalls: this.idleCallCounts.get(ns),
        });
        continue;
      }
      log("info", "Auto-deactivating idle server", { namespace: ns, idleCalls: this.idleCallCounts.get(ns) });
      await disconnectFromUpstream(connection);
      this.connections.delete(ns);
      this.idleCallCounts.delete(ns);
      this.adaptiveSkipLogged.delete(ns);
      this.toolFilters.delete(ns);
      // Same lifetime as toolFilters: a namespace torn down here is no longer
      // something the client asked for. Leaving it set means a LATER
      // dispatch-driven activation would advertise the whole namespace, which
      // is exactly what keying on explicit activation exists to prevent.
      this.sessionActivated.delete(ns);
      deactivated++;
    }

    // Only notify when a connection actually went away — a run where every
    // candidate was skipped leaves the routing table exactly as it was.
    if (deactivated > 0) {
      await this.refreshRoutesAndNotify();
    }
  }

  private async reconcileConfig(newConfig: ConnectConfig): Promise<void> {
    const newServersByNs = new Map(newConfig.servers.map((s) => [s.namespace, s]));
    let changed = false;

    // Deactivate servers that were removed from config or disabled
    for (const [namespace, connection] of this.connections) {
      const newServerConfig = newServersByNs.get(namespace);

      if (!newServerConfig?.isActive) {
        log("info", "Server removed or disabled in config, deactivating", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        this.idleCallCounts.delete(namespace);
        this.adaptiveSkipLogged.delete(namespace);
        this.toolFilters.delete(namespace);
        // See the idle-reaper note: session activation is per-namespace state
        // with the same lifetime as the filter beside it.
        this.sessionActivated.delete(namespace);
        // Drop any session-elicited credentials for this namespace too —
        // the server is gone (or disabled), so the cached values are stale
        // and could leak into a future re-add of an unrelated config.
        this.elicitedEnv.delete(namespace);
        changed = true;
        continue;
      }

      // Check if config changed (different command, args, url, env, type, or timeout)
      const oldConfig = connection.config;
      if (
        oldConfig.command !== newServerConfig.command ||
        !argsEqual(oldConfig.args, newServerConfig.args) ||
        oldConfig.url !== newServerConfig.url ||
        !envEqual(oldConfig.env, newServerConfig.env) ||
        oldConfig.type !== newServerConfig.type ||
        oldConfig.connectTimeoutMs !== newServerConfig.connectTimeoutMs
      ) {
        log("info", "Server config changed, deactivating stale connection", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        this.idleCallCounts.delete(namespace);
        this.adaptiveSkipLogged.delete(namespace);
        this.toolFilters.delete(namespace);
        // See the idle-reaper note: session activation is per-namespace state
        // with the same lifetime as the filter beside it.
        this.sessionActivated.delete(namespace);
        // Drop session-elicited credentials too — the connect spec changed,
        // so creds the user provided for the OLD spec may not match the
        // new one (different command/url/env wiring). Better to re-elicit
        // than silently inject stale values that produce a confusing failure.
        this.elicitedEnv.delete(namespace);
        changed = true;
      }
    }

    if (changed) {
      await this.refreshRoutesAndNotify();
    }
  }

  // Signature-on-demand: return one tool's full input schema without
  // persistently activating its server. When the server is already
  // loaded we read from the in-memory connection. When it isn't, we
  // spawn a transient upstream, extract the tool, and disconnect. The
  // transient path does NOT register the connection in this.connections
  // or toolRoutes — `mcp_connect_health` and `tools/list` stay unchanged
  // so the caller's context doesn't grow until they commit via activate.
  private async handleReadTool(
    serverArg: string,
    toolArg: string,
    progress?: ProgressReporter,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!serverArg) {
      return {
        content: [{ type: "text", text: "`server` is required (namespace of an installed MCP server)." }],
        isError: true,
      };
    }
    if (!toolArg) {
      return { content: [{ type: "text", text: "`tool` is required (name of the tool to inspect)." }], isError: true };
    }

    const serverConfig = this.config?.servers.find((s) => s.namespace === serverArg && s.isActive);
    if (!serverConfig) {
      return {
        content: [
          {
            type: "text",
            text: `"${serverArg}" is not in ~/.yaw-mcp/bundles.json. Call mcp_connect_discover to list available servers.`,
          },
        ],
        isError: true,
      };
    }

    // Policy gates, in the same order and with the same wording
    // runActivateOne uses. The transient path below still SPAWNS the
    // server's configured command with its resolved env (vault secrets
    // included) — "we disconnect afterwards" does not make executing a
    // deny-listed or below-floor server acceptable, and every other
    // surface (discover, dispatch, secrets, bundles, prewarm) narrows by
    // the profile before it reaches a server.
    if (!profileAllows(this.profile, serverArg)) {
      return {
        content: [
          {
            type: "text",
            text: `"${serverArg}" is not allowed by the project profile at ${this.profile?.path}.`,
          },
        ],
        isError: true,
      };
    }
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null && !passesMinCompliance(serverConfig.complianceGrade, minCompliance)) {
      return {
        content: [
          {
            type: "text",
            text: `Refused to load "${serverArg}": ${complianceRefusalReason(serverConfig.complianceGrade, minCompliance)}. Unset YAW_MCP_MIN_COMPLIANCE (or lower it) to override.`,
          },
        ],
        isError: true,
      };
    }

    // Fast path: server already loaded. Schema is already in context,
    // no network cost. Normalize with the live tool list so exact-match
    // takes priority over prefix-stripping.
    const existing = this.connections.get(serverArg);
    if (existing && existing.status === "connected") {
      const toolName = normalizeToolName(serverArg, toolArg, existing.tools);
      const tool = findTool(existing.tools, toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: formatToolNotFound(serverConfig, toolName, existing.tools) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: formatReadToolOutput({ tool, server: serverConfig, loaded: true }),
          },
        ],
      };
    }

    // Slow path: transient connect. Same spawn cost as activate, but
    // we tear down immediately after reading the tool list so the
    // server doesn't linger in the session.
    //
    // Accepted race: if an mcp_connect_activate for the same namespace
    // is in-flight via activateOne, this transient connect spawns a
    // SECOND upstream process. Both complete independently; the transient
    // is torn down in the finally block below, while activateOne's
    // connection is registered normally. The double-spawn is harmless
    // (two brief children, one wins the connections map) and fixing it
    // would require routing read_tool through activateOne's inflight
    // dedup map, which would change its semantics (persistent activation
    // vs transient inspection). Accepted as-is.
    progress?.(`Inspecting "${serverArg}" (transient — not loading into session)…`);
    let transient: UpstreamConnection | undefined;
    try {
      // Include any session-elicited credentials for this namespace so the
      // transient connect uses the same env as a persistent activation
      // would — otherwise schema inspection re-trips the missing-credential
      // error the user already supplied a value for this session.
      const elicitedForTransient = this.elicitedEnv.get(serverArg);
      const transientConfig = elicitedForTransient
        ? { ...serverConfig, env: { ...serverConfig.env, ...elicitedForTransient } }
        : serverConfig;
      transient = await connectToUpstream(transientConfig);
    } catch (err) {
      const message = err instanceof ActivationError ? err.message : err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Could not connect to "${serverArg}" to read tool schema: ${message}`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Normalize with the transient tool list so exact-match takes
      // priority over prefix-stripping.
      const toolName = normalizeToolName(serverArg, toolArg, transient.tools);
      const tool = findTool(transient.tools, toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: formatToolNotFound(serverConfig, toolName, transient.tools) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: formatReadToolOutput({ tool, server: serverConfig, loaded: false }),
          },
        ],
      };
    } finally {
      // Tear the transient connection down no matter what happened
      // above. Leaving it open would silently promote "read tool"
      // into "activate", which is exactly what this meta-tool exists
      // to avoid.
      await disconnectFromUpstream(transient).catch((e) =>
        log("warn", "transient disconnect after read_tool failed", {
          namespace: serverArg,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  // Values-free preview of which local-vault secrets each installed
  // server's `${secret:NAME}` env refs resolve to. NAMES ONLY -- this
  // reads the vault's KEY LIST (listKeys, no unlock, no passphrase) and
  // the servers' env-reference names, and NEVER calls getSecret /
  // decryptEntry. Servers with no refs are omitted.
  private async handleSecretsReport(
    serverArg?: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // Vault key list only -- no unlock, no decryption. A missing/unreadable
    // vault yields an empty key set, so every referenced name reports as
    // missing rather than erroring.
    const vault = await loadVault(vaultPath()).catch(() => null);
    const vaultKeys = new Set(vault ? listKeys(vault) : []);

    let servers = this.getProfiledActiveServers().map((s) => ({ namespace: s.namespace, env: s.env }));
    if (serverArg) servers = servers.filter((s) => s.namespace === serverArg);

    const rows = computeSecretsReport(servers, vaultKeys);

    if (serverArg && servers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No installed server with namespace "${serverArg}". Call mcp_connect_discover to list installed servers.`,
          },
        ],
        isError: true,
      };
    }

    if (rows.length === 0) {
      // Both scopes must read as a NEGATION. The single-server phrasing
      // needs its own verb ("does not reference") -- reusing the
      // all-servers sentence with a "Server \"gh\"" prefix produced
      // 'Server "gh" references any ${secret:NAME} vault values.', which
      // asserts the opposite of what happened.
      const sentence = serverArg
        ? `Server "${serverArg}" does not reference any \${secret:NAME} vault values.`
        : "No installed server references any ${secret:NAME} vault values.";
      return {
        content: [
          {
            type: "text",
            text: `${sentence} Add a reference in a server's env (e.g. GITHUB_TOKEN=\${secret:gh}) and store the value with \`yaw-mcp secrets set <name>\`.`,
          },
        ],
      };
    }

    // Names only -- no value ever appears in this payload.
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  }

  private handleHealth(): { content: Array<{ type: string; text: string }> } {
    const lines: string[] = [];
    if (this.profile) {
      // Label depends on which sources were loaded. If userPath is set,
      // both a project-local and a user-global profile contributed; show
      // both so it's obvious what's applied. Otherwise it's one or the
      // other — we can't tell which from `path` alone, so the generic
      // "Profile:" label covers both cases.
      if (this.profile.userPath) {
        lines.push(`Project profile: ${this.profile.path}`);
        lines.push(`User profile:    ${this.profile.userPath}`);
      } else {
        lines.push(`Profile: ${this.profile.path}`);
      }
      if (this.profile.servers?.length) lines.push(`  allow: ${this.profile.servers.join(", ")}`);
      if (this.profile.blocked?.length) lines.push(`  block: ${this.profile.blocked.join(", ")}`);
      lines.push("");
    }

    if (this.connections.size === 0) {
      lines.push("No servers loaded in this session yet.");
    } else {
      lines.push("Session health:\n");

      for (const [namespace, conn] of this.connections) {
        const h = conn.health;
        const avgLatency = h.totalCalls > 0 ? Math.round(h.totalLatencyMs / h.totalCalls) : 0;
        const errorRate = h.totalCalls > 0 ? Math.round((h.errorCount / h.totalCalls) * 100) : 0;
        const idleCount = this.idleCallCounts.get(namespace) ?? 0;
        const idleLimit = adaptiveThreshold(namespace, this.recentToolCalls, resolveIdleThreshold());
        const toolNames = conn.tools.map((t) => t.name).join(", ");

        lines.push(`  ${namespace} [${conn.status}] (${conn.config.type})`);
        lines.push(`    tools: ${conn.tools.length} — ${toolNames}`);
        lines.push(`    calls: ${h.totalCalls}, errors: ${h.errorCount} (${errorRate}%)`);
        lines.push(`    avg latency: ${avgLatency}ms`);
        lines.push(`    idle: ${idleCount}/${idleLimit} until auto-unload`);
        if (h.lastErrorMessage) {
          lines.push(`    last error: ${h.lastErrorMessage} at ${h.lastErrorAt}`);
        }
      }
    }

    // Cross-session reliability — flaky dormant servers pulled from
    // persisted learning. The in-session block above already covers
    // loaded namespaces with rich per-call telemetry; this surfaces
    // history for servers we AREN'T currently talking to so the LLM /
    // operator knows which ones have been unreliable before reloading
    // them. Threshold + sort shared with `yaw-mcp doctor` via
    // selectFlakyNamespaces (see usage-hints.ts).
    const now = Date.now();
    const flaky = selectFlakyNamespaces(
      this.learning.entries().filter(({ namespace }) => !this.connections.has(namespace)),
      5,
    );
    if (flaky.length > 0) {
      lines.push("\nCross-session reliability (dormant, <80% success):");
      for (const { namespace, usage } of flaky) {
        const rate = Math.round((usage.succeeded / usage.dispatched) * 100);
        const age = formatRelativeAge(now - usage.lastUsedAt);
        lines.push(`  ${namespace} — ${usage.dispatched} calls, ${rate}% success, last used ${age} ago`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Pack suggestion. Surfaces recurring multi-server tool-call sequences
  // observed in this session. Observation only — never activates
  // anything. Ranked by frequency primarily, with recency as a tiebreak
  // so the hottest-most-recent pattern sits at the top.
  private handleSuggest(): { content: Array<{ type: string; text: string }> } {
    const detected = this.packDetector.detectChains();
    if (detected.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No recurring multi-server patterns yet. Keep using tools across servers — once the same 2-3 server combination recurs in quick succession, it will show up here as a suggested pack.",
          },
        ],
      };
    }

    // Rank by frequency (primary) then recency (secondary). Both matter:
    // a pattern that repeated 5 times hours ago still beats one that
    // repeated twice last minute, but at equal frequency fresher wins.
    const ranked = [...detected].sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return b.lastSeenAt - a.lastSeenAt;
    });

    const lines: string[] = [
      // Pack history carries across yaw-mcp restarts (see persistence.ts),
      // so "recurring" isn't scoped to the live process — don't over
      // -claim with "this session" here.
      `Detected ${ranked.length} recurring server pack${ranked.length === 1 ? "" : "s"}:\n`,
    ];
    for (const pack of ranked) {
      const nsList = pack.namespaces.join(", ");
      const secondsAgo = Math.max(0, Math.round((Date.now() - pack.lastSeenAt) / 1000));
      lines.push(`  {${nsList}} — seen ${pack.frequency} times (last ${secondsAgo}s ago)`);
    }
    // Nudge toward the concrete action. `mcp_connect_activate` is the
    // loading meta-tool — `dispatch` is for invoking tools on servers
    // that are already active, so pointing at dispatch here used to
    // send the model the wrong direction.
    const top = ranked[0];
    const nsJson = JSON.stringify(top.namespaces);
    lines.push(`\nTo load the top pack in one step, call \`mcp_connect_activate\` with namespaces=${nsJson}.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Curated multi-server bundles. Static client-side data (see bundles.ts)
  // — no network call. `action=list` prints every bundle with a ready-to-
  // run `mcp_connect_activate` snippet; `action=match` cross-references
  // the installed server list and partitions into fully-ready vs
  // partially-installed so the caller only sees bundles that are actually
  // actionable with the servers in bundles.json.
  private handleBundles(action: "list" | "match"): { content: Array<{ type: string; text: string }> } {
    if (action === "list") {
      const lines: string[] = [`Curated server bundles (${CURATED_BUNDLES.length}):\n`];
      for (const bundle of CURATED_BUNDLES) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    servers: ${JSON.stringify(bundle.namespaces)}`);
        lines.push(`    activate: ${bundleActivateHint(bundle)}`);
      }
      lines.push("");
      lines.push(
        'Call mcp_connect_bundles with action="match" to filter these against the servers already in the user\'s bundles.json.',
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // action === "match"
    const installedNamespaces = this.getProfiledActiveServers().map((s) => s.namespace);
    const { ready, partial } = matchBundles(installedNamespaces);

    if (ready.length === 0 && partial.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No curated bundles match your currently installed servers. Browse the catalog at https://yaw.sh/mcp/catalog/ and add what a bundle needs with `yaw-mcp add <slug>`, then restart this MCP client and re-run mcp_connect_bundles.",
          },
        ],
      };
    }

    const lines: string[] = [];

    if (ready.length > 0) {
      lines.push("Bundles ready to activate now:");
      for (const bundle of ready) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    servers: ${JSON.stringify(bundle.namespaces)}`);
        lines.push(`    activate: ${bundleActivateHint(bundle)}`);
      }
    }

    if (partial.length > 0) {
      if (ready.length > 0) lines.push("");
      lines.push("Bundles partially installed:");
      for (const entry of partial) {
        const { bundle, have, missing } = entry;
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    have: ${have.join(", ")}`);
        lines.push(`    missing: ${missing.join(", ")} (add with: yaw-mcp add ${missing.join(" && yaw-mcp add ")})`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Extract the semantic payload from a successful MCP tool result for use
  // as a step binding in exec pipelines. The MCP wire format wraps every
  // result in `{ content: [{type, text}, ...], isError? }`, but the exec
  // tool description promises `$ref` targets that behave like the tool's
  // actual output -- e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number)`.
  //
  // Rules, in order:
  //   1. Single text item whose text is valid JSON -> the parsed JSON value.
  //   2. Single text item (non-JSON) -> the raw text string.
  //   3. Everything else (multi-item, non-text, empty) -> the content array.
  //
  // This is intentionally simple and loss-free: callers can still reach
  // the full wire payload via the `partial` / `steps` objects if needed.
  private static parseStepPayload(result: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }): unknown {
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1) return content ?? [];
    const item = content[0];
    if (item.type !== "text" || typeof item.text !== "string") return content;
    try {
      return JSON.parse(item.text);
    } catch {
      return item.text;
    }
  }

  // Declarative pipeline executor. Runs N tool calls in order, binding
  // each output under the step's id (or positional index), and lets
  // later steps splice those outputs into their args via
  // `{"$ref": "<id>.path"}` markers. No eval, no expression language —
  // the only dynamic behavior is the ref resolver in exec-engine.ts.
  //
  // Failure model: any step error fails the whole exec. The caller gets
  // the failed step's id/index, the error string, and the outputs of
  // the steps that did complete so they can reason about how far the
  // pipeline got without re-running the good ones.
  //
  // Meta-tool calls are rejected: exec only routes to upstream tools,
  // because recursively dispatching meta-tools (exec inside exec,
  // activate from exec) would hide side-effects that belong at the
  // top level of the model's reasoning.
  private async handleExec(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const validation = validateExecRequest(args);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `exec: ${validation.message}` }],
        isError: true,
      };
    }

    const steps = (args.steps as ExecStepInput[]).map((s) => ({
      id: typeof s.id === "string" ? s.id : undefined,
      tool: s.tool,
      args: (s.args ?? {}) as Record<string, unknown>,
    }));
    const explicitReturn = typeof args.return === "string" ? args.return : undefined;

    const bindings: Record<string, unknown> = {};
    const stepKeys: string[] = [];
    // stepKey -> namespace, built as steps run, so a failing step can
    // attribute cascading blame to the upstream steps it consumed via $ref.
    const stepNamespaces = new Map<string, string>();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const key = stepBindingKey(step, i);
      stepKeys.push(key);

      // Resolve $ref markers against the running bindings map BEFORE the
      // tool call goes out, so the upstream sees a concrete args object.
      let resolvedArgs: Record<string, unknown>;
      try {
        const resolved = resolveArgs(step.args, bindings);
        // validateExecRequest already ensured step.args is an object,
        // and resolveArgs only produces non-object values when the ENTIRE
        // args is itself a $ref node — which is legal (a step can take
        // its full args from a prior step) but must still be an object.
        if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    failedStep: key,
                    error: `step "${key}": resolved args are not an object (${typeof resolved})`,
                    partial: bindings,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        resolvedArgs = resolved as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof RefError ? err.message : err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: `step "${key}": ${msg}`,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Meta-tools are callable by the client directly; routing them
      // through exec would let a step, say, deactivate the server
      // another step is about to use. Keep exec's surface narrowly
      // proxy-only.
      // Cast: META_TOOL_NAMES is a Set typed over the literal meta-tool
      // names, but step.tool is a user-supplied string. The cast widens
      // `.has()` to accept arbitrary strings without losing the runtime
      // check.
      if ((META_TOOL_NAMES as Set<string>).has(step.tool)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: `step "${key}": meta-tool "${step.tool}" cannot be called from exec; call it directly`,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Dispatch through the same handleToolCall path that normal
      // tool-calls use. This reuses the auto-reconnect, deferred-route,
      // and pack-detector logic so exec steps behave identically to
      // direct calls — the caller pays no per-step cost in surprises.
      //
      // `extra` is omitted so exec steps don't fight for the top-level
      // progress token; the exec itself emits no progress.
      // Step-level (process) reward: defer the proxy path's learning signal
      // and attribute credit per step here, using the $ref dependency graph
      // so a step that fails on bad INPUT it consumed from an upstream step
      // shares the blame rather than sinking the upstream alone.
      // Snapshot the route map for THIS step before the lookup, and use
      // the snapshot for the call's blame attribution -- the same
      // discipline handleToolCall documents at its entry. Per-step (not
      // per-exec): an earlier step can legitimately rebuild routes by
      // activating a deferred server, so the next step must re-snapshot
      // rather than reuse a map captured before the pipeline started.
      const routes = this.toolRoutes;
      const stepNs = routes.get(step.tool)?.namespace;
      if (stepNs) stepNamespaces.set(key, stepNs);
      const stepResult = await this.handleToolCall(step.tool, resolvedArgs, undefined, { deferLearning: true });

      if (stepResult.isError) {
        const errText = stepResult.content?.[0]?.text ?? "unknown error";
        // Internal routing/cache faults (stale toolCache, dropped connection,
        // failed auto-reconnect, unknown tool) are NOT the upstream's failure,
        // so don't penalize the namespace's reliability for them.
        const routingFault = isRoutingFaultText(errText);
        if (stepNs && !routingFault) {
          // Invalid-params is recognized either by the transport-level code
          // tag ("[code=-32602]") OR by classifyError on a structured isError
          // body (the common MCP self-validation pattern, which carries no
          // code tag). When the failing step consumed $ref data from earlier
          // steps, the bad input likely came from a producer — split the blame
          // instead of full-blaming this server. Other errors are this
          // server's own failure (0.0).
          const inputShaped = errText.includes("[code=-32602]") || classifyError(errText) === "validation_error";
          const deps = collectRefDeps(step.args);
          if (inputShaped && deps.length > 0) {
            // The consumer failed and was never booked, so record its half
            // credit as a fresh dispatch. Each producer, however, ALREADY
            // booked its own dispatch when its step succeeded (recordOutcome
            // below) — booking it again here would double-count one real
            // dispatch (dispatched=2). Dock its earned credit with a
            // delta-only adjustment instead, leaving the dispatch count intact.
            this.learning.recordOutcome(stepNs, 0.5);
            for (const dep of deps) {
              const depNs = stepNamespaces.get(dep);
              if (depNs) this.learning.adjustSucceeded(depNs, -0.5);
            }
          } else {
            this.learning.recordOutcome(stepNs, 0);
          }
          this.scheduleStateSave();
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: errText,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      if (stepNs) {
        // Grade the success the same way the proxy path does -- an empty or
        // error-shaped 200 must not bank full 1.0 credit just because it
        // wasn't flagged isError.
        this.learning.recordOutcome(stepNs, computeOutcomeReward(stepResult));
        this.scheduleStateSave();
      }
      bindings[key] = ConnectServer.parseStepPayload(stepResult);
    }

    const returnKey = explicitReturn ?? stepKeys[stepKeys.length - 1];
    const finalResult = bindings[returnKey];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              result: finalResult,
              steps: bindings,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  async shutdown(): Promise<void> {
    log("info", "Shutting down yaw-mcp");

    // Latch FIRST: activateOne refuses from here on, so nothing new can be
    // registered into this.connections behind the teardown below.
    this.shuttingDown = true;

    // Flush any pending state save before we stop accepting writes.
    // Cancels the debounce timer so no stale snapshot writes after.
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    if (this.persistenceReady) {
      await this.flushStateSave();
    }

    // Drain activations that were already past the gate when we latched.
    // start()'s fire-and-forget prewarm can have several children mid-
    // handshake; each one registers its connection on resolve. Snapshotting
    // this.connections without waiting would miss them entirely, leaving
    // live child processes nobody ever disconnects (the parent exiting is
    // what masks this in production, not any cleanup we do).
    //
    // BOUNDED, deliberately. A single runActivateOne can burn a 15s connect
    // timeout (upstream.ts) retried once, plus a 60s elicitInput round-trip
    // — an unbounded await here outlives index.ts's 10s force-exit timer, so
    // a SIGTERM landing on a cold npx handshake would sit for 10s and then
    // exit(1) instead of exiting 0 promptly. 2s is what we can spend and
    // still finish: the disconnects below race the SDK's stdio close timers
    // (2s, twice) and then server.close() has to run, which leaves ~4s of
    // headroom under the 10s cap. Anything an activation needs beyond 2s was
    // never going to fit under that cap anyway, so waiting for it only buys
    // a forced exit(1).
    if (this.activationInflight.size > 0) {
      log("info", "Waiting for in-flight activations before teardown", { count: this.activationInflight.size });
      const drained = await settledWithin(
        Promise.allSettled([...this.activationInflight.values()]),
        ConnectServer.SHUTDOWN_DRAIN_MS,
      );
      if (!drained) {
        log("warn", "In-flight activations did not settle in time — tearing down anyway", {
          budgetMs: ConnectServer.SHUTDOWN_DRAIN_MS,
          count: this.activationInflight.size,
        });
      }
    }

    // An activation that landed during the drain calls scheduleStateSave()
    // for its freshly learned tool list, which re-arms the debounce timer we
    // cleared above — and that timer is unref'd, so it never fires before
    // the process exits. Flush once more when the drain re-armed it, so
    // bounding the drain cannot cost state the pre-drain flush would have
    // banked.
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
      if (this.persistenceReady) await this.flushStateSave();
    }

    // Disconnect all upstreams
    const disconnects = Array.from(this.connections.values()).map((conn) => disconnectFromUpstream(conn));
    await Promise.allSettled(disconnects);
    this.connections.clear();
    // Drop session-elicited credentials, as the field's contract promises.
    // Plaintext values the user typed must not survive a shutdown into an
    // embedded/test host that reuses the instance.
    this.elicitedEnv.clear();
    this.inflightCalls.clear();

    await this.server.close();

    log("info", "yaw-mcp shutdown complete");
  }

  // Debounced save trigger. Called after every learning/pack-detector
  // write — the timer collapses bursts into one write so a busy session
  // isn't writing the state file 10×/sec. Silently no-ops until start()
  // has hydrated state, which keeps unit tests that skip start() from
  // touching the user's ~/.yaw-mcp/state.json.
  private scheduleStateSave(): void {
    if (!this.persistenceReady) return;
    if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      this.flushStateSave().catch(() => {});
    }, ConnectServer.STATE_SAVE_DEBOUNCE_MS);
    if (this.stateSaveTimer.unref) this.stateSaveTimer.unref();
  }

  private async flushStateSave(): Promise<void> {
    await saveState({
      learning: this.learning.exportSnapshot(),
      packHistory: this.packDetector.exportSnapshot(),
      toolCache: this.exportToolCache(),
    });
  }
}
