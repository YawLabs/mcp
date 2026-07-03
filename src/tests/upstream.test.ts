import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivationError,
  connectToUpstream,
  fetchPromptsFromUpstream,
  fetchResourcesFromUpstream,
  fetchToolsFromUpstream,
  MAX_PROMPTS_PER_SERVER,
  MAX_RESOURCES_PER_SERVER,
  MAX_TOOLS_PER_SERVER,
  resetOamDowngrades,
} from "../upstream.js";

// ---------------------------------------------------------------------------
// Module-level mocks -- hoisted before imports by vitest
// ---------------------------------------------------------------------------

// Mock secrets-vault so resolveServerEnv tests never touch the filesystem.
vi.mock("../secrets-vault.js", () => ({
  hasSecretRefs: vi.fn(),
  loadVault: vi.fn(),
  resolveSecretRefs: vi.fn(),
  unlock: vi.fn(),
  vaultPath: vi.fn().mockReturnValue("/tmp/fake-vault.json"),
}));

// Stub logger to silence output in tests that don't test logging,
// but still write warn-level entries to stderr so the existing
// truncation tests (which capture process.stderr.write) keep working.
vi.mock("../logger.js", () => ({
  log: vi.fn((level: string, msg: string, data?: unknown) => {
    if (level === "warn") {
      process.stderr.write(`${JSON.stringify({ level, msg, ...(data ?? {}) })}\n`);
    }
  }),
}));

// Stub uv-bootstrap -- we never want real UV resolution in unit tests.
vi.mock("../uv-bootstrap.js", () => ({
  resolveUvSpawn: vi.fn().mockImplementation((cmd: string, args: string[]) => Promise.resolve({ command: cmd, args })),
}));

// ---------------------------------------------------------------------------
// MCP SDK mocks
// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the file by vitest, which means
// they run BEFORE module-level variable initialisers. To work around this,
// we use an indirection object whose properties are mutated by test code
// after the module loads. The factory closes over the object reference, which
// is stable across the hoist boundary.

const _sdkBehavior = {
  clientConnect: (): Promise<void> => Promise.reject(new Error("connect not configured")),
  clientClose: (): Promise<void> => Promise.resolve(),
  stderrEmitter: null as EventEmitter | null,
  // The {command,args,env} the stdio transport was last constructed with --
  // lets a test assert what actually gets spawned (e.g. the oam-rewritten cmd).
  lastStdioArgs: null as { command: string; args: string[]; env?: Record<string, string> } | null,
  // EVERY stdio construction, in order -- the boot-probe fallback respawns,
  // so a single "last" slot can't show the oam -> node downgrade sequence.
  stdioConstructions: [] as Array<{ command: string; args: string[]; env?: Record<string, string> }>,
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  function MockClient() {
    return {
      connect: () => _sdkBehavior.clientConnect(),
      close: () => _sdkBehavior.clientClose(),
      // listTools succeeds with an empty set so tests can drive the connect
      // flow to a SUCCESSFUL completion (the boot-probe fallback tests need
      // the second attempt to come up healthy).
      listTools: () => Promise.resolve({ tools: [] }),
      listResources: () => Promise.resolve({ resources: [] }),
      listPrompts: () => Promise.resolve({ prompts: [] }),
      onclose: undefined as (() => void) | undefined,
      setNotificationHandler: () => {},
    };
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  function MockStdioClientTransport(opts: { command: string; args: string[]; env?: Record<string, string> }) {
    _sdkBehavior.lastStdioArgs = opts;
    _sdkBehavior.stdioConstructions.push(opts);
    const emitter = new EventEmitter();
    _sdkBehavior.stderrEmitter = emitter;
    return { stderr: emitter };
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

// resolveOamSpawn is the spawn-rewrite chokepoint (upstream.ts gates it on
// the effective runtime being "oam"). Mock it so the WIRING -- "does the
// runtime gate actually reach + apply the rewrite?" -- is tested
// independently of an installed oam. probeOam feeds the oamVersion field of
// the connect/downgrade log lines; a fixed probe keeps that deterministic.
vi.mock("../oam-spawn.js", () => ({
  resolveOamSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
  probeOam: vi.fn(() => ({ bin: "/usr/bin/oam", version: "0.6.0", belowMin: false })),
}));

// Config-level default runtime (feature knob) -- mocked so connectToUpstream
// never reads the developer machine's real ~/.yaw-mcp/bundles.json, and so
// tests can flip the default per-case.
vi.mock("../default-runtime.js", () => ({
  defaultRuntime: vi.fn().mockResolvedValue(null),
}));

// Remote transports -- not needed for env/redact tests but must not throw.
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: function MockSSE() {
    return {};
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockHTTP() {
    return {};
  },
}));

// Import the mocked modules so the wiring tests can configure/assert them.
import { defaultRuntime } from "../default-runtime.js";
import { resolveOamSpawn } from "../oam-spawn.js";
// Import the mocked secrets-vault module so individual tests can configure it.
import { hasSecretRefs, loadVault, resolveSecretRefs, unlock } from "../secrets-vault.js";

// Minimal stand-in for the MCP SDK Client — only the listTools/listResources/
// listPrompts methods we call. `as any` covers the type shape mismatch.
function makeClient(overrides: Record<string, any>): any {
  return overrides;
}

// Capture stderr so we can assert the warn log fires on truncation.
function captureStderr(): { restore: () => void; writes: string[] } {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return {
    writes,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("fetchToolsFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("returns all tools when under the cap", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: "object" },
    }));
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(5);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(false);
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const tools = Array.from({ length: MAX_TOOLS_PER_SERVER + 25 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: "object" },
    }));
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_TOOLS_PER_SERVER);
    // First tool preserved, last one is index MAX-1 (the tail is dropped).
    expect(out[0].name).toBe("t0");
    expect(out[MAX_TOOLS_PER_SERVER - 1].name).toBe(`t${MAX_TOOLS_PER_SERVER - 1}`);
    expect(stderr.writes.some((w) => w.includes("truncating") && w.includes('"reported":1025'))).toBe(true);
  });
});

describe("fetchResourcesFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const resources = Array.from({ length: MAX_RESOURCES_PER_SERVER + 10 }, (_, i) => ({
      uri: `file:///r${i}`,
      name: `r${i}`,
    }));
    const client = makeClient({ listResources: vi.fn().mockResolvedValue({ resources }) });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_RESOURCES_PER_SERVER);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(true);
  });

  it("swallows listResources errors (server may not support them)", async () => {
    const client = makeClient({ listResources: vi.fn().mockRejectedValue(new Error("not supported")) });
    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toEqual([]);
  });
});

describe("fetchPromptsFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const prompts = Array.from({ length: MAX_PROMPTS_PER_SERVER + 7 }, (_, i) => ({
      name: `p${i}`,
    }));
    const client = makeClient({ listPrompts: vi.fn().mockResolvedValue({ prompts }) });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_PROMPTS_PER_SERVER);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(true);
  });

  it("swallows listPrompts errors (server may not support them)", async () => {
    const client = makeClient({ listPrompts: vi.fn().mockRejectedValue(new Error("not supported")) });
    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers for connectToUpstream-based tests
// ---------------------------------------------------------------------------

/** Minimal local server config that does NOT require a vault. */
function makeLocalConfig(overrides: Record<string, unknown> = {}): any {
  return {
    id: "test-srv",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "node",
    args: [],
    env: {},
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// redactSecretsInOutput -- tested via connectToUpstream ActivationError tail
// ---------------------------------------------------------------------------

describe("redactSecretsInOutput", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("handshake failed"));
    _sdkBehavior.clientClose = () => Promise.resolve();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("replaces secret values found in resolved env with ***KEY*** in ActivationError tail", async () => {
    // Simulate a resolved env where MY_TOKEN has a high-entropy value.
    const secretValue = "ghp_AbCdEfGhIjKlMnOpQrStUvWx12345678";
    // hasSecretRefs returns false so resolveServerEnv passes through immediately,
    // returning the env unchanged. resolvedServerEnv is populated with MY_TOKEN.
    // We then fail the connect so the error handler runs and calls redactSecretsInOutput.
    //
    // Stderr is emitted synchronously inside the connect call, BEFORE the rejection
    // promise resolves, so the stderrRing is populated when the catch block runs.
    const config = makeLocalConfig({ env: { MY_TOKEN: secretValue } });

    _sdkBehavior.clientConnect = () => {
      // Emit synchronously so the data listener (attached before connect is called)
      // populates the ring before the rejection is caught.
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`authentication failed: ${secretValue}`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // The raw secret value must NOT appear in the error message or stderrTail.
    expect(err!.message).not.toContain(secretValue);
    expect(err!.stderrTail).not.toContain(secretValue);
    // It should be replaced with the ***KEY*** pattern.
    expect(err!.stderrTail).toContain("***MY_TOKEN***");
  });

  it("is a no-op when env is empty -- output passes through unchanged", async () => {
    const config = makeLocalConfig({ env: {} });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("some plain error output"));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.stderrTail).toContain("some plain error output");
  });

  it("does not redact short env values (< 8 chars) -- boundary guard", async () => {
    // The redactor skips values shorter than 8 characters to avoid mangling
    // common substrings. Verify a 7-char value is left in place.
    const shortVal = "abc1234"; // 7 chars
    const config = makeLocalConfig({ env: { SHORT: shortVal } });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`error: ${shortVal} is invalid`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // Short value should NOT have been redacted.
    expect(err!.stderrTail).toContain(shortVal);
    expect(err!.stderrTail).not.toContain("***SHORT***");
  });
});

// ---------------------------------------------------------------------------
// resolveServerEnv -- tested via connectToUpstream error path
// ---------------------------------------------------------------------------

describe("resolveServerEnv", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
  });

  it("returns env unchanged when it contains no ${secret:} refs", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // connect will fail immediately -- we only care that no vault call was made
    // and that the error is NOT a vault-related throw.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { PLAIN: "hello" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    // loadVault must not have been called because there were no secret refs.
    expect(vi.mocked(loadVault)).not.toHaveBeenCalled();
    // The error should be an ActivationError (transport/connect failure), not
    // a vault error, confirming resolveServerEnv returned early.
    expect(err).toBeInstanceOf(ActivationError);
  });

  it("substitutes ${secret:NAME} with vault value when vault is loaded", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";

    const fakeVault = { version: 1, salt: "abc", entries: { MY_SECRET: {} } } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);

    const fakeKey = Buffer.from("fakekey");
    vi.mocked(unlock).mockResolvedValue(fakeKey);

    const resolvedValue = "resolved-cleartext-value";
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: resolvedValue },
      missing: [],
    });

    // Connect will fail -- we only need resolveServerEnv to complete without throwing.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MY_SECRET}" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    // resolveSecretRefs was called (vault path exercised).
    expect(vi.mocked(resolveSecretRefs)).toHaveBeenCalledWith({ API_KEY: "${secret:MY_SECRET}" }, fakeVault, fakeKey);
    // The failure is a transport ActivationError, not a vault error --
    // confirming resolveServerEnv succeeded and did not throw.
    expect(err).toBeInstanceOf(ActivationError);
    const ae = err as ActivationError;
    // The error must NOT be a vault error -- it is a transport-level failure.
    expect(ae.message).not.toMatch(/vault/i);
  });

  it("throws when secret NAME is missing from vault", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";

    const fakeVault = { version: 1, salt: "abc", entries: {} } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);

    const fakeKey = Buffer.from("fakekey");
    vi.mocked(unlock).mockResolvedValue(fakeKey);

    // resolveSecretRefs reports the name as missing.
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: "${secret:MISSING_NAME}" },
      missing: ["MISSING_NAME"],
    });

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MISSING_NAME}" } });

    await expect(connectToUpstream(config)).rejects.toThrow(
      /vault: missing or undecryptable secret refs: MISSING_NAME/,
    );
  });

  it("throws when YAW_MCP_VAULT_PASSPHRASE is not set and secret refs are present", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    await expect(connectToUpstream(config)).rejects.toThrow(/vault locked.*YAW_MCP_VAULT_PASSPHRASE/);
  });
});

// ---------------------------------------------------------------------------
// oam runtime wiring -- connectToUpstream must apply resolveOamSpawn to the
// launch command iff config.runtime === "oam". This is the integration link
// between local-bundles (which propagates `runtime`) and oam-spawn (which does
// the rewrite); a regression here (e.g. the 0.66.2 bug where `runtime` was
// dropped before reaching this gate) would silently host opted-in servers on
// node instead of oam.
// ---------------------------------------------------------------------------

describe("connectToUpstream oam runtime wiring", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // The transport is constructed before the client connects; reject connect so
    // the call returns fast -- lastStdioArgs is already captured by then.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("stop after spawn"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies resolveOamSpawn to the spawn command when runtime is 'oam'", async () => {
    vi.mocked(resolveOamSpawn).mockReturnValue({
      command: "/usr/bin/oam",
      args: ["run", "/cache/fetch/dist/index.js"],
    });
    const config = makeLocalConfig({
      runtime: "oam",
      command: "npx",
      args: ["-y", "@yawlabs/fetch-mcp@latest"],
    });
    try {
      await connectToUpstream(config);
    } catch {
      // connect rejects in the mock; we only assert the spawn was rewritten.
    }
    // The gate fired with the (uv-resolved) command/args, exactly once -- the
    // boot-probe downgrade retry deliberately skips the rewrite ...
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledOnce();
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledWith("npx", ["-y", "@yawlabs/fetch-mcp@latest"]);
    // ... and the REWRITTEN command/args are what actually get spawned first.
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("/usr/bin/oam");
    expect(_sdkBehavior.stdioConstructions[0]?.args).toEqual(["run", "/cache/fetch/dist/index.js"]);
  });

  it("does NOT touch the spawn command when runtime is unset", async () => {
    const config = makeLocalConfig({ command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* connect rejects; assert the original command was spawned */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.lastStdioArgs?.command).toBe("npx");
    expect(_sdkBehavior.lastStdioArgs?.args).toEqual(["-y", "@yawlabs/fetch-mcp@latest"]);
  });

  it("does NOT touch the spawn command when runtime is 'node'", async () => {
    const config = makeLocalConfig({ runtime: "node", command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.lastStdioArgs?.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Config-level default runtime -- connectToUpstream must apply the oam rewrite
// when defaultRuntime() says "oam" and the server carries no per-server
// runtime; per-server "node" stays an escape hatch. Backend server defs never
// carry `runtime`, so this gate is what makes the knob work in account mode.
// ---------------------------------------------------------------------------

describe("connectToUpstream config-level default runtime", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("stop after spawn"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies the oam rewrite when the default is 'oam' and runtime is unset", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("oam");
    vi.mocked(resolveOamSpawn).mockReturnValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* connect rejects; assertions below */
    }
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledWith("npx", ["-y", "@yawlabs/fetch-mcp@latest"]);
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("/usr/bin/oam");
  });

  it("per-server runtime:'node' opts out of a default of 'oam'", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("oam");
    const config = makeLocalConfig({ runtime: "node", command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["npx"]);
  });

  it("stays on node when the default is 'node'", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("node");
    const config = makeLocalConfig({ command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.lastStdioArgs?.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Boot-probe fallback -- when the spawn was ACTUALLY oam-rewritten and the
// boot fails (handshake failure / early child exit, both surfacing as an
// ActivationError), connectToUpstream respawns ONCE with the original
// pre-rewrite command. No retry ladder beyond that single downgrade, and
// non-oam spawns keep the existing single-attempt behavior.
// ---------------------------------------------------------------------------

describe("connectToUpstream oam boot-probe fallback", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("boot failed"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("respawns once on the ORIGINAL command and succeeds when node boots", async () => {
    vi.mocked(resolveOamSpawn).mockReturnValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      return connects === 1 ? Promise.reject(new Error("oam crashed on boot")) : Promise.resolve();
    };
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });

    const connection = await connectToUpstream(config);

    expect(connection.status).toBe("connected");
    // First spawn = oam-rewritten, second = the original pre-rewrite command.
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);
    expect(_sdkBehavior.stdioConstructions[1]?.args).toEqual(["-y", "@yawlabs/fetch-mcp@latest"]);
    // The downgrade attempt skips the rewrite entirely.
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledOnce();
  });

  it("downgrades exactly once: a second failure propagates (no retry ladder)", async () => {
    vi.mocked(resolveOamSpawn).mockReturnValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);
  });

  it("does NOT respawn when the spawn was never oam-rewritten", async () => {
    const config = makeLocalConfig({ command: "npx", args: ["-y", "x"] });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions).toHaveLength(1);
  });

  it("does NOT respawn when resolveOamSpawn already fell back internally (command unchanged)", async () => {
    // oam absent / package unresolvable: resolveOamSpawn returns the command
    // untouched, so a boot failure is a NODE failure -- no downgrade retry.
    vi.mocked(resolveOamSpawn).mockImplementation((command: string, args: string[]) => ({ command, args }));
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions).toHaveLength(1);
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("npx");
  });

  it("does NOT downgrade on non-activation failures (vault refusals rethrow untouched)", async () => {
    // Secret refs present but no passphrase -> resolveServerEnv throws a
    // plain Error AFTER the rewrite gate. Downgrading would just fail
    // identically on node, so the wrapper must rethrow without a respawn.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    vi.mocked(resolveOamSpawn).mockReturnValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({
      runtime: "oam",
      command: "npx",
      args: ["-y", "x"],
      env: { TOKEN: "${secret:MY_TOKEN}" },
    });
    await expect(connectToUpstream(config)).rejects.toThrow(/vault locked/);
    // The env is resolved before the transport is built -> no spawn at all.
    expect(_sdkBehavior.stdioConstructions).toHaveLength(0);
  });

  it("the downgrade STICKS for the session: later connects skip the oam rewrite", async () => {
    // Callers (activation retry, auto-reconnect) call connectToUpstream
    // repeatedly; without the namespace memo they'd re-pay the oam boot
    // failure on every outer attempt.
    vi.mocked(resolveOamSpawn).mockReturnValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    // First call: oam attempt fails, downgrade attempt fails too.
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);

    // Second call for the same namespace: straight to node, single spawn,
    // rewrite never consulted again.
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockClear();
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["npx"]);
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
  });
});
