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
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  function MockClient() {
    return {
      connect: () => _sdkBehavior.clientConnect(),
      close: () => _sdkBehavior.clientClose(),
      listResources: () => Promise.resolve({ resources: [] }),
      listPrompts: () => Promise.resolve({ prompts: [] }),
      onclose: undefined as (() => void) | undefined,
      setNotificationHandler: () => {},
    };
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  function MockStdioClientTransport() {
    const emitter = new EventEmitter();
    _sdkBehavior.stderrEmitter = emitter;
    return { stderr: emitter };
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

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
