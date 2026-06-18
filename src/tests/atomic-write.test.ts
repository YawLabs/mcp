import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("leaves the original file untouched and rethrows when the rename target is unwritable", async () => {
    // Simulate failure by passing a path whose parent is a regular file --
    // mkdir returns ok (it sees the existing 'parent'), but writeFile/
    // rename can't write through it. The original 'parent' file should
    // remain unchanged and no .tmp orphan should remain in the parent's
    // own directory.
    const blockingParent = join(dir, "block.txt");
    writeFileSync(blockingParent, "do not touch", "utf8");
    const target = join(blockingParent, "child.json"); // parent is a file, not a dir

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // Original blocking file is untouched.
    expect(readFileSync(blockingParent, "utf8")).toBe("do not touch");
    // No leaked tmp file in the test dir.
    const orphans = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(orphans).toEqual([]);
    // child.json was never created.
    expect(existsSync(target)).toBe(false);
  });
});
