import { describe, expect, it } from "vitest";
import { type RankableServer, rankServers } from "../relevance.js";

// ═══════════════════════════════════════════════════════════════════════
// Smart-routing quality gate. Pre-launch exercise from the launch TODO:
// "run mcp_connect_dispatch with varied English intents against a
// seeded 15-server config; verify the top-ranked server is correct or
// within top-3 in all cases."
//
// BENCHMARK below carries 14 intents (the original 10, plus 4 added for
// fetch-mcp v0.2.0's expanded surface). Keep this count in sync when
// adding cases -- it sets what the accuracy floor actually buys: at 14
// intents the >=80% top-1 gate tolerates 2 misses (12/14 = 85.7% passes,
// 11/14 = 78.6% fails).
//
// This file runs the BM25 side of that check — no Voyage rerank, so it
// tests the *floor* of ranking quality (what every user sees even when
// the backend rerank key is missing or the call times out). If this
// suite stays green across refactors, dispatch never regresses below
// the lexical baseline.
//
// The benchmark is deliberately a unit test, not a live-backend
// integration test, so it runs in CI without a Voyage key.
// ═══════════════════════════════════════════════════════════════════════

// Realistic seed of 15 MCP servers drawn from the mcp.hosting catalog.
// Descriptions + tool metadata match what the dashboard surfaces, which
// is what the ranker actually sees in production.
const CORPUS: RankableServer[] = [
  {
    namespace: "github",
    name: "GitHub",
    description: "GitHub API — issues, pull requests, repos, commits, branches, files, workflows",
    tools: [
      { name: "create_issue", description: "Open a new issue" },
      { name: "list_pull_requests" },
      { name: "merge_pull_request" },
      { name: "get_file_contents" },
      { name: "create_branch" },
      { name: "search_code" },
    ],
  },
  {
    namespace: "slack",
    name: "Slack",
    description: "Slack workspace — channels, messages, DMs, threads, reactions, users",
    tools: [
      { name: "post_message", description: "Send a message to a Slack channel" },
      { name: "list_channels" },
      { name: "reply_in_thread" },
      { name: "search_messages" },
    ],
  },
  {
    namespace: "stripe",
    name: "Stripe",
    description: "Stripe payments — charges, customers, subscriptions, invoices, refunds",
    tools: [
      { name: "create_charge", description: "Charge a customer's card" },
      { name: "create_customer" },
      { name: "create_subscription" },
      { name: "refund_charge" },
      { name: "list_invoices" },
    ],
  },
  {
    namespace: "postgres",
    name: "Postgres",
    description: "Postgres read-only SQL queries against the connected database",
    tools: [
      { name: "query", description: "Run a SELECT statement" },
      { name: "list_tables" },
      { name: "describe_table" },
    ],
  },
  {
    namespace: "linear",
    name: "Linear",
    description: "Linear project management — issues, projects, teams, comments, cycles",
    tools: [
      { name: "create_issue", description: "Create a Linear ticket" },
      { name: "list_issues" },
      { name: "add_comment" },
      { name: "update_issue_status" },
    ],
  },
  {
    namespace: "fetch",
    name: "Fetch",
    description:
      "HTTP fetch for agents — GET/POST/PUT/PATCH/DELETE, HTML to markdown, reader-mode article extraction, page metadata (opengraph, twitter cards, JSON-LD), outbound link extraction, XML sitemap parsing, RSS and Atom feed parsing, robots.txt verdicts. SSRF-protected.",
    tools: [
      { name: "http_get", description: "GET a URL and return the response body" },
      { name: "http_post", description: "POST a JSON or raw body to a URL" },
      { name: "http_put" },
      { name: "http_patch" },
      { name: "http_delete" },
      { name: "http_head" },
      { name: "http_options" },
      { name: "fetch_html_to_markdown", description: "Download a web page and convert to clean markdown" },
      { name: "fetch_html_to_text" },
      { name: "fetch_reader", description: "Reader-mode: isolate the main article body from a page" },
      { name: "fetch_meta", description: "Extract opengraph, twitter, JSON-LD metadata from a URL" },
      { name: "fetch_links", description: "Extract every outbound link from a page" },
      { name: "fetch_sitemap", description: "Parse an XML sitemap (gzipped and sitemap-index supported)" },
      { name: "fetch_feed", description: "Parse an RSS 2.0 or Atom 1.0 feed" },
      { name: "fetch_robots", description: "Parse robots.txt and return allow/disallow verdict for a path" },
    ],
  },
  {
    namespace: "filesystem",
    name: "Filesystem",
    description: "Read and write files on the local filesystem under an allowed root directory",
    tools: [{ name: "read_file" }, { name: "write_file" }, { name: "list_directory" }, { name: "search_files" }],
  },
  {
    namespace: "brave_search",
    name: "Brave Search",
    description: "Web search via Brave — query and return ranked results",
    tools: [{ name: "web_search", description: "Search the web" }],
  },
  {
    namespace: "time",
    name: "Time",
    description: "Current time, timezones, date arithmetic",
    tools: [{ name: "get_current_time" }, { name: "convert_timezone" }],
  },
  {
    namespace: "sentry",
    name: "Sentry",
    description: "Sentry error tracking — issues, events, releases, stack traces",
    tools: [{ name: "get_issue" }, { name: "list_project_issues" }, { name: "resolve_issue" }],
  },
  {
    namespace: "notion",
    name: "Notion",
    description: "Notion workspace — pages, databases, blocks, comments",
    tools: [{ name: "create_page" }, { name: "query_database" }, { name: "append_block_children" }, { name: "search" }],
  },
  {
    namespace: "gdrive",
    name: "Google Drive",
    description: "Google Drive files — list, read, upload, search documents and sheets",
    tools: [{ name: "list_files" }, { name: "read_file" }, { name: "search_files" }],
  },
  {
    namespace: "memory",
    name: "Memory",
    description: "Persistent knowledge graph for remembering entities and relations across sessions",
    tools: [
      { name: "create_entities" },
      { name: "create_relations" },
      { name: "search_nodes" },
      { name: "read_graph" },
    ],
  },
  {
    namespace: "sequential_thinking",
    name: "Sequential Thinking",
    description: "Step-by-step structured reasoning — break a hard problem into numbered thoughts",
    tools: [{ name: "sequentialthinking", description: "Add a structured reasoning step" }],
  },
  {
    namespace: "sqlite",
    name: "SQLite",
    description: "SQLite local database queries — SELECT, INSERT, schema inspection",
    tools: [{ name: "read_query" }, { name: "write_query" }, { name: "list_tables" }],
  },
];

// Varied intents a real user might give Claude. Each names the
// expected top-match namespace. Intents deliberately avoid including
// the namespace string itself in the query (that would be trivial) —
// they lean on the description/tools metadata instead.
const BENCHMARK: Array<{ intent: string; expected: string }> = [
  { intent: "open a new issue about a login bug on our repo", expected: "github" },
  { intent: "post a message to the #launch channel", expected: "slack" },
  { intent: "charge a customer's credit card for the invoice", expected: "stripe" },
  { intent: "run a SELECT query against the users table in the database", expected: "postgres" },
  { intent: "create a ticket for the mobile team to track a regression", expected: "linear" },
  { intent: "download the html of https://example.com/pricing", expected: "fetch" },
  { intent: "read the contents of a file from disk", expected: "filesystem" },
  { intent: "search the web for recent news about llms", expected: "brave_search" },
  { intent: "what time is it in Tokyo right now", expected: "time" },
  { intent: "look up the latest unresolved error events in our project", expected: "sentry" },
  // fetch-mcp v0.2.0 expanded surface — each intent targets a different sub-tool.
  { intent: "parse the xml sitemap for example.com", expected: "fetch" },
  { intent: "extract the main article body from this blog post url", expected: "fetch" },
  { intent: "get the opengraph metadata from this page url", expected: "fetch" },
  { intent: "parse the rss feed at blog.example.com/feed.xml", expected: "fetch" },
];

function topN(intent: string, n: number): string[] {
  return rankServers(intent, CORPUS)
    .slice(0, n)
    .map((r) => r.namespace);
}

describe("smart-routing quality gate (BM25 floor)", () => {
  // Primary gate from the launch TODO: top-3 must contain expected.
  // If any intent drops out of the top-3, the next commit to the
  // ranker probably regressed — investigate before merging.
  it.each(BENCHMARK)("top-3 contains expected namespace for: $intent", ({ intent, expected }) => {
    const top3 = topN(intent, 3);
    expect(top3, `top-3 was: ${top3.join(", ")}`).toContain(expected);
  });

  // Stronger gate: the expected namespace is also #1 for most intents.
  // We tolerate a small number of "top-3 but not top-1" misses because
  // BM25 alone is lexical — that's what Voyage rerank is for in prod.
  // At the current 14 intents the 80% floor tolerates exactly 2 misses;
  // a 3rd miss fails the gate. If top-1 accuracy drops below 80% here,
  // the corpus got worse OR the ranker regressed; either way, investigate.
  it("top-1 accuracy meets the BM25-only floor (≥80%)", () => {
    const hits = BENCHMARK.filter(({ intent, expected }) => topN(intent, 1)[0] === expected).length;
    const accuracy = hits / BENCHMARK.length;
    expect(
      accuracy,
      `got ${hits}/${BENCHMARK.length} correct @1 — intents are in routing-quality.test.ts`,
    ).toBeGreaterThanOrEqual(0.8);
  });

  // Sanity: every intent resolves to at least one candidate. Empty
  // result = BM25 tokenizer broke or the corpus is missing a field.
  it.each(BENCHMARK)("produces at least one match for: $intent", ({ intent }) => {
    expect(topN(intent, 5).length).toBeGreaterThan(0);
  });
});
