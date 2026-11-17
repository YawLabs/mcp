import { createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  copyKey,
  DEFAULT_KDF,
  DEK_LEN,
  decryptEntry,
  defaultKdf,
  deriveKey,
  deriveRecoveryKek,
  encryptEntry,
  generateDek,
  generateSalt,
  generateVaultId,
  invalidKdfParamsReason,
  isValidKdfParams,
  KEY_LEN,
  kdfExceedsDefault,
  LEGACY_KDF,
  normalizePassphrase,
  SALT_LEN,
  setDefaultKdfForTesting,
  slotDigest,
  unwrapKey,
  VAULT_ID_LEN,
  wrapKey,
} from "../secrets-crypto.js";

afterEach(() => {
  setDefaultKdfForTesting(null);
});

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
      // guard quietly refuse vaults that would open. node's scrypt directly,
      // not deriveKey: deriveKey now runs the guard first, so it would only
      // be checking the guard against itself.
      expect(
        () => scryptSync("pw", salt, 32, { ...params, maxmem: 256 * 1024 * 1024 }),
        JSON.stringify(params),
      ).toThrow();
      // ...and deriveKey refuses them up front with loadVault's wording.
      await expect(deriveKey("pw", salt, params), JSON.stringify(params)).rejects.toThrow(/invalid kdf parameters/);
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

describe("decryptEntry on an authentication failure", () => {
  it("zeroes the bytes GCM's update() already decrypted before rethrowing", () => {
    const key = randomBytes(32);
    const secret = "sk-SECRET-token-123";
    const entry = encryptEntry(secret, key, "aad");
    const tag = Buffer.from(entry.authTag, "base64");
    tag[0] ^= 1;
    const tampered = { ...entry, authTag: tag.toString("base64") };
    // update() runs before the tag check, so under the RIGHT key it hands
    // back the plaintext; the buffer it returned must be wiped when final()
    // throws. Record every Buffer zero-filled during the failing decrypt.
    const zeroed: Buffer[] = [];
    const realFill = Buffer.prototype.fill;
    const spy = vi.spyOn(Buffer.prototype, "fill").mockImplementation(function (this: Buffer, ...args: unknown[]) {
      const out = (realFill as (...a: unknown[]) => Buffer).apply(this, args);
      if (args[0] === 0) zeroed.push(this);
      return out;
    });
    try {
      expect(() => decryptEntry(tampered, key, "aad")).toThrow();
    } finally {
      spy.mockRestore();
    }
    const head = zeroed.find((b) => b.length === Buffer.byteLength(secret));
    expect(head, "the decrypted head buffer was not zeroed").toBeDefined();
    expect(head?.every((byte) => byte === 0)).toBe(true);
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

describe("invalidKdfParamsReason names the field, isValidKdfParams is its verdict", () => {
  it("says which bound broke, so loadVault's corrupt-vault error can quote it", () => {
    expect(invalidKdfParamsReason({ N: 32768, r: 8, p: 17 })).toBe("p=17 must be between 1 and 16");
    expect(invalidKdfParamsReason({ N: 32768, r: 8, p: 0 })).toBe("p=0 must be between 1 and 16");
    expect(invalidKdfParamsReason({ N: 3, r: 8, p: 1 })).toMatch(/^N=3 must be a power of two/);
    expect(invalidKdfParamsReason({ N: 2, r: 33, p: 1 })).toBe("r=33 must be between 1 and 32");
    expect(invalidKdfParamsReason({ N: 1 << 18, r: 32, p: 1 })).toMatch(/over the \d+ bound$/);
    expect(invalidKdfParamsReason({ N: 1 << 16, r: 1, p: 1 })).toMatch(/below 2\^\(16\*r\)/);
    expect(invalidKdfParamsReason("nope")).toBe("not an object");
    expect(invalidKdfParamsReason({ N: "32768", r: 8, p: 1 })).toBe("N, r and p must be numbers");
    expect(invalidKdfParamsReason({ N: 32768, r: 8.5, p: 1 })).toBe("N, r and p must be integers");
  });

  it("agrees with isValidKdfParams on every case, both ways", () => {
    for (const v of [DEFAULT_KDF, LEGACY_KDF, { N: 1 << 18, r: 8, p: 16 }]) {
      expect(invalidKdfParamsReason(v), JSON.stringify(v)).toBe(null);
      expect(isValidKdfParams(v), JSON.stringify(v)).toBe(true);
    }
    for (const v of [{ N: 32768, r: 8, p: 17 }, { N: 3, r: 8, p: 1 }, null]) {
      expect(invalidKdfParamsReason(v), JSON.stringify(v)).not.toBe(null);
      expect(isValidKdfParams(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("kdfExceedsDefault", () => {
  it("is true on any axis above DEFAULT_KDF -- p included, which the memory bound never sees", () => {
    expect(kdfExceedsDefault(DEFAULT_KDF)).toBe(false);
    expect(kdfExceedsDefault(LEGACY_KDF)).toBe(false);
    expect(kdfExceedsDefault({ N: DEFAULT_KDF.N, r: DEFAULT_KDF.r, p: 2 })).toBe(true);
    expect(kdfExceedsDefault({ N: DEFAULT_KDF.N << 1, r: DEFAULT_KDF.r, p: 1 })).toBe(true);
    expect(kdfExceedsDefault({ N: DEFAULT_KDF.N, r: DEFAULT_KDF.r + 1, p: 1 })).toBe(true);
    // Cheaper than the default is not "exceeds".
    expect(kdfExceedsDefault({ N: DEFAULT_KDF.N >> 1, r: 1, p: 1 })).toBe(false);
  });
});

describe("deriveKey validates its parameters", () => {
  it("rejects params invalidKdfParamsReason refuses before scrypt runs, naming the field", async () => {
    const salt = generateSalt();
    await expect(deriveKey("pw", salt, { N: 3, r: 8, p: 1 })).rejects.toThrow(
      /^invalid kdf parameters \(N=3 must be a power of two/,
    );
    await expect(deriveKey("pw", salt, { N: 1 << 18, r: 32, p: 1 })).rejects.toThrow(/over the \d+ bound/);
    await expect(deriveKey("pw", salt, { N: 1 << 15, r: 8, p: 17 })).rejects.toThrow(/p=17/);
  });
});

describe("key material lives in its own allocation", () => {
  it("deriveKey returns a key backed by its own ArrayBuffer, not a slice of the shared pool", async () => {
    const key = await deriveKey("pw", generateSalt(), { N: 1 << 10, r: 8, p: 1 });
    expect(key).toHaveLength(KEY_LEN);
    expect(key.byteOffset).toBe(0);
    expect(key.buffer.byteLength).toBe(KEY_LEN);
  });

  it("copyKey copies into a dedicated buffer the source can be zeroed without touching", () => {
    const src = Buffer.alloc(KEY_LEN, 7);
    const out = copyKey(src);
    expect(out).not.toBe(src);
    expect(out.buffer).not.toBe(src.buffer);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(KEY_LEN);
    src.fill(0);
    expect(out.every((b) => b === 7)).toBe(true);
  });
});

describe("DEFAULT_KDF is frozen; tests move the default through the hook", () => {
  it("cannot be mutated in place", () => {
    expect(Object.isFrozen(DEFAULT_KDF)).toBe(true);
    expect(() => {
      (DEFAULT_KDF as { N: number }).N = 2;
    }).toThrow(TypeError);
    expect(DEFAULT_KDF.N).toBe(1 << 15);
  });

  it("setDefaultKdfForTesting moves defaultKdf() and kdfExceedsDefault, and null restores DEFAULT_KDF", () => {
    expect(defaultKdf()).toBe(DEFAULT_KDF);
    setDefaultKdfForTesting({ N: 1 << 16, r: 8, p: 1 });
    expect(defaultKdf()).toEqual({ N: 1 << 16, r: 8, p: 1 });
    expect(Object.isFrozen(defaultKdf())).toBe(true);
    expect(kdfExceedsDefault(DEFAULT_KDF)).toBe(false);
    expect(kdfExceedsDefault({ N: 1 << 17, r: 8, p: 1 })).toBe(true);
    setDefaultKdfForTesting(null);
    expect(defaultKdf()).toBe(DEFAULT_KDF);
  });
});

describe("v3 key-slot primitives", () => {
  it("generateDek is 32 fresh bytes; generateVaultId is 16 fresh bytes in base64", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a).toHaveLength(DEK_LEN);
    expect(a.equals(b)).toBe(false);
    const id = generateVaultId();
    expect(Buffer.from(id, "base64")).toHaveLength(VAULT_ID_LEN);
    expect(generateVaultId()).not.toBe(id);
  });

  it("wrapKey/unwrapKey round-trip, and refuse a different kek or aad", () => {
    const dek = generateDek();
    const kek = randomBytes(32);
    const wrapped = wrapKey(dek, kek, "aad-1");
    expect(unwrapKey(wrapped, kek, "aad-1").equals(dek)).toBe(true);
    expect(() => unwrapKey(wrapped, randomBytes(32), "aad-1")).toThrow();
    expect(() => unwrapKey(wrapped, kek, "aad-2")).toThrow();
  });

  it("unwrapKey refuses a plaintext that is not a 32-byte key", () => {
    const kek = randomBytes(32);
    const wrapped = wrapKey(Buffer.alloc(16, 7), kek, "a");
    expect(() => unwrapKey(wrapped, kek, "a")).toThrow(/wrong length/);
  });

  it("slotDigest is base64 SHA-256 over aad || 0x00 || iv || ciphertext || authTag", () => {
    const wrapped = wrapKey(generateDek(), randomBytes(32), "x");
    const aad = canonicalJson({
      role: "passphrase",
      vault_id: "v",
      version: 3,
      kdf: { N: 1024, r: 8, p: 1 },
      salt: "s",
    });
    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from(aad, "utf8"),
          Buffer.from([0]),
          Buffer.from(wrapped.iv, "base64"),
          Buffer.from(wrapped.ciphertext, "base64"),
          Buffer.from(wrapped.authTag, "base64"),
        ]),
      )
      .digest("base64");
    expect(slotDigest(aad, wrapped)).toBe(expected);
    expect(Buffer.from(slotDigest(aad, wrapped), "base64")).toHaveLength(32);
    // The AAD is part of the digest: any change to it changes the stamp.
    expect(slotDigest(`${aad} `, wrapped)).not.toBe(expected);
  });

  it("deriveRecoveryKek is HKDF-SHA256 with the pinned info string", () => {
    const secret = randomBytes(16);
    const salt = randomBytes(16);
    const expected = Buffer.from(hkdfSync("sha256", secret, salt, "yaw-mcp:keyslot:recovery:v1", 32));
    expect(deriveRecoveryKek(secret, salt).equals(expected)).toBe(true);
    expect(deriveRecoveryKek(secret, randomBytes(16)).equals(expected)).toBe(false);
  });

  it("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null }, z: undefined })).toBe(
      '{"a":{"c":null,"d":[1,"x"]},"b":1}',
    );
    // Build order does not matter.
    expect(canonicalJson({ role: "r", kdf: { r: 8, N: 2, p: 1 } })).toBe(
      canonicalJson({ kdf: { p: 1, N: 2, r: 8 }, role: "r" }),
    );
  });
});
