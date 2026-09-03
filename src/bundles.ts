// Curated multi-server bundles — static client-side data, not fetched from
// yaw.sh/mcp. Each bundle is a "stack" of namespaces that commonly ship
// together for a known workflow (on-call triage, PR review, etc.). The
// `mcp_connect_bundles` meta-tool surfaces these so the model can activate
// a coherent preset in one step instead of juggling discover + load.
//
// Namespaces here MUST be the namespaces the install paths actually write:
// both `yaw-mcp add` (local-add-cmd.ts) and the Yaw Terminal app derive the
// namespace from the catalog row's display NAME via deriveNamespace
// (local-bundles.ts) — NOT from the slug. So "Google Analytics" installs as
// `googleanalytics` even though its catalog slug is `ga`; a bundle listing
// the slug form could never match any installed set. If a user hand-picked
// a different namespace locally, partial-match will still be useful ("you
// have github + linear, pr-review is ready") even if their slack install is
// called "myslack" — the bundle just won't fire on that account until they
// align the names.

export type BundleCategory = "dev" | "ops" | "growth" | "data";

export interface CuratedBundle {
  id: string;
  name: string;
  description: string;
  namespaces: string[];
  category: BundleCategory;
}

export const CURATED_BUNDLES: readonly CuratedBundle[] = [
  {
    id: "devops-incident",
    name: "DevOps Incident Triage",
    description: "GitHub + PagerDuty + Slack for on-call triage",
    namespaces: ["github", "pagerduty", "slack"],
    category: "ops",
  },
  {
    id: "pr-review",
    name: "PR Review",
    description: "GitHub + Linear for issue-to-PR traceability",
    namespaces: ["github", "linear"],
    category: "dev",
  },
  {
    id: "growth-stack",
    name: "Growth Stack",
    description: "HubSpot + Slack + GA for lifecycle + funnel signals",
    // NOT "ga": the catalog slug is `ga`, but every install path derives the
    // namespace from the row's NAME ("Google Analytics"), so the installed
    // namespace is `googleanalytics` and the slug form can never match.
    namespaces: ["hubspot", "slack", "googleanalytics"],
    category: "growth",
  },
  {
    id: "data-ops",
    name: "Data Ops",
    description: "Postgres + AWS + Snowflake for pipeline debugging",
    namespaces: ["postgres", "aws", "snowflake"],
    category: "data",
  },
  {
    id: "product-release",
    name: "Product Release",
    description: "GitHub + Linear + Slack for ship-day coordination",
    namespaces: ["github", "linear", "slack"],
    category: "dev",
  },
  {
    id: "support-ops",
    name: "Support Ops",
    description: "Zendesk + Slack + HubSpot for escalation handoffs",
    namespaces: ["zendesk", "slack", "hubspot"],
    category: "ops",
  },
];

export interface BundleMatchResult {
  ready: CuratedBundle[];
  partial: Array<{ bundle: CuratedBundle; have: string[]; missing: string[] }>;
}

/**
 * Partition the curated bundles against a set of installed namespaces.
 *
 * - `ready`: every namespace in the bundle is installed — the caller can
 *   run `mcp_connect_activate({ servers: [...] })` verbatim.
 * - `partial`: at least one namespace is installed AND at least one is
 *   missing — surface the missing list so the user knows what to install.
 *
 * Bundles with zero matching namespaces are omitted entirely (noise). Pure
 * function — does not mutate `installedNamespaces` or the bundles array.
 */
export function matchBundles(installedNamespaces: Iterable<string>): BundleMatchResult {
  const installed = new Set(installedNamespaces);
  const ready: CuratedBundle[] = [];
  const partial: BundleMatchResult["partial"] = [];

  for (const bundle of CURATED_BUNDLES) {
    const have = bundle.namespaces.filter((ns) => installed.has(ns));
    const missing = bundle.namespaces.filter((ns) => !installed.has(ns));
    if (missing.length === 0) {
      ready.push(bundle);
    } else if (have.length > 0) {
      partial.push({ bundle, have, missing });
    }
  }

  return { ready, partial };
}

/**
 * One-line "how to activate" snippet per bundle. Used by the `list` action
 * so the model has a ready-to-run call site without a second round-trip.
 */
export function bundleActivateHint(bundle: CuratedBundle): string {
  return `mcp_connect_activate({ servers: ${JSON.stringify(bundle.namespaces)} })`;
}

/**
 * The one ranking order for partial-match bundles. Primary sort: fewest
 * missing namespaces first (the cheapest install to unlock a curated bundle).
 * Tie-break: more already-installed namespaces first (most momentum), then
 * bundle id alphabetical for stability.
 *
 * Exported because TWO surfaces present this list -- the inline discover nudge
 * (topPartialBundles below) and `yaw-mcp bundles match` (bundles-cmd.ts
 * renderMatch) -- and a user who sees them disagree reads it as a bug. The
 * CLI re-implemented this comparator inline, so a tie-break tweak here would
 * silently desync the two; both now sort through this function.
 */
export function comparePartialBundles(
  a: BundleMatchResult["partial"][number],
  b: BundleMatchResult["partial"][number],
): number {
  if (a.missing.length !== b.missing.length) return a.missing.length - b.missing.length;
  if (a.have.length !== b.have.length) return b.have.length - a.have.length;
  return a.bundle.id.localeCompare(b.bundle.id);
}

/**
 * Rank partial-match bundles for an inline "complete this stack" nudge, using
 * the shared comparePartialBundles order.
 *
 * Returns at most `limit` bundles. Empty array if nothing matches.
 */
export function topPartialBundles(installedNamespaces: Iterable<string>, limit: number): BundleMatchResult["partial"] {
  if (limit <= 0) return [];
  const { partial } = matchBundles(installedNamespaces);
  return partial.slice().sort(comparePartialBundles).slice(0, limit);
}
