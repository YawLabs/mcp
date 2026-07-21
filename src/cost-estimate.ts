// Rough "how many tokens will this server add to your context" estimate
// for the discover() meta-tool. Helps the LLM budget before activating.
//
// We take the approach the mcp-hosting backend's `estimateTokens` uses —
// ~4 bytes/token averages close enough to both OpenAI's BPE and
// Anthropic's tokenizer for the coarse "this is a 300-token server vs.
// a 3,000-token server" signal discover() surfaces.
//
// Connected servers: measure the actual tool definitions the LLM would
// see — name + description + inputSchema, serialized as JSON.
//
// Not-yet-connected servers (toolCache only): we don't have inputSchema
// yet, so we pad each tool with a conservative schema-overhead constant.
// 200 bytes is the 50th percentile of observed MCP inputSchema JSON
// across our sampled catalog; it's roughly 50 tokens per tool of
// "unknown" surface. The estimate is labelled with a leading tilde in
// the UI so no caller treats it as authoritative.

const BYTES_PER_TOKEN = 4;

// Added to each cached tool to approximate an unseen inputSchema.
// Tuned to 200 bytes (~50 tokens) based on the median of tool schema
// sizes across the @yawlabs/* catalog. Tools with nothing but required
// fields are tighter; tools with rich discriminated unions blow past
// this — hence the tilde.
const CACHED_TOOL_SCHEMA_PAD_BYTES = 200;

// Minimum description allowance for tools that don't carry one in
// toolCache. Descriptions are usually a 1-2 sentence blurb, 80-150
// bytes in practice; 100 is a fair middle.
const MISSING_DESCRIPTION_PAD_BYTES = 100;

export interface CostSample {
  tools: number;
  bytes: number;
  tokens: number;
  // True when the estimate came from cached name/description only,
  // not the live tool definitions. Helps callers surface uncertainty.
  cached: boolean;
}

// Server isn't connected — we only have name + description from the
// toolCache. Pad each tool with a stub allowance for the unseen schema.
export function estimateFromToolCache(
  toolCache: Array<{ name: string; description?: string }> | undefined,
): CostSample {
  if (!toolCache || toolCache.length === 0) {
    return { tools: 0, bytes: 0, tokens: 0, cached: true };
  }
  let bytes = 0;
  for (const t of toolCache) {
    bytes += Buffer.byteLength(t.name, "utf8");
    bytes += Buffer.byteLength(t.description ?? "", "utf8") || MISSING_DESCRIPTION_PAD_BYTES;
    bytes += CACHED_TOOL_SCHEMA_PAD_BYTES;
  }
  return {
    tools: toolCache.length,
    bytes,
    tokens: Math.ceil(bytes / BYTES_PER_TOKEN),
    cached: true,
  };
}

// Server is connected — measure the tool defs the LLM actually sees.
// This is the authoritative estimate; no cached=true on the result.
export function estimateFromConnectedTools(
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): CostSample {
  if (tools.length === 0) return { tools: 0, bytes: 0, tokens: 0, cached: false };
  let bytes = 0;
  for (const t of tools) {
    try {
      bytes += Buffer.byteLength(
        JSON.stringify({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }),
        "utf8",
      );
    } catch {
      // Schemas with cycles are pathological; fall back to the cached
      // formula for that one tool so the whole estimate doesn't error.
      bytes += Buffer.byteLength(t.name, "utf8");
      bytes += Buffer.byteLength(t.description ?? "", "utf8") || MISSING_DESCRIPTION_PAD_BYTES;
      bytes += CACHED_TOOL_SCHEMA_PAD_BYTES;
    }
  }
  return {
    tools: tools.length,
    bytes,
    tokens: Math.ceil(bytes / BYTES_PER_TOKEN),
    cached: false,
  };
}

// UI-facing compact label: "12 tools, ~850 tokens" (cached) or
// "12 tools, 850 tokens" (connected). Returns empty string if the
// sample has no tools — caller decides how to render that.
export function formatCostLabel(sample: CostSample): string {
  if (sample.tools === 0) return "";
  const n = sample.tokens;
  // Readable orders of magnitude: "120", "1.2k", "22k".
  //
  // The 10k cutoff is applied to the ROUNDED value, not the raw one. Testing
  // the raw n put 9999 in the one-decimal branch, where it rounded up to
  // "10.0k" while 10000 rendered "10k" -- one token more, and the label got
  // shorter. Deciding on the rounded value keeps the boundary monotone: both
  // render "10k".
  let tokensLabel: string;
  if (n < 1000) {
    tokensLabel = String(n);
  } else {
    const k = n / 1000;
    const oneDecimal = Math.round(k * 10) / 10;
    tokensLabel = oneDecimal < 10 ? `${oneDecimal.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const pluralTools = sample.tools === 1 ? "tool" : "tools";
  const tilde = sample.cached ? "~" : "";
  return `${sample.tools} ${pluralTools}, ${tilde}${tokensLabel} tokens`;
}
