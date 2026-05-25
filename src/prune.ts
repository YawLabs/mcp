// Conservative response pruning for MCP tool-call results.
//
// Goal: strip obviously-dead weight from upstream responses before they
// reach the LLM, so large tool outputs cost fewer tokens without
// changing meaning. We measure bytes before and after and ship both
// numbers to the backend (see analytics.ts::recordDispatchEvent) so the
// dashboard can surface a "tokens saved" figure.
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
//   * If pruning doesn't save at least MIN_SAVINGS_RATIO of bytes, we
//     return the original untouched — the re-serialization cost isn't
//     worth a marginal win.
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
      const cleaned = pruneJson(parsed);
      if (cleaned !== undefined) return JSON.stringify(cleaned);
    } catch {
      // Not JSON — fall through to text-mode cleanup.
    }
  }
  return pruneWhitespace(text);
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
    const cleaned: unknown[] = [];
    for (const el of value) {
      const pv = pruneJson(el);
      if (pv !== undefined) cleaned.push(pv);
    }
    return cleaned.length === 0 ? undefined : cleaned;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneJson(v);
      if (pv !== undefined) {
        out[k] = pv;
        kept++;
      }
    }
    return kept === 0 ? undefined : out;
  }

  return value;
}
