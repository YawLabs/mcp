// Foundry: privacy-safe local harvest of dispatch traces for a future
// routing-eval corpus.
//
// The goal is to let a user OPT IN to collecting a corpus of "intent ->
// candidate namespaces -> chosen namespace" decisions that a future eval
// could replay to measure routing quality -- WITHOUT ever persisting the
// raw English intent the user typed. Two layers keep it privacy-safe:
//
//   1. Path-splitting in `tokenize` (src/relevance.ts) already shreds most
//      structure: it lowercases and splits on every non-alphanumeric run,
//      so emails, URLs, file paths, `key=value` pairs, and dotted hosts are
//      blown apart into bare alphanumeric tokens before we ever see them.
//      `user@host.com/secret` becomes ["user", "host", "com", "secret"].
//      That is the FIRST line of defense -- structure is gone.
//
//   2. `redactIntent` is the SECOND line of defense: it drops the tokens
//      that survive splitting but still look sensitive -- long high-entropy
//      blobs, known secret prefixes, hex digests, long pure-alpha runs, and
//      mixed letter+digit runs (an API key with no punctuation inside it).
//      The surviving tokens are then SORTED, so word order is destroyed and
//      the original sentence cannot be reconstructed from the bag.
//
// Privacy scope (READ BEFORE ENABLING): this protects against persisting the
// raw intent string, its delimiters/structure, secret-shaped tokens, and
// word order. It does NOT strip ordinary words that happen to be sensitive --
// personal names, company names, or ticket text are "ordinary words" to the
// redactor and survive (un-ordered) in the bag. Do not enable YAW_MCP_FOUNDRY
// on intents that routinely carry such PII.
//
// Default is privacy-safe: harvesting is DISABLED unless YAW_MCP_FOUNDRY is
// explicitly "1" / "true". When enabled, only the redacted+sorted token bag,
// the candidate namespaces + scores, and the chosen namespace are written --
// never the raw intent string.

import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { userConfigDir } from "./paths.js";
import { tokenize } from "./relevance.js";

export interface RedactedIntent {
  tokens: string[];
  redactedCount: number;
}

// Known secret/token prefixes. A token is dropped outright if it starts with
// any of these. All prefixes are stored lowercase because tokenize has
// already lowercased every token before it reaches us (so "akia" here matches
// an "AKIA..." AWS access-key-id that arrived as "akia...").
const SECRET_PREFIXES = ["sk_", "sk-", "tok_", "ghp_", "gho_", "xox", "pk_", "akia"];

// A token "looks like a secret/PII" when any of these hold. tokenize has
// already lowercased and stripped non-alphanumerics, so by the time we see
// a token it is a single [a-z0-9]+ run (>= 3 chars). The checks therefore
// target what survives: long high-entropy blobs and prefixed/hex tokens.
function looksSensitive(token: string): boolean {
  // Known secret prefixes (case-insensitive; token is already lowercased).
  for (const prefix of SECRET_PREFIXES) {
    if (token.startsWith(prefix)) return true;
  }

  // Pure-hex of length >= 16 (git SHAs, hashed ids, hex-encoded keys).
  if (token.length >= 16 && /^[0-9a-f]+$/.test(token)) return true;

  // Mixed letters+digits, length >= 12. A 12+ char run that interleaves
  // [a-z] and [0-9] is almost never an English word; it is overwhelmingly an
  // id, token, or key fragment. (Lowered from 20 so 12-19 char keys don't
  // slip through.)
  if (token.length >= 12 && /[a-z]/.test(token) && /[0-9]/.test(token)) return true;

  // Long pure-alpha run, length >= 16. A single [a-z] run this long is far
  // more likely a passphrase / base32-style secret than an English word, so
  // we over-redact here rather than risk persisting a cleartext secret.
  if (token.length >= 16 && /^[a-z]+$/.test(token)) return true;

  return false;
}

// Tokenize an intent (via relevance `tokenize`) THEN drop any surviving
// token that looks like a secret/PII. Returns the kept tokens plus the
// number dropped. Note on "email / IPv4 / @" rules from the spec: tokenize
// splits on `@` and `.`, so an email or IPv4 never reaches here as a single
// token -- its alphanumeric pieces ("user", "gmail", "com", "192", "168")
// pass through as ordinary tokens, which is acceptable since the
// identifying structure (the @ and dots) is already destroyed. We document
// this rather than re-detect a structure tokenize has already removed.
// Structured PII patterns we strip from the RAW intent BEFORE tokenize()
// shreds it into bare alphanumeric runs. Tokenize splits on every
// non-alphanumeric, which loses the structure that makes these
// recognizable -- so we have to scrub here, not in the token loop.
// Each pattern's matched substrings are replaced with " " (so a token
// boundary is preserved) and counted toward redactedCount.
//   - email: user@host.tld
//   - phone-shape: 9+ digits with optional +/separators
//   - GitHub-style refs: #1234
//   - bracketed IDs: PROJ-1234, ABC-9 (Jira-style ticket refs)
// Each pattern is wrapped with `(?<![A-Za-z0-9])...(?![A-Za-z0-9])` so it only
// matches when bounded by non-alphanumerics (start/end of string, whitespace,
// punctuation). Without these, the phone-shape pattern matches a digit run
// INSIDE a longer alphanumeric token (e.g. the "0123456789" tail of
// "xoxbabcdef0123456789"), double-counting against the prefix-token rule.
const RAW_PII_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])\+?[0-9][0-9\s().-]{8,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])#\d+(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])[A-Z]+-\d+(?![A-Za-z0-9])/g,
];

export function redactIntent(intent: string): RedactedIntent {
  let redactedCount = 0;
  // First pass: strip structured PII from the raw string. Replace each
  // match with a single space to preserve token boundaries. APPEND to the
  // existing token-level redaction below -- this layer catches patterns
  // tokenize() would destroy before looksSensitive could see them.
  let scrubbed = intent;
  for (const re of RAW_PII_PATTERNS) {
    scrubbed = scrubbed.replace(re, () => {
      redactedCount++;
      return " ";
    });
  }

  const all = tokenize(scrubbed);
  const tokens: string[] = [];
  for (const token of all) {
    if (looksSensitive(token)) {
      redactedCount++;
    } else {
      tokens.push(token);
    }
  }
  // Sort the surviving tokens so word ORDER is destroyed -- a bag of words
  // can't reconstruct the original sentence. BM25-style eval is bag-of-words
  // anyway, so ordering carries no signal we lose.
  tokens.sort();
  return { tokens, redactedCount };
}

export interface FoundryTrace {
  tokens: string[];
  candidates: Array<{ ns: string; score: number }>;
  chosen: string;
  redactedCount: number;
}

// Opt-in ONLY. True when YAW_MCP_FOUNDRY is exactly "1" or "true"
// (case-insensitive, whitespace-trimmed). Anything else -- unset, "0",
// "false", "yes", garbage -- is treated as disabled. Privacy-safe default.
export function isFoundryEnabled(): boolean {
  const raw = process.env.YAW_MCP_FOUNDRY;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

// Hard cap on the harvest file size. Once foundry.jsonl exceeds this, we
// stop appending so an npm-published CLI can never fill a user's disk.
// 5 MiB of single-line JSON traces is on the order of 10k-30k entries --
// far more than any eval corpus needs -- and the cap is checked cheaply via
// a single stat() before each append. We DROP new traces rather than
// rotate/truncate: rotation adds I/O and complexity for telemetry that must
// stay best-effort and never throw, and an eval corpus only needs a bounded
// sample, not the most-recent window. Bounded-by-drop is the simple choice.
const MAX_FOUNDRY_BYTES = 5 * 1024 * 1024;

export const FOUNDRY_FILENAME = "foundry.jsonl";

// Append one trace as a JSON line to ~/.yaw-mcp/foundry.jsonl.
//
// Best-effort by contract: this is telemetry and MUST NEVER throw or reject
// in a way that breaks a dispatch. Every failure path (disabled, oversized
// file, mkdir/stat/append error) resolves quietly. No-op when disabled.
//
// `home` is overridable so tests (and any future relocation) can isolate
// the harvest dir without touching the real home -- mirrors
// userConfigDir(home) in paths.ts.
export async function appendFoundryTrace(trace: FoundryTrace, home: string = homedir()): Promise<void> {
  try {
    if (!isFoundryEnabled()) return;

    const dir = userConfigDir(home);
    const file = path.join(dir, FOUNDRY_FILENAME);

    // Enforce the size cap BEFORE writing. If the file is already at/over
    // the cap, drop this trace silently. A missing file (ENOENT) means
    // size 0 -- proceed to create it.
    try {
      const info = await stat(file);
      if (info.size >= MAX_FOUNDRY_BYTES) return;
    } catch {
      // ENOENT (first write) or any stat error -> treat as "not over cap"
      // and let the append attempt proceed / fail quietly below.
    }

    // Persist ONLY the redacted bag + routing decision -- never raw intent.
    // Strip per-candidate score fields before write: scores reflect the
    // ranker's live health/learning state at decision time, which biases an
    // eval replay against the SAME ranker state instead of measuring it.
    const candidatesNoScores = trace.candidates.map((c) => ({ ns: c.ns }));
    const line = `${JSON.stringify({
      tokens: trace.tokens,
      candidates: candidatesNoScores,
      chosen: trace.chosen,
      redactedCount: trace.redactedCount,
    })}\n`;

    await mkdir(dir, { recursive: true });
    await appendFile(file, line, "utf8");
  } catch {
    // Swallow everything. Telemetry must never break a dispatch.
  }
}
