// Static registry: which MCP server namespaces shadow which local CLIs.
//
// Used by:
//   - discover: surface "this server shadows `<cli>`" per candidate
//   - guide: auto-generated "Installed servers" section appended to YAW-MCP.md
//   - doctor: scan shell history for shadowed-CLI invocations
//
// Written against the yaw.sh/mcp Explore catalog, so a user who imports a
// covered server with the default namespace gets the hint with no
// configuration -- but it does NOT cover the whole catalog. Measured
// 2026-11-11 against https://yaw.sh/data/mcp-catalog.json (generated
// 2026-10-16, 85 servers): 23 rows derive a namespace with no key here (35
// before the rows for docker, mysql, redis x2, bigquery, azure, digitalocean,
// vault, consul, terraform-cwd, ansible and salesforce). The 23 are left out on
// purpose: none clearly wraps one well-known CLI. Most are API services with no
// CLI to prefer over (datadog, zendesk, asana, pinecone, ...); a few have a CLI
// the server does not clearly stand in for (HashiCorp's terraform server works
// against the Registry and HCP, not a working directory; clickhouse's client
// binary has two spellings; databricks, snowflake and huggingface overlap their
// vendor CLI only in part). auth0 was checked on 2026-11-11 against the tool
// list in @auth0/auth0-mcp-server's README: applications, resource servers,
// Actions (incl. deploy), logs and forms, but NO user tools -- and `auth0
// users` is a main reason an agent runs the CLI -- so it stays unregistered.
// (salesforce was decided the same way and DID qualify; see its row.) None of
// these carries the EMPTY entry described below either. An unregistered
// namespace falls through to the tool-name heuristic, which can only ever
// answer with a CLI named in KNOWN_CLI_PREFIXES.
// Nothing ENFORCES coverage either: the catalog is generated outside this
// repo, no slug list is vendored here, and no test diffs the two -- so
// re-measure against the live catalog before relying on any count here.
// Namespace keys are lowercased at lookup time.
//
// CLI-name lookups are NOT case-normalized here. Both CLI-keyed tables below
// (the cliToNamespaces reverse index and SHADOW_INSTALL_TARGETS) are keyed by
// bare, already-lowercase binary names and matched exactly, so the CALLER
// lowercases before it looks up. doctor's extractLeadingBinary is that caller
// and does exactly that: it strips path, wrapper and `.exe`/`.cmd` decoration
// and lowercases the result, because a PowerShell history line reading
// `NPM.CMD audit` matches nothing otherwise.
//
// A multi-word catalog slug needs TWO keys when it actually shadows something,
// and both are registered below. The forward lookup is keyed on a real
// namespace, and every namespace that reaches it passed NAMESPACE_RE
// (^[a-z][a-z0-9_]{0,29}$) -- so a hyphen or a leading digit is impossible
// there. deriveNamespace (local-bundles.ts) is what an import actually lands
// on, and it strips non-alphanumerics: "AWS API" -> `awsapi`, "1Password" ->
// `s1password`. The hyphenated/leading-digit form is still the CATALOG SLUG the
// user types into `yaw-mcp add`, and it is what cliToNamespaces reports back
// through doctor, so it stays; the derived form is what makes the shadow hint
// actually fire.
//
// An EMPTY entry gets only ONE key, the derived form. The hyphenated twin of an
// EMPTY entry is dead on both paths -- resolveShadowedClis can never be handed a
// hyphen, and an empty shadow list contributes nothing to the reverse index --
// so `aws-knowledge`, `aws-pricing`, `google-workspace`, `google-maps`,
// `brave-search` and `sequential-thinking` are registered under their derived
// spelling alone. Don't add a hyphenated twin for a new EMPTY entry.
//
// Well-known alias namespaces (gh, k8s, pg, …) are also registered so
// a user who renamed the server on import still matches. A custom
// namespace falls through to a tool-name heuristic (shared lowercase
// prefix across three or more tool-cache entries, prefix must be in
// KNOWN_CLI_PREFIXES); getProfiledActiveServers merges the in-memory
// toolCache so this fires for any server with learned/persisted tools.

import type { UpstreamServerConfig } from "./types.js";

export interface CliShadow {
  /** The local CLI this server shadows (e.g. "npm", "tailscale"). */
  cli: string;
  /** Optional subset of subcommands the server specifically covers.
   *  Undefined means "the CLI's read/admin surface generally". */
  subcommands?: string[];
}

// Empty array means "known MCP server, nothing useful to shadow" —
// e.g. API-only services (Notion, Firecrawl, Linear) with no
// widely-used CLI. Declaring them explicitly keeps the heuristic from
// inferring a wrong shadow from the tool-name prefix.
const EMPTY: readonly CliShadow[] = [];

// Namespace → shadowed CLI(s). Keys are catalog slugs (not all of them;
// see the coverage note in the header) plus common aliases. Subcommand lists are only filled in where the MCP
// server meaningfully restricts itself to a subset (e.g. npmjs is a
// read/admin-only surface, not `npm install`).
const NAMESPACE_REGISTRY: Record<string, readonly CliShadow[]> = {
  // —— Dev / code —————————————————————————————————————————————
  github: [{ cli: "gh" }],
  gh: [{ cli: "gh" }],
  gitlab: [{ cli: "glab" }],
  glab: [{ cli: "glab" }],
  ssh: [{ cli: "ssh" }, { cli: "scp" }],
  playwright: [{ cli: "playwright" }],
  puppeteer: EMPTY,
  electron: EMPTY,
  sentry: [{ cli: "sentry-cli" }],
  docker: [{ cli: "docker" }],

  // —— npm / package registries ——————————————————————————————————
  npmjs: [
    {
      cli: "npm",
      subcommands: ["search", "view", "info", "audit", "owner", "deprecate", "dist-tag", "whoami", "profile", "token"],
    },
  ],
  npm: [
    {
      cli: "npm",
      subcommands: ["search", "view", "audit", "owner", "deprecate", "dist-tag"],
    },
  ],

  // —— Databases ——————————————————————————————————————————————
  postgres: [{ cli: "psql" }, { cli: "pg_dump" }],
  pg: [{ cli: "psql" }, { cli: "pg_dump" }],
  sqlite: [{ cli: "sqlite3" }],
  mongodb: [{ cli: "mongosh" }, { cli: "mongodump" }],
  mongo: [{ cli: "mongosh" }],
  supabase: [{ cli: "supabase" }],
  mysql: [{ cli: "mysql" }],
  // Two catalog servers derive `redis` (Redis's own and @yawlabs/redis-mcp,
  // both named "Redis"); `redis-yawlabs` is the second one's slug.
  redis: [{ cli: "redis-cli" }],
  "redis-yawlabs": [{ cli: "redis-cli" }],
  bigquery: [{ cli: "bq", subcommands: ["query", "ls", "show"] }],
  bq: [{ cli: "bq", subcommands: ["query", "ls", "show"] }],

  // —— Infra / ops ————————————————————————————————————————————
  tailscale: [{ cli: "tailscale" }],
  kubernetes: [{ cli: "kubectl" }],
  kubectl: [{ cli: "kubectl" }],
  k8s: [{ cli: "kubectl" }],
  caddy: [{ cli: "caddy" }],
  cloudflare: [{ cli: "wrangler" }],
  wrangler: [{ cli: "wrangler" }],
  vercel: [{ cli: "vercel" }],
  "aws-api": [{ cli: "aws" }],
  awsapi: [{ cli: "aws" }],
  aws: [{ cli: "aws" }],
  awsknowledge: EMPTY,
  awspricing: EMPTY,
  grafana: EMPTY,
  azure: [{ cli: "az" }],
  az: [{ cli: "az" }],
  digitalocean: [{ cli: "doctl" }],
  doctl: [{ cli: "doctl" }],
  vault: [{ cli: "vault" }],
  consul: [{ cli: "consul" }],
  // terraform-cwd answers what these read-only subcommands would (`state
  // list`, `show -json`, `providers schema -json`); it never plans or applies. HashiCorp's own `terraform`
  // server is deliberately absent: per its catalog entry it searches the
  // Registry and drives HCP Terraform workspaces and runs over the API, not a
  // local working directory, so which `terraform` call it replaces is unclear.
  "terraform-cwd": [{ cli: "terraform", subcommands: ["state", "show", "providers"] }],
  terraformcwd: [{ cli: "terraform", subcommands: ["state", "show", "providers"] }],
  ansible: [{ cli: "ansible-doc" }, { cli: "ansible-inventory" }, { cli: "ansible-config" }],

  // —— YawLabs tools —————————————————————————————————————————
  ctxlint: [{ cli: "ctxlint" }],
  "mcp-compliance": [{ cli: "mcp-compliance" }],
  mcpcompliance: [{ cli: "mcp-compliance" }],

  // —— Data / observability —————————————————————————————————————
  posthog: EMPTY,
  honeycomb: EMPTY,

  // —— Payments / commerce ——————————————————————————————————————
  stripe: [{ cli: "stripe" }],
  shopify: [{ cli: "shopify" }],
  lemonsqueezy: EMPTY,
  hubspot: EMPTY,

  // —— Comms / productivity ——————————————————————————————————————
  slack: [{ cli: "slack" }],
  discord: EMPTY,
  twilio: [{ cli: "twilio" }],
  elevenlabs: EMPTY,
  notion: EMPTY,
  linear: EMPTY,
  figma: EMPTY,
  atlassian: EMPTY,
  airtable: EMPTY,
  obsidian: EMPTY,
  googleworkspace: EMPTY,
  googlemaps: EMPTY,
  // The catalog's salesforce server (@tsmztech/mcp-server-salesforce) runs SOQL
  // and aggregate queries, record DML, object describe/search and Apex
  // read/write/execute-anonymous -- the `sf data`, `sf sobject` and `sf apex`
  // work an agent shells out for. It has no project deploy/retrieve and no org
  // login, hence the subcommand list.
  salesforce: [{ cli: "sf", subcommands: ["data", "sobject", "apex"] }],
  sf: [{ cli: "sf", subcommands: ["data", "sobject", "apex"] }],

  // —— Search / web —————————————————————————————————————————————
  bravesearch: EMPTY,
  firecrawl: EMPTY,
  exa: EMPTY,
  fetch: [{ cli: "curl" }, { cli: "wget" }],

  // —— Filesystem / local tools ——————————————————————————————————
  filesystem: EMPTY,
  memory: EMPTY,
  sequentialthinking: EMPTY,
  time: EMPTY,
  context7: EMPTY,

  // —— Identity / secrets ————————————————————————————————————————
  // "1Password" cannot BE a namespace (NAMESPACE_RE bars the leading digit);
  // deriveNamespace 's'-prefixes it, so s1password is the one that ever matches.
  "1password": [{ cli: "op" }],
  s1password: [{ cli: "op" }],
  op: [{ cli: "op" }],
};

// Prefixes the tool-name heuristic will trust. A tool cache whose
// entries all share one of these as their first segment is treated as
// shadowing that CLI. Intentionally narrow: broad prefixes ("get",
// "set", "list") would generate false positives.
//
// Heuristic reach: requires a non-empty `toolCache` on the server object
// handed to resolveShadowedClis. bundles.json doesn't carry one
// (local-bundles.ts validateEntry returns a fixed whitelist that drops
// the field), so the only way the heuristic fires is when a callsite
// merges in the in-memory cache (ConnectServer.toolCache, hydrated from
// state.json at startup and updated as servers activate). getProfiledActiveServers
// does that merge so discover + guide see learned tools; a server with no
// learned/persisted tools for its namespace still falls through to [].
//
// Keyed by tool-name prefix, valued by the CLI binary the hint names. The two
// differ only where the word a server puts on its tools is not the executable:
// Redis tools read `redis_get`, but the binary is `redis-cli` (there is no
// `redis` executable), so the heuristic used to answer `cli: "redis"`. Every
// value below is a real executable name; most are their own prefix.
const KNOWN_CLI_PREFIXES = new Map<string, string>([
  ["npm", "npm"],
  ["tailscale", "tailscale"],
  ["gh", "gh"],
  ["aws", "aws"],
  ["kubectl", "kubectl"],
  ["docker", "docker"],
  ["psql", "psql"],
  ["mongosh", "mongosh"],
  ["redis", "redis-cli"],
  ["stripe", "stripe"],
  ["heroku", "heroku"],
  ["supabase", "supabase"],
  ["flyctl", "flyctl"],
  ["shopify", "shopify"],
  ["vercel", "vercel"],
  ["wrangler", "wrangler"],
  ["twilio", "twilio"],
  ["caddy", "caddy"],
  ["playwright", "playwright"],
  ["sqlite3", "sqlite3"],
  ["glab", "glab"],
  ["op", "op"],
]);

export function resolveShadowedClis(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): CliShadow[] {
  // Object.hasOwn, not a bare index: `namespace` comes from bundles.json and
  // NAMESPACE_RE (local-bundles.ts) accepts `constructor`, `toString`,
  // `valueOf` -- all real inherited properties. A bare lookup returned
  // Object.prototype.constructor (a function, not undefined), so the copy below
  // threw ("direct is not iterable", back when it was a spread) inside
  // discover's output builder (server.ts formatShadowLine, no try/catch) and
  // took the whole tool call down instead of degrading to "shadows nothing".
  const key = server.namespace.toLowerCase();
  const direct = Object.hasOwn(NAMESPACE_REGISTRY, key) ? NAMESPACE_REGISTRY[key] : undefined;
  // DEEP copy, not `[...direct]`: a shallow spread hands out the registry's own
  // CliShadow objects and their `subcommands` arrays, so a caller that sorted or
  // pushed onto `shadows[0].subcommands` (formatShadowLine's callers own the
  // value they get back) would edit process-wide module state for every later
  // lookup. Fresh objects and fresh subcommand arrays give the isolation the
  // cliToNamespaces docblock below claims for its own copy.
  if (direct !== undefined) {
    return direct.map((s) => (s.subcommands ? { ...s, subcommands: [...s.subcommands] } : { ...s }));
  }

  // Heuristic fallback — look for a single common lowercase prefix
  // across the tool cache. Needs at least three tools to trust it; a
  // server with one or two tools could share a prefix by coincidence.
  //
  // Reachable in production via getProfiledActiveServers' toolCache merge
  // for any server with persisted/learned tools; see KNOWN_CLI_PREFIXES above.
  const cache = server.toolCache ?? [];
  if (cache.length < 3) return [];
  const prefixes = new Set<string>();
  // The `if (first)` guard drops any tool whose FIRST segment is empty:
  // a fully empty name (`""` splits to `[""]`) or a separator-leading one
  // (`_meta` splits to `["", "meta"]`). Without it, a cache mixing one
  // such degenerate entry with real prefixes would collect `""` alongside
  // the real prefix and fail the `size !== 1` test, matching nothing.
  for (const t of cache) {
    const first = t.name.split(/[_.-]/)[0];
    if (first) prefixes.add(first.toLowerCase());
  }
  if (prefixes.size !== 1) return [];
  const cli = KNOWN_CLI_PREFIXES.get([...prefixes][0]);
  return cli === undefined ? [] : [{ cli }];
}

// There is deliberately no `shadowedCliNames(server)` helper. One existed
// as a "flatten resolveShadowedClis to bare CLI names" convenience and
// claimed the doctor shell-history scan as its consumer, but doctor never
// called it: scanShellHistoryForShadows (doctor-cmd.ts) matches on the
// REVERSE index below, keyed by CLI binary name, because it starts from a
// history line rather than from a server. The wrapper's only importer was
// its own test. If a caller ever does want bare names, inline
// `resolveShadowedClis(server).map((s) => s.cli)` at the callsite rather
// than reviving an export whose sole user is a test.

/** Reverse index: CLI binary name → namespaces that shadow it. Built
 *  lazily from NAMESPACE_REGISTRY. Used by doctor's shell-history scan
 *  so a bash line starting with `npm` can be pointed back at the
 *  `npmjs` MCP server (and vice versa).
 *
 *  Returns a FRESH Map with fresh inner arrays on every call. The lazily
 *  built index is process-wide module state, so handing it out directly let
 *  any caller corrupt the registry view for every later caller -- and one
 *  already can: scanShellHistoryForShadows embeds `map.get(cli)` straight
 *  into `ShadowHit.namespaces` (doctor-cmd.ts), so a single `.sort()` on a
 *  hit would reorder the shared array in place for the rest of the process.
 *  Copying keeps the build-once cache (the actual win) and drops the
 *  aliasing (the hazard); the index is ~40 keys of short arrays, so the
 *  per-call copy is noise. Deliberately still a mutable `Map<string,
 *  string[]>` rather than a ReadonlyMap: callers do their own sorting, and
 *  the copy protects the cache without pushing `readonly` through them.
 *  Sibling note: resolveShadowedClis deep-copies for the same reason. */
let reverseIndexCache: Map<string, string[]> | null = null;
export function cliToNamespaces(): Map<string, string[]> {
  if (reverseIndexCache === null) {
    const map = new Map<string, string[]>();
    for (const [namespace, shadows] of Object.entries(NAMESPACE_REGISTRY)) {
      for (const s of shadows) {
        const list = map.get(s.cli) ?? [];
        // No dedup guard: object keys are unique, so each namespace is visited
        // once, and no registry entry names the same CLI twice within one
        // namespace (`ssh: [{ ssh }, { scp }]` is the shape -- distinct CLIs).
        // A `!list.includes(namespace)` test could therefore never be false.
        // The invariant it stood in for is asserted in cli-shadows.test.ts
        // ("never lists a namespace twice for one CLI").
        list.push(namespace);
        map.set(s.cli, list);
      }
    }
    reverseIndexCache = map;
  }
  return new Map([...reverseIndexCache].map(([cli, namespaces]) => [cli, [...namespaces]]));
}

/** First-party install targets keyed by CLI binary name. Used by the
 *  opt-in shadow-driven install nudge (install-nudge.ts + discover): when
 *  a user runs `<cli>` heavily but has no matching MCP server installed,
 *  discover surfaces "install <package>".
 *
 *  Deliberately HARDCODED and first-party only. This is NOT the inverse of
 *  NAMESPACE_REGISTRY — that registry maps many CLIs (npm, ssh, gh, kubectl,
 *  psql, ...) to servers, but only the entries below correspond to a
 *  Yaw Labs npm package we are willing to recommend installing unprompted.
 *  A heavily-used CLI with no entry here (kubectl, npm, ssh, gh) produces NO
 *  nudge — we never push a third-party server, and we never push a CLI whose
 *  package isn't confirmed live on npm. Adding an entry is an explicit
 *  decision; do not derive this table from NAMESPACE_REGISTRY.
 *
 *  Note the two tiers, easy to conflate: NAMESPACE_REGISTRY is the only one
 *  the doctor reverse index (cliToNamespaces) can report from. heroku and
 *  flyctl appear ONLY in KNOWN_CLI_PREFIXES, which feeds the tool-name-prefix
 *  heuristic -- no registry entry names them as a CLI, so they can never
 *  surface as a shadow hit and are not candidates here either. docker, redis-cli, terraform, sf and
 *  the ansible-* CLIs DO have registry rows now, and still no entry here:
 *  being shadowed does not make a CLI an install target. */
export const SHADOW_INSTALL_TARGETS: Record<string, { package: string; namespace: string; name: string }> = {
  aws: { package: "@yawlabs/aws-mcp", namespace: "aws", name: "AWS" },
  caddy: { package: "@yawlabs/caddy-mcp", namespace: "caddy", name: "Caddy" },
  curl: { package: "@yawlabs/fetch-mcp", namespace: "fetch", name: "Fetch" },
  wget: { package: "@yawlabs/fetch-mcp", namespace: "fetch", name: "Fetch" },
  psql: { package: "@yawlabs/postgres-mcp", namespace: "postgres", name: "Postgres" },
  pg_dump: { package: "@yawlabs/postgres-mcp", namespace: "postgres", name: "Postgres" },
  tailscale: { package: "@yawlabs/tailscale-mcp", namespace: "tailscale", name: "Tailscale" },
};

/** Look up the first-party install target for a CLI binary name, or
 *  undefined if no first-party server covers it. Pure lookup over
 *  SHADOW_INSTALL_TARGETS; the CLI name is matched EXACTLY and every key here
 *  is lowercase, so normalizing is the caller's job -- the same caller that
 *  already strips path/sudo prefixes via extractLeadingBinary, and for the same
 *  reason (see the CLI-name note at the top of this file). */
export function installTargetForCli(cli: string): { package: string; namespace: string; name: string } | undefined {
  // Same own-property guard as resolveShadowedClis. The CLI name comes from
  // a shell-history line, so `constructor` would otherwise resolve to a
  // function and be reported as an install target with `.package` undefined.
  return Object.hasOwn(SHADOW_INSTALL_TARGETS, cli) ? SHADOW_INSTALL_TARGETS[cli] : undefined;
}

/** Format a single server's shadow info as one human line. Used by
 *  discover + the guide auto-section. Returns null when the server
 *  shadows nothing — callers skip the line entirely. */
export function formatShadowLine(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): string | null {
  const shadows = resolveShadowedClis(server);
  if (shadows.length === 0) return null;
  const parts = shadows.map((s) => {
    if (s.subcommands && s.subcommands.length > 0) {
      return `\`${s.cli}\` (${s.subcommands.join(", ")})`;
    }
    return `\`${s.cli}\``;
  });
  return `prefer over local CLI: ${parts.join(", ")}`;
}
