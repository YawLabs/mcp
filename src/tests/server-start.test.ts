// Coverage for ConnectServer.start() — the ONLY startup path since the
// localMode branch was deleted. Everything here runs against a synthetic
// $HOME + cwd on the REAL filesystem (mkdtemp), so the trust gate, the
// grade cache, the state file and the bundles loader all exercise their
// production I/O. Only two things are stubbed, both process boundaries:
// the stdio transport (it would seize the test runner's stdin) and
// connectToUpstream/disconnectFromUpstream (they would spawn children).
//
// $HOME is redirected by setting HOME + USERPROFILE rather than by mocking
// node:os — os.homedir() reads USERPROFILE on win32 and HOME on POSIX, so
// setting both moves EVERY homedir() default in the tree (persistence,
// grades-cache, local-bundles, trust, config-loader) in one move, with no
// module mock to drift out of sync.
//
// Path keys are built with join(), never POSIX literals: the SUT routes
// through path.join, which yields backslashes on the Windows runner.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import { CONFIG_FILENAME } from "../config-loader.js";
import { gradesCachePath } from "../grades-cache.js";
import { localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME } from "../persistence.js";
import { buildToolList } from "../proxy.js";
import { ConnectServer } from "../server.js";
import { grantTrust } from "../trust.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream } from "../upstream.js";
import { ensureUv } from "../uv-bootstrap.js";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "YAW_MCP_MIN_COMPLIANCE",
  "YAW_MCP_DISABLE_PERSISTENCE",
  "YAW_MCP_AUTO_LOAD",
  "YAW_MCP_SERVER_CAP",
  "YAW_MCP_TRUST_PROJECT",
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

/** Construct + start a ConnectServer, capturing the pre-warm promise.
 *  The capture wraps the private method on the INSTANCE (production code
 *  is untouched) so the fire-and-forget call becomes awaitable. By
 *  default the downstream initialize handshake is driven too;
 *  `handshake: false` leaves the client un-initialized so the gating
 *  itself can be observed. */
async function startServer(opts: { handshake?: boolean } = {}): Promise<Started> {
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

  await server.start();
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
    transport,
  };
}

function namespacesOf(priv: any): string[] {
  return (priv.config?.servers ?? []).map((s: UpstreamServerConfig) => s.namespace);
}

/** Namespaces connectToUpstream was actually asked to spawn, sorted. */
function spawnedNamespaces(): string[] {
  return vi
    .mocked(connectToUpstream)
    .mock.calls.map((c) => (c[0] as UpstreamServerConfig).namespace)
    .sort();
}

/** Tool names a client would see in tools/list, minus the meta-tools. */
function listedUpstreamTools(priv: any): string[] {
  return buildToolList(priv.connections, priv.getDeferredServers(), priv.toolFilters)
    .map((t) => t.name)
    .filter((n) => !n.startsWith("mcp_connect_"));
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
    expect(listedUpstreamTools(priv)).toEqual(["gh_gh_live"]);
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
    // And the cached tools are visible to the client without a spawn.
    expect(listedUpstreamTools(priv).sort()).toEqual(["fresh_fresh_live", "known_cached_tool"]);
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
    expect(listedUpstreamTools(priv)).toEqual(["allowed_allowed_live"]);
  });
});
