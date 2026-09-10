// Conservative response pruning for MCP tool-call results.
//
// Goal: strip obviously-dead weight from upstream responses before they
// reach the LLM, so large tool outputs cost fewer tokens without
// changing meaning. We measure bytes before and after so callers can
// tell whether pruning actually paid for itself.
//
// The rules are intentionally narrow — pruning is on by default, so
// anything that risks changing semantics is left alone:
//
//   * Drop keys whose values are null / undefined / [] / {}. These
//     almost always mean "no value" for an LLM consumer; keeping them
//     costs tokens without informing the model.
//   * KEEP false, 0, empty strings — those can be load-bearing
//     ("error": "" meaning success, "deleted": false, etc.).
//   * Text-mode: strip trailing whitespace per line and collapse runs
//     of 3+ blank lines into 2 -- but only after CLASSIFYING THE BLOCK.
//     Trailing whitespace and blank runs are formatting in prose and
//     CONTENT in a unified diff, inside a fenced code block, and at a
//     Markdown hard line break, and none of the three can be recognized
//     from one line in isolation. See the block-classification note above
//     pruneWhitespace for the three rules and for what is deliberately
//     still NOT preserved.
//   * JSON mode is SKIPPED entirely when re-serializing would change a
//     number. Pruning round-trips through JSON.parse + JSON.stringify, so
//     an int64 id like 12345678901234567890 (ordinary in SQL and REST MCP
//     servers) would reach the model as 12345678901234567000. Losing a
//     couple of percent of savings beats handing the model a wrong id.
//   * If pruning doesn't save at least MIN_SAVINGS_RATIO of the total
//     serialized bytes across the entire content array, we return the
//     original untouched — the re-serialization cost isn't worth a
//     marginal win. The ratio is measured over the whole array
//     (JSON.stringify(content)), not per individual content item.
//
// Opt-out: set YAW_MCP_PRUNE_RESPONSES=0 to disable entirely and keep
// the original bytes. In that mode responseBytesPruned == responseBytesRaw.
//
// NOT a security control. Nothing here inspects, redacts or truncates a
// VALUE -- a large file blob, a base64 payload, an instruction-shaped string
// all reach the model byte-for-byte (a whitespace collapse in text mode is
// the only edit to content). Token savings is the whole job; any prompt-
// injection or blob-redaction claim about "response pruning" describes a
// feature this module does not have.

import { setJsonKey } from "./json-key.js";

const MIN_SAVINGS_RATIO = 0.02;

export interface Content {
  type: string;
  text: string;
  [k: string]: unknown;
}

export interface PruneResult {
  content: Content[];
  bytesRaw: number;
  bytesPruned: number;
}

export function isPruneEnabled(): boolean {
  const raw = process.env.YAW_MCP_PRUNE_RESPONSES;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function pruneContent(content: Content[]): PruneResult {
  const bytesRaw = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (!isPruneEnabled()) {
    return { content, bytesRaw, bytesPruned: bytesRaw };
  }

  const pruned: Content[] = content.map((item) => {
    if (item.type !== "text" || typeof item.text !== "string") return item;
    const text = pruneText(item.text);
    return text === item.text ? item : { ...item, text };
  });

  const bytesPruned = Buffer.byteLength(JSON.stringify(pruned), "utf8");

  if (bytesPruned > bytesRaw * (1 - MIN_SAVINGS_RATIO)) {
    return { content, bytesRaw, bytesPruned: bytesRaw };
  }
  return { content: pruned, bytesRaw, bytesPruned };
}

function pruneText(text: string): string {
  // Guard: don't try to parse multi-megabyte blobs as JSON — even a
  // failed parse chews CPU. We still apply text-mode cleanup below.
  const trimmed = text.trimStart();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && text.length < 2_000_000) {
    try {
      const parsed = JSON.parse(text);
      // Only re-serialize when every number survives the round-trip. A
      // response carrying one oversized id keeps its original bytes rather
      // than reaching the model with that id silently rewritten.
      if (jsonNumbersAreFaithful(text)) {
        const cleaned = pruneJson(parsed);
        if (cleaned !== undefined) return JSON.stringify(cleaned);
      }
    } catch {
      // Not JSON — fall through to text-mode cleanup.
    }
  }
  return pruneWhitespace(text);
}

// --- number fidelity --------------------------------------------------
//
// JSON numbers are IEEE-754 doubles once parsed, so JSON.parse +
// JSON.stringify is not a round-trip for every literal a server can send:
//
//   12345678901234567890  ->  12345678901234567000   (int64 row id)
//   9007199254740993      ->  9007199254740992       (2^53 + 1)
//   1e400                 ->  null                   (overflow to Infinity)
//   1e-400                ->  0                      (underflow)
//
// Pruning is on by default and these shapes are ordinary in SQL / REST MCP
// servers, so the module's "anything that risks changing semantics is left
// alone" contract has to cover them too. When any literal is unfaithful we
// skip JSON mode for the whole document and fall back to whitespace-only
// cleanup, which cannot alter a value.
//
// Both shapes get an EXACT test, so a 16-digit id a double holds precisely
// still prunes: integers compare the re-serialized text byte for byte,
// fractional / exponent forms compare canonical (sign, digits, exponent)
// triples so a pure reformat passes and a changed value does not.

/** A JSON string literal (escapes included) OR a JSON number literal, in one
 *  alternation with the STRING form first. Order is what makes it safe: digits
 *  inside a string are consumed as part of that string match, so they can
 *  never be read as a number. Neither branch can match empty, so the exec loop
 *  below always advances. */
const JSON_STRING_OR_NUMBER_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Does every number in `text` survive JSON.parse + JSON.stringify with its
 *  value intact? Callers only ask after JSON.parse succeeded, so every literal
 *  outside a string really is a number.
 *
 *  One pass, and it does not copy the document. The previous shape blanked
 *  every string with a full-text `replace` -- an extra whole copy of the
 *  response -- and then swept that copy with `matchAll`, which measured
 *  11-15 ms on a 2 MB row array next to 5 ms for the JSON.parse it sits
 *  beside, on the synchronous proxy path. Alternating the two literal forms in
 *  a single regex drops the copy (measured 13.4 ms -> 7.4 ms on that same
 *  array) and lets an unfaithful literal return immediately instead of only
 *  after the copy has been built -- so the common case of an int64 id in the
 *  first row now costs almost nothing.
 *
 *  No cheap pre-filter guards this, deliberately: a digit-run bail
 *  (`/\d[\d.]{15}|.../.test(text)`) measures 7.6 ms on the same 2 MB input --
 *  as much as this entire scan -- because it is itself a full-text regex pass.
 *  The cost here was never the matching, it was the copy, so a pre-filter
 *  would only make the common case slower. */
function jsonNumbersAreFaithful(text: string): boolean {
  // Module-level /g regex: a bail below leaves lastIndex mid-document, so
  // reset before iterating rather than trusting the previous call to have run
  // to completion.
  JSON_STRING_OR_NUMBER_RE.lastIndex = 0;
  let match = JSON_STRING_OR_NUMBER_RE.exec(text);
  while (match !== null) {
    const literal = match[0];
    // A string literal, not a number — nothing to check.
    if (!literal.startsWith('"') && !numberLiteralIsFaithful(literal)) return false;
    match = JSON_STRING_OR_NUMBER_RE.exec(text);
  }
  return true;
}

function numberLiteralIsFaithful(literal: string): boolean {
  const n = Number(literal);
  // 1e400 parses to Infinity, which JSON.stringify emits as `null`.
  if (!Number.isFinite(n)) return false;
  // Plain integers are the shape that actually breaks, so they get an EXACT
  // test: the re-serialized text must be the literal, byte for byte. That
  // keeps every id a double holds precisely (9007199254740991 is 16 digits
  // and fine), rejects the ones it does not (12345678901234567890, 2^53+1),
  // and also rejects the ones that merely reshape (1000000000000000000000
  // comes back as 1e+21 -- same value, but not an id the user can grep for).
  if (/^-?\d+$/.test(literal)) return String(n) === literal;
  // Fractional / exponent forms: the double IS the value every JSON parser
  // sees, and JSON.stringify emits the shortest text that round-trips to
  // that same double, so re-serializing is allowed to REFORMAT (1.0 -> 1,
  // 19.90 -> 19.9, 0.0000001 -> 1e-7) but never to change the value.
  const mantissa = literal.replace(/^-/, "").split(/[eE]/)[0];
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  // 1e-400 underflows to 0 -- the digits are gone, not merely rounded.
  if (n === 0) return !/[1-9]/.test(digits);
  // Comparing the two spellings in canonical form IS the reformat-or-not
  // test: it accepts every reshaping above and rejects a literal carrying
  // more precision than a double holds (0.12345678901234567 comes back
  // ...66, 0.1000000000000000000001 collapses to 0.1). A digit-count bound
  // cannot do both -- 15 (the decimal->double->decimal guarantee) rejects
  // ordinary computed doubles like 0.30000000000000004, and one rejected
  // literal costs the WHOLE document its pruning; 17 (the double->decimal
  // direction) accepts 16-17 digit literals a double does not hold.
  const canonical = canonicalDecimal(literal);
  return canonical !== null && canonical === canonicalDecimal(String(n));
}

/** A decimal number's value as a `(sign, significant digits, exponent)`
 *  triple, in which two spellings of the SAME value compare equal: `19.90`,
 *  `19.9` and `1.990e1` all canonicalize to `199e-1`, while
 *  `9007199254740993.0` and the `9007199254740992` a double re-serializes to
 *  do not. Returns null for a shape it cannot parse, which the caller treats
 *  as unfaithful. */
function canonicalDecimal(s: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (m === null) return null;
  const [, sign, intPart, fracPart = "", expPart = ""] = m;
  // value === digits * 10^pow, with the digit string read as an integer:
  // every fraction digit shifts the point right by one, the exponent shifts
  // it back (Number("") is 0, which is the no-exponent case). Leading zeros
  // do not change an integer's value, so dropping them leaves pow alone;
  // each dropped TRAILING zero divides the digits by ten, so pow gains one
  // back.
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const pow = Number(expPart) - fracPart.length + (digits.length - significant.length);
  return `${sign === "-" ? "-" : ""}${significant}e${pow}`;
}

// --- block classification ---------------------------------------------
//
// A per-line decision cannot answer a block-level question, and both text
// rules ask one. Trailing whitespace and blank-line runs are formatting in
// prose and CONTENT in three shapes upstream servers return constantly:
//
//   * A UNIFIED DIFF. The context line for an empty source line is a lone
//     " ", so stripping it leaves a hunk git refuses to apply; a `+`/`-`
//     line carries the file's own trailing bytes verbatim; and the
//     `@@ -a,b +c,d @@` header COUNTS the lines that follow it, so
//     collapsing a blank run inside a hunk invalidates the count. Nothing
//     about that is visible from the line being stripped -- the hunk header
//     several lines up is what gives it its meaning. So a patch is
//     ALL-OR-NOTHING: the whole text comes back byte-faithful, exactly the
//     way JSON mode bails on the whole document when one number would not
//     survive the round-trip.
//   * A FENCED CODE BLOCK. Everything between the fences is literal, and a
//     fence is precisely where an embedded diff, Markdown sample or
//     whitespace-significant payload lives when it is quoted inside prose.
//     A blank-run collapse in there deletes lines from the code the model is
//     being shown and shifts every line number after it, so both rules are
//     off between the fences. Whether a line is inside one is only knowable
//     by scanning from the top of the document.
//   * A MARKDOWN HARD LINE BREAK -- two or more trailing spaces on a line
//     that another line follows. Stripping it joins the two lines when the
//     text is rendered.
//
// NOT preserved, stated rather than implied, because the module's contract
// has to match what the code does:
//
//   * A hard break in text carrying NO Markdown structural signal (no ATX
//     heading, no fence). "line one   " followed by "line two" is a hard
//     break in a README and trailing junk in a log, and the two are not
//     distinguishable from the text -- so the signal gates it. Guessing
//     "everything with two trailing spaces is Markdown" would disable the
//     module's primary text rule for ordinary CLI output and logs, which is
//     most of what flows through here; guessing the other way is what
//     corrupts a README. A false POSITIVE on the gate costs savings only.
//   * Trailing TABS, and a SINGLE trailing space. Neither is a CommonMark
//     hard break, so both still prune everywhere.

/** Per line: is it inside a fenced code block (fence lines included)?
 *
 *  CommonMark shape: up to three leading spaces, then three or more
 *  backticks or tildes; the closer uses the same character, is at least as
 *  long, and carries nothing but whitespace after it. An opening backtick
 *  fence's info string may not itself contain a backtick.
 *
 *  An UNCLOSED opener fences the rest of the document. That is the safe
 *  direction: it costs savings, never content. */
function classifyFencedLines(lines: string[]): boolean[] {
  const fenced: boolean[] = new Array(lines.length).fill(false);
  let openChar: string | null = null;
  let openLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (openChar === null) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        openChar = m[1][0];
        openLength = m[1].length;
        fenced[i] = true;
      }
      continue;
    }
    fenced[i] = true;
    if (m && m[1][0] === openChar && m[1].length >= openLength && m[2].trim() === "") {
      openChar = null;
      openLength = 0;
    }
  }
  return fenced;
}

/** Is this text a unified diff?
 *
 *  The hunk header is the signal: every patch carrying content has one, and
 *  `@@ -1,4 +1,4 @@` is not a shape prose takes, so this classifies without
 *  the fuzzy "does it look like a diff" guessing the module avoids
 *  everywhere else. `diff --git` is accepted too, so a content-free patch (a
 *  pure rename or mode change) is recognized as well.
 *
 *  FENCED lines are skipped deliberately: a diff quoted inside a Markdown
 *  code fence is already protected by the fence rule, and treating it as a
 *  patch would cost the surrounding prose its pruning for no gain. */
function looksLikePatch(lines: string[], fenced: boolean[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    if (lines[i].startsWith("diff --git ")) return true;
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[i])) return true;
  }
  return false;
}

/** Does this text carry a Markdown structural signal -- an ATX heading or a
 *  fence? That is what makes a two-trailing-space line a hard break rather
 *  than trailing junk; see the NOT-preserved note above for why the gate is
 *  here at all. */
function looksLikeMarkdown(lines: string[], fenced: boolean[]): boolean {
  return fenced.some(Boolean) || lines.some((line) => /^ {0,3}#{1,6}(?:\s|\r?$)/.test(line));
}

/** A Markdown hard line break: two or more trailing SPACES on a non-blank
 *  line that a non-blank line follows. The lookahead is the block context --
 *  trailing spaces before a BLANK line are insignificant even in Markdown,
 *  so those still prune. */
function isHardLineBreak(line: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (!/ {2}\r?$/.test(line)) return false;
  if (line.trim() === "") return false;
  return next.trim() !== "";
}

// CRLF-aware on purpose: a Windows-hosted MCP server that shells out (git,
// filesystem, any CLI wrapper) returns \r\n line endings, and an LF-only
// version of these rules was a silent no-op there — the trailing-space
// regex never matched before a \r, and the blank-run collapse never saw
// three consecutive \n. The \r itself is preserved (content stays
// byte-faithful); only the collapsed blank run is rewritten, in the style
// the run itself used.
function pruneWhitespace(text: string): string {
  const lines = text.split("\n");
  const fenced = classifyFencedLines(lines);
  // Classify BEFORE any per-line edit -- a patch comes back untouched.
  if (looksLikePatch(lines, fenced)) return text;
  const markdown = looksLikeMarkdown(lines, fenced);

  const stripped = lines.map((line, i) => {
    if (fenced[i]) return line;
    if (markdown && isHardLineBreak(line, lines[i + 1])) return line;
    return line.replace(/[ \t]+(?=\r?$)/, "");
  });

  // Collapse per contiguous NON-fenced run of lines rather than over the
  // whole document: a run inside a fence is left alone, and no run is
  // collapsed across a fence boundary. With no fence at all this is one
  // chunk covering the whole text, i.e. the original single regex pass.
  const parts: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    const inFence = fenced[i];
    let j = i;
    while (j < stripped.length && fenced[j] === inFence) j++;
    const chunk = stripped.slice(i, j).join("\n");
    parts.push(inFence ? chunk : collapseBlankRuns(chunk));
    i = j;
  }
  return parts.join("\n");
}

function collapseBlankRuns(chunk: string): string {
  return chunk.replace(/(?:\r?\n){3,}/g, (run) => (run.includes("\r") ? "\r\n\r\n" : "\n\n"));
}

// Walk a parsed JSON tree, dropping keys/elements whose value is
// "no information" (null, undefined, empty collection after recursion).
// `undefined` returned from this function means "caller should drop me".
function pruneJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    // Never drop array elements — dropping shifts indices and breaks any
    // caller that relies on positional access (e.g. list data returned to
    // the model). Pruned elements stay in place: an OBJECT that prunes to
    // empty is preserved as `{}` so the row/object SHAPE survives (a list of
    // rows stays a list of objects, not a list of nulls); anything else that
    // prunes away (null/undefined/empty primitive collection) becomes null.
    const cleaned: unknown[] = value.map((el) => {
      const pv = pruneJson(el);
      if (pv !== undefined) return pv;
      // el pruned to "no information": keep {} for objects to preserve shape.
      if (el !== null && typeof el === "object" && !Array.isArray(el)) return {};
      return null;
    });
    return cleaned;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneJson(v);
      if (pv !== undefined) {
        // setJsonKey, not out[k]: `k` came out of an upstream server's JSON,
        // and plain assignment to "__proto__" hits Object.prototype's
        // inherited setter instead of creating an own key -- the field
        // would vanish from the pruned result the server actually returned.
        // Shared with persistence/grades-cache/trust so the one key that
        // needs this cannot be handled four subtly different ways.
        setJsonKey(out, k, pv);
        kept++;
      }
    }
    return kept === 0 ? undefined : out;
  }

  return value;
}
