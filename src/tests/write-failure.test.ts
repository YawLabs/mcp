// describeWriteFailure / describeFileInTheWay (src/write-failure.ts): the one
// wording for a config file yaw-mcp could not write.
//
// Most of this file hands the helper SYNTHETIC errno objects, shaped the way
// node shapes them (code, syscall, path, dest, and a message naming the call),
// and a fake disk through the `statPath` seam -- so both platforms' branches
// run on either runner, and no test depends on what this machine lets a user
// make read-only. The shapes are the measured ones (Windows 11, Node 22.22.2):
// a read-only config.toml fails the publish RENAME with EPERM naming the temp
// sibling, and CODEX_HOME set to a regular file fails mkdir with EEXIST (the
// directory itself) or ENOTDIR (one below it). The last describe runs the
// default seam against a real file on disk; the install-level tests over a
// real read-only file and a real CODEX_HOME file are in
// target-codex-cli.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFileInTheWay, describeWriteFailure, type WriteFailurePathState } from "../write-failure.js";

/** An errno the way node builds one: the code, the call, the path it was
 *  handed (and the rename's destination), and a message naming all three. */
function errnoOf(code: string, syscall: string, path?: string, dest?: string): NodeJS.ErrnoException {
  const where = path === undefined ? "" : ` '${path}'${dest === undefined ? "" : ` -> '${dest}'`}`;
  // `dest` is on node's rename errors but not on the ErrnoException type.
  const e = new Error(`${code}: synthetic, ${syscall}${where}`) as NodeJS.ErrnoException & { dest?: string };
  e.code = code;
  e.syscall = syscall;
  if (path !== undefined) e.path = path;
  if (dest !== undefined) e.dest = dest;
  return e;
}

/** A fake disk: the paths listed exist in the state given, nothing else does. */
function diskWith(entries: Record<string, WriteFailurePathState>): (path: string) => WriteFailurePathState | null {
  return (path) => entries[path] ?? null;
}

const FILE_STATE: WriteFailurePathState = { directory: false, readOnly: false };
const READ_ONLY_FILE: WriteFailurePathState = { directory: false, readOnly: true };
const DIRECTORY: WriteFailurePathState = { directory: true, readOnly: false };

describe("describeWriteFailure on Windows", () => {
  const DIR = "C:\\Users\\u\\.codex";
  const FILE = `${DIR}\\config.toml`;
  /** atomicWriteFile's temp sibling -- the file node's message names. */
  const TMP = `${FILE}.tmp-36712-1790344914194-1`;

  it("a read-only file is named as read-only, never by its temp sibling, with how to clear the attribute", () => {
    // attrib +R: the publish rename fails EPERM, and the message node gives
    // names the temp file and says nothing about what to do.
    const out = describeWriteFailure(FILE, errnoOf("EPERM", "rename", TMP, FILE), {
      platform: "win32",
      statPath: diskWith({ [FILE]: READ_ONLY_FILE, [DIR]: DIRECTORY }),
    });
    expect(out).toBe(
      `failed to write ${FILE}: it is read-only -- clear its read-only attribute (\`attrib -R "${FILE}"\`), then re-run`,
    );
    expect(out).not.toContain(".tmp-");
  });

  it("a writable file whose replace was refused is one another program may be holding", () => {
    // Not read-only, and the rename still failed after atomic-write's
    // retries: an editor, a sync client or a scanner holding it, or an ACL.
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const out = describeWriteFailure(FILE, errnoOf(code, "rename", TMP, FILE), {
        platform: "win32",
        statPath: diskWith({ [FILE]: FILE_STATE, [DIR]: DIRECTORY }),
      });
      expect(out, code).toBe(
        `failed to write ${FILE}: another program may be holding it open, or your account may not replace it (${code}) -- ` +
          "close whatever has it open (an editor, a sync client, a virus scanner) or fix its permissions, then re-run",
      );
    }
  });

  it("a directory that will not take the temp file is named, not the file", () => {
    // The temp sibling's CREATE failed: nothing about the file itself.
    const out = describeWriteFailure(FILE, errnoOf("EPERM", "open", TMP), {
      platform: "win32",
      statPath: diskWith({ [DIR]: DIRECTORY }),
    });
    expect(out).toBe(
      `failed to write ${FILE}: your account may not create or replace files in ${DIR} (EPERM) -- fix that directory's permissions, then re-run`,
    );
  });

  it("a regular file where the directory has to be is named: EEXIST from mkdir, and ENOTDIR from below it", () => {
    const afile = "C:\\h\\afile";
    const disk = diskWith({ [afile]: FILE_STATE, "C:\\h": DIRECTORY });
    expect(
      describeWriteFailure(`${afile}\\config.toml`, errnoOf("EEXIST", "mkdir", afile), {
        platform: "win32",
        statPath: disk,
      }),
    ).toBe(
      `failed to write ${afile}\\config.toml: ${afile} is a file, not a directory -- move or rename it, then re-run`,
    );
    // One level deeper, reported at the directory mkdir was asked for (the
    // POSIX shape): the file in the way is found on disk, not in the errno.
    expect(
      describeWriteFailure(`${afile}\\sub\\config.toml`, errnoOf("ENOTDIR", "mkdir", `${afile}\\sub`), {
        platform: "win32",
        statPath: disk,
      }),
    ).toBe(
      `failed to write ${afile}\\sub\\config.toml: ${afile} is a file, not a directory -- move or rename it, then re-run`,
    );
  });

  it("names the variable that put the path under the file, when the caller says one did", () => {
    const afile = "C:\\h\\afile";
    const disk = diskWith({ [afile]: FILE_STATE, "C:\\h": DIRECTORY });
    const expected =
      `failed to write ${afile}\\config.toml: ${afile} is a file, not a directory, and CODEX_HOME (set to ${afile}) ` +
      "puts config.toml under it -- point CODEX_HOME at a directory, then re-run";
    expect(
      describeWriteFailure(`${afile}\\config.toml`, errnoOf("EEXIST", "mkdir", afile), {
        platform: "win32",
        statPath: disk,
        env: { name: "CODEX_HOME", value: afile },
      }),
    ).toBe(expected);
    // Windows paths compare case-folded: the value as the user typed it.
    expect(
      describeWriteFailure(`${afile}\\config.toml`, errnoOf("EEXIST", "mkdir", afile), {
        platform: "win32",
        statPath: disk,
        env: { name: "CODEX_HOME", value: "c:\\H\\AFILE" },
      }),
    ).toContain("CODEX_HOME (set to c:\\H\\AFILE) puts config.toml under it");
    // A file in the way BELOW the variable's directory is not the variable's
    // fault: pointing it elsewhere is not the step, so it is not named.
    const zed = "C:\\h\\xdg\\zed";
    expect(
      describeWriteFailure(`${zed}\\settings.json`, errnoOf("EEXIST", "mkdir", zed), {
        platform: "win32",
        statPath: diskWith({ [zed]: FILE_STATE, "C:\\h\\xdg": DIRECTORY }),
        env: { name: "XDG_CONFIG_HOME", value: "C:\\h\\xdg" },
      }),
    ).toBe(
      `failed to write ${zed}\\settings.json: ${zed} is a file, not a directory -- move or rename it, then re-run`,
    );
  });

  it("an unrecognised errno keeps node's message after the real file; a directory the variable names that mkdir could not make names the variable", () => {
    // An invalid character in CODEX_HOME: mkdir answers a bare ENOENT.
    const bad = "C:\\h\\bad|name";
    const err = errnoOf("ENOENT", "mkdir", bad);
    expect(describeWriteFailure(`${bad}\\config.toml`, err, { platform: "win32", statPath: diskWith({}) })).toBe(
      `failed to write ${bad}\\config.toml: ${err.message}`,
    );
    expect(
      describeWriteFailure(`${bad}\\config.toml`, err, {
        platform: "win32",
        statPath: diskWith({}),
        env: { name: "CODEX_HOME", value: bad },
      }),
    ).toBe(
      `failed to write ${bad}\\config.toml: ${err.message} -- CODEX_HOME is set to ${bad}; ` +
        "check that it names a directory that can be created, then re-run",
    );
  });
});

describe("describeWriteFailure on POSIX", () => {
  const DIR = "/home/u/.codex";
  const FILE = `${DIR}/config.toml`;
  const TMP = `${FILE}.tmp-4242-1790344914194-1`;

  it("a refused rename is the DIRECTORY's permissions, even over a read-only file: rename(2) does not ask the file", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const out = describeWriteFailure(FILE, errnoOf(code, "rename", TMP, FILE), {
        platform: "linux",
        statPath: diskWith({ [FILE]: READ_ONLY_FILE, [DIR]: DIRECTORY }),
      });
      expect(out, code).toBe(
        `failed to write ${FILE}: your account may not create or replace files in ${DIR} (${code}) -- fix that directory's permissions, then re-run`,
      );
    }
  });

  it("a read-only file is named as read-only when the failed call opened the file itself", () => {
    // A write in place (not atomicWriteFile's rename) of a mode-0444 file.
    const out = describeWriteFailure(FILE, errnoOf("EACCES", "open", FILE), {
      platform: "linux",
      statPath: diskWith({ [FILE]: READ_ONLY_FILE, [DIR]: DIRECTORY }),
    });
    expect(out).toBe(
      `failed to write ${FILE}: it is read-only -- make it writable (\`chmod u+w "${FILE}"\`), then re-run`,
    );
  });

  it("an ENOTDIR from any call is walked to the file in the way", () => {
    const afile = "/home/u/afile";
    const out = describeWriteFailure(`${afile}/config.toml`, errnoOf("ENOTDIR", "open", `${afile}/config.toml`), {
      platform: "linux",
      statPath: diskWith({ [afile]: FILE_STATE, "/home/u": DIRECTORY }),
      env: { name: "CODEX_HOME", value: afile },
    });
    expect(out).toBe(
      `failed to write ${afile}/config.toml: ${afile} is a file, not a directory, and CODEX_HOME (set to ${afile}) ` +
        "puts config.toml under it -- point CODEX_HOME at a directory, then re-run",
    );
  });

  it("anything else is node's own message, after the real file -- a thrown non-Error too", () => {
    const full = errnoOf("ENOSPC", "write");
    expect(describeWriteFailure(FILE, full, { platform: "linux", statPath: diskWith({}) })).toBe(
      `failed to write ${FILE}: ${full.message}`,
    );
    expect(describeWriteFailure(FILE, "boom", { platform: "linux", statPath: diskWith({}) })).toBe(
      `failed to write ${FILE}: boom`,
    );
    // EBUSY on POSIX (a mount point) is not claimed to be anything it is not.
    const busy = errnoOf("EBUSY", "rename", TMP, FILE);
    expect(describeWriteFailure(FILE, busy, { platform: "linux", statPath: diskWith({ [FILE]: FILE_STATE }) })).toBe(
      `failed to write ${FILE}: ${busy.message}`,
    );
  });
});

describe("describeFileInTheWay over the real disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-write-failure-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a regular file above the target with the default stat, and nothing when the path is clear", () => {
    const afile = join(dir, "afile");
    writeFileSync(afile, "x");
    expect(describeFileInTheWay(join(afile, "sub", "config.toml"))).toBe(
      `${afile} is a file, not a directory -- move or rename it, then re-run`,
    );
    mkdirSync(join(dir, "real"));
    expect(describeFileInTheWay(join(dir, "real", "missing", "config.toml"))).toBeNull();
  });

  it("words the error a real recursive mkdir raises under a regular file", async () => {
    // Whatever this platform's mkdir reports (Windows: ENOTDIR at the file;
    // POSIX: ENOTDIR or EEXIST at the path asked for), the clause names the
    // file in the way.
    const afile = join(dir, "afile");
    writeFileSync(afile, "x");
    const err = await mkdir(join(afile, "sub"), { recursive: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(describeWriteFailure(join(afile, "sub", "config.toml"), err)).toBe(
      `failed to write ${join(afile, "sub", "config.toml")}: ${afile} is a file, not a directory -- move or rename it, then re-run`,
    );
  });
});
