// Claude Code's settings.json, and the one grant install adds to it.
//
// Separate from the client-config core on purpose: `settings.json` is NOT an
// MCP server list. It holds hooks, model and permissions, and Claude Code
// ignores any `mcpServers` key in it -- the launch entry goes in
// `~/.claude.json`, which the core owns. So this module is the one place
// outside the adapters allowed to reach for raw JSONC editing, and the
// boundary test's allowlist names it for exactly that reason.
//
// What install does here is BEST-EFFORT, and the asymmetry with the client
// config is deliberate at every step: the launch entry is already written by
// the time this runs, `settings.json` is hand-maintained, and rewriting a key
// the user put there is a bigger liberty than naming it and letting them fix
// it. So a `permissions` key holding something that is not an object is
// REPORTED, never repaired, and an emptied `allow` is left as `[]` rather
// than deleted.
//
// THE GRANT IS SPLICED AS ONE ELEMENT. It used to be written by replacing the
// whole `permissions.allow` VALUE, which deletes every comment inside that
// array -- and an allow-list is exactly the kind of list people annotate
// ("// the team agreed on this one" above a pattern). Adding or removing our
// one pattern took those notes with it. `addJsoncArrayElement` /
// `removeJsoncArrayElements` edit the single member in the original bytes
// instead, so every other element, and every comment, survives byte for byte.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describeValueShape } from "./client-config.js";
import type { InstallScope } from "./install-target-model.js";
import { addJsoncArrayElement, parseJsonc, removeJsoncArrayElements } from "./jsonc.js";

/** Pattern added to Claude Code's `permissions.allow` on install so the
 *  user isn't re-prompted for each yaw-mcp MCP tool call. Only matters for
 *  Claude Code (Claude Desktop / Cursor / VS Code have their own models).
 *  Keep in sync with the tool-name prefix our proxy exposes -- Claude Code
 *  derives the prefix from ENTRY_NAME by replacing non-alphanumeric chars
 *  with underscores, so "mcp" becomes "mcp__mcp__". */
export const CLAUDE_CODE_ALLOW_PATTERN = "mcp__mcp__*";

/** Resolve the Claude Code settings.json file that holds `permissions.allow`.
 *  Different from the mcpServers path (`~/.claude.json`): permissions live
 *  in `settings.json`, not the user config. Returns null for clients that
 *  don't use this scheme.
 *
 *  When `claudeConfigDir` is set, user-scope `settings.json` lives at
 *  `<DIR>/settings.json` (NOT `<DIR>/.claude/settings.json` — the `.claude`
 *  segment is absorbed by the env redirect). Project/local scopes are
 *  project-relative and unaffected.
 *
 *  No `os` parameter, unlike the path resolvers in install-targets.ts (which
 *  spell a `display` string for the TARGET os): every path here is built with
 *  `node:path.join` against the runner's own platform -- the only thing a
 *  caller writing the file could use. A dead `os` option used to ride along
 *  for the sake of old call sites; it was dropped once the last one stopped
 *  passing it. */
export function resolveClaudeCodeSettingsPath(
  scope: InstallScope,
  opts: { home: string; projectDir?: string; claudeConfigDir?: string },
): string | null {
  const { home, projectDir, claudeConfigDir } = opts;
  const cfgDir = claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : null;
  if (scope === "user") return cfgDir ? join(cfgDir, "settings.json") : join(home, ".claude", "settings.json");
  if (scope === "project" && projectDir) return join(projectDir, ".claude", "settings.json");
  if (scope === "local" && projectDir) return join(projectDir, ".claude", "settings.local.json");
  return null;
}

/** Union `patterns` into `existing.permissions.allow`, preserving every
 *  other key and every element already there. Deduplicates by string equality
 *  so repeated installs don't grow the list.
 *
 *  Operates on the PARSED document, and is what decides whether there is a
 *  change to make at all; the bytes are then spliced by
 *  `patchPermissionsAllowText` below, which never re-renders the array.
 *
 *  Deliberately NOT a place that strips the pre-rename legacy wildcards
 *  (`mcp__yaw_mcp__*`, `mcp__mcph__*`, `mcp__mcp_hosting__*`). An earlier
 *  version dropped them unless the legacy mcpServers entry was still present
 *  in the ONE container install was writing -- but ~/.claude/settings.json is
 *  global, so a user-scope install could not see the legacy `yaw-mcp` entry a
 *  repo's .mcp.json (or another project's local scope) still runs, stripped
 *  its grant, and Claude Code re-prompted on every tool call of that live
 *  server. No cheap read sees every container a global allow-list covers.
 *  Three dead wildcards are harmless; a revoked live grant is not.
 *
 *  That reasoning SURVIVES the legacy-entry trim runInstall performs, and
 *  the two must not be conflated: the trim removes the legacy key from the one
 *  container this run writes, while the allow-list it would have to strip is
 *  machine-global and may still be serving a legacy entry in a container this
 *  run never reads. Same asymmetry, same conclusion -- the entry goes, the
 *  wildcard stays.
 *  Exported for tests. */
export function mergePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prev = out.permissions;
  const perms: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const prevAllow = perms.allow;
  // Every existing element is carried through VERBATIM, non-strings included.
  // The dedupe below is a string-only concept, so a pass that narrowed to
  // string silently DELETED anything else the user (or a future Claude Code
  // schema) had put in `permissions.allow` -- an object rule, a nested array --
  // on the next install, contradicting this function's own promise to preserve
  // everything it does not manage.
  const allow: unknown[] = Array.isArray(prevAllow) ? [...(prevAllow as unknown[])] : [];
  for (const p of patterns) {
    if (!allow.includes(p)) allow.push(p);
  }
  perms.allow = allow;
  out.permissions = perms;
  return out;
}

/**
 * The subtract side of `mergePermissionsAllow`: drop `patterns` from
 * `existing.permissions.allow`, preserving every other key and every other
 * element (non-strings included, for the same preserve-what-we-do-not-manage
 * reason the merge carries them).
 *
 * Returns the SAME object reference when there is nothing to drop -- no
 * `permissions` key, no `allow` array, or no member matching. The caller's
 * `JSON.stringify(before) === JSON.stringify(after)` no-op test then trivially
 * holds, which is what keeps `uninstall` from rewriting a settings.json it has
 * no change to make to.
 *
 * An emptied `allow` is left as `[]` rather than deleted, and `permissions`
 * with it. Deleting a key the user's file declares is a bigger liberty than
 * this best-effort patch is entitled to -- the same asymmetry the install path
 * draws when it REPORTS a non-object `permissions` instead of repairing it.
 * Exported for tests.
 */
export function removePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const prev = existing.permissions;
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) return existing;
  const prevAllow = (prev as Record<string, unknown>).allow;
  if (!Array.isArray(prevAllow)) return existing;
  const allow = (prevAllow as unknown[]).filter((p) => !(typeof p === "string" && patterns.includes(p)));
  if (allow.length === (prevAllow as unknown[]).length) return existing;
  return { ...existing, permissions: { ...(prev as Record<string, unknown>), allow } };
}

/** Splice `patterns` into (or out of) `raw`'s `permissions.allow` ONE ELEMENT
 *  AT A TIME, so a comment inside that array survives.
 *
 *  Each call re-parses the text the last one produced, because the splice
 *  computes offsets against the tree it was handed -- two edits taken from one
 *  parse would each land at stale positions. Exported for tests: the byte-level
 *  claim ("a comment inside the array survives an install and an uninstall")
 *  is pinned here rather than only through a whole install run. */
export function patchPermissionsAllowText(raw: string, patterns: string[], op: "add" | "remove"): string {
  let text = raw;
  for (const pattern of patterns) {
    text =
      op === "add"
        ? addJsoncArrayElement(text, ["permissions", "allow"], pattern)
        : removeJsoncArrayElements(text, ["permissions", "allow"], (v) => v === pattern);
  }
  return text;
}

/** The fields a concurrent writer moves; null when the file is absent. Used
 *  to detect a write that lands between install's read of a file and its
 *  publishing rename. */
export type SettingsFingerprint = { mtimeMs: number; size: number } | null;

async function settingsFingerprint(path: string): Promise<SettingsFingerprint> {
  try {
    const st = await stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export interface ClaudeCodeSettingsPatch {
  path: string;
  nextJson: string;
  changed: boolean;
  /** The patterns this patch appends to `permissions.allow` -- the whole
   *  delta, since the merge only ever adds. What `--dry-run` prints instead of
   *  `nextJson`, which is the entire settings.json (hooks, `env`, ...). Empty
   *  when nothing changed, and empty under `op: "remove"` (see `removed`). */
  added: string[];
  /** The mirror of `added` under `op: "remove"` -- the patterns this patch
   *  drops. Empty on the add path. */
  removed: string[];
  /** stat of the file taken ahead of the read; null when it was absent. */
  fingerprint: SettingsFingerprint;
  malformed?: boolean;
  malformedReason?: string;
}

export async function prepareClaudeCodeSettingsPatch(opts: {
  scope: InstallScope;
  home: string;
  projectDir: string | undefined;
  claudeConfigDir: string | undefined;
  /** "add" (install) unions the pattern in; "remove" (uninstall) drops it. */
  op?: "add" | "remove";
}): Promise<ClaudeCodeSettingsPatch | null> {
  const path = resolveClaudeCodeSettingsPath(opts.scope, {
    home: opts.home,
    projectDir: opts.projectDir,
    claudeConfigDir: opts.claudeConfigDir,
  });
  if (!path) return null;

  let existing: Record<string, unknown> = {};
  // Raw bytes of the pre-existing settings.json, for the same reason install
  // keeps the client config's: settings.json is JSONC and hand-maintained,
  // and a JSON.stringify rewrite drops every comment in it.
  let rawSettings: string | null = null;
  // Fingerprinted BEFORE the read, for the same reason the client config is
  // (runInstall, ahead of its readFile): taken after, a write landing between
  // the read and the stat would be carried forward under a fresh fingerprint.
  // null is "absent", which is the existence test this used to be an
  // existsSync for; an unreadable file still reaches the readFile below and
  // is reported from there.
  const fingerprint = await settingsFingerprint(path);
  if (fingerprint !== null) {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
          rawSettings = raw;
        } else {
          // Not an object — leave alone, but flag it so the caller can warn
          // (otherwise the settings.json is silently never patched).
          return {
            path,
            nextJson: "",
            changed: false,
            added: [],
            removed: [],
            malformed: true,
            malformedReason: "not a JSON object",
            fingerprint,
          };
        }
      }
    } catch (e) {
      // Malformed settings.json — don't try to rewrite; flag it so the
      // caller can warn (let the user fix it by hand).
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: (e as Error).message,
        fingerprint,
      };
    }
  }

  const op = opts.op ?? "add";
  const merged =
    op === "remove"
      ? removePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN])
      : mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
  // If nothing changed, signal no-op to the caller.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return { path, nextJson: "", changed: false, added: [], removed: [], fingerprint };
  // The delta is "our patterns that were not already there" (add) or "ours that
  // were" (remove): both helpers preserve every other element, so a membership
  // test against the PREVIOUS list is the whole change either way.
  const prevAllow = (existing.permissions as { allow?: unknown } | undefined)?.allow;
  const prevAllowList: unknown[] = Array.isArray(prevAllow) ? prevAllow : [];
  const added = op === "add" ? [CLAUDE_CODE_ALLOW_PATTERN].filter((p) => !prevAllowList.includes(p)) : [];
  const removed = op === "remove" ? [CLAUDE_CODE_ALLOW_PATTERN].filter((p) => prevAllowList.includes(p)) : [];
  if (rawSettings !== null) {
    // Pre-empt the one shape that makes the splice below throw: a `permissions`
    // key holding a non-object (null, a scalar, an array) has no `allow` node
    // to hang the pattern off, and jsonc-parser's message for it ("Can not add
    // index to parent of type array") names neither the file nor the key --
    // exactly the internal text the client-config path takes care never to
    // print. Named here instead, in the same shape vocabulary that path uses.
    //
    // Reported, NOT repaired -- deliberately asymmetric with the client config.
    // There, replacing an empty container is the difference between installing
    // and not; here the patch is best-effort (the launch entry is already
    // written), settings.json is hand-maintained, and rewriting a key the user
    // put there is a bigger liberty than naming it and letting them fix it.
    const perms = existing.permissions;
    if (perms !== undefined && (typeof perms !== "object" || perms === null || Array.isArray(perms))) {
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: `"permissions" is ${describeValueShape(perms)}, not a JSON object`,
        fingerprint,
      };
    }
    // Only our ONE pattern changes, so splice that one array ELEMENT in the
    // original bytes. Everything else -- hooks, model, the other patterns,
    // comments inside the allow list, formatting -- is left untouched rather
    // than re-serialized.
    try {
      const next = patchPermissionsAllowText(rawSettings, [CLAUDE_CODE_ALLOW_PATTERN], op);
      return { path, nextJson: next.endsWith("\n") ? next : `${next}\n`, changed: true, added, removed, fingerprint };
    } catch (e) {
      // Backstop for whatever the shape check above cannot foresee -- an
      // `allow` key holding a non-array is the reachable one, since
      // `addJsoncArrayElement` refuses rather than replace it. Named the same
      // way, so even here the user gets the key alongside the splice's text
      // rather than the text alone.
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: `could not splice permissions.allow (${(e as Error).message})`,
        fingerprint,
      };
    }
  }
  return { path, nextJson: `${JSON.stringify(merged, null, 2)}\n`, changed: true, added, removed, fingerprint };
}
