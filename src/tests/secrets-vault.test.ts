import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptEntry, deriveKey, type EncryptedEntry, encryptEntry, generateSalt } from "../secrets-crypto.js";
import {
  getSecret,
  hasSecretRefs,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  resolveSecretRefs,
  rotateVault,
  SECRET_REF_RE,
  saveVault,
  setSecret,
  unlock,
  VAULT_CHECK_PLAINTEXT,
  type VaultFile,
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

  it("unlock with wrong passphrase throws before caching the key", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // setSecret stamps vault.check, so a wrong passphrase is detected at
    // unlock time (no longer a silent bad-key derivation).
    await expect(unlock(vault, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("inherited Object.prototype members are not vault entries", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // `"toString" in entries` is true for every JSON-parsed vault -- own-key
    // checks are what stop `secrets get toString` from finding an "entry".
    expect(getSecret(vault, key, "toString")).toBeNull();
    expect(removeSecret(vault, "constructor")).toBe(vault);
    const { resolved, missing } = resolveSecretRefs({ X: "${secret:toString}" }, vault, key);
    expect(resolved.X).toBe("${secret:toString}");
    expect(missing).toEqual(["toString"]);
  });

  it("unlock rejects a wrong passphrase even when a key is already cached for this vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // NOTE: no lock() here -- the key is still cached under this salt, which
    // is exactly the long-lived-process case. The cache hit must not hand
    // the key back for a passphrase that never unlocked this vault.
    await expect(unlock(vault, "hunter3")).rejects.toThrow(/wrong passphrase/i);
    // ...and the correct passphrase still resolves from cache.
    await expect(unlock(vault, "hunter2")).resolves.toBeInstanceOf(Buffer);
  });

  it("setSecret rejects a name no ${secret:NAME} reference could address", async () => {
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    for (const bad of ["has space", "a:b", "a{b}", "a/b", "a$b"]) {
      expect(() => setSecret(vault, key, bad, "v")).toThrow(/invalid secret name/i);
    }
    // The reference-safe character class is accepted.
    expect(listKeys(setSecret(vault, key, "GH_token.v2-1", "v"))).toEqual(["GH_token.v2-1"]);
  });

  it("setSecret stamps a vault.check verification token", async () => {
    let vault = newVault();
    expect(vault.check).toBeUndefined();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    expect(vault.check).toBeDefined();
    // The check decrypts to the fixed constant under the correct key.
    expect(decryptEntry(vault.check as EncryptedEntry, key)).toBe(VAULT_CHECK_PLAINTEXT);
  });

  it("unlock on a fresh/empty vault accepts any passphrase (nothing to verify)", async () => {
    const vault = newVault();
    // No entries, no check -- unlock cannot verify, so it must not throw.
    await expect(unlock(vault, "anything")).resolves.toBeInstanceOf(Buffer);
  });

  it("legacy vault (entries, no check) verifies via first-entry canary", async () => {
    // Build a vault, then strip its check to simulate a pre-check vault.
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const legacy = { version: vault.version, salt: vault.salt, entries: vault.entries };
    lock();
    // Correct passphrase: canary decrypts -> resolves.
    await expect(unlock(legacy, "hunter2")).resolves.toBeInstanceOf(Buffer);
    lock();
    // Wrong passphrase: canary fails -> throws.
    await expect(unlock(legacy, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("loadVault rejects a vault with a malformed entry", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const corrupt = {
      version: 1,
      salt: generateSalt().toString("base64"),
      entries: { bad: { iv: "x", ciphertext: 123, authTag: "y" } },
    };
    writeFileSync(path, `${JSON.stringify(corrupt)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/vault corrupt at entry bad/);
  });

  it("loadVault preserves a valid check field round-trip", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    await saveVault(path, vault);
    lock();
    const loaded = await loadVault(path);
    expect(loaded?.check).toBeDefined();
    // Wrong passphrase against the loaded vault is rejected via check.
    await expect(unlock(loaded as VaultFile, "wrongpass")).rejects.toThrow(/wrong passphrase/i);
  });

  it("vaultPath places secrets.json under ~/.yaw-mcp/", () => {
    expect(vaultPath("/home/jeff")).toMatch(/[/\\]\.yaw-mcp[/\\]secrets\.json$/);
  });
});

describe("SECRET_REF_RE is exported and matches ${secret:NAME}", () => {
  it("captures the name", () => {
    // Fresh regex use to avoid lastIndex carryover from the global flag.
    const m = [...`x ${"${secret:gh}"} y`.matchAll(SECRET_REF_RE)];
    expect(m[0][1]).toBe("gh");
  });
});

describe("rotateVault", () => {
  it("re-encrypts every entry: old passphrase fails post-rotate, new one decrypts", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");
    vault = setSecret(vault, oldKey, "aws", "aws_xyz");
    const oldSalt = vault.salt;

    // Sanity: old key decrypts pre-rotate.
    expect(getSecret(vault, oldKey, "github")).toBe("ghp_abc");

    const rotated = await rotateVault(vault, oldKey, "new-passphrase");

    // Salt changed -> fresh derivation lineage.
    expect(rotated.salt).not.toBe(oldSalt);
    expect(listKeys(rotated)).toEqual(["aws", "github"]);
    expect(rotated.check).toBeDefined();

    // The OLD key must NOT decrypt the rotated entries.
    expect(() => getSecret(rotated, oldKey, "github")).toThrow();

    // The NEW passphrase decrypts post-rotate, values intact.
    lock();
    const newKey = await unlock(rotated, "new-passphrase");
    expect(getSecret(rotated, newKey, "github")).toBe("ghp_abc");
    expect(getSecret(rotated, newKey, "aws")).toBe("aws_xyz");

    // The new check marker verifies under the new key, and a wrong
    // passphrase is rejected at unlock.
    expect(decryptEntry(rotated.check as EncryptedEntry, newKey)).toBe(VAULT_CHECK_PLAINTEXT);
    lock();
    await expect(unlock(rotated, "old-passphrase")).rejects.toThrow(/wrong passphrase/i);
  });

  it("aborts when an entry fails to decrypt, leaving the input vault untouched", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");

    // Corrupt one entry's ciphertext so decrypt-all fails.
    const corrupted: VaultFile = {
      ...vault,
      entries: {
        ...vault.entries,
        github: { ...vault.entries.github, ciphertext: Buffer.from("tampered").toString("base64") },
      },
    };
    const snapshot = JSON.stringify(corrupted);

    await expect(rotateVault(corrupted, oldKey, "new-passphrase")).rejects.toThrow(/failed to decrypt/i);
    // The input vault object is not mutated by the abort.
    expect(JSON.stringify(corrupted)).toBe(snapshot);
  });

  it("aborts when the current key is wrong (check marker fails), nothing re-encrypted", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");
    const snapshot = JSON.stringify(vault);

    // Derive a DIFFERENT key (wrong passphrase) against the same salt.
    const wrongKey = await deriveKey("not-the-passphrase", Buffer.from(vault.salt, "base64"));
    await expect(rotateVault(vault, wrongKey, "new-passphrase")).rejects.toThrow(/current passphrase is wrong/i);
    expect(JSON.stringify(vault)).toBe(snapshot);
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
