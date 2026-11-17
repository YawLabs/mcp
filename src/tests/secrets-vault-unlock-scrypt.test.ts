// unlock()'s scrypt accounting: how many derivations a call really runs.
// node:crypto's scrypt is wrapped (still the real one underneath) so the
// count is observable; that mock is why these live in their own file rather
// than in secrets-vault.test.ts.

import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

import { deriveKey, encryptEntry, generateSalt, LEGACY_KDF } from "../secrets-crypto.js";
import {
  getSecret,
  isUnlocked,
  lock,
  newVault,
  setSecret,
  unlock,
  VAULT_CHECK_AAD,
  VAULT_CHECK_CORRUPT_ERROR,
  VAULT_CHECK_PLAINTEXT,
  type VaultFile,
} from "../secrets-vault.js";

const scryptMock = vi.mocked(crypto.scrypt);

beforeEach(() => {
  lock();
});

afterEach(() => {
  lock();
  scryptMock.mockClear();
});

async function vaultUnder(passphrase: string): Promise<VaultFile> {
  let vault = newVault();
  vault = setSecret(vault, await unlock(vault, passphrase), "github", "ghp_abc");
  lock();
  scryptMock.mockClear();
  return vault;
}

describe("concurrent cold unlocks share one scrypt run", () => {
  it("runs scrypt once for N concurrent callers, and hands each its OWN key", async () => {
    const vault = await vaultUnder("hunter2");
    const keys = await Promise.all([unlock(vault, "hunter2"), unlock(vault, "hunter2"), unlock(vault, "hunter2")]);
    expect(scryptMock).toHaveBeenCalledTimes(1);
    expect(new Set(keys).size).toBe(3);
    expect(new Set(keys.map((k) => k.buffer)).size).toBe(3);
    // Zeroing one caller's key leaves the others intact.
    keys[0].fill(0);
    expect(getSecret(vault, keys[1], "github")).toBe("ghp_abc");
    expect(getSecret(vault, keys[2], "github")).toBe("ghp_abc");
  });

  it("does not share across different passphrases", async () => {
    const vault = await vaultUnder("hunter2");
    const results = await Promise.allSettled([unlock(vault, "hunter2"), unlock(vault, "hunter3")]);
    expect(scryptMock).toHaveBeenCalledTimes(2);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
  });

  it("drops a REJECTED derivation, so the next unlock retries instead of replaying the failure", async () => {
    const vault = await vaultUnder("hunter2");
    scryptMock.mockImplementationOnce(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, key?: Buffer) => void;
      setImmediate(() => cb(new Error("simulated scrypt failure")));
    }) as unknown as typeof crypto.scrypt);
    const results = await Promise.allSettled([unlock(vault, "hunter2"), unlock(vault, "hunter2")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(scryptMock).toHaveBeenCalledTimes(1);
    expect(isUnlocked()).toBe(false);

    const key = await unlock(vault, "hunter2");
    expect(scryptMock).toHaveBeenCalledTimes(2);
    expect(getSecret(vault, key, "github")).toBe("ghp_abc");
  });
});

describe("the legacy normalization retries", () => {
  const COMPOSED = `caf${String.fromCharCode(0xe9)}-passphrase`;
  const DECOMPOSED = `cafe${String.fromCharCode(0x301)}-passphrase`;

  it("skips the retries entirely when the first verdict is a corrupt MARKER (the passphrase is right)", async () => {
    // Keyed on the NFC form with a damaged marker: the NFC key opens the
    // entry, so the passphrase is proven. A retry could only cost scrypt runs.
    let vault = newVault();
    vault = setSecret(vault, await unlock(vault, COMPOSED), "github", "ghp_abc");
    const damaged: VaultFile = {
      ...vault,
      check: { ...(vault.check as VaultFile["entries"][string]), ciphertext: Buffer.from("x").toString("base64") },
    };
    lock();
    scryptMock.mockClear();
    await expect(unlock(damaged, DECOMPOSED)).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
    expect(scryptMock).toHaveBeenCalledTimes(1);
  });

  it("tries NFC first, then the raw bytes, then NFD -- one scrypt each, only as needed", async () => {
    // A passphrase that is neither NFC nor NFD: e-acute composed, then a
    // decomposed e + combining acute. Raw, NFC and NFD are all distinct.
    const MIXED = `${String.fromCharCode(0xe9)}e${String.fromCharCode(0x301)}`;
    expect(new Set([MIXED, MIXED.normalize("NFC"), MIXED.normalize("NFD")]).size).toBe(3);
    const salt = generateSalt();
    const nfdKey = await deriveKey(MIXED.normalize("NFD"), salt, LEGACY_KDF, false);
    const vault: VaultFile = {
      version: 2,
      salt: salt.toString("base64"),
      kdf: { ...LEGACY_KDF },
      entries: {},
      check: encryptEntry(VAULT_CHECK_PLAINTEXT, nfdKey, VAULT_CHECK_AAD),
    };
    scryptMock.mockClear();
    const key = await unlock(vault, MIXED);
    expect(key.equals(nfdKey)).toBe(true);
    expect(scryptMock).toHaveBeenCalledTimes(3);
    const order = scryptMock.mock.calls.map((c) => String(c[0]));
    expect(order).toEqual([MIXED.normalize("NFC"), MIXED, MIXED.normalize("NFD")]);
  });

  it("an ASCII passphrase gets no retry at all", async () => {
    const vault = await vaultUnder("hunter2");
    await expect(unlock(vault, "hunter3")).rejects.toThrow();
    expect(scryptMock).toHaveBeenCalledTimes(1);
  });
});
