// Foundry corpus: turn harvested dispatch traces (foundry.jsonl, written by
// foundry.ts when YAW_MCP_FOUNDRY is on) into a checked-in regression corpus,
// and score the BM25 ranker against it.
//
// What this gate measures (and what it does NOT):
//   It is a BM25-FLOOR REGRESSION gate, not a correctness oracle. Each entry
//   is a real (redacted token bag -> chosen server) pair, where `chosen` is
//   the server the FULL pipeline (BM25 + rerank + health + learning + sampling)
//   actually routed to. The gate asserts that the BM25-only floor still ranks
//   `chosen` in its top-K on those real intents -- i.e. a change to BM25
//   weights/tokenization doesn't drop real-world choices out of contention.
//   It does NOT claim `chosen` was the objectively correct server; richer
//   ground-truth labels (re-dispatch / graded-reward / thumbs) are a future
//   enrichment. Because it scores the BM25 floor (no Voyage key needed), it
//   runs in CI exactly like routing-quality.test.ts.
//
// The corpus is a checked-in fixture, not live data. A maintainer runs
// `yaw-mcp foundry export` to fold ~/.yaw-mcp/foundry.jsonl into the fixture;
// the gate consumes it. Until a fixture exists the gate cleanly skips.

import { readFileSync } from "node:fs";
import { type RankableServer, rankServers } from "./relevance.js";

export const FOUNDRY_CORPUS_VERSION = 1 as const;

// Default cap on corpus entries. Keeps the checked-in fixture bounded; the
// export stratifies by `chosen` so rare servers survive the cap.
export const DEFAULT_CORPUS_CAP = 500;

// Minimum weighted top-3 accuracy the gate requires. Starts conservative;
// ratchet UP toward the last green measurement as the corpus matures so the
// gate tightens with the data instead of rubber-stamping a regression.
export const FOUNDRY_TOP3_FLOOR = 0.7;

// One harvested trace as written by foundry.ts/appendFoundryTrace.
export interface HarvestedTrace {
  tokens: string[];
  candidates?: Array<{ ns: string; score: number }>;
  chosen: string;
  redactedCount?: number;
}

export interface FoundryCorpusEntry {
  // Redacted, sorted token bag (order already destroyed at harvest time).
  tokens: string[];
  // The namespace the full pipeline routed this intent to.
  chosen: string;
  // How many harvested traces collapsed into this entry (same tokens+chosen).
  weight: number;
}

export interface FoundryCorpus {
  version: typeof FOUNDRY_CORPUS_VERSION;
  // Server catalog snapshot to re-rank against, captured at export time.
  servers: RankableServer[];
  entries: FoundryCorpusEntry[];
}

// Parse a foundry.jsonl blob into traces. Skips blank/garbage lines (the file
// is append-only telemetry; a torn final line must not abort the whole parse).
export function parseTraceLines(text: string): HarvestedTrace[] {
  const out: HarvestedTrace[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && Array.isArray(obj.tokens) && typeof obj.chosen === "string") {
        out.push(obj as HarvestedTrace);
      }
    } catch {
      // Skip an unparseable line rather than fail the export.
    }
  }
  return out;
}

// Dedup key for an entry: tokens are [a-z0-9] runs and a namespace has no
// spaces or colons, so "<space-joined tokens>::<chosen>" is unambiguous.
function entryKey(tokens: string[], chosen: string): string {
  return `${tokens.join(" ")}::${chosen}`;
}

// Stratified cap: keep up to `cap` entries, sampling round-robin across the
// distinct `chosen` namespaces (highest-weight first within each) so rare
// servers are not evicted wholesale when one namespace dominates. Deterministic
// (no randomness) so the fixture is reproducible.
function capStratified(entries: FoundryCorpusEntry[], cap: number): FoundryCorpusEntry[] {
  if (entries.length <= cap) return entries;
  const byChosen = new Map<string, FoundryCorpusEntry[]>();
  for (const e of entries) {
    const g = byChosen.get(e.chosen);
    if (g) g.push(e);
    else byChosen.set(e.chosen, [e]);
  }
  // Highest-weight first within each group; stable group order by name.
  const groups = [...byChosen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, g]) => g.sort((x, y) => y.weight - x.weight));
  const out: FoundryCorpusEntry[] = [];
  let i = 0;
  while (out.length < cap) {
    let took = false;
    for (const g of groups) {
      if (i < g.length) {
        out.push(g[i]);
        took = true;
        if (out.length >= cap) break;
      }
    }
    if (!took) break; // all groups exhausted
    i++;
  }
  return out;
}

// Fold harvested traces into a corpus: drop traces whose `chosen` is not in the
// snapshot server set (unscorable) or that carry no tokens, dedup by
// (sorted-tokens, chosen) accumulating weight, then stratify-cap. Pure.
export function buildCorpusFromTraces(
  traces: HarvestedTrace[],
  servers: RankableServer[],
  opts: { cap?: number } = {},
): FoundryCorpus {
  const known = new Set(servers.map((s) => s.namespace));
  const byKey = new Map<string, FoundryCorpusEntry>();
  for (const t of traces) {
    if (!t || typeof t.chosen !== "string" || !known.has(t.chosen)) continue;
    if (!Array.isArray(t.tokens) || t.tokens.length === 0) continue;
    const tokens = [...t.tokens].filter((x) => typeof x === "string").sort();
    if (tokens.length === 0) continue;
    const key = entryKey(tokens, t.chosen);
    const prev = byKey.get(key);
    if (prev) prev.weight += 1;
    else byKey.set(key, { tokens, chosen: t.chosen, weight: 1 });
  }
  const entries = capStratified([...byKey.values()], opts.cap ?? DEFAULT_CORPUS_CAP);
  return { version: FOUNDRY_CORPUS_VERSION, servers, entries };
}

export interface CorpusScore {
  totalWeight: number;
  top1Weight: number;
  top3Weight: number;
  top1: number;
  top3: number;
}

// Weighted top-1 / top-3 accuracy of the BM25 floor over the corpus: for each
// entry, re-rank the snapshot servers against the entry's tokens and check
// whether `chosen` lands at #1 / within the top 3. Weights count repeated
// intents once per occurrence. Pure (uses rankServers, no I/O).
export function scoreCorpus(corpus: FoundryCorpus): CorpusScore {
  let totalWeight = 0;
  let top1Weight = 0;
  let top3Weight = 0;
  for (const e of corpus.entries) {
    totalWeight += e.weight;
    const top3 = rankServers(e.tokens.join(" "), corpus.servers)
      .slice(0, 3)
      .map((r) => r.namespace);
    if (top3[0] === e.chosen) top1Weight += e.weight;
    if (top3.includes(e.chosen)) top3Weight += e.weight;
  }
  return {
    totalWeight,
    top1Weight,
    top3Weight,
    top1: totalWeight > 0 ? top1Weight / totalWeight : 0,
    top3: totalWeight > 0 ? top3Weight / totalWeight : 0,
  };
}

// Validate a parsed object as a FoundryCorpus. Returns the typed corpus or null
// (used by the gate to skip cleanly on a missing/garbage/empty fixture).
export function validateCorpus(obj: unknown): FoundryCorpus | null {
  if (!obj || typeof obj !== "object") return null;
  const c = obj as Partial<FoundryCorpus>;
  if (c.version !== FOUNDRY_CORPUS_VERSION) return null;
  if (!Array.isArray(c.servers) || !Array.isArray(c.entries)) return null;
  if (c.entries.length === 0) return null;
  return c as FoundryCorpus;
}

// Load + validate a corpus fixture from disk. Returns null when the file is
// absent, unreadable, malformed, or empty -- the gate treats null as "no
// corpus committed yet, skip".
export function loadFoundryCorpus(path: string): FoundryCorpus | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return validateCorpus(JSON.parse(text));
  } catch {
    return null;
  }
}
