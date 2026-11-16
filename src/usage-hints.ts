import { LEARNING_MIN_OBSERVATIONS, type NamespaceUsage, PENALTY_RATE_THRESHOLD } from "./learning.js";
import type { DetectedPack } from "./pack-detect.js";

// Inline usage hints for discover() output. Two signals:
//
//   1. Use recorded by LearningStore — "you called a tool on this server
//      N times." Populated on the proxy path in handleToolCall through
//      recordOutcome, which counts the call and banks a GRADED reward in
//      [0,1] for it rather than a binary answered/errored flag. The line
//      shows once the banked credit reaches one full success and prints
//      `dispatched`: the routed calls, failed ones included, plus any
//      routing misses booked against the server (see formatUsageHint).
//      Activation alone doesn't contribute.
//
//   2. Co-activation peers from PackDetector — "when you loaded X
//      you usually had Y loaded too." Populated by successful proxied
//      tool calls across ≥2 distinct namespaces within a short gap.
//
// Both signals persist across yaw-mcp restarts via ~/.yaw-mcp/state.json
// (see persistence.ts) so a freshly-started session still knows which
// servers the user has been relying on. Counts are cumulative since
// persistence started, not just the live process, and are not a count of
// successes: `dispatched` includes calls that failed and booked misses.
// Set YAW_MCP_DISABLE_PERSISTENCE=1 to keep signals session-local only.

// Cap on peers per hint. Keeps the discover() line length bounded —
// more than ~3 peers quickly drowns out the rest of the server card.
const MAX_PEERS = 3;
const MIN_SUCCESS_TO_SHOW = 1;

// The dormant-reliability thresholds below are LEARNING_MIN_OBSERVATIONS
// and PENALTY_RATE_THRESHOLD, used directly rather than re-exported under
// reliability-flavoured names. handleHealth and `yaw-mcp doctor` share the
// "what counts as flaky" definition by calling selectFlakyNamespaces /
// formatReliabilityWarning, not by importing a threshold -- so a local
// alias bought nothing and only added a second name for one number.
// Reading the learning-store constants here (rather than mirroring them)
// is what keeps the hint describing exactly the population the routing
// penalty depresses; change them in learning.ts and both surfaces move.

// Flatten detected packs into a per-namespace peer list. Each pack is
// a set of 2-3 namespaces that co-occurred in ≥2 bursts; the map
// entry for namespace N lists every OTHER namespace that appeared in
// any pack containing N.
//
// Pass `installed` (the namespaces currently in bundles.json) to drop
// namespaces the user has since removed. Pack history is PERSISTED across
// restarts, so without the filter discover() prints `often loaded with
// "<ns>"` about a server that can no longer be activated at all -- the
// adjacent Suggested-packs block already filters exactly this way. Omitting
// the argument keeps the raw history, which is only right for a caller that
// has no installed list to check against.
//
// Output is sorted + deduped so rendering is stable across calls even
// as the underlying pack list's internal order shifts.
export function buildCoUsageMap(packs: DetectedPack[], installed?: ReadonlySet<string>): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  const isInstalled = (ns: string): boolean => installed === undefined || installed.has(ns);
  for (const pack of packs) {
    const namespaces = pack.namespaces.filter(isInstalled);
    for (const ns of namespaces) {
      const bucket = result.get(ns) ?? new Set<string>();
      for (const peer of namespaces) {
        if (peer !== ns) bucket.add(peer);
      }
      // A pack whose other members were all filtered out leaves no peer to
      // name, so it earns no entry rather than an empty one.
      if (bucket.size > 0) result.set(ns, bucket);
    }
  }
  const sorted = new Map<string, string[]>();
  for (const [ns, peers] of result) {
    sorted.set(ns, Array.from(peers).sort());
  }
  return sorted;
}

// Render a one-line "usage:" hint summarizing the two signals. Returns
// null when neither signal has enough evidence — the caller should
// skip the line entirely rather than print "usage: —" or similar.
//
// The string form starts with "usage: " so the LLM can scan past it
// cheaply and the prefix is consistent with other diagnostic lines
// (warn:, known tools:).
export function formatUsageHint(usage: NamespaceUsage | undefined, coUsedWith: string[]): string | null {
  const parts: string[] = [];
  if (usage && usage.succeeded >= MIN_SUCCESS_TO_SHOW) {
    // No "this session" qualifier: with cross-session persistence the
    // count is cumulative (restored from state.json on startup). Tacking
    // "this session" on overclaims freshness; dropping it is both
    // shorter and accurate in both persistence-on and opt-out states.
    // The GATE above reads `succeeded` (a SUM of graded rewards in [0,1], see
    // learning.ts): a server that never earned one full success of credit
    // gets no "used" line. The NUMBER printed is `dispatched`, the integer
    // the reliability line calls "past calls": one per routed call, plus
    // one per routing miss LearningStore.recordMiss booked against the
    // server. So it is calls plus booked misses, not strictly calls: one
    // call followed by one booked miss prints "used 2x". That is accepted
    // -- it is the same integer the reliability line prints, so the two
    // lines never disagree -- and it is far closer to what "used Nx" reads
    // as than the rounded credit it used to print: ten calls that each
    // earned 0.2 showed "used 2x". How well those calls went is the
    // reliability line's job (formatReliabilityWarning).
    parts.push(`used ${usage.dispatched}x`);
  }
  if (coUsedWith.length > 0) {
    const shown = coUsedWith.slice(0, MAX_PEERS);
    const more = coUsedWith.length - shown.length;
    const names = shown.map((n) => `"${n}"`).join(", ");
    const tail = more > 0 ? ` +${more} more` : "";
    parts.push(`often loaded with ${names}${tail}`);
  }
  if (parts.length === 0) return null;
  return `usage: ${parts.join("; ")}`;
}

// Dormant-reliability warning rendered inline under the server card in
// discover(). Returns null unless the persisted learning for this namespace
// shows at least LEARNING_MIN_OBSERVATIONS dispatches AND a success rate
// below PENALTY_RATE_THRESHOLD -- the same two constants the dispatch-time
// penalty reads, so the warning fires exactly when the penalty does. Caller
// is responsible for suppressing this when the server is currently loaded
// (the live health warning takes precedence there -- see
// formatHealthWarning).
export function formatReliabilityWarning(usage: NamespaceUsage | undefined): string | null {
  if (!usage || usage.dispatched < LEARNING_MIN_OBSERVATIONS) return null;
  const rate = usage.succeeded / usage.dispatched;
  if (rate >= PENALTY_RATE_THRESHOLD) return null;
  const pct = Math.round(rate * 100);
  return `reliability: ${pct}% success across ${usage.dispatched} past calls`;
}

export interface FlakyNamespaceEntry {
  namespace: string;
  usage: NamespaceUsage;
}

// Shared selector for the flaky-namespace lists shown by handleHealth
// and `yaw-mcp doctor`'s RELIABILITY section. Filter rules are the same as
// formatReliabilityWarning; sort is worst-rate first, tie-break by most
// calls (more evidence = more credible), then alphabetical so output is
// deterministic. Caller passes any pre-filter (e.g., handleHealth
// excludes currently-connected namespaces).
export function selectFlakyNamespaces(entries: Iterable<FlakyNamespaceEntry>, limit: number): FlakyNamespaceEntry[] {
  if (limit <= 0) return [];
  return Array.from(entries)
    .filter(({ usage }) => {
      if (usage.dispatched < LEARNING_MIN_OBSERVATIONS) return false;
      return usage.succeeded / usage.dispatched < PENALTY_RATE_THRESHOLD;
    })
    .sort((a, b) => {
      const aRate = a.usage.succeeded / a.usage.dispatched;
      const bRate = b.usage.succeeded / b.usage.dispatched;
      if (aRate !== bRate) return aRate - bRate;
      if (a.usage.dispatched !== b.usage.dispatched) return b.usage.dispatched - a.usage.dispatched;
      return a.namespace.localeCompare(b.namespace);
    })
    .slice(0, limit);
}
