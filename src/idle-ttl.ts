// Context-aware idle TTL.
//
// The original auto-deactivate logic used a single static threshold
// (the idle-threshold env var, default 10 -- YAW_MCP_IDLE_THRESHOLD today,
// spelled MCP_CONNECT_IDLE_THRESHOLD back then and still honoured under that
// name as a fallback) for every namespace: once an upstream had seen N calls
// for OTHER namespaces since its own last call, we'd tear it down to save RAM.
//
// That worked for long-tail usage but penalized bursty workflows. If a
// user fired off five `github_*` calls in a row, then bounced to `slack`
// for a dozen follow-up tool calls, the github upstream would get
// deactivated mid-task even though we were almost certainly about to
// come back to it. Re-activation is slow (spawn + tools/list + handshake)
// so the "patience" for a just-used server should be longer than for one
// we touched half an hour ago and forgot about.
//
// This module computes an adaptive per-namespace threshold from a rolling
// history of recent tool calls. The function is deliberately pure: the
// server keeps the history, this file just scores it.

export interface ToolCallRecord {
  namespace: string;
  at: number; // epoch millis
}

// Window of recent tool calls considered when computing adaptive
// threshold. Only same-namespace hits within this window count toward
// "burstiness".
export const ADAPTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// How far back the scan walks: it stops after this many same-namespace
// entries, so scoring one namespace costs a bounded walk rather than the
// whole HISTORY_LIMIT-entry array.
//
// It is a WORK bound, not a scoring rule, and with the current constants it
// cannot change the RESULT for a history in chronological order — which is
// the only kind pushToolCall and server.ts produce. Walking backwards, the
// entries it excludes are always older than the 20th-most-recent same-ns
// call, so excluding them can only matter when 20+ of them are inside the
// 5-minute window — and 10 in-window hits already saturate
// ADAPTIVE_BONUS_CAP (10 * 2 = 20). The cap is therefore observable only on
// an out-of-order history, which is why the test that pins it has to build
// one by hand. Keep it as the guard for a caller that hands over an unsorted
// history, and as the reason a 100-entry history is never fully scanned.
export const ADAPTIVE_LOOKBACK = 20;

// Hard bounds on the final threshold. Even with a high base and a very
// bursty namespace we never wait longer than 50 idle calls; even with a
// low/invalid base we never deactivate faster than 5.
//
// Both ends are equally visible, and neither warn lives here: server.ts's
// resolveIdleThreshold warns (once per distinct value) when a configured
// baseline exceeds ADAPTIVE_MAX, because "I set 100" behaving as 50 is worth
// saying out loud, and mirrors that warn when a baseline falls BELOW
// ADAPTIVE_MIN — server.ts rejects <1 outright, so only 1..4 reach here, and
// an operator asking for aggressive reaping is told they got the floor
// instead. Both warns belong in resolveIdleThreshold rather than here:
// adaptiveThreshold is deliberately pure (no logging, no env) so it can be
// scored on every tool call without side effects.
export const ADAPTIVE_MIN = 5;
export const ADAPTIVE_MAX = 50;

// Maximum bonus an adaptive namespace can earn on top of `base`. A
// completely idle namespace gets `base` exactly; a heavily-used one gets
// `base + ADAPTIVE_BONUS_CAP`.
export const ADAPTIVE_BONUS_CAP = 20;

// Rolling history size kept by the server. Bounded so we don't grow
// unbounded on long sessions; 100 is enough to feed several lookback
// windows across namespaces.
export const HISTORY_LIMIT = 100;

/**
 * Compute the adaptive idle-call threshold for `namespace` given the
 * rolling history of recent tool calls.
 *
 * Rules:
 *  - Count same-namespace calls within the last ADAPTIVE_WINDOW_MS, scanning
 *    back at most ADAPTIVE_LOOKBACK same-namespace entries (a work bound; see
 *    the constant for why it cannot change the answer on an in-order history).
 *  - Return `base + min(recent * 2, ADAPTIVE_BONUS_CAP)`.
 *  - Clamp the final result to [ADAPTIVE_MIN, ADAPTIVE_MAX].
 *
 * The caller supplies `base`, so whatever server.ts's resolveIdleThreshold
 * made of the env var continues to control the baseline; this function never
 * reads the environment itself. The adaptive cap is not user-tunable — it's a
 * safety valve.
 *
 * @param namespace The upstream namespace we're scoring.
 * @param recentCalls The server's rolling history of recent tool calls.
 * @param base Baseline threshold (default 10, overridable via env var).
 * @param now Current time in epoch millis — injected for deterministic
 *   tests. Defaults to Date.now().
 */
export function adaptiveThreshold(
  namespace: string,
  recentCalls: ReadonlyArray<ToolCallRecord>,
  base: number,
  now: number = Date.now(),
): number {
  // Guard a non-finite base BEFORE it reaches the clamps below. NaN fails
  // BOTH `computed < ADAPTIVE_MIN` and `computed > ADAPTIVE_MAX`, so it falls
  // straight through and returns NaN -- and a caller testing `idleCalls >=
  // threshold` against NaN never deactivates at all, which is the exact
  // opposite of the documented "never deactivate faster than ADAPTIVE_MIN,
  // never wait longer than ADAPTIVE_MAX" contract. +/-Infinity happens to
  // clamp correctly today but is equally invalid as a baseline; both snap to
  // the documented floor.
  //
  // The in-tree caller can no longer produce a NaN: resolveIdleThreshold
  // (server.ts) parses the env var with a strict digit-run test and falls back
  // to the default on anything else -- it was `Number(...)` over the raw value
  // when this guard was written. The guard stays because `base` is a plain
  // parameter: this function is exported and pure, and a future caller
  // computing a baseline some other way must not be able to disable the reaper
  // by handing over a NaN.
  if (!Number.isFinite(base)) return ADAPTIVE_MIN;

  const cutoff = now - ADAPTIVE_WINDOW_MS;

  // Walk the history backwards, stopping after ADAPTIVE_LOOKBACK
  // same-namespace entries. Backwards because the newest entries are the ones
  // that can be inside the window; the stop is a scan bound, not a scoring
  // rule (see the constant).
  let sameNsSeen = 0;
  let recent = 0;
  for (let i = recentCalls.length - 1; i >= 0 && sameNsSeen < ADAPTIVE_LOOKBACK; i--) {
    const rec = recentCalls[i];
    if (rec.namespace !== namespace) continue;
    sameNsSeen++;
    if (rec.at >= cutoff) recent++;
  }

  const bonus = Math.min(recent * 2, ADAPTIVE_BONUS_CAP);
  const computed = base + bonus;

  if (computed < ADAPTIVE_MIN) return ADAPTIVE_MIN;
  if (computed > ADAPTIVE_MAX) return ADAPTIVE_MAX;
  return computed;
}

/**
 * Append a tool call to a rolling history, evicting the oldest entries
 * so the history never exceeds `limit`. Returns the (possibly trimmed)
 * array — callers can use the return value or rely on in-place mutation.
 */
export function pushToolCall(
  history: ToolCallRecord[],
  record: ToolCallRecord,
  limit: number = HISTORY_LIMIT,
): ToolCallRecord[] {
  history.push(record);
  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }
  return history;
}
