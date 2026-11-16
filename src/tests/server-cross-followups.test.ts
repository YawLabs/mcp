// Cross-file follow-ups that land in server.ts:
//   * an entry that cannot be launched as written is not retried,
//   * resources/read and prompts/get forward the client's abort signal,
//   * the bundle "missing" split is the shared one in bundles.ts,
//   * mcp_connect_secrets counts a git entry's tokenSecret (the projection
//     in handleSecretsReport; computeSecretsReport itself is covered in
//     git-token-secret-refs.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn(async (c: UpstreamConnection) => {
      c.status = "disconnected";
    }),
  };
});

import { splitBundleMissing } from "../bundles.js";
import { ConnectServer, hasUnlaunchableShape } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "../upstream.js";

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "1",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

/** The error connectToUpstream throws for a refusal it makes from the entry
 *  alone: category "unknown", with the config pointer. Its catch-all for a
 *  failure it could not classify has the same category and pointer -- which
 *  is why the category alone cannot decide the retry. */
const configError = (message: string): ActivationError =>
  new ActivationError(message, "unknown", undefined, undefined, { summary: message, fix: 'Fix "x" in bundles.json' });

let server: ConnectServer;
let priv: any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(disconnectFromUpstream).mockReset();
  server = new ConnectServer();
  priv = server as any;
});

afterEach(async () => {
  await server.shutdown();
});

describe("hasUnlaunchableShape", () => {
  it("is true for exactly the entries connectToUpstream refuses from their shape", () => {
    expect(hasUnlaunchableShape(makeServerConfig({ command: undefined }))).toBe(true);
    expect(hasUnlaunchableShape(makeServerConfig({ command: "" }))).toBe(true);
    expect(hasUnlaunchableShape(makeServerConfig())).toBe(false);
    const remote = (url: string | undefined) => makeServerConfig({ type: "remote", command: undefined, url });
    expect(hasUnlaunchableShape(remote(undefined))).toBe(true);
    expect(hasUnlaunchableShape(remote("not a url"))).toBe(true);
    expect(hasUnlaunchableShape(remote("https://example.test/mcp"))).toBe(false);
  });
});

describe("activation retry", () => {
  it("does not retry (or sleep) when the entry cannot be launched as written", async () => {
    // A real delay: if the retry sleep ran, this case would take 60 s and
    // time out, so "no sleep" is observed and not just "one call".
    priv.activationRetryDelayMs = 60_000;
    priv.config = { servers: [makeServerConfig({ namespace: "nocmd", command: undefined })], configVersion: "v1" };
    vi.mocked(connectToUpstream).mockRejectedValue(
      configError('Server "nocmd" has no "command": command is required for local servers'),
    );

    const result = await priv.activateOne("nocmd");

    expect(result.ok).toBe(false);
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
  });

  it("still retries an unclassified failure on an entry whose shape is fine", async () => {
    // Same category, same pointer -- but nothing about the entry says the
    // second attempt must fail, so it gets one.
    priv.activationRetryDelayMs = 0;
    priv.config = { servers: [makeServerConfig({ namespace: "flaky" })], configVersion: "v1" };
    vi.mocked(connectToUpstream).mockRejectedValue(configError("Connection closed"));

    const result = await priv.activateOne("flaky");

    expect(result.ok).toBe(false);
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
  });
});

describe("resources/read and prompts/get forward the client's abort signal", () => {
  /** Capture the handlers installHandlers registers, as the SDK would hold them. */
  function installedHandlers(): Map<string, (request: unknown, ctx: unknown) => Promise<unknown>> {
    const handlers = new Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>();
    priv.installHandlers(
      {
        setRequestHandler: (method: string, fn: (request: unknown, ctx: unknown) => Promise<unknown>) =>
          handlers.set(method, fn),
      },
      undefined,
    );
    return handlers;
  }

  function connect(): { readResource: ReturnType<typeof vi.fn>; getPrompt: ReturnType<typeof vi.fn> } {
    const readResource = vi.fn().mockResolvedValue({ contents: [{ uri: "db://tables", text: "t" }] });
    const getPrompt = vi.fn().mockResolvedValue({ messages: [] });
    const connection = {
      config: makeServerConfig({ namespace: "db", name: "db" }),
      client: { readResource, getPrompt, close: vi.fn() },
      transport: {},
      tools: [],
      resources: [{ uri: "db://tables", namespacedUri: "connect://db/db://tables", name: "tables" }],
      prompts: [{ name: "review", namespacedName: "db_review" }],
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0, resultBytesUpstream: 0, resultBytesDownstream: 0 },
      status: "connected",
    } as unknown as UpstreamConnection;
    priv.connections.set("db", connection);
    priv.resourceRoutes = new Map([["connect://db/db://tables", { namespace: "db", originalUri: "db://tables" }]]);
    priv.promptRoutes = new Map([["db_review", { namespace: "db", originalName: "review" }]]);
    return { readResource, getPrompt };
  }

  it("hands ctx.mcpReq.signal to the upstream request on both routes", async () => {
    const { readResource, getPrompt } = connect();
    const handlers = installedHandlers();
    const ac = new AbortController();
    const ctx = { mcpReq: { signal: ac.signal } };

    await handlers.get("resources/read")?.({ params: { uri: "connect://db/db://tables" } }, ctx);
    await handlers.get("prompts/get")?.({ params: { name: "db_review", arguments: {} } }, ctx);

    expect(readResource).toHaveBeenCalledTimes(1);
    expect(getPrompt).toHaveBeenCalledTimes(1);
    expect(readResource.mock.calls[0][1].signal).toBe(ac.signal);
    expect(getPrompt.mock.calls[0][1].signal).toBe(ac.signal);
  });
});

describe("mcp_connect_secrets -- git.tokenSecret", () => {
  let synthHome: string;

  beforeEach(() => {
    // The report lists the vault's key names from ~/.yaw-mcp/secrets.json:
    // an empty temp home keeps the developer's real vault out of it.
    synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-secrets-git-"));
    vi.stubEnv("HOME", synthHome);
    vi.stubEnv("USERPROFILE", synthHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(synthHome, { recursive: true, force: true });
  });

  it("names a git entry's clone token, which sits in neither env nor headers", async () => {
    priv.config = {
      servers: [
        makeServerConfig({
          namespace: "privrepo",
          git: {
            url: "https://example.test/acme/server.git",
            commit: "0123456789abcdef0123456789abcdef01234567",
            entry: "dist/index.js",
            tokenSecret: "GIT_TOKEN",
          },
        }),
      ],
      configVersion: "v1",
    };

    const result = await priv.handleSecretsReport();

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([
      { server: "privrepo", injectedSecrets: [], missing: ["GIT_TOKEN"], malformed: [] },
    ]);
  });
});

describe("bundle remedies", () => {
  it("server.ts splits a bundle's missing members with the shared bundles.ts function", () => {
    const servers = [
      makeServerConfig({ namespace: "github" }),
      makeServerConfig({ namespace: "linear", isActive: false }),
      makeServerConfig({ namespace: "slack" }),
    ];
    priv.config = { servers, configVersion: "v1" };
    const missing = ["pagerduty", "linear", "slack"];
    const expected = { notInstalled: ["pagerduty"], disabled: ["linear"], blocked: ["slack"] };
    expect(splitBundleMissing(missing, servers)).toEqual(expected);
    expect(priv.splitBundleMissing(missing)).toEqual(expected);
  });

  it("the first entry wins for a duplicated namespace", () => {
    expect(
      splitBundleMissing(
        ["gh"],
        [
          { namespace: "gh", isActive: false },
          { namespace: "gh", isActive: true },
        ],
      ),
    ).toEqual({ notInstalled: [], disabled: ["gh"], blocked: [] });
  });
});
