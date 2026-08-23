import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "./logger.js";

// Per-platform cache root for anything yaw-mcp fetches at runtime (uv
// binary today; potentially more later). Matches the conventions each
// OS uses for non-essential, regenerable data so users who wipe their
// home can recover without losing config.
export function cacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const base = localAppData && localAppData.length > 0 ? localAppData : path.join(homedir(), "AppData", "Local");
    return path.join(base, "yaw-mcp", "Cache");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "yaw-mcp");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".cache"), "yaw-mcp");
}

// Directory that holds all yaw-mcp config + guidance files. Mirrors the
// `.git/`, `.vscode/`, `.claude/` convention so everything related to
// yaw-mcp lives under one predictable folder a user can grep, gitignore,
// or blow away atomically.
export const CONFIG_DIRNAME = ".yaw-mcp";

/** Subdirectory of the config dir holding the sidecar install that
 *  `yaw-mcp sidecars install` manages. */
export const SIDECARS_DIRNAME = "sidecars";

/** Where `yaw-mcp sidecars install` installs MCP server packages. */
export function sidecarsRoot(home: string = homedir()): string {
  return path.join(userConfigDir(home), SIDECARS_DIRNAME);
}

/**
 * The `node_modules` of the managed sidecar install.
 *
 * Lives here rather than beside the command that writes it because
 * oam-spawn's resolver reads it, and oam-spawn is imported BY that command --
 * putting the path there would be an import cycle.
 *
 * IMPORT THIS (and sidecarsRoot) FROM HERE. sidecars-cmd.ts re-exports both,
 * which makes it read like the owner, and doctor-cmd.ts consumes sidecarsRoot
 * through that re-export -- but sidecars-cmd.ts also imports from oam-spawn.ts,
 * so pointing oam-spawn.ts at the re-export instead of at this module recreates
 * the cycle above. Nothing detects it: both cross-module uses are deferred to
 * call time (a function body, a default parameter), so the cycle would ship
 * latent and only bite once either module gains top-level initialization that
 * touches the other (TDZ on whichever side loads second). There is no cycle
 * linter in the repo; this note and the paragraph above are the only guard.
 */
export function sidecarsNodeModules(home: string = homedir()): string {
  return path.join(sidecarsRoot(home), "node_modules");
}

// User-global yaw-mcp config dir: `~/.yaw-mcp/`. Always this; no XDG
// variation -- config is small, human-edited, and lives next to shell
// dotfiles like `.gitconfig` rather than under a cache root.
export function userConfigDir(home: string = homedir()): string {
  return path.join(home, CONFIG_DIRNAME);
}

// Walks up from `start` looking for a `.yaw-mcp/` directory, stopping
// just BEFORE $HOME (exclusive) or the filesystem root. Returns the
// absolute path to the `.yaw-mcp/` directory, or null if none was found.
//
// Why exclusive of $HOME: a `.yaw-mcp/` sitting at $HOME is the
// user-global scope (handled separately by userConfigDir). Returning
// it here would double-load it as both project and user-global.
function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// True iff `dir` is STRICTLY under `homeResolved` ($HOME itself is false).
// Exported for migrate.ts's findLegacyProjectRoot, whose walk-up bound must
// be a subset of this one -- sharing the predicate keeps the two from
// drifting (a bare `startsWith("..")` copy over there once disagreed with
// the anchored test below, so a legacy config under `~/..config/` was
// discoverable by the loader but never migrated).
export function isUnderHome(dir: string, homeResolved: string): boolean {
  const dirKey = normalizeForCompare(dir);
  const homeKey = normalizeForCompare(homeResolved);
  if (dirKey === homeKey) return false;
  const rel = path.relative(homeResolved, dir);
  if (rel === "" || path.isAbsolute(rel)) return false;
  // Anchor the "escapes $HOME" test on a path SEPARATOR. A bare
  // `startsWith("..")` also rejects a directory literally NAMED `..`-
  // something: path.relative("/home/alice", "/home/alice/..config/app") is
  // "..config/app", which starts with ".." while being genuinely under
  // $HOME. findProjectConfigDir treats a false here as "stop the walk", so
  // that one character made every `.yaw-mcp/` below `~/..config/`
  // undiscoverable. Only a segment that IS ".." actually escapes.
  const relNorm = normalizeForCompare(rel);
  return relNorm !== ".." && !relNorm.startsWith(`..${path.sep}`);
}

// Trust gate for candidates found OUTSIDE $HOME: on POSIX, only accept a
// `.yaw-mcp/` owned by the current effective uid. A hostile `.yaw-mcp/`
// planted on the walk-up path (a shared /tmp-style dir, `/` in a container)
// shouldn't get loaded as project config -- same stance as migrate.ts's
// owner check on legacy files. process.geteuid is POSIX-only; on win32 it
// doesn't exist and Windows uses a different ACL model (the dirs above a
// non-home checkout -- `D:\`, `C:\` -- need admin rights to write into),
// so candidates are accepted as-is there.
async function ownedByCurrentUser(candidate: string): Promise<boolean> {
  const geteuid = (process as { geteuid?: () => number }).geteuid;
  if (typeof geteuid !== "function") return true;
  try {
    const st = await stat(candidate);
    return typeof st.uid === "number" && st.uid === geteuid.call(process);
  } catch {
    // Can't verify ownership of a dir we just saw exist -- treat as
    // hostile / racy and don't trust it.
    return false;
  }
}

export async function findProjectConfigDir(start: string, home: string = homedir()): Promise<string | null> {
  const homeFallback = home && home.length > 0 ? home : process.env.USERPROFILE || homedir();
  const homeResolved = path.resolve(homeFallback);
  let dir = path.resolve(start);
  // The bound depends on where the walk STARTS. Starting at or under $HOME,
  // the walk stops just before $HOME (exclusive): a hijacked `.yaw-mcp/`
  // ABOVE the user's home (`/home/.yaw-mcp`, `/.yaw-mcp`) must never be
  // picked up as project config, and $HOME itself is the user-global scope
  // (userConfigDir). Starting OUTSIDE $HOME -- a second drive (`D:\proj`),
  // a container workspace (`/workspaces/proj` with HOME=/home/vscode), an
  // `/srv` checkout -- $HOME is not on the walk-up path at all, so bounding
  // at $HOME would (and once did) disable project config, the YAW-MCP.md
  // guide, and project bundles for every such checkout. There the walk runs
  // to the filesystem root instead, with the POSIX ownership check above as
  // the trust boundary on each hit.
  const boundedByHome =
    isUnderHome(dir, homeResolved) || normalizeForCompare(dir) === normalizeForCompare(homeResolved);
  let prev = "";
  while (dir !== prev) {
    // Bound the walk at $HOME when it started there: only consider dirs
    // strictly under $HOME, skipping $HOME itself (handled separately by
    // userConfigDir).
    if (boundedByHome && !isUnderHome(dir, homeResolved)) return null;
    const candidate = path.join(dir, CONFIG_DIRNAME);
    try {
      await access(candidate);
      if (boundedByHome || (await ownedByCurrentUser(candidate))) return candidate;
      // Found but not trusted: skip it and keep walking, mirroring the
      // unreadable-dir trade-off below -- a planted dir shouldn't be able
      // to mask a legitimate config further up either.
      log("warn", "Skipping a .yaw-mcp/ dir not owned by the current user", { candidate });
    } catch {
      // Accepted trade-off: we treat ALL errors (ENOENT, EPERM, EACCES,
      // etc.) as "not found here" and keep walking up the directory tree.
      // An unreadable .yaw-mcp/ dir is therefore silently skipped rather
      // than surfaced as an error, which means the walk may reach a
      // parent-directory config instead of stopping at the unreadable one.
      // The risk is low in practice (permission errors on .yaw-mcp/ itself
      // are unusual), and the alternative -- treating access errors as
      // fatal -- would break startup for the common ENOENT case. Callers
      // that need stricter semantics (e.g. readBundlesAt in local-bundles.ts)
      // handle their own permission errors explicitly.
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Name of the human-authored guidance file yaw-mcp surfaces to clients via
// the yaw-mcp://guide resource. Lives next to config.json inside `.yaw-mcp/`.
export const GUIDE_FILENAME = "YAW-MCP.md";

// Absolute path to the YAW-MCP.md file inside a given `.yaw-mcp/` directory.
export function guidePath(configDir: string): string {
  return path.join(configDir, GUIDE_FILENAME);
}
