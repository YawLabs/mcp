// Small string-distance helper for "did you mean?" suggestions when a
// caller activates a namespace that doesn't exist. Pure, no deps.
//
// Kept deliberately conservative — we only emit suggestions when the
// input is a clear typo of an installed namespace (short edit distance
// or substring containment). A wild mis-match returns [] so the caller
// can fall back to a generic "use discover" hint instead of surfacing
// noise.

/**
 * Standard edit-distance (insertion/deletion/substitution each cost 1).
 * O(n*m) time, O(m) space. Fine for short namespace identifiers.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let prev = new Array<number>(bLen + 1);
  let curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bLen];
}

/**
 * Minimum query length for the inexact tiers (prefix / substring /
 * edit-distance). Below 3 chars there is no such thing as a "clear typo":
 * the prefix tier would surface every namespace sharing a first letter
 * ('g' -> gh, github, gitlab), and the d<=2 edit-distance tier covers most
 * of the short-namespace space ('gt' is within 1 of 'gh'). Only a
 * case-only mismatch carries enough signal at that length; everything
 * else falls back to the caller's generic "use discover" hint.
 */
const MIN_TYPO_QUERY_LEN = 3;

/**
 * Rank candidates by approximate match to `query` and return the best `limit`.
 *
 * Score tiers (lower is better):
 *   0 — case-only mismatch of an otherwise equal string
 *   1 — one side is a prefix of the other (case-insensitive)
 *   2 — one side contains the other as a substring
 *   3–4 — Levenshtein distance ≤ 2 (near-typo)
 *
 * Tiers 1-4 require the query to be at least MIN_TYPO_QUERY_LEN chars —
 * a 1-2 char input matches too much to call anything a clear typo.
 *
 * Candidates with no qualifying match are dropped. Ties broken alphabetically.
 * Exact matches of `query` are excluded — a caller emitting a "did you mean?"
 * hint already knows the exact name didn't exist.
 */
export function closestNames(query: string, candidates: readonly string[], limit: number): string[] {
  if (limit <= 0) return [];
  const q = query.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];

  for (const c of candidates) {
    if (c === query) continue;
    const lc = c.toLowerCase();
    let score: number | null = null;
    if (lc === q) {
      score = 0;
    } else if (q.length >= MIN_TYPO_QUERY_LEN) {
      if (lc.startsWith(q) || q.startsWith(lc)) {
        score = 1;
      } else if (
        // Substring containment is only a credible "typo" signal when the
        // shorter string covers at least half the longer one. Without this
        // gate a short query ("set") substring-matches long commands
        // ("set-active") and surfaces misleading suggestions the header
        // calls conservative. The Levenshtein tier still catches genuine
        // short typos. (The old q.length >= 3 gate here is subsumed by the
        // MIN_TYPO_QUERY_LEN gate on the whole inexact block.)
        (lc.includes(q) || q.includes(lc)) &&
        Math.min(q.length, lc.length) * 2 >= Math.max(q.length, lc.length)
      ) {
        score = 2;
      } else {
        const d = levenshtein(q, lc);
        if (d <= 2) score = 2 + d;
      }
    }
    // else: 1-2 char query — only the case-only tier above may fire; see
    // MIN_TYPO_QUERY_LEN for why the inexact tiers are pure noise here.
    if (score !== null) scored.push({ name: c, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.name.localeCompare(b.name);
  });
  return scored.slice(0, limit).map((s) => s.name);
}
