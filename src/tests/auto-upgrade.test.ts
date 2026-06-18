import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
const GLOBAL_NPM_PATH = "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js";
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
        expect(spawnImpl, `value=${value} should NOT opt out`).toHaveBeenCalledWith("npm", [
          "install",
          "-g",
          "@yawlabs/mcp@latest",
        ]);
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
    expect(spawnImpl).toHaveBeenCalledWith("npm", ["install", "-g", "@yawlabs/mcp@latest"]);
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
    expect(calls).toEqual([["npm", ["install", "-g", "@yawlabs/mcp@latest"]]]);
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
