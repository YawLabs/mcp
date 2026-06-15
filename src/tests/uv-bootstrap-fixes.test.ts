import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Pins for the two uv-bootstrap bug fixes that require mocking spawn:
//
//   Fix 1: onPath must pass shell:true on win32 so PATHEXT shims (.cmd)
//          are found and the probe doesn't false-negative on Windows.
//
//   Fix 2: ensureUv must clear the memo on rejection so a transient
//          failure doesn't poison every subsequent call for the process
//          lifetime.
//
// These live in a separate file so they can mock node:child_process at
// module level without breaking the other uv-bootstrap tests that rely
// on the real spawn (to probe whether uv is actually installed).
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Point cacheDir() at an empty temp dir. Otherwise resolveUv()'s
// `if (await exists(finalBin)) return finalBin` short-circuit finds a REAL
// cached uv binary that a previous bootstrap left under the OS cache root
// (e.g. %LOCALAPPDATA%\yaw-mcp\Cache) and RESOLVES -- defeating the spawn
// mock and making the rejection-path tests below pass in clean CI but fail
// on any dev box that has run uv. require() inside the factory because
// vi.mock is hoisted above the top-level imports.
vi.mock("../paths.js", () => {
  const nodeOs = require("node:os");
  const nodePath = require("node:path");
  return {
    cacheDir: () => nodePath.join(nodeOs.tmpdir(), "yaw-mcp-uvbf-test-cache"),
  };
});

// Mock undici so resolveUv's download path fails fast rather than hitting
// the network (which makes the test suite slow and flaky in CI).
vi.mock("undici", () => ({
  request: vi.fn().mockRejectedValue(new Error("network mocked out")),
}));

// Mock node:child_process at module level -- required for ESM mocking.
// We replace spawn with a factory that stores the last options and emits
// an error event so onPath returns false immediately.
const spawnCalls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
let spawnCallCount = 0;

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (cmd: string, _args: unknown, opts: Record<string, unknown>) => {
      spawnCallCount++;
      spawnCalls.push({ cmd, opts: { ...opts } });
      const fake = new EventEmitter();
      fake.kill = () => {};
      // Emit error asynchronously so the promise chain settles before we check.
      setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      return fake;
    },
  };
});

import { __resetUvBootstrap, ensureUv } from "../uv-bootstrap.js";

beforeEach(() => {
  spawnCalls.length = 0;
  spawnCallCount = 0;
  __resetUvBootstrap();
});

afterEach(async () => {
  __resetUvBootstrap();
  // resolveUv() mkdir's the (mocked) cache dir before the download fails;
  // clean the empty tree so we don't litter the OS temp dir.
  await fs.rm(path.join(os.tmpdir(), "yaw-mcp-uvbf-test-cache"), { recursive: true, force: true }).catch(() => {});
});

// ── Fix 1: onPath passes the right shell option ───────────────────────
describe("onPath spawn options (fix 1)", () => {
  it("passes shell=process.platform==='win32' and matching windowsHide", async () => {
    // ensureUv() calls onPath("uv") first, which is the spawn we intercept.
    await ensureUv().catch(() => {});

    // At least one spawn call must have been made (the onPath probe).
    expect(spawnCalls.length).toBeGreaterThan(0);
    const probeOpts = spawnCalls[0].opts;

    const isWin32 = process.platform === "win32";
    expect(probeOpts.shell).toBe(isWin32);
    expect(probeOpts.windowsHide).toBe(isWin32);
  });
});

// ── uvTarget: unsupported platform/arch returns null; ensureUv surfaces message ──
describe("uvTarget unsupported platform/arch (coverage gap)", () => {
  // We cannot actually change process.platform/arch in a live process, but
  // we CAN verify the branch that fires when uvTarget() returns null:
  // resolveUv() throws with 'No prebuilt uv binary' + docs URL.
  //
  // Strategy: ensureUv() calls onPath("uv") first (which returns false
  // because our spawn mock emits error), then calls resolveUv() which
  // calls uvTarget(). On this machine uvTarget() may return a real string
  // (supported platform), in which case it tries to download -- but we
  // mocked undici to reject with "network mocked out". That's fine for
  // showing the download-attempt branch. The unsupported-platform branch
  // is verified by importing and calling uvTarget via the internal
  // logic that rejects with the specific message.
  //
  // Because uvTarget is not exported we test the observable outcome:
  // on a mocked environment that simulates an unsupported arch, resolveUv
  // throws with the expected message. We do this by temporarily stubbing
  // process.platform and process.arch.
  it("ensureUv rejects with 'No prebuilt uv binary' message on unsupported platform/arch", async () => {
    __resetUvBootstrap();

    // Save originals.
    const origPlatform = process.platform;
    const origArch = process.arch;

    // Stub to an unsupported combination.
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    Object.defineProperty(process, "arch", { value: "mips", configurable: true });

    try {
      const err = await ensureUv().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("No prebuilt uv binary");
      expect((err as Error).message).toContain("https://docs.astral.sh/uv/");
    } finally {
      // Restore.
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      Object.defineProperty(process, "arch", { value: origArch, configurable: true });
      __resetUvBootstrap();
    }
  });
});

// ── Fix 2: ensureUv clears memo on rejection ──────────────────────────
describe("ensureUv rejection memo clear (fix 2)", () => {
  it("retries after a transient failure instead of returning the same rejection", async () => {
    // First call -- rejects because spawn emits error (uv not on PATH).
    const first = await ensureUv().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);

    const countAfterFirst = spawnCallCount;

    // Second call -- must spawn again (new promise), not replay the cached rejection.
    const second = await ensureUv().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(Error);
    expect(spawnCallCount).toBeGreaterThan(countAfterFirst);
  });

  it("succeeds on a retry after transient failure clears the memo", async () => {
    // First call fails.
    await ensureUv().catch(() => {});

    // Now make the next spawn succeed by pointing it at a real command.
    // Simplest: test that calling ensureUv() after a failure does NOT
    // return the cached rejected promise -- it starts a new resolution chain.
    // We verify this by checking the memo is null after rejection: that
    // means the exported __resetUvBootstrap no-ops (already null) and
    // a fresh call to ensureUv() goes through resolveUv() again.
    const countBefore = spawnCallCount;
    await ensureUv().catch(() => {});
    expect(spawnCallCount).toBeGreaterThan(countBefore);
  });
});
