import { describe, expect, it, vi } from "vitest";
import {
  registerShutdownTriggers,
  runShutdown,
  SHUTDOWN_FORCE_EXIT_MS,
  SIGNAL_SHUTDOWN_EVENTS,
  STDIN_SHUTDOWN_EVENTS,
} from "../shutdown-triggers.js";

/** A recording stand-in for `process` / `process.stdin`.
 *
 *  Carries a `resume` spy that the module under test has no way to reach
 *  through its own ShutdownEventTarget type. That is the point: the test
 *  asserts the SHAPE the production call has, so a future widening of the
 *  interface to include `resume` fails the "never resumes stdin" test below
 *  rather than silently regressing the protocol. */
function makeTarget() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    listeners,
    resume: vi.fn(),
    pause: vi.fn(),
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    /** Fire one event the way Node would. */
    emit(event: string) {
      for (const l of listeners.get(event) ?? []) l();
    },
  };
}

describe("registerShutdownTriggers", () => {
  it("registers both POSIX signals", () => {
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect([...proc.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("registers stdin end AND close -- the events the SDK transport never binds", () => {
    // The regression this whole module exists for. StdioServerTransport.start()
    // attaches only 'data' and 'error', so nothing in the SDK notices EOF and
    // transport.onclose never fires. If these two ever stop being registered,
    // shutdown() stops running on Windows and upstream children leak again.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect([...stdin.listeners.keys()].sort()).toEqual(["close", "end"]);
  });

  it("never resumes stdin, so the transport keeps every byte the client sent", () => {
    // Resuming before StdioServerTransport attaches its 'data' listener puts
    // stdin in flowing mode with no consumer, which discards whatever the
    // client already wrote -- typically its `initialize` request. A broker
    // that eats the handshake is worse than one that leaks on exit.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect(stdin.resume).not.toHaveBeenCalled();
    expect(stdin.pause).not.toHaveBeenCalled();
  });

  it("routes every trigger to the one shutdown callback, once per event (no latch -- the caller owns idempotency)", () => {
    // runServer's `shuttingDown` flag is the single latch. Adding a second
    // one here would mean two places decide what "already shutting down"
    // means, and the one in index.ts is the one that guards the force-exit
    // timer. A killed client really can deliver 'end' then 'close', so the
    // module passes both through.
    const proc = makeTarget();
    const stdin = makeTarget();
    const shutdown = vi.fn();
    registerShutdownTriggers(shutdown, { proc, stdin });

    proc.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(1);
    proc.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledTimes(2);
    stdin.emit("end");
    expect(shutdown).toHaveBeenCalledTimes(3);
    stdin.emit("close");
    expect(shutdown).toHaveBeenCalledTimes(4);
  });

  it("registers exactly the events its exported constants name", () => {
    // Drift guard: the constants are documentation other code and this test
    // read, so they must not diverge from what actually gets bound.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    for (const signal of SIGNAL_SHUTDOWN_EVENTS) {
      expect(proc.listeners.get(signal)).toHaveLength(1);
    }
    for (const event of STDIN_SHUTDOWN_EVENTS) {
      expect(stdin.listeners.get(event)).toHaveLength(1);
    }
    expect(proc.listeners.size).toBe(SIGNAL_SHUTDOWN_EVENTS.length);
    expect(stdin.listeners.size).toBe(STDIN_SHUTDOWN_EVENTS.length);
  });
});

describe("runShutdown", () => {
  // The body of index.ts's shutdown closure. It used to be reachable only by
  // reading index.ts's source (index-source-shape.test.ts); called here, with
  // a recording exit and a real clock unless a case says otherwise.
  const deps = () => {
    const exit = vi.fn();
    const log = vi.fn();
    return { exit, log };
  };

  it("exits 0 when the teardown resolves, and logs nothing", async () => {
    const d = deps();
    await runShutdown(async () => {}, d);
    expect(d.exit.mock.calls).toEqual([[0]]);
    expect(d.log).not.toHaveBeenCalled();
  });

  it("a REJECTING teardown is one error log and exit(1) at once -- not a wait for the watchdog", async () => {
    // Uncaught, the rejection reached the unhandledRejection handler, which
    // only logs, and the process idled out the full 10 s before exit(1).
    // Fake clock, never advanced: the exit below cannot be the watchdog's,
    // and no wall-clock budget is needed to say so.
    vi.useFakeTimers();
    try {
      const d = deps();
      await runShutdown(async () => {
        throw new Error("transport already closed");
      }, d);
      expect(d.log.mock.calls).toEqual([["error", "Shutdown failed", { error: "transport already closed" }]]);
      expect(d.exit.mock.calls).toEqual([[1]]);
      // The watchdog is cleared, so it cannot fire a second exit later.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names a non-Error rejection by its string form", async () => {
    const d = deps();
    await runShutdown(() => Promise.reject("nope"), d);
    expect(d.log.mock.calls).toEqual([["error", "Shutdown failed", { error: "nope" }]]);
    expect(d.exit.mock.calls).toEqual([[1]]);
  });

  it("force-exits 1 when the teardown never settles, at the watchdog budget (10 s by default)", async () => {
    expect(SHUTDOWN_FORCE_EXIT_MS).toBe(10_000);
    vi.useFakeTimers();
    try {
      const d = deps();
      void runShutdown(() => new Promise<void>(() => {}), d);
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FORCE_EXIT_MS - 1);
      expect(d.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(d.exit.mock.calls).toEqual([[1]]);
      expect(d.log).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours forceAfterMs, and a settled teardown leaves no watchdog behind to fire a second exit", async () => {
    vi.useFakeTimers();
    try {
      const hung = deps();
      void runShutdown(() => new Promise<void>(() => {}), { ...hung, forceAfterMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(hung.exit.mock.calls).toEqual([[1]]);

      for (const teardown of [async () => {}, () => Promise.reject(new Error("x"))]) {
        const d = deps();
        await runShutdown(teardown, { ...d, forceAfterMs: 50 });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(d.exit).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
