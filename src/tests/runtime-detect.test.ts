import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Runtime detection — coverage of the small reporting surface.
//
// `spawn` is mocked rather than exercised for real. That is correctness,
// not convenience: probeCandidate has a 3s hard timeout (PROBE_TIMEOUT_MS),
// and a real `node --version` / `python --version` under a parallel suite
// on Windows -- where every probe goes through cmd.exe -- can exceed it.
// Any assertion on a probe RESULT then passes or fails with machine load.
// Mocking makes those deterministic, and lets the python case assert the
// candidate-WALK itself instead of whether this box happens to have python.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { request } from "undici";
import { detectRuntimes, initRuntimeDetect, reportRuntimes } from "../runtime-detect.js";

// Stand-in for a spawned probe: emits its output, then closes with `code`.
// Emission is deferred to a macrotask because probeCandidate attaches its
// stdout/stderr/close listeners synchronously after spawn() returns.
function fakeChild(code: number, stdout = "", stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

// Output shaped to satisfy each probe's parse() in runtime-detect.
const PROBE_OUTPUT: Record<string, string> = {
  node: "v22.22.2",
  npx: "11.13.0",
  py: "Python 3.14.3",
  python: "Python 3.14.3",
  python3: "Python 3.14.3",
  uvx: "0.11.7",
  docker: "Docker version 29.4.2",
};

// The first python candidate runtime-detect tries on this platform.
const FIRST_PYTHON = process.platform === "win32" ? "py" : "python3";

beforeEach(() => {
  vi.mocked(spawn).mockImplementation(((bin: string) => fakeChild(0, PROBE_OUTPUT[bin] ?? "")) as never);
});

describe("detectRuntimes", () => {
  it("returns a flat snapshot carrying every known runtime key", async () => {
    const snap = await detectRuntimes();
    // Optional runtimes stay in the snapshot (as false when absent) so the
    // dashboard can render the negative case rather than guessing.
    for (const key of ["node", "npx", "python", "uvx", "docker"]) {
      expect(snap).toHaveProperty(key);
    }
  });

  it("walks past a missing first python candidate to a later one", async () => {
    // The candidate list (py -3 / python / python3 on win32; python3 /
    // python on posix) exists so python is still found when the first
    // name is absent. Fail the first candidate and require that a later
    // one is tried AND its parsed version wins -- the actual contract,
    // which "is python truthy on this machine" never tested.
    vi.mocked(spawn).mockImplementation(((bin: string) =>
      bin === FIRST_PYTHON ? fakeChild(1) : fakeChild(0, "Python 3.12.7")) as never);

    const snap = await detectRuntimes();

    expect(snap.python).toBe("3.12.7");
    expect(vi.mocked(spawn).mock.calls.some(([bin]) => bin === FIRST_PYTHON)).toBe(true);
  });

  it("reports python as false when every candidate is absent", async () => {
    vi.mocked(spawn).mockImplementation((() => fakeChild(1)) as never);
    const snap = await detectRuntimes();
    expect(snap.python).toBe(false);
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
    // Deterministic via the mocked probe (see the header): the node probe
    // strips the leading v from "v22.22.2". Previously this asserted on a
    // real `node --version` spawn and so could time out under load.
    expect(body.runtimes.node).toBe("22.22.2");
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
