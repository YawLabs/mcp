// YAW_MCP_AUTO_PREWARM, YAW_MCP_MAX_AUTO_PREWARM, YAW_MCP_AUTO_PREWARM_TIMEOUT
// -- the opt-out, the per-process cap, and the per-package timeout for the
// startup npx-cache pre-warm. Pin the design so a future change that
// re-spawns the upstream server, loses the cap, or short-circuits the
// timeout silently regresses here rather than in a user's first-session
// initialize.
//
// Why this test exists: the pre-warm is fire-and-forget from `start()` and
// touches the network. The cost of getting it wrong is either (a) a quiet
// loss of the fix, in which case the user keeps seeing "MCP request
// initialize to server mcp timed out after 30000ms" without knowing why; or
// (b) a noisy prewarm that runs for tens of seconds on every startup, which
// is exactly what the existing YAW_MCP_PREWARM opt-out exists to prevent
// for a sibling feature. The tests below pin every knob a user might reach
// for.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// node:child_process is mocked at the top of the file so the production
// spawn path is exercised through a captured call. The real spawn would
// launch a real npx against the registry on every test, and the default
// 30s per-package timeout would make the suite a 30s-per-test integration
// test. With this mock the captured call is asserted directly and the
// mock child emits `close` immediately so the done promise resolves.
// `vi.hoisted` keeps the captured-array reference stable across the
// module-import boundary the hoisted vi.mock creates.
const spawnCalls = vi.hoisted(() => [] as Array<{ cmd: string; args: string[]; opts: unknown }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:child_process");
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], opts: unknown) => {
      spawnCalls.push({ cmd, args, opts });
      const child = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean };
      child.kill = () => true;
      setImmediate(() => child.emit("close", 0));
      return child as unknown as ReturnType<typeof actual.spawn>;
    }) as typeof actual.spawn,
  };
});

import {
  DEFAULT_AUTO_PREWARM_TIMEOUT_MS,
  DEFAULT_MAX_AUTO_PREWARM,
  extractNpxPackages,
  isAutoPrewarmDisabled,
  maybeAutoPrewarmNpxCache,
  parseAutoPrewarmMax,
  parseAutoPrewarmTimeoutMs,
  type SpawnReason,
} from "../auto-prewarm.js";
import { log } from "../logger.js";
import type { UpstreamServerConfig } from "../types.js";

function makeServer(over: Partial<UpstreamServerConfig>): UpstreamServerConfig {
  return {
    id: over.namespace ?? "x",
    name: over.namespace ?? "x",
    namespace: over.namespace ?? "x",
    type: over.type ?? "local",
    command: over.command ?? "echo",
    args: over.args,
    isActive: true,
  } as UpstreamServerConfig;
}

function makeNpx(pkg: string, ns: string = pkg): UpstreamServerConfig {
  return makeServer({ namespace: ns, command: "npx", args: ["-y", pkg] });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isAutoPrewarmDisabled", () => {
  // Same convention as isPrewarmEnabled (server-prewarm-optout.test.ts:100-128):
  // two off spellings, anything else on.
  it.each(["0", "false", "False", "FALSE"])("is off for %j", (value) => {
    vi.stubEnv("YAW_MCP_AUTO_PREWARM", value);
    expect(isAutoPrewarmDisabled()).toBe(true);
  });

  // cmd.exe's `set VAR=0 && yaw-mcp serve` delivers "0 " with a trailing
  // space. The trim is load-bearing -- the test in
  // server-prewarm-optout.test.ts:111-114 is exactly the regression this
  // guards against.
  it.each(["0 ", " 0", " false "])("is off for the padded spelling %j", (value) => {
    vi.stubEnv("YAW_MCP_AUTO_PREWARM", value);
    expect(isAutoPrewarmDisabled()).toBe(true);
  });

  // Near-misses stay ON. An opt-out that engaged on anything vaguely
  // zero-ish would turn a typo into an invisible loss of the feature.
  it.each(["1", "true", "", "00", "0abc", "no", "off"])("stays on for %j", (value) => {
    vi.stubEnv("YAW_MCP_AUTO_PREWARM", value);
    expect(isAutoPrewarmDisabled()).toBe(false);
  });

  it("stays on when the variable is not set at all", () => {
    vi.stubEnv("YAW_MCP_AUTO_PREWARM", undefined as unknown as string);
    expect(isAutoPrewarmDisabled()).toBe(false);
  });
});

describe("parseAutoPrewarmMax", () => {
  it("returns the default for absent, empty, or unparseable input", () => {
    expect(parseAutoPrewarmMax({})).toBe(DEFAULT_MAX_AUTO_PREWARM);
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "" })).toBe(DEFAULT_MAX_AUTO_PREWARM);
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "abc" })).toBe(DEFAULT_MAX_AUTO_PREWARM);
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "-1" })).toBe(DEFAULT_MAX_AUTO_PREWARM);
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "0" })).toBe(DEFAULT_MAX_AUTO_PREWARM);
  });
  it("parses a positive integer", () => {
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "7" })).toBe(7);
  });
  it("floors a fractional value rather than rounding -- 7.9 reads 7", () => {
    // parseInt is the chosen primitive; documented in the function header.
    expect(parseAutoPrewarmMax({ YAW_MCP_MAX_AUTO_PREWARM: "7.9" })).toBe(7);
  });
  it("accepts a custom fallback", () => {
    expect(parseAutoPrewarmMax({}, 5)).toBe(5);
  });
});

describe("parseAutoPrewarmTimeoutMs", () => {
  it("returns the default for absent, empty, or unparseable input", () => {
    expect(parseAutoPrewarmTimeoutMs({})).toBe(DEFAULT_AUTO_PREWARM_TIMEOUT_MS);
    expect(parseAutoPrewarmTimeoutMs({ YAW_MCP_AUTO_PREWARM_TIMEOUT: "" })).toBe(DEFAULT_AUTO_PREWARM_TIMEOUT_MS);
    expect(parseAutoPrewarmTimeoutMs({ YAW_MCP_AUTO_PREWARM_TIMEOUT: "abc" })).toBe(DEFAULT_AUTO_PREWARM_TIMEOUT_MS);
    expect(parseAutoPrewarmTimeoutMs({ YAW_MCP_AUTO_PREWARM_TIMEOUT: "0" })).toBe(DEFAULT_AUTO_PREWARM_TIMEOUT_MS);
  });
  it("parses a positive integer", () => {
    expect(parseAutoPrewarmTimeoutMs({ YAW_MCP_AUTO_PREWARM_TIMEOUT: "45000" })).toBe(45000);
  });
});

describe("extractNpxPackages", () => {
  it("returns an empty list for an empty server list", () => {
    expect(extractNpxPackages([])).toEqual([]);
  });

  it("ignores remote entries", () => {
    expect(
      extractNpxPackages([makeServer({ namespace: "r", type: "remote", command: "npx", args: ["-y", "pkg@1"] })]),
    ).toEqual([]);
  });

  it("ignores non-npx commands", () => {
    expect(extractNpxPackages([makeServer({ namespace: "u", command: "uvx", args: ["pkg@1"] })])).toEqual([]);
    expect(extractNpxPackages([makeServer({ namespace: "d", command: "docker", args: ["run", "img"] })])).toEqual([]);
  });

  it("ignores npx without the `-y` flag", () => {
    expect(extractNpxPackages([makeServer({ namespace: "n", command: "npx", args: ["pkg@1"] })])).toEqual([]);
  });

  it("extracts a single npx -y <pkg>@<ver> entry", () => {
    expect(extractNpxPackages([makeNpx("pkg-a@1.0.0")])).toEqual(["pkg-a@1.0.0"]);
  });

  it("accepts the scoped-package shape @scope/name@<ver>", () => {
    expect(extractNpxPackages([makeNpx("@yawlabs/tailscale-mcp@latest")])).toEqual(["@yawlabs/tailscale-mcp@latest"]);
  });

  it("accepts semver and dist-tag versions", () => {
    expect(extractNpxPackages([makeNpx("a@1.2.3")])).toEqual(["a@1.2.3"]);
    expect(extractNpxPackages([makeNpx("a@1.2.3-beta.1")])).toEqual(["a@1.2.3-beta.1"]);
    expect(extractNpxPackages([makeNpx("a@latest")])).toEqual(["a@latest"]);
    expect(extractNpxPackages([makeNpx("a@*")])).toEqual(["a@*"]);
  });

  it("ignores args that do not look like a package spec", () => {
    expect(extractNpxPackages([makeServer({ namespace: "f", command: "npx", args: ["-y", "--foo"] })])).toEqual([]);
    expect(extractNpxPackages([makeServer({ namespace: "g", command: "npx", args: ["-y", "./local"] })])).toEqual([]);
    expect(extractNpxPackages([makeServer({ namespace: "h", command: "npx", args: ["-y", "FOO=bar"] })])).toEqual([]);
  });

  it("deduplicates two servers that use the same package spec", () => {
    const a = makeNpx("a@1.0.0", "ns1");
    const b = makeNpx("a@1.0.0", "ns2");
    expect(extractNpxPackages([a, b])).toEqual(["a@1.0.0"]);
  });

  it("preserves first-seen order across multiple unique packages", () => {
    expect(extractNpxPackages([makeNpx("b@1"), makeNpx("a@1"), makeNpx("c@1"), makeNpx("a@1")])).toEqual([
      "b@1",
      "a@1",
      "c@1",
    ]);
  });

  it("extracts a package that lives after a -p flag (npx -y -p <pkg> form)", () => {
    // Less common but legal; not refusing it means a custom args list does
    // not silently lose its prime.
    const server = makeServer({ namespace: "p", command: "npx", args: ["-y", "-p", "pkg-p@1.0.0"] });
    expect(extractNpxPackages([server])).toEqual(["pkg-p@1.0.0"]);
  });
});

// A minimal ChildProcess-shaped EventEmitter for the spawnImpl-injecting
// tests. The default-spawn tests use the EventEmitter-shaped child
// produced by the node:child_process mock above.
class FakeChild extends EventEmitter {
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

// Test helper: a spawnImpl whose child emits `close` next tick with the
// given exit code. The default-spawn-style done promise resolves from
// that close, so the parent function returns without waiting on the
// 30s kill timer. `exitCode` defaults to 0; pass a non-zero value to
// exercise the "ok: false, reason: exit" branch.
function okSpawn(spawned: string[], exitCode: number = 0) {
  return (pkg: string) => {
    spawned.push(pkg);
    const child = new FakeChild() as any;
    // Pre-attach a no-op `error` listener so a test that does not emit
    // `error` does not crash Node. The production code attaches its own
    // listener on the real child; the FakeChild is shared with the test
    // so we add the safety listener here.
    child.on("error", () => {});
    const done = new Promise<{ ok: boolean; reason: SpawnReason }>((resolve) => {
      child.on("close", () => resolve({ ok: exitCode === 0, reason: "exit" }));
    });
    setImmediate(() => child.emit("close", exitCode));
    return { package: pkg, child, done };
  };
}

// Test helper: a spawnImpl whose child emits `error` next tick. The
// production code's `child.on("error", ...)` handler resolves the done
// promise with `ok: false, reason: "spawn-error"`, so the parent
// function returns and the test asserts the failed-summary log line.
function errorSpawn(spawned: string[], message: string = "spawn npx ENOENT") {
  return (pkg: string) => {
    spawned.push(pkg);
    const child = new FakeChild() as any;
    const done = new Promise<{ ok: boolean; reason: SpawnReason }>((resolve) => {
      child.on("error", () => resolve({ ok: false, reason: "spawn-error" }));
    });
    setImmediate(() => child.emit("error", new Error(message)));
    return { package: pkg, child, done };
  };
}

describe("maybeAutoPrewarmNpxCache", () => {
  it("is a no-op when the opt-out env is set", async () => {
    vi.stubEnv("YAW_MCP_AUTO_PREWARM", "0");
    const spawnImpl = vi.fn();
    await maybeAutoPrewarmNpxCache({ listActiveServers: () => [makeNpx("a@1")], spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no active npx servers", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoPrewarmNpxCache({ listActiveServers: () => [], spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawns one child per unique npx package", async () => {
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1"), makeNpx("b@1")],
      spawnImpl: okSpawn(spawned),
    });
    expect(spawned.sort()).toEqual(["a@1", "b@1"]);
  });

  it("dedupes two servers that use the same package spec to one spawn", async () => {
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1", "ns1"), makeNpx("a@1", "ns2")],
      spawnImpl: okSpawn(spawned),
    });
    expect(spawned).toEqual(["a@1"]);
  });

  it("caps the package list at YAW_MCP_MAX_AUTO_PREWARM and logs a cap line", async () => {
    vi.stubEnv("YAW_MCP_MAX_AUTO_PREWARM", "2");
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1"), makeNpx("b@1"), makeNpx("c@1"), makeNpx("d@1")],
      spawnImpl: okSpawn(spawned),
    });
    expect(spawned).toEqual(["a@1", "b@1"]);
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("capping at 2 of 4 npx packages"),
      expect.objectContaining({ capped: 2, total: 4 }),
    );
  });

  it("skips the prewarm when the sidecars lock is held by another process", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1")],
      spawnImpl,
      acquireLockImpl: () => null,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("another process holds the sidecars lock"));
  });

  it("releases the sidecars lock exactly once after the spawns settle", async () => {
    let released = 0;
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1")],
      spawnImpl: okSpawn(spawned),
      acquireLockImpl: () => () => {
        released += 1;
      },
    });
    expect(released).toBe(1);
  });

  it("does not await the children -- they run in parallel", async () => {
    // Two children, each "completes" 50ms later. If the production code
    // awaited them serially, this would take >=100ms; in parallel it takes
    // ~50ms. Use a generous upper bound so a contended CI box does not
    // flake; the lower bound proves the parallelism, not the speed.
    const start = Date.now();
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1"), makeNpx("b@1")],
      spawnImpl: (pkg: string) => {
        spawned.push(pkg);
        const child = new FakeChild() as any;
        child.on("error", () => {});
        const done = new Promise<{ ok: boolean; reason: SpawnReason }>((resolve) => {
          setTimeout(() => resolve({ ok: true, reason: "exit" }), 50);
        });
        setTimeout(() => child.emit("close", 0), 50);
        return { package: pkg, child, done };
      },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(90);
  });

  it("absorbs a per-package timeout -- the function still returns and the failure is logged", async () => {
    // A child that never emits 'close' or 'error' and is then killed by
    // the timer. The default spawn path is not used here; the
    // timeout behaviour is exercised by the real one. We mirror its
    // shape: a child, a setTimeout that kills after the configured ms,
    // and a done promise that resolves with `timeout`.
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1")],
      perPackageTimeoutMs: () => 10,
      spawnImpl: (pkg: string) => {
        spawned.push(pkg);
        const child = new FakeChild() as any;
        child.on("error", () => {});
        const done = new Promise<{ ok: boolean; reason: SpawnReason }>((resolve) => {
          setTimeout(() => {
            child.kill();
            resolve({ ok: false, reason: "timeout" });
          }, 10);
        });
        return { package: pkg, child, done };
      },
    });
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("auto-prewarmed 0 of 1 npx packages"),
      expect.objectContaining({ ok: 0, failed: 1 }),
    );
  });

  it("absorbs a spawn error -- the function still returns", async () => {
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1")],
      spawnImpl: errorSpawn(spawned),
    });
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("auto-prewarmed 0 of 1 npx packages"),
      expect.objectContaining({ ok: 0, failed: 1 }),
    );
  });

  it("logs the summary line on a fully successful pass", async () => {
    const spawned: string[] = [];
    await maybeAutoPrewarmNpxCache({
      listActiveServers: () => [makeNpx("a@1"), makeNpx("b@1")],
      spawnImpl: okSpawn(spawned),
    });
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("auto-prewarmed 2 of 2 npx packages"),
      expect.objectContaining({ ok: 2, failed: 0 }),
    );
  });
});

// One more: pin that the default spawn -- the one real npx children go
// through -- applies the env-hygiene and the stdio discipline. The default
// is exercised through `maybeAutoPrewarmNpxCache` without injecting
// spawnImpl. The node:child_process mock at the top of this file captures
// every call and returns a child that emits `close` next tick.
describe("default spawn (no injected spawnImpl)", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("forwards an env that strips YAW_MCP_VAULT_PASSPHRASE and sets stdio to ignore", async () => {
    process.env.YAW_MCP_VAULT_PASSPHRASE = "super-secret";
    try {
      await maybeAutoPrewarmNpxCache({
        listActiveServers: () => [makeNpx("a@1")],
        acquireLockImpl: () => () => {},
      });
    } finally {
      delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    }
    expect(spawnCalls).toHaveLength(1);
    const { cmd, args, opts } = spawnCalls[0];
    expect(cmd).toBe("npx");
    expect(args).toEqual(["-y", "a@1", "--version"]);
    expect((opts as { stdio?: string }).stdio).toBe("ignore");
    const env = (opts as { env: Record<string, string> }).env;
    expect(env).toBeDefined();
    expect(env.YAW_MCP_VAULT_PASSPHRASE).toBeUndefined();
  });
});
