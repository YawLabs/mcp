// reset-learning's ONLY non-zero exit: the unlink failed with something
// other than ENOENT, so a state file the user asked to clear is still there.
//
// Lives in its own file because it mocks node:fs/promises module-wide: the
// sibling reset-learning-cmd.test.ts exercises the real fs (its ENOENT and
// happy paths depend on real unlink semantics) and must not inherit the
// intercept. A real EACCES unlink is not portably reproducible -- win32 and
// POSIX disagree about whether a read-only file or a locked handle blocks
// the delete, and a test running as root ignores the permission bits
// entirely -- so the errno is injected by name instead.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted errno the mock throws on the NEXT unlink; one-shot so nothing
// else in the run inherits a poisoned fs.
const failNextUnlink = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    unlink: (async (...args: Parameters<typeof real.unlink>) => {
      const code = failNextUnlink.code;
      if (code) {
        failNextUnlink.code = null;
        const err = new Error(`${code}: injected`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return real.unlink(...args);
    }) as typeof real.unlink,
  };
});

import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";
import { runResetLearning } from "../reset-learning-cmd.js";

let home: string;
let stateFile: string;

beforeEach(() => {
  failNextUnlink.code = null;
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-reset-unlink-"));
  const yawMcpDir = join(home, CONFIG_DIRNAME);
  mkdirSync(yawMcpDir, { recursive: true });
  stateFile = join(yawMcpDir, STATE_FILENAME);
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: STATE_SCHEMA_VERSION,
      savedAt: 1,
      learning: { gh: { dispatched: 10, succeeded: 4, lastUsedAt: 100 } },
      packHistory: [],
      toolCache: {},
    }),
    "utf8",
  );
});

afterEach(() => {
  failNextUnlink.code = null;
  rmSync(home, { recursive: true, force: true });
});

describe("runResetLearning -- unlink fails with a non-ENOENT errno", () => {
  it("exits 1, names the path on stderr, and leaves the file in place", async () => {
    const out: string[] = [];
    const err: string[] = [];
    failNextUnlink.code = "EACCES";

    const r = await runResetLearning({
      home,
      env: {},
      out: (s) => {
        out.push(s);
      },
      err: (s) => {
        err.push(s);
      },
    });

    expect(r.exitCode).toBe(1);
    expect(r.removed).toBe(false);
    expect(r.path).toBe(stateFile);
    // The failure goes to stderr and names the file, so the user can fix the
    // permission and re-run instead of guessing which path was refused.
    const combinedErr = err.join("\n");
    expect(combinedErr).toContain("failed to remove");
    expect(combinedErr).toContain(stateFile);
    expect(combinedErr).toContain("EACCES");
    // Nothing on stdout: a failed reset must not print any part of the
    // success report (counts, or the running-serve restart advice for a
    // reset that did not happen).
    expect(out).toEqual([]);
    // And the state file survives -- the command reports failure rather than
    // half-clearing anything.
    expect(existsSync(stateFile)).toBe(true);
  });

  it("recovers on the next run once the failure clears", async () => {
    const io: string[] = [];
    failNextUnlink.code = "EACCES";
    const failed = await runResetLearning({ home, env: {}, out: () => {}, err: () => {} });
    expect(failed.exitCode).toBe(1);

    const ok = await runResetLearning({
      home,
      env: {},
      out: (s) => {
        io.push(s);
      },
      err: () => {},
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    expect(io.join("")).toContain("learning entries removed:     1");
  });
});
