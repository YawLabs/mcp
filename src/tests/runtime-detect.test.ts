import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Runtime detection — coverage of the small reporting surface. The
// per-binary probe spawns real child processes, which is hard to mock
// portably; we cover the report path (initialized vs not, success vs
// failure) which is where the actual bugs live.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { request } from "undici";
import { initRuntimeDetect, reportRuntimes } from "../runtime-detect.js";

describe("reportRuntimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset module-level state by re-init with empty creds.
    initRuntimeDetect("", "");
  });

  it("does nothing when not initialized", async () => {
    await reportRuntimes();
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("posts to /api/connect/runtimes when initialized", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);

    await reportRuntimes();

    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(request).mock.calls[0];
    expect(String(url)).toContain("/api/connect/runtimes");
    expect((opts as any).method).toBe("POST");
    const body = JSON.parse((opts as any).body);
    expect(body.runtimes).toBeTypeOf("object");
    // node should always be detected — we're running this test on Node,
    // and the probe runs `node --version`.
    expect(body.runtimes.node).toBeTruthy();
  });

  it("swallows network errors silently", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockRejectedValue(new Error("ECONNRESET"));
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });

  it("does not throw on 404 (older mcp.hosting deploy)", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 404,
      body: { text: vi.fn().mockResolvedValue("") },
    } as any);
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });

  it("does not throw on 5xx", async () => {
    initRuntimeDetect("https://yaw.sh/mcp", "tok");
    vi.mocked(request).mockResolvedValue({
      statusCode: 500,
      body: { text: vi.fn().mockResolvedValue("internal error") },
    } as any);
    await expect(reportRuntimes()).resolves.toBeUndefined();
  });
});
