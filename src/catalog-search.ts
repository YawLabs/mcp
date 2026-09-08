// Matching the public catalog by free text, and suggesting a slug when an
// exact one missed.
//
// Pure: no I/O, no fetch, no clock. The caller supplies the entries, which is
// what lets `add`'s did-you-mean reuse the catalog it ALREADY fetched rather
// than paying for a second round trip on the error path.
//
// The type import from catalog.js is type-only on purpose, so catalog.ts can
// import this module back without a runtime cycle.

import type { CatalogServer } from "./catalog.js";
import { closestNames } from "./fuzzy.js";

/** A catalog entry and how well it matched. Lower is better. */
export interface CatalogMatch {
  entry: CatalogServer;
  /** 0 exact slug/name, 1 prefix, 2 substring/tag/category, 3 description. */
  tier: 0 | 1 | 2 | 3;
}

/** Extra fields the live catalog carries that CatalogServer does not declare.
 *  Read defensively -- this is third-party JSON, and a `tags: "web"` string
 *  where an array was expected must not throw inside a search. */
interface CatalogExtras {
  category?: unknown;
  tags?: unknown;
  toolCount?: unknown;
  estimatedTokens?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const tagsOf = (entry: CatalogServer): string[] => {
  const raw = (entry as CatalogServer & CatalogExtras).tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
};

const categoryOf = (entry: CatalogServer): string | undefined => str((entry as CatalogServer & CatalogExtras).category);

/** Where one token matched an entry, or null if it did not. First hit wins,
 *  so a slug match never degrades to a description match. */
function tierFor(token: string, entry: CatalogServer): 0 | 1 | 2 | 3 | null {
  const slug = entry.slug.toLowerCase();
  const name = (str(entry.name) ?? "").toLowerCase();
  if (token === slug || (name !== "" && token === name)) return 0;
  if (slug.startsWith(token) || (name !== "" && name.startsWith(token))) return 1;
  if (slug.includes(token) || (name !== "" && name.includes(token))) return 2;
  if (tagsOf(entry).some((t) => t.toLowerCase() === token)) return 2;
  if ((categoryOf(entry) ?? "").toLowerCase() === token) return 2;
  if ((str(entry.description) ?? "").toLowerCase().includes(token)) return 3;
  return null;
}

/** Entries matching EVERY token in `query`, best tier first.
 *
 *  AND rather than OR: `sql postgres` should narrow, and an OR would make
 *  every extra word widen the result set, which is the opposite of what
 *  typing more words means. An entry's tier is the WORST of its tokens --
 *  matching one token exactly and another only in prose is a prose match. */
export function matchCatalog(query: string, servers: readonly CatalogServer[]): CatalogMatch[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "");

  const matches: CatalogMatch[] = [];
  for (const entry of servers) {
    if (typeof entry?.slug !== "string" || entry.slug === "") continue;
    // No tokens is not "no matches": a bare `search` lists the catalog.
    if (tokens.length === 0) {
      matches.push({ entry, tier: 0 });
      continue;
    }
    let worst: 0 | 1 | 2 | 3 = 0;
    let all = true;
    for (const token of tokens) {
      const tier = tierFor(token, entry);
      if (tier === null) {
        all = false;
        break;
      }
      if (tier > worst) worst = tier;
    }
    if (all) matches.push({ entry, tier: worst });
  }

  matches.sort((a, b) => a.tier - b.tier || a.entry.slug.localeCompare(b.entry.slug));
  return matches;
}

/** Slugs to offer after an exact lookup missed.
 *
 *  Real matches first, capped at `limit`. Description-tier hits are excluded:
 *  a server whose prose happens to mention the word is not a plausible
 *  correction for a slug the user typed.
 *
 *  The typo fallback runs ONLY when nothing matched, deliberately not as a
 *  union. Merging the two lists surfaces edit-distance noise beside real hits
 *  -- `k8s` is two edits from `aws`, so a union would suggest AWS to someone
 *  who typed Kubernetes, next to the answer they actually wanted. */
export function suggestCatalogSlugs(query: string, servers: readonly CatalogServer[], limit: number): string[] {
  if (limit <= 0) return [];
  const matched = matchCatalog(query, servers)
    .filter((m) => m.tier <= 2)
    .map((m) => m.entry.slug)
    .slice(0, limit);
  if (matched.length > 0) return matched;
  const slugs = servers.map((s) => s?.slug).filter((s): s is string => typeof s === "string" && s !== "");
  return closestNames(query, slugs, limit);
}
