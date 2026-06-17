// On-disk vault for Yaw MCP secrets. Stores per-entry encrypted blobs
// at ~/.yaw-mcp/secrets.json (or <project>/.yaw-mcp/secrets.json for
// project-local overrides). The salt sits at the vault level so the
// passphrase-derived key is computed once per session.
//
// File format:
//   {
//     "version": 1,
//     "salt": "<base64>",           // 16 bytes, vault-level
//     "entries": {
//       "<secret-name>": { iv, ciphertext, authTag }  // per-entry
//     }
//   }
//
// Process lifetime: the derived key is cached in module-scoped memory
// so subsequent operations within the same yaw-mcp process don't
// re-prompt. The cache is cleared on `yaw-mcp secrets lock` or on
// process exit -- nothing persists across processes.
//
// Phase 6b ships local-only management. Sync is implemented in
// Phase 6c via the mcp_secrets team-resource on yaw.sh (server gets
// an opaque ciphertext blob; never sees plaintext).

import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";
import { decryptEntry, deriveKey, type EncryptedEntry, encryptEntry, generateSalt } from "./secrets-crypto.js";

export const SECRETS_FILENAME = "secrets.json";
export const SECRETS_SCHEMA_VERSION = 1;

export interface VaultFile {
  version: number;
  salt: string; // base64
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

export function vaultPath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SECRETS_FILENAME);
}

function emptyVault(): VaultFile {
  return {
    version: SECRETS_SCHEMA_VERSION,
    salt: generateSalt().toString("base64"),
    entries: {},
  };
}

export async function loadVault(path: string): Promise<VaultFile | null> {
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
    log("warn", "Failed to read vault", { path, error: err instanceof Error ? err.message : String(err), code });
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("warn", "Vault file is not valid JSON", { path, error: err instanceof Error ? err.message : String(err) });
    throw new Error(`vault at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`vault at ${path} is corrupt: root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.salt !== "string" || !obj.entries || typeof obj.entries !== "object") {
    throw new Error(`vault at ${path} is corrupt: missing or invalid salt/entries`);
  }
  // Validate each entry's shape up front rather than deferring to decrypt
  // time -- a malformed entry (missing/non-string iv/ciphertext/authTag) is
  // a corrupt vault, and surfacing it here gives a clear, named error.
  const entries = obj.entries as Record<string, unknown>;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isEncryptedEntry(entry)) {
      throw new Error(`vault corrupt at entry ${name}`);
    }
  }
  const check = isEncryptedEntry(obj.check) ? obj.check : undefined;
  return {
    version: typeof obj.version === "number" ? obj.version : SECRETS_SCHEMA_VERSION,
    salt: obj.salt,
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
  // atomicWriteFile mkdirs the target dir recursively (atomic-write.ts:19)
  // before writing the temp file, so the caller does NOT need to create
  // the directory first. We DO chmod the dir to 0o700 on POSIX so the
  // vault directory itself isn't group/other-readable -- the file inside
  // is born 0o600 below, but a world-readable parent dir lets others
  // observe its existence and timestamps.
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  if (process.platform !== "win32") {
    try {
      await chmod(dir, 0o700);
    } catch {
      // not critical
    }
  }
  // Born 0o600 so the encrypted vault is never group/other-readable in the
  // window between rename and the chmod below (ciphertext only, but consistent
  // with the token/cookie files). The dirMode: 0o700 closes the same gap
  // for any parent directory atomicWriteFile creates -- belt-and-suspenders
  // alongside the explicit chmod(dir, 0o700) above, which only handles the
  // immediate parent (and only if it already existed).
  await atomicWriteFile(path, `${JSON.stringify(vault, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
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

export function lock(): void {
  if (cachedKey) cachedKey.fill(0); // best-effort zeroize
  cachedKey = null;
  cachedSalt = null;
}

/** Derive the key for the given vault if not cached, else return the
 *  cached one. The salt must match -- if the vault was rotated and the
 *  salt changed, the caller must lock() first to clear the stale key.
 *
 *  Verifies the passphrase BEFORE caching the key, so a wrong passphrase
 *  is rejected loudly instead of silently writing entries under a bad key:
 *    - vault.check present  -> decrypt it; authTag failure => wrong passphrase.
 *    - vault.check absent, but entries exist (legacy vault) -> decrypt the
 *      first entry as a canary; failure => wrong passphrase.
 *    - neither (fresh/empty vault) -> nothing to verify against; accept.
 *      The next setSecret stamps vault.check (via ensureCheck) so the
 *      saved vault carries a token future unlocks verify against. */
export async function unlock(vault: VaultFile, passphrase: string): Promise<Buffer> {
  if (cachedKey && cachedSalt === vault.salt) return cachedKey;
  const salt = Buffer.from(vault.salt, "base64");
  const key = await deriveKey(passphrase, salt);
  verifyKey(vault, key);
  cachedKey = key;
  cachedSalt = vault.salt;
  return key;
}

/** Throw a clear "wrong passphrase" error if `key` does not match the
 *  vault. Uses vault.check when present (back-compat: falls back to the
 *  first existing entry as a canary; no-op when the vault is empty). */
function verifyKey(vault: VaultFile, key: Buffer): void {
  const canary = vault.check ?? Object.values(vault.entries)[0];
  if (!canary) return; // fresh/empty vault -- nothing to verify yet
  try {
    decryptEntry(canary, key);
  } catch {
    throw new Error("wrong passphrase for this vault (decryption failed)");
  }
}

/** Return a vault guaranteed to carry a verification token under `key`.
 *  Encrypts VAULT_CHECK_PLAINTEXT when vault.check is absent; otherwise
 *  returns the vault unchanged. Called on the mutate path so every saved
 *  vault has a check future unlocks can verify against. */
export function ensureCheck(vault: VaultFile, key: Buffer): VaultFile {
  if (vault.check) return vault;
  return { ...vault, check: encryptEntry(VAULT_CHECK_PLAINTEXT, key) };
}

/** True iff an unlock has been performed in this process. */
export function isUnlocked(): boolean {
  return cachedKey !== null;
}

// ---------------------------------------------------------------------
// Public ops -- pure functions over VaultFile + cached key. Callers
// orchestrate load -> unlock -> mutate -> save.
// ---------------------------------------------------------------------

export function listKeys(vault: VaultFile): string[] {
  return Object.keys(vault.entries).sort();
}

export function setSecret(vault: VaultFile, key: Buffer, name: string, value: string): VaultFile {
  if (!name) throw new Error("secret name is required");
  // ensureCheck stamps vault.check on first save so future unlocks can
  // verify the passphrase before caching the derived key.
  return ensureCheck(
    {
      ...vault,
      entries: {
        ...vault.entries,
        [name]: encryptEntry(value, key),
      },
    },
    key,
  );
}

export function removeSecret(vault: VaultFile, name: string): VaultFile {
  if (!(name in vault.entries)) return vault;
  const { [name]: _removed, ...rest } = vault.entries;
  return { ...vault, entries: rest };
}

export function getSecret(vault: VaultFile, key: Buffer, name: string): string | null {
  const entry = vault.entries[name];
  if (!entry) return null;
  return decryptEntry(entry, key);
}

/** Bootstrap a fresh vault when no file exists yet. */
export function newVault(): VaultFile {
  return emptyVault();
}

/**
 * Scan an env map for `${secret:NAME}` references and substitute the
 * decrypted vault value for each match. Returns the resolved env.
 *
 * Behavior on misses:
 *   - The referenced secret doesn't exist in the vault: leave the
 *     literal `${secret:NAME}` in place. The child process will then
 *     surface its own "missing env var" or "invalid token" error,
 *     which is louder than yaw-mcp silently passing an empty string.
 *   - The vault entry decrypts cleanly: replace the entire env value
 *     with the secret. Inline composition (e.g. `Bearer ${secret:GH}`)
 *     also works -- the regex replaces just the reference span.
 */
const SECRET_REF_RE = /\$\{secret:([a-zA-Z0-9_.-]+)\}/g;
export function resolveSecretRefs(
  env: Record<string, string>,
  vault: VaultFile,
  key: Buffer,
): { resolved: Record<string, string>; missing: string[] } {
  const missing: string[] = [];
  const decrypted = new Map<string, string>();
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || !v.includes("${secret:")) {
      resolved[k] = v;
      continue;
    }
    resolved[k] = v.replace(SECRET_REF_RE, (full, name: string) => {
      if (decrypted.has(name)) return decrypted.get(name) as string;
      const entry = vault.entries[name];
      if (!entry) {
        if (!missing.includes(name)) missing.push(name);
        return full; // leave literal so the child errors cleanly
      }
      try {
        const value = decryptEntry(entry, key);
        decrypted.set(name, value);
        return value;
      } catch {
        if (!missing.includes(name)) missing.push(name);
        return full;
      }
    });
  }
  return { resolved, missing };
}

/** True iff any env value carries a `${secret:NAME}` reference. */
export function hasSecretRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false;
  for (const v of Object.values(env)) {
    if (typeof v === "string" && v.includes("${secret:")) return true;
  }
  return false;
}
