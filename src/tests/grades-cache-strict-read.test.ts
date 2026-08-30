// writeGrade's strict read, tested with a read-side-only failure.
//
// Lives in its own file because it mocks node:fs/promises module-wide:
// the sibling grades-cache.test.ts exercises the real fs and must not
// inherit the intercept. The directory-at-the-cache-path case over there
// pins "rejects rather than clobbers", but it does NOT discriminate the
// strict read from the old catch-all: a directory also fails the WRITE
// (rename onto a directory), so pre-fix code rejected too. The real
// clobber scenario is a read that fails while the path stays writable
// (EACCES/EBUSY from an AV/indexer handle) -- under the old
// `catch { return {} }` the write then succeeded and published a
// one-entry file over every other cached grade. Only a mocked read
// failure reproduces that shape on every platform.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted errno the mock throws on the NEXT readFile; one-shot so
// atomicWriteFile and later readers see the real fs.
const failNextRead = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      const code = failNextRead.code;
      if (code) {
        failNextRead.code = null;
        const err = new Error(`${code}: injected`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return real.readFile(...args);
    }) as typeof real.readFile,
  };
});

import type { CachedGrade } from "../grades-cache.js";
import { gradesCachePath, writeGrade } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

const ENTRY_A: CachedGrade = { grade: "A", score: 97.7, gradedAt: "2026-06-11T00:00:00.000Z" };
const ENTRY_B: CachedGrade = { grade: "B", score: 83.0, gradedAt: "2026-06-10T00:00:00.000Z" };

let synthHome: string;

beforeEach(() => {
  failNextRead.code = null;
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-grades-strict-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

describe("writeGrade -- strict read (read fails, path writable)", () => {
  it("rethrows the read error and leaves every existing grade untouched", async () => {
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({ one: ENTRY_A, two: ENTRY_B }, null, 2);
    writeFileSync(join(dir, "grades.json"), original, "utf8");

    failNextRead.code = "EACCES";
    await expect(writeGrade("three", ENTRY_A, synthHome)).rejects.toMatchObject({ code: "EACCES" });

    // The pre-fix catch-all read would have returned {} here and the
    // (perfectly writable) path would now hold ONLY {"three": ...}.
    expect(readFileSync(gradesCachePath(synthHome), "utf8")).toBe(original);
  });

  it("recovers on the next call once the transient failure clears", async () => {
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "grades.json"), JSON.stringify({ one: ENTRY_A }), "utf8");

    failNextRead.code = "EACCES";
    await expect(writeGrade("two", ENTRY_B, synthHome)).rejects.toMatchObject({ code: "EACCES" });

    await writeGrade("two", ENTRY_B, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(parsed.one).toEqual(ENTRY_A);
    expect(parsed.two).toEqual(ENTRY_B);
  });

  it.each(["ENOENT", "ENOTDIR"])("%s on the strict read means 'no cache yet' and the write proceeds", async (code) => {
    // Both errnos prove there is no cache file to preserve, so the strict
    // path must NOT rethrow them -- it starts from {} and creates the file,
    // exactly like the first-ever audit. (Real-fs ENOTDIR is platform-
    // shaped -- win32 reports ENOENT -- so the errno is injected by name.)
    failNextRead.code = code;
    await writeGrade("gh", ENTRY_A, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(parsed.gh).toEqual(ENTRY_A);
  });
});
