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

import { existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";
import { type EncryptedEntry, decryptEntry, deriveKey, encryptEntry, generateSalt } from "./secrets-crypto.js";

export const SECRETS_FILENAME = "secrets.json";
export const SECRETS_SCHEMA_VERSION = 1;

export interface VaultFile {
  version: number;
  salt: string; // base64
  entries: Record<string, EncryptedEntry>;
}

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
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log("warn", "Failed to read vault", { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("warn", "Vault file is not valid JSON", { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.salt !== "string" || !obj.entries || typeof obj.entries !== "object") return null;
  return {
    version: typeof obj.version === "number" ? obj.version : SECRETS_SCHEMA_VERSION,
    salt: obj.salt,
    entries: obj.entries as Record<string, EncryptedEntry>,
  };
}

export async function saveVault(path: string, vault: VaultFile): Promise<void> {
  const tmpDir = dirname(path);
  // mkdir handled by atomicWriteFile -> writeFileAtomic which doesn't
  // currently mkdir. atomic-write.ts in this repo wraps fs.rename atop
  // a temp file in the same dir; if the dir is missing, that fails.
  // Use atomicWriteFile and let the caller ensure the dir exists.
  void tmpDir;
  await atomicWriteFile(path, `${JSON.stringify(vault, null, 2)}\n`);
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
 *  salt changed, the caller must lock() first to clear the stale key. */
export async function unlock(vault: VaultFile, passphrase: string): Promise<Buffer> {
  if (cachedKey && cachedSalt === vault.salt) return cachedKey;
  const salt = Buffer.from(vault.salt, "base64");
  const key = await deriveKey(passphrase, salt);
  cachedKey = key;
  cachedSalt = vault.salt;
  return key;
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
  return {
    ...vault,
    entries: {
      ...vault.entries,
      [name]: encryptEntry(value, key),
    },
  };
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
