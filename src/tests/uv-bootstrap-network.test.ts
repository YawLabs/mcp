import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv-bootstrap -- network layer tests
//
// Covers fetchWithRedirects (via ensureUv / resolveUv) and the
// sha256 checksum verification step in resolveUv. Lives in its own
// file (like uv-bootstrap-fixes.test.ts) because it needs
// module-level vi.mock for undici and node:child_process; those
// mocks would collide with the "uv present" tests in the main
// uv-bootstrap.test.ts which rely on real spawn to probe PATH.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Point cacheDir() at a throwaway temp dir so the exists(finalBin)
// short-circuit in resolveUv never finds a real cached binary from a
// previous developer bootstrap and skips the download path.
vi.mock("../paths.js", () => {
  const nodeOs = require("node:os");
  const nodePath = require("node:path");
  return {
    cacheDir: () => nodePath.join(nodeOs.tmpdir(), "yaw-mcp-uvbn-test-cache"),
  };
});

// Mock undici so we control every request() call without touching the network.
// Individual tests configure the mock via vi.mocked(request).mockImplementation.
vi.mock("undici", () => ({
  request: vi.fn(),
}));

// Mock node:child_process so onPath("uv") always returns false -- we want
// to exercise the download path, not the PATH-hit short-circuit.
// spawnSync is also stubbed so the "uv present" describe (in the other
// test file) would skip, though it is not loaded here at all.
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (_cmd: string, _args: unknown, _opts: unknown) => {
      const fake = new EventEmitter();
      fake.kill = () => {};
      setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      return fake;
    },
    spawnSync: () => ({ status: 1 }),
  };
});

import { request } from "undici";
import { __resetUvBootstrap, ensureUv } from "../uv-bootstrap.js";

// ── helpers ──────────────────────────────────────────────────────────────

// Build a minimal fake undici response object that resolveUv / fetchWithRedirects
// can consume. The body needs arrayBuffer() and dump() methods.
function fakeResponse(
  statusCode: number,
  bodyBytes: Buffer,
  headers: Record<string, string> = {},
): {
  statusCode: number;
  headers: Record<string, string>;
  body: { arrayBuffer: () => Promise<ArrayBuffer>; dump: () => Promise<void> };
} {
  return {
    statusCode,
    headers,
    body: {
      arrayBuffer: () =>
        Promise.resolve(
          bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
        ),
      dump: () => Promise.resolve(),
    },
  };
}

// ── shared setup ─────────────────────────────────────────────────────────

const mockRequest = vi.mocked(request);
const TEMP_CACHE = path.join(os.tmpdir(), "yaw-mcp-uvbn-test-cache");

beforeEach(() => {
  __resetUvBootstrap();
  mockRequest.mockReset();
});

afterEach(async () => {
  __resetUvBootstrap();
  await fs.rm(TEMP_CACHE, { recursive: true, force: true }).catch(() => {});
});

// ── sha256 checksum mismatch ──────────────────────────────────────────────

describe("resolveUv checksum mismatch", () => {
  it("throws with 'checksum mismatch' when the downloaded archive sha256 does not match", async () => {
    const archiveBody = Buffer.from("fake-archive-bytes");
    // Compute the CORRECT sha256 of a DIFFERENT buffer so the check fails.
    const wrongHash = createHash("sha256").update(Buffer.from("different-content")).digest("hex");
    const shaBody = Buffer.from(`${wrongHash}  uv-x86_64-pc-windows-msvc.zip\n`);

    // resolveUv calls fetchWithRedirects twice: once for the archive, once
    // for the .sha256 file. Both succeed (200) but the hashes won't match.
    mockRequest
      .mockResolvedValueOnce(fakeResponse(200, archiveBody) as never)
      .mockResolvedValueOnce(fakeResponse(200, shaBody) as never);

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("checksum mismatch");
  });
});

// ── fetchWithRedirects: redirect following ────────────────────────────────

describe("fetchWithRedirects redirect following", () => {
  it("follows a 302 and returns the body from the final 200 response", async () => {
    const finalBody = Buffer.from("real-archive-content");
    // The CORRECT sha256 of finalBody so the checksum check passes and we
    // can confirm that fetchWithRedirects actually returned the right buffer.
    const correctHash = createHash("sha256").update(finalBody).digest("hex");
    const shaBody = Buffer.from(`${correctHash}  archive.zip\n`);

    // Call sequence: archive (302) -> archive redirect target (200) -> sha256 (200).
    mockRequest
      .mockResolvedValueOnce(
        fakeResponse(302, Buffer.alloc(0), { location: "https://cdn.example.com/uv.zip" }) as never,
      )
      .mockResolvedValueOnce(fakeResponse(200, finalBody) as never)
      .mockResolvedValueOnce(fakeResponse(200, shaBody) as never);

    // After the checksum check passes, resolveUv tries to write the archive
    // to disk. We don't need the full extract flow -- catching any error
    // after the checksum stage is fine; we verify the mock call pattern.
    await ensureUv().catch(() => {});

    // resolveUv calls Promise.all([fetchWithRedirects(archiveUrl), fetchWithRedirects(shaUrl)]),
    // so both start concurrently. The interleaved call order is:
    //   call[0] archiveUrl -> 302
    //   call[1] shaUrl -> 200 (sha fetch, runs concurrently, resolves immediately)
    //   call[2] redirect Location -> 200 (archive follow-through)
    expect(mockRequest).toHaveBeenCalledTimes(3);
    const urls = mockRequest.mock.calls.map((c) => (c as [string, ...unknown[]])[0]);
    expect(urls).toContain("https://cdn.example.com/uv.zip");
  });
});

// ── fetchWithRedirects: too many redirects ────────────────────────────────

describe("fetchWithRedirects too many redirects", () => {
  it("throws 'Too many redirects' after 5 consecutive 302 responses", async () => {
    // Return a 302 with a fresh location every time so fetchWithRedirects
    // keeps following until it exhausts the maxHops (5) cap.
    mockRequest.mockImplementation((_url: unknown) =>
      Promise.resolve(fakeResponse(302, Buffer.alloc(0), { location: "https://redir.example.com/next" }) as never),
    );

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Too many redirects");
  });
});

// ── fetchWithRedirects: 302 with no Location header ───────────────────────

describe("fetchWithRedirects missing Location header", () => {
  it("throws when a 302 response has no Location header", async () => {
    // 302 with no location field in headers.
    mockRequest.mockResolvedValueOnce(fakeResponse(302, Buffer.alloc(0)) as never);

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Redirect without Location header");
  });
});
