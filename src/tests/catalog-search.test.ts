import { describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { matchCatalog, suggestCatalogSlugs } from "../catalog-search.js";

const CATALOG = [
  {
    slug: "postgres",
    name: "Postgres",
    description: "Run SQL queries against a Postgres database.",
    category: "data",
    tags: ["sql", "database"],
  },
  {
    slug: "sqlite",
    name: "SQLite",
    description: "Query and explore SQLite databases locally.",
    category: "data",
    tags: ["sql", "local"],
  },
  {
    slug: "github",
    name: "GitHub",
    description: "Repos, issues and pull requests.",
    category: "dev",
    tags: ["git", "code"],
  },
  {
    slug: "notion",
    name: "Notion",
    description: "Pages and databases in Notion.",
    category: "docs",
    tags: ["notes"],
  },
] as unknown as CatalogServer[];

const slugs = (q: string): string[] => matchCatalog(q, CATALOG).map((m) => m.entry.slug);

describe("matchCatalog", () => {
  it("ranks an exact slug above a prefix, a substring and a description mention", () => {
    // The tier order is the whole point: a server whose prose happens to
    // contain the word must never outrank the one actually named by it.
    const withProse = [
      ...CATALOG,
      { slug: "zzz", name: "Zed", description: "talks to postgres sometimes" },
    ] as unknown as CatalogServer[];
    expect(matchCatalog("postgres", withProse).map((m) => [m.entry.slug, m.tier])).toEqual([
      ["postgres", 0],
      ["zzz", 3],
    ]);
  });

  it("matches a tag and a category at the same tier as a substring", () => {
    // sqlite is a slug PREFIX hit (tier 1) and postgres only carries "sql"
    // as a tag (tier 2), so the prefix sorts first -- that ordering is what
    // the tiers exist to produce.
    expect(slugs("sql")).toEqual(["sqlite", "postgres"]);
    expect(slugs("docs")).toEqual(["notion"]);
  });

  it("ANDs multiple tokens, so more words narrow rather than widen", () => {
    // An OR would make every extra word grow the result set, which is the
    // opposite of what typing more words means.
    expect(slugs("sql local")).toEqual(["sqlite"]);
    expect(slugs("sql git")).toEqual([]);
  });

  it("takes the WORST tier across tokens", () => {
    // "postgres" is an exact slug on the postgres entry, "queries" only
    // appears in its prose -- so the whole match is a prose match.
    const m = matchCatalog("postgres queries", CATALOG);
    expect(m).toHaveLength(1);
    expect(m[0].tier).toBe(3);
  });

  it("lists everything for an empty query", () => {
    // A bare `yaw-mcp search` is a catalog listing, not zero results.
    expect(matchCatalog("", CATALOG)).toHaveLength(CATALOG.length);
    expect(matchCatalog("   ", CATALOG)).toHaveLength(CATALOG.length);
  });

  it("is case-insensitive and sorts ties by slug", () => {
    expect(slugs("SQL")).toEqual(["sqlite", "postgres"]);
  });

  it("survives a catalog entry with the wrong types", () => {
    // Third-party JSON: a `tags: "web"` string where an array was expected
    // must not throw inside a search.
    const junk = [
      { slug: "ok", name: "OK", description: "fine", tags: "notanarray", category: 42 },
      { slug: 7 },
      null,
      { name: "no slug" },
    ] as unknown as CatalogServer[];
    expect(matchCatalog("ok", junk).map((m) => m.entry.slug)).toEqual(["ok"]);
  });
});

describe("suggestCatalogSlugs", () => {
  it("suggests a real match before reaching for edit distance", () => {
    expect(suggestCatalogSlugs("postgres", CATALOG, 3)).toEqual(["postgres"]);
  });

  it("falls back to a near-miss when nothing matched", () => {
    expect(suggestCatalogSlugs("postgress", CATALOG, 3)).toEqual(["postgres"]);
  });

  it("never mixes edit-distance noise in beside real matches", () => {
    // The reason the fallback is exclusive rather than a union: a union puts
    // an unrelated two-edit neighbour next to the answer the user wanted, and
    // a wrong suggestion beside a right one is worse than one alone.
    const many = [...CATALOG, { slug: "sqs", name: "SQS", description: "queues" }] as unknown as CatalogServer[];
    // "sqs" is one edit from "sql", so the typo fallback WOULD offer it -- but
    // real matches exist, so the fallback never runs.
    const out = suggestCatalogSlugs("sql", many, 5);
    expect(out).toEqual(["sqlite", "postgres"]);
    expect(out).not.toContain("sqs");
  });

  it("does not suggest a server that only mentions the word in prose", () => {
    // A description hit is not a plausible correction for a slug someone
    // typed -- they were naming a server, not describing one.
    const prose = [{ slug: "zzz", name: "Zed", description: "talks to postgres" }] as unknown as CatalogServer[];
    expect(suggestCatalogSlugs("postgres", prose, 3)).toEqual([]);
  });

  it("respects the limit, and returns nothing for a limit of zero", () => {
    expect(suggestCatalogSlugs("sql", CATALOG, 1)).toEqual(["sqlite"]);
    expect(suggestCatalogSlugs("sql", CATALOG, 0)).toEqual([]);
  });
});
