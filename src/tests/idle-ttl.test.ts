import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTIVE_BONUS_CAP,
  ADAPTIVE_LOOKBACK,
  ADAPTIVE_MAX,
  ADAPTIVE_MIN,
  ADAPTIVE_WINDOW_MS,
  adaptiveThreshold,
  HISTORY_LIMIT,
  pushToolCall,
  type ToolCallRecord,
} from "../idle-ttl.js";

// Fixed "now" used throughout tests so relative timestamps read easily.
const NOW = 1_700_000_000_000;

function record(namespace: string, offsetMs: number): ToolCallRecord {
  return { namespace, at: NOW - offsetMs };
}

describe("adaptiveThreshold", () => {
  it("returns base when there's no history at all", () => {
    expect(adaptiveThreshold("gh", [], 10, NOW)).toBe(10);
  });

  it("returns base when the namespace has no recent activity", () => {
    // History has other namespaces but not `gh`.
    const history: ToolCallRecord[] = [record("slack", 1000), record("jira", 2000), record("slack", 500)];
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10);
  });

  it("returns base when gh was called long ago (outside the window)", () => {
    // Just outside the 5-minute window.
    const outsideWindow = ADAPTIVE_WINDOW_MS + 1;
    const history = [record("gh", outsideWindow), record("gh", outsideWindow + 1000)];
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10);
  });

  it("adds 2 per recent same-namespace call", () => {
    const history = [record("gh", 10_000), record("gh", 20_000), record("gh", 30_000)];
    // 3 recent gh calls → bonus = min(3*2, 20) = 6 → 10 + 6 = 16
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(16);
  });

  it("caps the adaptive bonus at ADAPTIVE_BONUS_CAP", () => {
    // 15 recent gh calls — raw bonus 30, capped to 20.
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 15; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10 + ADAPTIVE_BONUS_CAP);
  });

  it("honors a custom base (env-var override)", () => {
    const history = [record("gh", 10_000), record("gh", 20_000)];
    // 2 recent gh calls → bonus 4 → base 15 + 4 = 19
    expect(adaptiveThreshold("gh", history, 15, NOW)).toBe(19);
  });

  it("clamps final result to ADAPTIVE_MIN (5) when base is smaller", () => {
    // Contrived: someone passes base=1 with no activity. We still
    // refuse to deactivate after fewer than 5 idle calls.
    expect(adaptiveThreshold("gh", [], 1, NOW)).toBe(ADAPTIVE_MIN);
  });

  it("snaps a non-finite base to ADAPTIVE_MIN instead of returning NaN", () => {
    // The realistic source is Number(process.env.MCP_CONNECT_IDLE_THRESHOLD)
    // over a non-numeric value. NaN fails BOTH clamp comparisons, so before
    // the guard this returned NaN -- and `idleCalls >= NaN` is always false,
    // i.e. the namespace never deactivated at all. That is the opposite of
    // the documented "never deactivate faster than ADAPTIVE_MIN" floor.
    expect(adaptiveThreshold("gh", [], Number.NaN, NOW)).toBe(ADAPTIVE_MIN);
    // Also with activity present, so the bonus path cannot mask it.
    const history = [record("gh", 10_000), record("gh", 20_000)];
    expect(adaptiveThreshold("gh", history, Number.NaN, NOW)).toBe(ADAPTIVE_MIN);
    expect(adaptiveThreshold("gh", [], Number.POSITIVE_INFINITY, NOW)).toBe(ADAPTIVE_MIN);
    expect(adaptiveThreshold("gh", [], Number.NEGATIVE_INFINITY, NOW)).toBe(ADAPTIVE_MIN);
  });

  it("clamps final result to ADAPTIVE_MAX (50)", () => {
    // Contrived: base=40 + full bonus cap 20 = 60 → clamped to 50.
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 20; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 40, NOW)).toBe(ADAPTIVE_MAX);
  });

  it("distinguishes namespaces — bursty gh does not help slack", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 10; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBeGreaterThan(10);
    expect(adaptiveThreshold("slack", history, 10, NOW)).toBe(10);
  });

  it("only considers same-namespace calls within the time window", () => {
    // 2 recent gh calls, 3 old ones outside the window. Only the 2
    // recent count toward the bonus.
    const history = [
      record("gh", ADAPTIVE_WINDOW_MS + 1000), // old
      record("gh", ADAPTIVE_WINDOW_MS + 2000), // old
      record("gh", ADAPTIVE_WINDOW_MS + 3000), // old
      record("gh", 10_000), // recent
      record("gh", 20_000), // recent
    ];
    // 2 recent → bonus 4 → 14
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(14);
  });

  it("uses Date.now() by default when no explicit now is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const history = [record("gh", 10_000), record("gh", 20_000)];
      // 2 recent → bonus 4 → 14
      expect(adaptiveThreshold("gh", history, 10)).toBe(14);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only considers the last ADAPTIVE_LOOKBACK same-namespace entries (cap)", () => {
    // Build a history with ADAPTIVE_LOOKBACK + 5 recent gh entries. All are
    // within the time window, but only ADAPTIVE_LOOKBACK of them should be
    // examined. Each counts as +2 bonus; capping at ADAPTIVE_LOOKBACK entries
    // means the bonus is min(ADAPTIVE_LOOKBACK * 2, ADAPTIVE_BONUS_CAP).
    // ADAPTIVE_LOOKBACK=20, ADAPTIVE_BONUS_CAP=20 -> bonus=20 regardless of
    // whether we examine 20 or 25 entries (both saturate the cap at 20).
    // To make the cap *observable*, we need a history where beyond-cap entries
    // would change the result if they were counted. We do that by mixing
    // "far future" timestamps (would count as extra recent hits if examined)
    // past the cap position, and OLD timestamps (outside the window) at the
    // cap boundary.
    //
    // Strategy: place ADAPTIVE_LOOKBACK entries outside the window (old) and
    // then 5 entries inside the window. The cap stops the walk at the 20th
    // same-ns entry, which is one of the old ones. Only the 5 recent inner
    // entries are within the window, contributing 5*2=10 bonus, not 20.
    // If the cap were absent the walk would continue and find all old entries
    // too (but they're outside the window so bonus stays 10 either way --
    // we need a different arrangement).
    //
    // Actually simpler arrangement: 5 recent "inner" entries PLUS
    // ADAPTIVE_LOOKBACK entries that are ALSO recent but interleaved with
    // OTHER-namespace entries so they appear beyond the cap. After walking
    // back ADAPTIVE_LOOKBACK same-ns hits (the 5 + 15 from the deep set),
    // any remaining recent same-ns entries should be ignored.
    //
    // Clearest proof: build a history of exactly ADAPTIVE_LOOKBACK + 10
    // recent same-ns entries (all within the window). Without the cap all
    // 30 would be counted but the bonus is already capped at ADAPTIVE_BONUS_CAP
    // so we can't distinguish 20 vs 30 that way. Instead use a low-enough
    // count so that "first ADAPTIVE_LOOKBACK" vs "all entries" produces a
    // different bonus when the cap fires.
    //
    // Use ADAPTIVE_LOOKBACK=20 entries: the first (newest) 5 are WITHIN the
    // window, the next 15 are OUTSIDE the window. Then add 5 more entries
    // that are within the window but should be skipped by the cap (they are
    // beyond the 20th same-ns entry from the tail). The expected bonus
    // is 5*2=10 (only the first 5 recent entries count before the cap halts
    // the walk at the 20th same-ns entry which is outside the window).
    const history: ToolCallRecord[] = [];
    // 5 extra entries that are INSIDE the window but appear BEFORE the cap
    // group in the array (so they are walked AFTER the cap group when
    // iterating backwards -- i.e. they would be examined beyond position 20).
    for (let i = 0; i < 5; i++) {
      history.push({ namespace: "gh", at: NOW - (i + 1) * 1000 }); // recent, should be capped out
    }
    // ADAPTIVE_LOOKBACK entries: the first 5 are recent, the remaining 15
    // are outside the window. These appear AFTER the extra 5 in the array
    // so they are seen first when walking backwards.
    for (let i = 0; i < ADAPTIVE_LOOKBACK; i++) {
      const offsetMs =
        i < 5
          ? (i + 6) * 1000 // recent (inside window)
          : ADAPTIVE_WINDOW_MS + (i + 1) * 1000; // old (outside window)
      history.push({ namespace: "gh", at: NOW - offsetMs });
    }
    // Walking backwards: the last ADAPTIVE_LOOKBACK entries (oldest 20 in the
    // push order) are encountered first. Those 20 constitute the cap group:
    // 5 recent + 15 old -> sameNsSeen reaches ADAPTIVE_LOOKBACK, loop stops.
    // The 5 extra entries prepended earlier are never examined.
    // Bonus = 5 * 2 = 10 -> threshold = 10 + 10 = 20.
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(20);
  });
});

describe("pushToolCall", () => {
  it("appends records in order", () => {
    const history: ToolCallRecord[] = [];
    pushToolCall(history, { namespace: "gh", at: 1 });
    pushToolCall(history, { namespace: "slack", at: 2 });
    pushToolCall(history, { namespace: "gh", at: 3 });
    expect(history.map((r) => r.namespace)).toEqual(["gh", "slack", "gh"]);
  });

  it("trims oldest entries once over the limit", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 5; i++) pushToolCall(history, { namespace: "n", at: i }, 3);
    // Limit 3 → keeps the last three: at=2, at=3, at=4
    expect(history.map((r) => r.at)).toEqual([2, 3, 4]);
  });

  it("defaults to HISTORY_LIMIT when no limit is provided", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) pushToolCall(history, { namespace: "n", at: i });
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history[0].at).toBe(10); // first 10 dropped
    expect(history[history.length - 1].at).toBe(HISTORY_LIMIT + 9);
  });
});

describe("MCP_CONNECT_IDLE_THRESHOLD env var override", () => {
  // The env var is consumed by server.ts to pick the baseline; this
  // test exercises the shape of that contract: adaptiveThreshold must
  // treat the passed-in base as the true baseline regardless of what
  // the env var was. The override behavior itself lives in server.ts
  // (static class init) but the guarantee we care about here is that
  // the adaptive function never ignores the baseline it's handed.
  const ORIGINAL_ENV = process.env.MCP_CONNECT_IDLE_THRESHOLD;

  beforeEach(() => {
    delete process.env.MCP_CONNECT_IDLE_THRESHOLD;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MCP_CONNECT_IDLE_THRESHOLD;
    } else {
      process.env.MCP_CONNECT_IDLE_THRESHOLD = ORIGINAL_ENV;
    }
  });

  it("respects a high base even with no activity", () => {
    process.env.MCP_CONNECT_IDLE_THRESHOLD = "25";
    // Simulate the server's resolution — adaptiveThreshold should use
    // the caller-supplied baseline, not the env var directly.
    expect(adaptiveThreshold("gh", [], 25, NOW)).toBe(25);
  });

  it("respects a low base and keeps clamping to ADAPTIVE_MIN", () => {
    process.env.MCP_CONNECT_IDLE_THRESHOLD = "2";
    // Even with base=2 and no activity, the floor holds at 5.
    expect(adaptiveThreshold("gh", [], 2, NOW)).toBe(ADAPTIVE_MIN);
  });

  it("lets a high base stack with the adaptive bonus up to the hard cap", () => {
    process.env.MCP_CONNECT_IDLE_THRESHOLD = "25";
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 15; i++) history.push(record("gh", i * 1000));
    // 25 + 20 = 45, still under ADAPTIVE_MAX (50).
    expect(adaptiveThreshold("gh", history, 25, NOW)).toBe(45);
  });
});
