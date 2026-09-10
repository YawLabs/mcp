import { afterEach, describe, expect, it, vi } from "vitest";

// The helper's whole job is orchestration around these two, so they are the
// seam: mocking them is what lets the teardown contract be asserted without
// spawning a child process.
vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    // Mirrors PRODUCTION: upstream.ts flips the status synchronously and only
    // then awaits the close, and it catches its own close failure rather than
    // rejecting. Both matter to what this module may assume.
    disconnectFromUpstream: vi.fn(async (c: { status: string }) => {
      c.status = "disconnected";
    }),
  };
});

import { TransientConnectError, withTransientUpstream } from "../transient-upstream.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

const CONFIG = {
  id: "local-gh",
  name: "GitHub",
  namespace: "gh",
  type: "local",
  command: "npx",
  isActive: true,
} as UpstreamServerConfig;

function fakeConnection(): UpstreamConnection {
  return {
    config: CONFIG,
    status: "connected",
    tools: [],
    resources: [],
    prompts: [],
  } as unknown as UpstreamConnection;
}

afterEach(() => {
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(disconnectFromUpstream).mockClear();
});

describe("withTransientUpstream", () => {
  it("returns the body's value and disconnects afterwards", async () => {
    const conn = fakeConnection();
    vi.mocked(connectToUpstream).mockResolvedValue(conn);

    const value = await withTransientUpstream(CONFIG, async (c) => {
      // The connection is live INSIDE the body -- that is the contract the
      // callers rely on, and the reason the teardown is in a finally rather
      // than before the return.
      expect(c.status).toBe("connected");
      return "answer";
    });

    expect(value).toBe("answer");
    expect(disconnectFromUpstream).toHaveBeenCalledTimes(1);
    expect(disconnectFromUpstream).toHaveBeenCalledWith(conn);
  });

  it("disconnects even when the body throws, and lets the body's error through", async () => {
    // Leaving the connection open would silently promote a one-shot read or
    // call into an activation -- and for a stdio server it leaves a child
    // process behind with nothing left to reap it.
    vi.mocked(connectToUpstream).mockResolvedValue(fakeConnection());
    const boom = new Error("body exploded");

    await expect(
      withTransientUpstream(CONFIG, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(disconnectFromUpstream).toHaveBeenCalledTimes(1);
  });

  it("wraps a CONNECT failure, and only a connect failure", async () => {
    // Callers report a connect failure as "could not connect to X". A body
    // error reported that way would send the user to check a server that
    // started perfectly well, so the two have to be distinguishable.
    const cause = new Error("ENOENT npx");
    vi.mocked(connectToUpstream).mockRejectedValue(cause);

    const err = await withTransientUpstream(CONFIG, async () => "unreachable").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientConnectError);
    expect((err as TransientConnectError).namespace).toBe("gh");
    expect((err as TransientConnectError).cause).toBe(cause);
    // The message is the underlying one verbatim, so a caller that only wants
    // to interpolate it does not have to unwrap anything.
    expect((err as TransientConnectError).message).toBe("ENOENT npx");
    // Nothing was connected, so nothing is torn down.
    expect(disconnectFromUpstream).not.toHaveBeenCalled();
  });

  it("does not register the connection anywhere or hand it back", async () => {
    // The helper is deliberately stateless: a transient upstream must not end
    // up in a caller's connections map. Returning the connection would be the
    // one way to leak it, and it is closed by then anyway.
    const conn = fakeConnection();
    vi.mocked(connectToUpstream).mockResolvedValue(conn);
    const returned = await withTransientUpstream(CONFIG, async (c) => c);
    expect(returned.status).toBe("disconnected");
  });

  it("passes the bridge through and registers no lifecycle callbacks", async () => {
    // onDisconnect / onListChanged exist to keep a SESSION's routing table in
    // step with a long-lived upstream; this connection outlives nothing, so
    // handing over callbacks would arm notifications with no table to refresh.
    vi.mocked(connectToUpstream).mockResolvedValue(fakeConnection());
    const bridge = { getClientCapabilities: () => undefined } as never;
    await withTransientUpstream(CONFIG, async () => undefined, { bridge });
    expect(connectToUpstream).toHaveBeenCalledWith(CONFIG, undefined, undefined, bridge);
  });
});
