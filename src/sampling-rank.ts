import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./logger.js";
import type { UpstreamServerConfig } from "./types.js";

// Top-2 scores within this ratio of each other trigger a sampling
// tiebreak. 0.9 means "runner-up scored ≥90% of the leader" — if the
// gap is wider than that, BM25+rerank is confident enough on its own.
export const SAMPLING_TIEBREAK_RATIO = 0.9;

// Small budget — the LLM's job here is to name one candidate, not to
// write an essay. Room for a short rationale.
const SAMPLING_MAX_TOKENS = 120;

// Hard ceiling on best-of-N samples. N is clamped into [1, MAX_SAMPLES]
// so a misconfigured effort dial can never fan out unboundedly.
export const MAX_SAMPLES = 5;

// Wall-clock budget for the whole best-of-N aggregate (all N calls
// combined), so added latency stays bounded regardless of N. On timeout
// we fall back to the ranker's order.
export const SAMPLING_TIMEOUT_MS = 2000;

// Ambiguity thresholds for the effort-aware gate. "auto" mirrors today's
// 0.9 tiebreak ratio generalized onto the [0,1] ambiguity scale; a top-2
// ratio of 0.9 yields an inverse-margin of 0.1, but the entropy signal of
// two near-tied scores pushes the combined ambiguity up near ~0.85+, so we
// gate auto at 0.85. "aggressive" samples on milder ambiguity.
export const AUTO_AMBIGUITY_THRESHOLD = 0.85;
export const AGGRESSIVE_AMBIGUITY_THRESHOLD = 0.6;

export interface TiebreakCandidate {
  namespace: string;
  score: number;
  description?: string;
  tools: Array<{ name: string; description?: string }>;
}

// Decide whether the ranked list is close enough at the top to warrant
// consulting the LLM. Single-candidate and wide-margin cases skip the
// round-trip — sampling isn't free.
export function shouldTiebreak(
  ranked: Array<{ namespace: string; score: number }>,
  ratio: number = SAMPLING_TIEBREAK_RATIO,
): boolean {
  if (ranked.length < 2) return false;
  const [top, second] = ranked;
  if (!top || !second || top.score <= 0) return false;
  return second.score / top.score >= ratio;
}

// Build a compact prompt describing the candidate servers. Keep it
// under a few hundred tokens so the sampling round-trip is cheap.
export function buildTiebreakPrompt(intent: string, candidates: TiebreakCandidate[]): string {
  const blocks = candidates.map((c, i) => {
    const toolLine =
      c.tools.length > 0
        ? c.tools
            .slice(0, 8)
            .map((t) => t.name)
            .join(", ")
        : "(no tool metadata yet)";
    return `${i + 1}. ${c.namespace}${c.description ? ` -- ${c.description}` : ""}\n   tools: ${toolLine}`;
  });
  return [
    "You are a router picking the best MCP server for a user task.",
    `User intent: ${intent}`,
    "",
    "Candidates:",
    ...blocks,
    "",
    'Reply with ONLY the chosen server\'s namespace on the first line (e.g. "github"). No quotes, no explanation.',
  ].join("\n");
}

// Extract the chosen namespace from the LLM's free-text response. The
// prompt asks for just the namespace, but LLMs sometimes add prose --
// scan each non-empty line against the candidate list. Within a single
// line we pick whichever candidate appears earliest (by character
// index); a response like "I prefer gitlab over github" must return
// "gitlab", not the first candidate iterated. Returns null if no
// candidate appears anywhere.
export function parseTiebreakResponse(response: string, candidates: TiebreakCandidate[]): string | null {
  const namespaces = candidates.map((c) => c.namespace);
  const namespaceSet = new Set(namespaces);
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[`"'*>\-\s]+|[`"'*\s]+$/g, "");
    if (!line) continue;
    if (namespaceSet.has(line)) return line;
    // Allow inline mentions like "I pick github because..." -- pick the
    // earliest-positioned candidate so the LLM's lexical choice wins
    // even when iteration order says otherwise.
    let bestNs: string | null = null;
    let bestPos = Number.POSITIVE_INFINITY;
    for (const ns of namespaces) {
      const re = new RegExp(`\\b${escapeRegex(ns)}\\b`);
      const match = re.exec(line);
      if (match && match.index < bestPos) {
        bestPos = match.index;
        bestNs = ns;
      }
    }
    if (bestNs) return bestNs;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Ask the client LLM to pick a winner among the top-tied candidates.
// Returns the chosen namespace, or null if sampling is unsupported,
// declined, failed, or the response doesn't name any candidate.
// Never throws — a bad tiebreak just falls back to the ranker's order.
export async function tiebreakViaSampling(
  server: Server,
  intent: string,
  candidates: TiebreakCandidate[],
): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;
  if (candidates.length < 2) return null;

  const prompt = buildTiebreakPrompt(intent, candidates);
  try {
    const result = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens: SAMPLING_MAX_TOKENS,
      // Hint that we want a cheap, fast response.
      includeContext: "none",
    });
    const text =
      result && typeof result === "object" && "content" in result && result.content ? extractText(result.content) : "";
    if (!text) return null;
    return parseTiebreakResponse(text, candidates);
  } catch (err) {
    log("warn", "Sampling tiebreak failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// createMessage can return content as a single block or an array (when
// the LLM used tools). For tiebreak we only care about text; collect
// any text blocks we find and join them.
function extractText(content: unknown): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c ? String(c.text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content !== null && "type" in content) {
    const block = content as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

// Build TiebreakCandidate descriptors for a subset of servers sharing
// the top of the ranking. Caller feeds us the ranked list and the raw
// servers so we can attach descriptions + tool metadata.
export function buildCandidates(
  topRanked: Array<{ namespace: string; score: number }>,
  serversByNamespace: Map<string, UpstreamServerConfig>,
  toolsByNamespace: Map<string, Array<{ name: string; description?: string }>>,
): TiebreakCandidate[] {
  const out: TiebreakCandidate[] = [];
  for (const r of topRanked) {
    const server = serversByNamespace.get(r.namespace);
    if (!server) continue;
    const candidate: TiebreakCandidate = {
      namespace: r.namespace,
      score: r.score,
      tools: toolsByNamespace.get(r.namespace) ?? server.toolCache ?? [],
    };
    if (server.description) candidate.description = server.description;
    out.push(candidate);
  }
  return out;
}

// =============================================================================
// Effort dial: test-time-compute routing (idea 5)
//
// A coarse "how hard should the router try" knob layered on top of the
// existing tiebreak. "off" disables LLM sampling entirely; "auto" preserves
// today's behavior (one sample only on genuine ambiguity); "aggressive"
// samples sooner and fans out to best-of-N for a sturdier vote.
// =============================================================================

export type RouteEffort = "off" | "auto" | "aggressive";

// Parse YAW_MCP_ROUTE_EFFORT. Default "auto". Unknown values fall back to
// "auto" so a typo never silently disables routing or burns compute.
export function parseRouteEffort(raw: string | undefined): RouteEffort {
  if (raw === undefined) return "auto";
  switch (raw.trim().toLowerCase()) {
    case "off":
      return "off";
    case "aggressive":
      return "aggressive";
    default:
      // Includes "auto", empty string, and anything unrecognized.
      return "auto";
  }
}

// Measure how ambiguous the top of the ranking is, on [0,1]. We combine two
// independent signals over the top-K and take the larger (more cautious):
//
//   1. Top-2 closeness: ranked[1].score / ranked[0].score. A wide gap -> near
//      0; a near-tie -> near 1. (The "inverse top-2 margin" — high when the
//      margin between the leaders is small, i.e. the result is ambiguous.)
//   2. Normalized Shannon entropy of the top-K scores (normalized to a
//      probability distribution): one dominant score -> ~0; a flat spread
//      across K -> ~1.
//
// 0 means one clear winner; 1 means flat/ambiguous. Degenerate inputs
// (fewer than 2 candidates, non-positive leader score) return 0 — nothing to
// disambiguate.
export function computeAmbiguity(ranked: Array<{ namespace: string; score: number }>, k = 3): number {
  if (ranked.length < 2) return 0;
  const top = ranked[0];
  if (!top || top.score <= 0) return 0;

  const topK = ranked.slice(0, Math.max(2, k));

  // Signal 1: top-2 closeness (inverse margin). The closer the runner-up's
  // score is to the leader's, the higher the ambiguity. Clamp into [0,1] — a
  // runner-up can't legitimately outscore the leader, but guard float noise.
  const second = topK[1];
  const secondScore = second ? second.score : 0;
  const inverseMargin = Math.min(1, Math.max(0, secondScore / top.score));

  // Signal 2: normalized Shannon entropy. Treat non-positive scores as 0
  // mass. If every score is non-positive (can't happen given top>0) the
  // distribution is empty -> 0.
  const weights = topK.map((c) => Math.max(0, c.score));
  const total = weights.reduce((a, b) => a + b, 0);
  let entropy = 0;
  if (total > 0 && topK.length >= 2) {
    let h = 0;
    for (const w of weights) {
      if (w <= 0) continue;
      const p = w / total;
      h -= p * Math.log(p);
    }
    // Normalize by log(K) so a perfectly flat distribution maps to 1.
    const maxH = Math.log(topK.length);
    entropy = maxH > 0 ? h / maxH : 0;
  }

  return Math.max(inverseMargin, entropy);
}

// Effort-aware gate deciding whether to spend an LLM round-trip on this
// ranking. Pure; no I/O. "off" never samples. "auto" and "aggressive" sample
// when computed ambiguity crosses their respective thresholds.
export function shouldSample(ranked: Array<{ namespace: string; score: number }>, effort: RouteEffort): boolean {
  if (effort === "off") return false;
  const ambiguity = computeAmbiguity(ranked);
  const threshold = effort === "aggressive" ? AGGRESSIVE_AMBIGUITY_THRESHOLD : AUTO_AMBIGUITY_THRESHOLD;
  return ambiguity >= threshold;
}

// Map an effort level to the number of best-of-N samples. "auto" stays at a
// single sample so default latency matches today's tiebreak; "aggressive"
// fans out to 3. "off" never reaches here, but maps to 0 for completeness.
export function sampleCountForEffort(effort: RouteEffort): number {
  switch (effort) {
    case "off":
      return 0;
    case "aggressive":
      return 3;
    default:
      return 1;
  }
}

// Best-of-N tiebreak: call the client LLM N times, majority-vote the parsed
// namespace, ties broken by ranker order (the first candidate in the list
// wins). N is clamped into [1, MAX_SAMPLES]. The whole aggregate is wrapped
// in a SAMPLING_TIMEOUT_MS race so total added latency is bounded regardless
// of N. Reuses the same capability gate and never-throws discipline as
// tiebreakViaSampling: on timeout, missing sampling capability, fewer than 2
// candidates, or total failure, returns null and the caller falls back to the
// ranker's order.
export async function bestOfNViaSampling(
  server: Server,
  intent: string,
  candidates: TiebreakCandidate[],
  n: number,
): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;
  if (candidates.length < 2) return null;

  const samples = Math.min(MAX_SAMPLES, Math.max(1, Math.floor(n)));
  const prompt = buildTiebreakPrompt(intent, candidates);

  // One sampling call -> parsed namespace or null. Never throws.
  const sampleOnce = async (): Promise<string | null> => {
    try {
      const result = await server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: SAMPLING_MAX_TOKENS,
        includeContext: "none",
      });
      const text =
        result && typeof result === "object" && "content" in result && result.content
          ? extractText(result.content)
          : "";
      if (!text) return null;
      return parseTiebreakResponse(text, candidates);
    } catch (err) {
      log("warn", "Best-of-N sample failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  // Run all N samples concurrently, bounded by a single timeout for the
  // whole aggregate. A timeout resolves to null (fall back to ranker order).
  const aggregate = (async (): Promise<string | null> => {
    const results = await Promise.all(Array.from({ length: samples }, () => sampleOnce()));

    // Tally votes; track first-seen order so ranker order can break ties.
    const votes = new Map<string, number>();
    for (const ns of results) {
      if (!ns) continue;
      votes.set(ns, (votes.get(ns) ?? 0) + 1);
    }
    if (votes.size === 0) return null;

    // Rank position for tie-breaking: earlier candidate wins.
    const order = new Map<string, number>();
    candidates.forEach((c, i) => order.set(c.namespace, i));

    let winner: string | null = null;
    let bestVotes = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const [ns, count] of votes) {
      const rank = order.get(ns) ?? Number.POSITIVE_INFINITY;
      if (count > bestVotes || (count === bestVotes && rank < bestRank)) {
        winner = ns;
        bestVotes = count;
        bestRank = rank;
      }
    }
    return winner;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAMPLING_TIMEOUT_MS);
  });

  try {
    return await Promise.race([aggregate, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
