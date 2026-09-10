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

// A malformed third-party entry sitting next to a well-formed one. Both of the
// junk fields are the wrong type -- `tags` a bare string where an array was
// expected, `category` a number -- which is exactly the shape tagsOf and
// categoryOf read defensively for.
const WRONG_TYPES = [
  { slug: "ok", name: "OK", description: "fine", tags: "notanarray", category: 42 },
  { slug: "good", name: "Good", description: "real", tags: ["notanarray"], category: "data" },
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

  it("reads tags defensively on a query that cannot match the slug or the name", () => {
    // Guards the Array.isArray read in tagsOf. The test above queries "ok",
    // which tierFor answers on its FIRST line (token === slug) and returns
    // from before tags is ever touched -- so it proves nothing about this arm.
    // A token carried only by a well-formed entry's TAG forces tierFor past
    // the slug and name arms and into tagsOf on the entry whose `tags` is a
    // bare string, where an unguarded .filter throws mid-search.
    expect(matchCatalog("notanarray", WRONG_TYPES).map((m) => [m.entry.slug, m.tier])).toEqual([["good", 2]]);
  });

  it("reads category defensively on a query that cannot match the slug or the name", () => {
    // Same shape one arm further down, for the string guard in categoryOf: the
    // malformed entry's tags read to [] so the category arm actually runs, and
    // `category: 42` reaching .toLowerCase() unguarded throws. The well-formed
    // entry still has to come back at tier 2 -- a search must not be taken out
    // by a neighbouring entry's bad field.
    expect(matchCatalog("data", WRONG_TYPES).map((m) => [m.entry.slug, m.tier])).toEqual([["good", 2]]);
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

  it("sanitises the slug list before handing it to the typo fallback", () => {
    // This is the did-you-mean path `add` takes on a miss, against catalog
    // JSON nobody validated, on an ERROR path -- the worst possible place to
    // throw. closestNames lowercases every candidate it is given, so a null
    // entry, a slug-less entry or a numeric slug reaching it would replace the
    // friendly no-such-slug message with a stack trace.
    const junk = [
      null,
      { name: "no slug" },
      { slug: 7, name: "Seven" },
      { slug: "postgres", name: "Postgres", description: "Run SQL queries." },
    ] as unknown as CatalogServer[];
    expect(suggestCatalogSlugs("postgress", junk, 3)).toEqual(["postgres"]);
    // And with nothing left once the junk is filtered out, still an empty list
    // rather than a throw.
    expect(suggestCatalogSlugs("postgress", junk.slice(0, 3), 3)).toEqual([]);
  });
});
