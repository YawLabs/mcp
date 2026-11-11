// BM25 ranking for dispatch + context-aware discover.
//
// The pre-BM25 ranker was substring-only: a query for "file a PR" would
// never match a GitHub server whose description didn't literally contain
// the word "PR". BM25 fixes that by treating every configured server as a
// document, computing proper IDF across the corpus, and summing per-term
// scores over weighted fields. The corpus is tiny (<100s of servers per
// install), so the O(N*M) prep cost is negligible.
//
// Terms are normalized before they are counted -- a light suffix fold
// (normalizeTerm) plus a small generic abbreviation map and aliases derived
// from the installed servers' own identifiers (see "Term normalization"
// below) -- but there are no embeddings: lexical BM25 with good field
// weights captures the bulk of the cases. This used to promise "a semantic
// Stage 2 (on the server side) will handle semantic matches when it lands";
// the hosted backend that Stage 2 would have run on is retired, so there is
// no second stage to land and this file is the whole ranker. (server.ts's
// rankIntentCandidates -- formerly twoStageRank, a name left over from that
// plan -- calls rankServers once and slices the top K; the optional LLM
// tiebreak that follows in dispatch is a disambiguator over those candidates,
// not a ranking stage.)
// If semantic matching is ever wanted it has to be built here, locally, not
// waited for.

import { createHash } from "node:crypto";

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

/** Prose tokenizer (3-char floor). Exactly one production consumer outside
 *  this file: the re-dispatch miss detector in server.ts, which compares intent
 *  text with it, so widening THIS would change its recall too. (foundry.ts used
 *  to be the second, which is what this comment claimed; the harvest moved to
 *  tokenizeQuery so it tokenizes at the floor the live ranker actually uses.) */
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
// server ~1.5 on `to` alone, which clears dispatch (no score floor, in
// ConnectServer.handleDispatch) and discover's auto-warm gate (1.0 with no
// runner-up, in ConnectServer.handleDiscoverWithAutoWarm), so an unrelated
// intent spawned Postgres and was told "loaded top 1 of 1 matching servers".
//
// So: keep the 1-char floor on the document side and on the query, and
// subtract exactly the words that are never content terms. Entries are all
// sub-floor by construction: tokenizeQuery is also what the foundry harvest
// and discover's match summary read, so it subtracts only the words below the
// prose floor that it alone admits. The 3+ char function words ("the", "and",
// "for") are dropped later, inside the rankers (QUERY_FUNCTION_WORDS).
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
 *  Exported for the two callers that have to agree with the live ranker rather
 *  than roll a third floor of their own: the foundry harvest, which would
 *  otherwise delete short identifiers (pg, gh, s3) from the corpus that scores
 *  this very ranker, and discover's match summary in server.ts, whose per-tool
 *  set intersection would otherwise credit a tool for a term the ranker
 *  deliberately strips. */
export function tokenizeQuery(text: string | undefined): string[] {
  return tokenizeIdent(text).filter((t) => t.length >= MIN_TOKEN_LEN || !SUB_FLOOR_STOPWORDS.has(t));
}

// --- Term normalization ----------------------------------------------------
//
// Exact-token matching missed the commonest surface variation in a request:
// "open a pull request" never met a description saying "pull requests",
// "issues" and "issue" were different terms, "vulnerable" never met
// "vulnerabilities", and "list my PRs" matched nothing GitHub-shaped at all.
// Every token -- query AND document, every field -- now goes through
// normalizeTerm before it is counted or looked up, so both sides fold to the
// same form. tokenize / tokenizeQuery above are unchanged and still return
// surface tokens: their outside callers (the re-dispatch miss detector, the
// foundry harvest, discover's match summary) compare raw text, not index
// terms.

/** Generic developer abbreviations, folded to their long form on both sides.
 *  Written as a general vocabulary list, not from any install's misses, and
 *  keyed on no server's namespace: every entry is an abbreviation people type
 *  for a concept, so "k8s" and "kubernetes", or "repo" and "repository", are
 *  one term wherever either appears. Two folds a measured prototype found
 *  harmful are deliberately absent: http -> fetch (every URL in a prompt
 *  carries "http", so "with playwright, open http://localhost:5173 and take a
 *  screenshot" went to a fetch server) and folder -> directory (it sent "my
 *  cloud folder" to a local filesystem server instead of the cloud drive). */
const ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
  pr: ["pull", "request"],
  prs: ["pull", "request"],
  k8s: ["kubernetes"],
  repo: ["repository"],
  repos: ["repository"],
  db: ["database"],
  dbs: ["database"],
  gh: ["github"],
  pkg: ["package"],
  pkgs: ["package"],
  dep: ["dependency"],
  deps: ["dependency"],
  dir: ["directory"],
  dirs: ["directory"],
  doc: ["documentation"],
  docs: ["documentation"],
  config: ["configuration"],
  configs: ["configuration"],
  cfg: ["configuration"],
  auth: ["authentication"],
  env: ["environment"],
  envs: ["environment"],
  cred: ["credential"],
  creds: ["credential"],
  cert: ["certificate"],
  certs: ["certificate"],
  msg: ["message"],
  msgs: ["message"],
  img: ["image"],
  imgs: ["image"],
  param: ["parameter"],
  params: ["parameter"],
  arg: ["argument"],
  args: ["argument"],
  info: ["information"],
  perf: ["performance"],
  stats: ["statistic"],
  prod: ["production"],
  mgmt: ["management"],
  txn: ["transaction"],
  js: ["javascript"],
  ts: ["typescript"],
  py: ["python"],
};

/** Words the plural / suffix fold below would mangle into a different word
 *  ("news" -> "new", "series" -> "sery"), plus singulars ending in -as whose
 *  final s is not a plural: left whole they meet their own inflections
 *  ("aliases" / "aliased" -> "alias"), where the plain -s strip gave "alia".
 *  Listed by name because -as cannot be protected the way -ss/-us/-is are:
 *  that would stop "schemas", "quotas" and "replicas" meeting their
 *  singulars. */
const STEM_EXCEPTIONS = new Set(["news", "series", "species", "always", "perhaps", "alias", "atlas", "bias", "canvas"]);

const VOWEL = /[aeiouy]/;

/** Drop a doubled final consonant left by a suffix strip: "running" -> "runn"
 *  -> "run", "mapped" -> "mapp" -> "map". l, s and z stay doubled ("installed"
 *  -> "install", "processed" -> "process"). */
function undouble(s: string): string {
  const n = s.length;
  // n >= 4: a 3-letter stem keeps its double ("adding" -> "add", not "ad",
  // which would fall under the 3-character floor and leave "adding" unfolded).
  return n >= 4 && s[n - 1] === s[n - 2] && !/[aeiouylsz]/.test(s[n - 1]) ? s.slice(0, -1) : s;
}

/** A 3-letter consonant-vowel-consonant stem ("sav", "cod", "fix"). */
function isShortCvc(s: string): boolean {
  return s.length === 3 && !VOWEL.test(s[0]) && VOWEL.test(s[1]) && !VOWEL.test(s[2]);
}

/** Finish an -ed / -ing strip, Porter-style: undouble a doubled consonant
 *  ("running" -> "runn" -> "run"), else put back the silent e a 4-letter base
 *  lost ("saved" / "saving" -> "sav" -> "save", "coding" -> "code"), so the
 *  inflected forms meet the base word, which is too short for the final-e
 *  strip below. No e after w/x/y ("fixed" -> "fix"). */
function restoreE(stem: string): string {
  const u = undouble(stem);
  if (u !== stem) return u;
  return isShortCvc(stem) && !/[wxy]$/.test(stem) ? `${stem}e` : stem;
}

/** Light suffix fold, a few Porter-style rules rather than a full stemmer:
 *  plurals (ies/sses/xes/ches/shes/s) and a singular -ie, then -ied/-ing/-ed, then
 *  -ability/-able, then a final -e. The output is a matching key, not a word
 *  ("issue" and "issues" both fold to "issu", "create" / "created" /
 *  "creating" to "creat", "save" / "saved" / "saving" to "save"); it only has
 *  to be the SAME key for both sides.
 *
 *  Tokens of three characters or fewer, and any token containing a digit, are
 *  returned untouched: those are identifiers (pg, gh, aws, s3, ec2, v2), and
 *  a fold that turned "aws" into "aw" would be the short-identifier recall
 *  hole tokenizeIdent exists to close. -ing and -ed strip only when what is
 *  left still carries a vowel ("string" stays "string", not "str") and never
 *  from -eed ("speed", "need"). */
export function normalizeTerm(token: string): string {
  if (token.length <= 3 || /\d/.test(token) || STEM_EXCEPTIONS.has(token)) return token;
  let s = token;
  if (s.endsWith("ies") && s.length > 4) s = `${s.slice(0, -3)}y`;
  // A singular in -ie takes the key its plural just got ("cookie" / "cookies"
  // -> "cooky"); the final-e strip below would leave it at "cooki" instead.
  else if (s.endsWith("ie") && s.length > 4) s = `${s.slice(0, -2)}y`;
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(?:x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);

  if (s.endsWith("ied") && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("ing") && s.length >= 6 && VOWEL.test(s.slice(0, -3))) s = restoreE(s.slice(0, -3));
  else if (s.endsWith("ed") && !s.endsWith("eed") && s.length >= 5 && VOWEL.test(s.slice(0, -2))) {
    const stem = s.slice(0, -2);
    // A 3-letter -ed stem that is not CVC is a root ending in "ed", not an
    // inflection of an e-final verb: "embed" stays whole so it meets
    // "embedding" -> "embed". Cost: "asked" / "ended" / "added" stay whole too.
    if (stem.length > 3 || isShortCvc(stem)) s = restoreE(stem);
  }

  if (s.endsWith("ability") && s.length >= 9) s = s.slice(0, -7);
  // Not "disable": there -able is the root, not a suffix, and stripping it
  // left "dis" while "disabled" / "disabling" fold to "disabl".
  else if (s.endsWith("able") && s.length >= 7 && s !== "disable") s = s.slice(0, -4);
  if (s.endsWith("e") && s.length >= 5) s = s.slice(0, -1);
  return s.length >= 3 ? s : token;
}

/** Surface tokens -> index terms: abbreviation expansion, then the suffix
 *  fold. One surface token can become several terms ("pr" -> pull, request). */
function normalizeTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const expanded = ABBREVIATIONS[t];
    if (expanded) for (const e of expanded) out.push(normalizeTerm(e));
    else out.push(normalizeTerm(t));
  }
  return out;
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

/** One tool's normalized terms, for rankTools. */
interface ToolTerms {
  name: Set<string>;
  /** Name terms in order, duplicates kept -- the tie-break counts how many of
   *  them the query left unmatched. */
  nameList: string[];
  desc: Set<string>;
}

/** Everything both rankers need from one server, built once per distinct
 *  server content and cached (see docCache). `tools[i]` is `server.tools[i]`:
 *  the cache key covers every tool in order, so the alignment holds for any
 *  server array that produced the same key. */
interface IndexedDoc {
  fields: DocFields;
  tools: ToolTerms[];
  namespaceTerms: string[];
}

function buildDoc(server: RankableServer): IndexedDoc {
  const toolName = emptyField();
  const toolDescription = emptyField();
  const tools: ToolTerms[] = [];
  for (const tool of server.tools) {
    const nameList = normalizeTokens(tokenizeIdent(tool.name));
    const descList = normalizeTokens(tokenize(tool.description));
    addTokens(toolName, nameList);
    addTokens(toolDescription, descList);
    tools.push({ name: new Set(nameList), nameList, desc: new Set(descList) });
  }
  const namespaceTerms = normalizeTokens(tokenizeIdent(server.namespace));
  return {
    fields: {
      namespace: addTokens(emptyField(), namespaceTerms),
      name: addTokens(emptyField(), normalizeTokens(tokenizeIdent(server.name))),
      description: addTokens(emptyField(), normalizeTokens(tokenize(server.description))),
      toolName,
      toolDescription,
    },
    tools,
    namespaceTerms,
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
    // `undefined` is the live case: the term appears in no document, so it
    // has no IDF entry. The `<= 0` arm is DEFENSIVE ONLY and unreachable
    // under the formula this file uses: buildIndex computes
    // log((N - d + 0.5) / (d + 0.5) + 1), whose argument exceeds 1 for every
    // d in [1, N], so a term present in every document still scores a small
    // positive IDF rather than zero or negative. It is kept for the
    // un-shifted textbook BM25 IDF -- log((N - d + 0.5) / (d + 0.5)), which
    // DOES go negative once a term is in more than about half the corpus --
    // so swapping the formula back cannot silently start subtracting score.
    if (termIdf === undefined || termIdf <= 0) continue;

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
//
// The key is a DIGEST of that content, not the content itself. Keyed on the
// raw signature, a 512-entry doc cache pins 512 copies of every tool name and
// description its servers ever published (multi-KB apiece for a large
// upstream) plus four whole-corpus keys that each concatenate the entire
// corpus -- resident for the life of the process, purely as Map keys nothing
// ever reads back. Hashing keeps every correctness property (same content ->
// same key, any edit -> a different key) and drops the retained text to a
// fixed 43 bytes per entry.

/** Content digest used for both cache keys. sha256 rather than a cheap
 *  32-bit hash because a collision here does not degrade a lookup, it serves
 *  one corpus another corpus's index: wrong N, wrong IDF, and a ranked
 *  namespace the caller never passed in. At 512 doc entries a 32-bit FNV
 *  carries a ~3e-5 birthday chance of exactly that; sha256 puts it below any
 *  rate worth reasoning about, and hashing a few KB costs microseconds
 *  against the tokenization this cache exists to skip. base64url keeps the
 *  key to 43 chars with no padding. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

/** Per-server IndexedDoc, keyed by the digest of that server's content
 *  signature. Sized to outlive a corpus edit: when one server activates, the
 *  other N-1 keys are unchanged and their fields are reused. */
const MAX_CACHED_DOCS = 512;
const docCache = new Map<string, IndexedDoc>();

/** Whole-corpus index, keyed by the digest of the joined per-server digests.
 *  A handful of entries covers the alternation between discover's corpus (all
 *  profiled servers) and dispatch's (a caller-supplied subset). */
const MAX_CACHED_INDEXES = 4;
const indexCache = new Map<string, RankingIndex>();

interface RankingIndex {
  docs: Array<{ namespace: string } & IndexedDoc>;
  idf: Map<string, number>;
  avgFieldLen: Record<FieldName, number>;
  /** Query-side aliases derived from this corpus's identifiers (see
   *  deriveAliases): surface token -> index terms. */
  aliases: Map<string, string[]>;
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

/** Test hook: total bytes of KEY text currently resident in each cache, plus
 *  the longest single key. Exists so the "keys are digests, not corpus text"
 *  property is pinned by a test rather than by a comment -- keyed on the raw
 *  signature these numbers grow with the corpus, which is the leak the digest
 *  fixes. */
export function relevanceCacheKeyBytes(): { docKeyBytes: number; indexKeyBytes: number; longestKey: number } {
  let docKeyBytes = 0;
  let indexKeyBytes = 0;
  let longestKey = 0;
  for (const key of docCache.keys()) {
    docKeyBytes += key.length;
    longestKey = Math.max(longestKey, key.length);
  }
  for (const key of indexCache.keys()) {
    indexKeyBytes += key.length;
    longestKey = Math.max(longestKey, key.length);
  }
  return { docKeyBytes, indexKeyBytes, longestKey };
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

/** Field separator for a server signature, plus the escape byte that makes the
 *  encoding injective: inside a field ESC is written ESC ESC and SEP is written
 *  ESC SEP, so a bare SEP is always a field boundary and no field content can
 *  forge one.
 *
 *  Doubling the separator instead -- the previous scheme -- is NOT unambiguous,
 *  whatever its comment claimed: a field ending in SEP followed by a field "b",
 *  and a field "a" followed by a field starting with SEP, both render as
 *  a SEP SEP SEP b, so two distinct servers sign identically. That never
 *  poisoned the cache only because the bytes that shift across the boundary in
 *  such a pair are SEPs themselves, and SEP is also a token separator, so the
 *  colliding corpora happened to tokenize alike -- a property of the byte
 *  chosen, not of the encoding. */
const SEP = "\u0000";
const ESC = String.fromCharCode(1); // U+0001 SOH

/** Escape the separator -- and the escape byte itself -- out of one field.
 *  Upstream tool names and descriptions arrive from third-party servers over
 *  JSON-RPC, where every character -- control characters included -- is legal
 *  string content, so a scheme that assumed some byte was absent would be
 *  trusting the untrusted side. Order matters: ESC is escaped first, or the ESC
 *  this function puts in front of a SEP would be escaped again on the second
 *  pass. The scan allocates nothing in the overwhelming common case of text
 *  that contains neither byte. */
function esc(text: string): string {
  return text.includes(ESC) || text.includes(SEP) ? text.replaceAll(ESC, ESC + ESC).replaceAll(SEP, ESC + SEP) : text;
}

/** Content signature for one server: every string BM25 will read, in order,
 *  escaped through `esc` so distinct field splits cannot collide onto one key.
 *  Unescaped, namespace "a b" + name "c" signs identically to namespace "a" +
 *  name "b c", silently serving one corpus its neighbour's index -- and since
 *  the separator is a bare control character, the text that triggers the
 *  collision is supplied by the upstream server. */
function serverSignature(server: RankableServer): string {
  let sig = `${esc(server.namespace)}${SEP}${esc(server.name)}${SEP}${esc(server.description ?? "")}`;
  for (const tool of server.tools) {
    sig += `${SEP}${esc(tool.name)}${SEP}${esc(tool.description ?? "")}`;
  }
  return sig;
}

/** Whole-corpus key: the digest of the per-server digests, joined. The old
 *  scheme prefixed the raw signature LENGTHS so the concatenation that
 *  followed parsed unambiguously; fixed-width digests make that unnecessary
 *  by construction -- every element is exactly as long as every other, so no
 *  two different corpora can produce the same join. (The hazard the lengths
 *  guarded against is real and unchanged: a single server whose text embeds
 *  the join separator must not sign identically to a two-server corpus, or a
 *  1-doc corpus gets served a 2-doc index -- wrong N, wrong IDF, and a ranked
 *  namespace the caller never passed in.) Hashing the join keeps the resident
 *  key at 43 bytes instead of 43*N. */
function indexKeyFor(docKeys: string[]): string {
  return digest(docKeys.join(""));
}

function docFor(docKey: string, server: RankableServer): IndexedDoc {
  const cached = docCache.get(docKey);
  if (cached) {
    touch(docCache, docKey, cached);
    return cached;
  }
  docBuilds++;
  const doc = buildDoc(server);
  putBounded(docCache, docKey, doc, MAX_CACHED_DOCS);
  return doc;
}

// --- Aliases derived from the installed servers ----------------------------
//
// The abbreviation map above is generic vocabulary. Installs also carry their
// own shorthand that no global list can know, and the identifiers already
// spell it out: a server whose tools say `resource_group` five times is the
// server "rg" means, and a namespace called `kubernetes` is what "k8s" means.
// So at index time two alias shapes are read off the corpus's IDENTIFIERS
// (namespace, server name, tool names -- never prose descriptions, where
// adjacent words are not a phrase):
//
//   * acronym of a recurring two- or three-word identifier phrase
//     (`virtual_machine` -> "vm", `resource_group` -> "rg");
//   * numeronym of a long namespace or server-name word
//     (kubernetes -> "k8s", internationalization -> "i18n").
//
// An alias only ever applies to a query token that is NOT itself a term in
// the corpus, so it can add recall but never re-route a word some server
// already uses. A short token is precious (see SUB_FLOOR_STOPWORDS and the
// "go" / "do" namespaces), so the acronym rules are strict: every word of the
// phrase is a 3+ letter word that is not a common action verb, not a generic
// product word (mcp, server, api ...) and, in a tool name, not the server's
// own namespace or name; the phrase recurs (two or more tool names) unless it
// is exactly one server's namespace or name; and an acronym two different
// phrases produce is dropped as ambiguous.

/** Generic action verbs that lead most tool names. A phrase starting or
 *  containing one is an operation, not a noun people abbreviate: `get_user`
 *  is not "gu". */
const ACTION_VERBS = new Set([
  "get",
  "set",
  "list",
  "create",
  "delete",
  "update",
  "add",
  "remove",
  "read",
  "write",
  "run",
  "fetch",
  "search",
  "find",
  "check",
  "show",
  "open",
  "close",
  "start",
  "stop",
  "put",
  "post",
  "patch",
  "send",
  "describe",
  "query",
  "execute",
  "exec",
  "upload",
  "download",
  "install",
  "enable",
  "disable",
]);

/** Words that name the kind of thing a server is rather than what it does.
 *  Server names are full of them ("Slack MCP Server", "Jira API Client"),
 *  so a phrase containing one is packaging, not a noun people abbreviate:
 *  "MCP Server" twice in an install must not make "ms" an alias that routes
 *  "50 ms" to whichever servers carry the filler. */
const GENERIC_PRODUCT_WORDS = new Set(["mcp", "server", "tool", "api", "client", "plugin", "service", "sdk", "app"]);

const MIN_NUMERONYM_WORD = 8;

function deriveAliases(servers: RankableServer[], idf: Map<string, number>): Map<string, string[]> {
  // acronym -> phrase (its normalized terms, space-joined, so
  // `resource_group` and `resource_groups` are one phrase) -> how many
  // identifiers carry it
  const phrases = new Map<string, Map<string, number>>();
  // phrase -> the servers whose namespace or name carries it
  const fromName = new Map<string, Set<string>>();
  const note = (tokens: string[], nameOf: string | undefined) => {
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i + len <= tokens.length; i++) {
        const words = tokens.slice(i, i + len);
        if (!words.every((w) => /^[a-z]{3,}$/.test(w) && !ACTION_VERBS.has(w) && !GENERIC_PRODUCT_WORDS.has(w)))
          continue;
        const acronym = words.map((w) => w[0]).join("");
        const key = normalizeTokens(words).join(" ");
        let byPhrase = phrases.get(acronym);
        if (!byPhrase) {
          byPhrase = new Map();
          phrases.set(acronym, byPhrase);
        }
        // Recurrence counts tool names only; a name is recorded in fromName.
        byPhrase.set(key, (byPhrase.get(key) ?? 0) + (nameOf === undefined ? 1 : 0));
        if (nameOf !== undefined) {
          let owners = fromName.get(key);
          if (!owners) {
            owners = new Set();
            fromName.set(key, owners);
          }
          owners.add(nameOf);
        }
      }
    }
  };
  const aliases = new Map<string, string[]>();
  const offer = (alias: string, terms: string[]) => {
    if (idf.has(alias) || ABBREVIATIONS[alias] || SUB_FLOOR_STOPWORDS.has(alias)) return;
    aliases.set(alias, terms);
  };
  for (const server of servers) {
    const nsTokens = tokenizeIdent(server.namespace);
    const nameTokens = tokenizeIdent(server.name);
    note(nsTokens, server.namespace);
    note(nameTokens, server.namespace);
    // The server's own words break a tool-name phrase rather than join one:
    // `electron_scaffold_ipc` is electron's scaffold tool, not an
    // "electron scaffold" phrase whose acronym is "es".
    const own = new Set([...nsTokens, ...nameTokens]);
    for (const tool of server.tools)
      note(
        tokenizeIdent(tool.name).map((w) => (own.has(w) ? "" : w)),
        undefined,
      );
    for (const word of [...nsTokens, ...nameTokens]) {
      if (word.length >= MIN_NUMERONYM_WORD && /^[a-z]+$/.test(word)) {
        offer(`${word[0]}${word.length - 2}${word[word.length - 1]}`, normalizeTokens([word]));
      }
    }
  }
  for (const [acronym, byPhrase] of phrases) {
    if (byPhrase.size !== 1) continue; // ambiguous: two phrases, one acronym
    const [[key, count]] = [...byPhrase];
    // A name earns its acronym without recurring only when it is ONE
    // server's name: a phrase several servers' names share is not what any
    // one of them is called.
    if (count >= 2 || fromName.get(key)?.size === 1) offer(acronym, key.split(" "));
  }
  return aliases;
}

function buildIndex(servers: RankableServer[], docKeys: string[]): RankingIndex {
  indexBuilds++;
  const docs = servers.map((s, i) => ({ namespace: s.namespace, ...docFor(docKeys[i], s) }));
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

  return { docs, idf, avgFieldLen, aliases: deriveAliases(servers, idf) };
}

/** The cached index for this corpus, building it on a miss. The raw
 *  signatures are transient -- only their digests are held, and only as Map
 *  keys -- so a corpus of large upstreams does not park its whole text in the
 *  cache for the life of the process. */
function indexFor(servers: RankableServer[]): RankingIndex {
  const docKeys = servers.map((s) => digest(serverSignature(s)));
  const indexKey = indexKeyFor(docKeys);
  let index = indexCache.get(indexKey);
  if (index === undefined) {
    index = buildIndex(servers, docKeys);
    putBounded(indexCache, indexKey, index, MAX_CACHED_INDEXES);
  } else {
    touch(indexCache, indexKey, index);
  }
  return index;
}

// 3+ character English function words (plus "use" / "using", which carry no
// intent of their own). The prose floor (3 chars) admits them, so "the",
// "what", "with" used to be scoring terms in both rankers. In rankServers a
// query of nothing but them still matched: "the" alone matched 19 of 21
// servers on one real install, and dispatch, which refuses only a zero-match
// ranking, loaded one. rankTools has no IDF, so there each one was a flat +1
// for every tool whose description used it, and on a 73-tool server that
// alone decided the top of the list ("what is the capital of France" returned
// an azure tool). Every word here is removed from the query before
// normalization, by both rankers and by queryCoverage. Closed-class words
// only: none of these can name a tool, a resource or a domain.
export const QUERY_FUNCTION_WORDS = new Set(
  (
    "the and for are that this with what which how does did was were have has had our your their its " +
    "from into about can could would should will just any all some when where who why whether then than " +
    "there here also very much many not but via you they them these those been being please thanks thank " +
    "let lets since until while between among use using"
  ).split(" "),
);

/** Normalized query terms for this index, in query order, with `drop`
 *  removing surface words first. A surface token takes the generic
 *  abbreviation expansion when it has one; otherwise its folded form, unless
 *  that form is absent from the corpus and the corpus derived an alias for
 *  the token. */
function queryTermsFor(text: string, index: RankingIndex, drop?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const t of tokenizeQuery(text)) {
    if (drop?.has(t)) continue;
    const expanded = ABBREVIATIONS[t];
    if (expanded) {
      for (const e of expanded) out.push(normalizeTerm(e));
      continue;
    }
    const folded = normalizeTerm(t);
    const alias = index.idf.has(folded) ? undefined : index.aliases.get(t);
    if (alias) out.push(...alias);
    else out.push(folded);
  }
  return out;
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

  // Stable tie-break by namespace so test assertions don't flake. localeCompare
  // (as rankTools below) rather than `a < b ? -1 : 1`: that form returned 1
  // for BOTH orderings of two equal namespaces, an inconsistent comparator
  // whose output order is then whatever the sort algorithm happens to do.
  results.sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace));

  return results;
}

/** One tool, ranked across every configured server. */
export interface RankedTool {
  namespace: string;
  /** Bare tool name as the upstream declares it, e.g. "create_issue". */
  name: string;
  description?: string;
  score: number;
}

/** Did the query name this namespace? True when every identifier term of it
 *  is a query term ("aws" and "s3" for `aws_s3`). Both sides are split on the
 *  same non-alphanumeric separators and normalized the same way, so `aws_s3`,
 *  `aws-s3` and "aws s3" in the query all qualify -- while "awss3" does not:
 *  it is one token, and nothing here joins segments. A namespace that
 *  tokenizes to nothing never matches: an `every` over an empty list would be
 *  vacuously true. */
function queryNamesNamespace(queryTerms: ReadonlySet<string>, namespaceTerms: readonly string[]): boolean {
  return namespaceTerms.length > 0 && namespaceTerms.every((p) => queryTerms.has(p));
}

/** Rank TOOLS across servers, rather than ranking the servers that hold them.
 *
 *  rankServers answers "which server should I load", which is the right
 *  question when the caller knows the shape of the task. It is the wrong one
 *  when the caller knows the CAPABILITY and not its home -- and until this
 *  existed, that caller had nowhere to go: read_tool demands the namespace up
 *  front, and discover's "Matches for your query" block is prose capped at
 *  five servers by five tools with no schemas.
 *
 *  Scored by term overlap rather than the full BM25 index above, deliberately.
 *  That index is server-shaped: a document is a whole server, so its IDF is
 *  computed over server-sized documents and its length normalization divides
 *  by a server's total field length. Reusing it per tool would give a tool on
 *  a 60-tool server a systematically different score from the identical tool
 *  on a 3-tool one. (A per-tool BM25 was also measured and rejected: it rewards
 *  a rare word that happens to sit in an unrelated tool's name -- "select"
 *  pulled browser select tools over a SQL explain tool -- and its gain
 *  vanished on prompts reworded away from the descriptions' own wording.) The
 *  weighting still mirrors FIELD_WEIGHTS (a name hit outweighs a description
 *  hit) so the two rankers agree about what "matches" means, and each field
 *  is tokenized and normalized exactly as rankServers indexes it -- the
 *  identifier floor for tool names, the prose floor for descriptions -- so a
 *  term that survives for one ranker survives for the other. With no IDF here,
 *  function words are dropped from the query (QUERY_FUNCTION_WORDS). */
export function rankTools(query: string, servers: RankableServer[]): RankedTool[] {
  if (tokenizeQuery(query).length === 0 || servers.length === 0) return [];
  const index = indexFor(servers);
  const termList = queryTermsFor(query, index, QUERY_FUNCTION_WORDS);
  const queryTerms = new Set(termList);
  if (queryTerms.size === 0) return [];
  // What rankServers scores each server for this same query: the first
  // tie-break below, so find_tool and dispatch agree on whose tool wins a tie.
  const serverScore = new Map(scoreAgainstIndex(termList, index).map((r) => [r.namespace, r.score]));

  interface Scored extends RankedTool {
    serverScore: number;
    nameHits: number;
    nameMisses: number;
    serverTools: number;
  }
  const out: Scored[] = [];
  servers.forEach((server, i) => {
    const doc = index.docs[i];
    const namedNamespace = queryNamesNamespace(queryTerms, doc.namespaceTerms);
    server.tools.forEach((tool, j) => {
      const terms = doc.tools[j];
      let score = 0;
      let nameHits = 0;
      for (const term of queryTerms) {
        if (terms.name.has(term)) {
          score += FIELD_WEIGHTS.toolName;
          nameHits++;
        } else if (terms.desc.has(term)) score += FIELD_WEIGHTS.toolDescription;
      }
      if (score === 0) return;
      // A namespace hit is worth something but must not carry a tool on its
      // own: "github" should surface github's tools BELOW a tool actually
      // named for what was asked, on any server.
      if (namedNamespace) score += 0.5;
      const nameMisses = terms.nameList.filter((t) => !queryTerms.has(t)).length;
      out.push({
        namespace: server.namespace,
        name: tool.name,
        description: tool.description,
        score,
        serverScore: serverScore.get(server.namespace) ?? 0,
        nameHits,
        nameMisses,
        serverTools: server.tools.length,
      });
    });
  });
  // Equal scores are common (the score is a small sum of field weights), so
  // the tie-break carries real signal rather than the alphabet: first the tool
  // on the server rankServers scores higher for this query (BM25 over the
  // whole server, with IDF -- the one signal here that knows "redis" is rarer
  // than "list"), then the tool whose NAME the query hit more often (two name
  // hits beat one name hit plus two description hits at the same total), then
  // the tool whose name the query covers most completely (`npm_downloads`
  // over `npm_downloads_bulk` for "downloads"), then the tool on the smaller
  // server, whose tools are each more specific than one of a 70-tool
  // catch-all's. Namespace and name last, so the order is stable across calls
  // -- an unstable list reads as churn to a model comparing two responses.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.serverScore - a.serverScore ||
      b.nameHits - a.nameHits ||
      a.nameMisses - b.nameMisses ||
      a.serverTools - b.serverTools ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name),
  );
  return out.map(({ namespace, name, description, score }) => ({ namespace, name, description, score }));
}

// Rank a list of servers against a free-text query. Returns results sorted
// descending by score, only including entries with score > 0 (matches at
// least one query term in some field). Zero-score servers are omitted so
// the caller can cleanly tell "no match" from "weak match".
export function rankServers(context: string, servers: RankableServer[]): RankedResult[] {
  // Identifier floor on the query, not the prose floor: "use pg" has to
  // survive tokenization or the short-namespace fix on the document side is
  // unreachable. Minus closed-class function words -- SUB_FLOOR_STOPWORDS
  // (why the identifier floor alone was not safe on the query side) and
  // QUERY_FUNCTION_WORDS (the 3+ char ones the prose floor admits).
  if (tokenizeQuery(context).length === 0 || servers.length === 0) return [];
  const index = indexFor(servers);
  return scoreAgainstIndex(queryTermsFor(context, index, QUERY_FUNCTION_WORDS), index);
}

/** How much of a query one server explains. */
export interface QueryCoverage {
  namespace: string;
  /** IDF-weighted share of the query's content terms this server matches in
   *  any field: sum(idf of matched terms) / sum(idf of all content terms),
   *  in [0, 1]. 0 when the query has no content terms. */
  coverage: number;
  /** Distinct content terms matched. */
  matched: number;
  /** Distinct content terms in the query. */
  contentTerms: number;
}

/** Query coverage per server, over the same normalized terms and cached index
 *  rankServers uses. rankServers' score is an absolute BM25 sum: it grows with
 *  how rare the matched terms are, not with how much of the request a server
 *  explains, so "how does Redis LRU eviction differ from LFU" scores a redis
 *  server highly on the one word "redis" while lru / eviction / lfu match
 *  nothing anywhere. Coverage asks the relative question.
 *
 *  Content terms are the query's normalized terms minus QUERY_FUNCTION_WORDS,
 *  pure numbers and 1-character tokens (arguments and variable names, not
 *  routing intent). A term no server contains gets the highest IDF the
 *  index's formula can give (document frequency 0): an unmatched word nobody
 *  can serve is exactly the evidence that the request is not a tool request.
 *  Returned in corpus order, one entry per server. */
export function queryCoverage(query: string, servers: RankableServer[]): QueryCoverage[] {
  if (servers.length === 0) return [];
  const index = indexFor(servers);
  const terms = [
    ...new Set(queryTermsFor(query, index, QUERY_FUNCTION_WORDS).filter((t) => t.length >= 2 && !/^[0-9]+$/.test(t))),
  ];
  const N = index.docs.length;
  const unseenIdf = Math.log((N + 0.5) / 0.5 + 1);
  const idfOf = (t: string) => index.idf.get(t) ?? unseenIdf;
  const total = terms.reduce((sum, t) => sum + idfOf(t), 0);
  return index.docs.map(({ namespace, fields }) => {
    let mass = 0;
    let matched = 0;
    for (const t of terms) {
      if ((Object.keys(FIELD_WEIGHTS) as FieldName[]).some((f) => fields[f].counts.has(t))) {
        mass += idfOf(t);
        matched++;
      }
    }
    return { namespace, coverage: total > 0 ? mass / total : 0, matched, contentTerms: terms.length };
  });
}
