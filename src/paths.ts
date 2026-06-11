import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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
export async function findProjectConfigDir(start: string, home: string = homedir()): Promise<string | null> {
  const homeResolved = path.resolve(home);
  let dir = path.resolve(start);
  let prev = "";
  while (dir !== prev) {
    if (dir === homeResolved) return null;
    const candidate = path.join(dir, CONFIG_DIRNAME);
    try {
      await access(candidate);
      return candidate;
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
