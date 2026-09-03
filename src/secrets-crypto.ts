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
//                        reasonable entropy. The parameters are RECORDED
//                        IN THE VAULT FILE (see KdfParams below), so a
//                        future cost bump can raise the default while
//                        every existing vault keeps opening under the
//                        parameters it was written with.
//   - Authenticated enc: AES-256-GCM with a per-entry random 12-byte IV.
//                        AuthTag prevents tampering; tampered ciphertexts
//                        fail decrypt before any plaintext is exposed.
//                        The entry NAME is bound in as additional
//                        authenticated data (AAD) -- see encryptEntry.
//
// Per-entry encryption (not one envelope around the whole vault) means:
//   1. Adding/rotating a single secret rewrites only its entry, not the
//      full vault -- smaller diff, smaller torn-write blast radius.
//   2. A corrupt or tampered entry fails to decrypt on its own; the other
//      entries stay readable instead of the whole vault going opaque.
//
// The salt is stored AT THE VAULT LEVEL, not per-entry. All entries
// share the same scrypt-derived key, so the key is derived once per
// passphrase prompt, not once per entry.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";

/** Length in bytes of the derived key. AES-256-GCM needs 32. */
export const KEY_LEN = 32;

/** AES-GCM standard IV size; do NOT change without revisiting NIST guidance. */
export const IV_LEN = 12;

/** Salt size in bytes. 16 is the conventional minimum. */
export const SALT_LEN = 16;

/** scrypt cost parameters. Higher N = slower derivation = better brute-force
 *  resistance, but every CLI command that touches the vault waits for
 *  derivation. 2^15 is a reasonable middle ground (~100ms on commodity
 *  hardware in 2026).
 *
 *  These are PERSISTED next to the salt (secrets-vault.ts VaultFile.kdf)
 *  rather than being a compile-time constant the reader assumes. Without
 *  that, raising the cost factor later needs a schema bump plus a forced
 *  rotate of every vault in the wild, because an existing vault would
 *  silently derive a different key and report "wrong passphrase". */
export interface KdfParams {
  /** scrypt cost factor. Power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
}

/** What a vault created by THIS build is written with. Free to move upward as
 *  hardware gets faster: every vault created or rotated from now on records
 *  the parameters it was written under, and a vault that records NONE is read
 *  under LEGACY_KDF below -- never under this. */
export const DEFAULT_KDF: KdfParams = { N: 1 << 15, r: 8, p: 1 };

/** The parameters every KDF-LESS vault was derived under -- schema v1, written
 *  before `kdf` was recorded in the file, when the cost factor was a
 *  compile-time constant with exactly these values.
 *
 *  This is a HISTORICAL FACT, not a policy knob: THESE VALUES MUST NEVER
 *  CHANGE. unlock() reads a vault with no `kdf` under them, so editing them
 *  re-keys every such vault still in the wild and reports "wrong passphrase
 *  for this vault" for a passphrase that is perfectly correct -- the exact
 *  lockout the recorded-KDF design exists to prevent. Raise DEFAULT_KDF
 *  instead; that only affects vaults written from now on. Frozen so a stray
 *  mutation cannot do it either. */
export const LEGACY_KDF: Readonly<KdfParams> = Object.freeze({ N: 1 << 15, r: 8, p: 1 });

/** Per-field bounds accepted for vault-supplied KDF parameters. These alone
 *  do NOT imply the memory ceiling: scrypt allocates roughly 128 * N * r
 *  bytes, and MAX_KDF_N * MAX_KDF_R multiplies out to 1 GiB -- four times the
 *  documented cap. MAX_KDF_MEMORY_BYTES below is what actually enforces it;
 *  these keep any single field from being absurd. */
const MAX_KDF_N = 1 << 18;
const MAX_KDF_R = 32;
const MAX_KDF_P = 16;

/** The real memory bound, checked against the PRODUCT. An unbounded working
 *  set read out of a file is a memory bomb, and bounding N and r separately
 *  is not the same thing as bounding what they cost together. 256MB is
 *  exactly the worst case the per-field caps were written for (N=2^18 at the
 *  default r=8), so this pins the number the comment always claimed while
 *  still leaving 8x headroom above DEFAULT_KDF for a future cost bump. */
const MAX_KDF_MEMORY_BYTES = 256 * 1024 * 1024;

/** scrypt's approximate working set for a given N and r. */
function kdfMemoryBytes(N: number, r: number): number {
  return 128 * N * r;
}

/** Validate KDF parameters read off disk. Rejects non-integers, zero/negative
 *  values, a non-power-of-two N, anything past a per-field bound, and any
 *  N/r PAIR whose combined working set exceeds MAX_KDF_MEMORY_BYTES. */
export function isValidKdfParams(v: unknown): v is KdfParams {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const { N, r, p } = o;
  if (typeof N !== "number" || typeof r !== "number" || typeof p !== "number") return false;
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 2 || N > MAX_KDF_N || (N & (N - 1)) !== 0) return false; // must be a power of two
  if (r < 1 || r > MAX_KDF_R) return false;
  if (p < 1 || p > MAX_KDF_P) return false;
  if (kdfMemoryBytes(N, r) > MAX_KDF_MEMORY_BYTES) return false;
  return true;
}

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

/** Unicode-normalize a passphrase before it reaches scrypt.
 *
 *  scrypt keys the raw UTF-8 bytes, so the SAME passphrase typed on macOS
 *  (which hands back decomposed NFD for accented characters) and pasted from
 *  a Linux env var (usually composed NFC) derives two different keys, and the
 *  second one reports "wrong passphrase for this vault" with nothing to point
 *  at. NFC is the interchange default, so that is the form the key is derived
 *  from. Exported so unlock() can retry the UN-normalized bytes for a vault
 *  created before this existed under a decomposed passphrase. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFC");
}

/** Derive a 32-byte key from a passphrase + salt via scrypt.
 *
 *  `params` defaults to LEGACY_KDF, NOT DEFAULT_KDF: the only vault whose
 *  parameters a caller can legitimately omit is one that recorded none, and
 *  every such vault was written under LEGACY_KDF. Defaulting to DEFAULT_KDF
 *  would re-key those vaults the day the default is raised. A caller reading
 *  any other existing vault MUST pass the parameters recorded in it, and a
 *  caller CREATING a vault must pass DEFAULT_KDF explicitly. `normalize` is
 *  only turned off for the legacy un-normalized retry described in
 *  normalizePassphrase. */
export async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: KdfParams = LEGACY_KDF,
  normalize = true,
): Promise<Buffer> {
  return scryptCallWithMaxmem(normalize ? normalizePassphrase(passphrase) : passphrase, salt, KEY_LEN, params);
}

async function scryptCallWithMaxmem(
  password: string,
  salt: Buffer,
  keylen: number,
  params: KdfParams,
): Promise<Buffer> {
  // node:crypto's scrypt(password, salt, keylen, opts?) accepts opts.
  // promisify doesn't carry opts cleanly, so we re-implement the
  // promise wrapper to pass N/r/p/maxmem.
  //
  // maxmem scales WITH the parameters: scrypt's own default is far below what
  // N=2^15 needs, and a hardcoded 64MB would start throwing the moment a
  // vault records a higher cost factor. 256 * N * r is 2x the working set.
  // This is a ceiling for node, NOT the security bound -- isValidKdfParams
  // has already refused any pair whose working set exceeds
  // MAX_KDF_MEMORY_BYTES, so nothing reaching here can ask for 2 GiB.
  const maxmem = Math.max(64 * 1024 * 1024, 256 * params.N * params.r);
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
}

/** Encrypt a plaintext string into an EncryptedEntry.
 *
 *  `aad` binds the ciphertext to the name it is stored under. Without it the
 *  blobs are position-independent: anyone who can WRITE secrets.json could
 *  swap the blob under PROD_TOKEN with DEV_TOKEN's and every decrypt still
 *  succeeded, so a spawned server received a different secret than the vault
 *  said it would. With the name as additional authenticated data a moved blob
 *  fails its auth tag. (This does not stop deletion or a whole-file rollback
 *  -- those need a vault-level MAC, which the file format does not have.) */
export function encryptEntry(plaintext: string, key: Buffer, aad?: string): EncryptedEntry {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ct.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/** Decrypt an EncryptedEntry. Throws on tamper / wrong key / corruption --
 *  including an `aad` that does not match the one it was encrypted under. */
export function decryptEntry(entry: EncryptedEntry, key: Buffer, aad?: string): string {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  const iv = Buffer.from(entry.iv, "base64");
  const ct = Buffer.from(entry.ciphertext, "base64");
  const authTag = Buffer.from(entry.authTag, "base64");
  if (iv.length !== IV_LEN) throw new Error("invalid IV length");
  if (authTag.length !== 16) throw new Error("invalid auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
