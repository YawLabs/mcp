// The alias table, and the two helpers every consumer uses to turn a
// `<client>` argument into a target.
//
// An ALIAS is a second name for a (client, scope) pair that already has a row
// in INSTALL_TARGETS -- not a row of its own. That distinction is the whole
// point: a row would make the same file appear twice in `install --list` and
// in doctor, once under each name, and would tell `try`'s auto-detect that
// there are two clients to probe where there is one file.
//
// The table holds ONE row, `mcp`. It was landed as the one-hunk change the
// empty table was built to make possible: every consumer already routes
// through `resolveClientArg` and `clientChoices`, and every expectation that
// names the id list DERIVES from them, so no other file changed to add it.
// The literal list of alias ids is spelled in exactly one place, and it is a
// test (client-aliases.test.ts), not this module -- the same arrangement
// client-config-boundary.test.ts uses for the canonical client ids.

import { INSTALL_TARGETS, type InstallClientId, type InstallScope } from "./install-targets.js";

/** Which verbs accept an alias. `try` does NOT: it writes a one-off trial
 *  entry and picks a client by probing, so a second name for a slot it
 *  already probes would let one file be trialled twice. Every other
 *  client-taking verb does. */
export type ClientVerb = "install" | "uninstall" | "import" | "try";

export interface ClientAlias {
  /** The id a user types, e.g. `mcp`. Must not collide with a canonical
   *  clientId -- `aliasesAreDistinct` below is the check, and the boundary
   *  test runs it. */
  id: string;
  /** The canonical row this name resolves to. */
  clientId: InstallClientId;
  /** The scope the alias pins. When absent the alias only renames the client
   *  and the caller's own `--scope` (or its default) still applies. */
  scope?: InstallScope;
  /** One clause naming what the alias is, for help and completion output. */
  label: string;
}

export const CLIENT_ALIASES: readonly ClientAlias[] = [
  // `mcp` is Claude Code's PROJECT scope under a second name: the same
  // `<project>/.mcp.json`, the same `mcpServers` container and the same launch
  // entry `install claude-code --scope project` writes. Claude Code's docs
  // call that scope "a `.mcp.json` file at your project's root directory" with
  // the root key `mcpServers` (code.claude.com/docs/en/mcp, "Project scope").
  //
  // Pinning the scope is what makes it name that file at all: claude-code's
  // three scopes include `user`, and `resolveInstallSite` prefers `user` when
  // no `--scope` is given, so an alias that pinned nothing would resolve
  // `install mcp` to `~/.claude.json` -- the wrong file under the right name.
  //
  // Nothing claude-code's project scope does is re-implemented here, because
  // the alias is gone before any of it runs: the row's
  // `hooks.permissionsPatch` (the `permissions.allow += ["mcp__mcp__*"]` patch
  // of `<project>/.claude/settings.json`), the approve-on-restart Done line,
  // and whatever strictness that scope declares through `strictJson` all key
  // off the resolved (client, scope) and never off the spelling. The tests
  // drive BOTH spellings through the same assertions rather than assume it.
  {
    id: "mcp",
    clientId: "claude-code",
    scope: "project",
    label: "Claude Code's project scope -- the project-root .mcp.json",
  },
];

/** The ids `verb` accepts, canonical rows first in table order, then the
 *  aliases in table order.
 *
 *  Order is load-bearing twice over: the canonical half must stay in
 *  INSTALL_TARGETS order because `--list`, doctor and `try`'s auto-detect all
 *  walk that order, and the aliases must come LAST so a completion list, a
 *  usage synopsis and the "Choose: ..." line all keep naming the real clients
 *  first. */
export function clientChoices(verb: ClientVerb = "install"): string[] {
  const ids = INSTALL_TARGETS.map((t) => t.clientId as string);
  if (verb === "try") return ids;
  return [...ids, ...CLIENT_ALIASES.map((a) => a.id)];
}

/** What a `<client>` argument resolved to: a canonical row, plus the scope an
 *  alias pinned (absent when the argument was a canonical id, or an alias that
 *  pins no scope). */
export interface ResolvedClientArg {
  clientId: InstallClientId;
  /** Set only when an ALIAS pinned it. A caller applies it as the scope
   *  DEFAULT, so an explicit `--scope` the user typed still wins -- otherwise
   *  an alias would silently override the flag beside it. */
  scope?: InstallScope;
  /** The alias id the user typed, or null when they typed a canonical id.
   *  Messages name the canonical client either way; this is for a caller that
   *  wants to echo what was typed. */
  via: string | null;
}

/** Resolve a `<client>` argument for `verb`, or null when it is not one this
 *  verb accepts. Canonical ids win over aliases, which `aliasesAreDistinct`
 *  makes moot -- but the order is stated rather than assumed, so an alias that
 *  slipped past that check could never shadow a real client. */
export function resolveClientArg(verb: ClientVerb, arg: string): ResolvedClientArg | null {
  const target = INSTALL_TARGETS.find((t) => t.clientId === arg);
  if (target) return { clientId: target.clientId, via: null };
  if (verb === "try") return null;
  const alias = CLIENT_ALIASES.find((a) => a.id === arg);
  if (!alias) return null;
  return { clientId: alias.clientId, scope: alias.scope, via: alias.id };
}

/** Every alias id that collides with a canonical clientId or with another
 *  alias, and every alias whose `clientId` names no row. Empty means the table
 *  is well formed. Exported so the boundary test can assert it stays empty
 *  once the table is filled, rather than re-deriving the rule there. */
export function aliasTableProblems(): string[] {
  const problems: string[] = [];
  const canonical = new Set(INSTALL_TARGETS.map((t) => t.clientId as string));
  const seen = new Set<string>();
  for (const alias of CLIENT_ALIASES) {
    if (canonical.has(alias.id)) problems.push(`alias "${alias.id}" collides with a client id`);
    if (seen.has(alias.id)) problems.push(`alias "${alias.id}" is declared twice`);
    seen.add(alias.id);
    if (!canonical.has(alias.clientId))
      problems.push(`alias "${alias.id}" points at unknown client "${alias.clientId}"`);
  }
  return problems;
}
