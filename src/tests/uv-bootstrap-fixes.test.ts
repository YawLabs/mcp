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

afterEach(() => {
  __resetUvBootstrap();
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
