import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRunningInstallPrefix, maybeAutoUpgrade } from "../auto-upgrade.js";

// ═══════════════════════════════════════════════════════════════════════
// maybeAutoUpgrade — fire-and-forget startup self-upgrade check.
//
// The registry fetch and the npm spawn are both injected, so these tests
// are pure: they assert WHEN a background `npm install -g` is spawned and
// when it is correctly skipped (dev build, offline, already-current, or
// an install method we won't touch).
// ═══════════════════════════════════════════════════════════════════════

// argv[1] paths that detectInstallMethod (upgrade-cmd.ts) classifies.
// Built with join(), NOT a POSIX literal. detectRunningInstallPrefix matches
// on `${sep}node_modules${sep}`, and the file-level realpathSync mock hands
// this string straight back -- so a literal "/usr/.../node_modules/..." finds
// a prefix on POSIX and finds NOTHING on win32. That skew made the spawn args
// platform-dependent (bare 3-element form here, 5-element --prefix form on
// Linux) and silently green only on Windows. join() makes both platforms
// resolve the prefix, so the expected argv is the same everywhere.
const GLOBAL_NPM_PREFIX = join(sep, "usr", "local");
const GLOBAL_NPM_PATH = join(GLOBAL_NPM_PREFIX, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
/** What maybeAutoUpgrade spawns for a global-npm install whose prefix resolves. */
const GLOBAL_NPM_ARGS = ["install", "-g", "--prefix", GLOBAL_NPM_PREFIX, "@yawlabs/mcp@latest"];
const NPX_PATH = "/home/u/.npm/_npx/abc123/node_modules/@yawlabs/mcp/dist/index.js";
const LOCAL_NODE_MODULES_PATH = "/home/u/myproject/node_modules/@yawlabs/mcp/dist/index.js";
const UNKNOWN_PATH = "/tmp/some/random/launch/path.js";

describe("maybeAutoUpgrade", () => {
  it("does nothing when YAW_MCP_AUTO_UPGRADE=0 (opt-out short-circuits before fetch/spawn)", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "0";
    try {
      const fetchLatestImpl = vi.fn();
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl,
        spawnImpl,
      });
      expect(fetchLatestImpl).not.toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=false also opts out (matches the =0 escape hatch)", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "false";
    try {
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl: async () => "0.47.8",
        spawnImpl,
      });
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=FALSE (uppercase) opts out -- contract is case-insensitive", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "FALSE";
    try {
      const fetchLatestImpl = vi.fn();
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl,
        spawnImpl,
      });
      expect(fetchLatestImpl).not.toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=1 / =true does NOT opt out -- only `0`/`false` disable", async () => {
    // Defends the opt-OUT contract against a user who reads the env var
    // as opt-in and sets `1`/`true` expecting it to enable -- the
    // feature is already on by default, and these values must NOT
    // accidentally suppress it.
    for (const value of ["1", "true", "yes", "on"]) {
      const prev = process.env.YAW_MCP_AUTO_UPGRADE;
      process.env.YAW_MCP_AUTO_UPGRADE = value;
      try {
        const spawnImpl = vi.fn();
        await maybeAutoUpgrade({
          currentVersion: "0.47.0",
          argvPath: GLOBAL_NPM_PATH,
          fetchLatestImpl: async () => "0.47.8",
          spawnImpl,
        });
        expect(spawnImpl, `value=${value} should NOT opt out`).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS);
      } finally {
        if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
        else process.env.YAW_MCP_AUTO_UPGRADE = prev;
      }
    }
  });

  it("does nothing for an unbuilt dev checkout (never fetches or spawns)", async () => {
    const fetchLatestImpl = vi.fn();
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "dev", argvPath: GLOBAL_NPM_PATH, fetchLatestImpl, spawnImpl });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the registry is unreachable (fetch returns null)", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => null,
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when already on the latest version", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.8",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("background-upgrades a stale global-npm install", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS);
  });

  it("background-upgrades stale pnpm/bun globals with their owning tool", async () => {
    const pnpmSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: pnpmSpawn,
    });
    expect(pnpmSpawn).toHaveBeenCalledWith("pnpm", ["add", "-g", "@yawlabs/mcp@latest"]);

    const bunSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: bunSpawn,
    });
    expect(bunSpawn).toHaveBeenCalledWith("bun", ["add", "-g", "@yawlabs/mcp@latest"]);
  });

  it("does NOT spawn for a stale npx install (npx self-heals via the @latest config)", async () => {
    // npx installs are upgraded by the `@yawlabs/mcp@latest` entry that
    // `yaw-mcp install` writes -- there is nothing safe to spawn from here.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: NPX_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a stale local-node-modules install (project owns its own tree)", async () => {
    // If a project has @yawlabs/mcp as a local dep, this process must
    // never run `npm install -g` against the user's environment -- the
    // project's lockfile owns that version. Locks the switch arm in
    // maybeAutoUpgrade so a future refactor can't flip the default.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: LOCAL_NODE_MODULES_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a stale install of unknown method (the catch-all is harmless)", async () => {
    // detectInstallMethod returns "unknown" when argv[1] doesn't match
    // any known pattern. The only spawn arm is gated on "global-npm";
    // this test pins that the unknown fallback logs an info hint and
    // never reaches a spawn, even when latest > current.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: UNKNOWN_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a standalone binary (no package manager to self-upgrade)", async () => {
    // A SEA binary has no package manager; the user replaces the executable.
    // isSeaImpl forces the binary classification regardless of the argv path.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      isSeaImpl: () => true,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("only whitelists `npm install -g @yawlabs/mcp@latest` -- never arbitrary commands", async () => {
    const calls: [string, string[]][] = [];
    await maybeAutoUpgrade({
      currentVersion: "0.40.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: (cmd, args) => calls.push([cmd, args]),
    });
    expect(calls).toEqual([["npm", GLOBAL_NPM_ARGS]]);
  });

  it("does NOT spawn for a stale bundled-app (asar.unpacked) argvPath -- distinct from generic no-spawn cases", async () => {
    // Item 5: auto-upgrade.ts:155 -- the bundled-app branch logs and returns
    // without calling spawnImpl. This is the same surface as npx/local/unknown
    // but the code reaches it through the explicit bundled-app guard at line 155
    // rather than the null-globalSpec fallthrough. Pin that branch explicitly.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// detectRunningInstallPrefix
//
// The function calls realpathSync(argvPath) then walks dirname() up the
// tree looking for a `<sep>node_modules<sep>` segment. We mock
// realpathSync so the tests control exactly what "resolved" path is
// seen, and build all fixture paths with path.join / sep so the
// assertions hold on both Windows (\) and POSIX (/) runners.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn((p: string) => p) };
});

import { realpathSync } from "node:fs";

const mockRealpathSync = vi.mocked(realpathSync);

describe("detectRunningInstallPrefix", () => {
  it("returns the install prefix when argv[1] is inside a node_modules/.bin/ path", () => {
    // e.g. /usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js
    // -> walks up past @yawlabs/mcp/dist, finds node_modules segment
    // -> candidate = /usr/local/lib  (then strips /lib -> /usr/local)
    const argv1 = join(sep, "usr", "local", "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    const result = detectRunningInstallPrefix(argv1);
    // The /lib suffix must be stripped on a Linux-style global path.
    expect(result).toBe(join(sep, "usr", "local"));
  });

  it("returns null when no node_modules segment exists in argv[1]", () => {
    const argv1 = join(sep, "home", "user", "bin", "yaw-mcp");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBeNull();
  });

  it("strips the lib segment on Linux-style global paths", () => {
    // /opt/homebrew/lib/node_modules/@yawlabs/mcp/dist/index.js
    // -> candidate = /opt/homebrew/lib  -> stripped to /opt/homebrew
    const argv1 = join(sep, "opt", "homebrew", "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(join(sep, "opt", "homebrew"));
  });

  it("does NOT strip lib when the path has node_modules but no trailing /lib parent", () => {
    // /home/user/.nvm/versions/node/v20.0.0/node_modules/@yawlabs/mcp/dist/index.js
    // candidate = /home/user/.nvm/versions/node/v20.0.0  -- no /lib suffix, kept as-is
    const argv1 = join(
      sep,
      "home",
      "user",
      ".nvm",
      "versions",
      "node",
      "v20.0.0",
      "node_modules",
      "@yawlabs",
      "mcp",
      "dist",
      "index.js",
    );
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(join(sep, "home", "user", ".nvm", "versions", "node", "v20.0.0"));
  });

  it("returns null when argv[1] is undefined", () => {
    expect(detectRunningInstallPrefix(undefined)).toBeNull();
  });

  it("returns null when the path has more than 24 segments (safety cap)", () => {
    // Build a 26-segment path with no node_modules to exhaust the cap.
    const deepSegments = Array.from({ length: 26 }, (_, i) => `dir${i}`);
    const argv1 = join(sep, ...deepSegments, "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBeNull();
  });

  it("returns null when realpathSync throws (e.g. path does not exist)", () => {
    mockRealpathSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(detectRunningInstallPrefix("/nonexistent/path/index.js")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// runAutoUpgrade (via maybeAutoUpgrade) -- --prefix injection
//
// When detectRunningInstallPrefix returns a prefix that differs from
// what `npm prefix -g` would return, the spawn args must include
// --prefix <dir> so the upgrade lands in the same tree the client
// originally spawned us from.
// ═══════════════════════════════════════════════════════════════════════

describe("runAutoUpgrade: --prefix injection into spawn args", () => {
  it("adds --prefix to npm spawn args when detected prefix differs from the default", async () => {
    // Use a path whose dirname walk hits node_modules so
    // detectRunningInstallPrefix returns a non-null prefix. The mock
    // realpathSync set above returns the path verbatim.
    const customPrefix = join(sep, "opt", "node");
    const argv1 = join(customPrefix, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValue(argv1);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: argv1,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("npm");
    expect(args).toContain("--prefix");
    expect(args).toContain(customPrefix);
    expect(args).toContain("@yawlabs/mcp@latest");
    // Ensure the exact whitelisted shape: install -g --prefix <dir> @yawlabs/mcp@latest
    expect(args).toEqual(["install", "-g", "--prefix", customPrefix, "@yawlabs/mcp@latest"]);

    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: Parameters<typeof mockRealpathSync>[0]) => String(p));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// defaultSpawn + compareWithNpmPrefix + fetchLatestVersion
//
// Everything above injects `spawnImpl` / `fetchLatestImpl`, so the arms
// that only run when a real caller does NOT inject a hook were never
// executed: the actual `spawn()` of `npm install -g` (its options, its
// close/error handling) and the actual registry fetch. Those are the two
// pieces that touch the user's machine at every server start, so they are
// exercised here against a mocked `node:child_process` / `fetch`.
//
// Mocking node:child_process has a second benefit: without it, the
// --prefix test above really did spawn `npm prefix -g` on the test
// machine (compareWithNpmPrefix, unlike upgrade-cmd's defaultNpmPrefix,
// has no `process.env.VITEST` short-circuit) as an unawaited background
// child.
// ═══════════════════════════════════════════════════════════════════════

import type { EventEmitter } from "node:events";

/** Recorder for the mocked spawn. `vi.hoisted` so the object exists before
 *  the hoisted `vi.mock` factory below closes over it. */
const cp = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  children: [] as Array<EventEmitter & { stdout: EventEmitter }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = new EE() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EE();
      cp.calls.push({ cmd, args: [...args], opts: { ...opts } });
      cp.children.push(child);
      return child;
    },
  };
});

// The module logs its outcome rather than returning it, so the log is the
// only observable for the close/error arms of defaultSpawn.
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { log } from "../logger.js";

const mockLog = vi.mocked(log);

/** A realpath with NO node_modules segment: detectRunningInstallPrefix
 *  returns null for it on EVERY platform, so `--prefix` is omitted and the
 *  `npm prefix -g` comparison probe never fires. Built with join/sep
 *  because the walk in detectRunningInstallPrefix keys off `path.sep`. */
const NO_PREFIX_REALPATH = join(sep, "home", "u", "bin", "yaw-mcp");
/** A realpath that DOES yield a prefix on every platform. */
const DETECTED_PREFIX = join(sep, "opt", "node");
const PREFIXED_REALPATH = join(DETECTED_PREFIX, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");

const PNPM_PATH = "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js";
const BUN_PATH = "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js";

/** All `warn`-level log calls, in order. */
function warnCalls(): Array<[string, string, Record<string, unknown> | undefined]> {
  return mockLog.mock.calls.filter((c) => c[0] === "warn") as Array<
    [string, string, Record<string, unknown> | undefined]
  >;
}

function resetSpawnRecorder(): void {
  cp.calls.length = 0;
  cp.children.length = 0;
  mockLog.mockClear();
  mockRealpathSync.mockReset();
  mockRealpathSync.mockImplementation((p: Parameters<typeof mockRealpathSync>[0]) => String(p));
}

describe("defaultSpawn -- the real background upgrade child", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  it("spawns the whitelisted npm command with stdio ignored, NOT detached, shell only on win32", async () => {
    // stdio:"ignore" keeps the child off the MCP stdio transport (a single
    // stray byte on stdout corrupts the JSON-RPC stream); detached:false
    // makes the child die with yaw-mcp instead of outliving it.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("npm");
    expect(cp.calls[0].args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
    expect(cp.calls[0].opts).toMatchObject({
      stdio: "ignore",
      detached: false,
      shell: process.platform === "win32",
    });
  });

  it("logs completion (not a warning) when the child exits 0", async () => {
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    cp.children[0].emit("close", 0);

    expect(mockLog).toHaveBeenCalledWith("info", expect.stringContaining("self-upgrade complete"));
    expect(warnCalls()).toHaveLength(0);
  });

  it("warns with the npm corrective command, the EACCES hint and the opt-out when the child exits non-zero", async () => {
    // stdio is "ignore", so the tool's own error text is unrecoverable --
    // the warning IS the entire diagnostic the user gets. It has to carry
    // the command to run by hand and the way to silence the check.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    cp.children[0].emit("close", 243);

    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("npm install -g @yawlabs/mcp@latest");
    expect(warns[0][1]).toContain("EACCES");
    expect(warns[0][1]).toContain("YAW_MCP_AUTO_UPGRADE=0");
    // The exit code has to survive into the structured field -- it is the
    // only machine-readable part of an otherwise opaque failure.
    expect(warns[0][2]).toEqual({ code: 243 });
  });

  it("warns once on a spawn error, and the close that follows it stays SILENT", async () => {
    // ENOENT fires BOTH "error" and "close". The error handler owns the
    // message (it is the only one that knows what actually happened), so a
    // regression that drops the errorFired guard shows up here as a second,
    // misleading "exited non-zero" warning for the same failure.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    const child = cp.children[0];
    child.emit("error", new Error("spawn npm ENOENT"));
    child.emit("close", 1);

    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("spawn failed");
    expect(warns[0][2]).toEqual({ error: "spawn npm ENOENT" });
  });

  it("names pnpm (not npm) in the corrective command, and drops the sudo/EACCES hint", async () => {
    // The EACCES hint is npm-specific -- pnpm manages its own global store,
    // so telling a pnpm user to fix permissions on an npm prefix is wrong.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: PNPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    // Exactly one spawn: the `npm prefix -g` comparison probe is global-npm
    // only, so a pnpm upgrade must not shell out to npm at all.
    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("pnpm");
    expect(cp.calls[0].args).toEqual(["add", "-g", "@yawlabs/mcp@latest"]);

    cp.children[0].emit("close", 1);
    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("pnpm add -g @yawlabs/mcp@latest");
    expect(warns[0][1]).not.toContain("EACCES");
  });

  it("names bun in the corrective command, and drops the sudo/EACCES hint", async () => {
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: BUN_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("bun");
    expect(cp.calls[0].args).toEqual(["add", "-g", "@yawlabs/mcp@latest"]);

    cp.children[0].emit("close", 1);
    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("bun add -g @yawlabs/mcp@latest");
    expect(warns[0][1]).not.toContain("EACCES");
  });

  it("never computes a --prefix for pnpm/bun -- the flag is npm-only", async () => {
    // detectRunningInstallPrefix WOULD return a prefix for this realpath;
    // the guard is on `method === "global-npm"`, not on the prefix being
    // resolvable. `pnpm add -g --prefix ...` is not a real pnpm flag.
    mockRealpathSync.mockReturnValue(PREFIXED_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: PNPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].args).not.toContain("--prefix");
  });

  it("forwards a detected --prefix VERBATIM as one argv element, spaces and all", async () => {
    // KNOWN ROUGH EDGE, pinned as-is rather than fixed: defaultSpawn passes
    // `shell: true` on win32, and Node builds the cmd.exe command line by
    // joining argv with spaces WITHOUT quoting. A Windows prefix under a
    // username containing a space (`C:\Users\Jeff Smith\AppData\Roaming\npm`)
    // therefore reaches npm as two tokens and the install lands somewhere
    // else -- or fails. This test locks the CURRENT behavior (one unquoted
    // argv element) so a future fix is a deliberate, visible change here.
    const spaced = join(sep, "Users", "Jeff Smith", "AppData", "Roaming", "npm");
    mockRealpathSync.mockReturnValue(join(spaced, "node_modules", "@yawlabs", "mcp", "dist", "index.js"));

    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    // calls[0] is the `npm prefix -g` comparison probe; calls[1] is the install.
    const install = cp.calls[cp.calls.length - 1];
    expect(install.args).toEqual(["install", "-g", "--prefix", spaced, "@yawlabs/mcp@latest"]);
    expect(install.args[3]).toContain(" ");
    expect(install.opts.shell).toBe(process.platform === "win32");
  });
});

describe("compareWithNpmPrefix -- the multi-prefix warning", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSpawnRecorder();
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    resetSpawnRecorder();
  });

  const stderrText = (): string => (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("");

  it("warns on stderr when `npm prefix -g` disagrees with the running-install prefix", async () => {
    mockRealpathSync.mockReturnValue(PREFIXED_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      // Inject the upgrade spawn so the only child_process call recorded
      // here is the comparison probe itself.
      spawnImpl: vi.fn(),
    });

    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("npm");
    expect(cp.calls[0].args).toEqual(["prefix", "-g"]);
    // The probe must not inherit the parent's stdout either -- it pipes so
    // it can read the answer, and ignores stderr.
    expect(cp.calls[0].opts).toMatchObject({ stdio: ["ignore", "pipe", "ignore"] });

    const probe = cp.children[0];
    probe.stdout.emit("data", Buffer.from(`${join(sep, "usr", "local")}\n`));
    probe.emit("close", 0);

    expect(stderrText()).toContain("detected running prefix differs");
    expect(stderrText()).toContain(DETECTED_PREFIX);
    expect(stderrText()).toContain(join(sep, "usr", "local"));
  });

  it("stays quiet when the two prefixes agree", async () => {
    mockRealpathSync.mockReturnValue(PREFIXED_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
    });

    const probe = cp.children[0];
    probe.stdout.emit("data", Buffer.from(`${DETECTED_PREFIX}\n`));
    probe.emit("close", 0);

    expect(stderrText()).not.toContain("detected running prefix differs");
  });

  it("stays quiet (and does not throw) when the probe emits no output or fails to spawn", async () => {
    mockRealpathSync.mockReturnValue(PREFIXED_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
    });

    // No stdout data at all -> npmPrefix is "" -> falsy -> no warning.
    cp.children[0].emit("close", 1);
    expect(stderrText()).not.toContain("detected running prefix differs");

    // And an outright spawn failure resolves the probe instead of leaving
    // an unhandled "error" event on an EventEmitter with no listener.
    cp.calls.length = 0;
    cp.children.length = 0;
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
    });
    expect(() => cp.children[0].emit("error", new Error("ENOENT"))).not.toThrow();
    expect(stderrText()).not.toContain("detected running prefix differs");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// fetchLatestVersion -- the built-in registry probe used when the caller
// injects no fetchLatestImpl. Every failure shape must degrade to "no
// upgrade this session", never to a spawn against a bogus version.
// ═══════════════════════════════════════════════════════════════════════

/** Minimal duck-typed stand-in for the two members fetchLatestVersion uses. */
function fakeResponse(ok: boolean, json: () => Promise<unknown>): Response {
  return { ok, json } as unknown as Response;
}

describe("fetchLatestVersion -- the built-in registry probe", () => {
  beforeEach(resetSpawnRecorder);

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSpawnRecorder();
  });

  it("requests @yawlabs/mcp/latest with an abort signal, and upgrades on a newer version", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers?: Record<string, string>; signal?: AbortSignal }) =>
      fakeResponse(true, async () => ({ version: "0.47.8" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/@yawlabs/mcp/latest");
    expect(init.headers).toEqual({ accept: "application/json" });
    // The 3s AbortController is what keeps a hung registry off the serve
    // hot path; without a signal the check could stall startup indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(spawnImpl).toHaveBeenCalledWith("npm", ["install", "-g", "@yawlabs/mcp@latest"]);
  });

  it.each([
    ["a non-2xx response", () => fakeResponse(false, async () => ({ version: "0.47.8" }))],
    ["a body with no version field", () => fakeResponse(true, async () => ({}))],
    ["a body whose version is not a string", () => fakeResponse(true, async () => ({ version: 47 }))],
    [
      "a body that is not JSON",
      () =>
        fakeResponse(true, async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
    ],
  ])("does not spawn on %s", async (_label, make) => {
    const fetchMock = vi.fn(async () => make());
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
  });

  it("does not spawn (and does not reject) when fetch itself throws -- offline / aborted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    });
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await expect(
      maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl }),
    ).resolves.toBeUndefined();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("YAW_MCP_AUTO_UPGRADE=0 makes NO network call and spawns NO child -- the opt-out is total", async () => {
    // The three existing opt-out tests all inject both hooks, so they can
    // only prove the injected fns went uncalled. This one leaves the real
    // fetch + real spawn in place, which is what a pinned-version or
    // sudo-installed user is actually opting out of.
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "0";
    try {
      const fetchMock = vi.fn(async () => fakeResponse(true, async () => ({ version: "9.9.9" })));
      vi.stubGlobal("fetch", fetchMock);
      mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

      await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(cp.calls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("an unbuilt dev checkout short-circuits before the registry probe", async () => {
    // Same class as the opt-out above: the existing dev-checkout test
    // injects fetchLatestImpl, so it cannot show that the REAL fetch is
    // skipped for a version of "dev".
    const fetchMock = vi.fn(async () => fakeResponse(true, async () => ({ version: "9.9.9" })));
    vi.stubGlobal("fetch", fetchMock);
    await maybeAutoUpgrade({ currentVersion: "dev", argvPath: GLOBAL_NPM_PATH });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
  });
});
