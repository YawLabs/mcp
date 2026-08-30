// Chain detection. Watches tool-call sequences across namespaces and
// surfaces recurring multi-server patterns as suggested "packs" the
// LLM/user could dispatch in one step via mcp_connect_dispatch.
//
// Scope is intentionally small:
//   - Snapshots persist across restarts via exportSnapshot/loadSnapshot
//     (see persistence.ts); ConnectServer owns the load/save timing.
//   - Observation only. Detection never activates a server — we surface
//     the suggestion and let the caller decide.
//   - Short time window. A "chain" is a burst of calls across ≥2 distinct
//     namespaces with small gaps between consecutive calls. Slow meanders
//     across a day aren't a pack, they're just usage.
//
// The packId is the sorted-unique namespace set; that way [gh, linear, gh]
// and [gh, linear] count toward the same {gh, linear} pack. Order is
// remembered in the original sequence list but not in the identity.

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_GAP_MS = 120_000; // 120s between consecutive calls
const MIN_NAMESPACES = 2;
const MAX_NAMESPACES = 3;
const MIN_RECURRENCES = 2;
// A burst also closes once it has SPANNED maxGapMs * BURST_SPAN_FACTOR
// (10 min at the defaults), even with no idle gap. Without this ceiling a
// continuous agent session -- tool calls seconds apart for half an hour --
// collapses into ONE burst, so its namespace set occurs exactly once and
// MIN_RECURRENCES rejects it: the detector returned [] for precisely the
// workload it targets. Slicing long sessions into span-bounded windows
// makes recurrence WITHIN a session countable.
const BURST_SPAN_FACTOR = 5;

export interface PackCall {
  namespace: string;
  toolName: string;
  at: number;
}

export interface DetectedPack {
  namespaces: string[];
  frequency: number;
  lastSeenAt: number;
}

export interface PackDetectorOptions {
  maxHistory?: number;
  maxGapMs?: number;
}

interface Burst {
  namespaces: string[]; // distinct, order-of-first-appearance
  startAt: number;
  lastAt: number;
}

function packIdFromNamespaces(namespaces: string[]): string {
  // Sort for set-identity; dedupe defensively (callers already dedupe).
  return Array.from(new Set(namespaces)).sort().join("|");
}

export class PackDetector {
  private readonly maxHistory: number;
  private readonly maxGapMs: number;
  private history: PackCall[] = [];

  constructor(options: PackDetectorOptions = {}) {
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  }

  recordCall(namespace: string, toolName: string, at: number): void {
    if (!namespace || !toolName) return;
    this.history.push({ namespace, toolName, at });
    if (this.history.length > this.maxHistory) {
      // Drop the oldest entries once we exceed the cap. Slice once
      // rather than shift-per-call so push-heavy sessions stay O(1)
      // amortized.
      const overflow = this.history.length - this.maxHistory;
      this.history = this.history.slice(overflow);
    }
  }

  // Walk the history, segmenting it into "bursts" (see segmentBursts for
  // the three boundaries). Each burst with ≥2 distinct namespaces is a
  // candidate pack. A pack is returned when the same namespace set
  // appears in ≥MIN_RECURRENCES bursts.
  detectChains(): DetectedPack[] {
    if (this.history.length < 2) return [];

    const bursts = this.segmentBursts();
    // Fold each burst's distinct-namespace set into pack counts.
    const packCounts = new Map<string, { namespaces: string[]; frequency: number; lastSeenAt: number }>();

    for (const burst of bursts) {
      if (burst.namespaces.length < MIN_NAMESPACES) continue;
      // UNREACHABLE today, kept as a guard: segmentBursts cuts a burst at the
      // overflow boundary, so no burst reaching here can carry more than
      // MAX_NAMESPACES namespaces. It survives because the pack-size cap is a
      // detectChains-level invariant -- if the overflow cut is ever relaxed or
      // a caller builds bursts another way, this is what keeps an over-wide
      // set out of the results instead of surfacing an undispatchable pack.
      if (burst.namespaces.length > MAX_NAMESPACES) continue;
      const id = packIdFromNamespaces(burst.namespaces);
      const prev = packCounts.get(id);
      if (prev) {
        prev.frequency += 1;
        if (burst.lastAt > prev.lastSeenAt) prev.lastSeenAt = burst.lastAt;
      } else {
        packCounts.set(id, {
          namespaces: [...burst.namespaces],
          frequency: 1,
          lastSeenAt: burst.lastAt,
        });
      }
    }

    const packs: DetectedPack[] = [];
    for (const entry of packCounts.values()) {
      if (entry.frequency >= MIN_RECURRENCES) {
        packs.push({
          namespaces: entry.namespaces,
          frequency: entry.frequency,
          lastSeenAt: entry.lastSeenAt,
        });
      }
    }
    return packs;
  }

  // Segment the call history into bursts. A new burst starts whenever:
  //   1. the gap to the previous call exceeds maxGapMs (idle boundary);
  //   2. the burst has already spanned maxGapMs * BURST_SPAN_FACTOR
  //      (span boundary -- see the constant for why a continuous session
  //      must be sliced for recurrence to be countable); or
  //   3. the call would add a namespace past MAX_NAMESPACES (overflow
  //      boundary). detectChains drops an over-wide burst entirely, so
  //      without this cut a single visit to a 4th namespace poisoned the
  //      whole burst and the recurring trio inside it was never counted.
  //      Cutting at the overflow keeps each burst representable as a
  //      pack; a wider rotation surfaces as its recurring 3-subsets, the
  //      best answer the MAX_NAMESPACES pack-size cap can express.
  // Within a burst, each namespace is recorded only once
  // (order-of-first-appearance); the "last seen" timestamp tracks the
  // most recent call in the burst so recency ranking is truthful even
  // when the burst has many calls.
  private segmentBursts(): Burst[] {
    const bursts: Burst[] = [];
    const maxBurstSpanMs = this.maxGapMs * BURST_SPAN_FACTOR;
    let current: Burst | null = null;
    let prevAt = 0;

    for (const call of this.history) {
      const gapExceeded = call.at - prevAt > this.maxGapMs;
      const spanExceeded = current !== null && call.at - current.startAt > maxBurstSpanMs;
      // Both comparisons above are one-sided (`>`), so a BACKWARDS `at` -- a
      // wall-clock step during a live session, or a snapshot that reached us
      // out of order -- makes both false and welds every later call into the
      // burst that preceded the jump, manufacturing a pack that never ran.
      // We cannot tell how much real time passed across a non-monotonic step,
      // so treat it as a boundary.
      const wentBackwards = current !== null && call.at < prevAt;
      const wouldOverflow =
        current !== null && current.namespaces.length >= MAX_NAMESPACES && !current.namespaces.includes(call.namespace);
      if (!current || gapExceeded || spanExceeded || wentBackwards || wouldOverflow) {
        current = { namespaces: [call.namespace], startAt: call.at, lastAt: call.at };
        bursts.push(current);
      } else {
        if (!current.namespaces.includes(call.namespace)) {
          current.namespaces.push(call.namespace);
        }
        current.lastAt = call.at;
      }
      prevAt = call.at;
    }

    return bursts;
  }

  // Exposed for tests.
  getHistory(): ReadonlyArray<PackCall> {
    return this.history;
  }

  reset(): void {
    this.history = [];
  }

  // Return a defensive copy of history for persistence. Each entry is a
  // fresh object, safe to JSON.stringify without worrying about later
  // mutations to the detector's internal array.
  exportSnapshot(): PackCall[] {
    return this.history.map((c) => ({ namespace: c.namespace, toolName: c.toolName, at: c.at }));
  }

  // Replace in-memory history with the given snapshot. Respects the
  // configured maxHistory cap — if the snapshot exceeds it, the oldest
  // entries are dropped, matching the cap behavior of recordCall.
  //
  // Entries are SORTED by `at` after cleaning. segmentBursts reads the history
  // as a time-ordered stream (see the boundary comparisons there), and the
  // snapshot comes off disk where a hand-edited, merged or torn file can carry
  // entries out of order; an out-of-order run would otherwise be segmented as
  // one welded burst plus spurious boundaries. Sorting is stable, so equal
  // timestamps keep their recorded order.
  //
  // `at` is validated as a finite number, not just present: the snapshot
  // comes off disk (persistence.ts) where a hand-edited or torn file can
  // carry null / "12345" / NaN. segmentBursts compares `call.at - prevAt >
  // maxGapMs`, and every comparison against NaN is false, so a single NaN
  // timestamp silently welds the whole history into one giant burst and
  // manufactures packs that never happened.
  loadSnapshot(snapshot: ReadonlyArray<PackCall>): void {
    const clean: PackCall[] = [];
    for (const c of snapshot) {
      if (!c?.namespace || !c.toolName) continue;
      if (typeof c.at !== "number" || !Number.isFinite(c.at)) continue;
      clean.push({ namespace: c.namespace, toolName: c.toolName, at: c.at });
    }
    clean.sort((a, b) => a.at - b.at);
    if (clean.length > this.maxHistory) {
      this.history = clean.slice(clean.length - this.maxHistory);
    } else {
      this.history = clean;
    }
  }
}
