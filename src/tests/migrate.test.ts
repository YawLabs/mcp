import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // 4. The owner check itself: a legacy file whose uid is not ours is left
  //    alone rather than hoisted into ~/.yaw-mcp/, where the loader trusts it.
  //
  //    migrateFile gates this on `process.platform !== "win32"` (Windows has
  //    no geteuid and a different ACL model) and reads process.platform at CALL
  //    time, so the decision is reachable from any runner: report a POSIX
  //    platform, then hand it a geteuid that disagrees with the file's stat().
  //    Both halves are stubs of things the OS supplies, not of the code under
  //    test -- what runs is the real comparison and the real skip.
  it("skips migration when the legacy file is owned by a different uid", async () => {
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const legacyPath = join(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    // stat().uid on the real file is the current user's (0 where the platform
    // does not report one), so a geteuid that differs is a foreign owner.
    const realStat = await stat(legacyPath);
    const foreignUid = realStat.uid + 999;
    const origGeteuid = (process as { geteuid?: () => number }).geteuid;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    (process as { geteuid?: () => number }).geteuid = () => foreignUid;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      (process as { geteuid?: () => number }).geteuid = origGeteuid;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }

    // Migration must have been skipped: target does not exist.
    await expect(stat(targetPath)).rejects.toThrow();
    // Legacy file must still be in place.
    await expect(stat(legacyPath)).resolves.toBeDefined();
  });

  // The other half of the same branch: a MATCHING uid must still migrate.
  // Without this, "skipped" above would pass just as happily against a
  // migrator that had stopped migrating anything at all.
  it("still migrates when the legacy file's uid IS ours", async () => {
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const legacyPath = join(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    const realStat = await stat(legacyPath);
    const origGeteuid = (process as { geteuid?: () => number }).geteuid;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    (process as { geteuid?: () => number }).geteuid = () => realStat.uid;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      (process as { geteuid?: () => number }).geteuid = origGeteuid;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }

    await expect(stat(targetPath)).resolves.toBeDefined();
    await expect(stat(legacyPath)).rejects.toThrow();
  });

  // 9. A symlinked legacy path is left alone: the inode the trust check
  //    covered (stat follows) was never the one rename() would have moved.
  it("skips a legacy file that is a symlink instead of moving the link", async () => {
    // The old code stat'ed (following the link) for the ownership decision and
    // then renamed the LINK, so the file it vetted and the file it moved were
    // different inodes -- and a relative link target dangles once the link
    // lands one directory deeper inside .yaw-mcp/.
    const realDir = mkdtempSync(join(home, "real-"));
    const realFile = writeLegacy(realDir, "actual-config.json");
    const linkPath = join(home, LEGACY_GLOBAL_FILENAME);
    try {
      symlinkSync(realFile, linkPath, "file");
    } catch {
      return; // symlink creation unavailable (unelevated Windows); nothing to pin
    }
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    // The link is still a link, still where it was...
    await expect(lstat(linkPath)).resolves.toMatchObject({});
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    // ...nothing was hoisted into ~/.yaw-mcp/, and the target is untouched.
    await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
    await expect(stat(realFile)).resolves.toBeDefined();
    // The skip is visible, not silent.
    expect(warns.join("")).toContain("legacy path is a symlink");
  });

  // 10. `.yaw-mcp.local.json` AT $HOME: no new-layout home, so it is left in
  //     place -- but the drop is announced instead of silent.
  it("warns about a legacy machine-local file sitting at $HOME instead of dropping it silently", async () => {
    // The loader's local scope is per-project and the project walk stops
    // strictly before $HOME, so this file becomes unread on upgrade with
    // nothing anywhere saying so.
    const legacyAtHome = writeLegacy(home, LEGACY_LOCAL_FILENAME);
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    const out = warns.join("");
    expect(out).toContain("legacy machine-local file at $HOME has no new location");
    // Non-destructive: the file stays put and nothing was written under
    // ~/.yaw-mcp/ on its behalf.
    await expect(stat(legacyAtHome)).resolves.toBeDefined();
    await expect(stat(join(userConfigDir(home), "config.local.json"))).rejects.toThrow();
  });
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

  // 5b. Regression: the walk-up must not stop at a directory whose NAME
  // starts with "..". migrate.ts once carried its own isUnderHome with a
  // bare `startsWith("..")` bound, so relative(home, dir) = "..config/app"
  // read as "escaped $HOME" and a legacy file under `~/..config/` was
  // discoverable by the loader but never migrated -- silent config loss.
  // The predicate is now shared with paths.ts (anchored on a separator).
  it("migrates a legacy file under a directory whose name starts with '..'", async () => {
    const projectRoot = join(home, "..config", "app");
    mkdirSync(projectRoot, { recursive: true });
    writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);
    const deep = join(projectRoot, "src");
    mkdirSync(deep, { recursive: true });

    await migrateLegacyConfigPaths({ cwd: deep, home });

    const targetPath = join(projectRoot, CONFIG_DIRNAME, "config.json");
    const { readFile } = await import("node:fs/promises");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.token).toBe("mcp_pat_legacy_aaaa");
    await expect(stat(join(projectRoot, LEGACY_PROJECT_FILENAME))).rejects.toThrow();
  });

  // 6. Returns null (no project migration) when the walk reaches $HOME itself.
  it("does not migrate a legacy file sitting at $HOME as a project file", async () => {
    // `.yaw-mcp.local.json` at $HOME. The local variant is deliberate: the
    // global migration only handles `.yaw-mcp.json`, so the ONLY code path
    // that could touch this file is the project walk-up -- which must stop
    // strictly before $HOME.
    const innerHome = mkdtempSync(join(home, "inner-home-"));
    const innerCwd = mkdtempSync(join(innerHome, "cwd-"));
    const legacyAtHome = writeLegacy(innerHome, LEGACY_LOCAL_FILENAME);

    await migrateLegacyConfigPaths({ cwd: innerCwd, home: innerHome });

    // A regressed guard would treat innerHome as the project root and write
    // innerHome/.yaw-mcp/config.local.json -- assert against THAT path, not
    // innerCwd's (which the walker could never have picked as the root,
    // making the old assertion vacuous).
    await expect(stat(join(innerHome, CONFIG_DIRNAME, "config.local.json"))).rejects.toThrow();
    // ...and the legacy file is still sitting untouched at $HOME.
    await expect(stat(legacyAtHome)).resolves.toBeDefined();
  });

  // 7. No-op when cwd is OUTSIDE $HOME entirely.
  it("is a no-op when cwd is outside $HOME (no walk to the filesystem root)", async () => {
    // A cwd outside $HOME used to send the walker all the way to the
    // filesystem root, destructively renaming any `.yaw-mcp.json` it passed
    // -- hoisting files from unrelated ancestors (a shared /tmp, `/`).
    // The loader now walks outside $HOME too (ownership-gated), but the
    // DESTRUCTIVE migrator deliberately stays strictly under $HOME: legacy
    // files out there are left in place for the user to move by hand.
    const outside = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-outside-"));
    try {
      const legacyProject = writeLegacy(outside, LEGACY_PROJECT_FILENAME);
      const legacyLocal = writeLegacy(outside, LEGACY_LOCAL_FILENAME);

      await migrateLegacyConfigPaths({ cwd: outside, home });

      // Both legacy files stay exactly where they are...
      await expect(stat(legacyProject)).resolves.toBeDefined();
      await expect(stat(legacyLocal)).resolves.toBeDefined();
      // ...and no `.yaw-mcp/` was created out there.
      await expect(stat(join(outside, CONFIG_DIRNAME))).rejects.toThrow();
      // The synthetic $HOME is untouched too (nothing was hoisted into it).
      await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // 8. A symlinked $HOME spelling still migrates (realpath'd bound).
  it("migrates when $HOME is passed via a symlinked spelling of the same directory", async () => {
    // Production shape: HOME is the logical spelling (/home/u) while
    // process.cwd() reports the physical path (/var/home/u) -- symlinked
    // homes, NFS automounts. findLegacyProjectRoot used to compare the two
    // lexically, so the first isUnderHome test failed and pre-0.12 project
    // configs were silently never migrated. Both inputs are realpath'd now
    // (the same treatment findProjectConfigDir gives the loader). The link
    // is a directory junction so the fixture works unelevated on Windows;
    // on POSIX symlinkSync ignores the type hint.
    const linkParent = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-link-"));
    const homeLink = join(linkParent, "home-link");
    try {
      symlinkSync(home, homeLink, "junction");
    } catch {
      rmSync(linkParent, { recursive: true, force: true });
      return; // symlink creation unavailable in this environment; nothing to pin
    }
    try {
      const projectRoot = mkdtempSync(join(home, "proj-"));
      const legacyPath = writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);

      // home via the LINK, cwd via the PHYSICAL path -- lexically disjoint.
      await migrateLegacyConfigPaths({ cwd: projectRoot, home: homeLink });

      // Migrated: legacy renamed into the project's .yaw-mcp/.
      await expect(stat(legacyPath)).rejects.toThrow();
      await expect(stat(join(projectRoot, CONFIG_DIRNAME, "config.json"))).resolves.toBeDefined();
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });
});
