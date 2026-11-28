// Schema v3: the DEK + key-slot layout, recovery codes, re-keying, and the
// v1/v2 -> v3 migration. secrets-vault.test.ts covers v1/v2 behaviour and the
// layout-independent helpers.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRecoveryCode,
  RECOVERY_CODE_FORMAT_ERROR,
  RECOVERY_CODE_TYPO_ERROR,
  RECOVERY_CODE_WRONG_VAULT_ERROR,
} from "../recovery-code.js";
import {
  canonicalJson,
  DEFAULT_KDF,
  decryptEntry,
  deriveKey,
  type EncryptedEntry,
  encryptEntry,
  generateDek,
  generateSalt,
  type KdfParams,
  setDefaultKdfForTesting,
  wrapKey,
} from "../secrets-crypto.js";
import {
  checkVaultPassphrase,
  createVaultV3,
  FIRST_BOUND_SCHEMA_VERSION,
  getSecret,
  isV3Vault,
  listKeys,
  loadVault,
  lock,
  newVault,
  passphraseSlotDigest,
  recoverySlotDigest,
  recoveryStatus,
  rekeyVault,
  removeSecret,
  resolveSecretRefs,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  unlockWithRecoveryCode,
  VAULT_CHECK_CORRUPT_ERROR,
  VAULT_CHECK_PLAINTEXT,
  VAULT_NO_RECOVERY_ERROR,
  VAULT_RECOVERY_SLOT_DAMAGED_ERROR,
  VAULT_SLOT_DAMAGED_ERROR,
  VAULT_WRONG_PASSPHRASE_ERROR,
  type VaultFile,
  type VaultLoadWarning,
  vaultCheckAad,
  vaultEntryAad,
  vaultVerifiesPassphrases,
} from "../secrets-vault.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAST_KDF: KdfParams = { N: 1024, r: 8, p: 1 };
const CODE_RE = /^YAWR(-[0-9A-HJKMNP-TV-Z]{4}){7}$/;

let home: string;
let path: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-v3-"));
  path = join(home, ".yaw-mcp", "secrets.json");
  lock();
  // Fast slots for the suite; the parameters are recorded per slot, so this
  // changes nothing about the format.
  setDefaultKdfForTesting(FAST_KDF);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  lock();
  setDefaultKdfForTesting(null);
  vi.restoreAllMocks();
});

/** A v3 vault under `pass` holding `entries`, with or without a recovery slot. */
async function v3With(
  pass: string,
  entries: Record<string, string>,
  recovery = false,
): Promise<{ vault: VaultFile; code?: string }> {
  const built = await createVaultV3(pass, { recovery });
  let vault = built.vault;
  const dek = await unlock(vault, pass);
  for (const [k, v] of Object.entries(entries)) vault = setSecret(vault, dek, k, v);
  dek.fill(0);
  lock();
  return { vault, code: built.recoveryCode };
}

function writeRaw(obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function slotAadFor(role: string, vaultId: string, extra: Record<string, unknown>): string {
  return canonicalJson({ role, vault_id: vaultId, version: 3, ...extra });
}

describe("createVaultV3: the on-disk shape", () => {
  it("writes version 3, a vault_id, an inert salt, a passphrase slot and a check marker -- no top-level kdf", async () => {
    const { vault, recoveryCode } = await createVaultV3("pass-one", { recovery: false });
    expect(recoveryCode).toBeUndefined();
    expect(vault.version).toBe(3);
    expect(SECRETS_SCHEMA_VERSION).toBe(3);
    expect(Buffer.from(vault.vault_id as string, "base64")).toHaveLength(16);
    expect(Buffer.from(vault.salt, "base64")).toHaveLength(16);
    expect(vault.kdf).toBeUndefined();
    expect(vault.entries).toEqual({});
    expect(vault.check).toBeDefined();
    const slot = vault.keyslots?.passphrase;
    expect(slot?.kdf).toEqual(FAST_KDF);
    expect(Buffer.from(slot?.salt as string, "base64")).toHaveLength(16);
    expect(slot?.digest).toBe(passphraseSlotDigest(vault.vault_id as string, slot as NonNullable<typeof slot>));
    // Independently: SHA-256 over the canonical slot AAD, a NUL, then the
    // wrapped key's iv || ciphertext || authTag.
    const { createHash } = await import("node:crypto");
    const aad = slotAadFor("passphrase", vault.vault_id as string, { kdf: slot?.kdf, salt: slot?.salt });
    const w = slot?.wrapped as EncryptedEntry;
    expect(slot?.digest).toBe(
      createHash("sha256")
        .update(aad, "utf8")
        .update(Buffer.from([0]))
        .update(Buffer.from(w.iv, "base64"))
        .update(Buffer.from(w.ciphertext, "base64"))
        .update(Buffer.from(w.authTag, "base64"))
        .digest("base64"),
    );
    expect(vault.keyslots?.recovery).toBeUndefined();
    // The placeholder salt is NOT the slot salt.
    expect(vault.salt).not.toBe(slot?.salt);
    expect(isV3Vault(vault)).toBe(true);
    expect(vaultVerifiesPassphrases(vault)).toBe(true);
  });

  it("with recovery: returns a YAWR code once and records the slot with its created time", async () => {
    const before = Date.now();
    const { vault, recoveryCode } = await createVaultV3("pass-one", { recovery: true });
    expect(recoveryCode).toMatch(CODE_RE);
    const slot = vault.keyslots?.recovery;
    expect(slot?.kdf).toBe("hkdf-sha256");
    expect(Date.parse(slot?.created as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(recoveryStatus(vault)).toEqual({ state: "set", created: slot?.created });
    // The code is nowhere in the vault object.
    const compact = (recoveryCode as string).replace(/^YAWR-/, "").replace(/-/g, "");
    expect(JSON.stringify(vault)).not.toContain(compact);
  });

  it("round-trips through saveVault/loadVault unchanged, and the file never holds the code", async () => {
    const { vault, code } = await v3With("pass-one", { github: "ghp_x" }, true);
    await saveVault(path, vault);
    const raw = readFileSync(path, "utf8");
    const compact = (code as string).replace(/^YAWR-/, "").replace(/-/g, "");
    expect(raw).not.toContain(compact);
    expect(raw).not.toContain(code as string);
    const loaded = await loadVault(path);
    expect(loaded).toEqual(vault);
    const dek = await unlock(loaded as VaultFile, "pass-one");
    expect(getSecret(loaded as VaultFile, dek, "github")).toBe("ghp_x");
  });

  it("createVaultV3 without recovery: the slot-less vault a rotate-without-recovery produces", async () => {
    const vault = (await createVaultV3("reset-pass", { recovery: false })).vault;
    expect(isV3Vault(vault)).toBe(true);
    expect(recoveryStatus(vault).state).toBe("none");
    await expect(unlock(vault, "something-else")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
    await expect(unlock(vault, "reset-pass")).resolves.toBeInstanceOf(Buffer);
  });
});

describe("v3 unlock verdicts", () => {
  it("right passphrase -> the DEK (a copy); wrong -> VAULT_WRONG_PASSPHRASE_ERROR", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const a = await unlock(vault, "right");
    a.fill(0);
    const b = await unlock(vault, "right"); // cache hit, own copy
    expect(getSecret(vault, b, "github")).toBe("ghp_1");
    lock();
    await expect(unlock(vault, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
    expect(await checkVaultPassphrase(vault, "wrong")).toBe("wrong");
    expect(await checkVaultPassphrase(vault, "right")).toBe("opens");
  });

  it("slot digest mismatch -> VAULT_SLOT_DAMAGED_ERROR, and the unwrap is never attempted", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const slot = vault.keyslots?.passphrase;
    if (!slot) throw new Error("no slot");
    // Damage the wrapped key but keep the old digest: the digest catches it.
    const damagedCt = Buffer.from(slot.wrapped.ciphertext, "base64");
    damagedCt[0] ^= 1;
    const damaged: VaultFile = {
      ...vault,
      keyslots: { passphrase: { ...slot, wrapped: { ...slot.wrapped, ciphertext: damagedCt.toString("base64") } } },
    };
    await expect(unlock(damaged, "right")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    await expect(unlock(damaged, "wrong")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    expect(await checkVaultPassphrase(damaged, "right")).toBe("slot-damaged");
    // A digest that is itself damaged reads the same.
    const badDigest = Buffer.from(slot.digest, "base64");
    badDigest[5] ^= 0x80;
    const damaged2: VaultFile = {
      ...vault,
      keyslots: { passphrase: { ...slot, digest: badDigest.toString("base64") } },
    };
    await expect(unlock(damaged2, "right")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
  });

  it("damage to the slot's salt, kdf or the vault_id reads as slot-damaged, not as a wrong passphrase", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const slot = vault.keyslots?.passphrase;
    if (!slot) throw new Error("no slot");
    // Each edit keeps the field well formed (loadVault would accept it) and
    // keeps the recorded digest: what a bit flip that survives the shape
    // checks looks like.
    const salt = Buffer.from(slot.salt, "base64");
    salt[0] ^= 1;
    const vaultId = Buffer.from(vault.vault_id as string, "base64");
    vaultId[0] ^= 1;
    const cases: Record<string, VaultFile> = {
      salt: { ...vault, keyslots: { passphrase: { ...slot, salt: salt.toString("base64") } } },
      kdf: { ...vault, keyslots: { passphrase: { ...slot, kdf: { ...slot.kdf, N: slot.kdf.N * 2 } } } },
      vault_id: { ...vault, vault_id: vaultId.toString("base64") },
    };
    for (const [field, damaged] of Object.entries(cases)) {
      await expect(unlock(damaged, "right"), field).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
      await expect(unlock(damaged, "wrong"), field).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
      expect(await checkVaultPassphrase(damaged, "right"), field).toBe("slot-damaged");
    }
  });

  it("a check-less vault whose slot unwraps a foreign key, entries present -> VAULT_SLOT_DAMAGED_ERROR", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const { check: _gone, ...noCheck } = vault;
    const slot = vault.keyslots?.passphrase;
    if (!slot) throw new Error("no slot");
    // The hand-fix state (marker deleted), with a slot that is authentic for
    // this vault_id and has a valid digest but wraps a key no entry was
    // written under. Nothing decrypts, so the verdict is "mismatch", not "ok".
    const kek = await deriveKey("right", Buffer.from(slot.salt, "base64"), slot.kdf);
    const wrapped = wrapKey(
      generateDek(),
      kek,
      slotAadFor("passphrase", vault.vault_id as string, { kdf: slot.kdf, salt: slot.salt }),
    );
    const foreign: VaultFile = {
      ...noCheck,
      keyslots: {
        passphrase: { ...slot, wrapped, digest: passphraseSlotDigest(vault.vault_id as string, { ...slot, wrapped }) },
      },
    };
    expect(foreign.check).toBeUndefined();
    await expect(unlock(foreign, "right")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    expect(await checkVaultPassphrase(foreign, "right")).toBe("slot-damaged");
    // A passphrase that does not derive the slot's key fails the unwrap first.
    await expect(unlock(foreign, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("a slot that unwraps a key the contents do not know -> VAULT_SLOT_DAMAGED_ERROR", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const slot = vault.keyslots?.passphrase;
    if (!slot) throw new Error("no slot");
    // A well-formed slot for THIS vault_id that wraps a different DEK.
    const kek = await deriveKey("right", Buffer.from(slot.salt, "base64"), slot.kdf);
    const wrapped = wrapKey(
      generateDek(),
      kek,
      slotAadFor("passphrase", vault.vault_id as string, { kdf: slot.kdf, salt: slot.salt }),
    );
    const foreign: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: { ...slot, wrapped, digest: passphraseSlotDigest(vault.vault_id as string, { ...slot, wrapped }) },
      },
    };
    await expect(unlock(foreign, "right")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    // Same with no entries at all: now the marker is the ONLY witness, and
    // the unwrap that reached it already proved the passphrase is the one the
    // slot was created under. Nothing in the file can tell "slot wraps a
    // foreign key" from "the marker alone is damaged" -- the GCM failure is
    // identical -- so the rule is to believe the authenticated unwrap and
    // blame the marker, not the slot (VAULT_CHECK_CORRUPT_ERROR points at the
    // hand-fix; VAULT_SLOT_DAMAGED_ERROR would send the user chasing a slot
    // that checks out). With an entry present the entry settles it, which is
    // the case the line above covers.
    const emptyForeign: VaultFile = { ...foreign, entries: {} };
    await expect(unlock(emptyForeign, "right")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
    expect(await checkVaultPassphrase(emptyForeign, "right")).toBe("marker-corrupt");
    // The passphrase is still the slot's own: a wrong one never reaches the
    // marker at all.
    await expect(unlock(emptyForeign, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("marker corrupt but an entry decrypts -> VAULT_CHECK_CORRUPT_ERROR (marker-corrupt verdict)", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const damaged: VaultFile = {
      ...vault,
      check: { ...(vault.check as EncryptedEntry), ciphertext: Buffer.from("garbage!").toString("base64") },
    };
    await expect(unlock(damaged, "right")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
    expect(await checkVaultPassphrase(damaged, "right")).toBe("marker-corrupt");
    await expect(unlock(damaged, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("marker corrupt on an EMPTY vault -> marker-corrupt, never slot-damaged (the unwrap already proved the key)", async () => {
    const { vault, code } = await v3With("right", {}, true);
    expect(Object.keys(vault.entries)).toEqual([]);
    const damaged: VaultFile = {
      ...vault,
      check: { ...(vault.check as EncryptedEntry), ciphertext: Buffer.from("garbage!").toString("base64") },
    };
    // With zero entries the marker is the only witness, and there is nothing
    // to corroborate it either way -- but the GCM unwrap that got us here
    // already authenticated the key. Reporting "slot damaged" would accuse the
    // slot on that evidence, name the passphrase slot in the error and send
    // the user to `secrets recover` instead of the hand-fix that deletes the
    // marker (whose hint only VAULT_CHECK_CORRUPT_ERROR carries).
    const verdict = await unlock(damaged, "right").then(
      () => "opened",
      (err: unknown) => (err as Error).message,
    );
    expect(verdict).toBe(VAULT_CHECK_CORRUPT_ERROR);
    expect(verdict).not.toBe(VAULT_SLOT_DAMAGED_ERROR);
    expect(await checkVaultPassphrase(damaged, "right")).toBe("marker-corrupt");
    // A wrong passphrase still fails at the unwrap, before the marker is read.
    await expect(unlock(damaged, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
    // The same empty-vault rule applies to the recovery path, where the
    // unwrap proves the code instead of the passphrase.
    expect(() => unlockWithRecoveryCode(damaged, code as string)).toThrow(VAULT_CHECK_CORRUPT_ERROR);
  });

  it("the hand-fix (marker deleted) loads and unlocks, and the next set re-stamps the marker", async () => {
    const { vault } = await v3With("right", { github: "ghp_1" });
    const { check: _gone, ...noCheck } = vault;
    writeRaw(noCheck);
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.check).toBeUndefined();
    const dek = await unlock(loaded, "right");
    const next = setSecret(loaded, dek, "aws", "aws_1");
    expect(next.check).toBeDefined();
    expect(decryptEntry(next.check as EncryptedEntry, dek, vaultCheckAad(next))).toBe(VAULT_CHECK_PLAINTEXT);
    lock();
    await expect(unlock(loaded, "wrong")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("an in-memory vault claiming v3 without key slots is refused, not keyed by its placeholder salt", async () => {
    const bogus: VaultFile = { ...newVault(), version: 3 };
    await expect(unlock(bogus, "x")).rejects.toThrow(/no vault_id\/keyslots/);
    expect(() => setSecret(bogus, Buffer.alloc(32), "a", "b")).toThrow(/no vault_id\/keyslots/);
  });
});

describe("vault_id binding", () => {
  it("an entry or the marker copied in from another vault (same passphrase) fails", async () => {
    const a = await v3With("same-pass", { github: "ghp_A" });
    const b = await v3With("same-pass", { github: "ghp_B" });
    const dekA = await unlock(a.vault, "same-pass");
    // Entry from B under A's name: decrypt under A's DEK fails (different DEK
    // AND different vault_id in the AAD).
    const grafted: VaultFile = { ...a.vault, entries: { ...a.vault.entries, other: b.vault.entries.github } };
    expect(() => getSecret(grafted, dekA, "other")).toThrow();
    // An entry moved to another NAME inside A fails too.
    const renamed: VaultFile = { ...a.vault, entries: { moved: a.vault.entries.github } };
    expect(() => getSecret(renamed, dekA, "moved")).toThrow();
  });

  it("a passphrase slot copied in from another vault does not unwrap", async () => {
    const a = await v3With("same-pass", { github: "ghp_A" });
    const b = await v3With("same-pass", { github: "ghp_B" });
    const swapped: VaultFile = { ...a.vault, keyslots: b.vault.keyslots };
    // B's slot (and its digest) are bound to B's vault_id, so under A's the
    // digest disagrees and the slot reads as damaged -- for every passphrase,
    // with no unwrap attempted. It never hands A's reader B's DEK.
    await expect(unlock(swapped, "same-pass")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    // Re-stamping the digest for A's vault_id gets past that check, and the
    // AAD-bound unwrap still refuses it.
    const bSlot = b.vault.keyslots?.passphrase;
    if (!bSlot) throw new Error("no slot");
    const restamped: VaultFile = {
      ...a.vault,
      keyslots: { passphrase: { ...bSlot, digest: passphraseSlotDigest(a.vault.vault_id as string, bSlot) } },
    };
    await expect(unlock(restamped, "same-pass")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("entries are encrypted under the documented AAD", async () => {
    const { vault } = await v3With("p", { github: "ghp_A" });
    const dek = await unlock(vault, "p");
    expect(vaultEntryAad(vault, "github")).toBe(`yaw-mcp:v3:entry:${vault.vault_id}:github`);
    expect(vaultCheckAad(vault)).toBe(`yaw-mcp:v3:check:${vault.vault_id}`);
    expect(decryptEntry(vault.entries.github, dek, `yaw-mcp:v3:entry:${vault.vault_id}:github`)).toBe("ghp_A");
    expect(() => decryptEntry(vault.entries.github, dek, "github")).toThrow();
  });
});

describe("cache identity", () => {
  it("a slot rewritten in this process under the SAME passphrase is a cache miss", async () => {
    const { vault } = await v3With("same", { github: "ghp_1" });
    const dek = await unlock(vault, "same"); // now cached
    const rekeyed = (await rekeyVault(vault, dek, "same", { recovery: false })).vault;
    const newDek = await unlock(rekeyed, "same");
    expect(newDek.equals(dek)).toBe(false);
    expect(getSecret(rekeyed, newDek, "github")).toBe("ghp_1");
  });

  it("keeps the digest in the key: same salt, different wrapped key -> miss (not the cached DEK)", async () => {
    const { vault } = await v3With("same", { github: "ghp_1" });
    await unlock(vault, "same"); // cached under salt + digest
    const slot = vault.keyslots?.passphrase;
    if (!slot) throw new Error("no slot");
    const ct = Buffer.from(slot.wrapped.ciphertext, "base64");
    ct[3] ^= 0x10;
    const wrapped = { ...slot.wrapped, ciphertext: ct.toString("base64") };
    const edited: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: { ...slot, wrapped, digest: passphraseSlotDigest(vault.vault_id as string, { ...slot, wrapped }) },
      },
    };
    // A salt-only cache would hand back the old DEK; the real one re-derives
    // and the edited slot fails to unwrap.
    await expect(unlock(edited, "same")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("keeps the vault_id in the key: the cached slot copied verbatim under another vault_id -> miss", async () => {
    const { vault } = await v3With("same", { github: "ghp_1" });
    const dek = await unlock(vault, "same"); // cached
    const otherId = Buffer.from(vault.vault_id as string, "base64");
    otherId[0] ^= 1;
    // Same slot bytes (salt, digest, wrapped), same passphrase, different
    // vault_id. A hit would hand back the cached DEK before the slot is
    // checked; a miss checks it and finds the digest no longer matches.
    const moved: VaultFile = { ...vault, vault_id: otherId.toString("base64") };
    await expect(unlock(moved, "same")).rejects.toThrow(VAULT_SLOT_DAMAGED_ERROR);
    // The original is still a hit.
    expect((await unlock(vault, "same")).equals(dek)).toBe(true);
  });

  it("lock() during an in-flight v3 unlock leaves nothing cached", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" });
    const pending = unlock(vault, "p");
    lock();
    const dek = await pending;
    expect(getSecret(vault, dek, "github")).toBe("ghp_1");
    const { isUnlocked } = await import("../secrets-vault.js");
    expect(isUnlocked()).toBe(false);
  });
});

describe("setSecret / removeSecret / resolveSecretRefs on v3", () => {
  it("setSecret leaves keyslots, vault_id and the placeholder salt byte-identical, and stamps no kdf", async () => {
    const { vault } = await v3With("p", {}, true);
    const before = JSON.stringify({ k: vault.keyslots, id: vault.vault_id, salt: vault.salt });
    const dek = await unlock(vault, "p");
    let next = setSecret(vault, dek, "github", "ghp_1");
    next = setSecret(next, dek, "aws", "aws_1");
    next = removeSecret(next, "aws");
    expect(JSON.stringify({ k: next.keyslots, id: next.vault_id, salt: next.salt })).toBe(before);
    expect(next.kdf).toBeUndefined();
    expect(next.version).toBe(3);
    expect(next.check).toEqual(vault.check);
    expect(listKeys(next)).toEqual(["github"]);
  });

  it("resolveSecretRefs decrypts v3 entries", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" });
    const dek = await unlock(vault, "p");
    const out = resolveSecretRefs({ T: "Bearer ${secret:github}" }, vault, dek);
    expect(out.resolved.T).toBe("Bearer ghp_1");
    expect(out.missing).toEqual([]);
  });
});

describe("recovery codes", () => {
  it("unlockWithRecoveryCode returns the DEK, accepting the code as typed or as raw bytes", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const dek = unlockWithRecoveryCode(vault, code as string);
    expect(getSecret(vault, dek, "github")).toBe("ghp_1");
    const typed = (code as string).toLowerCase().replace(/-/g, " ");
    expect(unlockWithRecoveryCode(vault, typed).equals(dek)).toBe(true);
  });

  it("distinct errors: typo, not-a-code, wrong vault, no slot", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const c = code as string;
    const last = c.at(-1) === "0" ? "1" : "0";
    expect(() => unlockWithRecoveryCode(vault, `${c.slice(0, -1)}${last}`)).toThrow(RECOVERY_CODE_TYPO_ERROR);
    expect(() => unlockWithRecoveryCode(vault, "YAWR-1234")).toThrow(RECOVERY_CODE_FORMAT_ERROR);
    const other = formatRecoveryCode(Buffer.alloc(16, 9));
    expect(() => unlockWithRecoveryCode(vault, other)).toThrow(RECOVERY_CODE_WRONG_VAULT_ERROR);
    const none = await v3With("p", { github: "ghp_1" }, false);
    expect(() => unlockWithRecoveryCode(none.vault, c)).toThrow(VAULT_NO_RECOVERY_ERROR);
    const v2 = newVault();
    expect(() => unlockWithRecoveryCode(v2, c)).toThrow(VAULT_NO_RECOVERY_ERROR);
  });

  it("a recovery slot copied from another vault does not open this one", async () => {
    const a = await v3With("p", { github: "ghp_A" }, true);
    const b = await v3With("p", { github: "ghp_B" }, true);
    const bSlot = b.vault.keyslots?.recovery;
    if (!bSlot) throw new Error("no slot");
    // B's slot, digest and all, under A's vault_id. It cannot open A's file
    // and the verdict is SLOT DAMAGE rather than "wrong code": the stamp is
    // computed over B's vault_id, so under A's it cannot match -- the same
    // answer the passphrase slot gives a slot moved between vaults (see the
    // `moved` cache test above), and a code cannot be blamed for the file it
    // was never recorded against.
    const grafted: VaultFile = {
      ...a.vault,
      keyslots: { passphrase: a.vault.keyslots?.passphrase as never, recovery: bSlot },
    };
    expect(() => unlockWithRecoveryCode(grafted, b.code as string)).toThrow(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
    // A foreign code against A's OWN slot is still a wrong code: the slot's
    // stamp matches, so the unwrap is attempted and B's code fails it.
    expect(() => unlockWithRecoveryCode(a.vault, b.code as string)).toThrow(RECOVERY_CODE_WRONG_VAULT_ERROR);
  });

  it("a recovery slot wrapping a key the contents do not know -> VAULT_RECOVERY_SLOT_DAMAGED_ERROR", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    // Re-build the slot around a random DEK under the same code: authentic
    // for this vault_id, but holding the wrong key.
    const { parseRecoveryCode } = await import("../recovery-code.js");
    const { deriveRecoveryKek } = await import("../secrets-crypto.js");
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    const kek = deriveRecoveryKek(parseRecoveryCode(code as string), Buffer.from(slot.salt, "base64"));
    const wrapped = wrapKey(
      generateDek(),
      kek,
      slotAadFor("recovery", vault.vault_id as string, { kdf: slot.kdf, salt: slot.salt, created: slot.created }),
    );
    const bad: VaultFile = {
      ...vault,
      keyslots: { passphrase: vault.keyslots?.passphrase as never, recovery: { ...slot, wrapped } },
    };
    expect(() => unlockWithRecoveryCode(bad, code as string)).toThrow(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
    // ...while a corrupt marker with an entry that opens is the marker verdict.
    const markerBad: VaultFile = {
      ...vault,
      check: { ...(vault.check as EncryptedEntry), ciphertext: Buffer.from("zzzz").toString("base64") },
    };
    expect(() => unlockWithRecoveryCode(markerBad, code as string)).toThrow(VAULT_CHECK_CORRUPT_ERROR);
  });

  it("the recovery slot carries a digest: a flipped created or vault_id reads as slot-damaged, not wrong code", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    // The stamp is the same algorithm as the passphrase slot's, over the
    // recovery AAD (which binds created as well as salt and vault_id).
    expect(slot.digest).toBe(
      recoverySlotDigest(vault.vault_id as string, {
        salt: slot.salt,
        kdf: slot.kdf,
        created: slot.created,
        wrapped: slot.wrapped,
      }),
    );
    const otherId = generateSalt();
    const flipped = Buffer.from(slot.digest as string, "base64");
    flipped[0] ^= 0xff;
    const cases: Record<string, VaultFile> = {
      // The unwrap binds `created`, so an edited one fails GCM exactly like a
      // wrong code -- unless the digest is read first.
      created: {
        ...vault,
        keyslots: {
          passphrase: vault.keyslots?.passphrase as never,
          recovery: { ...slot, created: "2020-01-01T00:00:00.000Z" },
        },
      },
      vault_id: { ...vault, vault_id: otherId.toString("base64") },
      // The digest is itself damage: it no longer describes the slot.
      digest: {
        ...vault,
        keyslots: {
          passphrase: vault.keyslots?.passphrase as never,
          recovery: { ...slot, digest: flipped.toString("base64") },
        },
      },
    };
    for (const [field, damaged] of Object.entries(cases)) {
      // The holder of the CORRECT code is told the slot is damaged -- the
      // unwrap would fail identically for a typo, so without the digest this
      // reads as "this recovery code does not open this vault".
      const verdict = (() => {
        try {
          unlockWithRecoveryCode(damaged, code as string);
          return "opened";
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(verdict, field).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
      expect(verdict, field).not.toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    }
    // The undamaged vault still opens, and a genuinely wrong code is still
    // a wrong code -- the digest says nothing about the CODE, only about the
    // slot it unwraps.
    expect(unlockWithRecoveryCode(vault, code as string)).toBeInstanceOf(Buffer);
    const other = formatRecoveryCode(Buffer.alloc(16, 9));
    expect(() => unlockWithRecoveryCode(vault, other)).toThrow(RECOVERY_CODE_WRONG_VAULT_ERROR);
  });

  it("a vault written before the recovery digest existed still opens (a missing stamp is age, not damage)", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    // What every pre-digest v3 file looks like: no `digest` field at all --
    // including the pinned golden fixture, which this build must keep reading.
    const { digest: _undigested, ...oldSlot } = slot;
    const old: VaultFile = {
      ...vault,
      keyslots: { passphrase: vault.keyslots?.passphrase as never, recovery: oldSlot },
    };
    expect(old.keyslots?.recovery?.digest).toBeUndefined();
    expect(unlockWithRecoveryCode(old, code as string)).toBeInstanceOf(Buffer);
    // Absence must not become "wrong code" either: a well-formed but foreign
    // code on a digest-less slot is still reported as the wrong code.
    const other = formatRecoveryCode(Buffer.alloc(16, 9));
    expect(() => unlockWithRecoveryCode(old, other)).toThrow(RECOVERY_CODE_WRONG_VAULT_ERROR);
    // The golden fixture (written by an independent implementation, with no
    // digest) still opens by its code.
    const fixtureVault = JSON.parse(readFileSync(join(FIXTURES, "vault-v3.json"), "utf8")) as VaultFile;
    expect(fixtureVault.keyslots?.recovery?.digest).toBeUndefined();
    expect(unlockWithRecoveryCode(fixtureVault, "YAWR-206S-0V9V-11BG-11MW-FTSJ-DXBZ-7MFX")).toBeInstanceOf(Buffer);
  });

  it("editing the recovery slot's created time is slot damage, not a wrong code (it is in the AAD and the digest)", async () => {
    const { vault, code } = await v3With("p", {}, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    const edited: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: vault.keyslots?.passphrase as never,
        recovery: { ...slot, created: "2020-01-01T00:00:00.000Z" },
      },
    };
    expect(() => unlockWithRecoveryCode(edited, code as string)).toThrow(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
  });

  it("recoveryStatus: set / none / malformed / unsupported", async () => {
    const withCode = await v3With("p", {}, true);
    expect(recoveryStatus(withCode.vault).state).toBe("set");
    const without = await v3With("p", {}, false);
    expect(recoveryStatus(without.vault)).toEqual({ state: "none", created: null });
    expect(recoveryStatus({ ...without.vault, recoveryMalformed: true })).toEqual({
      state: "malformed",
      created: null,
    });
    expect(recoveryStatus(newVault())).toEqual({ state: "unsupported", created: null });
  });
});

describe("every re-key leaves the old passphrase, old code and old backup unable to open the new file", () => {
  async function assertCutOff(
    oldVault: VaultFile,
    oldPass: string,
    oldCode: string | undefined,
    oldDek: Buffer,
    next: VaultFile,
    nextPass: string,
  ): Promise<void> {
    lock();
    expect(next.vault_id).not.toBe(oldVault.vault_id);
    if (oldPass !== nextPass) await expect(unlock(next, oldPass)).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
    if (oldCode) {
      const err = (() => {
        try {
          unlockWithRecoveryCode(next, oldCode);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect([RECOVERY_CODE_WRONG_VAULT_ERROR, VAULT_NO_RECOVERY_ERROR]).toContain(err);
    }
    // The old DEK (anything a backup of the old file yields) opens nothing.
    for (const name of Object.keys(next.entries)) expect(() => getSecret(next, oldDek, name)).toThrow();
    // The new file opens under the new passphrase with every entry intact.
    const dek = await unlock(next, nextPass);
    expect(dek.equals(oldDek)).toBe(false);
    for (const name of Object.keys(oldVault.entries)) {
      expect(getSecret(next, dek, name)).toBe(getSecret(oldVault, oldDek, name));
    }
    lock();
  }

  it("rotate (new passphrase, new code)", async () => {
    const { vault, code } = await v3With("old-pass", { github: "ghp_1", aws: "aws_1" }, true);
    const dek = await unlock(vault, "old-pass");
    const next = await rekeyVault(vault, dek, "new-pass", { recovery: true });
    expect(next.recoveryCode).toMatch(CODE_RE);
    expect(next.recoveryCode).not.toBe(code);
    await assertCutOff(vault, "old-pass", code, dek, next.vault, "new-pass");
    expect(unlockWithRecoveryCode(next.vault, next.recoveryCode as string)).toBeInstanceOf(Buffer);
  });

  it("recover (code -> fresh DEK, new passphrase, new single-use code)", async () => {
    const { vault, code } = await v3With("forgotten", { github: "ghp_1" }, true);
    const dek = unlockWithRecoveryCode(vault, code as string);
    const next = await rekeyVault(vault, dek, "brand-new", { recovery: true, operation: "recover" });
    await assertCutOff(vault, "forgotten", code, dek, next.vault, "brand-new");
  });

  it("recovery new (same passphrase, fresh DEK, old code dead)", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const dek = await unlock(vault, "p");
    const next = await rekeyVault(vault, dek, "p", { recovery: true, operation: "recovery new" });
    await assertCutOff(vault, "p", code, dek, next.vault, "p");
    expect(next.vault.keyslots?.passphrase.salt).not.toBe(vault.keyslots?.passphrase.salt);
  });

  it("recovery remove (same passphrase, fresh DEK, no slot)", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const dek = await unlock(vault, "p");
    const next = await rekeyVault(vault, dek, "p", { recovery: false, operation: "recovery remove" });
    expect(next.recoveryCode).toBeUndefined();
    expect(recoveryStatus(next.vault).state).toBe("none");
    await assertCutOff(vault, "p", code, dek, next.vault, "p");
  });

  it("rekeyVault with recovery: false re-keys and drops the recovery slot (the plain-rotate shape)", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const dek = await unlock(vault, "p");
    const next = await rekeyVault(vault, dek, "q", { recovery: false });
    expect(next.recoveryCode).toBeUndefined();
    expect(recoveryStatus(next.vault).state).toBe("none");
    await assertCutOff(vault, "p", code, dek, next.vault, "q");
  });

  it("aborts with the operation's name on a corrupt entry, input untouched", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" });
    const dek = await unlock(vault, "p");
    const corrupt: VaultFile = {
      ...vault,
      entries: { github: { ...vault.entries.github, ciphertext: Buffer.from("nope").toString("base64") } },
    };
    const snapshot = JSON.stringify(corrupt);
    await expect(rekeyVault(corrupt, dek, "q", { recovery: true, operation: "recover" })).rejects.toThrow(
      /^recover aborted: entry "github" failed to decrypt, but the passphrase is right.*re-run recover\.$/,
    );
    expect(JSON.stringify(corrupt)).toBe(snapshot);
    await expect(rekeyVault(vault, generateDek(), "q", { recovery: false })).rejects.toThrow(
      /^rotate aborted: current passphrase is wrong/,
    );
  });
});

describe("loadVault: v3 validation", () => {
  async function base(): Promise<Record<string, unknown>> {
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    return JSON.parse(JSON.stringify(vault)) as Record<string, unknown>;
  }

  it("refuses a missing or wrong-length vault_id, missing keyslots, or a bad passphrase slot as corrupt", async () => {
    const good = await base();
    const slots = good.keyslots as Record<string, Record<string, unknown>>;
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["no vault_id", { ...good, vault_id: undefined }, /vault_id/],
      ["short vault_id", { ...good, vault_id: Buffer.alloc(8).toString("base64") }, /vault_id/],
      ["no keyslots", { ...good, keyslots: undefined }, /keyslots/],
      ["array keyslots", { ...good, keyslots: [] }, /keyslots/],
      ["no passphrase slot", { ...good, keyslots: { recovery: slots.recovery } }, /passphrase key slot/],
      [
        "short slot salt",
        { ...good, keyslots: { ...slots, passphrase: { ...slots.passphrase, salt: "AAAA" } } },
        /passphrase key slot salt/,
      ],
      [
        "bad slot kdf",
        { ...good, keyslots: { ...slots, passphrase: { ...slots.passphrase, kdf: { N: 3, r: 8, p: 1 } } } },
        /invalid kdf parameters \(N=3/,
      ],
      [
        "bad wrapped",
        { ...good, keyslots: { ...slots, passphrase: { ...slots.passphrase, wrapped: { iv: 1 } } } },
        /malformed wrapped key/,
      ],
      [
        "short digest",
        { ...good, keyslots: { ...slots, passphrase: { ...slots.passphrase, digest: "AAAA" } } },
        /digest/,
      ],
      ["malformed check", { ...good, check: { iv: "x" } }, /"check" marker is malformed/],
    ];
    for (const [label, obj, re] of cases) {
      writeRaw(obj);
      await expect(loadVault(path), label).rejects.toThrow(re);
    }
  });

  it("a malformed recovery slot is a warning: the vault loads without it and records recoveryMalformed", async () => {
    const good = await base();
    const slots = good.keyslots as Record<string, Record<string, unknown>>;
    for (const recovery of [
      { ...slots.recovery, created: "yesterday" },
      { ...slots.recovery, created: "2026-11-16T12:00:00+01:00" },
      { ...slots.recovery, kdf: "scrypt" },
      { ...slots.recovery, salt: "AAAA" },
      { ...slots.recovery, wrapped: null },
      "not-an-object",
    ]) {
      writeRaw({ ...good, keyslots: { ...slots, recovery } });
      const warnings: VaultLoadWarning[] = [];
      const loaded = (await loadVault(path, { onWarning: (w) => warnings.push(w) })) as VaultFile;
      expect(warnings.map((w) => w.kind)).toEqual(["recovery-malformed"]);
      expect(loaded.keyslots?.recovery).toBeUndefined();
      expect(loaded.recoveryMalformed).toBe(true);
      expect(recoveryStatus(loaded).state).toBe("malformed");
      // The passphrase still opens it.
      expect(await checkVaultPassphrase(loaded, "p")).toBe("opens");
      lock();
      // saveVault never writes the in-memory note.
      await saveVault(path, loaded);
      expect(readFileSync(path, "utf8")).not.toContain("recoveryMalformed");
      // ...but it DOES write the slot back out: the note describes a slot
      // that is still on disk, and dropping it is how an ordinary write used
      // to destroy the user's copy of it (see the round-trip test below).
      expect(JSON.parse(readFileSync(path, "utf8")).keyslots.recovery).toEqual(recovery);
    }
  });

  it("a malformed recovery slot survives a non-rekeying set: set and save keep it on disk", async () => {
    const good = await base();
    const slots = good.keyslots as Record<string, Record<string, unknown>>;
    // One shape of malformed (a `created` that is not an ISO-UTC instant) is
    // enough: every shape goes through the same load -> keep -> save path.
    const malformed = { ...slots.recovery, created: "yesterday" };
    writeRaw({ ...good, keyslots: { ...slots, recovery: malformed } });
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.recoveryMalformed).toBe(true);
    expect(recoveryStatus(loaded).state).toBe("malformed");
    // An ordinary `set` -- no re-key, no `recovery new` -- spreads this vault
    // through saveVault. The malformed slot must be back on disk afterwards,
    // byte for byte, exactly as `recovery new`'s warning promised.
    const dek = await unlock(loaded, "p");
    const afterSet = setSecret(loaded, dek, "new-secret", "value");
    dek.fill(0);
    lock();
    await saveVault(path, afterSet);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    expect(onDisk.keyslots.recovery).toEqual(malformed);
    expect(onDisk.recoveryMalformed).toBeUndefined();
    // ...and it reloads as the same malformed verdict, still with its entries.
    const warnings: VaultLoadWarning[] = [];
    const reloaded = (await loadVault(path, { onWarning: (w) => warnings.push(w) })) as VaultFile;
    expect(warnings.map((w) => w.kind)).toEqual(["recovery-malformed"]);
    expect(recoveryStatus(reloaded).state).toBe("malformed");
    expect(listKeys(reloaded)).toEqual(["github", "new-secret"]);
    // removeSecret round-trips it the same way.
    const afterRemove = removeSecret(reloaded, "new-secret");
    await saveVault(path, afterRemove);
    expect(JSON.parse(readFileSync(path, "utf8")).keyslots.recovery).toEqual(malformed);
    // Only a re-key replaces it: `recovery remove` builds a vault with no
    // slot at all, so neither the raw slot nor the flag rides along.
    const dek2 = await unlock(afterRemove, "p");
    const removed = await rekeyVault(afterRemove, dek2, "p", { recovery: false, operation: "recovery remove" });
    dek2.fill(0);
    expect(recoveryStatus(removed.vault).state).toBe("none");
    expect(removed.vault.recoveryMalformed).toBeUndefined();
    await saveVault(path, removed.vault);
    expect(JSON.parse(readFileSync(path, "utf8")).keyslots.recovery).toBeUndefined();
  });

  it("saveVault refuses a hand-built raw slot with no keyslots instead of dropping it", async () => {
    // The raw note can only exist alongside the keyslots that carry it when
    // it came from disk: loadV3Fields sets it only where keyslots.recovery
    // failed validation, and loadVault refuses a v3 vault with no keyslots at
    // all. So a vault with the raw and no keyslots is hand-built -- and the
    // old write path serialized it as-is, silently dropping the ONLY copy of
    // the slot and reintroducing the very deletion the raw exists to prevent.
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    const slots = vault.keyslots as unknown as Record<string, Record<string, unknown>>;
    const orphan: VaultFile = {
      ...vault,
      keyslots: undefined,
      recoveryMalformed: true,
      recoveryMalformedRaw: { ...slots.recovery, created: "yesterday" },
    };
    await expect(saveVault(path, orphan)).rejects.toThrow(/recoveryMalformedRaw but no keyslots/);
    // Loud, not just late: nothing was written behind the refusal.
    expect(() => readFileSync(path)).toThrow();
  });

  it("saveVault lets a valid keyslots.recovery win over a stale raw slot", async () => {
    // loadV3Fields sets the two exclusively, so both at once means something
    // repaired or replaced the slot in memory without clearing the note --
    // and the guard used to serialize only via the raw path, silently
    // reverting that repair on the next save. The valid slot is newer; it
    // must be what lands on disk.
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    const staleRaw = { ...(vault.keyslots?.recovery as unknown as Record<string, unknown>), created: "yesterday" };
    await saveVault(path, { ...vault, recoveryMalformed: true, recoveryMalformedRaw: staleRaw });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    expect(onDisk.keyslots.recovery).toEqual(vault.keyslots?.recovery);
    expect(onDisk.keyslots.recovery).not.toEqual(staleRaw);
    expect(onDisk.recoveryMalformedRaw).toBeUndefined();
  });

  it("drops a well-formed top-level kdf on v3 instead of refusing the vault", async () => {
    const good = await base();
    writeRaw({ ...good, kdf: DEFAULT_KDF });
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.kdf).toBeUndefined();
    expect(await checkVaultPassphrase(loaded, "p")).toBe("opens");
  });

  it("refuses schema 4 as newer", async () => {
    const good = await base();
    writeRaw({ ...good, version: 4 });
    await expect(loadVault(path)).rejects.toThrow(/newer yaw-mcp \(schema version 4 > 3\)/);
  });
});

describe("FIRST_BOUND_SCHEMA_VERSION: v2 still refuses an unbound blob after the bump", () => {
  it("v1 decrypts an unbound entry; v2 does not", async () => {
    expect(FIRST_BOUND_SCHEMA_VERSION).toBe(2);
    const salt = generateSalt();
    const key = await deriveKey("p", salt, FAST_KDF);
    const unbound = encryptEntry("value", key); // no AAD
    const v1: VaultFile = { version: 1, salt: salt.toString("base64"), kdf: FAST_KDF, entries: { a: unbound } };
    const v2: VaultFile = { ...v1, version: 2 };
    expect(getSecret(v1, key, "a")).toBe("value");
    expect(() => getSecret(v2, key, "a")).toThrow();
  });
});

describe("golden fixtures (written by an independent raw node:crypto implementation)", () => {
  function fixture(name: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  }

  it("v1 loads and unlocks exactly as before, then migrates to v3 with every entry intact", async () => {
    writeRaw(fixture("vault-v1.json"));
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.version).toBe(1);
    expect(recoveryStatus(loaded).state).toBe("unsupported");
    const key = await unlock(loaded, "golden-v1-fixture-passphrase");
    expect(getSecret(loaded, key, "github")).toBe("ghp_fixture_v1");
    const { vault: migrated, recoveryCode } = await rekeyVault(loaded, key, "golden-v1-fixture-passphrase", {
      recovery: true,
    });
    expect(migrated.version).toBe(3);
    await saveVault(path, migrated);
    lock();
    const reloaded = (await loadVault(path)) as VaultFile;
    const dek = await unlock(reloaded, "golden-v1-fixture-passphrase");
    expect(getSecret(reloaded, dek, "github")).toBe("ghp_fixture_v1");
    expect(getSecret(reloaded, dek, "aws")).toBe("aws_fixture_v1");
    expect(() => getSecret(reloaded, key, "github")).toThrow();
    expect(unlockWithRecoveryCode(reloaded, recoveryCode as string).equals(dek)).toBe(true);
  });

  it("v2 loads and unlocks exactly as before, then migrates to v3", async () => {
    writeRaw(fixture("vault-v2.json"));
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.version).toBe(2);
    expect(loaded.kdf).toEqual({ N: 1024, r: 8, p: 1 });
    await expect(unlock(loaded, "nope")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
    const key = await unlock(loaded, "golden-v2-fixture-passphrase");
    expect(getSecret(loaded, key, "aws")).toBe("aws_fixture_v2");
    const { vault: migrated } = await rekeyVault(loaded, key, "golden-v2-fixture-passphrase", { recovery: false });
    expect(isV3Vault(migrated)).toBe(true);
    lock();
    const dek = await unlock(migrated, "golden-v2-fixture-passphrase");
    expect(getSecret(migrated, dek, "github")).toBe("ghp_fixture_v2");
  });

  it("v3 (the format pinned by an independent writer) opens by passphrase and by its recovery code", async () => {
    writeRaw(fixture("vault-v3.json"));
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.version).toBe(3);
    expect(recoveryStatus(loaded)).toEqual({ state: "set", created: "2026-11-16T12:00:00.000Z" });
    const dek = await unlock(loaded, "golden-v3-fixture-passphrase");
    expect(getSecret(loaded, dek, "github")).toBe("ghp_fixture_v3");
    expect(getSecret(loaded, dek, "aws")).toBe("aws_fixture_v3");
    expect(unlockWithRecoveryCode(loaded, "YAWR-206S-0V9V-11BG-11MW-FTSJ-DXBZ-7MFX").equals(dek)).toBe(true);
    lock();
    await expect(unlock(loaded, "golden-v2-fixture-passphrase")).rejects.toThrow(VAULT_WRONG_PASSPHRASE_ERROR);
  });

  it("a v2 vault keyed under a legacy NON-NFC passphrase migrates to an NFC slot", async () => {
    const nfd = "café-passphrase"; // decomposed
    const nfc = nfd.normalize("NFC");
    const salt = generateSalt();
    const legacyKey = await deriveKey(nfd, salt, FAST_KDF, false); // raw bytes, pre-normalization
    const v2: VaultFile = {
      version: 2,
      salt: salt.toString("base64"),
      kdf: FAST_KDF,
      entries: { github: encryptEntry("ghp_nfd", legacyKey, "github") },
      check: encryptEntry(VAULT_CHECK_PLAINTEXT, legacyKey, "yaw-mcp:vault-check"),
    };
    const key = await unlock(v2, nfd); // NFC fails, the raw-bytes retry opens it
    expect(getSecret(v2, key, "github")).toBe("ghp_nfd");
    const { vault: migrated } = await rekeyVault(v2, key, nfd, { recovery: false });
    lock();
    // The new slot is NFC: the composed form opens it, and so does the
    // decomposed one (which normalizes to the same bytes).
    const viaNfc = await unlock(migrated, nfc);
    expect(getSecret(migrated, viaNfc, "github")).toBe("ghp_nfd");
    lock();
    const slot = migrated.keyslots?.passphrase;
    const kekNfc = await deriveKey(nfc, Buffer.from(slot?.salt as string, "base64"), slot?.kdf, false);
    const { unwrapKey } = await import("../secrets-crypto.js");
    expect(() =>
      unwrapKey(
        slot?.wrapped as EncryptedEntry,
        kekNfc,
        slotAadFor("passphrase", migrated.vault_id as string, { kdf: slot?.kdf, salt: slot?.salt }),
      ),
    ).not.toThrow();
  });
});

// The digest's flagship scenarios: shapes of damage that are WELL formed on
// disk (loadVault's shape checks pass) and only the recorded stamp can see.
// Every one must read as SLOT DAMAGE, never as "wrong code" -- the holder of
// the correct code must not be blamed for the file's damage.
describe("recovery slot digest: damage reads as damage, never as a wrong code", () => {
  /** Re-wrap a FOREIGN DEK under `code` in this vault's own slot identity and
   *  re-stamp the digest exactly as writeRecoverySlot would. The splice is
   *  then authentic for this vault_id -- the digest check passes, the code's
   *  unwrap SUCCEEDS -- and only verifyV3Contents can tell the key inside
   *  opens nothing. (The older foreign-DEK test swaps `wrapped` but keeps the
   *  ORIGINAL digest, so it exits at the digest check and never reaches the
   *  verdict mapping.) */
  async function splicedForeignSlot(vault: VaultFile, code: string) {
    const { parseRecoveryCode } = await import("../recovery-code.js");
    const { deriveRecoveryKek } = await import("../secrets-crypto.js");
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no recovery slot");
    const kek = deriveRecoveryKek(parseRecoveryCode(code), Buffer.from(slot.salt, "base64"));
    const wrapped = wrapKey(
      generateDek(),
      kek,
      slotAadFor("recovery", vault.vault_id as string, { kdf: slot.kdf, salt: slot.salt, created: slot.created }),
    );
    return {
      ...slot,
      wrapped,
      digest: recoverySlotDigest(vault.vault_id as string, {
        salt: slot.salt,
        kdf: slot.kdf,
        created: slot.created,
        wrapped,
      }),
    };
  }

  /** The verdict unlockWithRecoveryCode gives `code` on `vault`, captured
   *  rather than thrown so a test can assert it is NOT the wrong-code answer
   *  -- the whole point of reading the stamp before the unwrap. */
  function recoveryVerdict(vault: VaultFile, code: string): string {
    try {
      unlockWithRecoveryCode(vault, code);
      return "opened";
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("a digest-RE-STAMPED slot around a foreign DEK -> SLOT_DAMAGED via verifyV3Contents' mismatch verdict", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const spliced = await splicedForeignSlot(vault, code as string);
    // The wrapped key really was replaced (the old test's condition), while
    // the digest was re-stamped for it -- so the digest check PASSES here.
    expect(spliced.wrapped).not.toEqual(vault.keyslots?.recovery?.wrapped);
    const foreign: VaultFile = {
      ...vault,
      keyslots: { passphrase: vault.keyslots?.passphrase as never, recovery: spliced },
    };
    // The check marker is intact and every entry is present: the unwrap
    // succeeds, the marker fails under the foreign key, no entry decrypts,
    // so verifyV3Contents says "mismatch". unlockWithRecoveryCode must map
    // that to SLOT DAMAGE -- never CHECK_CORRUPT (that verdict needs an
    // entry to OPEN, which nothing here does) and never WRONG_VAULT (the
    // unwrap that just succeeded proved the code unwraps this slot).
    const verdict = recoveryVerdict(foreign, code as string);
    expect(verdict).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
    expect(verdict).not.toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
    expect(verdict).not.toBe(VAULT_CHECK_CORRUPT_ERROR);
  });

  it("the same foreign-DEK splice on a check-less vault -> SLOT_DAMAGED through the vault.check-absent branch", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const spliced = await splicedForeignSlot(vault, code as string);
    const { check: _gone, ...noCheck } = vault;
    const foreign: VaultFile = {
      ...noCheck,
      keyslots: { passphrase: vault.keyslots?.passphrase as never, recovery: spliced },
    };
    expect(foreign.check).toBeUndefined();
    // verifyV3Contents' check-less branch (the documented hand-fix state):
    // with no marker the entries are the only witnesses, none decrypts, so
    // the verdict is "mismatch" -> SLOT_DAMAGED. Absence of the marker must
    // not let the foreign key through as "ok" (an entry OPENING would be the
    // marker-corrupt path; here nothing opens).
    expect(recoveryVerdict(foreign, code as string)).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
  });

  it("a bit-flipped wrapped.ciphertext with the recorded digest intact -> SLOT_DAMAGED, never WRONG_VAULT", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    const ct = Buffer.from(slot.wrapped.ciphertext, "base64");
    ct[0] ^= 1;
    // Well formed on disk (loadVault type-checks the three wrapped strings,
    // not the bytes) and the digest still records the ORIGINAL ciphertext --
    // exactly what one flipped bit leaves. Without the stamp the unwrap fails
    // GCM and the only verdict it can give is WRONG_VAULT, telling the holder
    // of the CORRECT code the file is not theirs; the stamp is read first
    // (before any derivation, see unlockWithRecoveryCode) and blames the slot.
    const flipped: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: vault.keyslots?.passphrase as never,
        recovery: { ...slot, wrapped: { ...slot.wrapped, ciphertext: ct.toString("base64") } },
      },
    };
    const verdict = recoveryVerdict(flipped, code as string);
    expect(verdict).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
    expect(verdict).not.toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
  });

  it("a length-preserving salt flip with the recorded digest intact -> SLOT_DAMAGED (the digest binds salt)", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    const salt = Buffer.from(slot.salt, "base64");
    salt[0] ^= 1;
    const flippedSalt = salt.toString("base64");
    // Same byte length as the original, so loadVault's 16-byte salt check
    // still passes -- only the stamp can see it, because the canonical AAD it
    // covers includes `salt`: the recorded digest holds the ORIGINAL bytes,
    // so it no longer re-derives. Same shape the passphrase slot's salt-flip
    // test covers, on the recovery side.
    expect(Buffer.from(flippedSalt, "base64")).toHaveLength(16);
    const flipped: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: vault.keyslots?.passphrase as never,
        recovery: { ...slot, salt: flippedSalt },
      },
    };
    const verdict = recoveryVerdict(flipped, code as string);
    expect(verdict).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
    expect(verdict).not.toBe(RECOVERY_CODE_WRONG_VAULT_ERROR);
  });

  it("a truncated digest string -> SLOT_DAMAGED, not an unhandled timingSafeEqual RangeError", async () => {
    const { vault, code } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    // 4 chars, not the 44 of base64(SHA-256): Buffer.from(x, "base64")
    // decodes to 3 bytes, so the recorded.length === actual.length guard has
    // to reject BEFORE timingSafeEqual would throw RangeError on
    // mismatched-length inputs -- that throw is unhandled and would surface
    // as a crash instead of the documented verdict.
    expect(Buffer.from("AAAA", "base64")).toHaveLength(3);
    const truncated: VaultFile = {
      ...vault,
      keyslots: {
        passphrase: vault.keyslots?.passphrase as never,
        recovery: { ...slot, digest: "AAAA" },
      },
    };
    expect(recoveryVerdict(truncated, code as string)).toBe(VAULT_RECOVERY_SLOT_DAMAGED_ERROR);
  });

  it("a non-string digest loads as recovery-malformed, keeps the raw slot, and survives a save/load round trip", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    const good = JSON.parse(JSON.stringify(vault)) as Record<string, unknown>;
    const slots = good.keyslots as Record<string, Record<string, unknown>>;
    // parseRecoverySlot's digest-TYPE branch: a stamp of the wrong type is
    // damage the matcher must be able to see, not a field to drop -- dropping
    // it silently would read the slot as pre-digest (absence = age, always
    // accepted) and report "set" for a stamp that says something is wrong.
    // The malformed-shape loop covers bad created/kdf/salt/wrapped/shape;
    // this exercises the type check on a well-shaped slot, then the whole
    // keep promise: warned, raw KEPT, and a fresh load sees it again.
    for (const digest of [1, null]) {
      const label = `digest: ${JSON.stringify(digest)}`;
      writeRaw({ ...good, keyslots: { ...slots, recovery: { ...slots.recovery, digest } } });
      const warnings: VaultLoadWarning[] = [];
      const loaded = (await loadVault(path, { onWarning: (w) => warnings.push(w) })) as VaultFile;
      expect(
        warnings.map((w) => w.kind),
        label,
      ).toEqual(["recovery-malformed"]);
      expect(loaded.keyslots?.recovery, label).toBeUndefined();
      expect(loaded.recoveryMalformed, label).toBe(true);
      expect(loaded.recoveryMalformedRaw, label).toEqual({ ...slots.recovery, digest });
      expect(recoveryStatus(loaded).state, label).toBe("malformed");
      // The passphrase still opens it -- only the recovery code is lost.
      expect(await checkVaultPassphrase(loaded, "p"), label).toBe("opens");
      lock();
      await saveVault(path, loaded);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      expect(onDisk.keyslots.recovery, label).toEqual({ ...slots.recovery, digest });
      expect(onDisk.recoveryMalformed, label).toBeUndefined();
      const warnings2: VaultLoadWarning[] = [];
      const reloaded = (await loadVault(path, { onWarning: (w) => warnings2.push(w) })) as VaultFile;
      expect(
        warnings2.map((w) => w.kind),
        label,
      ).toEqual(["recovery-malformed"]);
      expect(recoveryStatus(reloaded).state, label).toBe("malformed");
    }
  });

  it("`recovery new` replaces a malformed slot: fresh valid slot, notes dropped, status set on reload", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    const slots = vault.keyslots as unknown as Record<string, Record<string, unknown>>;
    const malformed = { ...slots.recovery, created: "yesterday" };
    writeRaw({ ...vault, keyslots: { ...slots, recovery: malformed } });
    const warnings: VaultLoadWarning[] = [];
    const loaded = (await loadVault(path, { onWarning: (w) => warnings.push(w) })) as VaultFile;
    expect(warnings.map((w) => w.kind)).toEqual(["recovery-malformed"]);
    expect(loaded.recoveryMalformedRaw).toEqual(malformed);
    expect(recoveryStatus(loaded).state).toBe("malformed");
    // The load warning promises `recovery new` REPLACES the kept slot -- the
    // existing test covers only the `recovery remove` half of that promise.
    // The fresh build must carry neither note and a slot that validates.
    const dek = await unlock(loaded, "p");
    const next = await rekeyVault(loaded, dek, "p", { recovery: true, operation: "recovery new" });
    dek.fill(0);
    lock();
    expect(next.recoveryCode).toMatch(CODE_RE);
    expect(next.vault.recoveryMalformed).toBeUndefined();
    expect(next.vault.recoveryMalformedRaw).toBeUndefined();
    const slot = next.vault.keyslots?.recovery;
    if (!slot) throw new Error("recovery new wrote no slot");
    expect(slot.created).not.toBe(malformed.created);
    // Stamped the way writeRecoverySlot stamps it -- not merely present.
    expect(slot.digest).toBe(
      recoverySlotDigest(next.vault.vault_id as string, {
        salt: slot.salt,
        kdf: slot.kdf,
        created: slot.created,
        wrapped: slot.wrapped,
      }),
    );
    expect(unlockWithRecoveryCode(next.vault, next.recoveryCode as string)).toBeInstanceOf(Buffer);
    await saveVault(path, next.vault);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    expect(onDisk.keyslots.recovery).toEqual(slot);
    expect(onDisk.keyslots.recovery).not.toEqual(malformed);
    const warnings2: VaultLoadWarning[] = [];
    const reloaded = (await loadVault(path, { onWarning: (w) => warnings2.push(w) })) as VaultFile;
    expect(warnings2.map((w) => w.kind)).toEqual([]);
    expect(recoveryStatus(reloaded)).toEqual({ state: "set", created: slot.created });
    expect(unlockWithRecoveryCode(reloaded, next.recoveryCode as string)).toBeInstanceOf(Buffer);
    expect(await checkVaultPassphrase(reloaded, "p")).toBe("opens");
    lock();
  });

  it("a valid slot alongside a stale raw note reads as set, not malformed (the valid-wins precedence saveVault applies)", async () => {
    const { vault } = await v3With("p", { github: "ghp_1" }, true);
    const slot = vault.keyslots?.recovery;
    if (!slot) throw new Error("no slot");
    const staleRaw = { ...slot, created: "yesterday" };
    // The state saveVault's valid-wins guard writes: both notes at once mean
    // a repair replaced the slot in memory without clearing the note, and the
    // newer valid slot must win. recoveryStatus must apply the SAME
    // precedence -- keyslots.recovery is read first, so the stale raw
    // (recoveryMalformed) must never flip a usable slot to "malformed", or
    // status and the saved file would disagree about the same vault.
    const both: VaultFile = { ...vault, recoveryMalformed: true, recoveryMalformedRaw: staleRaw };
    expect(recoveryStatus(both)).toEqual({ state: "set", created: slot.created });
    await saveVault(path, both);
    const loaded = (await loadVault(path)) as VaultFile;
    expect(recoveryStatus(loaded)).toEqual({ state: "set", created: slot.created });
  });
});
