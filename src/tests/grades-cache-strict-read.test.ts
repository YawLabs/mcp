// writeGrade under INJECTED fs failures: the strict read (a read-side-only
// failure) and the lock steal (a rename-side-only failure).
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
//
// The same AV/indexer hold is what makes a stale-lock steal's rename fail
// with EPERM on Windows, and Node cannot open a file in a way that blocks
// another rename (libuv always shares delete), so that shape too is only
// reproducible by injection -- see the stale-lock describe.
//
// So is the EPERM an O_EXCL take gets when it lands inside another writer's
// unlink of the lock. The window is the unlink call itself, and a test cannot
// hold it open: libuv deletes with POSIX semantics, so a second open handle on
// the file does not delay the name's removal -- see the last describe.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted errnos the mock throws on the NEXT readFile / the NEXT rename;
// one-shot so atomicWriteFile and later callers see the real fs.
const failNextRead = vi.hoisted(() => ({ code: null as string | null }));
const failNextRename = vi.hoisted(() => ({ code: null as string | null }));
// Fails the NEXT write through a handle `open` returned -- the one window
// where a lock file exists but nothing has claimed it yet.
const failNextHandleWrite = vi.hoisted(() => ({ code: null as string | null }));
// Scripted answers for the lock's O_EXCL take (`open(path, "wx")` -- no other
// open in writeGrade passes that flag). Each take shifts one entry off
// `script`: an errno is thrown, null runs the real open. Once the script is
// empty, `thenAlways` (when set) is thrown on every take. `attempts` counts
// every "wx" open either way.
const exclOpen = vi.hoisted(() => ({
  script: [] as Array<string | null>,
  thenAlways: null as string | null,
  attempts: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const injected = (code: string): NodeJS.ErrnoException => {
    const err = new Error(`${code}: injected`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  };
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      const code = failNextRead.code;
      if (code) {
        failNextRead.code = null;
        throw injected(code);
      }
      return real.readFile(...args);
    }) as typeof real.readFile,
    rename: (async (...args: Parameters<typeof real.rename>) => {
      const code = failNextRename.code;
      if (code) {
        failNextRename.code = null;
        throw injected(code);
      }
      return real.rename(...args);
    }) as typeof real.rename,
    open: (async (...args: Parameters<typeof real.open>) => {
      if (args[1] === "wx") {
        exclOpen.attempts++;
        const code = exclOpen.script.length > 0 ? exclOpen.script.shift() : exclOpen.thenAlways;
        if (code) throw injected(code);
      }
      const handle = await real.open(...args);
      const code = failNextHandleWrite.code;
      if (!code) return handle;
      failNextHandleWrite.code = null;
      // The handle is REAL and the file it created is on disk -- only the
      // write through it fails, which is the exact shape takeLock has to
      // clean up after.
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "writeFile") {
            return async () => {
              throw injected(code);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof real.open,
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
  failNextRename.code = null;
  failNextHandleWrite.code = null;
  exclOpen.script = [];
  exclOpen.thenAlways = null;
  exclOpen.attempts = 0;
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

describe("writeGrade -- the lock file is created but the write through it fails", () => {
  it("removes the half-made lock before rethrowing, so the next audit does not wait out the stale age", async () => {
    // takeLock's O_EXCL open succeeds and THEN the write fails (EIO, a full
    // disk, a handle revoked under it). The throw escapes before
    // withGradesLock's try/finally is entered, so nothing releases the file:
    // pre-fix, a lock nobody ever held sat at the path and the next
    // `yaw-mcp audit` -- which the MCP panel fires per server -- paid the
    // whole stale age before it could steal it.
    failNextHandleWrite.code = "EIO";
    await expect(writeGrade("gh", ENTRY_A, synthHome)).rejects.toMatchObject({ code: "EIO" });

    const lockPath = `${gradesCachePath(synthHome)}.lock`;
    expect(existsSync(lockPath), "a lock nobody holds was left behind").toBe(false);

    // ...and the very next call goes straight through: no wait, no steal.
    await writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 200 });
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("writeGrade -- a stale lock that will not move (steal's rename fails, path held)", () => {
  it("waits the hold out and steals on the next pass instead of failing the write", async () => {
    // An abandoned lock is stolen by rename. On Windows an AV/indexer handle
    // on that file makes the rename EPERM for a beat -- the same transient
    // hold atomicWriteFile retries its publish rename around. Throwing on it
    // refused a write that succeeds one poll later, and audit then reported
    // the grade as computed-but-not-cached (exit 3) over a hold that had
    // already cleared by the time the user read the message.
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const lockPath = `${gradesCachePath(synthHome)}.lock`;
    writeFileSync(lockPath, "dead-process\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    failNextRename.code = "EPERM";
    await writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 5_000 });
    // The steal consumed the injected failure -- not atomicWriteFile's publish
    // rename, which would otherwise have thrown its way out of the write.
    expect(failNextRename.code).toBeNull();
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    // The second pass moved the stale lock and released our own afterwards.
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("writeGrade -- the O_EXCL take fails with a transient win32 errno", () => {
  // On Windows an O_EXCL create that lands inside another writer's unlink of
  // the lock fails EPERM rather than EEXIST (measured -- see
  // isWin32TransientFsError). That is the release of the very lock the take
  // is waiting on, and one poll later the path is free. takeLock used to
  // rethrow it, so the write failed and audit reported the grade as
  // computed-but-not-cached; a release run's test gate died on exactly this,
  // in grades-cache.test.ts's concurrent-writes case.
  //
  // isWin32TransientFsError reads process.platform at call time, so each case
  // pins the platform it is about rather than depending on the runner.
  async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return await fn();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  }
  const lockPath = (): string => `${gradesCachePath(synthHome)}.lock`;

  it("retries an EPERM take on win32 and lands the write", async () => {
    exclOpen.script = ["EPERM"];
    await onPlatform("win32", () => writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 5_000 }));
    expect(exclOpen.attempts).toBe(2);
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("throws the real errno, not a lock timeout, once a win32 EPERM outlasts the transient budget", async () => {
    // A create that fails for a whole second is a directory this process
    // cannot write into, not a release in flight. The deadline here is far
    // past the test timeout, so only the transient budget can end the wait.
    exclOpen.thenAlways = "EPERM";
    const started = Date.now();
    await expect(
      onPlatform("win32", () => writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 120_000 })),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(exclOpen.attempts).toBeGreaterThan(1);
    expect(existsSync(gradesCachePath(synthHome))).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("honours a deadline shorter than the transient budget", async () => {
    // lockWaitMs 0: the first EPERM is already past the deadline, so it is
    // thrown without a single retry.
    exclOpen.thenAlways = "EPERM";
    await expect(
      onPlatform("win32", () => writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 0 })),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(exclOpen.attempts).toBe(1);
  });

  it("restarts the transient budget after a take that answers normally", async () => {
    // Three writers: ours hits EPERM on the first holder's release, then finds
    // a second holder already in (EEXIST) and waits on it for longer than the
    // transient budget, then hits EPERM again on THAT release. The second
    // EPERM starts a new run; charging it to the first one's clock would fail
    // a write that is one poll from landing.
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(lockPath(), "second-holder\n");
    exclOpen.script = ["EPERM"];
    const ours = onPlatform("win32", () => writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 10_000 }));
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(exclOpen.script).toEqual([]);
    exclOpen.script = ["EPERM"];
    rmSync(lockPath());
    await ours;
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("does not retry on POSIX, where the same errno is a real permission failure", async () => {
    exclOpen.script = ["EACCES"];
    await expect(
      onPlatform("linux", () => writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 5_000 })),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(exclOpen.attempts).toBe(1);
  });
});
