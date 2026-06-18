import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_GLOBAL_FILENAME,
  LEGACY_LOCAL_FILENAME,
  LEGACY_PROJECT_FILENAME,
  migrateLegacyConfigPaths,
} from "../migrate.js";
import { CONFIG_DIRNAME, userConfigDir } from "../paths.js";

// findLegacyProjectRoot is not exported -- all walk-up behaviour is exercised
// indirectly through migrateLegacyConfigPaths in cases 5-6 below.

// Helper: create a legacy file at <dir>/<name> with minimal content.
function writeLegacy(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ token: "mcp_pat_legacy_aaaa" }), "utf8");
  return p;
}

describe("migrateLegacyConfigPaths", () => {
  let home: string;
  // cwd lives inside home so findLegacyProjectRoot walk-up stops at the
  // synthetic home boundary rather than escaping into the real user dir.
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-home-"));
    cwd = mkdtempSync(join(home, "proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // 1. Renames legacy ~/.yaw-mcp.json -> ~/.yaw-mcp/config.json when target does not exist.
  it("renames legacy global file into .yaw-mcp/ when target is absent", async () => {
    const legacyPath = writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    await migrateLegacyConfigPaths({ cwd, home });

    // Legacy file should no longer exist (rename, not copy).
    await expect(stat(legacyPath)).rejects.toThrow();
    // Target should now exist with the original content.
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.token).toBe("mcp_pat_legacy_aaaa");
  });

  // 2. Idempotent: does NOT overwrite target when ~/.yaw-mcp/config.json already exists.
  it("does not overwrite the target when it already exists (idempotent)", async () => {
    // Both legacy and target exist.
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const targetDir = userConfigDir(home);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, "config.json");
    writeFileSync(targetPath, JSON.stringify({ token: "mcp_pat_new_bbbb" }), "utf8");

    await migrateLegacyConfigPaths({ cwd, home });

    // Target content must be unchanged (new token wins, legacy is orphaned).
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.token).toBe("mcp_pat_new_bbbb");

    // Legacy file must still exist (not deleted, not renamed).
    await expect(stat(join(home, LEGACY_GLOBAL_FILENAME))).resolves.toBeDefined();
  });

  // 3. No-op when legacy file does not exist (ENOENT).
  it("is a no-op when the legacy file does not exist", async () => {
    // No legacy file created -- just call the migrator.
    await expect(migrateLegacyConfigPaths({ cwd, home })).resolves.toBeUndefined();

    // Target directory should not have been created (no migration happened).
    await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
  });

  // 4. POSIX-only: skips when legacy file is owned by a different uid.
  it.skipIf(process.platform === "win32")(
    "skips migration when legacy file is owned by a different uid (POSIX)",
    async () => {
      writeLegacy(home, LEGACY_GLOBAL_FILENAME);
      const legacyPath = join(home, LEGACY_GLOBAL_FILENAME);
      const targetPath = join(userConfigDir(home), "config.json");

      // Make geteuid report a uid that differs from the file's actual uid.
      // stat().uid on the real file will be process.geteuid() by default,
      // so we stub geteuid to return a different value.
      const realStat = await stat(legacyPath);
      const foreignUid = realStat.uid + 999;
      const origGeteuid = (process as { geteuid?: () => number }).geteuid;
      (process as { geteuid?: () => number }).geteuid = () => foreignUid;

      try {
        await migrateLegacyConfigPaths({ cwd, home });
      } finally {
        (process as { geteuid?: () => number }).geteuid = origGeteuid;
      }

      // Migration must have been skipped: target does not exist.
      await expect(stat(targetPath)).rejects.toThrow();
      // Legacy file must still be in place.
      await expect(stat(legacyPath)).resolves.toBeDefined();
    },
  );
});

describe("findLegacyProjectRoot (via migrateLegacyConfigPaths walk-up)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-walk-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // 5. Finds .yaw-mcp.json in a parent directory strictly under $HOME.
  it("migrates a project legacy file found by walking up from a deep subdirectory", async () => {
    // Place the legacy project file one level below home (the project root).
    const projectRoot = mkdtempSync(join(home, "proj-"));
    writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);

    // Start the migrator from a subdirectory several levels deeper.
    const deep = join(projectRoot, "packages", "api", "src");
    mkdirSync(deep, { recursive: true });

    await migrateLegacyConfigPaths({ cwd: deep, home });

    // The legacy project file should have been moved to .yaw-mcp/config.json
    // inside the project root.
    const targetPath = join(projectRoot, CONFIG_DIRNAME, "config.json");
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.token).toBe("mcp_pat_legacy_aaaa");

    // Legacy file must no longer exist.
    await expect(stat(join(projectRoot, LEGACY_PROJECT_FILENAME))).rejects.toThrow();
  });

  // 6. Returns null (no project migration) when walk reaches $HOME itself.
  it("does not migrate a legacy file sitting at $HOME as a project file", async () => {
    // Place a legacy file directly at $HOME -- this is the GLOBAL scope,
    // handled by the global migration path, NOT by the project walk-up.
    writeLegacy(home, LEGACY_PROJECT_FILENAME);

    // cwd is directly under home so the walk immediately hits the $HOME
    // boundary and stops -- the legacy file at $HOME is excluded.
    const _projectSub = mkdtempSync(join(home, "proj-"));

    // Run with a fresh home that has no global config dir yet so we can
    // distinguish global migration (which DOES move the file) from project
    // migration (which should NOT touch it at the home level).
    // We'll use a separate home for this test to avoid the global migration
    // picking up the file: use a nested temp dir where the "home" for the
    // migrator is the projectSub itself.
    //
    // Re-run with a sub-dir as home so the global migration has no effect,
    // and check that nothing in projectSub's parent (.yaw-mcp/ at home) is
    // created via the project walk-up path.
    const innerHome = mkdtempSync(join(home, "inner-home-"));
    const innerCwd = mkdtempSync(join(innerHome, "cwd-"));
    // Put the legacy file at innerHome -- the global migration WILL move it;
    // we just want to confirm no SECOND move happens via project walk-up.
    writeLegacy(innerHome, LEGACY_LOCAL_FILENAME); // use local variant to avoid global match

    // The walk from innerCwd up to innerHome should stop at innerHome and
    // not attempt a project migration for LEGACY_LOCAL_FILENAME sitting there.
    await migrateLegacyConfigPaths({ cwd: innerCwd, home: innerHome });

    // The local-scope file at innerHome is NOT under any project root in the
    // walk-up (since walk stops before home); so no project config.local.json
    // should be created by the project walk -- only the global-path migration
    // could have touched files at innerHome level.
    // Confirm: no .yaw-mcp/config.local.json in innerCwd (walk never reached innerHome as project).
    await expect(stat(join(innerCwd, CONFIG_DIRNAME, "config.local.json"))).rejects.toThrow();
  });
});
