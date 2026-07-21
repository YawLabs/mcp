// Legacy-path migration: fold pre-0.12 flat config dotfiles into the
// new `.yaw-mcp/` directory layout on startup.
//
// Pre-0.12, yaw-mcp read three flat files at the root:
//
//   ~/.yaw-mcp.json                 (user-global)
//   <project>/.yaw-mcp.json         (project-shared)
//   <project>/.yaw-mcp.local.json   (machine-local, gitignored)
//
// 0.12 moved these under `.yaw-mcp/` so all yaw-mcp state lives in one
// predictable dir. Existing 0.11.x users would otherwise see their token
// silently disappear on upgrade. This migrator fixes that:
//
//   - Idempotent: if the new location already exists, DON'T overwrite.
//   - Fail-open: a locked/unwritable path logs and continues — the
//     user isn't worse off than if they'd never upgraded.
//   - One-way: we rename the legacy file rather than copy + delete, so
//     downgrading doesn't silently revive a stale version.
//   - Quiet but visible: every successful move logs at INFO so users
//     can trace where their config went.

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { log } from "./logger.js";
import { CONFIG_DIRNAME, userConfigDir } from "./paths.js";

export const LEGACY_GLOBAL_FILENAME = ".yaw-mcp.json";
export const LEGACY_PROJECT_FILENAME = ".yaw-mcp.json";
export const LEGACY_LOCAL_FILENAME = ".yaw-mcp.local.json";

const NEW_CONFIG_FILENAME = "config.json";
const NEW_LOCAL_FILENAME = "config.local.json";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Move legacy → new, but only if the new path is empty. Ensures the
// parent dir exists first (the whole point of this migration is that
// `.yaw-mcp/` may not have been created yet). Logs on move, logs on skip
// due to an already-populated target, logs on error.
async function migrateFile(legacy: string, target: string, scope: string): Promise<void> {
  if (!(await exists(legacy))) return;

  // POSIX-only owner check: confirm the legacy file is owned by the
  // current effective uid before we rename it. A hostile or stale file
  // dropped into the walker's range (a path we walked up into, a shared
  // /tmp-style dir, a hand-off after `chown`) shouldn't get hoisted into
  // ~/.yaw-mcp/ where it'd be trusted by the loader. process.geteuid is
  // Posix-only -- on win32 it doesn't exist, and Windows uses a different
  // ACL model, so we accept legacy files as-is there.
  if (process.platform !== "win32") {
    const geteuid = (process as { geteuid?: () => number }).geteuid;
    if (typeof geteuid === "function") {
      try {
        const st = await stat(legacy);
        const myUid = geteuid.call(process);
        if (typeof st.uid === "number" && st.uid !== myUid) {
          log("warn", "yaw-mcp config: legacy file not owned by current user -- skipping migration", {
            scope,
            legacy,
            fileUid: st.uid,
            processUid: myUid,
          });
          return;
        }
      } catch (err) {
        // Couldn't stat the file we just verified exists -- treat as
        // hostile / racy and skip rather than blindly trust it.
        log("warn", "yaw-mcp config: could not stat legacy file -- skipping migration", {
          scope,
          legacy,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
  }

  if (await exists(target)) {
    // Target exists AND legacy exists — ambiguous. Prefer the new one,
    // but warn so the user knows the legacy is orphaned and can delete
    // it manually. We do NOT silently overwrite the new file; that
    // would lose whatever the user wrote there.
    log("warn", "yaw-mcp config: legacy file exists alongside new location -- legacy is ignored", {
      scope,
      legacy,
      target,
      action: "manually delete the legacy file after confirming the new one is correct",
    });
    return;
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(legacy, target);
    log("info", "yaw-mcp config: migrated legacy file into .yaw-mcp/ directory", {
      scope,
      from: legacy,
      to: target,
    });
  } catch (err) {
    log("warn", "yaw-mcp config: legacy migration failed -- leaving file in place", {
      scope,
      legacy,
      target,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MigrateOptions {
  cwd: string;
  home: string;
}

// Runs all three migrations. Called from loadYawMcpConfig before any
// file resolution so the rest of the loader only ever sees the new
// layout. Intentionally does NOT return anything — failures are
// absorbed via log so a bad filesystem state can't brick startup.
export async function migrateLegacyConfigPaths(opts: MigrateOptions): Promise<void> {
  const { cwd, home } = opts;

  // User-global: ~/.yaw-mcp.json → ~/.yaw-mcp/config.json
  const legacyGlobal = join(home, LEGACY_GLOBAL_FILENAME);
  const newGlobal = join(userConfigDir(home), NEW_CONFIG_FILENAME);
  await migrateFile(legacyGlobal, newGlobal, "global");

  // Project scope: find the nearest legacy file by walking up from cwd.
  // We use a dedicated walker rather than findProjectConfigDir because
  // the legacy layout has no `.yaw-mcp/` marker — the file IS the marker.
  const legacyProjectRoot = await findLegacyProjectRoot(cwd, home);
  if (legacyProjectRoot) {
    // A project dir found by the legacy walker is ALSO a valid target
    // for a `.yaw-mcp/` directory. findProjectConfigDir will discover the
    // `.yaw-mcp/` we're about to create on the next startup, so this is a
    // one-shot conversion.
    const newDir = join(legacyProjectRoot, CONFIG_DIRNAME);

    const legacyLocal = join(legacyProjectRoot, LEGACY_LOCAL_FILENAME);
    const newLocal = join(newDir, NEW_LOCAL_FILENAME);
    await migrateFile(legacyLocal, newLocal, "local");

    const legacyProject = join(legacyProjectRoot, LEGACY_PROJECT_FILENAME);
    const newProject = join(newDir, NEW_CONFIG_FILENAME);
    await migrateFile(legacyProject, newProject, "project");
  }
}

function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// True iff `dir` is STRICTLY under `homeResolved` ($HOME itself is false).
// Deliberately identical to the bound findProjectConfigDir uses in
// paths.ts -- see findLegacyProjectRoot for why they must agree.
function isUnderHome(dir: string, homeResolved: string): boolean {
  if (normalizeForCompare(dir) === normalizeForCompare(homeResolved)) return false;
  const rel = relative(homeResolved, dir);
  const relNorm = normalizeForCompare(rel);
  return relNorm !== "" && !relNorm.startsWith("..") && !isAbsolute(rel);
}

// Walk up from `cwd` looking for either a legacy `.yaw-mcp.json` or
// `.yaw-mcp.local.json`. Returns the directory that contains the legacy
// file(s), or null if none found.
//
// The walk is bounded to directories STRICTLY under $HOME, matching
// findProjectConfigDir (paths.ts). The bounds MUST agree: this migrator
// destructively renames `.yaw-mcp.json` -> `.yaw-mcp/config.json`, so
// migrating a directory the loader will never look in silently loses the
// user's token. The previous version walked to the filesystem root for
// any cwd outside $HOME (the `dir === homeResolved` check never fired),
// which both hoisted files from unrelated ancestors and moved them into
// a location nothing reads. Outside $HOME the walk is now a no-op.
async function findLegacyProjectRoot(cwd: string, home: string): Promise<string | null> {
  const homeResolved = resolve(home);
  let dir = resolve(cwd);
  let prev = "";
  while (dir !== prev) {
    if (!isUnderHome(dir, homeResolved)) return null;
    const legacyProject = join(dir, LEGACY_PROJECT_FILENAME);
    const legacyLocal = join(dir, LEGACY_LOCAL_FILENAME);
    if ((await exists(legacyProject)) || (await exists(legacyLocal))) return dir;
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}
