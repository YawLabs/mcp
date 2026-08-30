import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KDF,
  decryptEntry,
  deriveKey,
  type EncryptedEntry,
  encryptEntry,
  generateSalt,
} from "../secrets-crypto.js";
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
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  VAULT_CHECK_AAD,
  VAULT_CHECK_CORRUPT_ERROR,
  VAULT_CHECK_PLAINTEXT,
  VaultEntryCorruptError,
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
    expect(v.version).toBe(SECRETS_SCHEMA_VERSION);
    // The scrypt parameters are recorded in the file, not assumed by the
    // reader, so a later cost bump cannot orphan this vault.
    expect(v.kdf).toEqual(DEFAULT_KDF);
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
    expect(decryptEntry(vault.check as EncryptedEntry, key, VAULT_CHECK_AAD)).toBe(VAULT_CHECK_PLAINTEXT);
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

  it("loadVault rejects a vault whose salt does not decode to SALT_LEN bytes", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    // A string salt that decodes to 8 bytes, not 16 -- it would derive the
    // wrong key and fail every decrypt with an opaque auth-tag error.
    const badSalt = { version: 1, salt: Buffer.from("tooshort").toString("base64"), entries: {} };
    writeFileSync(path, `${JSON.stringify(badSalt)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/corrupt: salt/);
  });

  it("loadVault rejects a NEWER schema version but still loads the current one", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const salt = generateSalt().toString("base64");
    // A schema newer than this build understands is refused loudly.
    writeFileSync(path, `${JSON.stringify({ version: 99, salt, entries: {} })}\n`);
    await expect(loadVault(path)).rejects.toThrow(/newer/i);
    // Equal (current) version still loads -- forward reads stay compatible.
    writeFileSync(path, `${JSON.stringify({ version: 1, salt, entries: {} })}\n`);
    await expect(loadVault(path)).resolves.not.toBeNull();
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

  it("a damaged check marker is reported as a corrupt token, not a wrong passphrase", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // Flip the check ciphertext but keep the blob STRUCTURALLY valid (three
    // strings) -- exactly what survives loadVault. The entries are intact.
    const damaged: VaultFile = {
      ...vault,
      check: {
        ...(vault.check as EncryptedEntry),
        ciphertext: Buffer.from("tampered-check-marker").toString("base64"),
      },
    };
    // The right passphrase must NOT be condemned: an entry decrypts, so the
    // marker is the damaged thing and the error has to say so.
    await expect(unlock(damaged, "hunter2")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
    lock();
    // A genuinely wrong passphrase against the same vault is still a wrong
    // passphrase -- nothing at all decrypts.
    await expect(unlock(damaged, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("a legacy vault whose FIRST entry is corrupt still unlocks on a later good one", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "aaa-first", "v1");
    vault = setSecret(vault, key, "zzz-second", "v2");
    lock();
    // No check (pre-check vault) AND the first entry is undecryptable. A
    // first-entry-only canary condemned the correct passphrase here.
    const legacy: VaultFile = {
      version: vault.version,
      salt: vault.salt,
      entries: {
        "aaa-first": {
          ...vault.entries["aaa-first"],
          ciphertext: Buffer.from("tampered").toString("base64"),
        },
        "zzz-second": vault.entries["zzz-second"],
      },
    };
    await expect(unlock(legacy, "hunter2")).resolves.toBeInstanceOf(Buffer);
    lock();
    // Only an ALL-fail is a wrong passphrase.
    await expect(unlock(legacy, "hunter3")).rejects.toThrow(/wrong passphrase/i);
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
    expect(decryptEntry(rotated.check as EncryptedEntry, newKey, VAULT_CHECK_AAD)).toBe(VAULT_CHECK_PLAINTEXT);
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

// ---------------------------------------------------------------------
// Schema v2: the scrypt parameters live IN the file, and every ciphertext
// is bound to the entry name it is stored under.
// ---------------------------------------------------------------------

describe("secrets-vault v2: recorded KDF parameters", () => {
  /** Write a vault file by hand under the given parameters. */
  async function writeVaultWithKdf(params: { N: number; r: number; p: number }): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    const salt = generateSalt();
    const key = await deriveKey("hunter2", salt, params);
    const file = {
      version: 2,
      salt: salt.toString("base64"),
      kdf: params,
      entries: { github: encryptEntry("ghp_abc", key, "github") },
      check: encryptEntry(VAULT_CHECK_PLAINTEXT, key, VAULT_CHECK_AAD),
    };
    writeFileSync(path, `${JSON.stringify(file)}\n`);
    return path;
  }

  it("derives under the vault's OWN cost factor, not this build's default", async () => {
    // N here is deliberately NOT DEFAULT_KDF.N: a reader that assumes the
    // compile-time constant derives a different key and reports a wrong
    // passphrase for a vault whose passphrase is perfectly correct.
    const params = { N: 1 << 14, r: 8, p: 1 };
    expect(params.N).not.toBe(DEFAULT_KDF.N);
    const path = await writeVaultWithKdf(params);
    lock();
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.kdf).toEqual(params);
    const key = await unlock(loaded, "hunter2");
    expect(getSecret(loaded, key, "github")).toBe("ghp_abc");
  });

  it("a saved vault records its parameters on disk", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = vaultPath(synthHome);
    await saveVault(path, vault);
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(path, "utf8")).kdf).toEqual(DEFAULT_KDF);
  });

  it("refuses a vault whose kdf is nonsense rather than falling back to the default", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // N is not a power of two, and a bogus N means a wrong key (or a memory
    // bomb), not something to silently paper over.
    const bad = { version: 2, salt: generateSalt().toString("base64"), kdf: { N: 3, r: 8, p: 1 }, entries: {} };
    writeFileSync(path, `${JSON.stringify(bad)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/invalid kdf/i);
  });

  it("refuses an N/r PAIR whose working set busts the memory bound, not just each field", async () => {
    // The per-field caps (N <= 2^18, r <= 32) are individually satisfiable at
    // values that multiply out to 128 * 2^18 * 32 = 1 GiB -- four times the
    // 256MB the guard documents. Bounding the fields separately is not the
    // same as bounding what they cost together, and scryptCallWithMaxmem
    // hands node a maxmem derived from the same params, so it would not stop
    // the allocation either.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    const bomb = {
      version: 2,
      salt: generateSalt().toString("base64"),
      kdf: { N: 1 << 18, r: 32, p: 1 },
      entries: {},
    };
    writeFileSync(path, `${JSON.stringify(bomb)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/invalid kdf/i);

    // The documented worst case (2^18 at the default r=8 = exactly 256MB) is
    // still accepted, so the bound rejects the bomb without shrinking the
    // headroom the per-field caps were chosen to leave.
    const atCap = {
      version: 2,
      salt: generateSalt().toString("base64"),
      kdf: { N: 1 << 18, r: 8, p: 1 },
      entries: {},
    };
    writeFileSync(path, `${JSON.stringify(atCap)}\n`);
    await expect(loadVault(path)).resolves.toBeDefined();
  });
});

describe("secrets-vault v2: ciphertexts are bound to their entry name", () => {
  it("a blob moved to another entry no longer decrypts", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "PROD", "prod-token");
    vault = setSecret(vault, key, "DEV", "dev-token");
    // Exactly what an attacker with write access to secrets.json does: swap
    // the two ciphertext blobs so the server spawned for PROD gets DEV's
    // token. Both blobs are intact and the key is right.
    const swapped: VaultFile = {
      ...vault,
      entries: { PROD: vault.entries.DEV, DEV: vault.entries.PROD },
    };
    expect(() => getSecret(swapped, key, "PROD")).toThrow();
    expect(() => getSecret(swapped, key, "DEV")).toThrow();
  });

  it("still reads a v1 vault, whose entries were written unbound", async () => {
    const salt = generateSalt();
    const key = await deriveKey("hunter2", salt);
    const legacy: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      entries: { github: encryptEntry("ghp_legacy", key) },
    };
    lock();
    const unlocked = await unlock(legacy, "hunter2");
    expect(getSecret(legacy, unlocked, "github")).toBe("ghp_legacy");
  });

  it("does NOT accept an unbound blob in a v2 vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // A v2 vault carrying an entry written the old way is a downgrade
    // attempt: accepting it would let an attacker strip the binding.
    const downgraded: VaultFile = { ...vault, entries: { github: encryptEntry("ghp_swapped", key) } };
    expect(() => getSecret(downgraded, key, "github")).toThrow();
  });
});

describe("secrets-vault: passphrase normalization", () => {
  // Built from code points, never typed: the two forms are visually identical
  // in an editor, so a literal fixture would silently be the same string.
  const COMPOSED = `caf${String.fromCharCode(0xe9)}-passphrase`;
  const DECOMPOSED = `cafe${String.fromCharCode(0x301)}-passphrase`;

  it("opens a vault created with the composed form using the decomposed one", async () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    let vault = newVault();
    const key = await unlock(vault, COMPOSED);
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // Same passphrase to a human; different UTF-8 bytes. Without NFC the
    // second form reports "wrong passphrase for this vault".
    const reopened = await unlock(vault, DECOMPOSED);
    expect(getSecret(vault, reopened, "github")).toBe("ghp_abc");
  });

  it("still opens a legacy vault keyed on the UN-normalized bytes", async () => {
    // What a vault created before normalization looks like: the key came from
    // the decomposed bytes exactly as typed.
    const salt = generateSalt();
    const legacyKey = await deriveKey(DECOMPOSED, salt, DEFAULT_KDF, false);
    const vault: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      entries: { github: encryptEntry("ghp_legacy", legacyKey) },
    };
    lock();
    const key = await unlock(vault, DECOMPOSED);
    expect(getSecret(vault, key, "github")).toBe("ghp_legacy");
  });

  it("a genuinely wrong passphrase is still rejected", async () => {
    let vault = newVault();
    const key = await unlock(vault, COMPOSED);
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    await expect(unlock(vault, "not-the-passphrase")).rejects.toThrow(/wrong passphrase/i);
  });
});

describe("secrets-vault: the check marker is compared, not merely decrypted", () => {
  it("treats a marker holding the WRONG plaintext as corrupt", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // Decrypts cleanly under the right key, but is not the expected constant.
    // verifyKey used to accept on "it decrypted" alone, so this vault
    // unlocked while rotateVault -- which compares -- refused it.
    const wrongMarker: VaultFile = {
      ...vault,
      check: encryptEntry("some-other-plaintext", key, VAULT_CHECK_AAD),
    };
    lock();
    await expect(unlock(wrongMarker, "hunter2")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
  });
});

describe("secrets-vault: loadVault error shapes", () => {
  it("throws a typed error carrying the corrupt entry NAME, newlines and all", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // A legacy vault could store a name with a newline in it; sniffing the
    // name back out of the message text with /(.+)$/ silently lost it.
    const badName = `BAD${String.fromCharCode(10)}NAME`;
    const corrupt = {
      version: 1,
      salt: generateSalt().toString("base64"),
      entries: { [badName]: { iv: "x", ciphertext: 123, authTag: "y" } },
    };
    writeFileSync(path, `${JSON.stringify(corrupt)}\n`);
    const err = await loadVault(path).catch((e) => e);
    expect(err).toBeInstanceOf(VaultEntryCorruptError);
    expect((err as VaultEntryCorruptError).entryName).toBe(badName);
  });

  it("refuses a vault whose version is a STRING instead of assuming it is current", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // "99" as a string used to sail past the newer-schema guard entirely.
    const bad = { version: "99", salt: generateSalt().toString("base64"), entries: {} };
    writeFileSync(path, `${JSON.stringify(bad)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/"version" must be a number/);
  });
});
