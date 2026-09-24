import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KDF,
  decryptEntry,
  deriveKey,
  encryptEntry,
  generateSalt,
  isValidKdfParams,
  KEY_LEN,
  LEGACY_KDF,
  normalizePassphrase,
  SALT_LEN,
} from "../secrets-crypto.js";

// secrets-crypto.ts imported directly. The derivation and AEAD round trips are
// also exercised through the vault in secrets-vault.test.ts; this file covers
// what only shows up here -- the validator's per-field branches, the key-length
// guards, and the historical constants every kdf-less vault depends on.

describe("LEGACY_KDF is a historical fact, pinned by value", () => {
  it("is exactly the v1 compile-time constant, and frozen", () => {
    // Every "legacy vault" fixture in the suite derives its key FROM this
    // constant at test time, so an edit of the literal re-keys the fixtures
    // along with every real v1 vault and those tests stay green. Only a
    // literal comparison (and the golden vault in secrets-vault.test.ts)
    // notices. THESE VALUES MUST NEVER CHANGE -- see the constant's doc.
    expect(LEGACY_KDF).toEqual({ N: 32768, r: 8, p: 1 });
    expect(Object.isFrozen(LEGACY_KDF)).toBe(true);
  });

  it("is what deriveKey uses when a caller passes no parameters", async () => {
    // A known-answer test against node's own scrypt with LITERAL parameters,
    // not the constant: it fails if the default moves off the v1 values or if
    // deriveKey starts handing scrypt anything else (a different key length,
    // a different N/r/p).
    const salt = Buffer.from("gCHjA2qy+iUTFVuKxdHLnw==", "base64");
    const expected = scryptSync("golden-v1-passphrase", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const key = await deriveKey("golden-v1-passphrase", salt);
    expect(key.equals(expected)).toBe(true);
  });
});

describe("isValidKdfParams", () => {
  it("accepts the build's own parameters and the edges of every bound", () => {
    for (const params of [
      DEFAULT_KDF,
      LEGACY_KDF,
      { N: 2, r: 1, p: 1 }, // smallest of everything
      { N: 1 << 15, r: 1, p: 1 }, // largest N scrypt takes at r=1 (N < 2^16)
      { N: 1 << 16, r: 2, p: 1 }, // r=2 lifts that ceiling to 2^32
      { N: 1 << 18, r: 8, p: 1 }, // MAX_KDF_N at the default r: exactly 256 MiB
      { N: 1 << 18, r: 8, p: 16 }, // ...with MAX_KDF_P
      { N: 1 << 13, r: 32, p: 16 }, // MAX_KDF_R at a N the memory bound allows
    ]) {
      expect(isValidKdfParams(params), JSON.stringify(params)).toBe(true);
    }
  });

  it("refuses everything that is not an object of three positive integers in bounds", () => {
    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["a string", "32768"],
      ["a number", 32768],
      ["an empty object", {}],
      ["a missing field", { N: 32768, r: 8 }],
      ["a string field", { N: "32768", r: 8, p: 1 }],
      ["a fractional r", { N: 32768, r: 8.5, p: 1 }],
      ["a NaN p", { N: 32768, r: 8, p: Number.NaN }],
      ["an infinite N", { N: Number.POSITIVE_INFINITY, r: 8, p: 1 }],
      ["N below 2", { N: 1, r: 8, p: 1 }],
      ["N zero", { N: 0, r: 8, p: 1 }],
      ["N negative", { N: -32768, r: 8, p: 1 }],
      ["N not a power of two", { N: 3, r: 8, p: 1 }],
      ["N past MAX_KDF_N", { N: 1 << 19, r: 1, p: 1 }],
      ["r zero", { N: 32768, r: 0, p: 1 }],
      ["r past MAX_KDF_R", { N: 2, r: 33, p: 1 }],
      ["p zero", { N: 32768, r: 8, p: 0 }],
      ["p past MAX_KDF_P", { N: 32768, r: 8, p: 17 }],
      // Each field in bounds, the pair a 1 GiB memory bomb.
      ["an N/r pair past the memory bound", { N: 1 << 18, r: 32, p: 1 }],
    ];
    for (const [label, v] of cases) expect(isValidKdfParams(v), label).toBe(false);
  });

  it("refuses the N/r pairs node's scrypt rejects outright (N must stay below 2^(16*r))", async () => {
    // Inside every per-field bound and the memory bound, yet OpenSSL refuses
    // them with ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Accepted here, a vault
    // carrying one loaded cleanly and then failed unlock() with node's raw
    // error instead of loadVault's "invalid kdf parameters".
    const salt = generateSalt();
    for (const params of [
      { N: 1 << 16, r: 1, p: 1 },
      { N: 1 << 17, r: 1, p: 1 },
      { N: 1 << 18, r: 1, p: 1 },
    ]) {
      expect(isValidKdfParams(params), JSON.stringify(params)).toBe(false);
      // The fact the guard encodes, checked against node itself: if a future
      // runtime ever accepts these, this line says so rather than letting the
      // guard quietly refuse vaults that would open.
      await expect(deriveKey("pw", salt, params), JSON.stringify(params)).rejects.toThrow();
    }
  });

  it("every accepted pair at the edge of the scrypt constraint actually derives", async () => {
    // The other half of the agreement: the guard must not refuse a pair node
    // accepts, or a valid vault would read as corrupt. The largest N at each
    // small r is where the two could disagree; r >= 4 is past OpenSSL's check.
    const salt = generateSalt();
    for (const params of [
      { N: 1 << 15, r: 1, p: 1 },
      { N: 1 << 18, r: 2, p: 1 },
      { N: 1 << 18, r: 3, p: 1 },
    ]) {
      expect(isValidKdfParams(params), JSON.stringify(params)).toBe(true);
      const key = await deriveKey("pw", salt, params);
      expect(key, JSON.stringify(params)).toHaveLength(KEY_LEN);
    }
  });
});

describe("encryptEntry / decryptEntry key-length guard", () => {
  it("refuses a key that is not KEY_LEN bytes, both ways", async () => {
    // AES-256-GCM needs exactly 32 bytes. The guard turns a short or long key
    // into a named error instead of whatever createCipheriv throws.
    for (const len of [0, 16, KEY_LEN - 1, KEY_LEN + 1]) {
      expect(() => encryptEntry("x", Buffer.alloc(len)), String(len)).toThrow(/key must be 32 bytes/);
    }
    const good = await deriveKey("pw", generateSalt());
    const entry = encryptEntry("x", good);
    for (const len of [0, 16, KEY_LEN - 1, KEY_LEN + 1]) {
      expect(() => decryptEntry(entry, Buffer.alloc(len)), String(len)).toThrow(/key must be 32 bytes/);
    }
    // ...and the right length still round-trips.
    expect(decryptEntry(entry, good)).toBe("x");
  });
});

describe("generateSalt", () => {
  it("returns SALT_LEN (16) random bytes", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(SALT_LEN).toBe(16);
    expect(a).toHaveLength(SALT_LEN);
    expect(b).toHaveLength(SALT_LEN);
    expect(a.equals(b)).toBe(false);
  });
});

describe("normalizePassphrase", () => {
  // Built from code points, never typed: the two forms are visually identical
  // in an editor, so a literal fixture would silently be the same string.
  const COMPOSED = `caf${String.fromCharCode(0xe9)}-passphrase`;
  const DECOMPOSED = `cafe${String.fromCharCode(0x301)}-passphrase`;

  it("maps the decomposed form onto the composed one, and leaves ASCII alone", () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect(normalizePassphrase(DECOMPOSED)).toBe(COMPOSED);
    expect(normalizePassphrase(COMPOSED)).toBe(COMPOSED);
    expect(normalizePassphrase("hunter2")).toBe("hunter2");
  });

  it("is what deriveKey keys on, unless the legacy retry turns it off", async () => {
    const salt = generateSalt();
    const composed = await deriveKey(COMPOSED, salt);
    expect((await deriveKey(DECOMPOSED, salt)).equals(composed)).toBe(true);
    expect((await deriveKey(DECOMPOSED, salt, LEGACY_KDF, false)).equals(composed)).toBe(false);
  });
});
