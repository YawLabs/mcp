// Consent store for PROJECT-scoped bundles.json files.
//
// WHY THIS EXISTS
// ~/.yaw-mcp/bundles.json is the user's OWN file and is always trusted --
// nothing here ever gates it. <project>/.yaw-mcp/bundles.json is a
// different thing entirely: it is typically committed to a repo, so
// cloning a hostile repo and opening an editor in it was enough to make
// yaw-mcp spawn whatever argv that file named, as the user, at startup
// (loadLocalBundles let the project file win, entries default to
// isActive:true, and the server prewarms active servers). Peers gate this
// same surface: Claude Code prompts on .mcp.json, VS Code has Workspace
// Trust, direnv has `direnv allow`.
//
// WHY A STORE AND NOT A PROMPT
// yaw-mcp runs as an MCP *stdio* server spawned by the client, so there is
// no TTY at load time and we cannot ask. Consent is therefore granted
// out-of-band via `yaw-mcp trust` (which does have a TTY) and persisted
// here, then consulted at load time.
//
// WHAT IS PINNED
// The store maps an absolute project bundles.json path -> the SHA-256 of
// that file's EXACT BYTES at the moment trust was granted. Hashing the
// content and not just the path is deliberate: a repo you trusted last
// month can add a malicious server in a later commit, and that must
// re-require consent. A hash mismatch is reported as "changed", which the
// loader treats exactly like "never trusted".
//
// FAIL CLOSED
// This is the security boundary, so a missing / malformed / unreadable
// store means NOTHING is trusted. That is deliberately the OPPOSITE of the
// config loader's permissive fail-open posture (right there, wrong here).
//
// FAILING CLOSED IS ABOUT READS, NOT WRITES
// Denying on an unusable store is right; DISCARDING it is not. A store we
// could not READ (antivirus lock, a stray chmod, EIO) almost certainly still
// holds every grant the user made, so rebuilding it from empty would revoke
// every other project over a transient error -- security state destroyed by
// the very code that exists to protect it. A store we could not PARSE is
// genuinely garbage and there is nothing to preserve. readTrustStore
// therefore reports WHICH of the two happened (`malformedKind`), both deny,
// and only the parse case may be overwritten.

import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

/** Canonical filename for the trust store, inside ~/.yaw-mcp/. */
export const TRUST_FILENAME = "trusted.json";

/** Schema version emitted by current yaw-mcp. */
export const TRUST_SCHEMA_VERSION = 1;

/**
 * Escape hatch for CI / automation: when set to a truthy value the project
 * trust check is skipped entirely and a project bundles.json loads as it
 * did before this gate existed. Opting out means any repo you run yaw-mcp
 * inside can spawn arbitrary commands as you -- only set it where the
 * checkout is already trusted (your own CI, a container you built).
 */
export const TRUST_BYPASS_ENV = "YAW_MCP_TRUST_PROJECT";

/** One granted consent. */
export interface TrustRecord {
  /** Absolute path as resolved when trust was granted (display form -- the
   *  lookup key is the normalized variant, see normalizeTrustKey). */
  path: string;
  /** SHA-256 (hex) of the file's exact bytes at grant time. */
  sha256: string;
  /** ISO-8601 timestamp of the grant. */
  grantedAt: string;
}

/** In-memory view of ~/.yaw-mcp/trusted.json. */
export interface TrustStore {
  version: number;
  /** normalized-path -> record. Never contains a partially-valid entry. */
  entries: Record<string, TrustRecord>;
  /** True when a store file EXISTS but could not be read or parsed. When
   *  this is set, every lookup denies (fail closed) regardless of entries. */
  malformed: boolean;
  /** Human-readable reason for `malformed`; null otherwise. */
  malformedReason: string | null;
  /**
   * WHY the store is unusable; null when it is healthy.
   *
   *   "io"    -- the file exists but could not be READ (EACCES, EPERM, EIO,
   *              EBUSY, EISDIR...). The grants are almost certainly still on
   *              disk and intact, so this store must never be overwritten.
   *   "parse" -- the bytes were read fine but are not valid JSON, or the
   *              root / `trusted` shape is wrong. Nothing recoverable is in
   *              there, so rebuilding over it loses nothing.
   *
   * Both deny every lookup. The distinction only governs WRITES.
   */
  malformedKind: "io" | "parse" | null;
  /** errno of the failed read when `malformedKind` is "io" (e.g. "EACCES").
   *  Null otherwise, and null when the platform reported no code. */
  errorCode: string | null;
}

/**
 * Thrown when a trust-store WRITE is refused because the existing store
 * could not be read. Rebuilding it would silently revoke every project the
 * user approved on the strength of what is usually a transient lock, so the
 * write does not happen and the caller has to tell the user to fix the file.
 * A separate error type (rather than a flag on the result) so a caller that
 * forgets to check cannot accidentally proceed.
 */
export class TrustStoreUnreadableError extends Error {
  /** Absolute path of the store that could not be read. */
  readonly storePath: string;
  /** errno from the failed read, when the platform gave one. */
  readonly code: string | null;
  /** The store's `malformedReason` -- already names the path and the cause. */
  readonly reason: string;
  constructor(storePath: string, reason: string, code: string | null) {
    super(`refusing to write the trust store: ${reason}`);
    this.name = "TrustStoreUnreadableError";
    this.storePath = storePath;
    this.reason = reason;
    this.code = code;
  }
}

/** Absolute path to the trust store for a given home. */
export function trustStorePath(home: string = homedir()): string {
  return join(userConfigDir(home), TRUST_FILENAME);
}

/**
 * Canonical lookup key for a bundles.json path.
 *
 * `resolve` collapses `.`/`..`, makes the path absolute, and (on Windows)
 * rewrites forward slashes to backslashes, so `C:/foo` and `C:\foo` agree.
 * Windows paths are additionally lowercased because the filesystem is
 * case-insensitive there -- without it, `C:\Repo\...` and `c:\repo\...`
 * would be two different trust entries and a user who cd'd in with
 * different casing would be re-prompted. POSIX paths are case-SENSITIVE,
 * so they are left exactly as resolved. Same platform split as
 * paths.ts:normalizeForCompare.
 */
export function normalizeTrustKey(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * SHA-256 (hex) of a bundles.json's exact bytes.
 *
 * Callers should pass the raw Buffer, not a decoded string: decoding to
 * UTF-8 and back is lossy for invalid byte sequences, which would let two
 * different files hash identically. The string overload exists only for
 * tests and for callers that already hold text they produced themselves.
 */
export function hashTrustContent(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Is the CI/automation escape hatch enabled? Same truthiness convention as
 *  YAW_MCP_DISABLE_PERSISTENCE (doctor-cmd.ts:isPersistenceDisabled). */
export function isTrustBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TRUST_BYPASS_ENV];
  return raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
}

function emptyStore(
  kind: "io" | "parse" | null = null,
  reason: string | null = null,
  errorCode: string | null = null,
): TrustStore {
  return {
    version: TRUST_SCHEMA_VERSION,
    entries: {},
    malformed: kind !== null,
    malformedReason: reason,
    malformedKind: kind,
    errorCode,
  };
}

/**
 * Read ~/.yaw-mcp/trusted.json.
 *
 * FAIL CLOSED, unlike every other reader in this codebase: an absent store
 * yields an empty (nothing-trusted) store, and a store that exists but is
 * unreadable / unparseable / structurally wrong yields an empty store with
 * `malformed: true` so callers deny instead of silently proceeding. Strict
 * JSON.parse (not parseJsonc): this file is tool-managed, never hand-edited,
 * so accepting comments would only widen what an attacker can smuggle past
 * a reviewer's eye.
 *
 * `malformedKind` splits the two failures the readFile / JSON.parse boundary
 * already distinguishes: everything readFile rejects (other than ENOENT) is
 * "io", everything after it is "parse". Both deny; only "parse" may be
 * overwritten later. See the FAILING CLOSED IS ABOUT READS note at the top.
 *
 * Individual malformed ENTRIES are dropped (with a log line) rather than
 * poisoning the whole store -- one corrupt record must not silently revoke
 * every other project the user approved.
 */
export async function readTrustStore(home: string = homedir()): Promise<TrustStore> {
  const path = trustStorePath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyStore();
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Trust store unreadable; nothing is trusted", { path, error: msg, code });
    return emptyStore("io", `could not read ${path} (${msg})`, code ?? null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Trust store is not valid JSON; nothing is trusted", { path, error: msg });
    return emptyStore("parse", `${path} is not valid JSON (${msg})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyStore("parse", `${path} root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawEntries = obj.trusted;
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    return emptyStore("parse", `${path} is missing a 'trusted' object`);
  }
  const version = typeof obj.version === "number" ? obj.version : TRUST_SCHEMA_VERSION;
  const entries: Record<string, TrustRecord> = {};
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      log("warn", "Dropping malformed trust entry", { path, key });
      continue;
    }
    const v = value as Record<string, unknown>;
    // A record without a usable hash can never match anything, and treating
    // it as a wildcard would be exactly the bug this module exists to stop.
    if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) {
      log("warn", "Dropping trust entry with a missing or malformed sha256", { path, key });
      continue;
    }
    entries[key] = {
      path: typeof v.path === "string" && v.path.length > 0 ? v.path : key,
      sha256: v.sha256,
      grantedAt: typeof v.grantedAt === "string" ? v.grantedAt : "",
    };
  }
  return { version, entries, malformed: false, malformedReason: null, malformedKind: null, errorCode: null };
}

/** Result of checking one path+content pair against the store. */
export type TrustStatus =
  /** Path is in the store AND the content hash still matches. */
  | "trusted"
  /** Path is in the store but the file's bytes changed since the grant. */
  | "changed"
  /** Path was never granted. */
  | "untrusted"
  /** The store itself is unusable -- deny everything. */
  | "store-unreadable";

/** Classify one path + its exact bytes against an already-loaded store. */
export function trustStatusFor(path: string, contents: Buffer | string, store: TrustStore): TrustStatus {
  if (store.malformed) return "store-unreadable";
  const record = store.entries[normalizeTrustKey(path)];
  if (!record) return "untrusted";
  return record.sha256 === hashTrustContent(contents) ? "trusted" : "changed";
}

/**
 * Is this exact file (path + bytes) trusted? Convenience wrapper that loads
 * the store itself; callers that already hold a store should use
 * `trustStatusFor` so they only read the file once.
 *
 * NOTE: this deliberately ignores TRUST_BYPASS_ENV. The bypass is a
 * LOADER-level policy decision (see local-bundles.ts), not a claim that the
 * file is trusted -- keeping it out of here means `yaw-mcp trust --list`
 * and doctor keep reporting the real state even when the escape hatch is on.
 */
export async function isTrusted(
  path: string,
  contents: Buffer | string,
  opts: { home?: string } = {},
): Promise<boolean> {
  const store = await readTrustStore(opts.home ?? homedir());
  return trustStatusFor(path, contents, store) === "trusted";
}

/** Serialize + atomically persist a store. Mode 0600 (the file records
 *  which paths on this machine are allowed to spawn processes; another
 *  local user must not be able to append to it), parent dir 0700. */
async function writeTrustStore(home: string, entries: Record<string, TrustRecord>): Promise<string> {
  const path = trustStorePath(home);
  const body = { version: TRUST_SCHEMA_VERSION, trusted: entries };
  await atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod unsupported on this filesystem; not fatal.
    }
  }
  return path;
}

/**
 * Record consent for `path` pinned to the hash of `contents`.
 *
 * If the store is UNPARSEABLE we start from an EMPTY set rather than
 * refusing: the file is already unusable (every lookup was denying), so the
 * alternative is a user who can never grant anything again. Callers should
 * surface `storeWasMalformed` so the user knows other grants were dropped.
 *
 * If the store is UNREADABLE this throws TrustStoreUnreadableError and
 * writes nothing. An EACCES/EPERM/EIO/EBUSY at this moment says nothing
 * about the store's contents -- the grants are still there, just behind a
 * lock -- so replacing it would revoke every other approved project because
 * an antivirus scanner happened to hold the file open.
 */
export async function grantTrust(
  path: string,
  contents: Buffer | string,
  opts: { home?: string; now?: () => number } = {},
): Promise<{ storePath: string; record: TrustRecord; storeWasMalformed: boolean }> {
  const home = opts.home ?? homedir();
  const store = await readTrustStore(home);
  if (store.malformedKind === "io") {
    throw new TrustStoreUnreadableError(
      trustStorePath(home),
      store.malformedReason ?? `could not read ${trustStorePath(home)}`,
      store.errorCode,
    );
  }
  // Only the "parse" case reaches here, where there is nothing to preserve.
  const entries = store.malformed ? {} : { ...store.entries };
  const record: TrustRecord = {
    path: resolve(path),
    sha256: hashTrustContent(contents),
    grantedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
  };
  entries[normalizeTrustKey(path)] = record;
  const storePath = await writeTrustStore(home, entries);
  log("info", "Granted project bundles.json trust", { path: record.path, sha256: record.sha256 });
  return { storePath, record, storeWasMalformed: store.malformed };
}

/**
 * Drop consent for `path`. Returns removed:false when the path was not in
 * the store (a no-op revoke is a success -- "make it absent" happened) or
 * when the store is malformed (nothing is trusted anyway, and rewriting it
 * would destroy evidence the user may want to inspect).
 */
export async function revokeTrust(
  path: string,
  opts: { home?: string } = {},
): Promise<{ storePath: string; removed: boolean; storeWasMalformed: boolean }> {
  const home = opts.home ?? homedir();
  const store = await readTrustStore(home);
  const storePath = trustStorePath(home);
  if (store.malformed) return { storePath, removed: false, storeWasMalformed: true };
  const key = normalizeTrustKey(path);
  if (!(key in store.entries)) return { storePath, removed: false, storeWasMalformed: false };
  const entries = { ...store.entries };
  delete entries[key];
  await writeTrustStore(home, entries);
  log("info", "Revoked project bundles.json trust", { path: resolve(path) });
  return { storePath, removed: true, storeWasMalformed: false };
}

/** Every granted record, sorted by display path. Empty when the store is
 *  absent OR malformed (nothing is trusted in either case). */
export async function listTrusted(opts: { home?: string } = {}): Promise<TrustRecord[]> {
  const store = await readTrustStore(opts.home ?? homedir());
  if (store.malformed) return [];
  return Object.values(store.entries).sort((a, b) => a.path.localeCompare(b.path));
}
