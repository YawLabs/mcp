import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Heartbeat reporting — fires on first AI client `initialize`. The
// network path is mocked; we cover the not-initialized no-op, the
// success path's request shape, and the two failure modes mcph swallows
// silently (network error, 404 from older mcp.hosting deploys).
// Mirrors the runtime-detect.test.ts shape one-for-one.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { request } from "undici";
import { initHeartbeat, reportHeartbeat } from "../heartbeat.js";

describe("reportHeartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset module-level state so the next test starts uninitialized.
    initHeartbeat("", "");
  });

  it("does nothing when not initialized", async () => {
    await reportHeartbeat("claude-code", "1.0.0");
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("posts to /api/connect/heartbeat with bearer auth and client info", async () => {
    initHeartbeat("https://mcp.hosting", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await reportHeartbeat("claude-code", "1.2.3");

    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(request).mock.calls[0];
    expect(String(url)).toContain("/api/connect/heartbeat");
    expect((opts as any).method).toBe("POST");
    expect((opts as any).headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse((opts as any).body);
    expect(body.clientName).toBe("claude-code");
    expect(body.clientVersion).toBe("1.2.3");
  });

  it("sends nulls when client info is undefined (some clients omit it)", async () => {
    // Some MCP clients don't populate clientInfo.name or version. The
    // backend tolerates this (falls back to 'unknown'); we pass through
    // whatever we got so backend normalization is the single source of
    // truth for the shape on the wire.
    initHeartbeat("https://mcp.hosting", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await reportHeartbeat(undefined, undefined);

    const body = JSON.parse((vi.mocked(request).mock.calls[0][1] as any).body);
    expect(body.clientName).toBeNull();
    expect(body.clientVersion).toBeNull();
  });

  it("swallows network errors silently (telemetry is never CLI-blocking)", async () => {
    initHeartbeat("https://mcp.hosting", "tok");
    vi.mocked(request).mockRejectedValue(new Error("ECONNRESET"));
    await expect(reportHeartbeat("claude-code", "1.0.0")).resolves.toBeUndefined();
  });

  it("does not throw on 404 (older mcp.hosting deploy without the endpoint)", async () => {
    initHeartbeat("https://mcp.hosting", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 404,
      body: { text: vi.fn().mockResolvedValue("Not Found") },
    } as any);
    await expect(reportHeartbeat("claude-code", "1.0.0")).resolves.toBeUndefined();
  });

  it("does not throw on 5xx (transient backend failures)", async () => {
    initHeartbeat("https://mcp.hosting", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 503,
      body: { text: vi.fn().mockResolvedValue("Service Unavailable") },
    } as any);
    await expect(reportHeartbeat("claude-code", "1.0.0")).resolves.toBeUndefined();
  });

  it("strips a trailing slash from apiUrl before appending the path", async () => {
    // Defends against a misconfigured MCPH_URL that ends with '/' --
    // without the .replace, the request goes to '//api/connect/...'
    // which 404s on Caddy + most proxies.
    initHeartbeat("https://mcp.hosting/", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await reportHeartbeat("claude-code", "1.0.0");

    const [url] = vi.mocked(request).mock.calls[0];
    expect(String(url)).toBe("https://mcp.hosting/api/connect/heartbeat");
  });
});
