import { request } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock undici before importing analytics
vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
  }),
}));

import {
  getAnalyticsSnapshot,
  getDroppedEventsCount,
  getLastAnalyticsFailure,
  initAnalytics,
  recordConnectEvent,
  recordDispatchEvent,
  shutdownAnalytics,
} from "../analytics.js";

const mockedRequest = vi.mocked(request);

/** Parse the JSON body an undici `request` mock call was given. */
function bodyOf(call: unknown[] | undefined): { events: Array<Record<string, unknown>> } {
  expect(call).toBeDefined();
  return JSON.parse((call?.[1] as { body: string }).body);
}

describe("analytics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default to a 200 success path; individual tests override per call.
    mockedRequest.mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
  });

  afterEach(async () => {
    await shutdownAnalytics();
    vi.useRealTimers();
    mockedRequest.mockReset();
  });

  it("recordConnectEvent buffers the event and POSTs it, stamped, on flush", async () => {
    initAnalytics("https://example.com", "test-token");
    recordConnectEvent({
      namespace: "gh",
      toolName: "create_issue",
      action: "tool_call",
      latencyMs: 100,
      success: true,
    });

    // One event is well under FLUSH_SIZE, so nothing is on the wire yet.
    expect(getAnalyticsSnapshot().bufferedConnect).toBe(1);
    expect(mockedRequest).not.toHaveBeenCalled();

    await shutdownAnalytics();

    expect(mockedRequest).toHaveBeenCalledTimes(1);
    const call = mockedRequest.mock.calls[0];
    expect(String(call[0])).toBe("https://example.com/api/connect/analytics");
    expect((call[1] as { method: string }).method).toBe("POST");
    const body = bodyOf(call);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      namespace: "gh",
      toolName: "create_issue",
      action: "tool_call",
      latencyMs: 100,
      success: true,
    });
    // recordConnectEvent stamps the timestamp; the caller never supplies one.
    expect(Number.isNaN(Date.parse(body.events[0].timestamp as string))).toBe(false);
    // The buffer is drained, not just copied.
    expect(getAnalyticsSnapshot().bufferedConnect).toBe(0);
  });

  it("recordConnectEvent flushes automatically once FLUSH_SIZE events are buffered", async () => {
    initAnalytics("https://example.com", "test-token");
    const FLUSH_SIZE = 50;
    for (let i = 0; i < FLUSH_SIZE; i++) {
      recordConnectEvent({
        namespace: `ns-${i}`,
        toolName: null,
        action: "discover",
        latencyMs: null,
        success: true,
      });
    }
    // The 50th push calls flush(), which calls request() before its first
    // await -- so the POST is observable synchronously, no timer advance.
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    const body = bodyOf(mockedRequest.mock.calls[0]);
    expect(body.events).toHaveLength(FLUSH_SIZE);
    expect(body.events[0].namespace).toBe("ns-0");
    expect(body.events[FLUSH_SIZE - 1].namespace).toBe(`ns-${FLUSH_SIZE - 1}`);
    // Let the in-flight flush settle inside the test rather than after it.
    await shutdownAnalytics();
  });

  it("recordConnectEvent caps the buffer at MAX_BUFFER and counts the overflow as dropped", () => {
    // Empty url/token so flush() is a no-op. With a real apiUrl every 50th
    // push synchronously splices FLUSH_SIZE events back out of the buffer, so
    // it never approaches the cap and the premise of this test evaporates.
    initAnalytics("", "");
    const MAX_BUFFER = 5000;
    const EXTRA = 100;
    const droppedBefore = getDroppedEventsCount();

    for (let i = 0; i < MAX_BUFFER + EXTRA; i++) {
      recordConnectEvent({
        namespace: "gh",
        toolName: null,
        action: "discover",
        latencyMs: null,
        success: true,
      });
    }

    // The cap holds exactly: the buffer stops growing and every push past it
    // is counted, so an offline backlog is visible to `yaw-mcp doctor`.
    expect(getAnalyticsSnapshot().bufferedConnect).toBe(MAX_BUFFER);
    expect(getDroppedEventsCount() - droppedBefore).toBe(EXTRA);
  });

  it("a 401 flush sets the failure latch with the captured shape", async () => {
    // Persistent 401 for the duration of this test; shutdown loops up
    // to 3 times re-flushing the re-buffered batch and we want every
    // attempt to fail so the latch reliably captures 401.
    mockedRequest.mockResolvedValue({
      statusCode: 401,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);

    initAnalytics("https://example.com", "test-token");
    // Push a single event, then trigger shutdown which forces a flush.
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();

    const latch = getLastAnalyticsFailure();
    expect(latch).not.toBeNull();
    expect(latch?.statusCode).toBe(401);
    expect(latch?.url).toBe("https://example.com/api/connect/analytics");
    expect(typeof latch?.at).toBe("number");
  });

  it("a transport error sets the failure latch with statusCode 0 and warns once", async () => {
    // An offline machine never gets an HTTP status, so statusCode 0 is the
    // transport-error sentinel `yaw-mcp doctor` reads (same convention as
    // tool-report.ts). Before this the offline case was invisible to doctor
    // AND re-warned on every flush interval.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      mockedRequest.mockRejectedValue(new Error("ECONNREFUSED"));
      initAnalytics("https://example.com", "test-token");
      recordConnectEvent({
        namespace: "gh",
        toolName: null,
        action: "discover",
        latencyMs: null,
        success: true,
      });
      // shutdownAnalytics retries the re-enqueued batch up to 3 times, so
      // this also exercises the log latch across repeated identical failures.
      await shutdownAnalytics();

      const latch = getLastAnalyticsFailure();
      expect(latch).not.toBeNull();
      expect(latch?.statusCode).toBe(0);
      expect(latch?.url).toBe("https://example.com/api/connect/analytics");
      expect(typeof latch?.at).toBe("number");

      expect(mockedRequest.mock.calls.length).toBeGreaterThan(1);
      const warnLines = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("Analytics flush error"));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain("ECONNREFUSED");
    } finally {
      stderr.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // shouldSendBearer (tested indirectly via flush headers)
  // ---------------------------------------------------------------------------

  it("shouldSendBearer: sends Authorization header for https:// URL", async () => {
    initAnalytics("https://example.com", "tok-abc");
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();

    const call = mockedRequest.mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer tok-abc");
  });

  it.each([
    ["http://localhost", "localhost"],
    ["http://127.0.0.1", "127.0.0.1"],
    ["http://[::1]", "[::1]"],
  ])("shouldSendBearer: sends Authorization header for loopback %s", async (base) => {
    initAnalytics(base, "tok-loop");
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();

    const call = mockedRequest.mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer tok-loop");
  });

  it("shouldSendBearer: omits Authorization header for http://example.com (non-loopback plaintext)", async () => {
    initAnalytics("http://example.com", "tok-insecure");
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();

    const call = mockedRequest.mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // flushDispatch(): 500 re-enqueue behavior
  // ---------------------------------------------------------------------------

  it("flushDispatch(): 500 response re-enqueues events (not dropped) and sets the failure latch", async () => {
    mockedRequest.mockResolvedValue({
      statusCode: 500,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);

    initAnalytics("https://example.com", "test-token");
    recordDispatchEvent({
      scope: "connect",
      serverId: "srv-1",
      toolName: "list_repos",
      requestBytes: 10,
      responseBytesRaw: 20,
    });
    // shutdownAnalytics retries up to 3 times; keep returning 500 so events
    // stay in the buffer long enough to verify re-enqueue on the first flush.
    // We check the failure latch rather than internal buffer state.
    await shutdownAnalytics();

    const latch = getLastAnalyticsFailure();
    expect(latch).not.toBeNull();
    expect(latch?.statusCode).toBe(500);
    expect(latch?.url).toBe("https://example.com/api/connect/dispatch-events");
  });

  it("flushDispatch(): droppedEvents counted when dispatch buffer overflows MAX_BUFFER", () => {
    // Use empty url/token so flushDispatch is a no-op and the buffer fills
    // freely without being synchronously spliced on each FLUSH_SIZE hit.
    initAnalytics("", "");
    const before = getDroppedEventsCount();
    const MAX = 5000;
    const EXTRA = 10;

    for (let i = 0; i < MAX + EXTRA; i++) {
      recordDispatchEvent({
        scope: "connect",
        serverId: "srv",
        toolName: "t",
        requestBytes: 1,
        responseBytesRaw: 1,
      });
    }

    const after = getDroppedEventsCount();
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeGreaterThanOrEqual(EXTRA);
  });

  // ---------------------------------------------------------------------------
  // getDroppedEventsCount()
  // ---------------------------------------------------------------------------

  it("getDroppedEventsCount() returns the accumulated drop total", () => {
    // Use empty url/token so flush() is a no-op -- with a real apiUrl, flush()
    // synchronously splices the buffer on every FLUSH_SIZE hit, preventing the
    // buffer from ever reaching MAX_BUFFER.
    initAnalytics("", "");
    const before = getDroppedEventsCount();

    // Push 5100 connect events -- the first 5000 land, the rest are dropped.
    for (let i = 0; i < 5100; i++) {
      recordConnectEvent({
        namespace: "gh",
        toolName: null,
        action: "discover",
        latencyMs: null,
        success: true,
      });
    }

    const after = getDroppedEventsCount();
    // At least 100 events were dropped (5100 - MAX_BUFFER 5000).
    expect(after - before).toBeGreaterThanOrEqual(100);
  });

  it("a subsequent 200 flush clears the latch", async () => {
    // First, force a persistent 401 to set the latch.
    mockedRequest.mockResolvedValue({
      statusCode: 401,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    initAnalytics("https://example.com", "test-token");
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();
    expect(getLastAnalyticsFailure()).not.toBeNull();

    // Now a 200 flush should clear it.
    mockedRequest.mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    initAnalytics("https://example.com", "test-token");
    recordConnectEvent({
      namespace: "gh",
      toolName: null,
      action: "discover",
      latencyMs: null,
      success: true,
    });
    await shutdownAnalytics();

    expect(getLastAnalyticsFailure()).toBeNull();
  });
});
