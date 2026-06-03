// Coarse classification of failed tool calls. Sent alongside
// `success: false` analytics events so the Yaw MCP dashboard's
// Recent failures table can show "12 unauthorized" instead of "(no
// message)" 12 times.
//
// We deliberately don't ship the raw error text -- third-party MCP
// servers routinely echo args/secrets in errors (URLs with api_key=
// query params, request bodies, Python tracebacks containing locals)
// and we have no general scrubber. See ConnectAnalyticsEvent in
// analytics.ts for the original rationale.
//
// Keep this list in sync with mcp-hosting/src/lib/connect-error-categories.ts.
// The backend drops anything outside that allowlist on ingest, so adding
// a new category requires bumping both repos.

export const ERROR_CATEGORIES = [
  "validation_error",
  "timeout",
  "unauthorized",
  "unknown_tool",
  "connection_lost",
  "rate_limited",
  "not_found",
  "upstream_error",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

// Patterns derived from observed error shapes in real sessions:
// - MCP error -32602 (zod validation): "Invalid input", "expected ... received"
// - MCP error -32001: "Request timed out"
// - JSON-RPC -32601: "Method not found", "Unknown tool"
// - HTTP-ish: 401/403/429/404 status codes, "unauthorized", "rate limit"
// - yaw-mcp's own auto-reconnect message: "disconnected and auto-reconnect failed"
//
// Order matters -- the first match wins. The exact precedence is:
//
//   timeout > validation_error > unknown_tool > connection_lost
//     > rate_limited > unauthorized > not_found > upstream_error
//
// Rate-limit is intentionally above unauthorized because some providers
// emit "auth rate limit exceeded" and we want the rate-limit reading to
// win. Unauthorized is above not_found because a 401-then-404 cascade
// is more actionable as "fix the auth" than "fix the URL." Anything
// that matches none falls through to upstream_error.
//
// HTTP status codes match against \b-anchored regexes so a request ID
// or path segment that happens to contain "401" / "404" / "429" / "403"
// doesn't false-positive. Substring matches on bare digits would catch
// rows like "GET /v1/r/4040" or "request id: 401abc" and misclassify.
const RX_HTTP_401 = /\b401\b/;
const RX_HTTP_403 = /\b403\b/;
const RX_HTTP_404 = /\b404\b/;
const RX_HTTP_429 = /\b429\b/;
const RX_NO_TOKEN = /no [a-z_]*token (configured|set)/i;

export function classifyError(text: string | undefined | null): ErrorCategory {
  if (!text) return "upstream_error";
  const t = text.toLowerCase();

  // Timeout: MCP error -32001 is the canonical timeout code from
  // @modelcontextprotocol/sdk, plus the bare "timed out" / "timeout"
  // shapes that show up when an upstream returns its own timeout text.
  if (t.includes("-32001") || t.includes("timed out") || t.includes(" timeout")) {
    return "timeout";
  }

  // Validation: zod / JSON schema -- yaw-mcp sees these as -32602 from
  // upstream servers and as raw zod issues from its own validators.
  if (
    t.includes("-32602") ||
    t.includes("invalid input") ||
    t.includes("invalid_type") ||
    t.includes("invalid arguments")
  ) {
    return "validation_error";
  }

  // Unknown tool: the dispatcher itself emits this when a route lookup
  // misses, and JSON-RPC -32601 ("Method not found") covers upstream
  // servers that reject a tools/call for a tool they don't expose.
  if (t.includes("unknown tool") || t.includes("-32601") || t.includes("method not found")) {
    return "unknown_tool";
  }

  // Connection lost: yaw-mcp's auto-reconnect failure string -- this one
  // is precise enough that we don't need a generic "disconnected"
  // catch (which would also match upstream tool descriptions).
  if (t.includes("auto-reconnect failed") || t.includes("connection closed")) {
    return "connection_lost";
  }

  // Rate-limit: HTTP 429 + a couple of common phrasings. Has to come
  // before unauthorized because some providers say "auth rate limit
  // exceeded" and we want the rate-limit interpretation to win.
  if (RX_HTTP_429.test(t) || t.includes("rate limit") || t.includes("too many requests")) {
    return "rate_limited";
  }

  // Auth: HTTP 401/403, plus the upstream MCP shape "no X_TOKEN
  // configured" (npmjs, github, etc. all reject with that pattern when
  // an env var is missing).
  if (
    RX_HTTP_401.test(t) ||
    RX_HTTP_403.test(t) ||
    t.includes("unauthorized") ||
    t.includes("forbidden") ||
    t.includes("permission denied") ||
    RX_NO_TOKEN.test(text)
  ) {
    return "unauthorized";
  }

  // Not found: HTTP 404 + the canonical "not found" string.
  if (RX_HTTP_404.test(t) || t.includes("not found")) {
    return "not_found";
  }

  return "upstream_error";
}
