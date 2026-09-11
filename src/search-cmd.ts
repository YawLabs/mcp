// `yaw-mcp search [<text>...]` -- look through the public catalog without
// installing anything.
//
// WHY. `add` takes an exact slug and nothing else, so a user who does not
// already know the slug has two options: guess, or open a URL that is not
// clickable from a terminal. This prints what each match needs BEFORE the add,
// which is the question the add itself answers only by refusing.
//
// Read-only by design: it fetches the catalog and prints. `yaw-mcp add <slug>`
// is what writes, and the closing line says so, because a search that quietly
// installed would be a surprise in the wrong direction.

import { type CatalogServer, defaultFetchCatalog, type FetchCatalog, normalizeCatalogUrl } from "./catalog.js";
import { type CatalogMatch, matchCatalog, suggestCatalogSlugs } from "./catalog-search.js";
import { createStreamWriter } from "./logger.js";

export const SEARCH_USAGE = `Usage: yaw-mcp search [<text>...] [flags]

  Search the yaw.sh/mcp catalog -- slug, name, tags, category and description --
  and print what each match needs before you add it. With no <text>, lists the
  whole catalog. Nothing is written; \`yaw-mcp add <slug>\` is what installs one.

  --json            Emit the matches as JSON instead of the text listing.
  --limit <n>       Maximum matches to print (default 20, max 500).
  --catalog <url>   Override the catalog URL. Precedence: --catalog, then
                    $YAW_MCP_CATALOG_URL, then the public catalog.
`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
/** Long enough to tell two servers apart, short enough that ten results still
 *  fit on a screen. Truncation lands on a word boundary. */
const DESCRIPTION_CAP = 120;

export interface SearchCommandOptions {
  query?: string;
  json?: boolean;
  limit?: number;
  catalogUrl?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  fetchCatalog?: FetchCatalog;
}

export interface SearchCommandResult {
  exitCode: number;
}

export function parseSearchArgs(
  argv: string[],
): { ok: true; options: SearchCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SearchCommandOptions = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: SEARCH_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--catalog") {
      const v = argv[i + 1];
      // A missing value would otherwise swallow the next FLAG as the URL.
      if (v === undefined || v.startsWith("-"))
        return { ok: false, error: `--catalog requires a URL\n${SEARCH_USAGE}` };
      opts.catalogUrl = v;
      i++;
      continue;
    }
    if (a === "--limit") {
      const v = argv[i + 1];
      // Every rejection ECHOES what was rejected. One message for three
      // different mistakes ("--limit requires a positive integer (1-500)")
      // left the user comparing it against an argument they could no longer
      // see -- a typo'd `--limit 2O` and a forgotten value read identically,
      // and neither said which of the two had happened.
      if (v === undefined || v.startsWith("--")) {
        return {
          ok: false,
          error: `--limit needs a value: a whole number from 1 to ${MAX_LIMIT}${
            v === undefined ? ", and none followed it" : `, but the next argument is the flag "${v}"`
          }.\n${SEARCH_USAGE}`,
        };
      }
      const n = Number(v);
      if (!Number.isInteger(n)) {
        return {
          ok: false,
          error: `--limit requires a whole number from 1 to ${MAX_LIMIT}; got "${v}".\n${SEARCH_USAGE}`,
        };
      }
      if (n < 1 || n > MAX_LIMIT) {
        return { ok: false, error: `--limit requires a value from 1 to ${MAX_LIMIT}; got ${n}.\n${SEARCH_USAGE}` };
      }
      opts.limit = n;
      i++;
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${SEARCH_USAGE}` };
    words.push(a);
  }
  opts.query = words.join(" ");
  return { ok: true, options: opts };
}

/** Names, never values -- and the catalog holds no values anyway. */
function requiredEnvKeys(entry: CatalogServer): string[] {
  const raw = (entry as { requiredEnv?: unknown }).requiredEnv;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (typeof r === "string" ? r : (r as { key?: unknown } | null)?.key))
    .filter((k): k is string => typeof k === "string" && k !== "");
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const space = cut.lastIndexOf(" ");
  // A mid-word cut reads as corruption; back up to the last space when there
  // is one worth backing up to.
  return `${(space > cap * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** The one line that answers "what will this cost me to add?" */
function metaLine(entry: CatalogServer): string {
  const install = entry.install ?? {};
  const parts: string[] = [`runtime ${typeof install.runtime === "string" ? install.runtime : "unknown"}`];
  const toolCount = (entry as { toolCount?: unknown }).toolCount;
  if (typeof toolCount === "number") parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  const keys = requiredEnvKeys(entry);
  if (keys.length > 0) parts.push(`needs ${keys.join(", ")}`);
  else if ((entry as { requiresSetup?: unknown }).requiresSetup === true)
    parts.push("needs setup (no env keys listed)");
  else parts.push("no credentials");
  // `add` refuses a remote entry, so saying so here saves the round trip.
  const runtime = typeof install.runtime === "string" ? install.runtime.toLowerCase() : "";
  if (install.url || install.type === "remote" || /^(remote|https?|sse|url)$/.test(runtime)) {
    parts.push("remote -- add by hand");
  }
  return parts.join(" | ");
}

function renderJson(
  opts: SearchCommandOptions,
  catalogUrl: string,
  matches: CatalogMatch[],
  shown: CatalogMatch[],
  suggested: string[],
): string {
  return JSON.stringify(
    {
      query: opts.query ?? "",
      source: "catalog",
      catalogUrl,
      count: shown.length,
      total: matches.length,
      limit: opts.limit ?? DEFAULT_LIMIT,
      suggestedSlugs: suggested,
      results: shown.map(({ entry }) => ({
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        category: (entry as { category?: unknown }).category,
        tags: (entry as { tags?: unknown }).tags,
        runtime: entry.install?.runtime,
        command: entry.install?.command,
        requiredEnvKeys: requiredEnvKeys(entry),
        toolCount: (entry as { toolCount?: unknown }).toolCount,
        estimatedTokens: (entry as { estimatedTokens?: unknown }).estimatedTokens,
        repo: entry.repo,
      })),
    },
    null,
    2,
  );
}

export async function runSearch(opts: SearchCommandOptions): Promise<SearchCommandResult> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const env = opts.env ?? process.env;
  // Same precedence and the same set-but-empty handling as `add`: the fetcher
  // normalizes an empty override back to the default rather than fetching "".
  const catalogUrl = normalizeCatalogUrl(opts.catalogUrl ?? env.YAW_MCP_CATALOG_URL);
  const fetchCatalog = opts.fetchCatalog ?? defaultFetchCatalog;

  let servers: CatalogServer[];
  try {
    servers = await fetchCatalog(catalogUrl);
  } catch (e) {
    printErr(`yaw-mcp search: ${(e as Error).message}`);
    return { exitCode: 1 };
  }

  // A catalog that fetched fine and holds NOTHING is a source problem, not a
  // query problem, and the two used to share one message: with zero servers
  // every query misses, so `yaw-mcp search postgres` answered `No catalog
  // server matches "postgres"` -- and a bare `yaw-mcp search` answered `No
  // catalog server matches ""`, which reads like a bug in the tool. Reported
  // the way a fetch failure is (stderr, exit 1) because it is the same class
  // of thing: the source could not answer, so there is no result to pipe.
  // That also keeps --json honest -- it prints no body for an unusable
  // source, exactly as it already does when the fetch itself fails.
  if (servers.length === 0) {
    printErr(
      `yaw-mcp search: the Yaw MCP catalog at ${catalogUrl} loaded, but lists no servers at all -- there is nothing to search.`,
    );
    printErr(
      "Check the --catalog value or $YAW_MCP_CATALOG_URL if you set one; otherwise the published catalog is empty right now, so try again later.",
    );
    return { exitCode: 1 };
  }

  const query = opts.query ?? "";
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const matches = matchCatalog(query, servers);
  const shown = matches.slice(0, limit);

  if (opts.json) {
    print(
      renderJson(opts, catalogUrl, matches, shown, matches.length === 0 ? suggestCatalogSlugs(query, servers, 3) : []),
    );
    return { exitCode: 0 };
  }

  if (matches.length === 0) {
    // Exit 0, not grep's 1: this matches `list`'s empty state. "Nothing found"
    // is an answer, and a non-zero code would make a shell `&&` chain treat a
    // successful search as a failure.
    const near = suggestCatalogSlugs(query, servers, 3);
    print(
      near.length > 0
        ? `No catalog server matches "${query}". Did you mean: ${near.join(", ")}?`
        : `No catalog server matches "${query}".`,
    );
    print("Browse the full catalog at https://yaw.sh/mcp/catalog/, or re-run with fewer words.");
    return { exitCode: 0 };
  }

  print(
    query === ""
      ? `${matches.length} ${matches.length === 1 ? "server" : "servers"} in the Yaw MCP catalog:`
      : `${matches.length} ${matches.length === 1 ? "match" : "matches"} for "${query}":`,
  );
  print();
  for (const { entry } of shown) {
    print(`${entry.slug}  (${entry.name ?? entry.slug})`);
    if (typeof entry.description === "string" && entry.description !== "") {
      print(`  ${truncate(entry.description, DESCRIPTION_CAP)}`);
    }
    print(`  ${metaLine(entry)}`);
    print();
  }
  if (shown.length < matches.length) {
    // The footer is an instruction, so every number it names has to be one the
    // parser accepts -- and `--limit` is capped at MAX_LIMIT. Past the cap no
    // --limit shows the rest, so offer narrowing instead of a command that is
    // guaranteed to exit 2.
    const rest =
      matches.length <= MAX_LIMIT
        ? `re-run with --limit ${matches.length} for the rest.`
        : `--limit tops out at ${MAX_LIMIT}, so add more words to narrow it (or browse https://yaw.sh/mcp/catalog/).`;
    print(`Showing ${shown.length} of ${matches.length}; ${rest}`);
  }
  print("Add one with `yaw-mcp add <slug>`.");
  return { exitCode: 0 };
}
