import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv-bootstrap -- extractArchive win32 path-validation tests (coverage gaps 12/13)
//
// extractArchive() is win32-only and reached only through ensureUv() ->
// resolveUv(). It builds a PowerShell `Expand-Archive -Command` string from
// archivePath + destDir, both derived from cacheDir(). Line 198 hard-rejects
// paths containing a CR/LF or a Unicode smart-quote (U+2018/2019/201A/201B);
// line 208 escapes an ASCII apostrophe (' -> '') so a username like O'Brien
// is handled safely rather than rejected.
//
// Both gaps require process.platform === 'win32'. Everything external is
// mocked (spawn, undici, cacheDir), so these run on every platform -- they
// are NOT skipped on this win32 box or on the CI ubuntu/windows legs. We
// stub process.platform/arch via Object.defineProperty (same technique the
// unsupported-platform test in uv-bootstrap-fixes.test.ts uses).
//
// Own file (like the sibling uv-bootstrap-*.test.ts) because it needs a
// module-level vi.mock for node:child_process whose spawn distinguishes the
// onPath("uv") probe (must fail) from the extractArchive powershell.exe call
// (must resolve so we can capture the -Command string), plus a *controllable*
// cacheDir() mock so each test can inject an apostrophe- or smart-quote-bearing
// root. The sibling files' mocks are fixed and would not fit.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// cacheDir() is a vi.fn each test points at an apostrophe- or smart-quote-
// bearing root so the derived archivePath/destDir carry the char under test.
vi.mock("../paths.js", () => ({
  cacheDir: vi.fn(),
}));

// undici.request feeds resolveUv's download: a checksum-matching archive plus
// its .sha256 sidecar, so the checksum gate passes and control reaches
// extractArchive (the SUT for these gaps).
vi.mock("undici", () => ({
  request: vi.fn(),
}));

// spawn mock records every call. The onPath("uv") probe (cmd "uv") emits
// "error" so onPath returns false and resolveUv proceeds to the download +
// extract path. The extractArchive runCommand (cmd "powershell.exe") emits
// "close" 0 so runCommand resolves and we can assert the captured -Command.
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args: [...(args ?? [])], opts: { ...opts } });
      const fake = new EventEmitter();
      fake.kill = () => {};
      fake.stderr = new EventEmitter();
      fake.stdout = new EventEmitter();
      if (cmd === "powershell.exe") {
        // runCommand success: exit 0.
        setImmediate(() => fake.emit("close", 0));
      } else {
        // onPath probe: ENOENT -> onPath returns false.
        setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      }
      return fake;
    },
  };
});

import { request } from "undici";
import { cacheDir } from "../paths.js";
import { __resetUvBootstrap, ensureUv } from "../uv-bootstrap.js";

// ── helpers ──────────────────────────────────────────────────────────────

// Minimal fake undici response: body.arrayBuffer() + body.dump().
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

// Serve a checksum-matching archive for any URL, and the correct sha256
// sidecar for the *.sha256 URL, so resolveUv's checksum gate passes.
function serveGoodArchive(): void {
  const archiveBody = Buffer.from("fake-uv-archive-bytes-for-extract-test");
  const correctHash = createHash("sha256").update(archiveBody).digest("hex");
  const shaBody = Buffer.from(`${correctHash}  uv-x86_64-pc-windows-msvc.zip\n`);
  vi.mocked(request).mockImplementation((url: unknown) =>
    Promise.resolve(
      String(url).endsWith(".sha256")
        ? (fakeResponse(200, shaBody) as never)
        : (fakeResponse(200, archiveBody) as never),
    ),
  );
}

const mockCacheDir = vi.mocked(cacheDir);

// Both fixtures live under os.tmpdir(); afterEach removes them.
const APOSTROPHE_ROOT = path.join(os.tmpdir(), "yaw-mcp-O'Brien-extract-test");
// Smart-quote roots keyed by code point (built at use time to avoid literal
// smart-quote bytes floating in the file header).
function smartRoot(codePoint: number): string {
  return path.join(os.tmpdir(), `yaw-mcp-O${String.fromCharCode(codePoint)}Brien-smart-${codePoint.toString(16)}`);
}

// win32 stub scope. process.platform/arch are read at call time inside
// uv-bootstrap, so defining them before ensureUv() is enough.
let origPlatform: PropertyDescriptor | undefined;
let origArch: PropertyDescriptor | undefined;

function forceWin32(): void {
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  origArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
}

function restorePlatform(): void {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  if (origArch) Object.defineProperty(process, "arch", origArch);
  origPlatform = undefined;
  origArch = undefined;
}

beforeEach(() => {
  spawnCalls.length = 0;
  __resetUvBootstrap();
  mockCacheDir.mockReset();
  vi.mocked(request).mockReset();
});

afterEach(async () => {
  restorePlatform();
  __resetUvBootstrap();
  // resolveUv writes/extracts under cacheDir()/uv/<version>; clean both roots.
  await fs.rm(APOSTROPHE_ROOT, { recursive: true, force: true }).catch(() => {});
  for (const cp of [0x2018, 0x2019, 0x201a, 0x201b]) {
    await fs.rm(smartRoot(cp), { recursive: true, force: true }).catch(() => {});
  }
});

// ── Gap 12: ASCII apostrophe is allowed and reaches Expand-Archive ─────────
describe("extractArchive apostrophe path (gap 12)", () => {
  it("passes validation and calls runCommand with ' -> '' escaped Expand-Archive command", async () => {
    forceWin32();
    mockCacheDir.mockReturnValue(APOSTROPHE_ROOT);
    serveGoodArchive();

    // extractArchive resolves (powershell mock exits 0) but the extracted dir
    // is empty, so resolveUv then throws "uv binary not found" -- that is the
    // expected post-extract failure, NOT a validation rejection. Reaching it
    // proves the apostrophe path cleared the line-198 guard.
    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("uv binary not found");
    expect((err as Error).message).not.toContain("smart quote");

    const psCall = spawnCalls.find((c) => c.cmd === "powershell.exe");
    expect(psCall, "extractArchive should have invoked powershell.exe runCommand").toBeDefined();

    const command = (psCall as NonNullable<typeof psCall>).args.at(-1) as string;
    expect(command.startsWith("Expand-Archive -Path '")).toBe(true);
    // The ASCII apostrophe in "O'Brien" must be doubled to "O''Brien" in BOTH
    // the -Path and -DestinationPath quoted literals.
    expect(command).toContain("O''Brien");
    // And no single (un-doubled) "O'Brien" remains from the path segment.
    expect(command).not.toContain("O'Brien");
    // Sanity: it also carries the DestinationPath + -Force tail.
    expect(command).toContain("-DestinationPath '");
    expect(command).toContain("-Force");
  });
});

// ── Gap 13: Unicode smart-quote is rejected BEFORE runCommand ──────────────
describe("extractArchive smart-quote guard (gap 13)", () => {
  // U+2018 U+2019 U+201A U+201B -- every char the line-198 regex guards.
  it.each([
    0x2018, 0x2019, 0x201a, 0x201b,
  ])("throws 'contains a newline or smart quote' and never spawns powershell for U+%s", async (codePoint) => {
    forceWin32();
    mockCacheDir.mockReturnValue(smartRoot(codePoint));
    serveGoodArchive();

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("contains a newline or smart quote");

    // The guard fires before runCommand, so no powershell.exe spawn happened.
    const psCall = spawnCalls.find((c) => c.cmd === "powershell.exe");
    expect(psCall, "smart-quote path must not reach Expand-Archive").toBeUndefined();
  });
});
