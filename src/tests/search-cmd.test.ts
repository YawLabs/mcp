import { describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { parseSearchArgs, runSearch } from "../search-cmd.js";

const CATALOG = [
  {
    slug: "postgres",
    name: "Postgres",
    description: "Run SQL queries against a Postgres database.",
    category: "data",
    tags: ["sql"],
    toolCount: 3,
    install: { command: "npx -y pg-mcp", runtime: "node" },
    requiredEnv: [{ key: "DATABASE_URL" }, { key: "PGPASSWORD" }],
  },
  {
    slug: "sqlite",
    name: "SQLite",
    description: "Query SQLite locally.",
    category: "data",
    tags: ["sql"],
    toolCount: 1,
    install: { command: "uvx mcp-server-sqlite", runtime: "python" },
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Issues and projects.",
    install: { runtime: "remote", url: "https://mcp.linear.app/mcp" },
  },
] as unknown as CatalogServer[];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

const fetchCatalog = async (): Promise<CatalogServer[]> => CATALOG;

describe("parseSearchArgs", () => {
  it("joins the positionals into one query", () => {
    const r = parseSearchArgs(["sql", "database"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.query).toBe("sql database");
  });

  it("accepts an empty query, which lists the catalog", () => {
    const r = parseSearchArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.query).toBe("");
  });

  it("parses the flags and rejects a bad limit", () => {
    const ok = parseSearchArgs(["sql", "--json", "--limit", "5", "--catalog", "https://x.test/c.json"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.options.json).toBe(true);
      expect(ok.options.limit).toBe(5);
      expect(ok.options.catalogUrl).toBe("https://x.test/c.json");
    }
    for (const bad of [["--limit", "0"], ["--limit", "abc"], ["--limit", "501"], ["--limit"]]) {
      const r = parseSearchArgs(bad);
      expect(r.ok, bad.join(" ")).toBe(false);
      if (!r.ok) expect(r.error).toContain("--limit requires");
    }
  });

  it("refuses a --catalog that would swallow the next flag as its value", () => {
    const r = parseSearchArgs(["--catalog", "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--catalog requires a URL");
  });

  it("reports help as a non-error the dispatcher can route to stdout", () => {
    const r = parseSearchArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help).toBe(true);
  });
});

describe("runSearch", () => {
  it("prints what each match needs before you add it", async () => {
    const cap = capture();
    const r = await runSearch({ query: "sql", fetchCatalog, env: {}, ...cap });
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    expect(text).toContain('2 matches for "sql":');
    expect(text).toContain("sqlite  (SQLite)");
    // The line that answers "what will this cost me": runtime, tool count, and
    // the credentials -- by NAME, which is the question `add` only answers by
    // refusing.
    expect(text).toContain("runtime node | 3 tools | needs DATABASE_URL, PGPASSWORD");
    expect(text).toContain("runtime python | 1 tool | no credentials");
    expect(text).toContain("Add one with `yaw-mcp add <slug>`.");
  });

  it("says a remote entry has to be added by hand", async () => {
    // `add` refuses a remote entry, so saying so here saves the round trip.
    const cap = capture();
    await runSearch({ query: "linear", fetchCatalog, env: {}, ...cap });
    expect(cap.text()).toContain("remote -- add by hand");
  });

  it("lists the whole catalog for an empty query", async () => {
    const cap = capture();
    await runSearch({ query: "", fetchCatalog, env: {}, ...cap });
    expect(cap.text()).toContain("3 servers in the Yaw MCP catalog:");
  });

  it("caps at the limit and says how to see the rest", async () => {
    const cap = capture();
    await runSearch({ query: "sql", limit: 1, fetchCatalog, env: {}, ...cap });
    expect(cap.text()).toContain("Showing 1 of 2; re-run with --limit 2 for the rest.");
  });

  it("exits 0 on no matches, and suggests a near miss", async () => {
    // Exit 0, not grep's 1: "nothing found" is an answer, and a non-zero code
    // would make a shell && chain treat a successful search as a failure.
    const cap = capture();
    const r = await runSearch({ query: "postgress", fetchCatalog, env: {}, ...cap });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toContain('No catalog server matches "postgress". Did you mean: postgres?');
  });

  it("omits the suggestion clause when there is nothing close", async () => {
    const cap = capture();
    await runSearch({ query: "zzzqqq", fetchCatalog, env: {}, ...cap });
    expect(cap.text()).toContain('No catalog server matches "zzzqqq".');
    expect(cap.text()).not.toContain("Did you mean");
    expect(cap.text()).toContain("Browse the full catalog");
  });

  it("emits JSON with the counts and the credential KEYS", async () => {
    const cap = capture();
    await runSearch({ query: "sql", json: true, limit: 1, fetchCatalog, env: {}, ...cap });
    const parsed = JSON.parse(cap.text());
    expect(parsed.query).toBe("sql");
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(2);
    expect(parsed.results[0].slug).toBe("sqlite");
    expect(parsed.results[0].requiredEnvKeys).toEqual([]);
  });

  it("reports a catalog fetch failure on stderr with exit 1", async () => {
    const cap = capture();
    const r = await runSearch({
      query: "sql",
      fetchCatalog: async () => {
        throw new Error("network down");
      },
      env: {},
      ...cap,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toContain("network down");
  });

  it("prefers --catalog over the environment", async () => {
    let seen = "";
    await runSearch({
      query: "sql",
      catalogUrl: "https://flag.test/c.json",
      env: { YAW_MCP_CATALOG_URL: "https://env.test/c.json" },
      fetchCatalog: async (url) => {
        seen = url;
        return CATALOG;
      },
      ...capture(),
    });
    expect(seen).toBe("https://flag.test/c.json");
  });

  it("falls back to the default catalog on a set-but-empty override", async () => {
    // The CI shape: `export YAW_MCP_CATALOG_URL=` is not nullish, so a bare ??
    // would hand fetch an empty string.
    let seen = "";
    await runSearch({
      query: "sql",
      env: { YAW_MCP_CATALOG_URL: "" },
      fetchCatalog: async (url) => {
        seen = url;
        return CATALOG;
      },
      ...capture(),
    });
    expect(seen).toBe("https://yaw.sh/data/mcp-catalog.json");
  });
});
