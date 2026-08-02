// Cross-session persistence for session-scoped signal (learning +
// detected packs + learned tool lists). Stored at `~/.yaw-mcp/state.json`.
// Pure functions — ConnectServer owns the load/save lifecycle.
//
// Design principles:
//   - Silent failure. A corrupt or unreadable state file must never
//     prevent yaw-mcp from starting. Missing file returns empty state;
//     parse errors log once and also return empty state.
//   - Schema-versioned. An UNREADABLE version drops the old state
//     entirely rather than trying to migrate — the signal is small and
//     cheap to rebuild, and migration bugs would corrupt fresh data. A
//     purely ADDITIVE bump (v1 -> v2 added `toolCache`) is the one case
//     that migrates instead, since there is no field to reinterpret:
//     the missing key simply reads as empty. See READABLE_STATE_VERSIONS.
//   - Privacy-conserving. Only namespace names, tool names, and tool
//     descriptions (all schema identifiers published by the upstream
//     server, not user inputs) are persisted. No tool arguments,
//     response payloads, or credentials ever touch disk.
//   - Bounded. The tool cache is capped on both read and write — see
//     the TOOLCACHE_* limits — so a long-lived install can't grow
//     state.json without limit.
//   - Atomic writes. Write-rename so a crash mid-flush can't leave
//     half-written JSON where the loader would see garbage.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { setJsonKey } from "./json-key.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

export const STATE_SCHEMA_VERSION = 2;
export const STATE_FILENAME = "state.json";

// Versions loadState will still read. v1 is identical to v2 minus the
// `toolCache` key, so it migrates for free: the user keeps the learning
// and pack signal they already earned, and the tool cache starts empty
// (one final pre-warm repopulates it). The first save rewrites the file
// at STATE_SCHEMA_VERSION.
const READABLE_STATE_VERSIONS: ReadonlySet<number> = new Set([1, STATE_SCHEMA_VERSION]);

/** True when loadState can read a state file carrying this `version`.
 *  Exported so callers that peek at the raw file (doctor, reset-learning)
 *  can classify it the same way the loader does instead of comparing
 *  against STATE_SCHEMA_VERSION alone. */
export function isReadableStateVersion(version: unknown): boolean {
  return typeof version === "number" && READABLE_STATE_VERSIONS.has(version);
}

export interface PersistedLearningUsage {
  dispatched: number;
  succeeded: number;
  lastUsedAt: number;
}

export interface PersistedPackCall {
  namespace: string;
  toolName: string;
  at: number;
}

/** One tool as learned from a live upstream handshake. Mirrors the shape
 *  of `UpstreamServerConfig.toolCache` entries so the two are
 *  interchangeable at the call sites that read either. */
export interface PersistedTool {
  name: string;
  description?: string;
}

/** A namespace's learned tool list plus when it was learned. `learnedAt`
 *  drives both TTL expiry and the eviction order when the namespace cap
 *  is exceeded. */
export interface PersistedToolCacheEntry {
  tools: PersistedTool[];
  learnedAt: number;
}

// Bounds on the persisted tool cache. Without these, state.json grows with
// every server a user ever activates and never shrinks. Applied on BOTH
// load and save so a hand-edited or older oversized file is trimmed on the
// way in, not just on the way out.
/** Keep at most this many namespaces — the most recently learned win. */
export const TOOLCACHE_MAX_NAMESPACES = 64;
/** Keep at most this many tools per namespace. */
export const TOOLCACHE_MAX_TOOLS_PER_NAMESPACE = 512;
/** Truncate a tool description past this many characters. Real MCP
 *  descriptions run 80-150 chars, so this only bites on pathological input. */
export const TOOLCACHE_MAX_DESCRIPTION_CHARS = 2000;
/** Drop entries older than this. Bounds staleness: a server that gained or
 *  renamed tools gets re-learned by the next pre-warm after expiry. */
export const TOOLCACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface PersistedState {
  version: number;
  savedAt: number;
  learning: Record<string, PersistedLearningUsage>;
  packHistory: PersistedPackCall[];
  /** Learned tool lists keyed by namespace. Added in schema v2; absent in
   *  a v1 file, which reads as `{}`. */
  toolCache: Record<string, PersistedToolCacheEntry>;
}

export function statePath(configDir: string = userConfigDir()): string {
  return path.join(configDir, STATE_FILENAME);
}

export function emptyState(): PersistedState {
  return { version: STATE_SCHEMA_VERSION, savedAt: 0, learning: {}, packHistory: [], toolCache: {} };
}

// Load persisted state from disk. Always returns a PersistedState
// object — on any failure (missing file, bad JSON, version mismatch,
// sanitization drops everything) we silently fall through to empty.
export async function loadState(filePath: string = statePath()): Promise<PersistedState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    if (!isReadableStateVersion((parsed as { version?: unknown }).version)) return emptyState();
    const p = parsed as Record<string, unknown>;
    return {
      version: STATE_SCHEMA_VERSION,
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
      learning: sanitizeLearning(p.learning),
      packHistory: sanitizePackHistory(p.packHistory),
      // Absent on a v1 file -> sanitizeToolCache(undefined) -> {}. That IS
      // the v1 -> v2 migration; no other field changed shape.
      toolCache: sanitizeToolCache(p.toolCache),
    };
  } catch (err) {
    if (isFileNotFound(err)) return emptyState();
    log("warn", "Failed to load yaw-mcp state, starting fresh", { error: errorMessage(err) });
    return emptyState();
  }
}

// In-process serializer. Two saveState calls debounced too close in time
// would otherwise race -- both would mkdir, both would write to distinct
// .tmp- files (the pid-timestamp suffix makes the temp names unique),
// and both would rename onto the same target. Atomic-rename means we
// never see torn JSON, but the loser's increments are silently dropped.
// Chaining via this promise serializes the writes; the .catch reset
// keeps a failed save from poisoning the chain for subsequent callers.
//
// The cross-process race (two yaw-mcp instances writing the same file) is
// a separate problem that needs an OS-level file lock; not handled here.
let saveChain: Promise<void> = Promise.resolve();

// Save persisted state to disk atomically. Best-effort -- failures log
// but never throw, since a missing save shouldn't crash the session.
// `toolCache` is optional so the many callers that only carry learning +
// pack history (tests, and any future partial writer) keep compiling; an
// omitted cache persists as `{}` rather than silently preserving whatever
// was on disk -- the caller always owns the full snapshot.
export type SavableState = Pick<PersistedState, "learning" | "packHistory"> &
  Partial<Pick<PersistedState, "toolCache">>;

export function saveState(state: SavableState, filePath: string = statePath()): Promise<void> {
  const next = saveChain.then(() => doSaveState(state, filePath));
  saveChain = next.catch(() => undefined);
  return next;
}

async function doSaveState(state: SavableState, filePath: string): Promise<void> {
  const payload: PersistedState = {
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
    learning: state.learning,
    packHistory: state.packHistory,
    // Sanitize on the way out too: the caps must hold for the bytes we
    // WRITE, not merely for what a later load is willing to read back.
    toolCache: sanitizeToolCache(state.toolCache),
  };
  try {
    await atomicWriteFile(filePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    log("warn", "Failed to save yaw-mcp state", { error: errorMessage(err) });
  }
}

function sanitizeLearning(input: unknown): Record<string, PersistedLearningUsage> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, PersistedLearningUsage> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!k) continue;
    if (!v || typeof v !== "object") continue;
    const u = v as Record<string, unknown>;
    if (typeof u.dispatched !== "number" || !Number.isFinite(u.dispatched) || u.dispatched < 0) continue;
    if (typeof u.succeeded !== "number" || !Number.isFinite(u.succeeded) || u.succeeded < 0) continue;
    if (typeof u.lastUsedAt !== "number" || !Number.isFinite(u.lastUsedAt) || u.lastUsedAt < 0) continue;
    // succeeded cannot exceed dispatched — clamp rather than reject so we
    // salvage otherwise-valid entries from corrupted/hand-edited state files.
    const succeeded = Math.min(u.succeeded, u.dispatched);
    // setJsonKey, not out[k]: k comes from a parsed (and per the comment
    // above, possibly hand-edited) state file, and plain assignment to
    // "__proto__" would drop the entry AND repoint `out`'s prototype at it.
    setJsonKey(out, k, { dispatched: u.dispatched, succeeded, lastUsedAt: u.lastUsedAt });
  }
  return out;
}

function sanitizePackHistory(input: unknown): PersistedPackCall[] {
  if (!Array.isArray(input)) return [];
  const out: PersistedPackCall[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.namespace !== "string" || !c.namespace) continue;
    if (typeof c.toolName !== "string" || !c.toolName) continue;
    if (typeof c.at !== "number" || !Number.isFinite(c.at) || c.at < 0) continue;
    out.push({ namespace: c.namespace, toolName: c.toolName, at: c.at });
  }
  return out;
}

/**
 * Coerce the persisted tool cache into shape, dropping anything malformed
 * and enforcing every TOOLCACHE_* bound.
 *
 * Drops, in order: non-object input, entries with a blank namespace, a
 * non-object body, or a non-finite/negative `learnedAt`; entries older than
 * TOOLCACHE_TTL_MS; tools without a usable name; entries left with zero
 * tools (an empty cache is indistinguishable from no cache downstream, and
 * persisting one would make pre-warm skip a server forever without ever
 * surfacing its tools). Survivors are then trimmed to the most recently
 * learned TOOLCACHE_MAX_NAMESPACES.
 *
 * `now` is injectable so tests can pin TTL behavior without faking timers.
 */
function sanitizeToolCache(input: unknown, now: number = Date.now()): Record<string, PersistedToolCacheEntry> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const kept: Array<[string, PersistedToolCacheEntry]> = [];
  for (const [namespace, value] of Object.entries(input as Record<string, unknown>)) {
    if (!namespace) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const learnedAt = entry.learnedAt;
    if (typeof learnedAt !== "number" || !Number.isFinite(learnedAt) || learnedAt < 0) continue;
    // A future timestamp (clock skew, a hand-edited file) is kept rather
    // than expired -- `now - learnedAt` is negative, so it can't exceed the
    // TTL. Expiry only ever drops entries that are genuinely old.
    if (now - learnedAt > TOOLCACHE_TTL_MS) continue;
    if (!Array.isArray(entry.tools)) continue;
    const tools: PersistedTool[] = [];
    for (const raw of entry.tools) {
      if (tools.length >= TOOLCACHE_MAX_TOOLS_PER_NAMESPACE) break;
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      if (typeof t.name !== "string" || !t.name) continue;
      const description =
        typeof t.description === "string" ? t.description.slice(0, TOOLCACHE_MAX_DESCRIPTION_CHARS) : undefined;
      tools.push(description === undefined ? { name: t.name } : { name: t.name, description });
    }
    if (tools.length === 0) continue;
    kept.push([namespace, { tools, learnedAt }]);
  }

  // Namespace cap: newest-learned wins. Sorting only when over the cap keeps
  // the common path (a handful of namespaces) allocation-free.
  if (kept.length > TOOLCACHE_MAX_NAMESPACES) {
    kept.sort((a, b) => b[1].learnedAt - a[1].learnedAt);
    kept.length = TOOLCACHE_MAX_NAMESPACES;
  }
  return Object.fromEntries(kept);
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
