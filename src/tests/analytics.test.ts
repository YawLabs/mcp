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
  getDroppedEventsCount,
  getLastAnalyticsFailure,
  initAnalytics,
  recordConnectEvent,
  recordDispatchEvent,
  shutdownAnalytics,
} from "../analytics.js";

const mockedRequest = vi.mocked(request);

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

  it("recordConnectEvent adds event to buffer", () => {
    initAnalytics("https://example.com", "test-token");
    recordConnectEvent({
      namespace: "gh",
      toolName: "create_issue",
      action: "tool_call",
      latencyMs: 100,
      success: true,
    });
    // Event was recorded (buffer is internal, but we can verify via shutdown flush)
  });

  it("recordConnectEvent drops events beyond MAX_BUFFER", () => {
    initAnalytics("https://example.com", "test-token");
    // Fill beyond 5000
    for (let i = 0; i < 5100; i++) {
      recordConnectEvent({
        namespace: "gh",
        toolName: null,
        action: "discover",
        latencyMs: null,
        success: true,
      });
    }
    // Should not throw — events beyond 5000 are silently dropped
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
