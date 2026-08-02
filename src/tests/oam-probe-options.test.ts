// probeOam's DEFAULT runner -- the one that actually reaches child_process.
//
// The sibling oam-spawn.test.ts always injects a fake `run`, which is the right
// shape for testing the parse + version-gate logic but structurally cannot
// observe the spawn. That left the spawn options and the timeout untested:
// delete either and every test over there still passes, while the hang they
// prevent comes back.
//
// So this file mocks node:child_process and calls probeOam() with NO argument,
// which is what production does. Split into its own file (rather than added to
// oam-spawn.test.ts) because the mock is module-scoped -- the same reason
// uv-bootstrap's child_process mocks live in -extract / -fixes / -network.
//
// Rewritten for issue #91: the probe was execFileSync + timeout, which does not
// bound the call (spawnSync only SENDS the signal, then waits for an exit an
// unkillable child never produces). It is now spawn + a timer, so the central
// assertion here is no longer "the option is set" but "the event loop keeps
// turning while a probe hangs".

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
const killed: string[] = [];
const unrefed: number[] = [];
const stdoutDestroyed: number[] = [];
/** When true the fake child never exits -- the wedged-binary case. */
let hangForever = false;

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args: [...(args ?? [])], opts: { ...opts } });
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void; destroy: () => void };
    stdout.setEncoding = () => {};
    const child = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      kill: (sig?: string) => void;
      unref: () => void;
    };
    child.stdout = stdout;
    child.kill = (sig?: string) => {
      killed.push(sig ?? "default");
    };
    child.unref = () => {
      unrefed.push(1);
    };
    stdout.destroy = () => {
      stdoutDestroyed.push(1);
    };
    if (!hangForever) {
      // Emit on a later turn so the probe's listeners are attached first.
      setTimeout(() => {
        stdout.emit("data", "oam 9.9.9\n");
        child.emit("close", 0);
      }, 0);
    }
    return child;
  },
}));

const { OAM_PROBE_KILL_SIGNAL, OAM_PROBE_TIMEOUT_MS, probeOam, resetOamBinCache, winNormalize } = await import(
  "../oam-spawn.js"
);

describe("probeOam default runner", () => {
  const originalOamBin = process.env.OAM_BIN;

  beforeEach(() => {
    spawnCalls.length = 0;
    killed.length = 0;
    unrefed.length = 0;
    stdoutDestroyed.length = 0;
    hangForever = false;
    resetOamBinCache();
    process.env.OAM_BIN = "/usr/local/bin/oam";
  });

  afterEach(() => {
    vi.useRealTimers();
    resetOamBinCache();
    if (originalOamBin === undefined) delete process.env.OAM_BIN;
    else process.env.OAM_BIN = originalOamBin;
  });

  it("spawns `<bin> --version` with stdout piped and stderr off the broker's stdio", async () => {
    // The broker speaks MCP over its own stdio; a probe that inherited stderr
    // could interleave oam's output into the transport.
    const probe = await probeOam();

    expect(spawnCalls).toHaveLength(1);
    // Through winNormalize: OAM_BIN is backslash-converted on Windows so cmd
    // does not read a leading "/usr" as a switch.
    expect(spawnCalls[0].bin).toBe(winNormalize("/usr/local/bin/oam"));
    expect(spawnCalls[0].args).toEqual(["--version"]);
    expect(spawnCalls[0].opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
    expect(probe.version).toBe("9.9.9");
  });

  it("keeps the event loop responsive while a wedged binary is being probed", async () => {
    // THE regression this file exists for. Under the old synchronous probe the
    // call blocked the loop outright, so nothing else could run until it
    // returned -- and with an unkillable child it never returned. Here the
    // probe is in flight and other work must still be scheduled and completed.
    hangForever = true;
    vi.useFakeTimers();

    const pending = probeOam();
    let otherWorkRan = false;
    setTimeout(() => {
      otherWorkRan = true;
    }, 1);

    await vi.advanceTimersByTimeAsync(2);
    expect(otherWorkRan, "event loop was blocked by the probe").toBe(true);

    // Now let the probe's own deadline expire.
    await vi.advanceTimersByTimeAsync(OAM_PROBE_TIMEOUT_MS);
    const probe = await pending;

    // Same degraded shape as "oam is not installed" -- callers fall back to node.
    expect(probe).toEqual({ bin: null, version: null, belowMin: false });
    // Best-effort kill still attempted, with the stronger signal.
    expect(killed).toEqual([OAM_PROBE_KILL_SIGNAL]);
  });

  it("probes once per process, not once per call", async () => {
    await probeOam();
    await probeOam();
    await probeOam();

    expect(spawnCalls).toHaveLength(1);
  });

  it("shares one spawn between callers that race before the first result lands", async () => {
    // N servers connecting at once must not each start their own probe: the
    // cache is only populated once the first one finishes.
    const [a, b, c] = await Promise.all([probeOam(), probeOam(), probeOam()]);

    expect(spawnCalls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("detaches the child on timeout so a survivor cannot hold the process open", async () => {
    // Killing is best-effort; DETACHING is what makes the shutdown safe. A
    // live child with a piped stdout keeps the PARENT's event loop alive --
    // verified out-of-band: a parent with an unkilled child and nothing else
    // pending was still running after 6s. So in the exact case this probe
    // exists for (a kill that does not take effect), settling the promise
    // unblocks the connect path but the broker could then never exit.
    hangForever = true;
    vi.useFakeTimers();

    const pending = probeOam();
    await vi.advanceTimersByTimeAsync(OAM_PROBE_TIMEOUT_MS);
    await pending;

    expect(killed).toEqual([OAM_PROBE_KILL_SIGNAL]);
    expect(unrefed, "child was not unref'd -- it can still hold the loop").toHaveLength(1);
    expect(stdoutDestroyed, "stdout pipe was not released").toHaveLength(1);
  });
});
