// ~/.yaw-mcp/ must be BORN owner-only, whichever writer happens to create it.
//
// Every secret-bearing writer passes atomicWriteFile a dirMode of 0o700, and
// atomicWriteFile deliberately never re-chmods a parent that already exists.
// So the two writers that can get there first with a mkdir of their own -- the
// sidecar lock (a server's first state save) and the legacy-config migrator --
// decide the directory's mode for good, and both used to make it at the umask
// default.
//
// Asserted through the ARGUMENTS handed to node:fs, as atomic-write.test.ts
// does: the mode passed to mkdir is the decision this code makes, and Windows
// does not report POSIX bits at all, so stat().mode on the finished directory
// would pin nothing on the platform this suite runs on. mkdir is a passthrough
// spy; everything still happens on a real temp directory.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

import { mkdir } from "node:fs/promises";
import { withFileLock } from "../file-lock.js";
import { LEGACY_GLOBAL_FILENAME, LEGACY_PROJECT_FILENAME, migrateLegacyConfigPaths } from "../migrate.js";
import { CONFIG_DIRNAME, userConfigDir } from "../paths.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-birth-mode-"));
  vi.mocked(mkdir).mockClear();
  vi.stubEnv("LOG_LEVEL", "error");
  vi.stubEnv("YAW_MCP_LOG_LEVEL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** The options mkdir was handed for `dir`, one per call. */
function mkdirOptionsFor(dir: string): unknown[] {
  return vi
    .mocked(mkdir)
    .mock.calls.filter((call) => String(call[0]) === dir)
    .map((call) => call[1]);
}

describe("a config dir created by a non-secret writer is still born 0o700", () => {
  it("withFileLock: the lock's directory, when the lock is what creates it", async () => {
    const dir = userConfigDir(home);
    const target = join(dir, "state.json");
    expect(existsSync(dir)).toBe(false);

    const ran = await withFileLock(
      target,
      {},
      () => "timed out",
      async () => existsSync(`${target}.lock`),
    );

    expect(ran).toBe(true);
    expect(mkdirOptionsFor(dir)).toEqual([{ recursive: true, mode: 0o700 }]);
  });

  it("the migrator: ~/.yaw-mcp/ for the global file", async () => {
    writeFileSync(join(home, LEGACY_GLOBAL_FILENAME), JSON.stringify({ servers: ["a"] }), "utf8");
    const dir = userConfigDir(home);

    await migrateLegacyConfigPaths({ cwd: home, home });

    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(mkdirOptionsFor(dir)).toEqual([{ recursive: true, mode: 0o700 }]);
  });

  it("the migrator: a PROJECT .yaw-mcp/ keeps the default mode", async () => {
    // A project's config dir is shared through the checkout; only the
    // user-global one is the home of the vault and the trust store.
    const project = mkdtempSync(join(home, "proj-"));
    writeFileSync(join(project, LEGACY_PROJECT_FILENAME), JSON.stringify({ servers: ["a"] }), "utf8");
    const dir = join(project, CONFIG_DIRNAME);

    await migrateLegacyConfigPaths({ cwd: project, home });

    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(mkdirOptionsFor(dir)).toEqual([{ recursive: true }]);
  });
});
