// Session-scoped "routing miss" tracker.
//
// When the dispatcher routes an intent to server A, A replies cleanly once,
// and then is never used again -- and shortly after a SIMILAR intent gets
// routed to a DIFFERENT server B -- that's a strong signal that A was the
// WRONG route for the original intent: the model tried A, A answered but
// didn't actually help, and the model re-dispatched to B. We call A the
// "loser" of that miss.
//
// This is a pure in-memory ring buffer. It does NO I/O, holds no SDK
// handles, and never calls Date.now() -- the caller always passes `now` in.
// That keeps it trivially testable and resume-safe (a snapshot/restore of
// the session can replay timestamps without the clock drifting).

import { tokenize } from "./relevance.js";

export interface RedispatchMiss {
  loser: string;
}

// One dispatch decision in the ring.
interface DispatchRecord {
  namespace: string;
  // Pre-tokenized intent (caller passes tokenize(intent)) -- stored as a Set
  // so similarity is a straight set operation with no re-tokenizing.
  tokens: Set<string>;
  time: number;
  // First clean reply flips this true. It's the precondition for being a
  // miss candidate at all: a server that never replied cleanly wasn't
  // "tried and abandoned", it just failed.
  cleanReply: boolean;
  // A SECOND (or later) reply flips this true -> the server kept getting
  // used, so it was NOT abandoned and can't be a loser.
  furtherUse: boolean;
  // Once a record fires as a loser it's consumed so it can't fire twice.
  consumed: boolean;
}

// Drop the oldest record past this many. Small on purpose: a miss is a
// near-immediate re-route, so we only need the recent tail.
const RING_CAP = 8;

// A re-route more than this long after the original dispatch is a NEW task,
// not a correction -- don't treat it as a miss.
const WINDOW_MS = 120_000;

// Jaccard similarity floor. Below this the two intents are too different to
// call the re-route a correction of the earlier one.
const JACCARD_THRESHOLD = 0.4;

// Even at high Jaccard, require this many literally-shared tokens so a single
// common word ("list", "get") on two short intents can't trip a false miss.
const MIN_SHARED_TOKENS = 3;

function jaccard(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const t of a) {
    if (b.has(t)) shared++;
  }
  // |A ∪ B| = |A| + |B| - |A ∩ B|
  const union = a.size + b.size - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

export class RedispatchTracker {
  // Newest record is at the END of the array. Capped at RING_CAP by shifting
  // the oldest off the front.
  private ring: DispatchRecord[] = [];

  // Record a new dispatch decision. intentTokens = tokenize(intent).
  push(namespace: string, intentTokens: string[], now: number): void {
    this.ring.push({
      namespace,
      tokens: new Set(intentTokens),
      time: now,
      cleanReply: false,
      furtherUse: false,
      consumed: false,
    });
    while (this.ring.length > RING_CAP) {
      this.ring.shift();
    }
  }

  // Called from the proxy path when the dispatched server replied. We only
  // care about the MOST-RECENT record for `namespace` (that's the dispatch
  // the reply belongs to).
  //
  // First clean reply for that record sets cleanReply=true. Any SUBSEQUENT
  // call for that same record sets furtherUse=true (the server kept getting
  // used -> NOT abandoned, so it can never be a loser).
  markReply(namespace: string, clean: boolean): void {
    // Walk from the newest end backwards to the most-recent matching record.
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const rec = this.ring[i];
      if (rec.namespace !== namespace) continue;

      if (!rec.cleanReply) {
        // First reply we've seen for this record.
        if (clean) rec.cleanReply = true;
        // A non-clean first reply leaves cleanReply false (still failed),
        // and does NOT count as "further use".
      } else {
        // Already had a clean reply, now it's being used again.
        rec.furtherUse = true;
      }
      return;
    }
  }

  // When a new dispatch (newNamespace) lands, look back over the recent ring
  // for an ABANDONED record (cleanReply && !furtherUse) on a DIFFERENT
  // namespace whose intent is SIMILAR to newTokens and within the time
  // window. If found, that earlier server was the wrong route -> return
  // { loser }. isExcluded(a, b) returns true when a->b is a known legitimate
  // multi-server chain (curated bundle / detected pack) and must NOT be
  // treated as a miss. Returns null when no miss.
  detectMiss(
    newNamespace: string,
    newTokens: string[],
    now: number,
    isExcluded: (a: string, b: string) => boolean,
  ): RedispatchMiss | null {
    const newSet = new Set(newTokens);

    // Scan newest-first so we return the MOST-RECENT qualifying record.
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const rec = this.ring[i];

      if (rec.consumed) continue;
      // Same-server re-dispatch is a retry, not a miss.
      if (rec.namespace === newNamespace) continue;
      // Must have been tried-and-abandoned.
      if (!rec.cleanReply || rec.furtherUse) continue;
      // Time window: gate on the timestamps, not array position.
      if (now - rec.time > WINDOW_MS) continue;
      // Legitimate multi-server chain -> not a miss.
      if (isExcluded(rec.namespace, newNamespace)) continue;

      const { score, shared } = jaccard(rec.tokens, newSet);
      if (shared < MIN_SHARED_TOKENS) continue;
      if (score < JACCARD_THRESHOLD) continue;

      // Consume so this record can't fire as a loser twice.
      rec.consumed = true;
      return { loser: rec.namespace };
    }

    return null;
  }
}
