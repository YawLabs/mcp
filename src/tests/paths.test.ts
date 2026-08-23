import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_DIRNAME, cacheDir, findProjectConfigDir, GUIDE_FILENAME, guidePath, userConfigDir } from "../paths.js";

describe("cacheDir", () => {
  const ORIG_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: ORIG_PLATFORM });
    vi.unstubAllEnvs();
  });

  it("uses LOCALAPPDATA on Windows when set", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
    expect(cacheDir()).toMatch(/yaw-mcp[\\/]Cache$/);
    expect(cacheDir().startsWith("C:\\Users\\test\\AppData\\Local")).toBe(true);
  });

  it("falls back to homedir on Windows when LOCALAPPDATA missing", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("LOCALAPPDATA", "");
    expect(cacheDir()).toMatch(/AppData[\\/]Local[\\/]yaw-mcp[\\/]Cache$/);
  });

  it("uses ~/Library/Caches on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(cacheDir()).toMatch(/Library[\\/]Caches[\\/]yaw-mcp$/);
  });

  it("honors XDG_CACHE_HOME on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "/custom/cache");
    // path.join uses the host separator — tests run on Windows during
    // dev, Linux in CI — so match flexibly on "custom/cache/yaw-mcp".
    expect(cacheDir()).toMatch(/custom[\\/]cache[\\/]yaw-mcp$/);
  });

  it("falls back to ~/.cache on linux when XDG_CACHE_HOME missing", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "");
    expect(cacheDir()).toMatch(/\.cache[\\/]yaw-mcp$/);
  });

  it("ignores empty XDG_CACHE_HOME", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "");
    expect(cacheDir()).toMatch(/\.cache[\\/]yaw-mcp$/);
  });
});

describe("userConfigDir", () => {
  it("returns <home>/.yaw-mcp", () => {
    expect(userConfigDir("/home/alice")).toMatch(/^[/\\]home[/\\]alice[/\\]\.yaw-mcp$/);
  });

  it("uses os.homedir() when no arg passed", () => {
    // Just assert the tail — the prefix is whatever the host reports.
    expect(userConfigDir().endsWith(CONFIG_DIRNAME)).toBe(true);
  });
});

describe("guidePath", () => {
  it("returns <dir>/YAW-MCP.md", () => {
    expect(guidePath("/tmp/.yaw-mcp")).toMatch(/[/\\]\.yaw-mcp[/\\]YAW-MCP\.md$/);
  });

  it("uses the GUIDE_FILENAME constant", () => {
    expect(guidePath("/x")).toMatch(new RegExp(`${GUIDE_FILENAME.replace(".", "\\.")}$`));
  });
});

describe("findProjectConfigDir", () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-paths-home-"));
    // Root of the synthetic project tree lives INSIDE `home` so the
    // walk-up terminates at the synthetic `home` boundary rather than
    // escaping past tmpdir into the real user dir — where a real
    // ~/.yaw-mcp/ on dev machines would otherwise get claimed as the
    // project config.
    root = mkdtempSync(join(home, "proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no .yaw-mcp/ exists anywhere up to home", async () => {
    const sub = join(root, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    expect(await findProjectConfigDir(sub, home)).toBeNull();
  });

  it("finds a .yaw-mcp/ at the starting directory", async () => {
    const cfgDir = join(root, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    expect(await findProjectConfigDir(root, home)).toBe(cfgDir);
  });

  it("walks up when started in a deep subdirectory", async () => {
    const cfgDir = join(root, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    const deep = join(root, "pkg", "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfigDir(deep, home)).toBe(cfgDir);
  });

  it("stops BEFORE $HOME — a .yaw-mcp/ in home is NOT returned as a project dir", async () => {
    // .yaw-mcp/ lives at $HOME. That's the user-global scope, handled
    // separately by userConfigDir(). findProjectConfigDir must not
    // claim it, or the config loader would double-load the same file
    // as both project and user-global.
    mkdirSync(join(home, CONFIG_DIRNAME));
    const sub = join(home, "projects", "p1");
    mkdirSync(sub, { recursive: true });
    expect(await findProjectConfigDir(sub, home)).toBeNull();
  });

  it("descends into a directory whose NAME starts with '..'", async () => {
    // Regression: the walk-up bounded itself with `relative(home, dir)`
    // .startsWith(".."), which also matches a real directory named
    // `..config` (relative path "..config/app"). isUnderHome returned false
    // on the very first iteration, so no `.yaw-mcp/` anywhere below such a
    // directory was ever found. Only a literal ".." segment escapes $HOME.
    const project = join(home, "..config", "app");
    mkdirSync(project, { recursive: true });
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    const startFrom = join(project, "src");
    mkdirSync(startFrom);
    expect(await findProjectConfigDir(startFrom, home)).toBe(cfgDir);
  });

  it("prefers the nearest .yaw-mcp/ when multiple exist on the path", async () => {
    mkdirSync(join(root, CONFIG_DIRNAME));
    const innerProject = join(root, "apps", "web");
    mkdirSync(innerProject, { recursive: true });
    const innerCfg = join(innerProject, CONFIG_DIRNAME);
    mkdirSync(innerCfg);
    const startFrom = join(innerProject, "src");
    mkdirSync(startFrom);
    expect(await findProjectConfigDir(startFrom, home)).toBe(innerCfg);
  });

  it("returns null when the start dir IS $HOME (user-global scope, not a project)", async () => {
    // Relaxing the outside-$HOME bound must not turn $HOME itself into a
    // "project": its .yaw-mcp/ is the user-global scope (userConfigDir) and
    // returning it here would double-load it -- and the walk must not then
    // continue up past $HOME either.
    mkdirSync(join(home, CONFIG_DIRNAME));
    expect(await findProjectConfigDir(home, home)).toBeNull();
  });
});

describe("findProjectConfigDir outside $HOME", () => {
  // The project lives OUTSIDE the synthetic $HOME -- a sibling temp dir
  // stands in for a second drive (D:\proj), a container workspace, or an
  // /srv checkout. The old under-$HOME-only bound returned null before
  // probing a single directory, silently disabling project config, the
  // YAW-MCP.md guide, and project bundles for every such checkout. Every
  // test here creates the `.yaw-mcp/` INSIDE the synthetic project tree so
  // the walk finds it (or skips it) before escaping into the real
  // filesystem -- there is deliberately no "returns null with no config
  // anywhere" case, because that walk would run to the real root.
  let home: string;
  let project: string;
  const ORIG_GETEUID = Object.getOwnPropertyDescriptor(process, "geteuid");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-paths-home-"));
    project = mkdtempSync(join(tmpdir(), "yaw-mcp-paths-outside-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (ORIG_GETEUID) Object.defineProperty(process, "geteuid", ORIG_GETEUID);
    else delete (process as { geteuid?: unknown }).geteuid;
  });

  function stubGeteuid(uid: number): void {
    Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true, writable: true });
  }

  it("finds a .yaw-mcp/ at the starting directory of a checkout outside $HOME", async () => {
    // No geteuid stub: on POSIX runners the dir was just created by this
    // process's own user, on win32 there is no geteuid and candidates are
    // accepted as-is -- both take the trusted path for real.
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    expect(await findProjectConfigDir(project, home)).toBe(cfgDir);
  });

  it("walks up within an outside-$HOME tree from a deep subdirectory", async () => {
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    const deep = join(project, "pkg", "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfigDir(deep, home)).toBe(cfgDir);
  });

  it("skips an outside-$HOME .yaw-mcp/ not owned by the current euid", async () => {
    // The trust boundary for the outside-$HOME walk: a planted `.yaw-mcp/`
    // owned by someone else must not be returned. Stubbing geteuid to a
    // sentinel uid nothing on this machine owns makes the mismatch
    // deterministic on every platform (Windows stat reports uid 0).
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubGeteuid(999_999_999);
    expect(await findProjectConfigDir(project, home)).toBeNull();
  });

  it("accepts an outside-$HOME .yaw-mcp/ owned by the current euid", async () => {
    // Companion to the skip case, with geteuid pinned to the uid stat
    // actually reports for the candidate -- proves the gate compares
    // ownership rather than rejecting everything outside $HOME.
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubGeteuid(statSync(cfgDir).uid);
    expect(await findProjectConfigDir(project, home)).toBe(cfgDir);
  });
});
