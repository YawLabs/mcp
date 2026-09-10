// A hard ceiling on the size of ONE proxied tool result.
//
// Distinct from prune.ts, which is a token-savings pass: pruning drops dead
// weight (nulls, empty collections, runs of blank lines) and explicitly gives
// up when the saving is marginal, so it bounds nothing. A tool that returns a
// 40MB log, a base64 blob, or an unfiltered table walks through it untouched
// and lands whole in the model's context.
//
// That is the failure this broker exists to prevent, arriving by the one door
// it never watched. Every other surface is budgeted -- the server cap bounds
// how many tool lists are loaded, the token ceiling bounds how big they are,
// the idle reaper unloads what stopped being used -- and then a single
// `read_file` on a big file undoes all of it in one reply.
//
// Two rules make the cap safe to have on by default:
//
//   1. It is LOUD. A capped result carries a final text block naming exactly
//      what was dropped and what to do instead. Silent truncation is worse
//      than no cap: the model reads a cut-off log as a complete one and
//      reasons confidently from a partial answer.
//   2. It never edits a value it cannot cut honestly. `structuredContent` is
//      passed through verbatim by the proxy and is NOT capped here, so a
//      structured-output tool can still return an unbounded payload. That is
//      the same carve-out pruneContent makes one step earlier in server.ts,
//      and for the same reason: per MCP 2025-06-18 the structured value and
//      the text block are two representations of ONE result, so editing only
//      the side we can measure would leave them disagreeing -- a worse answer
//      for a reader than the bytes either edit would have saved. Stated here
//      rather than cross-referenced; an earlier version of this line pointed
//      at "the note on capResult", which does not exist.

/** One MCP content block. Structurally identical to prune.ts's `Content`,
 *  redeclared rather than imported so this module carries no dependency on
 *  the pruning pass it deliberately is not part of. */
export interface CapContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** ~25k tokens at the 4-bytes-per-token rule of thumb cost-estimate.ts uses.
 *
 *  Chosen to sit far above a normal tool result and far below a context
 *  blowout: an ordinary API response, a directory listing, a query returning
 *  a screenful of rows are all one to two orders of magnitude under it, while
 *  the results that actually break a session -- a whole log file, an
 *  unfiltered table dump, a base64 payload -- are over it. A ceiling tight
 *  enough to trip on ordinary work would train the caller to disable it. */
export const DEFAULT_MAX_RESULT_BYTES = 100_000;

/** 0 disables the cap. Invalid values fall back to the default rather than
 *  erroring -- the same strict digit-run parse, and the same reasoning, as
 *  resolveServerCap: parseInt's prefix parsing turns "0x1000" and "100_000"
 *  into 0, which is the DISABLE sentinel, so a typo would silently remove the
 *  ceiling instead of falling back to it. */
export function resolveMaxResultBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.YAW_MCP_MAX_RESULT_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_RESULT_BYTES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_RESULT_BYTES;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESULT_BYTES;
  return n;
}

export interface CapResult {
  content: CapContent[];
  /** True when anything was dropped. The caller logs on this rather than
   *  comparing byte counts, so a no-op cap stays silent. */
  capped: boolean;
  bytesRaw: number;
  bytesKept: number;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 *  Buffer.subarray cuts on a BYTE boundary, so a naive slice can end
 *  mid-sequence and decode to a replacement char -- and if the tail happens
 *  to be the lead byte of a surrogate pair, the model reads a corrupted final
 *  token. Decoding the cut and stripping a trailing replacement char is the
 *  cheap way to land on a character boundary without hand-decoding UTF-8. */
function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const cut = buf.subarray(0, maxBytes).toString("utf8");
  // Only a cut that actually severed a sequence ends in U+FFFD, and the
  // source could legitimately contain one -- but it cannot have gained one
  // at the very end that the full text does not have there.
  return cut.endsWith("�") && !text.startsWith(cut) ? cut.slice(0, -1) : cut;
}

/** The largest prefix of `item.text` whose ASSEMBLED, SERIALIZED block fits
 *  `budget` bytes -- or null when even one character does not fit.
 *
 *  Cutting to raw UTF-8 bytes is not enough, and the gap is not small. Every
 *  other measurement in this module is JSON-serialized, and JSON escaping is
 *  MULTIPLICATIVE: a quote or a newline costs 1 raw byte and 2 serialized, and
 *  a control byte costs 6 (it renders as a backslash-u escape). So a raw-byte
 *  cut against a serialized budget overshoots by however much the text happens
 *  to escape. Measured against a 100000-byte ceiling before this fix:
 *
 *    plain text        99909   (under -- no escaping at all, which is why a
 *                               fixture of "xxxx..." could not catch this)
 *    log lines        102750   (newlines)
 *    JSON-ish text    124773   (quotes)
 *    ANSI-coloured    166215   (escape bytes -- 66% over)
 *
 *  A fixed envelope allowance cannot bound a multiplicative expansion, so the
 *  only honest answer is to measure the real block. Binary search on the raw
 *  byte offset: O(log n) serializations, each of a string already in memory,
 *  against a payload that is by definition oversized. The alternative -- cut,
 *  measure, shrink by a guess, repeat -- has no bound at all on text that
 *  escapes heavily. */
function fitTextBlock(item: CapContent, budget: number): { block: CapContent; size: number } | null {
  if (typeof item.text !== "string" || budget <= 0) return null;
  let lo = 0;
  let hi = Buffer.byteLength(item.text, "utf8");
  let best: { block: CapContent; size: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cut = cutToBytes(item.text, mid);
    if (cut.length === 0) {
      lo = mid + 1;
      continue;
    }
    const block = { ...item, text: cut };
    const size = serializedBytes(block);
    if (size <= budget) {
      best = { block, size };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function serializedBytes(item: CapContent): number {
  try {
    return Buffer.byteLength(JSON.stringify(item), "utf8");
  } catch {
    // A cyclic or otherwise unserializable block cannot be measured. Treat it
    // as over-budget rather than as free: an unmeasurable block is exactly
    // the kind this ceiling exists to stop, and calling it zero would let it
    // through every time.
    return Number.POSITIVE_INFINITY;
  }
}

/** Apply the ceiling to a content array.
 *
 *  Blocks are kept in order while the budget lasts. The block that crosses it
 *  is truncated when it is text (a partial log is useful; the marker says it
 *  is partial) and dropped when it is not -- half an image is not half an
 *  answer. Everything after is dropped, and one final text block names the
 *  count and the byte total so the model knows the reply is incomplete and
 *  can narrow its next call instead of trusting a fragment.
 *
 *  `maxBytes <= 0` disables the cap and returns the input untouched.
 *
 *  The RETURNED array respects the ceiling, notice included -- the notice's
 *  bytes are reserved from the budget rather than added on top of it. One
 *  documented exception: a ceiling smaller than the notice itself cannot be
 *  honoured AND still report the cut, so such a call returns the notice alone
 *  and goes over. Reporting wins there, because a silently truncated log
 *  reads to the model as a complete one, which is the failure this module
 *  exists to prevent. */
export function capContent(content: CapContent[], maxBytes: number): CapResult {
  let bytesRaw = 0;
  for (const item of content) {
    const b = serializedBytes(item);
    bytesRaw += Number.isFinite(b) ? b : 0;
  }
  if (maxBytes <= 0 || content.length === 0) {
    return { content, capped: false, bytesRaw, bytesKept: bytesRaw };
  }
  if (bytesRaw <= maxBytes && content.every((i) => Number.isFinite(serializedBytes(i)))) {
    return { content, capped: false, bytesRaw, bytesKept: bytesRaw };
  }

  const kept: CapContent[] = [];
  let used = 0;
  let droppedBlocks = 0;
  let truncatedText = false;

  // The notice is part of the reply, so its bytes come OUT of the budget
  // rather than being added on top of it. Appending it afterwards made the
  // returned payload exceed the ceiling by the notice's own size -- measured
  // at 387 bytes over on every cap value, which is a cap that does not cap.
  // It went unnoticed because `bytesKept` counts only the content blocks, so
  // an assertion on that field passed while the actual array was over.
  //
  // Reserved from the largest notice this can produce, not the one this call
  // will: the text varies with the byte totals and the dropped-block count,
  // and reserving the actual value needs the count, which is not known until
  // the loop below has run. Over-reserving by a few dozen bytes keeps the
  // ceiling honest; under-reserving would put it back over.
  const noticeReserve = MAX_NOTICE_BYTES;
  const contentBudget = maxBytes - noticeReserve;

  for (const item of content) {
    const size = serializedBytes(item);
    if (Number.isFinite(size) && used + size <= contentBudget) {
      kept.push(item);
      used += size;
      continue;
    }
    // This block crosses the ceiling.
    const remaining = contentBudget - used;
    if (item.type === "text" && typeof item.text === "string" && remaining > MIN_USEFUL_TAIL_BYTES) {
      // Measured, not estimated. fitTextBlock returns a block whose SERIALIZED
      // size is known to fit `remaining` -- including the JSON envelope and any
      // sibling properties the spread carries along, both of which a fixed
      // allowance got wrong.
      const fitted = fitTextBlock(item, remaining);
      if (fitted) {
        kept.push(fitted.block);
        used += fitted.size;
        truncatedText = true;
        droppedBlocks += content.length - content.indexOf(item) - 1;
        break;
      }
    }
    droppedBlocks += content.length - content.indexOf(item);
    break;
  }

  kept.push({ type: "text", text: capNotice(bytesRaw, maxBytes, droppedBlocks, truncatedText) });
  return { content: kept, capped: true, bytesRaw, bytesKept: used };
}

// Below this, a truncated tail is not worth keeping -- a few dozen bytes of a
// log tells the model nothing and still reads as content.
const MIN_USEFUL_TAIL_BYTES = 512;

/** Upper bound on the serialized size of the notice block, reserved from the
 *  budget before any content is kept.
 *
 *  DERIVED, not guessed: capNotice is called with the values that make it
 *  longest -- both optional clauses present, and byte counts wide enough to
 *  cover any realistic result -- and the answer is measured. A hand-written
 *  constant would drift the moment someone edits the wording, and the drift
 *  would be silent in the direction that matters (a longer notice than the
 *  reserve puts the reply back over the ceiling). The computation runs once at
 *  module load and costs one JSON.stringify. */
const MAX_NOTICE_BYTES = (() => {
  // 999999999 is wider than any byte count a real result can carry, so the
  // rendered digits are at least as long as any live call will produce.
  const worst = capNotice(999_999_999, 999_999_999, 999_999_999, true);
  return Buffer.byteLength(JSON.stringify({ type: "text", text: worst }), "utf8");
})();
// ENVELOPE_ALLOWANCE_BYTES used to live here: a flat 64 bytes meant to cover
// the JSON keys and quoting around a cut text. It was deleted rather than
// retuned, because no constant can do that job. The overshoot it was guarding
// is MULTIPLICATIVE in the text's escaping (see fitTextBlock), so the error
// scales with the payload -- 66% over on ANSI-coloured output -- and it also
// ignored sibling properties the spread carries into the kept block.
// fitTextBlock measures the assembled block instead.

/** The marker appended to a capped result. Written for the model: what
 *  happened, how much is missing, and the two ways to get the rest. */
function capNotice(bytesRaw: number, maxBytes: number, droppedBlocks: number, truncatedText: boolean): string {
  const dropped = droppedBlocks > 0 ? ` ${droppedBlocks} further content block(s) were dropped.` : "";
  const cut = truncatedText ? " The last block above is TRUNCATED, not complete." : "";
  return (
    `[yaw-mcp] This tool result was ${bytesRaw} bytes, over the ${maxBytes}-byte ceiling, and has been CUT.` +
    `${cut}${dropped}` +
    " Do not treat what you received as the whole answer." +
    " Call the tool again with narrower arguments (a filter, a page, a smaller range)," +
    " or use mcp_connect_exec to reduce the result upstream." +
    " Ops can change the limit via YAW_MCP_MAX_RESULT_BYTES (0 disables it)."
  );
}
