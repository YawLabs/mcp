import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv bootstrap — covers the spawn-rewrite path that runs on every
// upstream activation. The download itself is out of scope here: the
// MOCKED download/checksum/extract path is covered by
// uv-bootstrap-network.test.ts and uv-bootstrap-extract.test.ts, and a
// REAL fetch of Astral's ~20MB release asset is deliberately exercised
// by nothing — there is no integration test and no env-gated escape
// hatch, because a live github.com dependency inside a unit suite is
// slow, flaky, and pinned to whatever assets UV_VERSION still has.
//
// NOTE: fix-1 (shell:true on win32) and fix-2 (memo clear on rejection)
// are pinned in uv-bootstrap-fixes.test.ts, which mocks node:child_process
// at module level to control spawn without ESM limitations.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

import path from "node:path";
import { compareVersions } from "../oam-spawn.js";
import {
  __resetUvBootstrap,
  buildUvSpawn,
  onPath,
  resolveUvSpawn,
  runCommand,
  UV_EXTRACT_TIMEOUT_MS,
  UV_VERSION,
  uvLaunchKind,
  uvTarget,
} from "../uv-bootstrap.js";

// Only ONE test below needs to know whether uv is reachable, and it asks
// through the resolver's own onPath at the moment it decides -- so the test
// and the code can no longer disagree. The module-level probe that used to
// live here gated five tests on a single early spawn: it made them skip
// wholesale on a host without uv, and it could not see the resolver timing
// its own probe out under load. The rewrite cases are pure now and need no
// probe at all.

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

  it("passes an explicit uv/uvx PATH through untouched (a pin on one concrete binary)", async () => {
    // An absolute or relative path is a user pin: substituting the managed
    // download would silently override it, and rewriting a pinned uvx's args
    // to `tool run` without switching the binary would mis-launch. These
    // return before ensureUv(), so they are safe on machines without uv.
    const winUv = path.join("C:", "Users", "x", ".local", "bin", "uv.exe");
    expect(await resolveUvSpawn(winUv, ["run", "server.py"])).toEqual({
      command: winUv,
      args: ["run", "server.py"],
    });
    const posixUvx = "/home/x/.local/bin/uvx";
    expect(await resolveUvSpawn(posixUvx, ["mcp-server-fetch"])).toEqual({
      command: posixUvx,
      args: ["mcp-server-fetch"],
    });
    const relUvx = `.${path.sep}bin${path.sep}uvx`;
    expect(await resolveUvSpawn(relUvx, [])).toEqual({ command: relUvx, args: [] });
  });

  it("does not treat near-miss bare names as uv", async () => {
    expect(await resolveUvSpawn("uvx2", [])).toEqual({ command: "uvx2", args: [] });
    expect(await resolveUvSpawn("guv", [])).toEqual({ command: "guv", args: [] });
    expect(await resolveUvSpawn("uv.sh", [])).toEqual({ command: "uv.sh", args: [] });
  });
});

// Pure function; parameters exist so a single host can exercise every
// (platform, arch, libc) combination.
describe("uvTarget", () => {
  it("selects the musl triple on musl Linux and the gnu triple otherwise", () => {
    // A glibc uv on Alpine dies with a loader error that reads as a broken
    // MCP server; Astral publishes -musl assets, so the right answer exists.
    expect(uvTarget("linux", "x64", true)).toBe("x86_64-unknown-linux-musl");
    expect(uvTarget("linux", "arm64", true)).toBe("aarch64-unknown-linux-musl");
    expect(uvTarget("linux", "x64", false)).toBe("x86_64-unknown-linux-gnu");
    expect(uvTarget("linux", "arm64", false)).toBe("aarch64-unknown-linux-gnu");
  });

  it("maps windows and darwin arches to their triples", () => {
    expect(uvTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(uvTarget("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(uvTarget("win32", "ia32")).toBe("i686-pc-windows-msvc");
    expect(uvTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(uvTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
  });

  it("returns null for combinations Astral does not publish", () => {
    expect(uvTarget("freebsd", "x64")).toBeNull();
    expect(uvTarget("linux", "mips")).toBeNull();
    expect(uvTarget("win32", "mips")).toBeNull();
    expect(uvTarget("darwin", "ia32")).toBeNull();
  });

  it("resolves a real triple for the host running this suite", () => {
    // The default-parameter path (process.platform/arch + libc probe) must
    // produce a non-null triple on any machine the suite supports.
    expect(uvTarget()).toMatch(/^(x86_64|aarch64|i686)-/);
  });

  it("does not derive a musl target from a NON-linux host's report", () => {
    // The libc probe reads process.report, which omits glibcVersionRuntime on
    // win32/darwin exactly as it does on musl. So asking for a linux triple
    // from a Windows or Mac host used to answer -musl from a libc reading that
    // machine never had. Both halves are forced here so the assertion means
    // the same thing on every runner: a non-linux host, and a report that
    // would read as musl if it were consulted.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const report = process.report;
    if (!report) throw new Error("process.report is unavailable; this test cannot force the musl reading");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const spy = vi.spyOn(report, "getReport").mockReturnValue({ header: {} });
    try {
      expect(uvTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
      expect(uvTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
      // An explicit `musl` still wins: a caller who knows the target's libc
      // is not overridden by the host gate.
      expect(uvTarget("linux", "x64", true)).toBe("x86_64-unknown-linux-musl");
    } finally {
      spy.mockRestore();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});

describe("UV_VERSION freshness floor", () => {
  it("has moved off the 0.11.x generation (POLICY: track the latest uv release)", () => {
    // The install dir is keyed by UV_VERSION, so a stale pin keeps every user
    // on that build indefinitely. 0.12.10 was the latest astral-sh/uv release
    // when the floor last moved (2026-09-05); raise the floor when bumping the
    // pin, never lower the pin below it.
    expect(UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compareVersions(UV_VERSION, "0.12.10")).toBeGreaterThanOrEqual(0);
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

  // resolveUv checks onPath("uv") FIRST, so with uv reachable the resolve
  // target is always the literal "uv" -- the managed cache copy is never
  // consulted on that branch, and __resetUvBootstrap in beforeEach clears the
  // memo between tests. The exact command is what pins the PATH-hit branch: a
  // widened "bare or bootstrapped path" matcher used here would have stayed
  // green through a regression that downloaded despite uv being on PATH.

  // The REWRITE cases below drive buildUvSpawn directly, with uvBin pinned to
  // the literal "uv". Going through resolveUvSpawn dragged in ensureUv and its
  // live 3s PATH probe, which made these depend on the machine twice over:
  // they skipped entirely on a host with no uv -- protecting nothing on
  // exactly the hosts the uvx rewrite exists for -- and under full-suite
  // contention the probe timed out, ensureUv fell through to a cached binary,
  // and the assertion on the bare "uv" failed. Four different tests failed
  // across four runs, each passing in isolation. The rewrite never needed to
  // know how uvBin was found, so these now run everywhere and cannot flake.

  it("rewrites uvx to `uv tool run`", () => {
    // uvx is sugar for `uv tool run`. Passing uvx through unchanged broke when
    // uv.exe was reachable but uvx.exe was not (Windows PATHEXT cases, or
    // partial installs). Always-rewriting means the spawn target is always uv.
    expect(buildUvSpawn("uvx", "uv", ["mcp-server-fetch"])).toEqual({
      command: "uv",
      args: ["tool", "run", "mcp-server-fetch"],
    });
  });

  it("preserves additional args when rewriting uvx", () => {
    expect(buildUvSpawn("uvx", "uv", ["--from", "mcp-server-fetch", "--transport", "stdio"])).toEqual({
      command: "uv",
      args: ["tool", "run", "--from", "mcp-server-fetch", "--transport", "stdio"],
    });
  });

  it("rewrites uvx with empty args", () => {
    expect(buildUvSpawn("uvx", "uv", [])).toEqual({ command: "uv", args: ["tool", "run"] });
  });

  it("passes a uv launch through, carrying its args", () => {
    expect(buildUvSpawn("uv", "uv", ["--version"])).toEqual({ command: "uv", args: ["--version"] });
  });

  it("uses whatever binary it is handed, cached absolute path included", () => {
    // The other half of the contract, and the half the old tests could never
    // assert: on a cache hit uvBin is an absolute path, and the rewrite must
    // target it rather than the bare name.
    const cached = "/var/cache/yaw-mcp/uv/0.12.10/uv";
    expect(buildUvSpawn("uvx", cached, ["x"])).toEqual({ command: cached, args: ["tool", "run", "x"] });
    expect(buildUvSpawn("uv", cached, ["x"])).toEqual({ command: cached, args: ["x"] });
  });

  it("recognises bare names with a Windows executable extension, any casing", async () => {
    // `"command": "uvx.exe"` is an ordinary config shape on Windows; exact
    // string equality used to pass it through untouched -- no bootstrap when
    // uv was missing, and no `uv tool run` rewrite. This is uvLaunchKind's
    // job, so it is asserted on uvLaunchKind rather than through a spawn.
    expect(uvLaunchKind("uvx.exe")).toBe("uvx");
    expect(uvLaunchKind("UVX.EXE")).toBe("uvx");
    expect(uvLaunchKind("uv.exe")).toBe("uv");
    // ...and the rewrite that kind then selects.
    expect(buildUvSpawn(uvLaunchKind("uvx.exe") as "uvx", "uv", ["mcp-server-fetch"])).toEqual({
      command: "uv",
      args: ["tool", "run", "mcp-server-fetch"],
    });
  });

  it("resolves to the bare `uv` when uv really is on PATH", async (ctx) => {
    // The one case that genuinely needs the live probe. Its precondition is
    // asked through the SAME function the resolver decides on, at the same
    // moment, so the test and the code can no longer disagree: under load this
    // skips with a visible reason instead of failing with a confusing one.
    if (!(await onPath("uv"))) {
      // ctx.skip(), not a bare return: a return reports GREEN while asserting
      // nothing, which is the exact shape this file's header already warns
      // about. A skip says so in the runner output.
      ctx.skip();
      return;
    }
    const result = await resolveUvSpawn("uv", ["--version"]);
    expect(result.command).toBe("uv");
    expect(result.args).toEqual(["--version"]);
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
