// Shared catalog resolver. Resolves a catalog slug to a concrete launch
// shape (command + args + required env keys) from the SAME static catalog
// the yaw.sh website and the Yaw Terminal app read:
//
//     https://yaw.sh/data/mcp-catalog.json
//
// Why one source: the website catalog page emits "Add to Yaw MCP" buttons
// carrying a `slug`, and both the Yaw Terminal app (yaw-install-handler.ts
// resolveSlug) and this CLI must accept the EXACT same slug set, or a button
// that works in the app silently fails in the CLI fallback. Keeping all three
// pointed at one static file is what guarantees slug parity.
//
// Both `yaw-mcp add <slug>` and `yaw-mcp try <slug>` resolve through here, so
// a catalog shape change is fixed in one place.

const DEFAULT_CATALOG_URL = "https://yaw.sh/data/mcp-catalog.json";
const FETCH_TIMEOUT_MS = 10_000;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A single required-env descriptor as the catalog stores it. */
export interface CatalogRequiredEnv {
  key: string;
  label?: string;
  placeholder?: string;
  docsUrl?: string;
}

/** A raw catalog server entry (only the fields this resolver reads). */
export interface CatalogServer {
  slug: string;
  name?: string;
  description?: string;
  install?: { command?: string; runtime?: string; url?: string; type?: string };
  requiredEnv?: CatalogRequiredEnv[];
  repo?: string;
  homepage?: string;
}

/** The resolved launch shape `add`/`try` consume. command + args are split
 *  from the catalog's single `install.command` launch line via tokenizeCommand. */
export interface ResolvedCatalogServer {
  slug: string;
  name: string;
  command: string;
  args: string[];
  /** Names (not values) of env vars the server needs. */
  requiredEnvKeys: string[];
  description?: string;
  source?: string;
  docUrl?: string;
}

export type FetchCatalog = (url: string) => Promise<CatalogServer[]>;

/**
 * Quote-aware split of a catalog `install.command` launch line into
 * command + argv. The catalog stores the whole line as one string
 * (e.g. `npx -y @yawlabs/aws-mcp`, or `docker run -i --rm -e FOO ghcr.io/...`),
 * but a bundles.json entry needs command and args separate. Mirror of the
 * app's tokenizeCommand (yaw-install-handler.ts) and the website's
 * (catalog/index.html), so all three produce identical splits.
 */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote !== null) {
    throw new Error(`Unbalanced quote in command: ${cmd}`);
  }
  if (has) out.push(cur);
  return out;
}

/** Fetch + shape-validate the catalog. Bounded by FETCH_TIMEOUT_MS. Throws a
 *  friendly Error on network / parse / shape failure. Injectable for tests. */
export async function defaultFetchCatalog(url: string = DEFAULT_CATALOG_URL): Promise<CatalogServer[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`the Yaw MCP catalog at ${url} returned HTTP ${res.status}.`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out fetching the Yaw MCP catalog at ${url}.`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
  const servers = (body as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(servers)) {
    throw new Error(`the Yaw MCP catalog at ${url} was not in the expected shape.`);
  }
  return servers.filter(
    (s): s is CatalogServer => typeof s === "object" && s !== null && typeof (s as CatalogServer).slug === "string",
  );
}

/**
 * Resolve a catalog slug to a concrete launch shape. Refuses remote/HTTP
 * servers (they have no stdio spawn command) the same way the app's
 * resolveSlug does. Throws a friendly Error on miss / remote / empty command.
 */
export async function resolveCatalogSlug(
  slug: string,
  opts: { catalogUrl?: string; fetchCatalog?: FetchCatalog } = {},
): Promise<ResolvedCatalogServer> {
  const url = opts.catalogUrl ?? DEFAULT_CATALOG_URL;
  const fetchCatalog = opts.fetchCatalog ?? defaultFetchCatalog;
  const servers = await fetchCatalog(url);
  const entry = servers.find((s) => s.slug === slug);
  if (!entry) {
    throw new Error(
      `no server with slug "${slug}" in the Yaw MCP catalog. Browse https://yaw.sh/mcp/catalog/ for the list.`,
    );
  }

  const install = entry.install ?? {};
  const runtime = typeof install.runtime === "string" ? install.runtime.toLowerCase() : "";
  // A remote/HTTP server has no stdio spawn command; refuse rather than
  // tokenize a URL into a broken entry. Matches the app's resolveSlug.
  if (install.url || install.type === "remote" || /^(remote|https?|sse|url)$/.test(runtime)) {
    throw new Error(`"${slug}" is a remote server -- add it from the Yaw MCP dashboard, not the local CLI.`);
  }
  const cmdStr = typeof install.command === "string" ? install.command.trim() : "";
  if (!cmdStr) {
    throw new Error(`catalog entry "${slug}" has no install command.`);
  }
  const tokens = tokenizeCommand(cmdStr);
  if (tokens.length === 0) {
    throw new Error(`catalog entry "${slug}" install command was empty.`);
  }
  const [command, ...args] = tokens;

  const requiredEnvKeys = Array.isArray(entry.requiredEnv)
    ? entry.requiredEnv
        .map((e) => (e && typeof e === "object" ? e.key : undefined))
        .filter((k): k is string => typeof k === "string" && ENV_KEY_RE.test(k))
    : [];

  const source =
    typeof entry.repo === "string" ? entry.repo : typeof entry.homepage === "string" ? entry.homepage : undefined;
  return {
    slug,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : slug,
    command,
    args,
    requiredEnvKeys,
    description: typeof entry.description === "string" ? entry.description : undefined,
    source,
    docUrl: source,
  };
}

export { DEFAULT_CATALOG_URL };
