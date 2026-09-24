// On-disk vault for Yaw MCP secrets. Stores per-entry encrypted blobs
// at ~/.yaw-mcp/secrets.json -- user-global only. Unlike bundles.json there
// is NO project-local override: vaultPath() below is the single location,
// and nothing walks up from cwd looking for one. The salt sits at the vault
// level so the passphrase-derived key is computed once per session.
//
// File format:
//   {
//     "version": 2,
//     "salt": "<base64>",           // 16 bytes, vault-level
//     "kdf": { "N": 32768, "r": 8, "p": 1 },   // scrypt cost, vault-level
//     "entries": {
//       "<secret-name>": { iv, ciphertext, authTag }  // per-entry
//     },
//     "check": { iv, ciphertext, authTag }  // vault-level verification marker
//                                           // (VAULT_CHECK_PLAINTEXT under the
//                                           // derived key; absent on a vault
//                                           // written before it existed)
//   }
//
// SCHEMA HISTORY
//   v1 -- no `kdf` (the scrypt parameters were a compile-time constant), and
//         entry ciphertexts carried no additional authenticated data, so a
//         blob could be moved between entry names and still decrypt.
//   v2 -- `kdf` recorded in the file, and every ciphertext is bound to the
//         name it is stored under (AAD). A v1 vault is still read: its
//         entries are decrypted without the binding (see decryptBound), and
//         it stays v1 on disk until `secrets rotate` rewrites it. A v2 vault
//         does NOT accept unbound blobs -- that is the point of the bump.
//
// Process lifetime: the derived key is cached in module-scoped memory
// so subsequent operations within the same yaw-mcp process don't
// re-prompt. lock() clears the cache of THE CALLING PROCESS ONLY -- so a
// `yaw-mcp secrets lock` CLI run, being its own short-lived process, cannot
// reach the cache of a yaw-mcp server that is already running (that one
// keeps its key until it exits; see the `lock` entry in secrets-cmd.ts's
// help). Otherwise the cache dies with the process, and nothing persists
// across processes.
//
// The vault is local-only: it is never uploaded anywhere. Every
// operation reads and writes the on-disk file above.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { setJsonKey } from "./json-key.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";
import {
  DEFAULT_KDF,
  decryptEntry,
  deriveKey,
  type EncryptedEntry,
  encryptEntry,
  generateSalt,
  isValidKdfParams,
  type KdfParams,
  LEGACY_KDF,
  normalizePassphrase,
  SALT_LEN,
} from "./secrets-crypto.js";

export const SECRETS_FILENAME = "secrets.json";
export const SECRETS_SCHEMA_VERSION = 2;

/** What a vault that declares NO version is assumed to be. Absent means
 *  "written before the field existed", i.e. the OLDEST schema -- never the
 *  current one, or a v1 vault's unbound ciphertexts would be read under v2
 *  rules and every entry would look corrupt. */
const LEGACY_SCHEMA_VERSION = 1;

/** AAD for the vault-level `check` marker. setSecret refuses a colon in a
 *  name (SECRET_NAME_RE), so no vault this build writes can carry an entry
 *  under this AAD, and the marker and an entry named "check" stay distinct
 *  ciphertexts. (loadVault does not apply SECRET_NAME_RE to stored names, so a
 *  hand-edited file could.) Exported alongside
 *  VAULT_CHECK_PLAINTEXT so a test or a recovery tool can decrypt the marker
 *  the way this module does instead of re-deriving the constant. */
export const VAULT_CHECK_AAD = "yaw-mcp:vault-check";

export interface VaultFile {
  version: number;
  salt: string; // base64
  /** scrypt parameters the vault's key is derived under. Absent on v1
   *  vaults, which were all written with LEGACY_KDF -- the pinned historical
   *  value, NOT whatever DEFAULT_KDF happens to be at read time. */
  kdf?: KdfParams;
  entries: Record<string, EncryptedEntry>;
  /** Vault-level verification token: a fixed known constant encrypted
   *  under the derived key. Lets unlock() detect a wrong passphrase
   *  BEFORE caching the key (instead of silently writing entries under
   *  a bad key). Optional for back-compat with vaults written before
   *  this field existed -- absent => legacy vault, see unlock(). */
  check?: EncryptedEntry;
}

/** Fixed plaintext encrypted into vault.check. A successful decrypt of
 *  the stored check proves the derived key matches the one the vault was
 *  created with -- i.e. the passphrase is correct. */
export const VAULT_CHECK_PLAINTEXT = "yaw-mcp-vault-v1";

/** Thrown by unlock() when the `check` marker does not verify -- it fails to
 *  decrypt, or decrypts to something other than VAULT_CHECK_PLAINTEXT -- but
 *  a real entry succeeds under the same key: the passphrase is RIGHT and the
 *  verification token itself is damaged. Exported so the CLI can attach a
 *  path-specific fix hint by comparing against this constant instead of
 *  sniffing the message text. */
export const VAULT_CHECK_CORRUPT_ERROR =
  'vault verification token ("check") is corrupt -- the passphrase is correct, but the check marker does not verify';

/** Thrown by unlock() when NOTHING in the vault decrypts under the supplied
 *  passphrase. Exported for the same reason as VAULT_CHECK_CORRUPT_ERROR: the
 *  CLI attaches the "forgot it? `secrets reset`" pointer by comparing against
 *  this constant, never by sniffing the message text. */
export const VAULT_WRONG_PASSPHRASE_ERROR = "wrong passphrase for this vault (decryption failed)";

export function vaultPath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SECRETS_FILENAME);
}

/** Thrown by loadVault when one entry's shape is wrong. Carries the entry
 *  NAME as a field so the CLI can render its "delete this key by hand" hint
 *  without regex-matching the message text -- a name holding a newline (a
 *  legacy vault could store one) defeated the sniff and silently dropped the
 *  only actionable part of the error. */
export class VaultEntryCorruptError extends Error {
  readonly entryName: string;
  constructor(entryName: string) {
    super(`vault corrupt at entry ${entryName}`);
    this.name = "VaultEntryCorruptError";
    this.entryName = entryName;
  }
}

/** A non-fatal condition loadVault met on a vault it still returned. Handed to
 *  LoadVaultOptions.onWarning instead of being logged, so a caller with its
 *  own output contract (the CLI's `--json`, where stderr is one JSON object
 *  per line) can render it itself. `message` is the prose loadVault would
 *  otherwise have logged. */
export type VaultLoadWarning = { kind: "check-malformed"; path: string; message: string };

export interface LoadVaultOptions {
  /** When set, loadVault reports through this and logs nothing itself: the
   *  malformed-check warning comes here instead of log("warn"), and the two
   *  failures it otherwise logs before throwing (a non-ENOENT read error, a
   *  file that is not JSON) are thrown without that line. The not-JSON
   *  error's message carries what its line did, the path and the parse
   *  error. The read error does not: it is rethrown as readFile raised it,
   *  and for a read-phase errno (EISDIR, EIO) Node's message names no path,
   *  so a caller that passes this has to name the file itself when it
   *  renders the error -- the CLI's safeLoadVault does, with the error's
   *  `code`. When absent, all three are logged as warn lines -- the server
   *  surface relies on them. */
  onWarning?: (warning: VaultLoadWarning) => void;
}

export async function loadVault(path: string, opts?: LoadVaultOptions): Promise<VaultFile | null> {
  const onWarning = opts?.onWarning;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the only "vault absent" signal; everything else (EACCES,
    // EIO, EISDIR, EPERM, ...) means the file likely exists but we can't
    // read it -- bubble that out so callers don't treat it as "no vault"
    // and overwrite real data.
    if (code === "ENOENT") return null;
    if (!onWarning) {
      log("warn", "Failed to read vault", { path, error: err instanceof Error ? err.message : String(err), code });
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!onWarning) {
      log("warn", "Vault file is not valid JSON", { path, error: err instanceof Error ? err.message : String(err) });
    }
    throw new Error(`vault at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`vault at ${path} is corrupt: root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  // An ARRAY `entries` is refused like a missing one, as the lenient reader
  // in secrets-cmd.ts already does: `[]` otherwise loaded as an empty vault,
  // and `["x"]` failed as "vault corrupt at entry 0", naming a key that is
  // not there.
  if (typeof obj.salt !== "string" || !obj.entries || typeof obj.entries !== "object" || Array.isArray(obj.entries)) {
    throw new Error(`vault at ${path} is corrupt: missing or invalid salt/entries`);
  }
  // The salt is a string (checked above), but a truncated / non-base64 salt
  // would derive the WRONG key and fail every decrypt with an opaque auth-tag
  // error far from here. Decode it and assert the byte length up front (mirrors
  // the per-entry validation below) so a corrupt salt surfaces a clear, named
  // error at load time.
  if (Buffer.from(obj.salt, "base64").length !== SALT_LEN) {
    throw new Error(`vault at ${path} is corrupt: salt (expected ${SALT_LEN} bytes)`);
  }
  // Reject a vault stamped with a schema NEWER than this build understands:
  // reading it under the old reader could silently drop or misinterpret a
  // field a future version added. Equal-or-older loads fine (forward reads
  // stay compatible); only a strictly-greater version is refused.
  // A PRESENT but non-numeric version is corrupt, never "assume current":
  // defaulting it let a hand edit of `"version": 2` to `"version": "2"` walk
  // straight past the newer-schema guard below and be read under this build's
  // rules -- the one thing that guard exists to prevent.
  if (obj.version !== undefined && typeof obj.version !== "number") {
    throw new Error(`vault at ${path} is corrupt: "version" must be a number`);
  }
  if (typeof obj.version === "number" && obj.version > SECRETS_SCHEMA_VERSION) {
    throw new Error(
      `vault at ${path} was written by a newer yaw-mcp (schema version ${obj.version} > ${SECRETS_SCHEMA_VERSION}); upgrade yaw-mcp to read it`,
    );
  }
  // The recorded KDF parameters decide how much memory scrypt allocates and
  // which key comes out, so a present-but-nonsense `kdf` is a corrupt vault,
  // not something to silently fall back from: falling back to the default
  // would derive the wrong key and report a wrong passphrase.
  if (obj.kdf !== undefined && !isValidKdfParams(obj.kdf)) {
    throw new Error(`vault at ${path} is corrupt: invalid kdf parameters`);
  }
  // Validate each entry's shape up front rather than deferring to decrypt
  // time -- a malformed entry (missing/non-string iv/ciphertext/authTag) is
  // a corrupt vault, and surfacing it here gives a clear, named error.
  const entries = obj.entries as Record<string, unknown>;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isEncryptedEntry(entry)) {
      throw new VaultEntryCorruptError(name);
    }
  }
  // A malformed `check` is deliberately NOT fatal the way a malformed entry
  // is: the marker is a verification convenience the next setSecret re-stamps
  // (ensureCheck; removeSecret carries the vault's marker as it found it, so
  // a `remove` in between just leaves it absent a little longer), never user
  // data, so throwing here would lock a user out of intact secrets over a
  // damaged token. But dropping it in total silence is the other extreme --
  // the vault quietly falls back to the legacy any-entry-decrypts path with
  // nothing anywhere saying why. Report it (to onWarning, or as a warn line),
  // then discard it.
  if (obj.check !== undefined && !isEncryptedEntry(obj.check)) {
    const message = "Vault verification token is malformed; ignoring it (the next `yaw-mcp secrets set` re-stamps it)";
    if (onWarning) onWarning({ kind: "check-malformed", path, message });
    else log("warn", message, { path });
  }
  const check = isEncryptedEntry(obj.check) ? obj.check : undefined;
  return {
    version: typeof obj.version === "number" ? obj.version : LEGACY_SCHEMA_VERSION,
    salt: obj.salt,
    ...(isValidKdfParams(obj.kdf) ? { kdf: obj.kdf } : {}),
    entries: obj.entries as Record<string, EncryptedEntry>,
    ...(check ? { check } : {}),
  };
}

/** Structural guard for an EncryptedEntry on the wire (all three fields
 *  must be strings). Does NOT verify base64 validity or decryptability --
 *  that is decrypt's job. */
function isEncryptedEntry(v: unknown): v is EncryptedEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.iv === "string" && typeof e.ciphertext === "string" && typeof e.authTag === "string";
}

export async function saveVault(path: string, vault: VaultFile): Promise<void> {
  // atomicWriteFile mkdirs the target dir recursively before writing the temp
  // file, so the caller does NOT need to create the directory first -- and
  // MUST NOT. dirMode only applies to directories atomicWriteFile itself
  // creates (atomic-write.ts mkdirpWithMode), so an explicit mkdir here
  // would hand it a directory that already exists, make the 0o700 below a
  // no-op, and leave ~/.yaw-mcp born at the umask default (typically 0o755)
  // for the window before the chmod. Letting atomicWriteFile create it means
  // the dir is BORN 0o700 -- which is what secrets-audit.ts's "matching
  // saveVault" note describes.
  //
  // The file is likewise born 0o600, so the encrypted vault is never
  // group/other-readable in the window between rename and the chmod below
  // (ciphertext only, but consistent with the token/cookie files).
  await atomicWriteFile(path, `${JSON.stringify(vault, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
    // Both chmods are best-effort belt-and-suspenders over the birth modes
    // above. The DIRECTORY one is not redundant: atomicWriteFile leaves a
    // PRE-EXISTING ~/.yaw-mcp alone (it will not tighten a directory the user
    // already had), so this is the only thing that narrows one created by an
    // earlier release or by a non-secret yaw-mcp file.
    try {
      await chmod(dirname(path), 0o700);
    } catch {
      // not critical
    }
    try {
      await chmod(path, 0o600);
    } catch {
      // not critical
    }
  }
}

// ---------------------------------------------------------------------
// Module-scoped passphrase cache.
//
// The derived key is held in memory for the lifetime of the yaw-mcp
// process so subsequent operations (set N+1, list, etc.) don't re-
// prompt. Cleared on `lock()`.
// ---------------------------------------------------------------------

let cachedKey: Buffer | null = null;
let cachedSalt: string | null = null;
/** Fingerprint of the passphrase that produced `cachedKey` (see
 *  passphraseFingerprint). Lets a cache hit prove the SUPPLIED passphrase
 *  is the one the cached key came from, without paying scrypt again. */
let cachedFingerprint: Buffer | null = null;

/** Random per-process HMAC key for the passphrase fingerprint. Never
 *  written to disk and regenerated on every process start, so a
 *  fingerprint is meaningless outside the process that made it (and an
 *  attacker who can read this process's memory already has the derived
 *  key, which is strictly worse). */
const FINGERPRINT_HMAC_KEY = randomBytes(32);

/** Cheap, constant-time-comparable stand-in for "which passphrase
 *  produced the cached key". Salt-bound so the same passphrase against a
 *  different vault does not collide. */
function passphraseFingerprint(passphrase: string, salt: string): Buffer {
  return createHmac("sha256", FINGERPRINT_HMAC_KEY).update(salt).update(":").update(passphrase, "utf8").digest();
}

export function lock(): void {
  // Best-effort zeroize of the MODULE's copy only. Callers hold their own
  // copies (see unlock), so this cannot reach -- or corrupt -- a key a
  // caller is still using.
  if (cachedKey) cachedKey.fill(0);
  cachedKey = null;
  cachedSalt = null;
  cachedFingerprint = null;
}

/** Derive the key for the given vault if not cached, else return the
 *  cached one. The cache is keyed on the salt, so a vault with a different
 *  salt (a rotated one) is a cache miss: its key is derived fresh and, once
 *  verified, replaces the cached one. No lock() is needed first; lock() only
 *  zeroizes the cached key, which that replacement drops without filling.
 *
 *  Returns the caller's OWN copy of the key, never the cached Buffer
 *  itself. lock() zero-fills the cached one in place, and a caller that
 *  held that same object across a lock() went on encrypting under 32 zero
 *  bytes -- which encryptEntry accepts, since it only checks the length --
 *  and saved entries no passphrase could ever decrypt, with a green exit
 *  code. No shipped caller sequenced things that way, but the aliasing made
 *  it a one-line refactor away (a lock() added to a shutdown path, rotate's
 *  lock() hoisted above its save). The copy costs 32 bytes per unlock, and
 *  a caller may fill(0) it when done without disturbing the cache.
 *
 *  Verifies the passphrase BEFORE caching the key, so a wrong passphrase
 *  is rejected loudly instead of silently writing entries under a bad key:
 *    - vault.check present  -> decrypt it; authTag failure => wrong passphrase.
 *    - vault.check absent, but entries exist (legacy vault) -> decrypt the
 *      first entry as a canary; failure => wrong passphrase.
 *    - neither (fresh/empty vault) -> nothing to verify against; accept.
 *      The next setSecret stamps vault.check (via ensureCheck) so the
 *      saved vault carries a token future unlocks verify against.
 *
 *  The cache short-circuit ALSO checks the passphrase: it is taken only
 *  when the supplied passphrase fingerprints to the one that produced the
 *  cached key. Otherwise we fall through to the full derive + verify path.
 *  Without that, a long-lived process (the hub resolving ${secret:...} at
 *  spawn time) would accept ANY passphrase once the first unlock had
 *  succeeded. */
export async function unlock(vault: VaultFile, passphrase: string): Promise<Buffer> {
  const fingerprint = passphraseFingerprint(passphrase, vault.salt);
  if (
    cachedKey &&
    cachedSalt === vault.salt &&
    cachedFingerprint &&
    cachedFingerprint.length === fingerprint.length &&
    timingSafeEqual(cachedFingerprint, fingerprint)
  ) {
    return Buffer.from(cachedKey);
  }
  const salt = Buffer.from(vault.salt, "base64");
  // The vault's OWN parameters, not this build's default: a vault written
  // under a different cost factor must keep opening. A vault that records
  // NONE falls back to LEGACY_KDF -- the pinned v1 constant -- rather than
  // DEFAULT_KDF, because DEFAULT_KDF is free to move: reading a kdf-less
  // vault under a raised default derives a different key and reports "wrong
  // passphrase" for a correct one, which is precisely the lockout recording
  // the parameters was meant to prevent.
  const params = vault.kdf ?? LEGACY_KDF;
  let key = await deriveKey(passphrase, salt, params);
  try {
    verifyKey(vault, key);
  } catch (err) {
    // Legacy retry: a vault created before passphrases were NFC-normalized was
    // keyed on the exact bytes the user typed. If those differ from the
    // normalized form (a decomposed accent from a macOS keyboard), give the
    // un-normalized derivation one chance before condemning the passphrase --
    // otherwise this change would lock those users out of their own vault.
    if (normalizePassphrase(passphrase) === passphrase) throw err;
    key.fill(0); // best-effort zeroize the derivation we are discarding
    key = await deriveKey(passphrase, salt, params, false);
    try {
      verifyKey(vault, key);
    } catch {
      key.fill(0);
      throw err; // report the primary (normalized) failure, not the retry's
    }
  }
  cachedKey = key;
  cachedSalt = vault.salt;
  cachedFingerprint = fingerprint;
  return Buffer.from(key);
}

/** May this vault still hold ciphertexts written WITHOUT the entry-name
 *  binding? True only for a pre-v2 file. A v2 vault refusing the unbound form
 *  is what makes the binding a real control: otherwise an attacker could strip
 *  the AAD by swapping in blobs that were never bound. */
function allowsUnboundDecrypt(vault: VaultFile): boolean {
  return vault.version < SECRETS_SCHEMA_VERSION;
}

/** Decrypt `entry` with `aad` bound in, falling back to an UNBOUND decrypt on
 *  a v1 vault (whose ciphertexts predate the binding). Throws the bound
 *  failure when no fallback is allowed. */
function decryptBound(vault: VaultFile, entry: EncryptedEntry, key: Buffer, aad: string): string {
  try {
    return decryptEntry(entry, key, aad);
  } catch (err) {
    if (!allowsUnboundDecrypt(vault)) throw err;
    return decryptEntry(entry, key);
  }
}

/** True iff `entry` decrypts cleanly under `key` (bound to `aad`). Swallows
 *  the auth-tag failure -- callers here only need the boolean. */
function canDecrypt(vault: VaultFile, entry: EncryptedEntry, key: Buffer, aad: string): boolean {
  try {
    decryptBound(vault, entry, key, aad);
    return true;
  } catch {
    return false;
  }
}

/** Throw a clear error if `key` does not match the vault.
 *
 *  A single failed canary is NOT enough to conclude "wrong passphrase":
 *  the canary itself can be the damaged thing, and a structurally-valid
 *  but undecryptable blob survives loadVault (which only type-checks the
 *  three string fields). Condemning the passphrase on that one failure
 *  made every secrets command report "wrong passphrase for this vault"
 *  forever on a vault whose entries were all intact -- with nothing
 *  anywhere pointing at the real culprit.
 *
 *  So: a failure is only reported as a wrong passphrase when NOTHING in
 *  the vault decrypts under the key.
 *    - check present, check decrypts        -> ok.
 *    - check present, check fails, an entry decrypts
 *                                           -> the key is right and the
 *                                              MARKER is corrupt; say so
 *                                              (VAULT_CHECK_CORRUPT_ERROR).
 *    - check absent (legacy vault)          -> any entry that decrypts
 *                                              proves the key; only an
 *                                              all-fail is a wrong
 *                                              passphrase. (The FIRST
 *                                              entry alone is not
 *                                              authoritative -- it can be
 *                                              the corrupt one.)
 *    - nothing to check against (fresh/empty vault) -> accept.
 *
 *  The check marker is DECRYPTED AND COMPARED to VAULT_CHECK_PLAINTEXT, the
 *  same predicate rotateVault uses. Accepting "it decrypted" alone is
 *  equivalent under GCM (the auth tag already proves the plaintext), but the
 *  two verifiers must not disagree: if the cipher were ever changed to a
 *  non-AEAD mode, the looser one would silently accept any key. */
function verifyKey(vault: VaultFile, key: Buffer): void {
  const entries = Object.entries(vault.entries);
  const someEntryDecrypts = (): boolean => entries.some(([name, e]) => canDecrypt(vault, e, key, name));
  if (vault.check) {
    if (checkMarkerMatches(vault, key)) return;
    if (someEntryDecrypts()) throw new Error(VAULT_CHECK_CORRUPT_ERROR);
    throw new Error(VAULT_WRONG_PASSPHRASE_ERROR);
  }
  if (entries.length === 0) return; // fresh/empty vault -- nothing to verify yet
  if (someEntryDecrypts()) return;
  throw new Error(VAULT_WRONG_PASSPHRASE_ERROR);
}

/** True iff the vault's check marker decrypts under `key` AND holds the
 *  expected constant. Shared by verifyKey and rotateVault. */
function checkMarkerMatches(vault: VaultFile, key: Buffer): boolean {
  if (!vault.check) return false;
  try {
    return decryptBound(vault, vault.check, key, VAULT_CHECK_AAD) === VAULT_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Return a vault guaranteed to carry a verification token under `key`.
 *  Encrypts VAULT_CHECK_PLAINTEXT when vault.check is absent; otherwise
 *  returns the vault unchanged. Module-private: setSecret and
 *  createEmptyVault below are its only callers. rotateVault stamps a fresh
 *  marker of its own (a new key needs one), and removeSecret stamps nothing
 *  -- it leaves the marker as it found it, so a check-less vault stays
 *  check-less across a `remove` until the next `set`. */
function ensureCheck(vault: VaultFile, key: Buffer): VaultFile {
  if (vault.check) return vault;
  return { ...vault, check: encryptEntry(VAULT_CHECK_PLAINTEXT, key, VAULT_CHECK_AAD) };
}

/** True iff an unlock has been performed in this process. */
export function isUnlocked(): boolean {
  return cachedKey !== null;
}

/** Does `vault` hold anything a passphrase can be checked AGAINST? A vault
 *  with no check marker and no entries has nothing for unlock() to verify, so
 *  it accepts every passphrase -- and "it unlocked" means nothing there. The
 *  callers that turn checkVaultPassphrase into a claim ("this passphrase is
 *  the vault's": doctor's line, `secrets reset`'s refusal) must skip the
 *  check on such a vault rather than report a match that was never tested. */
export function vaultVerifiesPassphrases(vault: VaultFile): boolean {
  return vault.check !== undefined || Object.keys(vault.entries).length > 0;
}

/** The three answers to "is `passphrase` this vault's passphrase?":
 *    "opens"          -- unlock() succeeds.
 *    "marker-corrupt" -- unlock() fails ONLY because the check marker is
 *                        damaged (VAULT_CHECK_CORRUPT_ERROR: an entry decrypts
 *                        under the key, the marker does not verify -- see
 *                        verifyKey). The passphrase is RIGHT, and nothing
 *                        opens until the marker is repaired
 *                        (vaultCheckCorruptHint); `rotate` refuses that vault
 *                        too -- its unlock() throws the same error before
 *                        rotateVault runs.
 *    "wrong"          -- unlock() fails with VAULT_WRONG_PASSPHRASE_ERROR
 *                        (nothing decrypts), or the passphrase is empty.
 *  Three values rather than a boolean because the callers say different
 *  things in the middle case: doctor must not print a green "unlocks" for a
 *  vault the broker refuses, and `secrets reset` must not send that user to
 *  `rotate`. There is no fourth value for a failure that says nothing about
 *  the passphrase (a key-derivation error): checkVaultPassphrase throws that
 *  instead -- see there. */
export type VaultPassphraseVerdict = "opens" | "marker-corrupt" | "wrong";

/** Which of the three `passphrase` is for `vault`.
 *
 *  One spelling for the CLI: doctor's "does the configured passphrase open it"
 *  line and `secrets reset`'s refusal to move a vault this passphrase already
 *  opens ask the same question, and two hand copies of "unlock, but read the
 *  corrupt-marker error as a right passphrase" drift -- one would read it as
 *  wrong. upstream.ts's verifyVaultPassphrase (the in-session prompt's
 *  pre-flight) routes through here too, and folds a thrown check into false
 *  because it promises never to throw.
 *
 *  THROWS -- rather than answering "wrong" -- when unlock() fails for any
 *  reason other than its two verdict errors: in practice a scrypt failure in
 *  deriveKey (the host cannot allocate the working set). That failure says
 *  nothing about the passphrase, and "wrong" would have doctor print "does
 *  NOT unlock" and `secrets reset` treat the vault as one to move aside.
 *  Thrown, it is "could not check": doctor reports the passphrase line as
 *  unverifiable, and `secrets reset` stops before touching the vault.
 *
 *  A successful unlock() leaves the derived key in the module cache, as any
 *  unlock does; a caller with no further use for it should lock(). Only
 *  meaningful on a vault vaultVerifiesPassphrases() is true for. */
export async function checkVaultPassphrase(vault: VaultFile, passphrase: string): Promise<VaultPassphraseVerdict> {
  if (passphrase.length === 0) return "wrong";
  try {
    (await unlock(vault, passphrase)).fill(0);
    return "opens";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === VAULT_CHECK_CORRUPT_ERROR) return "marker-corrupt";
    if (msg === VAULT_WRONG_PASSPHRASE_ERROR) return "wrong";
    throw err;
  }
}

/** The hand-fix for a corrupt check marker, worded once: the CLI's unlock
 *  error, doctor's passphrase line and `secrets reset`'s refusal all print
 *  it, and they must agree on what to delete. This module cannot name the
 *  file (unlock() never sees the path), so the caller passes it. */
export function vaultCheckCorruptHint(path: string): string {
  return `Your entries are intact: delete the "check" key from ${path} by hand and re-run -- the next \`yaw-mcp secrets set\` re-stamps it.`;
}

/** A fresh, EMPTY vault that already carries its verification marker under
 *  `passphrase` -- what `secrets reset` writes in place of the vault it moves
 *  aside. Of the two vault constructors, the one whose result verifies
 *  passphrases.
 *
 *  newVault() alone is not enough for that: an empty vault with no `check`
 *  has nothing for unlock() to verify against, so it accepts ANY passphrase
 *  and the next `secrets set` would silently establish whatever was typed
 *  then (running the confirm-twice creation prompt a second time). Stamping
 *  the marker here makes the passphrase chosen at reset THE passphrase: the
 *  next command verifies against it. setSecret's ensureCheck path is what
 *  stamps it on a first `set`; this is the same marker without an entry.
 *
 *  Derives under DEFAULT_KDF, which is what newVault() records in the file,
 *  so the recorded parameters and the marker's key agree. Touches neither
 *  disk nor the module key cache; the derived key is zeroed before return. */
export async function createEmptyVault(passphrase: string): Promise<VaultFile> {
  const vault = newVault();
  const key = await deriveKey(passphrase, Buffer.from(vault.salt, "base64"), DEFAULT_KDF);
  try {
    return ensureCheck(vault, key);
  } finally {
    key.fill(0);
  }
}

/**
 * Re-encrypt every entry (and the verification check) under a NEW
 * passphrase. Returns a fresh VaultFile the caller saves atomically; it
 * does NOT touch disk or the module key cache.
 *
 * Crypto discipline -- decrypt-all-BEFORE-write:
 *   1. Decrypt the `check` marker (if present) with `oldKey`. A failure
 *      means the supplied old passphrase is wrong -- throw before any
 *      re-encryption so the caller never overwrites a good vault with a
 *      mis-keyed one.
 *   2. Decrypt EVERY entry into memory. If ANY entry fails to decrypt
 *      (corruption, key mismatch), throw immediately -- nothing is
 *      re-encrypted, so the on-disk vault the caller still holds is
 *      untouched and recoverable. On a vault with a marker the error names
 *      the entry as corrupt, since step 1 proved the passphrase.
 *   3. Only after all plaintext is in hand: generate a fresh salt,
 *      derive `newKey`, and re-encrypt every entry + a fresh check
 *      marker under it.
 *
 * Rotate re-wraps the ENCRYPTION (salt + derived key), not the underlying
 * token VALUES -- a leaked token is still leaked; rotate the token at its
 * source for that.
 *
 * The caller is responsible for zeroizing the decrypted plaintext it can
 * see (the returned vault holds only ciphertext); the local `plaintext`
 * map here is best-effort cleared before return.
 */
export async function rotateVault(vault: VaultFile, oldKey: Buffer, newPassphrase: string): Promise<VaultFile> {
  // Step 1: verify the old key against the check marker first, so a wrong
  // old passphrase aborts loudly before we attempt any entry decrypt.
  if (vault.check && !checkMarkerMatches(vault, oldKey)) {
    throw new Error("rotate aborted: current passphrase is wrong (vault check failed to decrypt)");
  }

  // Step 2: decrypt every entry into memory. Any failure aborts the whole
  // rotation -- the on-disk vault stays untouched.
  //
  // What the failure means depends on step 1. With a marker, step 1 has just
  // PROVED the key, so an entry that fails here is damaged (or was written
  // under another key), and blaming the passphrase would send a user who
  // typed it right to `secrets reset` -- which refuses, because it opens the
  // vault. Only a check-less (legacy) vault leaves the key unproven here.
  const plaintext = new Map<string, string>();
  for (const [name, entry] of Object.entries(vault.entries)) {
    try {
      plaintext.set(name, decryptBound(vault, entry, oldKey, name));
    } catch {
      // Best-effort scrub of whatever we already decrypted before bailing.
      plaintext.clear();
      if (vault.check) {
        throw new Error(
          `rotate aborted: entry "${name}" failed to decrypt, but the passphrase is right (the vault's check marker verifies under it) -- the entry is corrupt, or was written under a different passphrase than the rest of the vault. Remove it (\`yaw-mcp secrets remove ${name}\`), set it again, and re-run rotate.`,
        );
      }
      throw new Error(`rotate aborted: entry "${name}" failed to decrypt under the current passphrase`);
    }
  }

  // Step 3: all plaintext in hand -- derive a fresh key under a new salt
  // and re-encrypt everything (entries + a fresh check marker). Rotate is
  // also the migration path: the rewritten file is stamped with the current
  // schema and this build's KDF parameters, and every ciphertext comes out
  // bound to its entry name.
  const newSalt = generateSalt();
  const newKey = await deriveKey(newPassphrase, newSalt, DEFAULT_KDF);
  try {
    const entries: Record<string, EncryptedEntry> = {};
    for (const [name, value] of plaintext) {
      // setJsonKey, never `entries[name] = ...`: a legally-named "__proto__"
      // secret (SECRET_NAME_RE allows it, and set/get/list/save/load all
      // preserve it) would assign through Object.prototype's inherited
      // setter, create NO own key, and silently vanish from the rotated
      // vault -- destroying it, since the caller then overwrites the file.
      setJsonKey(entries, name, encryptEntry(value, newKey, name));
    }
    return {
      version: SECRETS_SCHEMA_VERSION,
      salt: newSalt.toString("base64"),
      kdf: { ...DEFAULT_KDF },
      entries,
      check: encryptEntry(VAULT_CHECK_PLAINTEXT, newKey, VAULT_CHECK_AAD),
    };
  } finally {
    // Best-effort: drop references to plaintext. Strings can't be wiped in
    // V8, but clearing the map removes our held references promptly.
    plaintext.clear();
    newKey.fill(0);
  }
}

// ---------------------------------------------------------------------
// Public ops -- pure functions over VaultFile + cached key. Callers
// orchestrate load -> unlock -> mutate -> save.
// ---------------------------------------------------------------------

export function listKeys(vault: VaultFile): string[] {
  return Object.keys(vault.entries).sort();
}

/** The ONE spelling of the character class a secret name is drawn from.
 *  SECRET_NAME_RE (anchored, for setSecret and the CLI parser) and
 *  SECRET_REF_RE (the capture group inside `${secret:...}`) are both built
 *  from it below. They used to be two regex literals kept in sync by hand --
 *  the same drift secrets-cmd.ts's name check was pulled back from re-spelling
 *  -- and a class that widened in one and not the other would let a name be
 *  STORED that no reference could ever address, or vice versa. */
const SECRET_NAME_CLASS = "[a-zA-Z0-9_.-]+";

/** Names a `${secret:NAME}` reference can actually address -- the same
 *  character class SECRET_REF_RE captures, anchored. A name outside this
 *  set (spaces, colons, braces) can be stored, but no bundles.json env
 *  value could ever reference it, so setSecret rejects it up front rather
 *  than leaving a permanently-unreachable entry in the vault. */
export const SECRET_NAME_RE = new RegExp(`^${SECRET_NAME_CLASS}$`);

export function setSecret(vault: VaultFile, key: Buffer, name: string, value: string): VaultFile {
  if (!name) throw new Error("secret name is required");
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(
      `invalid secret name "${name}" -- use letters, digits, "_", "." or "-" only; other characters can never be referenced as \${secret:NAME}`,
    );
  }
  // ensureCheck stamps vault.check on first save so future unlocks can
  // verify the passphrase before caching the derived key. The ciphertext is
  // bound to `name` (AAD) so it cannot be moved to another entry later.
  //
  // `kdf` is stamped on the same path, so a vault that recorded none stops
  // being kdf-less the first time it is written to. The value is LEGACY_KDF,
  // not DEFAULT_KDF: the key this entry is being encrypted under came from
  // unlock(), which derived a kdf-less vault under LEGACY_KDF, so that is
  // what the file must record. (`entries` is a computed key in an object
  // literal, which defines an own property -- a "__proto__" secret survives
  // this path; see rotateVault for the one that needed setJsonKey.)
  return ensureCheck(
    {
      ...vault,
      kdf: vault.kdf ?? { ...LEGACY_KDF },
      entries: {
        ...vault.entries,
        [name]: encryptEntry(value, key, name),
      },
    },
    key,
  );
}

export function removeSecret(vault: VaultFile, name: string): VaultFile {
  // Object.hasOwn, not `in`: entries comes from JSON.parse and carries
  // Object.prototype, so `"toString" in entries` is true for every vault.
  if (!Object.hasOwn(vault.entries, name)) return vault;
  const { [name]: _removed, ...rest } = vault.entries;
  return { ...vault, entries: rest };
}

export function getSecret(vault: VaultFile, key: Buffer, name: string): string | null {
  // Own-property check first so an inherited member (`toString`,
  // `constructor`, ...) is reported as absent instead of being handed to
  // decryptEntry as a bogus entry.
  if (!Object.hasOwn(vault.entries, name)) return null;
  const entry = vault.entries[name];
  if (!entry) return null;
  return decryptBound(vault, entry, key, name);
}

/** A fresh, EMPTY vault with NO verification marker -- what a first `secrets
 *  set` starts from when no file exists yet. Until setSecret stamps the marker
 *  (ensureCheck), unlock() has nothing to verify against and accepts ANY
 *  passphrase: right for that first `set`, whose passphrase becomes the
 *  vault's, and wrong for anything that must hold a passphrase from birth.
 *  createEmptyVault is this same vault with the marker already stamped. */
export function newVault(): VaultFile {
  return {
    version: SECRETS_SCHEMA_VERSION,
    salt: generateSalt().toString("base64"),
    // Recorded, never assumed: see KdfParams. A vault that carries its own
    // cost factor keeps opening after the default is raised.
    kdf: { ...DEFAULT_KDF },
    entries: {},
  };
}

/**
 * Scan an env map for `${secret:NAME}` references and substitute the
 * decrypted vault value for each match. Returns the resolved env.
 *
 * Behavior on misses:
 *   - The referenced secret doesn't exist in the vault: leave the
 *     literal `${secret:NAME}` in place and report the name in `missing`.
 *     NOTE: the leave-literal only matters to NON-SPAWN callers. The prod
 *     spawn caller (upstream.ts resolveServerEnv) fail-CLOSES on ANY miss --
 *     it throws on a non-empty `missing` and the child never spawns, so a
 *     literal never reaches a child env. The older "leave it so the child
 *     surfaces its own error" rationale is therefore stale for the spawn
 *     path; resolution there is all-or-nothing. The literal (vs an empty
 *     string) only stays observable to callers that consult `missing`
 *     WITHOUT refusing -- e.g. a values-free scan -- where a literal is the
 *     safer, non-lossy default.
 *   - The vault entry decrypts cleanly: replace the entire env value
 *     with the secret. Inline composition (e.g. `Bearer ${secret:GH}`)
 *     also works -- the regex replaces just the reference span.
 *   - The value carries a `${secret:` that SECRET_REF_RE cannot parse (a
 *     space in the name, a missing `}`, an empty name): the literal stays
 *     in place and the MALFORMED SPAN is reported in `malformed`, so the
 *     spawn caller refuses exactly as it would for an absent name.
 *     hasSecretRefs gates on the `${secret:` substring, so such a value
 *     passes the gate, demands a passphrase, unlocks the vault -- and used
 *     to come out of `replace` untouched with `missing` EMPTY, because the
 *     strict regex simply never matched it. The child was then spawned
 *     with the literal `${secret:gh token}` as its token, and no "missing"
 *     audit event was written either (collectSecretRefNames found no
 *     name). A one-character typo silently broke the fail-closed promise;
 *     a value that passes the gate must now either resolve or be reported.
 *     `malformed` is its OWN list, never folded into `missing`: `missing`
 *     holds secret NAMES and every consumer treats it that way (the audit
 *     trail records each entry as a names-only `secret` field, the refusal
 *     joins it into an error), whereas a malformed span is an arbitrary
 *     slice of an env VALUE -- an unterminated `${secret:DB_PASS@db.host/`
 *     runs to the end of the value and can carry a URL, a password, a
 *     newline. So the span is never returned raw: see MalformedSecretRef
 *     for the two bounded forms it is reduced to.
 */
/** Matches a `${secret:NAME}` reference. Consumed by resolveSecretRefs,
 *  collectSecretRefNames and malformedSecretRefSpans below; exported for the
 *  tests that pin its shape. Production code that only needs the NAMES
 *  referenced in an env map (meta-tools.ts, upstream.ts, doctor-cmd.ts) goes
 *  through collectSecretRefNames rather than importing this, and nothing
 *  should re-declare a local copy: copies of one regex drift.
 *  Global flag => this object carries mutable lastIndex state that every
 *  importer shares. String.matchAll does NOT rescue that: its internal clone
 *  is SEEDED FROM this regex's lastIndex (matchAll only spares the original
 *  from being advanced), so an offset left behind by any `.exec`/`.test`
 *  elsewhere makes the next scan silently skip the head of the string.
 *  Scan with a fresh instance instead --
 *  `new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags)` -- which is what
 *  collectSecretRefNames below does; name-only callers should go through that
 *  helper rather than re-deriving the rule. `String.replace` is the one safe
 *  sharer: on a global regex it zeroes lastIndex before matching and again
 *  after, which is why resolveSecretRefs below can pass this object directly.
 *  Built from SECRET_NAME_CLASS (see SECRET_NAME_RE) rather than spelled as
 *  a literal, so the two can no longer drift apart. */
export const SECRET_REF_RE = new RegExp(`\\$\\{secret:(${SECRET_NAME_CLASS})\\}`, "g");
export function resolveSecretRefs(
  env: Record<string, string>,
  vault: VaultFile,
  key: Buffer,
): {
  resolved: Record<string, string>;
  missing: string[];
  malformed: MalformedSecretRef[];
  /** The decrypted values themselves, keyed by SECRET NAME.
   *
   *  Returned so a caller can redact the bare token as well as the string it
   *  was composed into. `resolved` holds `Bearer <token>` for the documented
   *  `"Authorization": "Bearer ${secret:linear}"` shape, so an upstream that
   *  echoes only the token back -- an `{"error":"invalid_api_key","key":"..."}`
   *  body -- matched nothing, the redactor being exact-substring. Same values,
   *  indexed the other way. */
  values: Record<string, string>;
} {
  const missing: string[] = [];
  const malformed: MalformedSecretRef[] = [];
  const decrypted = new Map<string, string>();
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || !v.includes(SECRET_REF_OPENER)) {
      resolved[k] = v;
      continue;
    }
    resolved[k] = v.replace(SECRET_REF_RE, (full, name: string) => {
      if (decrypted.has(name)) return decrypted.get(name) as string;
      // Own-property lookup: SECRET_REF_RE happily captures `toString`,
      // which `entries[name]` would otherwise resolve off Object.prototype.
      const entry = Object.hasOwn(vault.entries, name) ? vault.entries[name] : undefined;
      if (!entry) {
        if (!missing.includes(name)) missing.push(name);
        return full; // leave literal; reported via `missing` (see doc above)
      }
      try {
        const value = decryptBound(vault, entry, key, name);
        decrypted.set(name, value);
        return value;
      } catch {
        if (!missing.includes(name)) missing.push(name);
        return full;
      }
    });
    // Scanned on the ORIGINAL value, not the resolved one: a decrypted
    // secret could itself contain "${secret:" and must not be mistaken for
    // an unparsed reference. Deduped on the bounded `display` form, which is
    // what every consumer reports.
    for (const span of malformedSecretRefSpans(v)) {
      const ref = describeMalformedSecretRef(span);
      if (!malformed.some((m) => m.display === ref.display)) malformed.push(ref);
    }
  }
  return { resolved, missing, malformed, values: Object.fromEntries(decrypted) };
}

/** The substring hasSecretRefs gates on, and every malformed reference
 *  still starts with. */
const SECRET_REF_OPENER = "${secret:";

/** Prefix on every reported malformed reference, so a reader (or a grep over
 *  the audit log) can tell "this ref failed to PARSE" from "this NAME is not
 *  in the vault" without inspecting the rest of the string. */
export const MALFORMED_REF_MARKER = "<malformed ref>";

/** Cap on how much of a malformed span `display` quotes. An unterminated
 *  reference runs to the end of the env value, which is unbounded; 40
 *  characters is enough to show the opener and the typo next to it. */
export const MALFORMED_REF_MAX_CHARS = 40;

/** A `${secret:...}` span SECRET_REF_RE could not parse, reduced to the two
 *  bounded forms the callers need. The raw span is deliberately NOT a field:
 *  it is a slice of an env VALUE, not a name, and can carry whatever followed
 *  the opener -- a URL, a password, a newline. */
export interface MalformedSecretRef {
  /** For an error message or a diagnostic: MALFORMED_REF_MARKER, then the
   *  span as written with control characters stripped, cut at
   *  MALFORMED_REF_MAX_CHARS (with a `...` when it was). Quotes the typo so
   *  the user can find it in their config. */
  display: string;
  /** For the audit trail, whose `secret` field is a names-only contract:
   *  MALFORMED_REF_MARKER plus the longest prefix of the span's body that IS
   *  legal name text (SECRET_NAME_CLASS), and nothing past it. For
   *  `${secret:gh token}` that is `<malformed ref> gh`; for
   *  `${secret:DB_PASS@db.internal/prod` it is `<malformed ref> DB_PASS`
   *  -- the host never reaches the log. Just the marker when no prefix
   *  parses (`${secret:}`). */
  auditName: string;
}

/** Leading run of legal name characters, for MalformedSecretRef.auditName.
 *  Anchored and non-global, so it carries no lastIndex state. */
const SECRET_NAME_PREFIX_RE = new RegExp(`^${SECRET_NAME_CLASS}`);

/** How much of the name-shaped prefix of a malformed span the audit name and
 *  the display keep. The realistic typo this feature exists for is a VALUE
 *  pasted where a name belongs (`${secret:ghp_...` with the brace dropped):
 *  every character of a classic token is in the name class, so an unbounded
 *  prefix put the whole token into the names-only audit log. Sixteen chars
 *  is enough to recognise which reference is meant and too few to be the
 *  credential. */
const MALFORMED_REF_NAME_CHARS = 16;

function describeMalformedSecretRef(span: string): MalformedSecretRef {
  // Control characters dropped rather than escaped: this string is headed
  // for a terminal, a log line and an MCP error payload, and a raw ESC or
  // newline in any of them can forge a line or a cursor move. C0, DEL and C1
  // by code range, plus Unicode format controls (bidi overrides and isolates,
  // zero-width joiners, BOM) by property -- a right-to-left override in the
  // quoted typo would otherwise redraw the rest of the doctor line.
  let printable = "";
  for (const ch of span) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(ch)) continue;
    printable += ch;
  }
  const body = span.startsWith(SECRET_REF_OPENER) ? span.slice(SECRET_REF_OPENER.length) : "";
  const namePrefix = (SECRET_NAME_PREFIX_RE.exec(body)?.[0] ?? "").slice(0, MALFORMED_REF_NAME_CHARS);
  // Display shows the opener, the bounded name prefix and the first
  // character AFTER it -- the typo itself (`${secret:gh token`, `${secret:DB`
  // with no brace) -- and nothing further: past that point is env-value text
  // that may be a credential. The cut is on code points so it can never end
  // on half of a surrogate pair.
  const printableBody = printable.startsWith(SECRET_REF_OPENER) ? printable.slice(SECRET_REF_OPENER.length) : "";
  const shown = Array.from(printableBody)
    .slice(0, namePrefix.length + 1)
    .join("");
  const truncated = Array.from(printableBody).length > namePrefix.length + 1;
  const clipped = `${SECRET_REF_OPENER}${shown}${truncated ? "..." : ""}`.slice(0, MALFORMED_REF_MAX_CHARS + 3);
  return {
    display: `${MALFORMED_REF_MARKER} ${clipped}`,
    auditName: namePrefix.length > 0 ? `${MALFORMED_REF_MARKER} ${namePrefix}` : MALFORMED_REF_MARKER,
  };
}

/** Every `${secret:` in `value` that is NOT the start of a well-formed
 *  SECRET_REF_RE match, returned as the literal span the user wrote -- from
 *  the opener through the next `}`, or to the end of the value when there is
 *  none. Module-private on purpose: the raw span is unbounded env-value text
 *  (see MalformedSecretRef), so every exported surface goes through
 *  describeMalformedSecretRef first. Fresh RegExp for the same reason
 *  collectSecretRefNames uses one. */
function malformedSecretRefSpans(value: string): string[] {
  const wellFormedAt = new Set<number>();
  const re = new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags);
  for (;;) {
    const m = re.exec(value);
    if (!m) break;
    wellFormedAt.add(m.index);
  }
  const spans: string[] = [];
  let at = value.indexOf(SECRET_REF_OPENER);
  while (at !== -1) {
    if (!wellFormedAt.has(at)) {
      const close = value.indexOf("}", at);
      spans.push(close === -1 ? value.slice(at) : value.slice(at, close + 1));
    }
    at = value.indexOf(SECRET_REF_OPENER, at + SECRET_REF_OPENER.length);
  }
  return spans;
}

/** Distinct malformed `${secret:...}` references across an env map, in their
 *  bounded `display` form (see MalformedSecretRef) -- the values-free
 *  companion to collectSecretRefNames, for the diagnostics that report on
 *  refs without a passphrase: meta-tools.ts's `mcp_connect_secrets` report
 *  (its `malformed` column) and doctor's vault section. Those scan with the
 *  strict regex, so a reference a typo has put outside it is invisible to
 *  them while resolveSecretRefs refuses the spawn over it; this is how they
 *  can name it. */
export function collectMalformedSecretRefs(env: Record<string, string> | undefined): string[] {
  const displays: string[] = [];
  if (!env) return displays;
  for (const v of Object.values(env)) {
    if (typeof v !== "string") continue;
    for (const span of malformedSecretRefSpans(v)) {
      const { display } = describeMalformedSecretRef(span);
      if (!displays.includes(display)) displays.push(display);
    }
  }
  return displays;
}

/** Distinct `${secret:NAME}` names referenced across an env map -- the
 *  values-free half of resolveSecretRefs, and the one scanner every name-only
 *  caller shares: upstream.ts's spawn-time audit, meta-tools.ts's
 *  `mcp_connect_secrets` report and doctor's vault section each carried a
 *  byte-equivalent copy of this loop, agreeing only by luck and each having to
 *  re-derive the fresh-instance rule below.
 *
 *  A fresh RegExp per call rather than the shared SECRET_REF_RE: that object
 *  carries /g, so it holds mutable lastIndex state that every importer shares,
 *  and matchAll SEEDS its internal clone from it -- an offset left behind by an
 *  `.exec`/`.test` elsewhere would make the scan silently skip leading matches,
 *  dropping a referenced secret from the caller's report. Non-string values are
 *  skipped rather than coerced; only a string env value can carry a ref. */
export function collectSecretRefNames(env: Record<string, string> | undefined): Set<string> {
  const names = new Set<string>();
  if (!env) return names;
  const re = new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags);
  for (const v of Object.values(env)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(re)) if (m[1]) names.add(m[1]);
  }
  return names;
}

/** True iff any env value carries the `${secret:` opener. Deliberately
 *  LOOSER than SECRET_REF_RE: a reference a typo has put outside the strict
 *  shape must still trip the gate, because the gate is what routes the value
 *  to resolveSecretRefs -- which then reports what it cannot parse in
 *  `malformed` (see MalformedSecretRef) so the spawn fails closed. A gate
 *  built on the strict regex would wave the malformed literal straight
 *  through to the child instead. */
export function hasSecretRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false;
  for (const v of Object.values(env)) {
    if (typeof v === "string" && v.includes(SECRET_REF_OPENER)) return true;
  }
  return false;
}
