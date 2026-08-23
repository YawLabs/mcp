// BM25 ranking for dispatch + context-aware discover.
//
// The pre-BM25 ranker was substring-only: a query for "file a PR" would
// never match a GitHub server whose description didn't literally contain
// the word "PR". BM25 fixes that by treating every configured server as a
// document, computing proper IDF across the corpus, and summing per-term
// scores over weighted fields. The corpus is tiny (<100s of servers per
// account), so the O(N*M) prep cost is negligible.
//
// We deliberately skip stemming / synonyms / embeddings here — BM25 with
// good field weights captures the 80% case, and a semantic Stage 2 (on
// the server side) will handle semantic matches when it lands.

export interface RankableTool {
  name: string;
  description?: string;
}

export interface RankableServer {
  namespace: string;
  name: string;
  description?: string;
  tools: RankableTool[];
}

export interface RankedResult {
  namespace: string;
  score: number;
}

// Default BM25 constants. k1 controls term-frequency saturation; b controls
// length normalization. 1.2 / 0.75 are the canonical defaults — tuning them
// for our corpus would be premature given we have no usage data yet.
const K1 = 1.2;
const B = 0.75;

// Field weights — tuned by intuition, not data. Name is the strongest
// signal (users often include the server name in the query), tool names
// are next, then descriptions. Adjust if real-world ranking quality
// disappoints.
const FIELD_WEIGHTS = {
  name: 3.0,
  namespace: 2.0,
  description: 1.5,
  toolName: 2.0,
  toolDescription: 1.0,
} as const;

// Drop tokens shorter than 3 chars — kills most noise words (a, an, of,
// the, to, is) without needing a stopword list. This is the PROSE floor:
// it applies to descriptions, where noise words actually live.
const MIN_TOKEN_LEN = 3;

// Identifier fields (namespace, server name, tool name) use a length-1
// floor instead. The prose floor applied to them too, which silently
// deleted a whole field from the index for any server named `pg`, `gh`,
// or `db`: tokenize("pg") is [], so the namespace field -- the
// second-heaviest weight at 2.0 -- was permanently empty and short-circuited
// in bm25Score, and an intent that named only the short namespace ("use pg")
// ranked nothing at all. Same story for `s3` / `ec2` fragments inside tool
// names. Identifiers are chosen, not written: a 1-2 char identifier is a
// deliberate name, not a stopword, so there is no noise to suppress.
const MIN_IDENT_TOKEN_LEN = 1;

function splitTokens(text: string | undefined, minLen: number): string[] {
  if (!text) return [];
  // Split on any non-alphanumeric run so snake_case, kebab-case, and
  // mixed punctuation all produce the same tokens. This is what lets
  // "create issue" match a tool named `create_issue` — critical because
  // MCP tool names are overwhelmingly snake_case. The length filter also
  // drops the empty strings a leading/trailing separator produces.
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= minLen);
}

/** Prose tokenizer (3-char floor). Also the shape external callers get --
 *  foundry.ts and the re-dispatch miss detector in server.ts both compare
 *  intent text with it, so widening THIS would change their recall too. */
export function tokenize(text: string | undefined): string[] {
  return splitTokens(text, MIN_TOKEN_LEN);
}

/** Identifier tokenizer (1-char floor). Used for the namespace / name /
 *  tool-name DOCUMENT fields, where a 1-2 char token is always a deliberate
 *  name. The query goes through tokenizeQuery instead -- see why there. */
function tokenizeIdent(text: string | undefined): string[] {
  return splitTokens(text, MIN_IDENT_TOKEN_LEN);
}

// English closed-class function words below the prose floor. The query used
// to be tokenized with the bare identifier floor, on the reasoning that a
// short noise word "can only ever match an identifier field, and a term
// absent from the whole corpus has no IDF entry" -- both true, and together
// they still let the noise score, because a preposition is a routine whole
// SEGMENT of a snake_case tool name. `export_to_csv` puts `to` in the corpus
// under toolName (weight 2.0), and a function word inside a corpus of
// identifiers is RARE, so its IDF is high rather than low. The result was
// invented relevance: "convert the spreadsheet to a chart" scored a Postgres
// server ~1.5 on `to` alone, which clears dispatch (no score floor,
// server.ts:2384) and discover's auto-warm gate (1.0 with no runner-up,
// server.ts:1372), so an unrelated intent spawned Postgres and was told
// "loaded top 1 of 1 matching servers".
//
// So: keep the 1-char floor on the document side and on the query, and
// subtract exactly the words that are never content terms. Entries are all
// sub-floor by construction -- a 3+ char word here would be inert, since
// terms the prose floor already admitted ("the", "and", "for") are unchanged
// by this fix and out of its scope.
//
// Deliberately ABSENT even though they look like function words: `do`
// (DigitalOcean), `go` (Go toolchain), `pr`, `id`, `db`, `pg`, `gh`, `ai`,
// `s3`, `vm`, `os`, `js`, `ts`. Short identifiers are the entire reason the
// query floor was widened; a filter that ate them would trade one silent
// recall hole for another.
const SUB_FLOOR_STOPWORDS = new Set([
  // articles, prepositions, particles
  "a",
  "an",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  // conjunctions
  "if",
  "or",
  "so",
  // pronouns
  "i",
  "he",
  "it",
  "me",
  "my",
  "us",
  "we",
  // copula / auxiliary, negation
  "am",
  "be",
  "is",
  "no",
  // fragments left behind when splitTokens breaks on an apostrophe:
  // don't -> don/t, it's -> it/s, we're -> we/re, I've -> i/ve, I'll -> i/ll
  "d",
  "ll",
  "m",
  "re",
  "s",
  "t",
  "ve",
]);

/** Query tokenizer. Same 1-char floor as the document identifier fields --
 *  "use pg" has to survive or the document-side widening is unreachable --
 *  minus the closed-class words that floor would otherwise admit.
 *  Exported for foundry.ts: the harvest must tokenize intents with the SAME
 *  floor the live ranker uses, or short identifiers (pg, gh, s3) are deleted
 *  from the corpus that scores that very ranker. */
export function tokenizeQuery(text: string | undefined): string[] {
  return tokenizeIdent(text).filter((t) => t.length >= MIN_TOKEN_LEN || !SUB_FLOOR_STOPWORDS.has(t));
}

type FieldName = keyof typeof FIELD_WEIGHTS;

/** A field reduced to exactly what BM25 needs: its token count (for length
 *  normalization) and per-term occurrences. Storing counts instead of the
 *  raw token array turns term-frequency lookup into a Map hit rather than
 *  a linear scan of the field for every (query term, field) pair. */
interface FieldStats {
  len: number;
  counts: Map<string, number>;
}

type DocFields = Record<FieldName, FieldStats>;

function emptyField(): FieldStats {
  return { len: 0, counts: new Map() };
}

/** Fold tokens into a FieldStats, accumulating onto an existing one so the
 *  tool fields can absorb every tool without an intermediate array. */
function addTokens(field: FieldStats, tokens: string[]): FieldStats {
  for (const t of tokens) {
    field.counts.set(t, (field.counts.get(t) ?? 0) + 1);
  }
  field.len += tokens.length;
  return field;
}

function buildDocFields(server: RankableServer): DocFields {
  const toolName = emptyField();
  const toolDescription = emptyField();
  for (const tool of server.tools) {
    addTokens(toolName, tokenizeIdent(tool.name));
    addTokens(toolDescription, tokenize(tool.description));
  }
  return {
    namespace: addTokens(emptyField(), tokenizeIdent(server.namespace)),
    name: addTokens(emptyField(), tokenizeIdent(server.name)),
    description: addTokens(emptyField(), tokenize(server.description)),
    toolName,
    toolDescription,
  };
}

// Weighted BM25 across multiple fields — treats each field as its own
// "document" with its own length, then sums contributions weighted by the
// field's importance. This is the "BM25F" variant (Robertson et al. 2004),
// simplified: we use the same k1/b for every field rather than per-field
// tuning, which would be overfitting at this corpus size.
function bm25Score(
  queryTerms: string[],
  fields: DocFields,
  avgFieldLen: Record<keyof DocFields, number>,
  idfValues: Map<string, number>,
): number {
  let score = 0;
  const seen = new Set<string>(); // dedupe query terms — "github github" shouldn't double-count

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);

    const termIdf = idfValues.get(term);
    if (termIdf === undefined || termIdf <= 0) continue; // term missing or appears in every doc

    for (const [fieldName, weight] of Object.entries(FIELD_WEIGHTS) as Array<[keyof DocFields, number]>) {
      const field = fields[fieldName];
      if (field.len === 0) continue;
      const tf = field.counts.get(term) ?? 0;
      if (tf === 0) continue;
      const avg = avgFieldLen[fieldName] || 1;
      const normLen = 1 - B + B * (field.len / avg);
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * normLen;
      score += weight * termIdf * (numerator / denominator);
    }
  }

  return score;
}

// --- Index caching ---------------------------------------------------------
//
// Everything BM25 needs apart from the query itself -- per-field token
// counts, document frequency, IDF, average field lengths -- is a pure
// function of the CORPUS. Rebuilding it per call meant re-tokenizing every
// server name, description, and (dominant term) every tool name and
// description on every discover/dispatch, which profiles at ~90% of the
// call cost while the actual scoring is ~10%.
//
// Both caches are keyed on the corpus CONTENT, not on object identity:
// callers rebuild their RankableServer array on every call (see
// ConnectServer.rankableFor), so identity keys would never hit, and a
// content key makes stale results impossible by construction -- if any
// name, description, or tool text changes, the key changes with it.
// Building the key costs ~3% of what tokenizing the same text costs.

/** Per-server DocFields, keyed by that server's content signature. Sized to
 *  outlive a corpus edit: when one server activates, the other N-1 keys are
 *  unchanged and their fields are reused. */
const MAX_CACHED_DOCS = 512;
const docCache = new Map<string, DocFields>();

/** Whole-corpus index, keyed by the joined per-server signatures. A handful
 *  of entries covers the alternation between discover's corpus (all profiled
 *  servers) and dispatch's (a caller-supplied subset). */
const MAX_CACHED_INDEXES = 4;
const indexCache = new Map<string, RankingIndex>();

interface RankingIndex {
  docs: Array<{ namespace: string; fields: DocFields }>;
  idf: Map<string, number>;
  avgFieldLen: Record<FieldName, number>;
}

/** Build counters, exposed for tests to assert the caches actually hit
 *  rather than relying on flaky wall-clock timing. */
let indexBuilds = 0;
let docBuilds = 0;

/** Test hook: drop both caches and zero the counters. */
export function resetRelevanceCache(): void {
  docCache.clear();
  indexCache.clear();
  indexBuilds = 0;
  docBuilds = 0;
}

/** Test hook: how many times an index / document has actually been built. */
export function relevanceCacheStats(): { indexBuilds: number; docBuilds: number } {
  return { indexBuilds, docBuilds };
}

/** Insert into a bounded, LRU-ordered cache, evicting the least recently used
 *  entry once the cap is reached. Map iteration order is insertion order, so
 *  the LRU ordering is maintained by `touch` re-inserting on every hit. */
function putBounded<V>(cache: Map<string, V>, key: string, value: V, max: number): void {
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Move an existing entry to the newest position, so eviction is LRU rather
 *  than FIFO. Without this a server whose content never changes stays
 *  permanently "oldest" and gets evicted by a churning neighbour -- which is
 *  exactly the reuse the doc cache exists to provide. Measured on a 100-server
 *  corpus with one server churning: FIFO spent 798 doc builds over 600 calls
 *  against an ideal 699, and 2495 over 2000 against an ideal 2099. LRU hits
 *  the ideal exactly. */
function touch<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

/** Field separator for a server signature. Doubled wherever it occurs
 *  inside a field, which makes the encoding unambiguous: a lone separator is
 *  a field boundary, a doubled one is literal text. */
const SEP = "\u0000";

/** Escape the separator out of one field. Upstream tool names and
 *  descriptions arrive from third-party servers over JSON-RPC, where every
 *  character -- control characters included -- is legal string content, so a
 *  scheme that assumed some byte was absent would be trusting the untrusted
 *  side. The scan allocates nothing in the overwhelming common case of text
 *  that contains no separator at all. */
function esc(text: string): string {
  return text.includes(SEP) ? text.replaceAll(SEP, SEP + SEP) : text;
}

/** Content signature for one server: every string BM25 will read, in order,
 *  separator-escaped so distinct field splits cannot collide onto one key.
 *  Without the escaping, namespace "a b" + name "c" signs identically to
 *  namespace "a" + name "b c", silently serving one corpus its neighbour's
 *  index -- and with a bare control character as the separator, the text that
 *  triggers the collision is supplied by the upstream server. */
function serverSignature(server: RankableServer): string {
  let sig = `${esc(server.namespace)}${SEP}${esc(server.name)}${SEP}${esc(server.description ?? "")}`;
  for (const tool of server.tools) {
    sig += `${SEP}${esc(tool.name)}${SEP}${esc(tool.description ?? "")}`;
  }
  return sig;
}

/** Whole-corpus key. The per-server signature lengths go in front so the
 *  concatenation that follows parses unambiguously without a third separator
 *  level -- there are only as many numbers here as there are servers, so this
 *  costs nothing next to the corpus text itself. Without the lengths a single
 *  server whose text embeds the join separator signs identically to a
 *  two-server corpus, and a 1-doc corpus gets served a 2-doc index: wrong N,
 *  wrong IDF, and a ranked namespace the caller never passed in. */
function indexKeyFor(signatures: string[]): string {
  let lens = "";
  for (const sig of signatures) lens += `${sig.length},`;
  return `${lens}|${signatures.join("")}`;
}

function docFieldsFor(signature: string, server: RankableServer): DocFields {
  const cached = docCache.get(signature);
  if (cached) {
    touch(docCache, signature, cached);
    return cached;
  }
  docBuilds++;
  const fields = buildDocFields(server);
  putBounded(docCache, signature, fields, MAX_CACHED_DOCS);
  return fields;
}

function buildIndex(servers: RankableServer[], signatures: string[]): RankingIndex {
  indexBuilds++;
  const docs = servers.map((s, i) => ({ namespace: s.namespace, fields: docFieldsFor(signatures[i], s) }));
  const N = docs.length;

  // Document frequency — how many servers contain the term in ANY field.
  // Treating all fields as a single bag for DF is a deliberate simplification;
  // "contains the term somewhere" is what matters for IDF, not where.
  const df = new Map<string, number>();
  for (const { fields } of docs) {
    const bag = new Set<string>();
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
      for (const term of fields[fieldName].counts.keys()) bag.add(term);
    }
    for (const term of bag) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Per-term IDF using the standard BM25 formula with +1 so that terms
  // appearing in every document still get a tiny positive weight rather
  // than contributing a negative score.
  const idf = new Map<string, number>();
  for (const [term, d] of df) {
    idf.set(term, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  }

  // Average length per field across the corpus — used by length
  // normalization so longer fields don't inherently outscore shorter ones
  // just by having more chances to match.
  const totalLen: Record<FieldName, number> = {
    namespace: 0,
    name: 0,
    description: 0,
    toolName: 0,
    toolDescription: 0,
  };
  for (const { fields } of docs) {
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as FieldName[]) {
      totalLen[fieldName] += fields[fieldName].len;
    }
  }
  // Local divide-by-zero guard: rankServers early-returns on an empty
  // corpus so N>0 here today, but clamp the divisor so this block is
  // self-safe and won't emit NaN if the guard ever moves.
  const denom = Math.max(N, 1);
  const avgFieldLen: Record<FieldName, number> = {
    namespace: totalLen.namespace / denom,
    name: totalLen.name / denom,
    description: totalLen.description / denom,
    toolName: totalLen.toolName / denom,
    toolDescription: totalLen.toolDescription / denom,
  };

  return { docs, idf, avgFieldLen };
}

/** Score a prepared index against an already-tokenized query. */
function scoreAgainstIndex(queryTerms: string[], index: RankingIndex): RankedResult[] {
  const results: RankedResult[] = [];
  for (const { namespace, fields } of index.docs) {
    const score = bm25Score(queryTerms, fields, index.avgFieldLen, index.idf);
    if (score > 0) {
      results.push({ namespace, score });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tie-break by namespace so test assertions don't flake
    return a.namespace < b.namespace ? -1 : 1;
  });

  return results;
}

// Rank a list of servers against a free-text query. Returns results sorted
// descending by score, only including entries with score > 0 (matches at
// least one query term in some field). Zero-score servers are omitted so
// the caller can cleanly tell "no match" from "weak match".
export function rankServers(context: string, servers: RankableServer[]): RankedResult[] {
  // Identifier floor on the query, not the prose floor: "use pg" has to
  // survive tokenization or the short-namespace fix on the document side is
  // unreachable. Minus closed-class function words -- see SUB_FLOOR_STOPWORDS
  // for why the identifier floor alone was not safe on the query side.
  const queryTerms = tokenizeQuery(context);
  if (queryTerms.length === 0 || servers.length === 0) return [];

  const signatures = servers.map(serverSignature);
  const indexKey = indexKeyFor(signatures);
  let index = indexCache.get(indexKey);
  if (index === undefined) {
    index = buildIndex(servers, signatures);
    putBounded(indexCache, indexKey, index, MAX_CACHED_INDEXES);
  } else {
    touch(indexCache, indexKey, index);
  }

  return scoreAgainstIndex(queryTerms, index);
}

// A single-server `scoreRelevance` wrapper used to live here, documented as
// "kept for legacy callers that score one candidate at a time." No such
// caller existed anywhere in the repo -- only its own tests -- and it carried
// a bypass of indexCache (plus a regression test guarding that bypass) whose
// only purpose was to stop a loop over the wrapper from evicting the real
// corpus index. Deleted rather than re-documented: rankServers with a
// one-element array is the same computation, and the eviction subtlety stops
// existing along with the function. Tests that want a single score go through
// rankServers(query, [server])[0]?.score ?? 0.
