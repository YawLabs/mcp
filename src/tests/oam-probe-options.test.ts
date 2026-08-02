// probeOam's DEFAULT runner -- the one that actually reaches execFileSync.
//
// The sibling oam-spawn.test.ts always injects a fake `run`, which is the
// right shape for testing the parse + version-gate logic but structurally
// cannot observe the spawn options, since the fake never calls execFileSync.
// That leaves the timeout and killSignal untested: delete either option and
// every test over there still passes, while the hang they prevent comes back.
//
// So this file mocks node:child_process and calls probeOam() with NO argument,
// which is what production does. Split into its own file (rather than added to
// oam-spawn.test.ts) because the mock is module-scoped and would otherwise
// apply to all 34 tests there -- the same reason uv-bootstrap's child_process
// mocks live in uv-bootstrap-extract / -fixes / -network rather than one file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecCall {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}

const execCalls: ExecCall[] = [];

vi.mock("node:child_process", () => ({
  execFileSync: (bin: string, args: string[], opts: Record<string, unknown>) => {
    execCalls.push({ bin, args: [...(args ?? [])], opts: { ...opts } });
    return "oam 9.9.9\n";
  },
}));

const { OAM_PROBE_KILL_SIGNAL, OAM_PROBE_TIMEOUT_MS, probeOam, resetOamBinCache } = await import("../oam-spawn.js");

describe("probeOam default runner spawn options", () => {
  const originalOamBin = process.env.OAM_BIN;

  beforeEach(() => {
    execCalls.length = 0;
    resetOamBinCache();
    process.env.OAM_BIN = "/usr/local/bin/oam";
  });

  afterEach(() => {
    resetOamBinCache();
    if (originalOamBin === undefined) delete process.env.OAM_BIN;
    else process.env.OAM_BIN = originalOamBin;
  });

  it("bounds the real execFileSync call with both a timeout and a kill signal", () => {
    probeOam(); // no injected runner -- exercises the production default

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toEqual(["--version"]);
    // The timeout alone is not a bound on POSIX: spawnSync sends killSignal
    // and then waits for the child to exit, and Node does not escalate, so a
    // child that traps SIGTERM hangs the probe anyway. Both must be present.
    expect(execCalls[0].opts.timeout).toBe(OAM_PROBE_TIMEOUT_MS);
    expect(execCalls[0].opts.killSignal).toBe(OAM_PROBE_KILL_SIGNAL);
  });

  it("keeps stderr off the broker's stdio while capturing stdout", () => {
    // The broker speaks MCP over its own stdio; a probe that inherited stderr
    // could interleave oam's output into the transport.
    probeOam();

    expect(execCalls[0].opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
    expect(execCalls[0].opts.encoding).toBe("utf8");
  });

  it("probes once per process, not once per call", () => {
    probeOam();
    probeOam();
    probeOam();

    // The probe blocks the event loop; the cache is what keeps that cost to a
    // single occurrence even when many servers connect.
    expect(execCalls).toHaveLength(1);
  });
});
