// Masked-entry secret prompts on a 2026-07-28 connection (R2-lite).
//
// That revision has no server-to-client request, so yaw-mcp cannot push
// elicitation/create the way it does on 2025-11-25. It returns the prompt
// inside the tools/call reply as an input_required result instead, with a
// signed requestState naming the prompt; the client answers on a retry of the
// same call, which waits out the masked-entry page and re-runs the activation
// with the secret in place.
//
// Most of this drives a real @modelcontextprotocol/client 2.3.1 Client with
// versionNegotiation "auto" (what a 2026-07-28 client does) against the real
// ConnectServer serving entry, in process over a linked InMemoryTransport, and
// a REAL masked-entry page on 127.0.0.1 that the test submits to over HTTP.
// The client's auto-fulfil driver answers the prompt through its registered
// elicitation/create handler and retries on its own, so a passing test is the
// whole loop as a client sees it. Only the upstream spawn is mocked: a fake
// server that fails "GITHUB_TOKEN is required" until it is launched with one.
//
// The last block speaks raw JSON-RPC over the same transport, for what the
// SDK client would never send: a retry with no answer, a requestState from a
// different call, a replayed one, a forged one.
//
// The same loop against a real process, under node and oam, is in
// secret-entry-modern-process.test.ts.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session passphrase as the vault prompt stored it, for the fake
// upstream to read back (upstream.ts exports no getter).
const hoisted = vi.hoisted(() => ({ sessionPassphrase: null as string | null }));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
    verifyVaultPassphrase: vi.fn(),
    setSessionVaultPassphrase: (passphrase: string) => {
      hoisted.sessionPassphrase = passphrase;
      actual.setSessionVaultPassphrase(passphrase);
    },
  };
});

import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import {
  clearSessionVaultPassphrase,
  connectToUpstream,
  VaultPassphraseRequiredError,
  verifyVaultPassphrase,
} from "../upstream.js";

const SECRET_KEY = "yaw-mcp.secret";
const VAULT_PASSPHRASE = "correct horse";

let savedPrewarm: string | undefined;
const live: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  savedPrewarm = process.env.YAW_MCP_PREWARM;
  // Nothing here is about pre-warm, and a pre-warm sweep would add spawns
  // the assertions do not expect.
  process.env.YAW_MCP_PREWARM = "0";
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(verifyVaultPassphrase)
    .mockReset()
    .mockImplementation(async (p: string) => p === VAULT_PASSPHRASE);
  hoisted.sessionPassphrase = null;
});

afterEach(async () => {
  for (const h of live.splice(0)) await h.close();
  clearSessionVaultPassphrase();
  if (savedPrewarm === undefined) delete process.env.YAW_MCP_PREWARM;
  else process.env.YAW_MCP_PREWARM = savedPrewarm;
});

// --- fixtures ---------------------------------------------------------------

function serverConfig(namespace: string, env?: Record<string, string>): UpstreamServerConfig {
  return {
    id: namespace,
    name: namespace,
    namespace,
    type: "local",
    command: "echo",
    isActive: true,
    ...(env ? { env } : {}),
  };
}

function fakeConnection(config: UpstreamServerConfig): UpstreamConnection {
  return {
    config,
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: [{ name: "list", namespacedName: `${config.namespace}_list`, inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as unknown as UpstreamConnection;
}

/** An upstream that will not start without GITHUB_TOKEN in its env, the way
 *  a real server reports a missing credential. Records the token each launch
 *  carried. */
function needsGithubToken(): string[] {
  const seen: string[] = [];
  vi.mocked(connectToUpstream).mockImplementation((async (config: UpstreamServerConfig) => {
    const token = config.env?.GITHUB_TOKEN;
    seen.push(token ?? "(none)");
    if (!token) throw new Error("GITHUB_TOKEN is required");
    return fakeConnection(config);
  }) as unknown as typeof connectToUpstream);
  return seen;
}

/** Upstreams whose env references the local vault: they fail the way
 *  resolveServerEnv does until the session holds the passphrase the prompt
 *  verified and stored. */
function needsVault(): void {
  vi.mocked(connectToUpstream).mockImplementation((async (config: UpstreamServerConfig) => {
    if (hoisted.sessionPassphrase !== VAULT_PASSPHRASE) {
      throw new VaultPassphraseRequiredError("vault locked", config.namespace, ["GITHUB_TOKEN"], "missing");
    }
    return fakeConnection(config);
  }) as unknown as typeof connectToUpstream);
}

/** Type values into a masked-entry page the way its form posts them. */
async function submitPage(url: string, fields: Record<string, string>): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  await res.text();
  return res.status;
}

function text(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
}

/** The payload of a requestState minted by createRequestStateCodec:
 *  "v1." b64url({p, exp, b?}) "." b64url(mac). Signed, not encrypted, so
 *  anyone holding it can read this -- which is what the test checks. */
function statePayload(state: string): Record<string, unknown> {
  const [, body] = state.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")).p;
}

// --- harness ----------------------------------------------------------------

interface Harness {
  server: ConnectServer;
  priv: any;
  client: Client;
  /** Every message yaw-mcp wrote, in order. */
  wire: Array<Record<string, unknown>>;
  /** The params each elicitation/create the client fulfilled carried. */
  asked: Array<Record<string, unknown>>;
}

/** A ConnectServer serving over one end of a linked pair, and a v2 client
 *  on the other that negotiates the era itself. `onElicit` answers each
 *  prompt the client's auto-fulfil driver hands its elicitation/create
 *  handler. */
async function connectClient(opts: {
  servers: UpstreamServerConfig[];
  capabilities?: Record<string, unknown>;
  onElicit: (params: Record<string, unknown>, h: Harness) => Promise<{ action: "accept" | "decline" | "cancel" }>;
}): Promise<Harness> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const wire: Array<Record<string, unknown>> = [];
  const send = serverSide.send.bind(serverSide);
  serverSide.send = async (message, options) => {
    wire.push(message as unknown as Record<string, unknown>);
    return send(message, options);
  };

  const server = new ConnectServer();
  const priv = server as any;
  priv.config = { servers: opts.servers, configVersion: "v1" };
  // The single spawn retry sleeps a fixed 1 s; nothing here is about it.
  priv.activationRetryDelayMs = 0;
  priv.stdioHandle = await priv.serve(serverSide);

  const client = new Client(
    { name: "secret-entry-modern-test", version: "0.0.0" },
    {
      capabilities: (opts.capabilities ?? { elicitation: { form: {}, url: {} } }) as never,
      versionNegotiation: { mode: "auto" },
    },
  );
  const h: Harness = { server, priv, client, wire, asked: [] };
  client.setRequestHandler("elicitation/create", async (request) => {
    const params = request.params as unknown as Record<string, unknown>;
    h.asked.push(params);
    return opts.onElicit(params, h);
  });
  await client.connect(clientSide);
  live.push({
    close: async () => {
      await client.close().catch(() => {});
      await server.shutdown();
    },
  });
  return h;
}

function activate(h: Harness, server: string | string[]) {
  return h.client.callTool({
    name: "mcp_connect_activate",
    arguments: Array.isArray(server) ? { servers: server } : { server },
  });
}

/** Messages yaw-mcp sent that carry a method and an id: requests of its own,
 *  which a 2026-07-28 session must never send. */
function serverRequests(h: Harness): Array<Record<string, unknown>> {
  return h.wire.filter((m) => m.method !== undefined && m.id !== undefined);
}

/** The input_required replies yaw-mcp sent. */
function inputRequiredReplies(h: Harness): Array<{ inputRequests: Record<string, any>; requestState: string }> {
  return h.wire
    .map((m) => m.result as Record<string, any> | undefined)
    .filter((r): r is Record<string, any> => r?.resultType === "input_required") as never;
}

// --- tests ------------------------------------------------------------------

describe("secret entry on 2026-07-28, through a v2 client negotiating the era itself", () => {
  it("negotiates 2026-07-28 against yaw-mcp's serving entry", async () => {
    const h = await connectClient({ servers: [], onElicit: async () => ({ action: "cancel" }) });
    expect(h.client.getProtocolEra()).toBe("modern");
    expect(h.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
  });

  it("asks for a missing credential in URL mode with no elicitationId, and the page submitted before the retry completes the activation", async () => {
    const seen = needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async (params) => {
        // The user types the token and submits before the client retries.
        expect(await submitPage(params.url as string, { GITHUB_TOKEN: "tok-before" })).toBe(200);
        return { action: "accept" };
      },
    });

    const result = await activate(h, "gh");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Loaded "gh"');
    expect(seen.at(-1)).toBe("tok-before");
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].mode).toBe("url");
    expect(h.asked[0].message).toContain("GITHUB_TOKEN");
    expect(h.asked[0]).not.toHaveProperty("elicitationId");

    // On the wire: one input_required reply carrying the url-mode request,
    // and nothing pushed -- no elicitation/create, and no
    // notifications/elicitation/complete after the page settled.
    const [reply] = inputRequiredReplies(h);
    expect(Object.keys(reply.inputRequests)).toEqual([SECRET_KEY]);
    expect(reply.inputRequests[SECRET_KEY].params).not.toHaveProperty("elicitationId");
    expect(serverRequests(h)).toEqual([]);
    expect(h.wire.filter((m) => m.method === "notifications/elicitation/complete")).toEqual([]);
  });

  it("puts the prompt's own id and a digest of the call in requestState, never the page's address", async () => {
    needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async (params) => {
        await submitPage(params.url as string, { GITHUB_TOKEN: "tok" });
        return { action: "accept" };
      },
    });
    await activate(h, "gh");

    const [reply] = inputRequiredReplies(h);
    const pageUrl = reply.inputRequests[SECRET_KEY].params.url as string;
    const token = new URL(pageUrl).pathname.slice(1);
    expect(token.length).toBeGreaterThan(16);
    const payload = statePayload(reply.requestState);
    expect(Object.keys(payload).sort()).toEqual(["argsDigest", "pageId"]);
    expect(reply.requestState).not.toContain(token);
    expect(JSON.stringify(payload)).not.toContain(token);
  });

  it("waits on the page when the retry arrives before the user submits", async () => {
    const seen = needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async (params, harness) => {
        // Accept at once; submit only once the retry has redeemed the prompt
        // and is waiting on the page.
        void (async () => {
          await vi.waitFor(() => expect(harness.priv.secretAsks.size).toBe(0), { timeout: 10_000 });
          await submitPage(params.url as string, { GITHUB_TOKEN: "tok-after" });
        })();
        return { action: "accept" };
      },
    });

    const result = await activate(h, "gh");

    expect(text(result)).toContain('Loaded "gh"');
    expect(seen.at(-1)).toBe("tok-after");
    expect(h.wire.filter((m) => m.method === "notifications/elicitation/complete")).toEqual([]);
  });

  it("refuses with the expiry words when the page expires before anything is submitted", async () => {
    needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async () => ({ action: "accept" }),
    });
    h.priv.secretEntryPageTtlMs = 300;

    const result = await activate(h, "gh");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("expired with nothing submitted");
    expect(text(result)).toContain("GITHUB_TOKEN");
    // Expiry does not latch: the next activate asks again.
    await activate(h, "gh");
    expect(h.asked).toHaveLength(2);
  });

  it("asks a form-only client for consent with no fields, then opens the page itself", async () => {
    const seen = needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      capabilities: { elicitation: { form: {} } },
      onElicit: async () => ({ action: "accept" }),
    });
    const opened: string[] = [];
    h.priv.openBrowser = vi.fn(async (url: string) => {
      opened.push(url);
      void submitPage(url, { GITHUB_TOKEN: "tok-form" });
      return true;
    });

    const result = await activate(h, "gh");

    expect(text(result)).toContain('Loaded "gh"');
    expect(seen.at(-1)).toBe("tok-form");
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].mode ?? "form").toBe("form");
    expect(h.asked[0].requestedSchema).toEqual({ type: "object", properties: {} });
    expect(JSON.stringify(h.asked[0])).not.toContain("127.0.0.1:");
    expect(opened).toHaveLength(1);
  });

  it("treats a decline as the user's answer: the spawn error, and no second prompt", async () => {
    needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async () => ({ action: "decline" }),
    });

    const first = await activate(h, "gh");
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("GITHUB_TOKEN is required");

    const second = await activate(h, "gh");
    expect(second.isError).toBe(true);
    expect(h.asked).toHaveLength(1);
  });

  it("asks for two servers' credentials one round at a time when one call activates both", async () => {
    needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh"), serverConfig("gl")],
      onElicit: async (params) => {
        await submitPage(params.url as string, { GITHUB_TOKEN: `tok-${(params.message as string).slice(1, 3)}` });
        return { action: "accept" };
      },
    });

    const result = await activate(h, ["gh", "gl"]);

    // The last round re-ran both: gh was loaded by the round before it.
    expect(text(result)).toContain('"gh" is already loaded');
    expect(text(result)).toContain('Loaded "gl"');
    // Asked in turn: each round carries one prompt.
    expect(h.asked).toHaveLength(2);
    expect(inputRequiredReplies(h).map((r) => Object.keys(r.inputRequests))).toEqual([[SECRET_KEY], [SECRET_KEY]]);
    expect(h.priv.elicitedEnv.get("gh")).toEqual({ GITHUB_TOKEN: "tok-gh" });
    expect(h.priv.elicitedEnv.get("gl")).toEqual({ GITHUB_TOKEN: "tok-gl" });
  });

  it("unlocks the vault with one prompt for every vault-backed server in the call", async () => {
    needsVault();
    const h = await connectClient({
      servers: [serverConfig("gh"), serverConfig("gl")],
      onElicit: async (params) => {
        await submitPage(params.url as string, { passphrase: VAULT_PASSPHRASE });
        return { action: "accept" };
      },
    });
    const result = await activate(h, ["gh", "gl"]);

    expect(text(result)).toContain('Loaded "gh"');
    expect(text(result)).toContain('Loaded "gl"');
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].mode).toBe("url");
    expect(h.asked[0].message).toContain("vault");
    expect(serverRequests(h)).toEqual([]);
  });

  it("gives a passphrase that does not unlock the vault the rejection words", async () => {
    needsVault();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async (params) => {
        await submitPage(params.url as string, { passphrase: "wrong" });
        return { action: "accept" };
      },
    });

    const result = await activate(h, "gh");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("does not unlock your local secret vault");
    expect(hoisted.sessionPassphrase).toBeNull();
  });

  it("asks nothing for an activation no request carries, such as pre-warm, and leaves the asking to the next explicit activate", async () => {
    const seen = needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh")],
      onElicit: async (params) => {
        await submitPage(params.url as string, { GITHUB_TOKEN: "tok-later" });
        return { action: "accept" };
      },
    });
    // Any request past discover marks the session 2026-07-28.
    await h.client.listTools();

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    // An exported LOG_LEVEL=warn would silence the info line under test.
    vi.stubEnv("LOG_LEVEL", "");
    let r: { ok: boolean };
    try {
      r = await h.priv.activateOne("gh", undefined, /* fromPrewarm */ true);
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(r.ok).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(h.priv.secretAsks.size).toBe(0);
    expect(h.priv.secretEntryPages.size).toBe(0);
    expect(h.asked).toEqual([]);
    expect(written.join("")).toContain("no client request to ask on; the next explicit activate will ask");

    // Nothing was spent or latched, so the next explicit activate asks.
    const result = await activate(h, "gh");
    expect(text(result)).toContain('Loaded "gh"');
    expect(h.asked).toHaveLength(1);
  });
});

// --- one call, several activations at once ------------------------------------

/** A 2026-07-28 round registered the way callToolCarryingInput registers
 *  one, for driving activations of a single call directly. */
function roundOf(priv: any): { progress: () => void; leg: any } {
  const progress = (): void => {};
  let markPosted: () => void = () => {};
  const posted = new Promise<void>((resolve) => {
    markPosted = resolve;
  });
  const leg = {
    progress,
    capabilities: { elicitation: { form: {}, url: {} } },
    answer: null,
    ask: null,
    askClaimed: false,
    posted,
    markPosted,
  };
  priv.inputLegs.set(progress, leg);
  return { progress, leg };
}

/** Stretch the page open so a second activation of the same call reaches its
 *  prompt while the first is still opening its page: the window where a
 *  check of the posted prompt alone would let a second one through. */
function slowPageOpen(priv: any): void {
  const open = priv.openSecretPage;
  priv.openSecretPage = async (o: unknown) => {
    await new Promise((r) => setTimeout(r, 100));
    return open(o);
  };
}

describe("one call activating several servers at once", () => {
  it("posts a single prompt; the other activation waits for the next round", async () => {
    needsGithubToken();
    const h = await connectClient({
      servers: [serverConfig("gh"), serverConfig("gl")],
      onElicit: async () => ({ action: "cancel" }),
    });
    await h.client.listTools();
    slowPageOpen(h.priv);
    const { progress, leg } = roundOf(h.priv);

    const results = await Promise.all([h.priv.activateOne("gh", progress), h.priv.activateOne("gl", progress)]);

    expect(h.priv.secretAsks.size).toBe(1);
    expect(leg.ask).not.toBeNull();
    expect(results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect(results.map((r: { message: string }) => r.message).join("\n")).toContain("waiting on a secret-entry prompt");
    // Only the prompt that was posted spent its namespace's budget.
    expect([...h.priv.credentialPrompts.values()]).toEqual([1]);
  });

  it("does not wait on its own call's vault prompt: both activations return so the call can hand it out", async () => {
    needsVault();
    const h = await connectClient({
      servers: [serverConfig("gh"), serverConfig("gl")],
      onElicit: async () => ({ action: "cancel" }),
    });
    await h.client.listTools();
    slowPageOpen(h.priv);
    const { progress, leg } = roundOf(h.priv);

    const results = await Promise.all([h.priv.activateOne("gh", progress), h.priv.activateOne("gl", progress)]);

    expect(h.priv.secretAsks.size).toBe(1);
    expect(leg.ask.subject).toBe("vault");
    expect(
      results
        .map((r: { message: string }) => r.message)
        .every((m: string) => m.includes("waiting on a secret-entry prompt")),
    ).toBe(true);
  }, 10_000);
});

// --- raw JSON-RPC -------------------------------------------------------------

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
};

interface Raw {
  priv: any;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
}

async function connectRaw(servers: UpstreamServerConfig[]): Promise<Raw> {
  const [peer, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new ConnectServer();
  const priv = server as any;
  priv.config = { servers, configVersion: "v1" };
  priv.activationRetryDelayMs = 0;
  priv.stdioHandle = await priv.serve(serverSide);
  const waiters = new Map<number, (m: Record<string, any>) => void>();
  peer.onmessage = (m) => {
    const msg = m as unknown as Record<string, any>;
    const waiter = typeof msg.id === "number" ? waiters.get(msg.id) : undefined;
    if (waiter) {
      waiters.delete(msg.id);
      waiter(msg);
    }
  };
  await peer.start();
  live.push({ close: () => server.shutdown() });
  let id = 0;
  const raw: Raw = {
    priv,
    request(method, params = {}) {
      const myId = ++id;
      return new Promise((resolve) => {
        waiters.set(myId, resolve);
        void peer.send({ jsonrpc: "2.0", id: myId, method, params: { ...params, _meta: ENVELOPE } } as never);
      });
    },
  };
  const discover = await raw.request("server/discover");
  expect(discover.result.supportedVersions).toEqual(["2026-07-28"]);
  return raw;
}

describe("the requestState round trip, on the wire", () => {
  const CALL = { name: "mcp_connect_activate", arguments: { server: "gh" } };

  it("asks again when a retry brings no answer for the prompt", async () => {
    needsGithubToken();
    const raw = await connectRaw([serverConfig("gh")]);
    const first = await raw.request("tools/call", CALL);
    expect(first.result.resultType).toBe("input_required");

    const retry = await raw.request("tools/call", {
      ...CALL,
      inputResponses: {},
      requestState: first.result.requestState,
    });

    expect(retry.result.resultType).toBe("input_required");
    expect(retry.result.inputRequests).toEqual(first.result.inputRequests);
    // Still open: the re-ask did not consume it.
    expect(raw.priv.secretAsks.size).toBe(1);
  });

  it("refuses a requestState issued for a different call with -32602", async () => {
    needsGithubToken();
    const raw = await connectRaw([serverConfig("gh"), serverConfig("gl")]);
    const first = await raw.request("tools/call", CALL);

    const other = await raw.request("tools/call", {
      name: "mcp_connect_activate",
      arguments: { server: "gl" },
      inputResponses: { [SECRET_KEY]: { action: "accept" } },
      requestState: first.result.requestState,
    });

    expect(other.error?.code).toBe(-32602);
  });

  it("refuses a forged requestState with -32602 before the handler runs", async () => {
    needsGithubToken();
    const raw = await connectRaw([serverConfig("gh")]);
    const first = await raw.request("tools/call", CALL);
    const [v, , mac] = (first.result.requestState as string).split(".");
    const forged = `${v}.${Buffer.from(JSON.stringify({ p: { pageId: "x", argsDigest: "y" }, exp: 9e9 })).toString("base64url")}.${mac}`;

    const res = await raw.request("tools/call", {
      ...CALL,
      inputResponses: { [SECRET_KEY]: { action: "accept" } },
      requestState: forged,
    });

    expect(res.error?.code).toBe(-32602);
  });

  it("answers a replay of a redeemed requestState with a refusal, not a second answer", async () => {
    needsGithubToken();
    const raw = await connectRaw([serverConfig("gh")]);
    const first = await raw.request("tools/call", CALL);
    const declined = {
      ...CALL,
      inputResponses: { [SECRET_KEY]: { action: "decline" } },
      requestState: first.result.requestState,
    };

    const answered = await raw.request("tools/call", declined);
    expect(answered.result.isError).toBe(true);
    expect(text(answered.result)).toContain("GITHUB_TOKEN is required");

    const replay = await raw.request("tools/call", declined);
    expect(replay.result.isError).toBe(true);
    expect(text(replay.result)).toContain("no longer open");
  });
});
