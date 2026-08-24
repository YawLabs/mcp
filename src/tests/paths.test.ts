import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_UNOWNED_ENV,
  CONFIG_DIRNAME,
  cacheDir,
  findProjectConfigDir,
  GUIDE_FILENAME,
  guidePath,
  isUnderHome,
  userConfigDir,
} from "../paths.js";

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

describe("isUnderHome case folding", () => {
  const ORIG_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: ORIG_PLATFORM });
  });

  it("treats a case-variant spelling of $HOME as the same prefix on darwin", () => {
    // APFS/HFS+ default to case-insensitive, so /users/alice and
    // /Users/Alice are the same directory. Before the darwin fold this
    // returned false, which flipped findProjectConfigDir into the
    // unbounded outside-$HOME walk for a cwd genuinely under $HOME.
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(isUnderHome("/Users/Alice/project", "/users/alice")).toBe(true);
  });

  it("still rejects $HOME itself under darwin folding", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(isUnderHome("/Users/Alice", "/users/alice")).toBe(false);
  });

  it("still rejects a sibling of $HOME under darwin folding", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(isUnderHome("/users/bob/project", "/users/alice")).toBe(false);
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
    // The walk runs on physical paths now, so compare against the
    // realpath — identical on Windows/Linux, but on macOS tmpdir sits
    // behind the /var -> /private/var symlink.
    expect(await findProjectConfigDir(root, home)).toBe(realpathSync(cfgDir));
  });

  it("walks up when started in a deep subdirectory", async () => {
    const cfgDir = join(root, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    const deep = join(root, "pkg", "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfigDir(deep, home)).toBe(realpathSync(cfgDir));
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
    expect(await findProjectConfigDir(startFrom, home)).toBe(realpathSync(cfgDir));
  });

  it("prefers the nearest .yaw-mcp/ when multiple exist on the path", async () => {
    mkdirSync(join(root, CONFIG_DIRNAME));
    const innerProject = join(root, "apps", "web");
    mkdirSync(innerProject, { recursive: true });
    const innerCfg = join(innerProject, CONFIG_DIRNAME);
    mkdirSync(innerCfg);
    const startFrom = join(innerProject, "src");
    mkdirSync(startFrom);
    expect(await findProjectConfigDir(startFrom, home)).toBe(realpathSync(innerCfg));
  });

  it("returns null when the start dir IS $HOME (user-global scope, not a project)", async () => {
    // Relaxing the outside-$HOME bound must not turn $HOME itself into a
    // "project": its .yaw-mcp/ is the user-global scope (userConfigDir) and
    // returning it here would double-load it -- and the walk must not then
    // continue up past $HOME either.
    mkdirSync(join(home, CONFIG_DIRNAME));
    expect(await findProjectConfigDir(home, home)).toBeNull();
  });

  it("skips an under-$HOME project .yaw-mcp/ that is a symlink to the user-global dir", async () => {
    // ~/proj/.yaw-mcp -> ~/.yaw-mcp: the candidate RESOLVES to the
    // user-global scope, so returning it would double-load the same
    // files as both project and global -- the loader's dedupe compares
    // resolve() strings, not realpaths, so the aliasing must be caught
    // here. "junction" makes the link creatable without admin rights on
    // Windows; POSIX ignores the type argument.
    mkdirSync(join(home, CONFIG_DIRNAME));
    symlinkSync(join(home, CONFIG_DIRNAME), join(root, CONFIG_DIRNAME), "junction");
    expect(await findProjectConfigDir(root, home)).toBeNull();
  });
});

describe("findProjectConfigDir with a symlinked $HOME", () => {
  // /home -> /var/home style aliasing (Silverblue, NFS automounts): the
  // logical $HOME spelling differs from the physical cwd prefix, so a
  // lexical-only bound never matches. "junction" makes the link creatable
  // without admin rights on Windows; POSIX ignores the type argument.
  let physHome: string;
  let linkHome: string;

  beforeEach(() => {
    physHome = mkdtempSync(join(tmpdir(), "yaw-mcp-paths-phys-home-"));
    linkHome = `${physHome}-link`;
    symlinkSync(physHome, linkHome, "junction");
  });

  afterEach(() => {
    rmSync(linkHome, { recursive: true, force: true });
    rmSync(physHome, { recursive: true, force: true });
  });

  it("bounds the walk at the physical home when $HOME is spelled via the symlink", async () => {
    // Regression: the lexical bound computed boundedByHome=false (the
    // physical cwd is not textually under the symlinked $HOME), so the
    // outside-$HOME walk climbed into the physical home and returned the
    // user's own ~/.yaw-mcp as PROJECT config -- double-loading it and
    // tripping the project-trust probe on the user's own global file.
    mkdirSync(join(physHome, CONFIG_DIRNAME));
    const proj = join(physHome, "proj");
    mkdirSync(proj);
    expect(await findProjectConfigDir(proj, linkHome)).toBeNull();
  });

  it("still finds a project .yaw-mcp/ under the physical home when $HOME is the symlinked spelling", async () => {
    const proj = join(physHome, "proj");
    const cfgDir = join(proj, CONFIG_DIRNAME);
    mkdirSync(cfgDir, { recursive: true });
    expect(await findProjectConfigDir(proj, linkHome)).toBe(realpathSync(cfgDir));
  });

  it("resolves a symlink-spelled START against the physical home", async () => {
    // The converse skew: cwd arrives in the symlinked spelling while
    // $HOME is physical. The realpath'd start lands under home, so the
    // bounded walk applies and the project config is still found.
    const proj = join(physHome, "proj");
    const cfgDir = join(proj, CONFIG_DIRNAME);
    mkdirSync(cfgDir, { recursive: true });
    expect(await findProjectConfigDir(join(linkHome, "proj"), physHome)).toBe(realpathSync(cfgDir));
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
    vi.unstubAllEnvs();
  });

  function stubGeteuid(uid: number): void {
    Object.defineProperty(process, "geteuid", { value: () => uid, configurable: true, writable: true });
  }

  // Simulates the win32 runtime shape, where process.geteuid does not
  // exist and ownership of an outside-$HOME candidate is unverifiable.
  function stubNoGeteuid(): void {
    Object.defineProperty(process, "geteuid", { value: undefined, configurable: true, writable: true });
  }

  it("finds a .yaw-mcp/ at the starting directory of a checkout outside $HOME", async () => {
    // geteuid is pinned to the uid stat actually reports for the
    // candidate: on POSIX runners that is this process's own uid; on
    // win32 (no native geteuid, stat reports uid 0) the stub makes the
    // same ownership gate pass deterministically.
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubGeteuid(statSync(cfgDir).uid);
    expect(await findProjectConfigDir(project, home)).toBe(realpathSync(cfgDir));
  });

  it("walks up within an outside-$HOME tree from a deep subdirectory", async () => {
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubGeteuid(statSync(cfgDir).uid);
    const deep = join(project, "pkg", "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfigDir(deep, home)).toBe(realpathSync(cfgDir));
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
    expect(await findProjectConfigDir(project, home)).toBe(realpathSync(cfgDir));
  });

  it("rejects an outside-$HOME .yaw-mcp/ when ownership is unverifiable (win32 model)", async () => {
    // With no geteuid there is no ownership check at all, and shared
    // Windows locations (UNC shares, Public-style dirs, non-system
    // volume roots) are often writable by any authenticated user -- a
    // planted `.yaw-mcp/` there must not be trusted by default.
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubNoGeteuid();
    vi.stubEnv(ALLOW_UNOWNED_ENV, "");
    expect(await findProjectConfigDir(project, home)).toBeNull();
  });

  it("honours the explicit env opt-in when ownership is unverifiable (win32 model)", async () => {
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubNoGeteuid();
    vi.stubEnv(ALLOW_UNOWNED_ENV, "1");
    expect(await findProjectConfigDir(project, home)).toBe(realpathSync(cfgDir));
  });

  it("does not let the env opt-in bypass a real POSIX ownership mismatch", async () => {
    // The opt-in exists only for platforms with NO ownership probe; where
    // geteuid exists, a uid mismatch stays fatal regardless of the env.
    const cfgDir = join(project, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    stubGeteuid(999_999_999);
    vi.stubEnv(ALLOW_UNOWNED_ENV, "1");
    expect(await findProjectConfigDir(project, home)).toBeNull();
  });

  it("skips an outside-$HOME .yaw-mcp/ that resolves to the user-global dir and keeps walking", async () => {
    // A symlink inside the project tree pointing at ~/.yaw-mcp must not be
    // claimed as PROJECT config (that would double-load the user-global
    // scope); the walk skips it and may still find a real config above.
    const globalCfg = join(home, CONFIG_DIRNAME);
    mkdirSync(globalCfg);
    const outerCfg = join(project, CONFIG_DIRNAME);
    mkdirSync(outerCfg);
    const inner = join(project, "sub");
    mkdirSync(inner);
    symlinkSync(globalCfg, join(inner, CONFIG_DIRNAME), "junction");
    stubGeteuid(statSync(outerCfg).uid);
    expect(await findProjectConfigDir(inner, home)).toBe(realpathSync(outerCfg));
  });
});
