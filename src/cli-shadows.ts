// Static registry: which MCP server namespaces shadow which local CLIs.
//
// Used by:
//   - discover: surface "this server shadows `<cli>`" per candidate
//   - guide: auto-generated "Installed servers" section appended to YAW-MCP.md
//   - doctor: scan shell history for shadowed-CLI invocations
//
// Covers every slug in the yaw.sh/mcp Explore catalog so a user who
// imports from the catalog with the default namespace gets the hint
// with no configuration. Namespace keys are lowercased at lookup time.
//
// A multi-word catalog slug needs TWO keys, and both are registered below.
// The forward lookup is keyed on a real namespace, and every namespace that
// reaches it passed NAMESPACE_RE (^[a-z][a-z0-9_]{0,29}$) -- so a hyphen or a
// leading digit is impossible there. deriveNamespace (local-bundles.ts) is what
// an import actually lands on, and it strips non-alphanumerics: "AWS API" ->
// `awsapi`, "1Password" -> `s1password`. The hyphenated/leading-digit form is
// still the CATALOG SLUG the user types into `yaw-mcp add`, and it is what
// cliToNamespaces reports back through doctor, so it stays; the derived form is
// what makes the shadow hint actually fire.
//
// Well-known alias namespaces (gh, k8s, pg, …) are also registered so
// a user who renamed the server on import still matches. A custom
// namespace is meant to fall through to a tool-name heuristic (shared
// lowercase prefix across three or more tool-cache entries), but that
// heuristic is INERT on a real run -- see the note on KNOWN_CLI_PREFIXES
// for why and for the one-line callsite change that would revive it. So
// in practice a custom namespace gets no shadow hint, and the user has to
// document the mapping in their YAW-MCP.md; that copy is authoritative.

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

// Namespace → shadowed CLI(s). Keys cover every catalog slug plus
// common aliases. Subcommand lists are only filled in where the MCP
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
  "aws-knowledge": EMPTY,
  awsknowledge: EMPTY,
  "aws-pricing": EMPTY,
  awspricing: EMPTY,
  grafana: EMPTY,

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
  "google-workspace": EMPTY,
  googleworkspace: EMPTY,
  "google-maps": EMPTY,
  googlemaps: EMPTY,

  // —— Search / web —————————————————————————————————————————————
  "brave-search": EMPTY,
  bravesearch: EMPTY,
  firecrawl: EMPTY,
  exa: EMPTY,
  fetch: [{ cli: "curl" }, { cli: "wget" }],

  // —— Filesystem / local tools ——————————————————————————————————
  filesystem: EMPTY,
  memory: EMPTY,
  "sequential-thinking": EMPTY,
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
// REACHABLE ONLY FROM TESTS TODAY. The heuristic branch in
// resolveShadowedClis needs a `toolCache` on the server it is handed, and
// no production caller supplies one: both callers (server.ts's discover
// listing via formatShadowLine, and guide.ts's "Installed servers"
// auto-section) pass raw entries from `config.servers`, bundles.json is
// the only config source (server.ts start()), and local-bundles.ts's
// validateEntry returns a FIXED FIELD WHITELIST that does not include
// `toolCache` -- so the field is always undefined there and the branch
// bails at the `cache.length < 3` guard every time. Kept rather than
// deleted because the machinery is correct and one line at either callsite
// revives it: pass `{ ...server, toolCache: this.toolCache.get(
// server.namespace) ?? server.toolCache }` instead of `server`, which
// server.ts already computes twice in that same loop for its cost label
// and its "known tools" line, and which IS populated in production (from
// state.json at startup and from a live tools/list after activation).
// Until then, treat the constant and the branch below as test-only.
const KNOWN_CLI_PREFIXES = new Set<string>([
  "npm",
  "tailscale",
  "gh",
  "aws",
  "kubectl",
  "docker",
  "psql",
  "mongosh",
  "redis",
  "stripe",
  "heroku",
  "supabase",
  "flyctl",
  "shopify",
  "vercel",
  "wrangler",
  "twilio",
  "caddy",
  "playwright",
  "sqlite3",
  "glab",
  "op",
]);

export function resolveShadowedClis(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): CliShadow[] {
  // Object.hasOwn, not a bare index: `namespace` comes from bundles.json and
  // NAMESPACE_RE (local-bundles.ts) accepts `constructor`, `toString`,
  // `valueOf` -- all real inherited properties. A bare lookup returned
  // Object.prototype.constructor (a function, not undefined), so `[...direct]`
  // threw "direct is not iterable" inside discover's output builder
  // (server.ts formatShadowLine, no try/catch) and took the whole tool call
  // down instead of degrading to "shadows nothing".
  const key = server.namespace.toLowerCase();
  const direct = Object.hasOwn(NAMESPACE_REGISTRY, key) ? NAMESPACE_REGISTRY[key] : undefined;
  if (direct !== undefined) return [...direct];

  // Heuristic fallback — look for a single common lowercase prefix
  // across the tool cache. Needs at least three tools to trust it; a
  // server with one or two tools could share a prefix by coincidence.
  //
  // Test-only in practice: no production caller passes a `toolCache`, so
  // this always returns [] on a real run. See KNOWN_CLI_PREFIXES above for
  // why, and for the callsite one-liner that would make it fire.
  const cache = server.toolCache ?? [];
  if (cache.length < 3) return [];
  const prefixes = new Set<string>();
  for (const t of cache) {
    const first = t.name.split(/[_.-]/)[0];
    if (first) prefixes.add(first.toLowerCase());
  }
  if (prefixes.size !== 1) return [];
  const only = [...prefixes][0];
  return KNOWN_CLI_PREFIXES.has(only) ? [{ cli: only }] : [];
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
 *  aliasing (the hazard); the index is ~30 keys of short arrays, so the
 *  per-call copy is noise. Deliberately still a mutable `Map<string,
 *  string[]>` rather than a ReadonlyMap: callers do their own sorting, and
 *  the copy protects the cache without pushing `readonly` through them.
 *  Sibling note: resolveShadowedClis returns a copy for the same reason. */
let reverseIndexCache: Map<string, string[]> | null = null;
export function cliToNamespaces(): Map<string, string[]> {
  if (reverseIndexCache === null) {
    const map = new Map<string, string[]>();
    for (const [namespace, shadows] of Object.entries(NAMESPACE_REGISTRY)) {
      for (const s of shadows) {
        const list = map.get(s.cli) ?? [];
        if (!list.includes(namespace)) list.push(namespace);
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
 *  docker, ...) to servers, but only the entries below correspond to a
 *  Yaw Labs npm package we are willing to recommend installing unprompted.
 *  A heavily-used CLI with no entry here (kubectl, npm, ssh, docker, gh)
 *  produces NO nudge — we never push a third-party server, and we never
 *  push a CLI whose package isn't confirmed live on npm. Adding an entry is
 *  an explicit decision; do not derive this table from NAMESPACE_REGISTRY. */
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
 *  SHADOW_INSTALL_TARGETS; the CLI name is matched exactly (the caller
 *  already strips path/sudo prefixes via extractLeadingBinary). */
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
