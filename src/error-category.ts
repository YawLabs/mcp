// Coarse classification of failed tool calls, so a failure can be
// described by category ("unauthorized") rather than by raw error text.
//
// We deliberately never surface the raw error text alongside the
// category -- third-party MCP servers routinely echo args/secrets in
// errors (URLs with api_key= query params, request bodies, Python
// tracebacks containing locals) and we have no general scrubber.

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
// HTTP status codes require CONTEXT, not just \b-anchored digits. The \b
// anchors alone only reject contiguous-digit shapes ("GET /v1/r/4040",
// "request id: 401abc"); they still matched standalone tokens in
// SUCCESSFUL replies -- issue numbers ("#429 fix flaky build"),
// stack-trace line numbers ("server.js:404:12"), byte counts ("rx 429
// bytes"), JSON payload numbers ('{"number":401}') -- and reward.ts runs
// classifyError over EVERY proxied result, so each false positive banked
// a healthy call at 0.2 credit and fed the flaky list.
//
// Four context shapes match, chosen against real MCP error bodies:
//   A1. A STATUS intro before the code: status / statuscode / status_code
//      and the key spellings with an http/error/response prefix
//      (errorcode, error_code, httpstatus, httpstatuscode -- the AWS SDK
//      v3 $metadata spelling -- http_status, response_code; all seen
//      lowercased because classifyError lowercases its input), code, http
//      (incl. an HTTP/1.1-style status line), error, exception, failed,
//      responded, response, rejected. error/exception also match as a
//      CamelCase-glued suffix ("httperror: 404", "httpexception: 429",
//      "statuscodeerror: 429" after lowercasing). Between the intro word
//      and the code: punctuation / whitespace, OR a short bridge of
//      function words followed by optional punctuation ("failed with
//      429", "returned a 429", "failed with (429)"), OR up to three plain
//      words plus one URL/path-ish token ending in ":" ("failed to fetch
//      https://api.x.com/v1: 401", "error fetching robots.txt: 404" --
//      the fetch-wrapper template, whose HTTP/2 statusText is empty so no
//      reason phrase can rescue it). The bridges are closed shapes so an
//      arbitrary word cannot smuggle a count past the guard; "status" is
//      deliberately NOT a bridge word (it is already an intro, and
//      listing it in both places made a run of the token backtrack
//      quadratically -- 11 s on a 98 KB reply, measured); the URL token
//      is captured atomically (lookahead + backreference) so a long
//      dotted run stays linear; and the punctuation gaps exclude "#"
//      (an issue/PR reference: "fixed error #429") and "|" (a table cell
//      boundary: "| errors | 429 |" is a count column, and excluding the
//      pipe kills "| bytes received | 429 |" structurally).
//   A2. A COUNT-VERB intro (returned / received) with the same bridges --
//      but see the wider veto below.
//   B. The code immediately followed by error / response / status ("got a
//      429 response", "404 error from server") -- post-positioned
//      phrasings A1/A2 cannot see.
//   C. The body BEGINS with the code, after optional whitespace/quotes/
//      brackets -- the `${status} ${body}` convention of the Anthropic /
//      OpenAI SDK error messages ('401 {"type":"error",...}', "429 You
//      exceeded your current quota ...", '"401 {...}"' re-quoted by a
//      wrapper, "[401] ...").
//   Vetoes: A1 rejects a PLURAL count noun after the code ("received 429
//   bytes"-class); A2 and C additionally reject the plural domain nouns
//   (tokens/users/requests/repos/issues/commits/errors), because after a
//   count verb or at the start of a body those are counts ("received 429
//   requests in the last hour", "429 users match the filter") -- while
//   after a STATUS intro they are the objects of a real failure message
//   ("status 401 token expired"). Both lists are PLURAL-ONLY: a count of
//   401 is never followed by a singular noun, but a reason phrase often
//   is ("401 invalid token", "403 user lacks scope"). One adjective is
//   tolerated before the noun; ":" and "," right after the code are NOT
//   treated as count punctuation (they introduce a message: "HTTP 401:
//   the token has expired"). A2 also refuses when the count verb is
//   itself preceded by a bare count noun ("bytes received 429" -- an rx
//   stats line).
// Replies that carry the reason phrase instead ("401 Unauthorized",
// "Forbidden (403)", "429 Too Many Requests", "Bad credentials") are
// matched by the word checks in classifyError below, not by these regexes.
function httpStatusRe(code: number): RegExp {
  const keyPrefix = "(?:https?|error|response)?[\\s_-]*";
  const statusIntro = `${keyPrefix}status(?:[\\s_-]*code)?|${keyPrefix}code|https?(?:/[\\d.]{1,4})?|error|exception|failed|responded|response|rejected`;
  const countVerbIntro = "returned|received";
  // Atomic via lookahead+backreference: the token is captured once and
  // consumed verbatim, so the engine cannot re-split it while
  // backtracking. Three subtleties, each learned from a defect:
  //   - The capture is UNCAPPED \\S+: greedy \\S+ inside a lookahead is
  //     deterministic (no interior choice points), so it is not what
  //     keeps the shape linear -- and a {1,300} cap made the token
  //     capture exactly 300 chars of a longer URL, the (?<=:) then
  //     demanded char 300 be ":", and atomicity (correctly) forbade
  //     retrying: presigned S3/Azure/GCS URLs (routinely 400-1500 chars)
  //     silently fell out of the fetch-wrapper shape. Only the first
  //     lookahead -- the one that CAN backtrack -- keeps its 300 bound.
  //   - The group is NAMED, with a distinct name per interpolation:
  //     `bridge` is spliced into both shapeA1 and shapeA2, and a numbered
  //     backreference (\\1) in the second copy silently pointed at the
  //     FIRST copy's group after renumbering -- a non-participating group
  //     matches empty, the lookbehind then always failed, and shapeA2's
  //     URL branch was dead code no test could see.
  const urlToken = (g: string) => `(?=\\S{0,300}[/.])(?=(?<${g}>\\S+))\\k<${g}>(?<=:)`;
  //   - The punctuation gaps are {1,10}, never {0,10}: a zero-width gap
  //     let identifiers that GLUE an intro spelling onto the digits match
  //     ("wrote errorcode429.log", "saved http_status429.json",
  //     "typeerror429.md" in a file listing); every real error spelling
  //     has at least one separator between intro and code.
  const bridge = (g: string) =>
    `(?:[^\\w#|]{1,10}|(?:\\s+(?:with|a|an|the|of))+[^\\w#|]{1,10}|(?:\\s+[a-z]+){0,3}\\s+${urlToken(g)}\\s*)`;
  const countNouns = "bytes|rows|results|items|records|entries|files|lines|ms|messages|matches|findings|hits";
  const afterCode = `(?:${countNouns}|passed|failed|warnings)`;
  const domainNouns = "tokens|users|requests|repos|issues|commits|errors";
  const notCount = `(?![\\s|]{0,3}(?:[a-z]+\\s+)?${afterCode}\\b)`;
  const notCountOrDomain = `(?![\\s|]{0,3}(?:[a-z]+\\s+)?(?:${afterCode}|${domainNouns})\\b)`;
  const nounBefore = `(?<!\\b(?:${countNouns})\\s{0,3})`;
  const shapeA1 = `(?:\\b(?:${statusIntro})|(?<=[a-z])(?:error|exception))${bridge("u1")}${code}\\b${notCount}`;
  const shapeA2 = `${nounBefore}\\b(?:${countVerbIntro})${bridge("u2")}${code}\\b${notCountOrDomain}`;
  const shapeB = `\\b${code}\\s+(?:error|response|status)\\b`;
  const shapeC = `^[\\s"'\`\\[(]*${code}\\b${notCountOrDomain}`;
  return new RegExp(`${shapeA1}|${shapeA2}|${shapeB}|${shapeC}`);
}
const RX_HTTP_401 = httpStatusRe(401);
const RX_HTTP_403 = httpStatusRe(403);
const RX_HTTP_404 = httpStatusRe(404);
const RX_HTTP_429 = httpStatusRe(429);
const RX_NO_TOKEN = /no [a-z_]*token (configured|set)/i;
// "timeout" as a standalone, UNQUOTED word anywhere in the message. Three
// constraints, each earning its keep:
//
//   - Anywhere, not leading-space-anchored (the previous shape): that missed
//     the single most common client error in the corpus -- axios's "timeout of
//     5000ms exceeded", which starts the string -- and sent it to
//     upstream_error, where reward.ts treats it as a benign catch-all and
//     grants the call FULL credit.
//   - \b on both sides: keeps identifier-shaped text (connectTimeoutMs,
//     set_timeout, timeout_ms) from false-positiving, since JS word boundaries
//     treat `_` as a word char.
//   - Not directly quote-delimited: a `timeout` token wrapped in ' " or `
//     is DATA, not a failure report -- a config key echoed back by a
//     successful call (`{"timeout":5000,"retries":3}`) or a zod path in a
//     validation error (`"path":["timeout"]`). classifyError runs the timeout
//     check FIRST and server.ts scores EVERY proxied result, so a bare-noun
//     match banked a successful get_config at 0.2 reward instead of 1.0, and
//     stole -32602 replies from validation_error. Genuine timeouts either say
//     "timed out" (matched separately below) or use the word in running prose,
//     where it is unquoted. The tradeoff is a quoted error VALUE
//     (`{"error":"timeout"}`) falling through to upstream_error; that is the
//     benign direction, and such payloads normally carry "timed out" or -32001
//     as well.
const RX_TIMEOUT = /(?<!["'`])\btimeout\b(?!["'`])/;

export function classifyError(text: string | undefined | null): ErrorCategory {
  if (!text) return "upstream_error";
  const t = text.toLowerCase();

  // Timeout: MCP error -32001 is the canonical timeout code from
  // @modelcontextprotocol/sdk, plus the bare "timed out" / "timeout"
  // shapes that show up when an upstream returns its own timeout text.
  if (t.includes("-32001") || t.includes("timed out") || RX_TIMEOUT.test(t)) {
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
  if (
    RX_HTTP_429.test(t) ||
    t.includes("rate limit") ||
    t.includes("too many requests") ||
    // OpenAI SDK quota body: "429 You exceeded your current quota, ..."
    t.includes("exceeded your current quota")
  ) {
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
    t.includes("access denied") ||
    // go-github / github-mcp-server reason phrases, which follow a URL
    // rather than an intro word ("GET https://api.github.com/...: 401 Bad
    // credentials []") so the status regex cannot see the code.
    t.includes("bad credentials") ||
    t.includes("requires authentication") ||
    t.includes("not accessible by") ||
    RX_NO_TOKEN.test(t)
  ) {
    return "unauthorized";
  }

  // Not found: HTTP 404 + the canonical "not found" string.
  if (RX_HTTP_404.test(t) || t.includes("not found")) {
    return "not_found";
  }

  return "upstream_error";
}
