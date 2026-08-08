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
import { __resetUvBootstrap, resolveUvSpawn, runCommand, UV_EXTRACT_TIMEOUT_MS } from "../uv-bootstrap.js";

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

// runCommand is what extractArchive runs tar / powershell Expand-Archive
// through. Real subprocesses (this file deliberately does not mock spawn) --
// process.execPath is the one binary guaranteed present on any machine running
// the suite.
describe("runCommand", () => {
  it("resolves on a clean exit", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.exit(0)"], 30_000)).resolves.toBeUndefined();
  });

  it("rejects with the child's stderr on a non-zero exit", async () => {
    const err = await runCommand(process.execPath, ["-e", 'console.error("boom"); process.exit(3)'], 30_000).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("exited 3");
    expect((err as Error).message).toContain("boom");
  });

  it("kills and rejects a child that never exits, instead of hanging forever", async () => {
    // The hole this closes: extractArchive had no deadline, and upstream.ts
    // awaits resolveUvSpawn BEFORE it arms its own connect timeout -- so a
    // wedged tar never became an ActivationError and never expired. ensureUv
    // memoizes, so that one never-settling promise was then handed to every
    // later uv/uvx activation for the life of the process.
    const started = Date.now();
    const err = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 300).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did not finish within 300ms");
    expect(Date.now() - started, "settled on the deadline, not on the child").toBeLessThan(10_000);
  });

  it("does not deadlock on a child that writes more stdout than a pipe buffer holds", async () => {
    // The self-inflicted half of the same hang: stdout used to be "pipe" with
    // no reader, so any extractor writing past the pipe buffer (tar -v, a
    // PowerShell progress stream) blocked on write and never reached 'close'.
    // 4MB is far past every platform's buffer. A generous deadline, so a
    // failure here is the deadlock and not a slow machine.
    await expect(
      runCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(4 * 1024 * 1024))'], 30_000),
    ).resolves.toBeUndefined();
  });

  it("defaults to a budget sized for an archive extract, not for a probe", () => {
    // Expiry must mean "genuinely stuck", not "slow but working": a cold
    // PowerShell start plus Expand-Archive is seconds, so the floor here is
    // well above it.
    expect(UV_EXTRACT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
