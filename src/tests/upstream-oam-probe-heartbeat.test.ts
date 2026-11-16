import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The oam runtime probe is awaited BEFORE the connect deadline is armed, so
// neither MCP_CONNECT_TIMEOUT nor the handshake heartbeat covers it. This file
// holds that one await open and reads the heartbeat it is wrapped in; the
// sibling case for the launch-command resolve lives in upstream.test.ts.

vi.mock("../secrets-audit.js", () => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Passthrough and immediate, so the launch-command heartbeat has nothing to
// report and every line seen below belongs to the oam probe.
vi.mock("../uv-bootstrap.js", () => ({
  resolveUvSpawn: vi.fn((command: string, args: string[]) => Promise.resolve({ command, args })),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  function MockClient() {
    return {
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      listTools: () => Promise.resolve({ tools: [] }),
      listResources: () => Promise.resolve({ resources: [] }),
      listPrompts: () => Promise.resolve({ prompts: [] }),
      getInstructions: () => undefined,
      onclose: undefined,
      setNotificationHandler: () => {},
      setRequestHandler: () => {},
    };
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  function MockStdioClientTransport() {
    return { stderr: new EventEmitter(), pid: undefined };
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

// The real module spread, with the two spawn rewrites replaced: upstream.ts
// imports more than these from oam-spawn, and a bare factory would fail on the
// first name it did not list.
vi.mock("../oam-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oam-spawn.js")>();
  return {
    ...actual,
    resolveOamSpawn: vi.fn(),
    resolveManagedSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
  };
});

// null is "no runtime configured", which upstream.ts hosts on oam by default,
// so the probe is reached without the test opting in.
vi.mock("../default-runtime.js", () => ({
  defaultRuntime: vi.fn().mockResolvedValue(null),
}));

import { resolveOamSpawn } from "../oam-spawn.js";
import { connectToUpstream } from "../upstream.js";

describe("connectToUpstream progress during the oam runtime probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a slow oam runtime probe, which runs before the connect deadline is armed", async () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    let release: (v: { command: string; args: string[] }) => void = () => {};
    vi.mocked(resolveOamSpawn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const connecting = connectToUpstream(
      {
        id: "test-srv",
        name: "Test Server",
        namespace: "gh",
        type: "local",
        command: "node",
        args: ["server.js"],
        env: {},
        isActive: true,
      } as any,
      undefined,
      undefined,
      undefined,
      (m: string) => messages.push(m),
    );

    await vi.advanceTimersByTimeAsync(4_000);
    expect(messages.filter((m) => m.includes("oam runtime probe"))).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    const probing = messages.filter((m) => m.includes("oam runtime probe"));
    expect(probing).toEqual([
      '"gh" is still waiting on the oam runtime probe -- 5s so far',
      '"gh" is still waiting on the oam runtime probe -- 10s so far',
    ]);
    // The resolve before it finished at once, so its heartbeat said nothing.
    expect(messages.filter((m) => m.includes("resolving its launch command"))).toEqual([]);

    // Unchanged command: the probe found nothing to rewrite.
    release({ command: "node", args: ["server.js"] });
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    // The probe heartbeat stops with the probe.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages.filter((m) => m.includes("oam runtime probe"))).toHaveLength(2);
  });
});
