import { EventEmitter } from "node:events";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivationError,
  connectToUpstream,
  disconnectFromUpstream,
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
  // Real value, not a stub: upstream's collectSecretNames builds its scan
  // regex from this (single source of truth for the `${secret:NAME}` shape),
  // so a mocked-away export would break audit-name collection.
  SECRET_REF_RE: /\$\{secret:([a-zA-Z0-9_.-]+)\}/g,
}));

// Mock the audit appender: the real one writes to ~/.yaw-mcp/secrets-audit.log,
// and resolveServerEnv records events on BOTH the success and the missing-refs
// path -- unit tests must not touch the developer's (or CI's) home dir.
vi.mock("../secrets-audit.js", () => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
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
  // listResources/listPrompts route through these hooks so a test can override
  // one to fire client.onclose mid-fetch (the closedBeforeReady path). Both
  // default to the empty-inventory shape the connect-flow tests rely on; the
  // MockClient instance is passed so an override can reach its onclose handler.
  clientListResources: (_client: any): Promise<any> => Promise.resolve({ resources: [] }),
  clientListPrompts: (_client: any): Promise<any> => Promise.resolve({ prompts: [] }),
  // listTools routes through the same indirection so the list-changed chain
  // tests can hand out deferred promises per call and control resolution
  // order. Default is the empty-inventory shape every other suite relies on.
  clientListTools: (_client: any): Promise<any> => Promise.resolve({ tools: [] }),
  // Every (schema, handler) pair passed to client.setNotificationHandler, in
  // registration order -- the list-changed chain tests invoke the captured
  // handler directly rather than driving a real transport.
  notificationHandlers: [] as Array<{ schema: unknown; handler: (notification: any) => unknown }>,
  // Remote transport constructions (SSE vs streamable HTTP), in order.
  remoteConstructions: [] as Array<{ kind: "sse" | "http"; url: string }>,
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
    const client: any = {
      connect: () => _sdkBehavior.clientConnect(),
      close: () => _sdkBehavior.clientClose(),
      // listTools succeeds with an empty set so tests can drive the connect
      // flow to a SUCCESSFUL completion (the boot-probe fallback tests need
      // the second attempt to come up healthy).
      listTools: () => _sdkBehavior.clientListTools(client),
      // listResources/listPrompts go through _sdkBehavior so a test can make
      // one fire client.onclose before resolving (closedBeforeReady path).
      // The captured `client` is the same object connectToUpstream assigns
      // onclose to, so the override can reach the live handler.
      listResources: () => _sdkBehavior.clientListResources(client),
      listPrompts: () => _sdkBehavior.clientListPrompts(client),
      onclose: undefined as (() => void) | undefined,
      setNotificationHandler: (schema: unknown, handler: (notification: any) => unknown) => {
        _sdkBehavior.notificationHandlers.push({ schema, handler });
      },
    };
    return client;
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
// Each construction is recorded so the remote-config tests can assert WHICH
// transport the `transport: "sse"` switch selected.
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: function MockSSE(url: URL) {
    _sdkBehavior.remoteConstructions.push({ kind: "sse", url: String(url) });
    return {};
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockHTTP(url: URL) {
    _sdkBehavior.remoteConstructions.push({ kind: "http", url: String(url) });
    return {};
  },
}));

// Import the mocked modules so the wiring tests can configure/assert them.
import { defaultRuntime } from "../default-runtime.js";
import { log } from "../logger.js";
import { resolveOamSpawn } from "../oam-spawn.js";
import { appendAuditEvent } from "../secrets-audit.js";
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

  it("redacts the longest secret whole when one value is a substring of another", async () => {
    // INNER is a prefix of OUTER. If the redactor replaced values in
    // insertion order (short-first), INNER would be redacted inside OUTER
    // first, leaving OUTER's real "_SUFFIX_9999" tail exposed. Longest-first
    // ordering must redact OUTER whole instead.
    const innerValue = "ghp_AbCdEfGh12345678";
    const outerValue = `${innerValue}_SUFFIX_9999`;
    const config = makeLocalConfig({ env: { INNER_TOKEN: innerValue, OUTER_TOKEN: outerValue } });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`authentication failed: ${outerValue}`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // Neither raw value, nor OUTER's tail, may survive.
    expect(err!.stderrTail).not.toContain(outerValue);
    expect(err!.stderrTail).not.toContain("_SUFFIX_9999");
    expect(err!.stderrTail).toContain("***OUTER_TOKEN***");
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

  it("records 'missing' but NOT 'injected' when a refused spawn had one resolvable ref", async () => {
    // The refusal is the case an operator goes looking for in
    // `yaw-mcp secrets audit`; recording only on the success path left the
    // "missing" event kind dead even though the CLI renders it.
    //
    // Two refs -- one resolvable (OK_NAME), one missing -- because
    // resolution is all-or-nothing: the missing ref refuses the spawn, so
    // the resolvable one never reaches a child env either. Recording it as
    // "injected" answered "did this server ever receive OK_NAME?" with a
    // false yes. "injected" must keep meaning "went into a spawn env".
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { OK_NAME: {} } } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: "${secret:MISSING_NAME}", OTHER: "resolved-cleartext" },
      missing: ["MISSING_NAME"],
    });

    const config = makeLocalConfig({
      env: { API_KEY: "${secret:MISSING_NAME}", OTHER: "${secret:OK_NAME}" },
    });
    await expect(connectToUpstream(config)).rejects.toThrow(/missing or undecryptable/);

    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "MISSING_NAME",
      event: "missing",
    });
    // The ref that DID resolve must not be logged as injected -- the spawn
    // was refused, so nothing was injected at all.
    expect(vi.mocked(appendAuditEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ event: "injected" }));
    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledTimes(1);
  });

  it("records an 'injected' audit event per resolved secret NAME (never a value)", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { MY_SECRET: {} } } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({ resolved: { API_KEY: "cleartext" }, missing: [] });
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MY_SECRET}" } });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);

    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "MY_SECRET",
      event: "injected",
    });
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

// ---------------------------------------------------------------------------
// closedBeforeReady -- the child dies mid-init. initialize + tools/list
// succeed, then client.onclose fires DURING the resources/prompts fetch
// window while connection.status is still "disconnected". The post-fetch
// guard must reject with an ActivationError ("disconnected during
// initialization", protocol_error) rather than return a dead "connected"
// connection over an already-closed client (fetchResources/Prompts swallow
// errors, so without the closedBeforeReady flag the dead child would slip
// through). See upstream.ts:517-537.
// ---------------------------------------------------------------------------

describe("connectToUpstream closedBeforeReady", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // Handshake succeeds so the flow reaches the capability-fetch window.
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.stdioConstructions = [];
    _sdkBehavior.lastStdioArgs = null;
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
    // Restore the default empty-inventory resolvers so a mid-fetch onclose
    // override can never leak into another suite.
    _sdkBehavior.clientListResources = (_client: any) => Promise.resolve({ resources: [] });
    _sdkBehavior.clientListPrompts = (_client: any) => Promise.resolve({ prompts: [] });
  });

  it("rejects with protocol_error when onclose fires during the resources fetch (status still 'disconnected')", async () => {
    // The child dies while listResources is in flight. onclose runs with
    // connection.status still "disconnected", so closedBeforeReady flips true
    // and the guard after the three fetches rejects.
    _sdkBehavior.clientListResources = (client: any) => {
      client.onclose?.();
      return Promise.resolve({ resources: [] });
    };

    const config = makeLocalConfig();

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.message).toContain("disconnected during initialization");
    expect(err!.message).toContain("test"); // namespaced in the message
    expect(err!.category).toBe("protocol_error");
  });

  it("rejects with protocol_error when onclose fires during the prompts fetch (last fetch in the window)", async () => {
    // Same failure mode, but the close lands on the final fetch of the
    // initialization window rather than the first.
    _sdkBehavior.clientListPrompts = (client: any) => {
      client.onclose?.();
      return Promise.resolve({ prompts: [] });
    };

    const config = makeLocalConfig();

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.message).toContain("disconnected during initialization");
    expect(err!.category).toBe("protocol_error");
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for the chain / disconnect / activation-error suites below.
// ---------------------------------------------------------------------------

/** Explicit deferred. The chain tests decide resolution ORDER themselves --
 *  never a setTimeout race, which would make the assertions timing-dependent. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drain the microtask queue (and anything it queues in turn). setImmediate
 *  fires in the check phase, which runs only after microtasks are exhausted --
 *  so "nothing further happened" after a flush() is a real assertion, not a
 *  bet on a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The handler connectToUpstream registered for a given notification schema
 *  (most recent registration wins -- a suite may connect more than once). */
function handlerFor(schema: unknown): (notification: unknown) => Promise<void> {
  const entry = [..._sdkBehavior.notificationHandlers].reverse().find((h) => h.schema === schema);
  if (!entry) throw new Error("no notification handler was registered for that schema");
  return entry.handler as (notification: unknown) => Promise<void>;
}

/** Restore the default empty-inventory list hooks so an override can never
 *  leak out of the suite that installed it. */
function resetListHooks(): void {
  _sdkBehavior.clientListTools = (_client: any) => Promise.resolve({ tools: [] });
  _sdkBehavior.clientListResources = (_client: any) => Promise.resolve({ resources: [] });
  _sdkBehavior.clientListPrompts = (_client: any) => Promise.resolve({ prompts: [] });
}

// ---------------------------------------------------------------------------
// list-changed notification chains (upstream.ts:560-604)
//
// Each category (tools/resources/prompts) serializes its refreshes onto its
// own promise chain. Two back-to-back notifications from one upstream must
// produce SEQUENTIAL fetches, not concurrent ones: with concurrency, whichever
// listX() happens to resolve last wins connection.<category>, so a slow fetch
// from an EARLIER notification silently clobbers the newer inventory, and
// onListChanged fires twice in the wrong order (each rebuilding routes).
// ---------------------------------------------------------------------------

interface ListChangedCategory {
  label: string;
  method: string;
  schema: unknown;
  /** Install a per-call fetch implementation for this category. */
  install: (impl: () => Promise<unknown>) => void;
  /** A listX() result carrying a single entry with the given name. */
  result: (name: string) => unknown;
  /** The names currently stored on the connection for this category. */
  read: (connection: any) => (string | undefined)[];
}

const LIST_CHANGED_CATEGORIES: ListChangedCategory[] = [
  {
    label: "tools",
    method: "notifications/tools/list_changed",
    schema: ToolListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListTools = impl;
    },
    result: (name) => ({ tools: [{ name, inputSchema: { type: "object" } }] }),
    read: (connection) => connection.tools.map((t: any) => t.name),
  },
  {
    label: "resources",
    method: "notifications/resources/list_changed",
    schema: ResourceListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListResources = impl;
    },
    result: (name) => ({ resources: [{ uri: `file:///${name}`, name }] }),
    read: (connection) => connection.resources.map((r: any) => r.name),
  },
  {
    label: "prompts",
    method: "notifications/prompts/list_changed",
    schema: PromptListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListPrompts = impl;
    },
    result: (name) => ({ prompts: [{ name }] }),
    read: (connection) => connection.prompts.map((p: any) => p.name),
  },
];

describe("connectToUpstream list-changed chains", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
    resetListHooks();
    _sdkBehavior.notificationHandlers = [];
  });

  it("registers one handler per category when onListChanged is provided", async () => {
    await connectToUpstream(makeLocalConfig(), undefined, vi.fn());
    expect(_sdkBehavior.notificationHandlers.map((h) => h.schema)).toEqual([
      ToolListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
      PromptListChangedNotificationSchema,
    ]);
  });

  it("registers no handlers at all when onListChanged is omitted", async () => {
    await connectToUpstream(makeLocalConfig());
    expect(_sdkBehavior.notificationHandlers).toEqual([]);
  });

  for (const category of LIST_CHANGED_CATEGORIES) {
    it(`serializes back-to-back ${category.label} notifications so the LAST one wins`, async () => {
      const onListChanged = vi.fn();
      const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);
      expect(category.read(connection)).toEqual([]);

      // Fetch #1 (notification #1) is deliberately the SLOW one -- it does not
      // settle until the test resolves `slowFirst`. Fetch #2 settles
      // immediately. Serialized, #2 runs last and its result is the final
      // state. Run concurrently, #1's late result would clobber #2's.
      const slowFirst = deferred();
      const started: number[] = [];
      let calls = 0;
      category.install(() => {
        calls += 1;
        const nth = calls;
        started.push(nth);
        return nth === 1
          ? slowFirst.promise.then(() => category.result("from-first-notification"))
          : Promise.resolve(category.result("from-second-notification"));
      });

      const handler = handlerFor(category.schema);
      const first = handler({ method: category.method });
      const second = handler({ method: category.method });

      // Both notifications have been delivered and every microtask has run,
      // yet only ONE fetch has been issued: the second is queued behind the
      // first rather than racing it. Nothing has been published downstream.
      await flush();
      expect(started).toEqual([1]);
      expect(onListChanged).not.toHaveBeenCalled();

      slowFirst.resolve();
      await Promise.all([first, second]);

      // The second fetch only STARTED once the first finished ...
      expect(started).toEqual([1, 2]);
      // ... and the newest notification's inventory is what stuck.
      expect(category.read(connection)).toEqual(["from-second-notification"]);
      // One route rebuild per notification, no double-fire on either.
      expect(onListChanged).toHaveBeenCalledTimes(2);
      expect(onListChanged).toHaveBeenNthCalledWith(1, "test");
      expect(onListChanged).toHaveBeenNthCalledWith(2, "test");
    });
  }

  it("keeps the three chains independent -- a wedged tools fetch does not block resources", async () => {
    const onListChanged = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

    const wedged = deferred();
    _sdkBehavior.clientListTools = () => wedged.promise.then(() => ({ tools: [] }));
    _sdkBehavior.clientListResources = () => Promise.resolve({ resources: [{ uri: "file:///r", name: "r" }] });

    const toolsPending = handlerFor(ToolListChangedNotificationSchema)({ method: "notifications/tools/list_changed" });
    await handlerFor(ResourceListChangedNotificationSchema)({ method: "notifications/resources/list_changed" });

    expect(connection.resources.map((r) => r.name)).toEqual(["r"]);
    expect(onListChanged).toHaveBeenCalledTimes(1);

    // Unwedge so the pending tools chain settles before the test ends.
    wedged.resolve();
    await toolsPending;
    expect(onListChanged).toHaveBeenCalledTimes(2);
  });

  it("catches a throwing tools refresh, logs it, and leaves the chain usable", async () => {
    const onListChanged = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

    let calls = 0;
    _sdkBehavior.clientListTools = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("tools/list exploded"))
        : Promise.resolve({ tools: [{ name: "recovered", inputSchema: { type: "object" } }] });
    };

    const handler = handlerFor(ToolListChangedNotificationSchema);

    // fetchToolsFromUpstream RETHROWS as an ActivationError (unlike the
    // resources/prompts fetchers, which swallow). The chain link must still
    // RESOLVE -- a rejected link would poison every later notification.
    await expect(handler({ method: "notifications/tools/list_changed" })).resolves.toBeUndefined();
    // Nothing was published: the previous inventory stands and no route
    // rebuild was triggered off a failed fetch.
    expect(connection.tools).toEqual([]);
    expect(onListChanged).not.toHaveBeenCalled();
    expect(
      stderr.writes.some(
        (w) => w.includes("Failed to refresh tools from upstream") && w.includes("tools/list exploded"),
      ),
    ).toBe(true);

    // The next notification on the SAME chain still runs.
    await handler({ method: "notifications/tools/list_changed" });
    expect(connection.tools.map((t) => t.name)).toEqual(["recovered"]);
    expect(onListChanged).toHaveBeenCalledTimes(1);
  });

  // fetchResourcesFromUpstream / fetchPromptsFromUpstream SWALLOW their errors
  // and return [], so a throwing onListChanged is the only thing that can reach
  // those two catch arms -- and it is a real risk: the callback rebuilds routes
  // in server.ts. The chain has to absorb it rather than wedge every later
  // notification for that category.
  for (const category of LIST_CHANGED_CATEGORIES.filter((c) => c.label !== "tools")) {
    it(`catches a throwing onListChanged without breaking the ${category.label} chain`, async () => {
      const onListChanged = vi.fn().mockImplementationOnce(() => {
        throw new Error("route rebuild failed");
      });
      const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

      category.install(() => Promise.resolve(category.result("a")));
      const handler = handlerFor(category.schema);
      await expect(handler({ method: category.method })).resolves.toBeUndefined();

      // The fetch result landed before the callback threw.
      expect(category.read(connection)).toEqual(["a"]);
      expect(
        stderr.writes.some(
          (w) => w.includes(`Failed to refresh ${category.label} from upstream`) && w.includes("route rebuild failed"),
        ),
      ).toBe(true);

      // The chain survives: the next notification still refreshes.
      category.install(() => Promise.resolve(category.result("b")));
      await handler({ method: category.method });
      expect(category.read(connection)).toEqual(["b"]);
      expect(onListChanged).toHaveBeenCalledTimes(2);
    });
  }
});

// ---------------------------------------------------------------------------
// disconnectFromUpstream (upstream.ts:615-626) -- a wedged upstream failing to
// close cleanly is the NORMAL case (the child is already gone / the pipe is
// broken), so the catch arm must swallow it and the function must still run to
// completion. A throw here would abort whatever teardown loop called it.
// ---------------------------------------------------------------------------

describe("disconnectFromUpstream", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
    _sdkBehavior.clientClose = () => Promise.resolve();
  });

  it("marks the connection disconnected and closes the client", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    expect(connection.status).toBe("connected");

    const close = vi.fn().mockResolvedValue(undefined);
    _sdkBehavior.clientClose = close;

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();
    expect(connection.status).toBe("disconnected");
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Disconnected from upstream", { namespace: "test" });
  });

  it("does not throw when close() rejects -- logs the failure and finishes the teardown", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    _sdkBehavior.clientClose = () => Promise.reject(new Error("EPIPE: broken pipe"));

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();

    // Status is set BEFORE the close attempt, so a failed close still leaves
    // the connection marked dead rather than stuck on "connected".
    expect(connection.status).toBe("disconnected");
    expect(
      stderr.writes.some((w) => w.includes("Error disconnecting from upstream") && w.includes("EPIPE: broken pipe")),
    ).toBe(true);
    // The tail of the function still runs -- a failed close is not a short circuit.
    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Disconnected from upstream", { namespace: "test" });
  });

  it("does not throw when close() throws synchronously", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    _sdkBehavior.clientClose = () => {
      throw new Error("transport already destroyed");
    };

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();
    expect(connection.status).toBe("disconnected");
    expect(stderr.writes.some((w) => w.includes("transport already destroyed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unexpected disconnect AFTER the connection went live (upstream.ts:518-527).
// Distinct from closedBeforeReady: here status is already "connected", so the
// handler must mark the connection errored and hand the namespace to the
// reconnect callback instead of silently leaving a dead "connected" entry.
// ---------------------------------------------------------------------------

describe("connectToUpstream onclose after ready", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
  });

  it("flips the live connection to error and notifies onDisconnect", async () => {
    const onDisconnect = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), onDisconnect);
    expect(connection.status).toBe("connected");

    connection.client.onclose?.();

    expect(connection.status).toBe("error");
    expect(connection.error).toBe("Upstream disconnected unexpectedly");
    expect(onDisconnect).toHaveBeenCalledWith("test");
    expect(stderr.writes.some((w) => w.includes("Upstream disconnected unexpectedly"))).toBe(true);
  });

  it("still marks the connection errored when no onDisconnect callback was supplied", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    expect(() => connection.client.onclose?.()).not.toThrow();
    expect(connection.status).toBe("error");
    expect(connection.error).toBe("Upstream disconnected unexpectedly");
  });
});

// ---------------------------------------------------------------------------
// Activation failure categorization (upstream.ts:442-489). The dispatch and
// activate handlers compose their user-facing messages off `category`, so a
// mis-bucketed failure produces advice that points at the wrong thing ("check
// your PATH" for a server that actually refused the handshake).
// ---------------------------------------------------------------------------

/** Minimal remote server config (no command, no vault involvement). */
function makeRemoteConfig(overrides: Record<string, unknown> = {}): any {
  return {
    id: "remote-srv",
    name: "Remote Server",
    namespace: "test",
    type: "remote",
    url: "https://mcp.example.test/mcp",
    isActive: true,
    ...overrides,
  };
}

describe("connectToUpstream activation failure categories", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("not configured"));
    _sdkBehavior.stdioConstructions = [];
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.remoteConstructions = [];
    _sdkBehavior.notificationHandlers = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Drive a connect that is expected to fail and hand back the error. */
  async function failedConnect(config: any): Promise<ActivationError> {
    try {
      await connectToUpstream(config);
    } catch (err) {
      return err as ActivationError;
    }
    throw new Error("expected connectToUpstream to reject");
  }

  it("buckets ENOENT as spawn_failure with a PATH-oriented message", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("spawn uvx ENOENT"));

    const err = await failedConnect(makeLocalConfig({ command: "uvx" }));

    expect(err).toBeInstanceOf(ActivationError);
    expect(err.category).toBe("spawn_failure");
    expect(err.message).toContain("Command 'uvx' is not on PATH or is not executable.");
    expect(err.message).toContain('Fix in ~/.yaw-mcp/bundles.json under "test"');
    // The child never wrote to stderr, so there is no tail to attach.
    expect(err.stderrTail).toBeUndefined();
    expect((err.cause as Error).message).toBe("spawn uvx ENOENT");
  });

  it("buckets EACCES as spawn_failure too (second categorizer arm)", async () => {
    // Deliberately avoids the ENOENT/"not found" wording so this exercises the
    // permissions arm rather than the first regex.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("spawn EACCES"));

    const err = await failedConnect(makeLocalConfig({ command: "./server.sh" }));

    expect(err.category).toBe("spawn_failure");
    expect(err.message).toContain("Command './server.sh' is not on PATH or is not executable.");
  });

  it("falls through to 'unknown' and surfaces the raw error when nothing matches", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("Error POSTing to endpoint (HTTP 500)"));

    const err = await failedConnect(makeLocalConfig());

    expect(err.category).toBe("unknown");
    // Unknown failures keep the underlying message rather than inventing PATH
    // advice for a server that clearly started.
    expect(err.message).toContain("Error POSTing to endpoint (HTTP 500)");
    expect(err.message).not.toContain("is not on PATH");
    expect(err.message).toContain('Fix in ~/.yaw-mcp/bundles.json under "test"');
  });

  it("buckets a local handshake timeout as init_timeout and attaches the stderr tail", async () => {
    _sdkBehavior.clientConnect = () => {
      // Something WAS written before the child wedged -- that tail is the part
      // that usually explains the hang, so it must survive into the message.
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("waiting for database..."));
      // Never settles: the only way out is the connect timer.
      return new Promise<void>(() => {});
    };

    const err = await failedConnect(makeLocalConfig({ connectTimeoutMs: 5 }));

    expect(err.category).toBe("init_timeout");
    expect(err.message).toContain(`Server "test" started but didn't complete the MCP handshake within 0.005s.`);
    expect(err.message).toContain("stderr tail: waiting for database...");
    expect(err.stderrTail).toBe("waiting for database...");
  });

  it("buckets a stderr-producing early exit as install_failure", async () => {
    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("npm ERR! 404 Not Found - @acme/nope"));
      return Promise.reject(new Error("connection closed"));
    };

    const err = await failedConnect(makeLocalConfig());

    expect(err.category).toBe("install_failure");
    expect(err.message).toContain(`Server "test" failed to start. stderr: npm ERR! 404 Not Found - @acme/nope`);
  });

  it("rejects a local config with no command before anything is spawned", async () => {
    const err = await connectToUpstream(makeLocalConfig({ command: undefined })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ActivationError);
    expect((err as Error).message).toBe("command is required for local servers");
    expect(_sdkBehavior.stdioConstructions).toHaveLength(0);
  });

  it("rejects a remote config with no url before any transport is built", async () => {
    const err = await connectToUpstream(makeRemoteConfig({ url: undefined })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ActivationError);
    expect((err as Error).message).toBe("url is required for remote servers");
    expect(_sdkBehavior.remoteConstructions).toHaveLength(0);
  });

  it("buckets a remote timeout as init_timeout naming the URL, not the command", async () => {
    _sdkBehavior.clientConnect = () => new Promise<void>(() => {});

    const err = await failedConnect(makeRemoteConfig({ connectTimeoutMs: 5 }));

    expect(err.category).toBe("init_timeout");
    expect(err.message).toContain(
      "Remote server at https://mcp.example.test/mcp did not respond within 0.005s. Verify the URL is reachable.",
    );
    // Remote failures never carry a child stderr tail.
    expect(err.stderrTail).toBeUndefined();
  });

  it("buckets a remote connection refusal as protocol_error", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("fetch failed"));

    const err = await failedConnect(makeRemoteConfig());

    expect(err.category).toBe("protocol_error");
    expect(err.message).toContain("Remote server at https://mcp.example.test/mcp refused the connection.");
  });

  it("selects the SSE transport only when transport is 'sse'", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("fetch failed"));

    await failedConnect(makeRemoteConfig({ transport: "sse", url: "https://mcp.example.test/sse" }));
    await failedConnect(makeRemoteConfig());

    expect(_sdkBehavior.remoteConstructions).toEqual([
      { kind: "sse", url: "https://mcp.example.test/sse" },
      { kind: "http", url: "https://mcp.example.test/mcp" },
    ]);
  });
});
