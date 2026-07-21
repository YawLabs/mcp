import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Runtime detection — coverage of the small reporting surface. The
// per-binary probe spawns real child processes, which is hard to mock
// portably; we cover the report path (initialized vs not, success vs
// failure) which is where the actual bugs live.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { request } from "undici";
import { detectRuntimes, initRuntimeDetect, reportRuntimes } from "../runtime-detect.js";

// Is ANY python actually installed here? The assertion below is about the
// candidate-WALK, not about the machine having python -- so on a python-less
// box the test must SKIP (visibly) rather than fail on environment state.
// Mirrors runtime-detect's own PYTHON_CANDIDATES list + win32 shell option.
const PYTHON_PROBES: Array<[string, string[]]> =
  process.platform === "win32"
    ? [
        ["py", ["-3", "--version"]],
        ["python", ["--version"]],
        ["python3", ["--version"]],
      ]
    : [
        ["python3", ["--version"]],
        ["python", ["--version"]],
      ];
const HAS_PYTHON = PYTHON_PROBES.some(
  ([bin, args]) =>
    spawnSync(bin, args, { stdio: "ignore", shell: process.platform === "win32", windowsHide: true }).status === 0,
);

describe("detectRuntimes", () => {
  it("returns a flat snapshot carrying every known runtime key", async () => {
    const snap = await detectRuntimes();
    // Optional runtimes stay in the snapshot (as false when absent) so the
    // dashboard can render the negative case rather than guessing.
    for (const key of ["node", "npx", "python", "uvx", "docker"]) {
      expect(snap).toHaveProperty(key);
    }
  });

  it.skipIf(!HAS_PYTHON)("detects python across the per-platform candidate list", async () => {
    // The candidate list (py -3 / python / python3 on win32; python3 /
    // python on posix) means python is found even when the hard-coded
    // legacy name (`python` on win32) is absent. Gated on HAS_PYTHON: with
    // a python on the box, a falsey value here is a real regression in the
    // candidate-walk; without one, this asserts nothing about the code, so
    // it skips (and the skip is visible in the runner output) instead of
    // failing a python-less machine.
    const snap = await detectRuntimes();
    expect(snap.python).toBeTruthy();
  });
});

describe("initRuntimeDetect token validation", () => {
  afterEach(() => {
    // Reset module-level state.
    initRuntimeDetect("", "");
  });

  it("throws when token contains a newline character (CRLF injection guard)", () => {
    expect(() => initRuntimeDetect("https://yaw.sh/mcp", "tok\nen")).toThrow(/invalid characters/);
  });

  it("throws when token contains a carriage return", () => {
    expect(() => initRuntimeDetect("https://yaw.sh/mcp", "tok\ren")).toThrow(/invalid characters/);
  });
});

describe("reportRuntimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset module-level state by re-init with empty creds.
    initRuntimeDetect("", "");
  });

  it("does nothing when not initialized", async () => {
    await reportRuntimes();
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("posts to /api/connect/runtimes when initialized", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await reportRuntimes();

    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(request).mock.calls[0];
    expect(String(url)).toContain("/api/connect/runtimes");
    expect((opts as any).method).toBe("POST");
    const body = JSON.parse((opts as any).body);
    expect(body.runtimes).toBeTypeOf("object");
    // node should always be detected — we're running this test on Node,
    // and the probe runs `node --version`.
    expect(body.runtimes.node).toBeTruthy();
  });

  it("swallows network errors silently", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockRejectedValue(new Error("ECONNRESET"));
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });

  it("does not throw on 404 (older mcp.hosting deploy)", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 404,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });

  it("does not throw on 5xx", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 500,
      body: { text: vi.fn().mockResolvedValue("internal error") },
    } as any);
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });
});
