// The loader's project-is-global guard (config-loader.ts, normalizeDir) must
// case-fold on darwin as well as win32: both default to case-insensitive
// filesystems, so a `home` override spelled in a different case from the
// discovered project dir names the same directory and must not load it twice.
//
// findProjectConfigDir already refuses ~/.yaw-mcp itself, so the guard is only
// reachable when the walk hands back a case variant of the user-global dir.
// It is mocked here to do exactly that, and process.platform is stubbed to
// darwin so the test holds the fold on every host. The project dir exists on
// disk under its own spelling (HOME/), so the test fails on any host if the
// guard stops folding on darwin: the loader would then read it as project.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../paths.js")>();
  return { ...actual, findProjectConfigDir: vi.fn() };
});

import { CONFIG_FILENAME, loadYawMcpConfig } from "../config-loader.js";
import { CONFIG_DIRNAME, findProjectConfigDir } from "../paths.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-proj-is-global-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(findProjectConfigDir).mockReset();
});

describe("loadYawMcpConfig -- project-is-global guard on darwin", () => {
  it("does not load a case-variant spelling of the user-global dir as project config", async () => {
    const projectDir = join(root, "HOME", CONFIG_DIRNAME);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, CONFIG_FILENAME), JSON.stringify({ servers: ["github"] }));
    vi.mocked(findProjectConfigDir).mockResolvedValue(projectDir);

    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await loadYawMcpConfig({ cwd: root, home: join(root, "home"), env: {}, readOnly: true });
      expect(r.projectConfigDir).toBe(projectDir);
      expect(r.loadedFiles.map((f) => f.scope)).not.toContain("project");
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
});
