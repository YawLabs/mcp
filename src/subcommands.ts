// Side-effect-free registry of dispatched subcommands + flag aliases.
//
// Lives in its own module (not index.ts) because index.ts runs the
// dispatcher at import time -- importing it from a test would boot the
// CLI. Keeping the known-subcommand list here lets the completion test
// import the ground-truth dispatch table directly and assert
// SUBCOMMAND_SPEC covers every real subcommand (no hand-maintained
// mirror to drift).

import { closestNames, levenshtein } from "./fuzzy.js";

// Leading-dash flag aliases handled by the dispatcher (help/version).
// Kept separate from the subcommand names so consumers (did-you-mean,
// completion coverage) can filter them out cleanly.
export const FLAG_ALIASES = ["--help", "-h", "--version", "-V"] as const;

// Known subcommands for fuzzy-match feedback on typos. Anything not in
// this list and not a flag (leading `-`) falls through to "unknown
// subcommand" before runServer, so `yaw-mcp instal` fails loud instead of
// starting as an MCP server and opaquely erroring on the missing token.
export const KNOWN_SUBCOMMANDS = [
  "compliance",
  "audit",
  "foundry",
  "install",
  "add",
  "remove",
  "list",
  "doctor",
  "reset-learning",
  "servers",
  "bundles",
  "completion",
  "upgrade",
  "try",
  "try-cleanup",
  "login",
  "logout",
  "sync",
  "stats",
  "secrets",
  "set-active",
  "help",
  ...FLAG_ALIASES,
] as const;

/**
 * Suggest the closest real subcommands for a bare (non-dash) typo.
 * `help` stays in the pool so `halp` -> `help`; only the leading-dash
 * flag aliases are stripped (those are handled by `suggestFlag`).
 * Returns up to `limit` names, best first; [] when nothing is close.
 */
export function suggestSubcommand(input: string, limit = 3): string[] {
  const visible = KNOWN_SUBCOMMANDS.filter((s) => !s.startsWith("-"));
  return closestNames(input, visible, limit);
}

/**
 * Suggest the closest known flag alias for a long-form leading-dash typo
 * (e.g. `--versionn` -> `--version`, `--hepl` -> `--help`). Restricted to
 * inputs longer than a single-letter flag (length > 2) so a genuine short
 * flag like a server's own lowercase `-v` is NOT hijacked by a case-only
 * match against `-V`.
 *
 * Uses pure levenshtein distance <= 2 (without the prefix/substring tiers
 * that closestNames adds). Prefix matching is unsafe here: `--vers` is a
 * prefix of `--version` but could equally be the start of a genuine server
 * flag; intercepting it as a "did you mean?" would swallow a valid flag
 * before it reaches the server. Edit-distance only gives the same typo
 * coverage without that false-positive surface.
 *
 * Returns up to `limit` aliases, best first; [] when nothing is close (so
 * genuine long server flags fall through to the server untouched).
 */
export function suggestFlag(input: string, limit = 2): string[] {
  if (input.length <= 2) return [];
  const q = input.toLowerCase();
  const hits: Array<{ name: string; d: number }> = [];
  for (const alias of FLAG_ALIASES) {
    if (alias === input) continue; // exact match -- never "did you mean yourself"
    const d = levenshtein(q, alias.toLowerCase());
    if (d <= 2) hits.push({ name: alias, d });
  }
  hits.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map((h) => h.name);
}
