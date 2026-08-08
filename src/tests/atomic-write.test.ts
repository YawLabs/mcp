import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../atomic-write.js";

describe("atomicWriteFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes contents to a fresh path", async () => {
    const file = join(dir, "fresh.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("creates parent directories recursively", async () => {
    const file = join(dir, "nested", "deeper", "file.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("replaces an existing file in place", async () => {
    const file = join(dir, "existing.json");
    writeFileSync(file, '{"old":true}', "utf8");
    await atomicWriteFile(file, '{"new":true}');
    expect(readFileSync(file, "utf8")).toBe('{"new":true}');
  });

  // POSIX-only: Windows ignores the creation mode and reports 0o666.
  it.skipIf(process.platform === "win32")("honors the mode option so the file is born owner-only (0600)", async () => {
    const file = join(dir, "secret.json");
    await atomicWriteFile(file, '{"token":"x"}', "utf8", 0o600);
    expect(readFileSync(file, "utf8")).toBe('{"token":"x"}');
    // Mask to the permission bits; umask may only clear bits, never add, so
    // 0o600 stays 0o600 under any normal umask.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // POSIX-only: Windows ignores the creation mode and reports 0o666.
  it.skipIf(process.platform === "win32")(
    "carries an existing target's mode onto the replacement inode when no mode is passed",
    async () => {
      // rename() publishes a NEW inode, so without preservation the surviving
      // file is born at the umask default (~0644) and every overwrite silently
      // widens a config the user (or an earlier secret-bearing write) tightened
      // to owner-only. ~/.claude.json holds OAuth tokens and inline MCP env.
      const file = join(dir, "tightened.json");
      writeFileSync(file, '{"token":"x"}', { encoding: "utf8", mode: 0o600 });
      await atomicWriteFile(file, '{"token":"y"}');
      expect(readFileSync(file, "utf8")).toBe('{"token":"y"}');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  // POSIX-only for the same reason as above.
  it.skipIf(process.platform === "win32")("an explicit mode still wins over the target's existing mode", async () => {
    // Preservation must not block a caller that TIGHTENS on purpose: `yaw-mcp
    // try` passes 0o600 precisely because the write it is doing is what puts a
    // plaintext credential in the file.
    const file = join(dir, "was-open.json");
    writeFileSync(file, "{}", { encoding: "utf8", mode: 0o644 });
    await atomicWriteFile(file, '{"token":"x"}', "utf8", 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("gives concurrent same-path writes distinct tmp files instead of one shared one", async () => {
    // pid+ms alone is not unique WITHIN a process: two overlapping calls in the
    // same millisecond shared a tmp path, and writeFile opens with 'w', so
    // A.truncate -> B.truncate -> A.rename published a torn/zero-byte target
    // and the loser's rename threw. appendAuditEvent -> trimToTailCap reaches
    // this unserialized, once per secret.
    const file = join(dir, "concurrent.json");
    const payloads = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"];
    // allSettled, not all: on Windows several MoveFileEx calls racing for one
    // destination can still EPERM, which is a platform property of the rename
    // and not what this test is about. What must hold everywhere is that no
    // call ever observes another's half-written buffer.
    const results = await Promise.allSettled(payloads.map((p) => atomicWriteFile(file, p)));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // Last writer wins (that part is the caller's problem) but the surviving
    // file must be exactly ONE COMPLETE payload -- never empty, never spliced.
    expect(payloads).toContain(readFileSync(file, "utf8"));
    // And no tmp file was orphaned by a rename whose source vanished.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("leaves no orphan .tmp- siblings on success", async () => {
    const file = join(dir, "clean.json");
    await atomicWriteFile(file, "ok");
    const siblings = readdirSync(dir);
    expect(siblings).toEqual(["clean.json"]);
  });

  // POSIX-only: Windows chmod is a no-op; the mode bits are not meaningful there.
  it.skipIf(process.platform === "win32")(
    "with dirMode creates parent directories with the specified mode on POSIX",
    async () => {
      const file = join(dir, "secret-dir", "deeper", "vault.json");
      await atomicWriteFile(file, '{"s":1}', "utf8", undefined, 0o700);
      expect(readFileSync(file, "utf8")).toBe('{"s":1}');
      // Both newly-created parent directories should have mode 0o700.
      expect(statSync(join(dir, "secret-dir")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "secret-dir", "deeper")).mode & 0o777).toBe(0o700);
    },
  );

  it("leaves the original file untouched and rethrows when the parent path is a regular file", async () => {
    // Mechanism: mkdir(parent, {recursive:true}) THROWS EEXIST when
    // `parent` already exists as a REGULAR FILE -- recursive:true only
    // swallows EEXIST when the existing entry is a directory. So the
    // failure happens in mkdirpWithMode, BEFORE the try block that writes
    // the tmp file; nothing is created and there is nothing to clean up.
    // The cleanup path itself is covered by the rename test below.
    const blockingParent = join(dir, "block.txt");
    writeFileSync(blockingParent, "do not touch", "utf8");
    const target = join(blockingParent, "child.json"); // parent is a file, not a dir

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // Original blocking file is untouched.
    expect(readFileSync(blockingParent, "utf8")).toBe("do not touch");
    // child.json was never created.
    expect(existsSync(target)).toBe(false);
    // The directory holds exactly the blocker -- no partial artifacts.
    expect(readdirSync(dir)).toEqual(["block.txt"]);
  });

  it("unlinks the tmp file and rethrows when the rename fails", async () => {
    // This is the case the catch-block cleanup actually exists for: the
    // parent dir resolves fine, the tmp file IS written, and rename(tmp,
    // target) then fails because a non-empty directory sits at the target
    // path (EPERM on Windows, EISDIR/ENOTEMPTY on POSIX). If the unlink in
    // the catch were dropped, the .tmp- sibling would survive -- so the
    // orphan assertion below is load-bearing here, unlike in the
    // parent-is-a-file case above where no tmp is ever created.
    const target = join(dir, "target-is-a-dir");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep", "utf8");

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // The directory and its contents survive.
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    // And the tmp file the failed write left behind was cleaned up.
    const orphans = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(orphans).toEqual([]);
  });
});
