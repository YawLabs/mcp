// loadState's read-error split, driven by an injected errno so every case
// runs identically on every platform.
//
// Lives in its own file because it mocks node:fs/promises module-wide; the
// sibling persistence.test.ts exercises the real fs and must not inherit
// the intercept. The real-fs cases over there (a directory at the path, a
// file-blocked path component) are platform-shaped: win32 reports the
// blocked component as ENOENT while POSIX says ENOTDIR, so on this repo's
// win32-only local gate the ENOTDIR carve-out was never actually reached.
// The mock pins each errno by name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { emptyState, loadState } from "../persistence.js";

const PATH = "/nonexistent/for-mock/state.json";

beforeEach(() => {
  failNextRead.code = null;
});

afterEach(() => {
  failNextRead.code = null;
});

describe("persistence.loadState -- read errno split", () => {
  it("ENOENT: empty state, no loadFailed", async () => {
    failNextRead.code = "ENOENT";
    const s = await loadState(PATH);
    expect(s).toEqual(emptyState());
    expect(s.loadFailed).toBeUndefined();
  });

  it("ENOTDIR: empty state, no loadFailed (the file cannot exist, nothing to protect)", async () => {
    failNextRead.code = "ENOTDIR";
    const s = await loadState(PATH);
    expect(s).toEqual(emptyState());
    expect(s.loadFailed).toBeUndefined();
  });

  it.each([
    "EACCES",
    "EBUSY",
    "EISDIR",
    "EIO",
  ])("%s: empty state WITH loadFailed (presumed-healthy file)", async (code) => {
    failNextRead.code = code;
    const s = await loadState(PATH);
    expect(s.loadFailed).toBe(true);
    expect(s.learning).toEqual({});
    expect(s.packHistory).toEqual([]);
    expect(s.toolCache).toEqual({});
  });
});
