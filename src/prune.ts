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
//     of 3+ blank lines into 2. No content is removed, just formatting.
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
// Integers -- the shape that actually breaks -- get an exact test, so a
// 16-digit id a double holds precisely still prunes. Fractional forms get a
// conservative digit bound instead.

/** Significant mantissa digits a double round-trips (a double's shortest
 *  representation never needs more than 17). */
const MAX_FAITHFUL_MANTISSA_DIGITS = 17;

/** A JSON string literal, escapes included. Blanked before scanning for
 *  numbers so digits INSIDE a string can't trigger a false bail. */
const JSON_STRING_RE = /"(?:[^"\\]|\\.)*"/g;

/** A JSON number literal. Only ever run over string-blanked text. */
const JSON_NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Does every number in `text` survive JSON.parse + JSON.stringify with its
 *  value intact? Callers only ask after JSON.parse succeeded, so blanking
 *  string literals is enough to make every remaining digit run a number. */
function jsonNumbersAreFaithful(text: string): boolean {
  const outsideStrings = text.replace(JSON_STRING_RE, '""');
  for (const m of outsideStrings.matchAll(JSON_NUMBER_RE)) {
    if (!numberLiteralIsFaithful(m[0])) return false;
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
  // that same double, so re-serializing only reformats (1.0 -> 1, 19.90 ->
  // 19.9). What can still lose information is underflow to zero, and a
  // mantissa carrying more precision than a double holds
  // (0.1000000000000000000001 collapses to 0.1) -- guard those two.
  const mantissa = literal.replace(/^-/, "").split(/[eE]/)[0];
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  // 1e-400 underflows to 0 -- the digits are gone, not merely rounded.
  if (n === 0) return !/[1-9]/.test(digits);
  return digits.replace(/0+$/, "").length <= MAX_FAITHFUL_MANTISSA_DIGITS;
}

function pruneWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
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
        // See resolveArgs in exec-engine.ts: plain assignment to
        // "__proto__" hits the inherited setter instead of creating an own
        // key, so the field would be dropped from the pruned result an
        // upstream server actually returned. defineProperty keeps it a
        // plain data property.
        if (k === "__proto__") {
          Object.defineProperty(out, k, { value: pv, writable: true, enumerable: true, configurable: true });
        } else {
          out[k] = pv;
        }
        kept++;
      }
    }
    return kept === 0 ? undefined : out;
  }

  return value;
}
