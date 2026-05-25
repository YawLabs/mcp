// Passphrase-derived encryption for the Yaw MCP secret vault.
//
// Threat model: protect the on-disk vault file at ~/.yaw-mcp/secrets.json
// against offline brute-force when the file is exfiltrated (e.g. backup
// leak, stolen laptop). Per-process passphrase cache in memory means a
// running yaw-mcp can decrypt without re-prompting, but cold-start
// requires the passphrase.
//
// Algorithms:
//   - Key derivation:    scrypt (N=2^15, r=8, p=1) -- Node built-in,
//                        memory-hard, sufficient for a passphrase of
//                        reasonable entropy.
//   - Authenticated enc: AES-256-GCM with a per-entry random 12-byte IV.
//                        AuthTag prevents tampering; tampered ciphertexts
//                        fail decrypt before any plaintext is exposed.
//
// Per-entry encryption (not one envelope around the whole vault) means:
//   1. Adding/rotating a single secret rewrites only its entry, not the
//      full vault -- smaller diff in the synced blob.
//   2. The server (Netlify Blobs) sees an opaque object per key, never
//      plaintext -- mcp_secrets ships only ciphertext + iv + authTag
//      per entry, plus the salt at the top level.
//
// The salt is stored AT THE VAULT LEVEL, not per-entry. All entries
// share the same scrypt-derived key, so the key is derived once per
// passphrase prompt, not once per entry.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Length in bytes of the derived key. AES-256-GCM needs 32. */
export const KEY_LEN = 32;

/** AES-GCM standard IV size; do NOT change without revisiting NIST guidance. */
export const IV_LEN = 12;

/** Salt size in bytes. 16 is the conventional minimum. */
export const SALT_LEN = 16;

/** scrypt cost factor. Higher = slower derivation = better brute-force
 *  resistance, but every CLI command that touches the vault waits for
 *  derivation. 2^15 is a reasonable middle ground (~100ms on commodity
 *  hardware in 2026). */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** scrypt's default maxmem is too low for N=2^15. Set explicitly. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface EncryptedEntry {
  /** Base64-encoded IV (12 bytes). */
  iv: string;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded GCM auth tag (16 bytes). */
  authTag: string;
}

/** Generate a fresh random salt for a new vault. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

/** Derive a 32-byte key from a passphrase + salt via scrypt. */
export async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scryptCallWithMaxmem(passphrase, salt, KEY_LEN);
}

async function scryptCallWithMaxmem(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  // node:crypto's scrypt(password, salt, keylen, opts?) accepts opts.
  // promisify doesn't carry opts cleanly, so we re-implement the
  // promise wrapper to pass N/r/p/maxmem.
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
}

/** Encrypt a plaintext string into an EncryptedEntry. */
export function encryptEntry(plaintext: string, key: Buffer): EncryptedEntry {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ct.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/** Decrypt an EncryptedEntry. Throws on tamper / wrong key / corruption. */
export function decryptEntry(entry: EncryptedEntry, key: Buffer): string {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  const iv = Buffer.from(entry.iv, "base64");
  const ct = Buffer.from(entry.ciphertext, "base64");
  const authTag = Buffer.from(entry.authTag, "base64");
  if (iv.length !== IV_LEN) throw new Error("invalid IV length");
  if (authTag.length !== 16) throw new Error("invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Silence unused-import warning -- the promisified helper exists for
// callers who don't need the explicit-opts path.
void scrypt;
