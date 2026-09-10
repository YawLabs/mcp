// Coverage for ConnectServer.start() — the ONLY startup path since the
// localMode branch was deleted. Everything here runs against a synthetic
// $HOME + cwd on the REAL filesystem (mkdtemp), so the trust gate, the
// grade cache, the state file and the bundles loader all exercise their
// production I/O. Five modules are mocked below — four process boundaries
// plus one seam:
//   - the stdio transport (it would seize the test runner's stdin);
//   - connectToUpstream/disconnectFromUpstream (they would spawn children);
//   - maybeAutoUpgrade (it can shell out to `npm install -g`);
//   - ensureUv (it would download a uv binary — the gate's own predicate,
//     uvLaunchKind, stays real);
//   - loadLocalBundles, pass-through except in the one "loader throws" case
//     (it swallows every I/O error internally, so start()'s catch is
//     unreachable from the filesystem alone).
//
// One further process boundary start() reaches is NOT stubbed here:
// maybeRefreshSidecars, which can run an `npm install`. It stays inert
// because sidecar-refresh gates each of its default implementations on
// process.env.VITEST, so under the runner the first gate answers "no managed
// tree" and it no-ops. That is a property of production code, not of this
// file — relax that gating and these tests start doing real work.
//
// $HOME is redirected by setting HOME + USERPROFILE rather than by mocking
// node:os — os.homedir() reads USERPROFILE on win32 and HOME on POSIX, so
// setting both moves EVERY homedir() default in the tree (persistence,
// grades-cache, local-bundles, trust, config-loader) in one move, with no
// module mock to drift out of sync.
//
// Path keys are built with join(), never POSIX literals: the SUT routes
// through path.join, which yields backslashes on the Windows runner.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared state the module mocks below reach into. vi.hoisted so the object
// exists before the (hoisted) vi.mock factories run.
const hoisted = vi.hoisted(() => ({
  transports: [] as Array<{ started: boolean; closed: boolean; sent: unknown[] }>,
  /** When set, the mocked loadLocalBundles rejects with this instead of
   *  reading the fixture. Exercises start()'s catch-and-continue branch. */
  bundlesError: null as Error | null,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  // Minimal Transport: Protocol.connect() only assigns onclose/onerror/
  // onmessage and awaits start(); send() is used by the list-changed
  // notifications, close() by shutdown().
  class FakeStdioServerTransport {
    onclose?: () => void;
    onerror?: (err: Error) => void;
    onmessage?: (msg: unknown) => void;
    started = false;
    closed = false;
    sent: unknown[] = [];
    constructor() {
      hoisted.transports.push(this);
    }
    async start(): Promise<void> {
      this.started = true;
    }
    async send(msg: unknown): Promise<void> {
      this.sent.push(msg);
    }
    async close(): Promise<void> {
      this.closed = true;
      this.onclose?.();
    }
  }
  return { StdioServerTransport: FakeStdioServerTransport };
});

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

// Never let a test shell out to `npm install -g`. start() fires this
// fire-and-forget, so a real call would outlive the test.
vi.mock("../auto-upgrade.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, maybeAutoUpgrade: vi.fn().mockResolvedValue(undefined) };
});

// Never let start()'s uv prewarm gate reach the real bootstrap (it would
// download a uv binary). The gate's own predicate (uvLaunchKind) stays real.
vi.mock("../uv-bootstrap.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, ensureUv: vi.fn().mockResolvedValue("uv") };
});

// Pass-through by default; only the "loader throws" case swaps in a
// rejection. loadLocalBundles swallows every I/O error internally, so the
// catch in start() is unreachable from the filesystem alone.
vi.mock("../local-bundles.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    loadLocalBundles: (opts: unknown) =>
      hoisted.bundlesError ? Promise.reject(hoisted.bundlesError) : actual.loadLocalBundles(opts),
  };
});

import { CONFIG_FILENAME, type ResolvedConfig } from "../config-loader.js";
import { gradesCachePath } from "../grades-cache.js";
import { localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME } from "../persistence.js";
import { ConnectServer } from "../server.js";
import { grantTrust, revokeTrust } from "../trust.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";
import { ensureUv } from "../uv-bootstrap.js";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "YAW_MCP_MIN_COMPLIANCE",
  "YAW_MCP_DISABLE_PERSISTENCE",
  "YAW_MCP_AUTO_LOAD",
  "YAW_MCP_SERVER_CAP",
  "YAW_MCP_TRUST_PROJECT",
  // Now that listedUpstreamTools drives the real tools/list handler,
  // resolveToolExposure() decides what these tests see -- so an exported value
  // has to be saved and cleared like every other knob here, or the developer's
  // shell picks the exposure the assertions run at.
  "YAW_MCP_TOOL_EXPOSURE",
] as const;

let synthHome: string;
let synthCwd: string;
let savedEnv: Record<string, string | undefined>;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let servers: ConnectServer[];

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.transports.length = 0;
  hoisted.bundlesError = null;
  servers = [];

  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-start-"));
  // cwd lives INSIDE the synthetic home so findProjectConfigDir's walk-up
  // stops at the home boundary and never reaches the developer's real
  // ~/.yaw-mcp/ (same isolation pattern as local-bundles.test.ts).
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));

  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // os.homedir() honours USERPROFILE on win32 and HOME on POSIX.
  process.env.HOME = synthHome;
  process.env.USERPROFILE = synthHome;
  delete process.env.YAW_MCP_MIN_COMPLIANCE;
  delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
  delete process.env.YAW_MCP_AUTO_LOAD;
  delete process.env.YAW_MCP_SERVER_CAP;
  delete process.env.YAW_MCP_TRUST_PROJECT;
  delete process.env.YAW_MCP_TOOL_EXPOSURE;

  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(synthCwd);

  vi.mocked(connectToUpstream).mockImplementation((async (config: UpstreamServerConfig) =>
    fakeConnection(config, [`${config.namespace}_live`])) as unknown as typeof connectToUpstream);
});

afterEach(async () => {
  for (const s of servers) await s.shutdown();
  cwdSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(synthHome, { recursive: true, force: true });
});

// --- fixtures ---------------------------------------------------------------

function fakeConnection(config: UpstreamServerConfig, toolNames: string[]): UpstreamConnection {
  return {
    config,
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: toolNames.map((name) => ({
      name,
      namespacedName: `${config.namespace}_${name}`,
      inputSchema: { type: "object" },
    })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as unknown as UpstreamConnection;
}

function bundlesPathIn(dir: string): string {
  return localBundlesPath(join(dir, CONFIG_DIRNAME));
}

function writeBundles(dir: string, servers: Array<Record<string, unknown>>): string {
  mkdirSync(join(dir, CONFIG_DIRNAME), { recursive: true });
  const path = bundlesPathIn(dir);
  writeFileSync(path, JSON.stringify({ version: 1, servers }));
  return path;
}

/** Rewrite bundles.json and push its mtime forward.
 *
 *  The forward stamp is not cosmetic. The reload gate is mtime+size, and a
 *  test rewrites a file within microseconds of the load it is supposed to
 *  invalidate -- well inside NTFS's ~15ms timestamp granularity -- so a
 *  same-size edit can land on the identical mtime and read as unchanged.
 *  A real user's edit is seconds away from the load; this makes the fixture
 *  match that rather than testing a race the feature never sees. */
function rewriteBundles(dir: string, servers: Array<Record<string, unknown>>): string {
  const path = writeBundles(dir, servers);
  const ahead = new Date(Date.now() + 10_000);
  utimesSync(path, ahead, ahead);
  return path;
}

/** Corrupt bundles.json the way a half-finished save in an editor does. */
function breakBundles(dir: string): void {
  const path = bundlesPathIn(dir);
  writeFileSync(path, '{"version": 1, "servers": [ {{{ ');
  const ahead = new Date(Date.now() + 10_000);
  utimesSync(path, ahead, ahead);
}

function serverEntry(namespace: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { namespace, name: namespace, type: "local", command: "echo", args: [namespace], ...extra };
}

function writeUserConfigFile(name: string, content: unknown): void {
  mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(join(synthHome, CONFIG_DIRNAME, name), JSON.stringify(content));
}

function writeState(state: Record<string, unknown>): void {
  writeUserConfigFile(STATE_FILENAME, state);
}

function writeGrades(grades: Record<string, { grade: string; score: number; gradedAt?: string }>): void {
  mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
  const full = Object.fromEntries(
    Object.entries(grades).map(([ns, g]) => [ns, { gradedAt: new Date().toISOString(), ...g }]),
  );
  writeFileSync(gradesCachePath(synthHome), JSON.stringify(full));
}

// --- harness ----------------------------------------------------------------

interface Started {
  server: ConnectServer;
  priv: any;
  /** Resolves once the fire-and-forget pre-warm started by start() has
   *  finished — start() never awaits it, so assertions about spawning
   *  would otherwise race. */
  prewarmed: Promise<void>;
  /** The same capture for the fire-and-forget auto-load. Meaningful ONLY
   *  when YAW_MCP_AUTO_LOAD is on: start() does not call
   *  autoLoadRecurringPack when the gate is off, so awaiting this in a
   *  gate-off test would hang until the suite timeout. */
  autoLoaded: Promise<void>;
  transport: { started: boolean; closed: boolean; sent: unknown[] };
}

/** Drive the downstream MCP initialize handshake through a fake transport.
 *  start() defers pre-warm (and auto-load) until the SDK's `oninitialized`
 *  fires -- the capability snapshot upstream connects mirror is only
 *  populated by the initialize request -- so tests that expect the
 *  startup activation paths to run must complete the handshake first,
 *  exactly like a real client. */
async function driveInitialize(
  transport: { onmessage?: (msg: unknown) => void },
  capabilities: Record<string, unknown> = {},
): Promise<void> {
  transport.onmessage?.({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  });
  // Let the initialize response settle before announcing initialized,
  // mirroring a real client's ordering.
  await new Promise((r) => setImmediate(r));
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** Construct + start a ConnectServer, capturing the pre-warm and auto-load
 *  promises. Each capture wraps the private method on the INSTANCE (production
 *  code is untouched) so the fire-and-forget call becomes awaitable. By
 *  default the downstream initialize handshake is driven too;
 *  `handshake: false` leaves the client un-initialized so the gating
 *  itself can be observed. `config` is handed to start() the way index.ts
 *  hands its already-loaded ResolvedConfig in. */
async function startServer(opts: { handshake?: boolean; config?: ResolvedConfig } = {}): Promise<Started> {
  const server = new ConnectServer();
  servers.push(server);
  const priv = server as any;

  const originalPrewarm = priv.prewarmDormantServers.bind(priv);
  let capturePrewarm: () => void = () => {};
  const prewarmCaptured = new Promise<void>((resolve) => {
    capturePrewarm = resolve;
  });
  let prewarmPromise: Promise<void> = Promise.resolve();
  priv.prewarmDormantServers = () => {
    prewarmPromise = originalPrewarm();
    capturePrewarm();
    return prewarmPromise;
  };

  const originalAutoLoad = priv.autoLoadRecurringPack.bind(priv);
  let captureAutoLoad: () => void = () => {};
  const autoLoadCaptured = new Promise<void>((resolve) => {
    captureAutoLoad = resolve;
  });
  let autoLoadPromise: Promise<void> = Promise.resolve();
  priv.autoLoadRecurringPack = () => {
    autoLoadPromise = originalAutoLoad();
    captureAutoLoad();
    return autoLoadPromise;
  };

  await server.start(opts.config ? { config: opts.config } : {});
  const transport = hoisted.transports[hoisted.transports.length - 1];
  if (opts.handshake !== false) {
    await driveInitialize(transport as any);
  }
  return {
    server,
    priv,
    prewarmed: (async () => {
      await prewarmCaptured;
      await prewarmPromise;
    })(),
    autoLoaded: (async () => {
      await autoLoadCaptured;
      await autoLoadPromise;
    })(),
    transport,
  };
}

function namespacesOf(priv: any): string[] {
  return (priv.config?.servers ?? []).map((s: UpstreamServerConfig) => s.namespace);
}

/**
 * Run `fn` with stderr captured, and hand back the JSON log lines logger.ts
 * wrote while it ran (one object per line; a non-JSON line comes back as
 * `{ raw }`). LOG_LEVEL is pinned blank for the duration so a developer
 * running with LOG_LEVEL=warn does not silence the info line under test.
 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: Array<Record<string, unknown>> }> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as never);
  vi.stubEnv("LOG_LEVEL", "");
  try {
    const result = await fn();
    const logs = written
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.length > 0)
      .map((line): Record<string, unknown> => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    return { result, logs };
  } finally {
    vi.unstubAllEnvs();
    spy.mockRestore();
  }
}

/** Namespaces connectToUpstream was actually asked to spawn, sorted. */
function spawnedNamespaces(): string[] {
  return vi
    .mocked(connectToUpstream)
    .mock.calls.map((c) => (c[0] as UpstreamServerConfig).namespace)
    .sort();
}

/**
 * Tool names a client would see in tools/list, minus the meta-tools.
 *
 * Drives the REAL tools/list handler rather than re-implementing its call to
 * buildToolList. The handler is where resolveToolExposure() and
 * this.sessionActivated get wired into the arguments, and the hand-rolled
 * stand-in this replaces passed neither -- so it ran at buildToolList's own
 * "full" default and could not fail a gateway-exposure regression, which is
 * exactly the wiring the auto-load test below needs to pin.
 */
async function listedUpstreamTools(priv: any): Promise<string[]> {
  const handler = priv.server._requestHandlers.get("tools/list");
  const res = await handler({ method: "tools/list", params: {} }, {} as never);
  return res.tools.map((t: { name: string }) => t.name).filter((n: string) => !n.startsWith("mcp_connect_"));
}

/**
 * Run `fn` with tools/list at "full" exposure.
 *
 * The DEFERRED placeholders that pre-warm produces are a full-exposure-only
 * surface: gateway mode withholds them on purpose (they are the ~27,000 tokens
 * the mode exists to remove), so a test asserting a cached tool is visible
 * without a live child has to name the exposure it means instead of inheriting
 * whichever one the environment happens to carry.
 */
async function atFullExposure<T>(fn: () => Promise<T>): Promise<T> {
  process.env.YAW_MCP_TOOL_EXPOSURE = "full";
  try {
    return await fn();
  } finally {
    delete process.env.YAW_MCP_TOOL_EXPOSURE;
  }
}

// --- tests ------------------------------------------------------------------

describe("ConnectServer.start() — transport + config load", () => {
  it("connects the stdio transport and loads the user-global bundles.json", async () => {
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("slack")]);

    const { priv, transport, prewarmed } = await startServer();
    await prewarmed;

    expect(hoisted.transports).toHaveLength(1);
    expect(transport.started).toBe(true);
    expect(namespacesOf(priv).sort()).toEqual(["gh", "slack"]);
    // configVersion is the content hash the loader derives, not the empty
    // string start() falls back to when nothing loaded.
    expect(priv.configVersion).toMatch(/^local-[0-9a-f]{16}$/);
    expect(priv.persistenceReady).toBe(true);
  });

  it("makes a loaded server's tools reachable in tools/list after pre-warm", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // Pre-warm spawned it, cached the tools, then disconnected: the server
    // is surfaced as deferred, so the client sees tools without a live child.
    expect(spawnedNamespaces()).toEqual(["gh"]);
    expect(priv.connections.size).toBe(0);
    expect(await atFullExposure(() => listedUpstreamTools(priv))).toEqual(["gh_gh_live"]);
    // And the same handler withholds it under the default gateway exposure --
    // the deferred placeholder is the token cost that mode exists to remove.
    // buildToolRoutes ignores exposure, so a first tools/call still reaches it.
    expect(await listedUpstreamTools(priv)).toEqual([]);
    expect(priv.toolRoutes.has("gh_gh_live")).toBe(true);
  });

  it("carries a loader warning through to what discover shows the model", async () => {
    // The WIRING test. The render side is unit-tested in server.test.ts by
    // setting configWarnings directly, which cannot catch the loader ->
    // field -> discover chain being cut: drop the retention assignment and
    // that unit test still passes while every model sees a clean listing of
    // a broken install. This drives the REAL loader over a real file, so it
    // fails if any link goes.
    //
    // env as a bare string is the hand-edit shape: the loader throws away
    // every variable, and the entry still loads and still renders [ready].
    writeBundles(synthHome, [serverEntry("gh", { env: "TOKEN=abc" })]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    const text = priv.handleDiscover().content[0].text;
    expect(text).toContain("ignoring 'env' on \"gh\"");
    expect(text.indexOf("ignoring")).toBeLessThan(text.indexOf("Installed MCP servers"));
  });

  it("shows no warning banner when bundles.json is clean", async () => {
    // Same path, the silence half: a normal config must not put a banner at
    // the top of every discover call.
    writeBundles(synthHome, [serverEntry("gh")]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    const text = priv.handleDiscover().content[0].text;
    expect(text.startsWith("Installed MCP servers")).toBe(true);
  });

  it("drops a duplicate namespace from bundles.json, keeping the first entry", async () => {
    writeBundles(synthHome, [
      serverEntry("dup", { name: "First" }),
      serverEntry("dup", { name: "Second", command: "node" }),
    ]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(priv.config.servers).toHaveLength(1);
    expect(priv.config.servers[0].name).toBe("First");
    // And the survivor is the one that got pre-warmed, exactly once.
    expect(spawnedNamespaces()).toEqual(["dup"]);
  });

  it("still starts (with an empty config) when loadLocalBundles throws", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);
    hoisted.bundlesError = new Error("disk on fire");

    const { priv, transport, prewarmed } = await startServer();
    await prewarmed;

    // The catch in start() must degrade to an empty config, not abort:
    // the transport is still connected so the client gets meta-tools.
    expect(transport.started).toBe(true);
    expect(priv.config).toEqual({ servers: [], configVersion: "" });
    expect(spawnedNamespaces()).toEqual([]);
  });
});

describe("ConnectServer.start() — project-bundle trust gate", () => {
  it("ignores an UNTRUSTED project bundles.json and still loads user-global", async () => {
    writeBundles(synthHome, [serverEntry("userglobal")]);
    writeBundles(synthCwd, [serverEntry("hostile", { command: "curl" })]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(namespacesOf(priv)).toEqual(["userglobal"]);
    // The security invariant, stated as the thing that must not happen:
    // nothing from the unapproved repo file was ever spawned.
    expect(spawnedNamespaces()).toEqual(["userglobal"]);
  });

  it("honours the SAME project bundles.json once it is trusted", async () => {
    // Negative control for the case above: proves the project file was
    // found and parseable, so "ignored" was the trust gate deciding — not
    // a fixture that never loaded in the first place.
    writeBundles(synthHome, [serverEntry("userglobal")]);
    const projectPath = writeBundles(synthCwd, [serverEntry("hostile", { command: "curl" })]);
    await grantTrust(projectPath, readFileSync(projectPath), { home: synthHome });

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // An approved project file wins outright — no merge with user-global.
    expect(namespacesOf(priv)).toEqual(["hostile"]);
    expect(spawnedNamespaces()).toEqual(["hostile"]);
  });
});

describe("ConnectServer.start() — compliance grade hydration", () => {
  it("applies grades.json so a below-floor server is refused", async () => {
    writeBundles(synthHome, [serverEntry("shaky"), serverEntry("solid")]);
    writeGrades({ shaky: { grade: "D", score: 41 }, solid: { grade: "A", score: 98 } });
    process.env.YAW_MCP_MIN_COMPLIANCE = "B";

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // The grade reached this.config.servers (nothing else supplies it —
    // validateEntry strips complianceGrade from bundles.json).
    const shaky = priv.config.servers.find((s: UpstreamServerConfig) => s.namespace === "shaky");
    expect(shaky.complianceGrade).toBe("D");

    // ...and the floor therefore bites: pre-warm never spawned it.
    expect(spawnedNamespaces()).toEqual(["solid"]);

    const refusal = await priv.activateOne("shaky");
    expect(refusal.ok).toBe(false);
    expect(refusal.message).toContain("compliance grade D is below YAW_MCP_MIN_COMPLIANCE=B");
    expect((await priv.activateOne("solid")).ok).toBe(true);
  });

  it("leaves servers ungraded — and loadable — when grades.json is absent", async () => {
    // Negative control: identical fixture and floor, no grade cache. If
    // this ALSO refused, the test above would be passing for the wrong
    // reason (env var alone rather than the hydration).
    writeBundles(synthHome, [serverEntry("shaky"), serverEntry("solid")]);
    process.env.YAW_MCP_MIN_COMPLIANCE = "B";

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    const shaky = priv.config.servers.find((s: UpstreamServerConfig) => s.namespace === "shaky");
    expect(shaky.complianceGrade).toBeUndefined();
    expect(spawnedNamespaces()).toEqual(["shaky", "solid"]);
    expect((await priv.activateOne("shaky")).ok).toBe(true);
  });
});

describe("ConnectServer.start() — persisted state hydration", () => {
  const learnedAt = Date.now() - 60_000;

  function writeV2StateWithCache(): void {
    writeState({
      version: 2,
      savedAt: Date.now(),
      learning: { known: { dispatched: 7, succeeded: 6, lastUsedAt: learnedAt } },
      packHistory: [],
      toolCache: {
        known: { tools: [{ name: "cached_tool", description: "from state.json" }], learnedAt },
      },
    });
  }

  it("hydrates the persisted tool cache and skips pre-warm for servers it already knows", async () => {
    writeBundles(synthHome, [serverEntry("known"), serverEntry("fresh")]);
    writeV2StateWithCache();

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // hasKnownTools() reads the hydrated cache, so only "fresh" is dormant.
    expect(spawnedNamespaces()).toEqual(["fresh"]);
    expect(priv.toolCache.get("known")).toEqual([{ name: "cached_tool", description: "from state.json" }]);
    // The original age rides through the round-trip — a hydrated entry must
    // not be refreshed for free, or it would never age out under the TTL.
    expect(priv.toolCacheLearnedAt.get("known")).toBe(learnedAt);
    // And the cached tools are visible to the client without a spawn (at the
    // exposure where deferred placeholders are advertised at all).
    expect((await atFullExposure(() => listedUpstreamTools(priv))).sort()).toEqual([
      "fresh_fresh_live",
      "known_cached_tool",
    ]);
  });

  it("pre-warms EVERY server when there is no persisted tool cache", async () => {
    // Negative control for the skip above.
    writeBundles(synthHome, [serverEntry("known"), serverEntry("fresh")]);

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(spawnedNamespaces()).toEqual(["fresh", "known"]);
    expect(priv.toolCacheLearnedAt.get("known")).toBeGreaterThan(learnedAt);
  });

  it("reads a v1 state.json — learning and pack history survive the v2 migration", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);
    writeState({
      version: 1,
      savedAt: Date.now(),
      learning: { gh: { dispatched: 5, succeeded: 4, lastUsedAt: learnedAt } },
      packHistory: [{ namespace: "gh", toolName: "list_prs", at: learnedAt }],
      // no toolCache key at all — that IS the v1 shape
    });

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(priv.learning.exportSnapshot().gh).toMatchObject({ dispatched: 5, succeeded: 4 });
    expect(priv.packDetector.exportSnapshot()).toHaveLength(1);
    // v1 carries no tool cache, so the server is still dormant and gets
    // pre-warmed — the migration must not fabricate a cache entry.
    expect(spawnedNamespaces()).toEqual(["gh"]);
  });

  it("hydrates nothing when YAW_MCP_DISABLE_PERSISTENCE=1", async () => {
    // Negative control for both hydration tests above: same state.json,
    // one env toggle, and every restored signal must disappear.
    writeBundles(synthHome, [serverEntry("known"), serverEntry("fresh")]);
    writeV2StateWithCache();
    process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(priv.persistenceReady).toBe(false);
    expect(priv.learning.exportSnapshot()).toEqual({});
    // "known" is no longer known, so pre-warm has to spawn it.
    expect(spawnedNamespaces()).toEqual(["fresh", "known"]);
  });
});

describe("ConnectServer.start() — uv bootstrap prewarm gate", () => {
  it("prewarms uv for a cased/.exe uv launcher, matching what activation will bootstrap", async () => {
    // resolveUvSpawn bootstraps any bare uv/uvx spelling (uvLaunchKind), so
    // the startup gate must match the same set -- an exact-string gate let
    // `UVX.exe` configs skip the prewarm and pay the 2-10s ensureUv
    // download on the activation path instead.
    writeBundles(synthHome, [serverEntry("py", { command: "UVX.exe" })]);

    const { prewarmed } = await startServer();
    await prewarmed;

    expect(vi.mocked(ensureUv)).toHaveBeenCalled();
  });

  it("does not prewarm uv for a path-pinned uv binary", async () => {
    // A command with a path separator is a user pin on one concrete
    // binary; resolveUvSpawn passes it through untouched, so prewarming
    // the managed download would be pure waste.
    writeBundles(synthHome, [serverEntry("py", { command: "C:/tools/uv.exe" })]);

    const { prewarmed } = await startServer();
    await prewarmed;

    expect(vi.mocked(ensureUv)).not.toHaveBeenCalled();
  });
});

describe("ConnectServer.start() — startup activation waits for the initialize handshake", () => {
  it("does not pre-warm before the client initializes, then pre-warms after", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);

    const { transport, prewarmed } = await startServer({ handshake: false });
    // Transport is up (the client can talk to us), but nothing spawned:
    // upstream connects mirror the downstream capability snapshot, which
    // only exists once initialize has been handled, so pre-warm must wait.
    expect(transport.started).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(spawnedNamespaces()).toEqual([]);

    await driveInitialize(transport as any);
    await prewarmed;
    expect(spawnedNamespaces()).toEqual(["gh"]);
  });

  it("pre-warm's upstream connects see the downstream capability snapshot", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);

    // Record what the bridge reports AT CONNECT TIME -- upstream.ts reads
    // it once, at Client construction, so a snapshot that fills in later
    // would not help a connection spawned too early.
    const capsAtConnect: unknown[] = [];
    vi.mocked(connectToUpstream).mockImplementation((async (
      config: UpstreamServerConfig,
      _onDisconnect: unknown,
      _onListChanged: unknown,
      bridge: { getClientCapabilities: () => unknown } | undefined,
    ) => {
      capsAtConnect.push(bridge?.getClientCapabilities());
      return fakeConnection(config, [`${config.namespace}_live`]);
    }) as unknown as typeof connectToUpstream);

    const { transport, prewarmed } = await startServer({ handshake: false });
    await driveInitialize(transport as any, { elicitation: {}, sampling: {} });
    await prewarmed;

    // Presence, not exact shape: the SDK normalizes sub-capabilities (a
    // bare `elicitation: {}` gains `form: {}`), and pinning that would
    // couple the test to an SDK version. What matters is that the
    // snapshot was non-empty at connect time.
    expect(capsAtConnect).toHaveLength(1);
    const caps = capsAtConnect[0] as { elicitation?: unknown; sampling?: unknown };
    expect(caps.elicitation).toBeDefined();
    expect(caps.sampling).toBeDefined();
  });
});

describe("ConnectServer.start() — opt-in auto-load of the recurring pack", () => {
  /** Persisted history holding TWO {gh, linear} bursts. The 10-minute gap
   *  between them is what makes the set recurring: the pack detector closes a
   *  burst at a 120 s idle boundary, and a namespace set has to appear in at
   *  least two bursts before detectChains() will surface it. */
  function writeRecurringPackHistory(): void {
    const first = Date.now() - 30 * 60_000;
    const second = first + 10 * 60_000;
    writeState({
      version: 2,
      savedAt: Date.now(),
      learning: {},
      packHistory: [
        { namespace: "gh", toolName: "list_prs", at: first },
        { namespace: "linear", toolName: "list_issues", at: first + 1_000 },
        { namespace: "gh", toolName: "list_prs", at: second },
        { namespace: "linear", toolName: "list_issues", at: second + 1_000 },
      ],
      toolCache: {},
    });
  }

  it("activates and advertises the top pack when YAW_MCP_AUTO_LOAD=1", async () => {
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear"), serverEntry("solo")]);
    writeRecurringPackHistory();
    process.env.YAW_MCP_AUTO_LOAD = "1";

    const { priv, prewarmed, autoLoaded } = await startServer();
    await Promise.all([prewarmed, autoLoaded]);

    // Auto-load activates for REAL, unlike pre-warm, which disconnects as
    // soon as it has learned the tool list. The pack's members are the only
    // servers still holding a connection.
    expect(priv.connections.has("gh")).toBe(true);
    expect(priv.connections.has("linear")).toBe(true);
    expect(priv.connections.has("solo")).toBe(false);
    // And they are ADVERTISED: under the default gateway exposure a connected
    // namespace stays invisible in tools/list until it lands in
    // sessionActivated, so without this the feature spends a cap slot and a
    // child process on a pack the client still has to discover and activate —
    // the exact step YAW_MCP_AUTO_LOAD exists to skip.
    expect([...priv.sessionActivated].sort()).toEqual(["gh", "linear"]);
    // Asserted through the REAL tools/list handler, at the real default
    // exposure, so the sessionActivated bookkeeping above is checked where it
    // actually pays off. `solo` is neither connected nor advertised, and
    // gateway mode withholds deferred placeholders, so it contributes nothing.
    expect((await listedUpstreamTools(priv)).sort()).toEqual(["gh_gh_live", "linear_linear_live"]);
  });

  it("says why auto-load is skipped when persistence is disabled", async () => {
    // The flag is set, but with YAW_MCP_DISABLE_PERSISTENCE there is no
    // history to replay from, so the recurring pack never loads -- and
    // nothing used to say so. `autoLoaded` is deliberately not awaited:
    // autoLoadRecurringPack is never called on this path.
    writeBundles(synthHome, [serverEntry("gh")]);
    process.env.YAW_MCP_AUTO_LOAD = "1";
    process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";

    const { result, logs } = await captureLogs(() => startServer());
    await result.prewarmed;

    const skipped = logs.find((l) => typeof l.msg === "string" && l.msg.includes("skipping auto-load"));
    expect(skipped).toBeDefined();
    expect(String(skipped?.reason)).toContain("YAW_MCP_DISABLE_PERSISTENCE");
    expect(result.priv.sessionActivated.size).toBe(0);
  });

  it("auto-loads nothing when YAW_MCP_AUTO_LOAD is unset", async () => {
    // Negative control: identical history and servers, gate off. `autoLoaded`
    // is deliberately not awaited — start() never calls autoLoadRecurringPack
    // here, so it never resolves.
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear"), serverEntry("solo")]);
    writeRecurringPackHistory();

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(priv.sessionActivated.size).toBe(0);
    // Pre-warm learned every server's tools and hung up; nothing stayed live.
    expect(priv.connections.size).toBe(0);
    expect(spawnedNamespaces()).toEqual(["gh", "linear", "solo"]);
  });
});

describe("ConnectServer.start() — config warnings + handed-in config", () => {
  it("logs the config loader's warnings when it loads the config itself", async () => {
    // An embedded host constructs ConnectServer directly and never runs
    // index.ts, which is where the CLI path logged these. A typo'd key fails
    // OPEN to allow-all, so a silent load is the worst outcome.
    writeBundles(synthHome, [serverEntry("gh")]);
    writeUserConfigFile(CONFIG_FILENAME, { blocke: ["gh"] });

    const { result, logs } = await captureLogs(() => startServer());
    await result.prewarmed;

    const warning = logs.find((l) => l.msg === "Config warning");
    expect(warning).toBeDefined();
    expect(String(warning?.warning)).toContain("'blocke'");
    // ...and it did fail open: nothing is blocked.
    expect(result.priv.profile).toBeNull();
  });

  it("uses a handed-in config without re-loading from disk or re-logging its warnings", async () => {
    // index.ts loads the config before constructing the server (for the
    // warnings, which it logs itself) and hands it in, so one read serves
    // both. On disk: nothing blocked. Handed in: linear blocked. The profile
    // must come from the argument, and its warnings are the caller's.
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const configPath = join(synthHome, CONFIG_DIRNAME, CONFIG_FILENAME);
    const config: ResolvedConfig = {
      blocked: ["linear"],
      projectConfigDir: null,
      loadedFiles: [{ path: configPath, scope: "global", blocked: ["linear"] }],
      warnings: ["already logged by the caller"],
    };

    const { result, logs } = await captureLogs(() => startServer({ config }));
    await result.prewarmed;

    expect(result.priv.profile?.blocked).toEqual(["linear"]);
    expect(result.priv.profile?.path).toBe(configPath);
    expect(logs.some((l) => l.msg === "Config warning")).toBe(false);
    // The profile is really in effect: pre-warm skipped the blocked namespace.
    expect(spawnedNamespaces()).toEqual(["gh"]);
  });
});

describe("ConnectServer.start() — profile", () => {
  it("loads the user-global profile and skips pre-warm for a blocked namespace", async () => {
    writeBundles(synthHome, [serverEntry("allowed"), serverEntry("denied")]);
    writeUserConfigFile(CONFIG_FILENAME, { blocked: ["denied"] });

    const { priv, prewarmed } = await startServer();
    await prewarmed;

    expect(priv.profile).not.toBeNull();
    expect(priv.profile.blocked).toEqual(["denied"]);
    // The server stays in the config (it is installed) but the profile
    // keeps it out of every surfacing path, pre-warm included.
    expect(namespacesOf(priv).sort()).toEqual(["allowed", "denied"]);
    expect(spawnedNamespaces()).toEqual(["allowed"]);
    // Full exposure so the assertion is about the PROFILE, not about gateway
    // mode withholding the deferred placeholders of both namespaces alike.
    expect(await atFullExposure(() => listedUpstreamTools(priv))).toEqual(["allowed_allowed_live"]);
  });
});

describe("ConnectServer -- live bundles.json reload", () => {
  // Every test here drives the reload through the REAL meta-tool entry point
  // (handleToolCall), against the REAL loader and the REAL trust gate on a
  // real filesystem. That matters more here than anywhere else in this file:
  // the whole feature is "what happens when the bytes on disk change", so a
  // stubbed loader would test the mock's idea of a config change.

  it("picks up a server added to bundles.json at the next meta-tool call", async () => {
    // The headline behaviour: adding a server used to require killing the
    // client session, and discover's own text said so.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    expect(namespacesOf(priv).sort()).toEqual(["gh"]);

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);

    // Not a direct call to the reload method -- through the meta-tool the
    // model actually calls, so the boundary itself is what is under test.
    await priv.handleToolCall("mcp_connect_discover", {});
    expect(namespacesOf(priv).sort()).toEqual(["gh", "linear"]);
  });

  it("tells the client its tool list moved when the config changed", async () => {
    // An added server is new ADVERTISED surface even though nothing connected:
    // the deferred routes come straight off this.config. Without the
    // notification the client keeps serving a stale tools/list until something
    // else happens to move it.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    const refresh = vi.spyOn(priv, "refreshRoutesAndNotify");

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(refresh).toHaveBeenCalled();
  });

  it("costs a stat and nothing more when bundles.json has not changed", async () => {
    // The reason this is a lazy stat rather than a filesystem watcher: the
    // common case is that nothing moved, and it must not turn every meta-tool
    // call into a read + trust probe + parse.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    const applied = vi.spyOn(priv, "applyReloadedBundles");

    await priv.handleToolCall("mcp_connect_discover", {});
    await priv.handleToolCall("mcp_connect_health", {});

    expect(applied).not.toHaveBeenCalled();
  });

  it("does not reload on a PROXIED tool call", async () => {
    // The one call shape a reload could invalidate mid-flight. A proxied call
    // runs entirely on the config that was live when it started; the boundary
    // is meta-tools only, and this is the assertion that keeps it that way.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    // The shared fakeConnection stubs callTool with a bare vi.fn(), which
    // resolves undefined; the proxy books the RESULT, so this one test needs a
    // real reply to get through the path it is asserting about.
    priv.connections.get("gh").client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const applied = vi.spyOn(priv, "applyReloadedBundles");

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    // A real proxied name, routed like any upstream tool call.
    await priv.handleToolCall("gh_gh_live", {});

    expect(applied).not.toHaveBeenCalled();
    expect(namespacesOf(priv).sort()).toEqual(["gh"]);
  });

  it("unloads a connected server that the new config no longer defines", async () => {
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(priv.connections.has("gh")).toBe(true);

    rewriteBundles(synthHome, [serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});

    // Both halves matter: the child process is gone AND the tools it was
    // advertising have left the surface. Dropping the entry without the
    // teardown would leave a live child nothing can route to.
    expect(priv.connections.has("gh")).toBe(false);
    expect(await atFullExposure(() => listedUpstreamTools(priv))).not.toContain("gh_gh_live");
  });

  it("unloads a connected server whose launch config changed", async () => {
    // The live child is running the OLD argv. Leaving it up would serve the
    // user's edit back to them as if it had not happened.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });

    rewriteBundles(synthHome, [serverEntry("gh", { args: ["gh", "--new-flag"] })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.connections.has("gh")).toBe(false);
  });

  it("keeps a connected server up when only its description changed", async () => {
    // Presentation metadata is not a launch change. Killing a healthy child
    // over a reworded description would make editing the file hostile.
    writeBundles(synthHome, [serverEntry("gh", { description: "before" })]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });

    rewriteBundles(synthHome, [serverEntry("gh", { description: "after" })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.connections.has("gh")).toBe(true);
    expect(priv.config.servers[0].description).toBe("after");
  });

  it("unloads a connected server switched to isActive:false", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });

    rewriteBundles(synthHome, [serverEntry("gh", { isActive: false })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.connections.has("gh")).toBe(false);
  });

  it("never cuts an in-flight call, and retries the teardown at the next boundary", async () => {
    // The judgement call this feature turns on. A concurrent meta-tool call
    // must not close a connection a proxied call (or an exec pipeline) is
    // using: the close rejects the caller's own pending tools/call, which is
    // then booked as a 0.0 reliability outcome against a server that was
    // answering normally and that WE killed.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    priv.inflightCalls.set("gh", 1);

    rewriteBundles(synthHome, [serverEntry("gh", { args: ["gh", "--new-flag"] })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.connections.has("gh")).toBe(true);

    // And the deferral is not permanent. The fingerprint was already adopted
    // by the re-read above, so without the pending flag this second boundary
    // would see an unchanged file and skip the teardown forever -- leaving a
    // connection running on config the user replaced.
    priv.inflightCalls.delete("gh");
    await priv.handleToolCall("mcp_connect_health", {});
    expect(priv.connections.has("gh")).toBe(false);
  });

  it("keeps the running config when bundles.json becomes unparseable", async () => {
    // Saving a broken JSON must never blank the session.
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });

    breakBundles(synthHome);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(namespacesOf(priv).sort()).toEqual(["gh", "linear"]);
    expect(priv.connections.has("gh")).toBe(true);
    // The break is not silent, though: discover renders configWarnings, so the
    // model is told the file on disk is broken while the session keeps serving
    // what it loaded.
    expect(priv.configWarnings.join(" ")).toContain("invalid JSON");
  });

  it("does not re-parse an unchanged broken file on every meta-tool call", async () => {
    // The fingerprint is adopted before the read is judged, so a file that
    // stays broken costs one stat per boundary, not a parse per boundary.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    breakBundles(synthHome);
    const applied = vi.spyOn(priv, "applyReloadedBundles");
    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_health", {});

    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("recovers when the broken file is fixed", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    breakBundles(synthHome);
    await priv.handleToolCall("mcp_connect_health", {});
    expect(namespacesOf(priv).sort()).toEqual(["gh"]);

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});
    expect(namespacesOf(priv).sort()).toEqual(["gh", "linear"]);
  });

  it("will not load an untrusted project bundles.json on reload", async () => {
    // Reload must not become a way around the consent gate. A hostile repo
    // that writes .yaw-mcp/bundles.json mid-session gets exactly what it gets
    // at startup: ignored, and the user-global file left standing.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    rewriteBundles(synthCwd, [serverEntry("evil")]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(namespacesOf(priv).sort()).toEqual(["gh"]);
  });

  it("drops an APPROVED project file once its bytes change", async () => {
    // The trust pin is over CONTENT, so editing an approved project file
    // revokes its own approval. Reload has to honour that rather than carrying
    // the old grant forward -- otherwise approving a project file once would
    // approve every later edit to it, which is the smuggling path.
    const projectPath = writeBundles(synthCwd, [serverEntry("proj")]);
    await grantTrust(projectPath, readFileSync(projectPath), { home: synthHome });
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    // Baseline: the approved project file wins outright over user-global.
    expect(namespacesOf(priv).sort()).toEqual(["proj"]);

    rewriteBundles(synthCwd, [serverEntry("proj"), serverEntry("smuggled")]);
    await priv.handleToolCall("mcp_connect_health", {});

    // Not "proj + smuggled", and not "proj": the edited file is no longer
    // approved at all, so the user-global file loads as if it were not there.
    expect(namespacesOf(priv).sort()).toEqual(["gh"]);
  });

  it("dedupes a namespace duplicated by the RELOAD, not just by startup", async () => {
    // The dedupe used to live inline in start(), where a duplicate could only
    // ever arrive at startup. Reload is a second way in, and the routing state
    // assumes one server per namespace either way -- so both paths share one
    // copy of the filter. Without that sharing this is silent corruption
    // reached through the newer door.
    writeBundles(synthHome, [serverEntry("gh", { args: ["first"] })]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    rewriteBundles(synthHome, [serverEntry("gh", { args: ["first"] }), serverEntry("gh", { args: ["second"] })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.config.servers.filter((x: UpstreamServerConfig) => x.namespace === "gh")).toHaveLength(1);
    // First occurrence wins, matching what startup has always done.
    expect(priv.config.servers[0].args).toEqual(["first"]);
  });

  it("keeps compliance grades on the servers a reload re-read", async () => {
    // Grades come from ~/.yaw-mcp/grades.json and are OVERLAID onto the parsed
    // entries -- validateEntry drops complianceGrade, so a freshly-parsed entry
    // always arrives ungraded. Without re-overlaying them the reload would
    // blank the [A]-[F] badge on every server it re-read and, worse, silently
    // stop YAW_MCP_MIN_COMPLIANCE filtering (ungraded passes by default).
    writeGrades({ gh: { grade: "A", score: 95 } });
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    expect(priv.config.servers.find((x: UpstreamServerConfig) => x.namespace === "gh").complianceGrade).toBe("A");

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.config.servers.find((x: UpstreamServerConfig) => x.namespace === "gh").complianceGrade).toBe("A");
  });

  it("stops re-invoking a loader that throws, and keeps the running config", async () => {
    // The loader swallows its own I/O errors, so this path needs the seam.
    // It is the ONE case the pre-read fingerprint adoption exists for: a throw
    // returns before the loader can report which paths it consulted, so
    // nothing downstream re-fingerprints, and the re-read would otherwise
    // repeat on every meta-tool call for the rest of the session.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // Set only AFTER start(), so the session has a real watch set to begin
    // with and it is the RELOAD that meets the throw.
    hoisted.bundlesError = new Error("injected loader failure");
    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const applied = vi.spyOn(priv, "applyReloadedBundles");

    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_health", {});

    expect(applied).toHaveBeenCalledTimes(1);
    // And the throw cost the session nothing it already had.
    expect(namespacesOf(priv).sort()).toEqual(["gh"]);
  });

  it("does not reload for a session whose startup load never reported a watch set", async () => {
    // A ConnectServer that never ran start() (embedded hosts, most unit tests)
    // has no confirmed watch set, and reload stays off rather than guessing at
    // the canonical paths. This is what keeps the pre-reload behaviour of
    // every such caller byte-identical.
    const server = new ConnectServer();
    servers.push(server);
    const priv = server as any;
    const applied = vi.spyOn(priv, "applyReloadedBundles");

    writeBundles(synthHome, [serverEntry("gh")]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(applied).not.toHaveBeenCalled();
  });
});

describe("ConnectServer -- reload vs. an activation already in flight", () => {
  // reconcileConfig iterates this.connections, and connectToUpstream only
  // inserts there once its handshake RESOLVES. A namespace whose entry is
  // removed, disabled or relaunched during that handshake is therefore in
  // nothing the reconcile can see, and the connection lands afterwards --
  // permanently unreaped, still serving a server the user has already
  // replaced. These tests hold the handshake open so the window is a fixture
  // rather than a race.

  /** Swap connectToUpstream for one that parks until the returned release is
   *  called, so a test can put a whole config reload inside one handshake. */
  function gateConnect(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(connectToUpstream).mockImplementation((async (config: UpstreamServerConfig) => {
      await gate;
      return fakeConnection(config, [`${config.namespace}_live`]);
    }) as unknown as typeof connectToUpstream);
    return release;
  }

  it("closes an in-flight activation whose server the reload removed", async () => {
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    // Pre-warm learns tool lists by connecting and disconnecting, so the
    // disconnect assertions below have to start from a clean count.
    vi.mocked(disconnectFromUpstream).mockClear();

    const release = gateConnect();
    const activating = priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await new Promise((r) => setImmediate(r));
    expect(priv.connections.has("gh")).toBe(false);

    // The user deletes the entry while the child is still handshaking. The
    // reconcile this triggers has nothing to iterate for "gh".
    rewriteBundles(synthHome, [serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_discover", {});
    expect(namespacesOf(priv).sort()).toEqual(["linear"]);

    release();
    const res = await activating;

    // Both halves: the connection never joins the session, and the child that
    // did come up is actually closed rather than dropped on the floor.
    expect(priv.connections.has("gh")).toBe(false);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("gh");
  });

  it("closes an in-flight activation whose launch config the reload changed", async () => {
    // Same window, the commoner edit: the entry survives but the child now
    // running is on the OLD argv, which is exactly what reconcileConfig tears
    // down for a connection that made it into the map in time.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    const release = gateConnect();
    const activating = priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await new Promise((r) => setImmediate(r));

    rewriteBundles(synthHome, [serverEntry("gh", { args: ["gh", "--new-flag"] })]);
    await priv.handleToolCall("mcp_connect_discover", {});

    release();
    await activating;

    expect(priv.connections.has("gh")).toBe(false);
  });

  it("closes an in-flight activation whose server the reload disabled", async () => {
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    const release = gateConnect();
    const activating = priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await new Promise((r) => setImmediate(r));

    rewriteBundles(synthHome, [serverEntry("gh", { isActive: false })]);
    await priv.handleToolCall("mcp_connect_discover", {});

    release();
    await activating;

    expect(priv.connections.has("gh")).toBe(false);
  });

  it("keeps an in-flight activation the reload did not touch", async () => {
    // The other direction, and the reason the gate is a launch-identity
    // comparison rather than "did the config move at all": a reload triggered
    // by an UNRELATED entry must not cost the user the server they are in the
    // middle of loading.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    vi.mocked(disconnectFromUpstream).mockClear();

    const release = gateConnect();
    const activating = priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await new Promise((r) => setImmediate(r));

    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_discover", {});

    release();
    await activating;

    expect(priv.connections.has("gh")).toBe(true);
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
  });

  it("does not tear down a connection whose env was elicited this session", async () => {
    // connection.config is the config the child was LAUNCHED from, which is
    // the entry merged with any session-elicited credentials. Comparing a
    // freshly-parsed entry against it directly reads every elicited server as
    // "launch config changed" and reaps it on the next unrelated edit.
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    priv.elicitedEnv.set("gh", { GITHUB_TOKEN: "elicited-value" });
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(priv.connections.get("gh").config.env.GITHUB_TOKEN).toBe("elicited-value");

    // An edit to a DIFFERENT server. "gh" itself is untouched on disk.
    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear", { args: ["linear", "--x"] })]);
    await priv.handleToolCall("mcp_connect_health", {});

    expect(priv.connections.has("gh")).toBe(true);
  });
});

describe("ConnectServer -- the discover memo vs. a config that broke under it", () => {
  // buildDiscoverOutput memoizes its body for 3 seconds, keyed on
  // configVersion + the focus/warm/filter signature. configWarnings is in
  // NEITHER: the degraded-load path swaps new warnings in without moving
  // configVersion, so for the whole TTL discover replays the pre-break body --
  // telling the model everything is fine while bundles.json on disk is broken.
  // The warnings are precisely the thing that must not be memoized away.

  it("renders a warning raised since the memoized body was built", async () => {
    writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    // Fills the memo. Nothing is wrong yet, so the body carries no warning.
    const before = await priv.handleToolCall("mcp_connect_discover", {});
    expect(before.content[0].text).not.toContain("invalid JSON");

    breakBundles(synthHome);
    const after = await priv.handleToolCall("mcp_connect_discover", {});

    // The running config is deliberately KEPT (a half-saved edit must not
    // blank the session), so the server list staying put is correct. What is
    // not correct is saying nothing about the file on disk.
    expect(priv.configWarnings.join(" ")).toContain("invalid JSON");
    expect(after.content[0].text).toContain("invalid JSON");
  });

  it("drops the warning again once the file is fixed", async () => {
    // The other direction: a stale WARNING outliving the break would be the
    // same lie pointed the other way.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;

    breakBundles(synthHome);
    expect((await priv.handleToolCall("mcp_connect_discover", {})).content[0].text).toContain("invalid JSON");

    const fixed = writeBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    const ahead = new Date(Date.now() + 20_000);
    utimesSync(fixed, ahead, ahead);
    expect((await priv.handleToolCall("mcp_connect_discover", {})).content[0].text).not.toContain("invalid JSON");
  });

  it("still memoizes a repeated discover when nothing moved", async () => {
    // The fix must key the memo on the warnings, not defeat the memo. Two
    // back-to-back discovers inside the TTL are the pattern it exists for.
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    const build = vi.spyOn(priv, "buildDiscoverOutputImpl");

    await priv.handleToolCall("mcp_connect_discover", {});
    await priv.handleToolCall("mcp_connect_discover", {});

    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectServer -- recovery from a bad entry needs no restart", () => {
  // The behavioural half of the string audit. Every activation and connect
  // failure carries "Fix in ~/.yaw-mcp/bundles.json under <ns>, then restart
  // this MCP client" (upstream.ts, withConfigPointer) into the text the LLM
  // reads and relays to the user. This is the test that says the second half
  // of that sentence is false: fix the entry on disk, send activate again,
  // and it loads.

  it("loads a server after its bundles.json entry is fixed, without a restart", async () => {
    writeBundles(synthHome, [serverEntry("brokensrv", { command: "definitely-not-a-binary" })]);
    vi.mocked(connectToUpstream).mockImplementation((async (config: UpstreamServerConfig) => {
      if (config.command === "definitely-not-a-binary") throw new Error("spawn definitely-not-a-binary ENOENT");
      return fakeConnection(config, [`${config.namespace}_live`]);
    }) as unknown as typeof connectToUpstream);

    const { priv, prewarmed } = await startServer();
    await prewarmed;
    // The one fixed step before runActivateOne's single retry, zeroed so the
    // failing activation below does not burn a real second.
    priv.activationRetryDelayMs = 0;

    const failed = await priv.handleToolCall("mcp_connect_activate", { server: "brokensrv" });
    expect(failed.isError).toBe(true);
    expect(priv.connections.has("brokensrv")).toBe(false);

    // Exactly what the pointer tells the user to do, minus the restart.
    rewriteBundles(synthHome, [serverEntry("brokensrv", { command: "echo" })]);
    await priv.handleToolCall("mcp_connect_activate", { server: "brokensrv" });

    expect(priv.connections.has("brokensrv")).toBe(true);
  });
});

describe("ConnectServer -- the reload gate's documented blind spot", () => {
  // bundlesSignature is mtime+size, so a rewrite that keeps the byte length
  // and lands on the same filesystem tick reads as "nothing moved". The part
  // worth pinning is not that the write is missed -- that is the documented
  // heuristic -- but WHEN it stops being missed: the recorded pair never moves
  // on its own, so no later boundary recovers it. Only another write does.

  it("misses a same-size same-tick rewrite at every later boundary, not just the first", async () => {
    const path = writeBundles(synthHome, [serverEntry("gh")]);
    // Pin the mtime BEFORE the load so the recorded fingerprint is a value the
    // test can reproduce exactly, rather than a stat it has to race.
    const pinned = new Date(1_700_000_000_000);
    utimesSync(path, pinned, pinned);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    expect(namespacesOf(priv)).toEqual(["gh"]);

    // Same byte length, different content, restored to the same tick.
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("gh", "hg"));
    utimesSync(path, pinned, pinned);

    // Three boundaries, not one: the miss is PERMANENT, not deferred. A gate
    // that merely postponed the read would recover here.
    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_discover", {});
    await priv.handleToolCall("mcp_connect_health", {});
    expect(namespacesOf(priv)).toEqual(["gh"]);

    // And the escape is a WRITE, not a check -- the next one that moves the
    // pair loads the file as it now stands, missed edit included.
    rewriteBundles(synthHome, [serverEntry("hg"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});
    expect(namespacesOf(priv).sort()).toEqual(["hg", "linear"]);
  });
});

describe("ConnectServer -- what an explicit trust revoke does to a live session", () => {
  // The two revocations are not the same event, and the comment on
  // maybeReloadBundles used to claim they were.
  //
  //   IMPLICIT: edit an approved project bundles.json. The edit moves the
  //   fingerprint AND breaks the content pin, so the reload drops the file --
  //   live, at the next boundary. (Pinned by "drops an APPROVED project file
  //   once its bytes change" above.)
  //
  //   EXPLICIT: `yaw-mcp trust --revoke`. It writes trusted.json, which is NOT
  //   a consulted path, so nothing moves and the session keeps serving the
  //   project file's servers until bundles.json is next written or the client
  //   restarts -- which is exactly what the CLI tells the user to do.
  //
  // Pinned rather than left to the comment, because the comment being wrong
  // about it is the whole finding.

  it("keeps serving a revoked project config until the file itself moves", async () => {
    const projectPath = writeBundles(synthCwd, [serverEntry("proj")]);
    await grantTrust(projectPath, readFileSync(projectPath), { home: synthHome });
    writeBundles(synthHome, [serverEntry("gh")]);
    const { priv, prewarmed } = await startServer();
    await prewarmed;
    expect(namespacesOf(priv)).toEqual(["proj"]);

    const revoked = await revokeTrust(projectPath, { home: synthHome });
    expect(revoked.removed).toBe(true);

    // No boundary picks it up: the trust store is not part of the watch set,
    // so from the reload gate's point of view nothing happened.
    await priv.handleToolCall("mcp_connect_health", {});
    await priv.handleToolCall("mcp_connect_discover", {});
    expect(namespacesOf(priv)).toEqual(["proj"]);

    // A write to a CONSULTED path is what re-runs the consent gate, and the
    // now-unapproved project file loses to user-global there.
    rewriteBundles(synthHome, [serverEntry("gh"), serverEntry("linear")]);
    await priv.handleToolCall("mcp_connect_health", {});
    expect(namespacesOf(priv).sort()).toEqual(["gh", "linear"]);
  });

  it("says so in the comment that used to claim revocation was live", async () => {
    // A behaviour this surprising is only safe while the paragraph next to it
    // is honest; "revocation does not [wait]" was true of the implicit form and
    // false of the explicit one, which is the half a reader acts on.
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const start = src.indexOf("   *  TRUST: the re-read goes through loadLocalBundles");
    const end = src.indexOf("   *  FAILURE: a re-read that fails NEVER blanks");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paragraph = src.slice(start, end);

    expect(paragraph).not.toContain("revocation does not");
    expect(paragraph).toContain("--revoke");
  });
});
