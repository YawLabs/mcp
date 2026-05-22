import { describe, expect, it } from "vitest";
import { ERROR_CATEGORIES, classifyError } from "../error-category.js";

describe("classifyError", () => {
  // Test cases sourced from real failures observed in session
  // transcripts on 2026-05-19 .. 2026-05-21 (mcp-hosting Recent
  // failures dashboard investigation).
  const cases: Array<[string, string, (typeof ERROR_CATEGORIES)[number]]> = [
    ["ssh_exec timeout", "Error calling ssh_ssh_exec [code=-32001]: MCP error -32001: Request timed out", "timeout"],
    ["bare 'timed out' phrasing", "upstream: connection timed out after 30s", "timeout"],
    [
      "zod validation -32602 with missing array",
      'MCP error -32602: Input validation error: Invalid arguments for tool aws_metrics_query: [{"expected":"array","code":"invalid_type","path":["queries"]}]',
      "validation_error",
    ],
    [
      "zod -32602 with missing string field",
      'MCP error -32602: Input validation error: Invalid arguments for tool aws_call: [{"expected":"string","code":"invalid_type","path":["operation"],"message":"Invalid input: expected string, received undefined"}]',
      "validation_error",
    ],
    [
      "dispatcher unknown tool",
      "Unknown tool: npmjs_npm_trusted_publishers. Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.",
      "unknown_tool",
    ],
    ["JSON-RPC method not found", "MCP error -32601: Method not found", "unknown_tool"],
    [
      "missing token (npm shape)",
      "Error: No NPM_TOKEN configured. Set the NPM_TOKEN environment variable to use authenticated endpoints.",
      "unauthorized",
    ],
    [
      "missing token (github shape)",
      "No GITHUB_TOKEN configured. Set it to use authenticated endpoints.",
      "unauthorized",
    ],
    ["HTTP 401", "Request failed: 401 Unauthorized", "unauthorized"],
    ["HTTP 403", "Forbidden (403)", "unauthorized"],
    ["permission denied phrasing", "Permission denied: cannot access resource", "unauthorized"],
    ["HTTP 429", "429 Too Many Requests", "rate_limited"],
    ["rate limit phrasing", "API rate limit exceeded for user", "rate_limited"],
    ["rate-limit beats auth when both appear", "auth-rate-limit: too many requests", "rate_limited"],
    ["HTTP 404", "Resource returned 404", "not_found"],
    ["bare not found", "Subscription not found in store", "not_found"],
    [
      "mcph auto-reconnect failed",
      'Server "ssh" disconnected and auto-reconnect failed: ECONNREFUSED. Use mcp_connect_activate with server "ssh" to reload it manually.',
      "connection_lost",
    ],
    [
      "unknown upstream falls through to upstream_error",
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      "upstream_error",
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(`classifies: ${name} -> ${expected}`, () => {
      expect(classifyError(input)).toBe(expected);
    });
  }

  it("returns upstream_error for empty / null / undefined text", () => {
    expect(classifyError(null)).toBe("upstream_error");
    expect(classifyError(undefined)).toBe("upstream_error");
    expect(classifyError("")).toBe("upstream_error");
  });

  it("only ever returns values in the ERROR_CATEGORIES allowlist", () => {
    const out = new Set(cases.map(([, input]) => classifyError(input)));
    for (const value of out) {
      expect(ERROR_CATEGORIES).toContain(value);
    }
  });

  // Cross-repo drift tripwire. The mcp-hosting backend ships its own
  // copy of this list in src/lib/connect-error-categories.ts; the
  // ingest endpoint normalizes against it and drops unknown values to
  // null. If someone widens this enum without bumping the backend's
  // copy, every value of the new category gets silently dropped on
  // ingest. Pin the literal contents here so adding/removing a member
  // is a deliberate two-repo change (this test fails -> backend test
  // also fails -> both have to be updated together).
  it("ERROR_CATEGORIES is the exact pinned list (cross-repo drift tripwire)", () => {
    expect([...ERROR_CATEGORIES]).toEqual([
      "validation_error",
      "timeout",
      "unauthorized",
      "unknown_tool",
      "connection_lost",
      "rate_limited",
      "not_found",
      "upstream_error",
    ]);
  });
});
