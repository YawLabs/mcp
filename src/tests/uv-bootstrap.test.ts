import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv bootstrap — covers the spawn-rewrite path that runs on every
// upstream activation. The actual network download is out of scope
// here (it's exercised by the integration test gated on
// MCPH_TEST_UV_DOWNLOAD=1) because pulling a 20MB binary over
// GitHub during CI is noisy and slow.
//
// NOTE: fix-1 (shell:true on win32) and fix-2 (memo clear on rejection)
// are pinned in uv-bootstrap-fixes.test.ts, which mocks node:child_process
// at module level to control spawn without ESM limitations.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { spawnSync } from "node:child_process";
import { __resetUvBootstrap, resolveUvSpawn } from "../uv-bootstrap.js";

// Is uv reachable on this machine? Probed ONCE here instead of inside each
// test: the previous shape returned early when uv was absent, so the test
// reported GREEN while asserting nothing. `it.skipIf` makes the skip show up
// in the runner output, which is the honest signal.
const UV_PRESENT = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

describe("resolveUvSpawn", () => {
  beforeEach(() => {
    __resetUvBootstrap();
  });

  afterEach(() => {
    __resetUvBootstrap();
  });

  it("is a no-op for non-uv commands", async () => {
    const result = await resolveUvSpawn("npx", ["-y", "@modelcontextprotocol/server-github"]);
    expect(result).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("is a no-op for node, python, docker", async () => {
    expect(await resolveUvSpawn("node", ["index.js"])).toEqual({ command: "node", args: ["index.js"] });
    expect(await resolveUvSpawn("python", ["-m", "foo"])).toEqual({ command: "python", args: ["-m", "foo"] });
    expect(await resolveUvSpawn("docker", ["run", "img"])).toEqual({ command: "docker", args: ["run", "img"] });
  });

  it("preserves empty args array", async () => {
    const result = await resolveUvSpawn("custom-cmd", []);
    expect(result).toEqual({ command: "custom-cmd", args: [] });
  });
});

// The PATH-hit path and the uvx→uv tool run rewrite depend on
// whether uv is installed on the machine running the tests. Rather
// than mocking child_process (which would test the mock, not the
// code) we run these conditionally (it.skipIf) on what's actually there.
describe("resolveUvSpawn with uv present", () => {
  beforeEach(() => {
    __resetUvBootstrap();
  });

  // resolveUvSpawn (uv-bootstrap.ts:349) returns uvBin from ensureUv(),
  // which is either the literal "uv" (PATH) or the absolute path to the
  // managed cache copy. The previous shape asserted `command: "uv"`
  // exactly, which failed after a prior run bootstrapped a managed copy
  // (now the resolve target is `C:\...\Cache\uv\<ver>\uv.exe` even on a
  // box that also has `uv` on PATH, because ensureUv() memoizes the
  // first resolution for the process lifetime). The spawn target is
  // correct in both cases -- what's load-bearing is "the command points
  // at a uv binary and the args are rewritten to `uv tool run ...`."
  // isUvSpawnTarget accepts either form.
  const isUvSpawnTarget = (cmd: string): boolean => cmd === "uv" || /uv(\.exe)?$/.test(cmd);

  it.skipIf(!UV_PRESENT)("returns a uv spawn target (bare or bootstrapped path) when uv is reachable", async () => {
    const result = await resolveUvSpawn("uv", ["--version"]);
    expect(isUvSpawnTarget(result.command)).toBe(true);
    expect(result.args).toEqual(["--version"]);
  });

  it.skipIf(!UV_PRESENT)("rewrites uvx to `uv tool run` when uv is reachable", async () => {
    // uvx is sugar for `uv tool run`. Previously we passed uvx
    // through unchanged when uv was on PATH, which broke when uv.exe
    // was reachable but uvx.exe wasn't (Windows PATHEXT cases, or
    // partial installs). Always-rewriting means the spawn target is
    // always uv, which we've already confirmed is reachable.
    const result = await resolveUvSpawn("uvx", ["mcp-server-fetch"]);
    expect(isUvSpawnTarget(result.command)).toBe(true);
    expect(result.args).toEqual(["tool", "run", "mcp-server-fetch"]);
  });

  it.skipIf(!UV_PRESENT)("preserves additional args when rewriting uvx", async () => {
    const result = await resolveUvSpawn("uvx", ["--from", "mcp-server-fetch", "--transport", "stdio"]);
    expect(isUvSpawnTarget(result.command)).toBe(true);
    expect(result.args).toEqual(["tool", "run", "--from", "mcp-server-fetch", "--transport", "stdio"]);
  });

  it.skipIf(!UV_PRESENT)("rewrites uvx with empty args", async () => {
    const result = await resolveUvSpawn("uvx", []);
    expect(isUvSpawnTarget(result.command)).toBe(true);
    expect(result.args).toEqual(["tool", "run"]);
  });
});
