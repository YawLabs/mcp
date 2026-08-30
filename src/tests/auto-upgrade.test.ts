import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireUpgradeLock,
  detectRunningInstallPrefix,
  maybeAutoUpgrade,
  quoteArgForDisplay,
  quoteShellArgIfNeeded,
} from "../auto-upgrade.js";

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
/** maybeAutoUpgrade now hands the spawn a third argument -- the callback that
 *  releases the prefix lockfile once the install settles. Every spawn
 *  assertion has to account for it; the identity of the function is an
 *  implementation detail, its PRESENCE is the contract. */
const RELEASE_LOCK = expect.any(Function);
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
        expect(spawnImpl, `value=${value} should NOT opt out`).toHaveBeenCalledWith(
          "npm",
          GLOBAL_NPM_ARGS,
          RELEASE_LOCK,
        );
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
    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS, RELEASE_LOCK);
  });

  it("background-upgrades stale pnpm/bun globals with their owning tool", async () => {
    const pnpmSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: pnpmSpawn,
    });
    expect(pnpmSpawn).toHaveBeenCalledWith("pnpm", ["add", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);

    const bunSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: bunSpawn,
    });
    expect(bunSpawn).toHaveBeenCalledWith("bun", ["add", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);
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
// The function calls realpathSync(argvPath) then takes the LAST
// `<sep>node_modules<sep>` segment of its dirname (a bare node_modules
// segment -- no `.bin` directory is involved). We mock
// realpathSync so the tests control exactly what "resolved" path is
// seen, and build all fixture paths with path.join / sep so the
// assertions hold on both Windows (\) and POSIX (/) runners.
// ═══════════════════════════════════════════════════════════════════════

// Only realpathSync is stubbed -- the rest of node:fs stays real, which is
// what lets the lockfile suite below run against a genuine temp directory.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn((p: string) => p) };
});

import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";

const mockRealpathSync = vi.mocked(realpathSync);

describe("detectRunningInstallPrefix", () => {
  it("returns the install prefix when argv[1] is inside a node_modules tree", () => {
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

  it("returns null for a path with no node_modules segment, however deep", () => {
    // This replaces a test that claimed to pin a 24-segment "safety cap". The
    // cap never had an observable effect -- lastIndexOf scans the whole string,
    // so depth cannot hide a node_modules segment -- and the old fixture had no
    // node_modules in it at all, so it pinned the plain not-found null it still
    // pins here. The cap is gone; this is the behavior that was actually real.
    const deepSegments = Array.from({ length: 26 }, (_, i) => `dir${i}`);
    const argv1 = join(sep, ...deepSegments, "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBeNull();
  });

  it("resolves the prefix of an install nested far deeper than the old 24-segment cap", () => {
    // The counterpart the old cap test could never express: a REAL deep
    // install still resolves, because the match is on the segment, not depth.
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const prefix = join(sep, ...deep);
    const argv1 = join(prefix, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(prefix);
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

describe("quoteArgForDisplay -- paste-safe quoting for PRINTED command lines", () => {
  // Both platforms are pinned explicitly: the helper's job is that a printed
  // suggestion pastes as ONE token in the user's shell, which the spawn-side
  // quoteShellArgIfNeeded deliberately does NOT guarantee on POSIX (there the
  // spawn argv must stay raw -- no shell is involved).
  it("POSIX: passes shell-inert values through raw", () => {
    expect(quoteArgForDisplay("/usr/local", "linux")).toBe("/usr/local");
    expect(quoteArgForDisplay("/opt/node-22.1_x64/lib", "darwin")).toBe("/opt/node-22.1_x64/lib");
  });

  it("POSIX: single-quotes whitespace so the paste can't split into two tokens", () => {
    expect(quoteArgForDisplay("/Users/j/My Tools", "darwin")).toBe("'/Users/j/My Tools'");
    expect(quoteArgForDisplay("/home/j/a\tb", "linux")).toBe("'/home/j/a\tb'");
  });

  it("POSIX: single-quotes shell metacharacters, escaping embedded single quotes", () => {
    expect(quoteArgForDisplay("/home/j/$HOME-ish", "linux")).toBe("'/home/j/$HOME-ish'");
    // The standard '\'' dance: close, escaped literal quote, reopen.
    expect(quoteArgForDisplay("/Users/j/it's here", "darwin")).toBe("'/Users/j/it'\\''s here'");
  });

  it("win32: is byte-identical to quoteShellArgIfNeeded (the printed line must match the shell:true argv join)", () => {
    for (const arg of ["C:\\npm", "C:\\Users\\Jeff Smith\\AppData\\Roaming\\npm", 'C:\\bad"quote', "C:\\pct%path"]) {
      expect(quoteArgForDisplay(arg, "win32")).toBe(quoteShellArgIfNeeded(arg, "win32"));
    }
    expect(quoteArgForDisplay("C:\\Users\\Jeff Smith\\npm", "win32")).toBe('"C:\\Users\\Jeff Smith\\npm"');
    expect(quoteArgForDisplay('C:\\bad"quote', "win32")).toBeNull();
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
// The `npm prefix -g` comparison probe does NOT appear in cp.calls: it now
// routes through upgrade-cmd's shared npmGlobalPrefix, which short-circuits
// to null under `process.env.VITEST` so no unit test ever spawns a real npm.
// Tests that need the probe to answer inject `npmPrefixImpl` instead (see the
// compareWithNpmPrefix block below).
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

  it("quotes a --prefix containing a space for the win32 shell, passes it through on POSIX", async () => {
    // Regression guard. defaultSpawn passes `shell: true` on win32 (npm is
    // npm.cmd and Node will not spawn a .cmd without a shell), and Node builds
    // the cmd.exe command line by joining argv on spaces WITHOUT quoting. An
    // unquoted prefix under a username with a space therefore reached npm as
    // TWO tokens -- `--prefix C:\Users\Jeff` plus a stray positional -- so the
    // install landed in the wrong tree and the running copy stayed stale: the
    // exact silent no-op `--prefix` exists to prevent. And
    // C:\Users\<First Last>\AppData\Roaming\npm is npm's DEFAULT Windows
    // global prefix, so this was not an edge case.
    const spaced = join(sep, "Users", "Jeff Smith", "AppData", "Roaming", "npm");
    mockRealpathSync.mockReturnValue(join(spaced, "node_modules", "@yawlabs", "mcp", "dist", "index.js"));

    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    // The comparison probe never reaches child_process under vitest, so the
    // install is the only recorded spawn.
    expect(cp.calls).toHaveLength(1);
    const install = cp.calls[cp.calls.length - 1];
    const onWin32 = process.platform === "win32";
    // Quoted only where a shell actually parses it. On POSIX the arg goes
    // through execve untouched and quoting would put literal quotes in the path.
    const expected = onWin32 ? `"${spaced}"` : spaced;
    expect(install.args).toEqual(["install", "-g", "--prefix", expected, "@yawlabs/mcp@latest"]);
    expect(install.opts.shell).toBe(onWin32);
    // The structured log field carries the RAW path, never the quoted argv
    // form: a log field is read by a human and stray quotes read as part of
    // the path. Only the spawn argv is quoted.
    expect(mockLog).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("upgrading the global install"),
      expect.objectContaining({ prefix: spaced }),
    );
  });

  it("drops --prefix entirely when the path cannot be safely quoted on win32", async () => {
    // A `"` or `%` cannot be quoted for cmd.exe -- a quote ends the quoted run
    // and %VAR% expands even inside quotes. Emitting a mangled command line is
    // worse than falling back to npm's own prefix resolution, so the flag is
    // dropped rather than guessed at. POSIX has no such restriction.
    const nasty = join(sep, "Users", 'we"ird%USERNAME%', "AppData", "Roaming", "npm");
    mockRealpathSync.mockReturnValue(join(nasty, "node_modules", "@yawlabs", "mcp", "dist", "index.js"));

    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    const install = cp.calls[cp.calls.length - 1];
    if (process.platform === "win32") {
      expect(install.args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
    } else {
      expect(install.args).toEqual(["install", "-g", "--prefix", nasty, "@yawlabs/mcp@latest"]);
    }
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
    // Put the realpath mock back to the file-level factory default (identity)
    // so a per-test mapping installed by runWithProbe cannot leak into the
    // suites below.
    mockRealpathSync.mockImplementation((p) => String(p));
  });

  const stderrText = (): string => (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("");

  /** The comparison is fire-and-forget (`void compareWithNpmPrefix(...)`), so
   *  maybeAutoUpgrade resolves before the probe's continuation writes to
   *  stderr. Drain the microtask + immediate queues before asserting. */
  const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

  /** Every case here needs the same three things: a resolvable prefix, an
   *  injected upgrade spawn (so no real npm install is recorded), and an
   *  injected `npm prefix -g` answer -- the shared probe short-circuits to null
   *  under vitest, so the real one can never answer here. */
  async function runWithProbe(npmPrefixImpl: () => Promise<string | null>, realpath = PREFIXED_REALPATH) {
    // Map ONLY argv[1] to its resolved install path; every other path resolves
    // to itself. compareWithNpmPrefix now realpaths BOTH sides through
    // upgrade-cmd's comparablePath, so a blanket mockReturnValue would collapse
    // the two prefixes onto one string and no comparison could ever differ.
    mockRealpathSync.mockImplementation((p) => (p === GLOBAL_NPM_PATH ? realpath : String(p)));
    const probe = vi.fn(npmPrefixImpl);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: probe,
    });
    await settle();
    return probe;
  }

  it("warns on stderr when `npm prefix -g` disagrees with the running-install prefix", async () => {
    const other = join(sep, "usr", "local");
    const probe = await runWithProbe(async () => other);

    expect(probe).toHaveBeenCalledTimes(1);
    // No `npm prefix -g` child: the probe is upgrade-cmd's shared helper, which
    // never spawns under vitest. The only spawn arm here is injected too.
    expect(cp.calls).toHaveLength(0);
    expect(stderrText()).toContain("detected running prefix differs");
    expect(stderrText()).toContain(DETECTED_PREFIX);
    expect(stderrText()).toContain(other);
  });

  it("stays quiet when the two prefixes agree", async () => {
    await runWithProbe(async () => DETECTED_PREFIX);
    expect(stderrText()).not.toContain("detected running prefix differs");
  });

  it("stays quiet when the probe cannot answer (spawn failure / non-zero exit / 3s timeout)", async () => {
    // All three failure shapes collapse to null in npmGlobalPrefix, and null
    // must skip the warning rather than compare against an empty string.
    await runWithProbe(async () => null);
    expect(stderrText()).not.toContain("detected running prefix differs");
    // Blank output is the same non-answer.
    await runWithProbe(async () => "   ");
    expect(stderrText()).not.toContain("detected running prefix differs");
  });

  it("compares the RAW prefix, not the shell-quoted argv form", async () => {
    // Regression guard for the spaced-username case. The prefix handed to the
    // spawn is quoted for cmd.exe (`"C:\Users\Jeff Smith\..."`); comparing THAT
    // against npm's unquoted answer can never match, so every startup on npm's
    // DEFAULT Windows global prefix warned about a multi-prefix setup the user
    // does not have. Real assertion on win32; on POSIX quoting is a no-op, so
    // the case is trivially true there and the test just documents intent.
    const spaced = join(sep, "Users", "Jeff Smith", "AppData", "Roaming", "npm");
    const realpath = join(spaced, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    await runWithProbe(async () => spaced, realpath);
    expect(stderrText()).not.toContain("detected running prefix differs");

    // And when they genuinely differ, the message shows the raw path -- a
    // diagnostic with stray quotes in it reads as part of the filename.
    await runWithProbe(async () => join(sep, "opt", "node"), realpath);
    expect(stderrText()).toContain("detected running prefix differs");
    expect(stderrText()).toContain(spaced);
    expect(stderrText()).not.toContain('"');
  });

  it("treats a case-differing prefix as the SAME prefix on win32 (and as different on POSIX)", async () => {
    // Windows paths are case-insensitive, so npm reporting a lowercased prefix
    // is not a multi-prefix setup. POSIX paths are case-sensitive, so there the
    // difference is real and must still warn.
    await runWithProbe(async () => DETECTED_PREFIX.toUpperCase());
    if (process.platform === "win32") {
      expect(stderrText()).not.toContain("detected running prefix differs");
    } else {
      expect(stderrText()).toContain("detected running prefix differs");
    }
  });

  it("treats a junction/symlink prefix and its target as the SAME prefix", async () => {
    // The regression this exists for: the comparator used to trim+lowercase
    // only, while the detected prefix comes from a REALPATH-resolved argv[1].
    // On a scoop-style layout (`.../current` is a junction into `.../1.2.3`)
    // npm reports the junction name and the walk reports the target, so the
    // two names for ONE directory read as two prefixes and every stale startup
    // warned about a multi-prefix setup the user does not have. Both sides now
    // go through upgrade-cmd's comparablePath, which realpaths first.
    const junction = join(sep, "scoop", "apps", "nodejs", "current");
    const target = join(sep, "scoop", "apps", "nodejs", "22.1.0");
    const realpath = join(target, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockImplementation((p) => {
      if (p === GLOBAL_NPM_PATH) return realpath;
      if (p === junction) return target; // the junction resolves to its target
      return String(p);
    });
    const probe = vi.fn(async () => junction);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: probe,
    });
    await settle();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(stderrText()).not.toContain("detected running prefix differs");
  });

  it("still warns when two prefixes resolve to genuinely different directories", async () => {
    // The other half of the realpath change: resolving must not swallow a
    // REAL multi-prefix setup, which is the whole point of the warning.
    // Not DETECTED_PREFIX, and not a junction into it -- a second real tree.
    const other = join(sep, "usr", "local");
    mockRealpathSync.mockImplementation((p) => (p === GLOBAL_NPM_PATH ? PREFIXED_REALPATH : String(p)));
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: async () => other,
    });
    await settle();

    expect(stderrText()).toContain("detected running prefix differs");
    expect(stderrText()).toContain(other);
  });

  it("never probes when the prefix could not be quoted (no --prefix was passed)", async () => {
    // With the flag dropped, npm resolves its own prefix -- so the warning's
    // claim ("installing into the running prefix") would be false, and the
    // probe is skipped entirely rather than emitting a misleading diagnostic.
    const nasty = join(sep, "Users", 'we"ird%USERNAME%', "AppData", "Roaming", "npm");
    const probe = await runWithProbe(
      async () => join(sep, "opt", "node"),
      join(nasty, "node_modules", "@yawlabs", "mcp", "dist", "index.js"),
    );
    if (process.platform === "win32") {
      expect(probe).not.toHaveBeenCalled();
      expect(stderrText()).not.toContain("detected running prefix differs");
    } else {
      // POSIX has no unquotable path, so the prefix survives and the probe runs.
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Stale-install advice for the methods nothing can be spawned for. The log
// IS the whole user-facing surface here, so the text is the contract: it has
// to name a command that actually works for that method.
// ═══════════════════════════════════════════════════════════════════════

describe("maybeAutoUpgrade -- advice for the non-spawnable methods", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  /** The single "out of date" info log, asserted to be the only one. */
  function adviceLog(): [string, string, Record<string, unknown> | undefined] {
    const infos = mockLog.mock.calls.filter((c) => c[0] === "info" && String(c[1]).includes("out of date"));
    expect(infos).toHaveLength(1);
    return infos[0] as [string, string, Record<string, unknown> | undefined];
  }

  async function adviseFor(argvPath: string): Promise<[string, string, Record<string, unknown> | undefined]> {
    mockRealpathSync.mockReturnValue(argvPath);
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath, fetchLatestImpl: async () => "0.47.8", spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
    return adviceLog();
  }

  it("points a local-node-modules install at `upgrade --run`, which really can upgrade it", async () => {
    // upgrade-cmd builds a runSpec for local-node-modules (npm install in the
    // tree root), so --run is honest advice here.
    const [, message, fields] = await adviseFor(LOCAL_NODE_MODULES_PATH);
    expect(message).toContain("yaw-mcp upgrade --run");
    // The old wording called a project's node_modules tree a "global".
    expect(message).not.toContain("global");
    expect(fields).toMatchObject({ method: "local-node-modules" });
  });

  it("points an unknown install at plain `upgrade` -- `--run` always exits 2 there", async () => {
    // runUpgrade leaves runSpec null for unknown, so --run hits the "can't be
    // upgraded automatically" arm and exits 2. Advertising it was a dead end
    // (a bunx launch, say: its path has no node_modules segment at all).
    const [, message, fields] = await adviseFor(UNKNOWN_PATH);
    expect(message).toContain("yaw-mcp upgrade");
    // The dead-end instruction is what must be gone: `--run` may only appear as
    // the thing that CANNOT work, never as the command to type.
    expect(message).not.toContain("yaw-mcp upgrade --run");
    expect(message).toContain("can't automate");
    expect(fields).toMatchObject({ method: "unknown" });
  });

  it("points a dev-checkout install at plain `upgrade` too (same exit-2 arm)", async () => {
    const [, message, fields] = await adviseFor("/home/u/yaw-mcp/dist/index.js");
    expect(message).not.toContain("yaw-mcp upgrade --run");
    expect(fields).toMatchObject({ method: "dev-checkout" });
  });

  it("never spawns `npm install -g --prefix <repo>/packages` for a workspace package named `lib`", async () => {
    // The bare `/lib/node_modules/` marker classified this as global-npm, and
    // detectRunningInstallPrefix strips the trailing `/lib` -- so the background
    // child became `npm install -g --prefix <repo>/packages`, writing a global
    // tree plus bin shims into the user's repo over the workspace-pinned copy.
    const [, , fields] = await adviseFor("/home/u/repo/packages/lib/node_modules/@yawlabs/mcp/dist/index.js");
    expect(fields).toMatchObject({ method: "local-node-modules" });
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
    expect(spawnImpl).toHaveBeenCalledWith("npm", ["install", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);
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

// ═══════════════════════════════════════════════════════════════════════
// acquireUpgradeLock -- the prefix lockfile that serializes concurrent
// background installs.
//
// The realistic trigger is N Claude Code panes starting at once: each serve
// process independently detects the same staleness and, before the lock,
// each fired its own `npm install -g` into the same prefix. npm's cache lock
// made that slow rather than corrupting, but nothing made it SAFE.
//
// These run against a real temp directory (node:fs is only stubbed for
// realpathSync), because the whole primitive is openSync(path, "wx") and a
// mocked fs would test the mock.
// ═══════════════════════════════════════════════════════════════════════

describe("acquireUpgradeLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lockFile = (): string => join(dir, ".yaw-mcp-upgrade.lock");

  it("hands the first caller a release and refuses the second", () => {
    const first = acquireUpgradeLock(dir);
    expect(first).toBeTypeOf("function");
    expect(existsSync(lockFile())).toBe(true);

    // The second serve process starting against the same prefix.
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("frees the lock on release so the next process can take it", () => {
    const release = acquireUpgradeLock(dir);
    release?.();
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");
  });

  it("releases idempotently, so a double release cannot unlink someone else's lock", () => {
    const release = acquireUpgradeLock(dir);
    release?.();
    const second = acquireUpgradeLock(dir);
    // The first holder's release fires again (both spawn handlers can call it).
    release?.();
    // The SECOND holder still owns a live lock file.
    expect(second).toBeTypeOf("function");
    expect(existsSync(lockFile())).toBe(true);
  });

  it("steals a lock left behind by a killed process once it goes stale", () => {
    acquireUpgradeLock(dir);
    // Backdate the file rather than advancing `now`: mtimeMs carries
    // sub-millisecond precision while Date.now() is truncated, so a fixture
    // built as `Date.now() + STALE + 1` sits a fraction of a millisecond
    // INSIDE the threshold often enough to flake.
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lockFile(), stale, stale);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");

    // ...and still refuses while the lock is merely OLD, not stale.
    const recent = new Date(Date.now() - 60 * 1000);
    utimesSync(lockFile(), recent, recent);
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("steals a lock stamped in the FUTURE (clock stepped backwards)", () => {
    acquireUpgradeLock(dir);
    // A future mtime cannot belong to a live process on this clock; honouring
    // it would suppress every upgrade until wall-clock caught up.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(lockFile(), future, future);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");
  });

  it("does NOT block the upgrade when the lock cannot be created at all", () => {
    // Read-only prefix, EACCES, a prefix that does not exist: locking is
    // best-effort, so an un-lockable directory yields a no-op release and the
    // caller proceeds exactly as it did before the lock existed. Only a live
    // EEXIST means "someone else has this".
    const release = acquireUpgradeLock(join(dir, "does", "not", "exist"));
    expect(release).toBeTypeOf("function");
    expect(() => release?.()).not.toThrow();
  });
});

describe("maybeAutoUpgrade -- lock contention", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  it("skips the background install entirely when another process holds the lock", async () => {
    const spawnImpl = vi.fn();
    const acquireLockImpl = vi.fn(() => null);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
      acquireLockImpl,
    });

    expect(acquireLockImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    // The skip is logged, and deliberately does NOT claim an upgrade is running.
    const skips = mockLog.mock.calls.filter((c) => String(c[1]).includes("already upgrading this install"));
    expect(skips).toHaveLength(1);
    expect(mockLog.mock.calls.some((c) => String(c[1]).includes("upgrading the global install"))).toBe(false);
  });

  it("locks the DETECTED running prefix, not npm's configured one", async () => {
    // The lock has to live where the install actually lands, or two processes
    // installing into the same tree through different prefix names miss it.
    const acquireLockImpl = vi.fn(() => () => {});
    mockRealpathSync.mockReturnValueOnce(GLOBAL_NPM_PATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      acquireLockImpl,
    });
    expect(acquireLockImpl).toHaveBeenCalledWith(GLOBAL_NPM_PREFIX);
  });
});
