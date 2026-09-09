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
//      passed through verbatim by the proxy and is NOT capped here -- see
//      the note on capResult.

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
 *  `maxBytes <= 0` disables the cap and returns the input untouched. */
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

  for (const item of content) {
    const size = serializedBytes(item);
    if (Number.isFinite(size) && used + size <= maxBytes) {
      kept.push(item);
      used += size;
      continue;
    }
    // This block crosses the ceiling.
    const remaining = maxBytes - used;
    if (item.type === "text" && typeof item.text === "string" && remaining > MIN_USEFUL_TAIL_BYTES) {
      // Leave room for the JSON envelope around the text, so the kept block
      // really does fit the budget rather than the text alone doing so.
      const textBudget = remaining - ENVELOPE_ALLOWANCE_BYTES;
      const cut = cutToBytes(item.text, Math.max(0, textBudget));
      if (cut.length > 0) {
        kept.push({ ...item, text: cut });
        used += serializedBytes({ ...item, text: cut });
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
// Rough allowance for the JSON keys and quoting around a text block, so a cut
// text does not push the serialized block back over the budget.
const ENVELOPE_ALLOWANCE_BYTES = 64;

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
