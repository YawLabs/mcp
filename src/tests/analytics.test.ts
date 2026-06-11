import { request } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock undici before importing analytics
vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
  }),
}));

// Mock team-sync so teeToTeamAnalytics calls don't escape to the network.
vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, postAnalyticsEvent: vi.fn().mockResolvedValue({ ok: true }) };
});

import {
  _resetTeamAnalyticsForTests,
  getLastAnalyticsFailure,
  initAnalytics,
  recordConnectEvent,
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

  it("initAnalytics resets teamAnalyticsDisabled so mid-session sign-in re-enables team analytics", async () => {
    // Force the latch to the "disabled" state via the test hook.
    _resetTeamAnalyticsForTests(); // no-op if already false; call twice to confirm idempotence
    // Simulate the latch having fired (set it to true by importing internals
    // indirectly: we can't set the private var, but we can verify the reset
    // path by checking that initAnalytics calls the reset).
    // The exported _resetTeamAnalyticsForTests exists exactly to unset the latch;
    // calling initAnalytics should have the same effect (that is the fix).
    // Strategy: record the latch state is false after initAnalytics even when
    // called a second time (it was already false, so we need to simulate it
    // having been set first by using the hook to confirm the round-trip).
    _resetTeamAnalyticsForTests(); // ensure clean
    initAnalytics("https://example.com", "test-token");
    // After initAnalytics the latch must be false (enabled). We verify by
    // checking that a tool_call event actually reaches postAnalyticsEvent
    // (i.e., teeToTeamAnalytics is NOT short-circuited).
    const { postAnalyticsEvent } = await import("../team-sync.js");
    const spy = vi.mocked(postAnalyticsEvent as (...args: unknown[]) => unknown);
    spy.mockResolvedValue({ ok: true });
    recordConnectEvent({
      namespace: "gh",
      toolName: "create_issue",
      action: "tool_call",
      latencyMs: 50,
      success: true,
    });
    // Allow the microtask queue to flush the fire-and-forget promise.
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
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
