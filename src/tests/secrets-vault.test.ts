import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptEntry, deriveKey, encryptEntry, generateSalt } from "../secrets-crypto.js";
import {
  getSecret,
  hasSecretRefs,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  resolveSecretRefs,
  saveVault,
  setSecret,
  unlock,
  vaultPath,
} from "../secrets-vault.js";

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-secrets-"));
  lock();
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  lock();
});

describe("secrets-crypto", () => {
  it("derives the same key from the same passphrase + salt", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter2", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives different keys for different passphrases", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter3", salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives different keys for different salts", async () => {
    const k1 = await deriveKey("hunter2", generateSalt());
    const k2 = await deriveKey("hunter2", generateSalt());
    expect(k1.equals(k2)).toBe(false);
  });

  it("round-trips encrypt/decrypt", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("hello world", key);
    expect(decryptEntry(entry, key)).toBe("hello world");
  });

  it("decrypt fails with wrong key", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter3", salt);
    const entry = encryptEntry("secret", k1);
    expect(() => decryptEntry(entry, k2)).toThrow();
  });

  it("decrypt fails on tampered ciphertext", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("secret", key);
    const tampered = { ...entry, ciphertext: Buffer.from("AAAA", "base64").toString("base64") };
    expect(() => decryptEntry(tampered, key)).toThrow();
  });

  it("decrypt fails on tampered auth tag", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("secret", key);
    const tampered = {
      ...entry,
      authTag: Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64").toString("base64"),
    };
    expect(() => decryptEntry(tampered, key)).toThrow();
  });
});

describe("secrets-vault: set/get/list/remove", () => {
  it("newVault has a salt and empty entries", () => {
    const v = newVault();
    expect(v.salt).toBeTruthy();
    expect(v.entries).toEqual({});
    expect(v.version).toBe(1);
  });

  it("set + get round-trips a single secret", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc123");
    expect(listKeys(vault)).toEqual(["github"]);
    expect(getSecret(vault, key, "github")).toBe("ghp_abc123");
  });

  it("set multiple, list returns sorted names", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_1");
    vault = setSecret(vault, key, "aws", "aws_2");
    vault = setSecret(vault, key, "slack", "xoxb_3");
    expect(listKeys(vault)).toEqual(["aws", "github", "slack"]);
  });

  it("remove deletes an entry", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_1");
    vault = setSecret(vault, key, "aws", "aws_2");
    vault = removeSecret(vault, "github");
    expect(listKeys(vault)).toEqual(["aws"]);
    expect(getSecret(vault, key, "github")).toBeNull();
  });

  it("remove of nonexistent key is a no-op", () => {
    const v = newVault();
    expect(removeSecret(v, "nonesuch")).toEqual(v);
  });

  it("save + load round-trips the vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    await saveVault(path, vault);
    lock();
    const loaded = await loadVault(path);
    expect(loaded).not.toBeNull();
    if (loaded) {
      const k2 = await unlock(loaded, "hunter2");
      expect(getSecret(loaded, k2, "github")).toBe("ghp_abc");
    }
  });

  it("loadVault returns null when no file exists", async () => {
    const v = await loadVault(join(synthHome, "no-such-file.json"));
    expect(v).toBeNull();
  });

  it("unlock with wrong passphrase derives a non-decrypting key", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    const wrongKey = await unlock(vault, "hunter3");
    expect(() => getSecret(vault, wrongKey, "github")).toThrow();
  });

  it("vaultPath places secrets.json under ~/.yaw-mcp/", () => {
    expect(vaultPath("/home/jeff")).toMatch(/[/\\]\.yaw-mcp[/\\]secrets\.json$/);
  });
});

describe("hasSecretRefs + resolveSecretRefs (spawn-time substitution)", () => {
  it("hasSecretRefs detects ${secret:NAME} in env values", () => {
    expect(hasSecretRefs({ FOO: "bar" })).toBe(false);
    expect(hasSecretRefs({ FOO: "${secret:GITHUB}" })).toBe(true);
    expect(hasSecretRefs({ FOO: "Bearer ${secret:TOKEN}" })).toBe(true);
    expect(hasSecretRefs(undefined)).toBe(false);
    expect(hasSecretRefs({})).toBe(false);
  });

  it("resolveSecretRefs substitutes a single ref end-to-end", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc123");
    const { resolved, missing } = resolveSecretRefs({ GITHUB_TOKEN: "${secret:github}" }, vault, key);
    expect(resolved.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(missing).toEqual([]);
  });

  it("resolveSecretRefs preserves surrounding text", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "tok", "abc");
    const { resolved } = resolveSecretRefs({ AUTH: "Bearer ${secret:tok}" }, vault, key);
    expect(resolved.AUTH).toBe("Bearer abc");
  });

  it("resolveSecretRefs reports missing secrets and leaves the literal", async () => {
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    const { resolved, missing } = resolveSecretRefs({ GITHUB_TOKEN: "${secret:nonesuch}" }, vault, key);
    expect(resolved.GITHUB_TOKEN).toBe("${secret:nonesuch}");
    expect(missing).toEqual(["nonesuch"]);
  });

  it("resolveSecretRefs passes through env values without refs", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const { resolved } = resolveSecretRefs({ LITERAL: "no refs here", GITHUB_TOKEN: "${secret:github}" }, vault, key);
    expect(resolved.LITERAL).toBe("no refs here");
    expect(resolved.GITHUB_TOKEN).toBe("ghp_abc");
  });

  it("resolveSecretRefs caches decryption across multiple refs to the same secret", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "x", "value-x");
    const { resolved } = resolveSecretRefs(
      { A: "${secret:x}", B: "prefix-${secret:x}-suffix", C: "${secret:x}" },
      vault,
      key,
    );
    expect(resolved.A).toBe("value-x");
    expect(resolved.B).toBe("prefix-value-x-suffix");
    expect(resolved.C).toBe("value-x");
  });
});
