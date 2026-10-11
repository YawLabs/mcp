// Cross-session persistence for session-scoped signal (learning +
// detected packs + learned tool lists). Stored at `~/.yaw-mcp/state.json`.
// Functions with no state of their own except `saveChain`, which serializes
// every save in this process; StateSync carries the per-process baseline a
// merging save needs. ConnectServer owns the load/save lifecycle.
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
//     response payloads, or credentials ever touch disk. The tool cache's
//     `configKey` is a hash over env/header KEY NAMES only, never their
//     values (see toolCacheConfigKey in server.ts), so not even a hash of
//     a credential is written. A pre-warm failure's `message` is the
//     activation error text, truncated.
//   - Bounded. The tool cache is capped on both read and write — see
//     the TOOLCACHE_* limits — so a long-lived install can't grow
//     state.json without limit.
//   - Atomic writes. Write-rename so a crash mid-flush can't leave
//     half-written JSON where the loader would see garbage.
//   - Concurrent writers merge. Every yaw-mcp pane saves the same file, so a
//     save takes a cross-process lock, re-reads, and merges its own delta in
//     (see StateSync) rather than overwriting other panes' learning.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { type FileLockOptions, FileLockTimeoutError, withFileLock } from "./file-lock.js";
import { setJsonKey } from "./json-key.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

export const STATE_SCHEMA_VERSION = 2;
export const STATE_FILENAME = "state.json";

/** The env var that turns this whole module off. */
export const DISABLE_PERSISTENCE_ENV = "YAW_MCP_DISABLE_PERSISTENCE";

/**
 * Opt-out for cross-session persistence: `YAW_MCP_DISABLE_PERSISTENCE=1` (or
 * "true") keeps learning + pack history scoped to the current process --
 * nothing is loaded at start, nothing is written on shutdown. Intended for
 * ephemeral/shared environments (CI runners, containers, on-call relief boxes)
 * where a stale state file would lie about recent usage patterns.
 *
 * THE single source of truth for that truthiness rule, and it lives here
 * because this is the module the flag actually disables. Three copies used to
 * exist -- server.ts (process.env), doctor-cmd.ts (injected env), and an
 * open-coded expression in reset-learning-cmd.ts. They agreed, but nothing made
 * them: the first one to start accepting "yes"/"on" would have doctor reporting
 * persistence ON while the server had it OFF, or `reset-learning` deleting the
 * file a running broker still believed it owned.
 *
 * `env` is a parameter rather than a straight `process.env` read because the
 * CLI commands thread an injected environment (doctor's `opts.env`), and a
 * predicate they cannot pass their own env to is a predicate they cannot share.
 * The default is evaluated per call, so a test mutating process.env between
 * calls still gets the current value.
 *
 * The rule, shared with every YAW_MCP_* opt-in (isReadOnlyDiagnostics,
 * isTrustBypassEnabled, isAutoLoadEnabled): TRIMMED, then "1" or
 * case-insensitive "true" is on; anything else, unset and empty included, is
 * off. Trimmed because cmd.exe's `set VAR=1 && ...` keeps the space before
 * `&&`, so the value arrives as "1 " on Windows -- and this predicate was the
 * one copy that did not trim, so persistence stayed ON for exactly that shell.
 */
export function isPersistenceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DISABLE_PERSISTENCE_ENV]?.trim();
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

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
  /** Fingerprint of the launch config the list was learned under (see
   *  toolCacheConfigKey in server.ts). When the configured entry no longer
   *  hashes to it -- a pinned version, an image tag, a flag or an env key
   *  changed -- the list is re-learned at the next pre-warm instead of
   *  being trusted until the weekly refresh. Absent on entries written
   *  before it existed: those stay trusted until their weekly refresh
   *  stamps one. */
  configKey?: string;
  /** `serverInfo.version` the upstream reported when the list was learned.
   *  Informational; invalidation keys on configKey, because the version is
   *  only knowable by spawning the server. */
  serverVersion?: string;
}

/** A startup pre-warm that could not learn a namespace's tools. Persisted so
 *  the NEXT broker -- every pane starts its own -- does not re-spawn the same
 *  failing server (a stopped Docker daemon, a declined credential prompt)
 *  within PREWARM_FAILURE_BACKOFF_MS. Keyed to the config it failed under, so
 *  an edit retries at once; an explicit activate always retries. */
export interface PersistedPrewarmFailure {
  failedAt: number;
  configKey: string;
  message: string;
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
/** Longest fingerprint / version string kept on a tool-cache entry. */
export const TOOLCACHE_MAX_META_CHARS = 128;
/** How long a recorded pre-warm failure suppresses pre-warm of that
 *  namespace in every broker on the machine. One hour: long enough that a
 *  burst of new panes pays one failed spawn instead of one each, short
 *  enough that a server fixed out-of-band (Docker started, a token set)
 *  reappears on its own within the hour. */
export const PREWARM_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
/** Most pre-warm failures kept, and the longest message kept per failure. */
export const PREWARM_FAILURE_MAX_ENTRIES = 64;
export const PREWARM_FAILURE_MAX_MESSAGE_CHARS = 300;

export interface PersistedState {
  version: number;
  savedAt: number;
  learning: Record<string, PersistedLearningUsage>;
  packHistory: PersistedPackCall[];
  /** Learned tool lists keyed by namespace. Added in schema v2; absent in
   *  a v1 file, which reads as `{}`. */
  toolCache: Record<string, PersistedToolCacheEntry>;
  /** Recent startup pre-warm failures keyed by namespace. Optional and
   *  additive -- no schema bump: a v2 reader that predates it drops the key
   *  on its next save, which costs at most one extra failed pre-warm. A
   *  bump would be worse: READABLE_STATE_VERSIONS in an older broker still
   *  running in another pane would discard the WHOLE file. Absent when
   *  empty. */
  prewarmFailures?: Record<string, PersistedPrewarmFailure>;
  /** Set by loadState when the file EXISTS but could not be READ (EACCES,
   *  EBUSY, EISDIR, ...). The state on disk is presumed healthy, so the
   *  caller must not save over it with the empty state returned alongside
   *  this flag -- server.ts leaves persistenceReady false for the session.
   *  Never set for ENOENT/ENOTDIR (no file to protect) or for a
   *  parse/version failure (the file is genuinely unusable; overwriting it
   *  with fresh state is the documented start-over behavior). Never
   *  persisted: saveState builds its own object from the fields it is
   *  handed. */
  loadFailed?: boolean;
}

export function statePath(configDir: string = userConfigDir()): string {
  return path.join(configDir, STATE_FILENAME);
}

export function emptyState(): PersistedState {
  return { version: STATE_SCHEMA_VERSION, savedAt: 0, learning: {}, packHistory: [], toolCache: {} };
}

/** How many entries the FILE carried, counted before sanitization dropped
 *  anything. Zero across the board when there was no file, or when it could
 *  not be read/parsed (nothing was counted, so nothing is claimed). */
export interface RawStateCounts {
  learning: number;
  packHistory: number;
  toolCache: number;
  /** Pre-warm failures the file carried (the optional fourth section; 0 when
   *  the key is absent). Counted like the others so a file whose only content
   *  is failures does not read as empty to a report about deleting it. */
  prewarmFailures: number;
}

const NO_RAW_COUNTS: RawStateCounts = { learning: 0, packHistory: 0, toolCache: 0, prewarmFailures: 0 };

/** loadState's result plus how the file was classified on the way in. */
export interface ClassifiedState {
  state: PersistedState;
  /**
   * Pre-sanitization entry counts (see RawStateCounts). The sanitized `state`
   * is what yaw-mcp will USE; these are what the file HELD, and the two differ
   * whenever an entry was dropped -- a TTL-expired tool cache, a hand-edited
   * learning row with a negative `lastUsedAt`. A caller reporting on a file it
   * is about to delete (reset-learning) must use these, or it tells the user
   * "0 entries removed" about a file that really held five.
   */
  rawCounts: RawStateCounts;
  /**
   * True when the returned state reflects what was actually ON DISK: the file
   * parsed as an object at a readable version, or there was no file at all
   * (nothing to misreport). False when the returned state is the empty
   * fallback standing in for real content we could not use -- an unreadable
   * file, invalid JSON, a non-object root, or an unreadable schema version.
   *
   * Exists so a caller that REPORTS on the file (reset-learning) can tell
   * "0 entries" from "we could not read it" without a second read+parse of
   * the same bytes -- the shape that let the peek's parser drift from this
   * one (a BOM was accepted here and rejected there, so a perfectly good
   * state file was reported as unreadable).
   */
  parsedCleanly: boolean;
}

// Load persisted state from disk. Always returns a PersistedState
// object — on any failure (missing file, bad JSON, version mismatch,
// sanitization drops everything) we silently fall through to empty.
export async function loadState(filePath: string = statePath()): Promise<PersistedState> {
  return (await loadStateClassified(filePath)).state;
}

// loadState plus the parsedCleanly classification. THE single read+parse of
// the state file: loadState is a thin wrapper over this, so a caller that
// needs both cannot end up with two parsers that disagree.
export async function loadStateClassified(filePath: string = statePath()): Promise<ClassifiedState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    // ENOENT: no file. ENOTDIR: a path component is a regular file, so the
    // state file CANNOT exist either -- both mean "nothing to protect",
    // start empty. Same split as grades-cache/config-loader. Clean, not
    // failed: with no file on disk the empty state IS what is there.
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR")
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: true };
    // The file EXISTS but we could not read it -- a transient handle error
    // (win32 AV/indexer EBUSY, EACCES) on a presumed-HEALTHY file. Flag it
    // so the caller does not overwrite real learning/packHistory/toolCache
    // with the empty state we are about to return: without the flag, one
    // transient read error plus one debounced save silently wiped the file.
    //
    // The message describes what THIS function did, not what the caller will
    // do next: it used to promise "state saves are disabled for this session",
    // which is true for server.ts and flatly false for reset-learning, whose
    // very next act is to delete the file.
    log("warn", "Could not read yaw-mcp state file; flagged unreadable so a save cannot overwrite it", {
      error: errorMessage(err),
    });
    return { state: { ...emptyState(), loadFailed: true }, rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
  }
  try {
    // Strip a leading UTF-8 BOM (U+FEFF) before parsing -- same strip
    // parseJsonc (jsonc.ts) does, for the same reason: Notepad on Windows
    // defaults to BOM-prefixed UTF-8, and JSON.parse rejects the BOM. This
    // module explicitly anticipates hand-edited state files (see
    // sanitizeLearning); without the strip, one Notepad save would drop ALL
    // learning, pack history, and tool cache via the empty-state fallback.
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== "object")
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
    // Any version loadState can READ counts as clean, not just the current
    // one: v1 MIGRATES (see READABLE_STATE_VERSIONS), so treating it as
    // unreadable would discard real counts for the one session before the
    // first save rewrites the file.
    if (!isReadableStateVersion((parsed as { version?: unknown }).version))
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
    const p = parsed as Record<string, unknown>;
    return {
      state: {
        version: STATE_SCHEMA_VERSION,
        savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
        learning: sanitizeLearning(p.learning),
        packHistory: sanitizePackHistory(p.packHistory),
        // Absent on a v1 file -> sanitizeToolCache(undefined) -> {}. That IS
        // the v1 -> v2 migration; no other field changed shape.
        toolCache: sanitizeToolCache(p.toolCache),
        ...withPrewarmFailures(sanitizePrewarmFailures(p.prewarmFailures)),
      },
      // Counted off `p`, BEFORE the sanitizers above run: what the file held,
      // not what survived. See RawStateCounts.
      rawCounts: {
        learning: countRawEntries(p.learning),
        packHistory: countRawEntries(p.packHistory),
        toolCache: countRawEntries(p.toolCache),
        prewarmFailures: countRawEntries(p.prewarmFailures),
      },
      parsedCleanly: true,
    };
  } catch (err) {
    // Reached only for a parse failure -- read errors are handled above.
    // The file is genuinely unusable, so starting fresh (and letting the
    // next save replace it) is the intended behavior; no loadFailed flag.
    log("warn", "Failed to load yaw-mcp state, starting fresh", { error: errorMessage(err) });
    return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
  }
}

/** Count entries in a raw (unsanitized) state section: object keys for the
 *  learning/toolCache maps, elements for the packHistory array. Anything that
 *  is not an object or array held no entries, so it counts as 0. */
function countRawEntries(input: unknown): number {
  if (!input || typeof input !== "object") return 0;
  return Array.isArray(input) ? input.length : Object.keys(input).length;
}

// Two layers of serialization guard every save.
//
// IN-PROCESS: `saveChain`. Two saves debounced too close in time would
// otherwise interleave their read-merge-write steps. ONE chain for every
// path, not one per path: the only file anything saves is ~/.yaw-mcp/
// state.json, so per-path granularity would buy nothing. A failed save does
// not poison the chain for subsequent callers.
//
// CROSS-PROCESS: the sidecar lock in file-lock.ts (`state.json.lock`, O_EXCL
// take, stale takeover by rename after STATE_LOCK_STALE_MS, ownership-checked
// release). Every running `yaw-mcp serve` -- one per MCP client pane -- saves
// this same file, and each used to publish the whole document from the
// snapshot it loaded at startup: pane A loads, pane B loads, B saves its
// calls, A saves and B's calls are gone. Now every save takes the lock,
// RE-READS state.json, merges this process's changes into what is on disk,
// writes atomically (tmp+rename) and releases. See StateSync for the merge.
//
// The lock wait is short (STATE_LOCK_WAIT_MS) because a save also runs on
// shutdown, under index.ts's 10s force-exit timer. A wait that runs out is
// NOT a lost save: StateSync keeps its delta and lands it on the next save.
let saveChain: Promise<void> = Promise.resolve();

function chained<T>(fn: () => Promise<T>): Promise<T> {
  const next = saveChain.then(fn);
  saveChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** How long a save waits on another process's live lock. The critical
 *  section is one read and one atomic write -- milliseconds -- so this is
 *  generous for real contention while still bounding a shutdown flush. */
export const STATE_LOCK_WAIT_MS = 1_500;
/** Age past which a state.json.lock is abandoned (crashed holder). */
export const STATE_LOCK_STALE_MS = 10_000;

function stateLockTimeoutMessage(lockPath: string, heldMs: number | null): string {
  const held = heldMs === null ? "" : ` for ${Math.round(heldMs / 1000)}s`;
  return `state.json is locked by another yaw-mcp process (${lockPath}, held${held})`;
}

// What a caller hands a save. `toolCache` and `prewarmFailures` are optional
// so the many callers that only carry learning + pack history (tests, and any
// future partial writer) keep compiling.
export type SavableState = Pick<PersistedState, "learning" | "packHistory"> &
  Partial<Pick<PersistedState, "toolCache" | "prewarmFailures">>;

/**
 * OVERWRITE state.json with `state`, under the cross-process lock. The caller
 * owns the WHOLE document: an omitted cache persists as `{}`, and whatever
 * another process saved is replaced. That is the right primitive for a writer
 * that genuinely means "this is the file now" (tests seeding a fixture) and
 * the wrong one for a running broker -- `yaw-mcp serve` saves through
 * StateSync, which merges instead. Best-effort: failures log but never throw.
 */
export function saveState(
  state: SavableState,
  filePath: string = statePath(),
  lock: FileLockOptions = {},
): Promise<void> {
  return chained(async () => {
    try {
      await withFileLock(filePath, lockOptions(lock), stateLockTimeoutMessage, () =>
        writeStatePayload(buildPayload(state), filePath),
      );
    } catch (err) {
      log("warn", "Failed to save yaw-mcp state", { error: errorMessage(err) });
    }
  });
}

function lockOptions(lock: FileLockOptions): FileLockOptions {
  return {
    lockWaitMs: lock.lockWaitMs ?? STATE_LOCK_WAIT_MS,
    lockStaleMs: lock.lockStaleMs ?? STATE_LOCK_STALE_MS,
    lockTransientMs: lock.lockTransientMs,
  };
}

function buildPayload(state: SavableState): PersistedState {
  return {
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
    // Sanitize on the way out too: the caps must hold for the bytes we
    // WRITE, not merely for what a later load is willing to read back, and
    // they hold for every section -- not only the tool cache -- so the bound
    // on the file is this module's guarantee rather than each writer's.
    learning: capLearning(sanitizeLearning(state.learning)),
    packHistory: capPackHistory(sanitizePackHistory(state.packHistory)),
    toolCache: sanitizeToolCache(state.toolCache),
    ...withPrewarmFailures(sanitizePrewarmFailures(state.prewarmFailures)),
  };
}

async function writeStatePayload(payload: PersistedState, filePath: string): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(payload, null, 2));
}

/** The sections a merge works on. The first three are always present;
 *  `prewarmFailures` keeps the file's absent-when-empty shape (see
 *  withPrewarmFailures), so a PersistedState is a StateSections as-is. */
export interface StateSections {
  learning: Record<string, PersistedLearningUsage>;
  packHistory: PersistedPackCall[];
  toolCache: Record<string, PersistedToolCacheEntry>;
  prewarmFailures?: Record<string, PersistedPrewarmFailure>;
}

/** Union of two failure maps (newer failedAt wins), minus every failure a
 *  learned list at least as new supersedes -- a broker that later LEARNED the
 *  server proves the failure is over, whichever process recorded which.
 *  Exported for tests. */
export function mergePrewarmFailures(
  ours: Record<string, PersistedPrewarmFailure>,
  disk: Record<string, PersistedPrewarmFailure>,
  toolCache: Record<string, PersistedToolCacheEntry>,
): Record<string, PersistedPrewarmFailure> {
  const merged: Record<string, PersistedPrewarmFailure> = {};
  for (const [ns, f] of Object.entries(disk)) setJsonKey(merged, ns, f);
  for (const [ns, f] of Object.entries(ours)) {
    const other = ownValue(merged, ns);
    if (other === undefined || f.failedAt >= other.failedAt) setJsonKey(merged, ns, f);
  }
  const out: Record<string, PersistedPrewarmFailure> = {};
  for (const [ns, f] of Object.entries(merged)) {
    const learned = ownValue(toolCache, ns);
    if (learned !== undefined && learned.learnedAt >= f.failedAt) continue;
    setJsonKey(out, ns, f);
  }
  return out;
}

function ownValue<V>(map: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function packKey(c: PersistedPackCall): string {
  return `${c.namespace}\u0000${c.toolName}\u0000${c.at}`;
}

function countKeys(calls: readonly PersistedPackCall[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(packKey(c), (counts.get(packKey(c)) ?? 0) + 1);
  return counts;
}

/** Decrement `key` in `counts`; true when there was one to take. */
function takeOne(counts: Map<string, number>, key: string): boolean {
  const n = counts.get(key) ?? 0;
  if (n === 0) return false;
  counts.set(key, n - 1);
  return true;
}

/**
 * `disk + (current - baseline)`: apply what changed in this process since
 * `baseline` (the view it last loaded or saved) on top of `disk` (what is in
 * the file NOW, other processes' saves included). Pure; exported for tests.
 *
 * Why a delta and not a sum: `current` already CONTAINS `baseline` -- the
 * in-memory store was seeded from the file at startup -- so adding current
 * totals to disk totals would count every pre-existing observation twice.
 *
 *   - learning: dispatched/succeeded add the delta (succeeded may move DOWN:
 *     the reward grader revises credit with a negative adjustSucceeded), then
 *     clamp to the store's invariants (>= 0, succeeded <= dispatched);
 *     lastUsedAt takes the max. A namespace this process did not touch is
 *     left exactly as the disk has it -- including ABSENT, so a row another
 *     writer removed (`yaw-mcp reset-learning` deleting the file) is not
 *     resurrected from this process's stale copy.
 *   - packHistory: the entries in `current` that `baseline` did not have
 *     (multiset by namespace+tool+timestamp) are appended to the disk list,
 *     skipping any already on disk so a retried save is idempotent; then
 *     stable-sorted by time and capped at PACK_HISTORY_MAX_ENTRIES, newest
 *     kept. Entries the in-memory ring EVICTED are not deletions.
 *   - toolCache: per namespace, the newer `learnedAt` wins. A namespace this
 *     process did not re-learn since `baseline` is not written back over an
 *     absent disk entry, for the same no-resurrection reason as learning.
 *
 * Also used the other way round to refresh the in-memory view after a save:
 * `mergeStateDelta(written, snapshotSaved, memoryNow)` is "what is on disk
 * now, plus anything recorded while the save was in flight".
 */
export function mergeStateDelta(disk: StateSections, baseline: SavableState, current: SavableState): StateSections {
  const learning: Record<string, PersistedLearningUsage> = {};
  for (const [ns, u] of Object.entries(disk.learning)) setJsonKey(learning, ns, { ...u });
  for (const [ns, cur] of Object.entries(current.learning)) {
    const base = ownValue(baseline.learning, ns);
    const dDispatched = cur.dispatched - (base?.dispatched ?? 0);
    const dSucceeded = cur.succeeded - (base?.succeeded ?? 0);
    const touched = dDispatched !== 0 || dSucceeded !== 0 || cur.lastUsedAt > (base?.lastUsedAt ?? -1);
    if (!touched) continue;
    const prev = ownValue(learning, ns) ?? { dispatched: 0, succeeded: 0, lastUsedAt: 0 };
    const dispatched = Math.max(0, prev.dispatched + dDispatched);
    const succeeded = Math.min(dispatched, Math.max(0, prev.succeeded + dSucceeded));
    setJsonKey(learning, ns, { dispatched, succeeded, lastUsedAt: Math.max(prev.lastUsedAt, cur.lastUsedAt) });
  }

  const inBaseline = countKeys(baseline.packHistory);
  const onDisk = countKeys(disk.packHistory);
  const packHistory: PersistedPackCall[] = disk.packHistory.map((c) => ({ ...c }));
  for (const c of current.packHistory) {
    const k = packKey(c);
    if (takeOne(inBaseline, k) || takeOne(onDisk, k)) continue;
    packHistory.push({ namespace: c.namespace, toolName: c.toolName, at: c.at });
  }
  // Stable: equal timestamps keep disk-then-new order.
  packHistory.sort((a, b) => a.at - b.at);

  const toolCache: Record<string, PersistedToolCacheEntry> = {};
  for (const [ns, e] of Object.entries(disk.toolCache)) setJsonKey(toolCache, ns, e);
  for (const [ns, cur] of Object.entries(current.toolCache ?? {})) {
    const diskEntry = ownValue(toolCache, ns);
    if (diskEntry !== undefined) {
      if (cur.learnedAt > diskEntry.learnedAt) setJsonKey(toolCache, ns, cur);
      continue;
    }
    const base = ownValue(baseline.toolCache ?? {}, ns);
    if (base === undefined || cur.learnedAt > base.learnedAt) setJsonKey(toolCache, ns, cur);
  }

  // Pre-warm failures follow the tool cache's rule: a failure this process
  // recorded since `baseline` is new to the file; one it merely carried from
  // its own hydration is not written back over an absent disk entry. Then
  // every failure a learned list (from any process) supersedes is dropped.
  const ourFailures: Record<string, PersistedPrewarmFailure> = {};
  for (const [ns, cur] of Object.entries(current.prewarmFailures ?? {})) {
    const base = ownValue(baseline.prewarmFailures ?? {}, ns);
    if (base === undefined || cur.failedAt > base.failedAt) setJsonKey(ourFailures, ns, cur);
  }
  const prewarmFailures = mergePrewarmFailures(ourFailures, disk.prewarmFailures ?? {}, toolCache);

  return { learning, packHistory: capPackHistory(packHistory), toolCache, ...withPrewarmFailures(prewarmFailures) };
}

/** Hooks a StateSync drives: read this process's live view, and replace it. */
export interface StateSyncHooks {
  /** Snapshot this process's current in-memory state. Called synchronously
   *  inside the lock, so it must not await. */
  exportCurrent(): SavableState;
  /** Replace this process's in-memory learning and pack history with the
   *  merged view (what is on disk now plus anything recorded while the save
   *  was in flight). The merged toolCache and prewarmFailures are offered
   *  too, but StateSync assumes they are NOT adopted: its baseline for those
   *  sections stays this process's own last export. */
  applyMerged(merged: StateSections): void;
}

export interface StateSyncOptions {
  /** Defaults to statePath(), resolved at each save (not at construction),
   *  matching what saveState's default argument always did. */
  filePath?: string;
  lock?: FileLockOptions;
}

/**
 * Merging saver for a long-running process (`yaw-mcp serve`). Holds the
 * BASELINE -- the state this process last loaded from or wrote to disk -- so
 * each save sends only its delta (see mergeStateDelta) instead of overwriting
 * the file with a snapshot that is missing other processes' work.
 *
 * One save: take the in-process chain, take the cross-process lock, re-read
 * state.json, snapshot memory, merge, write atomically, release; then refresh
 * memory from the merged result (so this pane sees other panes' learning) and
 * make the written state the new baseline.
 *
 * The baseline describes THIS process's memory, never the file, so any other
 * writer -- another pane, a saveState overwrite, reset-learning deleting the
 * file -- is just "what is on disk now" to the next merge.
 *
 * A save that cannot complete -- the lock wait ran out, the re-read hit a
 * transient read error, the write failed -- logs ONE line and leaves the
 * baseline where it was, so the whole pending delta rides on the next save.
 * Nothing is dropped and nothing is counted twice. save() never throws.
 */
export class StateSync {
  private baseline: SavableState = { learning: {}, packHistory: [], toolCache: {} };
  private readonly filePath: string | undefined;
  private readonly lock: FileLockOptions;
  private readonly hooks: StateSyncHooks;

  constructor(hooks: StateSyncHooks, opts: StateSyncOptions = {}) {
    this.hooks = hooks;
    this.filePath = opts.filePath;
    this.lock = opts.lock ?? {};
  }

  /** Record what this process loaded at startup. Pass the in-memory view
   *  AFTER hydration (the stores apply their own caps and sorting), not the
   *  raw file, or the first delta is computed against the wrong base. */
  setBaseline(state: SavableState): void {
    this.baseline = cloneSavable(state);
  }

  /** Save this process's pending changes. Resolves true when they reached
   *  disk, false when they are still pending for the next save. */
  save(): Promise<boolean> {
    return chained(() => this.saveLocked());
  }

  private async saveLocked(): Promise<boolean> {
    const filePath = this.filePath ?? statePath();
    let written: { payload: PersistedState; snapshot: SavableState } | null;
    try {
      written = await withFileLock(filePath, lockOptions(this.lock), stateLockTimeoutMessage, async () => {
        const onDisk = await loadStateClassified(filePath);
        // The file exists but could not be read (EBUSY/EACCES): merging into
        // the empty stand-in would overwrite real data. Defer.
        if (onDisk.state.loadFailed) return null;
        const snapshot = cloneSavable(this.hooks.exportCurrent());
        // A file that parsed cleanly (or does not exist) is the base. One that
        // is corrupt or at an unreadable version carries nothing usable, so
        // this process's full view replaces it -- the documented start-over.
        const merged = onDisk.parsedCleanly
          ? mergeStateDelta(onDisk.state, this.baseline, snapshot)
          : mergeStateDelta(emptyState(), { learning: {}, packHistory: [] }, snapshot);
        const payload = buildPayload(merged);
        await writeStatePayload(payload, filePath);
        return { payload, snapshot };
      });
    } catch (err) {
      log("warn", "yaw-mcp state save deferred; pending changes kept for the next save", {
        error: errorMessage(err),
        lockTimeout: err instanceof FileLockTimeoutError,
      });
      return false;
    }
    if (written === null) {
      log("warn", "yaw-mcp state save deferred: state.json could not be re-read; pending changes kept");
      return false;
    }
    // Synchronous from here: nothing can record between the export and the
    // apply, so "recorded while the save was in flight" is exact.
    const refreshed = mergeStateDelta(written.payload, written.snapshot, this.hooks.exportCurrent());
    this.hooks.applyMerged(refreshed);
    // Learning and pack history: memory was just refreshed from the written
    // payload, so the payload is the new base. The tool cache is NOT
    // refreshed into memory (server.ts applyMergedState says why), so its
    // base stays what this process last exported -- basing it on the payload
    // would make a namespace the disk dropped look "newly learned" here on
    // the next save and resurrect it.
    // Pre-warm failures are not refreshed into memory either (a broker's own
    // sweep already ran), so their base is likewise this process's export.
    this.baseline = cloneSavable({
      learning: written.payload.learning,
      packHistory: written.payload.packHistory,
      toolCache: written.snapshot.toolCache,
      prewarmFailures: written.snapshot.prewarmFailures,
    });
    return true;
  }
}

function cloneSavable(s: SavableState): SavableState {
  const learning: Record<string, PersistedLearningUsage> = {};
  for (const [ns, u] of Object.entries(s.learning)) setJsonKey(learning, ns, { ...u });
  const toolCache: Record<string, PersistedToolCacheEntry> = {};
  for (const [ns, e] of Object.entries(s.toolCache ?? {}))
    setJsonKey(toolCache, ns, { ...e, tools: e.tools.map((t) => ({ ...t })) });
  const prewarmFailures: Record<string, PersistedPrewarmFailure> = {};
  for (const [ns, f] of Object.entries(s.prewarmFailures ?? {})) setJsonKey(prewarmFailures, ns, { ...f });
  return { learning, packHistory: s.packHistory.map((c) => ({ ...c })), toolCache, prewarmFailures };
}

/** Most pack-history calls persisted. The same bound PackDetector keeps in
 *  memory (DEFAULT_MAX_HISTORY in pack-detect.ts, not exported -- it is a
 *  constructor default there, and the write-side cap belongs to the module
 *  that owns the file). Newest entries win: the history is append-ordered,
 *  so the tail is what the detector would have kept. */
export const PACK_HISTORY_MAX_ENTRIES = 100;

/** Most learning namespaces persisted. Learning is keyed by namespace and a
 *  namespace is one installed server, so this is comfortably above any real
 *  install; the cap exists so a runaway writer (or a hand-edit) cannot grow
 *  state.json without bound. The most recently USED namespaces are kept,
 *  which is also what makes the learning worth keeping. */
export const LEARNING_MAX_NAMESPACES = 512;

function capPackHistory(history: PersistedPackCall[]): PersistedPackCall[] {
  return history.length > PACK_HISTORY_MAX_ENTRIES ? history.slice(-PACK_HISTORY_MAX_ENTRIES) : history;
}

function capLearning(learning: Record<string, PersistedLearningUsage>): Record<string, PersistedLearningUsage> {
  const entries = Object.entries(learning);
  if (entries.length <= LEARNING_MAX_NAMESPACES) return learning;
  entries.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
  const out: Record<string, PersistedLearningUsage> = {};
  for (const [k, v] of entries.slice(0, LEARNING_MAX_NAMESPACES)) setJsonKey(out, k, v);
  return out;
}

function sanitizeLearning(input: unknown): Record<string, PersistedLearningUsage> {
  // Arrays are rejected outright, exactly like sanitizeToolCache does: without
  // the check, a hand-edited `"learning": [{...}]` walks Object.entries and
  // lands as namespaces literally named "0", "1", "2" -- entries that can
  // never match a real namespace but do occupy the learning map forever.
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
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
 * TOOLCACHE_TTL_MS; tools without a usable name; and entries whose tools ALL
 * failed that name check -- a raw list that collapsed to empty is corruption,
 * not an observation. A GENUINELY empty `tools: []` is KEPT: a
 * resources/prompts-only upstream really does expose zero tools, and dropping
 * that answer is what made pre-warm re-spawn such a server every session (see
 * the inline note at the length check below). Survivors are then trimmed to
 * the most recently learned TOOLCACHE_MAX_NAMESPACES.
 */
function sanitizeToolCache(input: unknown): Record<string, PersistedToolCacheEntry> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  // Read the clock once so every entry is aged against the same instant --
  // a per-entry Date.now() could expire one entry and keep its neighbour
  // across a TTL boundary. This used to be a `now` parameter defaulted to
  // Date.now(), documented as test-injectable, but no caller ever passed
  // one: both call sites hand it a single argument. Tests pin TTL behavior
  // by choosing `learnedAt` relative to Date.now() instead.
  const now = Date.now();
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
    // A GENUINELY empty list is a known state, not a missing one: an upstream
    // that exposes only resources/prompts really does have zero tools, and
    // dropping the entry here (on both the save and the load path) is what
    // made pre-warm re-spawn such a server on every single session start --
    // it could never record the answer it had already paid for.
    //
    // An entry whose tools were ALL rejected above is a different thing:
    // that is a corrupt or hand-edited file, not a zero-tool server, so it
    // is still dropped and re-learned. The raw length is what separates them.
    if (tools.length === 0 && Array.isArray(entry.tools) && entry.tools.length > 0) continue;
    const survivor: PersistedToolCacheEntry = { tools, learnedAt };
    const configKey = metaString(entry.configKey);
    if (configKey !== undefined) survivor.configKey = configKey;
    const serverVersion = metaString(entry.serverVersion);
    if (serverVersion !== undefined) survivor.serverVersion = serverVersion;
    kept.push([namespace, survivor]);
  }

  // Namespace cap: newest-learned wins. Sorting only when over the cap keeps
  // the common path (a handful of namespaces) allocation-free.
  if (kept.length > TOOLCACHE_MAX_NAMESPACES) {
    kept.sort((a, b) => b[1].learnedAt - a[1].learnedAt);
    kept.length = TOOLCACHE_MAX_NAMESPACES;
  }
  return Object.fromEntries(kept);
}

/** A short non-empty string, or undefined. Bounds the optional tool-cache
 *  metadata the way descriptions are bounded. */
function metaString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, TOOLCACHE_MAX_META_CHARS);
}

/** `{ prewarmFailures }` when there is at least one, else `{}` -- the key
 *  is absent rather than empty, so a file (and a loaded state) without any
 *  failure keeps exactly the shape it had before failures were recorded. */
function withPrewarmFailures(failures: Record<string, PersistedPrewarmFailure>): {
  prewarmFailures?: Record<string, PersistedPrewarmFailure>;
} {
  return Object.keys(failures).length > 0 ? { prewarmFailures: failures } : {};
}

/**
 * Coerce persisted pre-warm failures into shape: drop malformed entries and
 * ones older than PREWARM_FAILURE_BACKOFF_MS (they no longer suppress
 * anything), truncate the message, and keep the newest
 * PREWARM_FAILURE_MAX_ENTRIES. A future failedAt (clock skew) is kept, as the
 * tool cache keeps a future learnedAt.
 */
function sanitizePrewarmFailures(input: unknown): Record<string, PersistedPrewarmFailure> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const now = Date.now();
  const kept: Array<[string, PersistedPrewarmFailure]> = [];
  for (const [namespace, value] of Object.entries(input as Record<string, unknown>)) {
    if (!namespace) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const failedAt = v.failedAt;
    if (typeof failedAt !== "number" || !Number.isFinite(failedAt) || failedAt < 0) continue;
    if (now - failedAt > PREWARM_FAILURE_BACKOFF_MS) continue;
    const configKey = metaString(v.configKey);
    if (configKey === undefined) continue;
    const message = typeof v.message === "string" ? v.message.slice(0, PREWARM_FAILURE_MAX_MESSAGE_CHARS) : "";
    kept.push([namespace, { failedAt, configKey, message }]);
  }
  if (kept.length > PREWARM_FAILURE_MAX_ENTRIES) {
    kept.sort((a, b) => b[1].failedAt - a[1].failedAt);
    kept.length = PREWARM_FAILURE_MAX_ENTRIES;
  }
  const out: Record<string, PersistedPrewarmFailure> = {};
  for (const [ns, f] of kept) setJsonKey(out, ns, f);
  return out;
}

/** True for an ENOENT errno -- "the file is not there", as distinct from
 *  "the file is there and something went wrong reading it". Exported because
 *  reset-learning needs exactly this split on its unlink (ENOENT is the benign
 *  nothing-to-reset path, anything else is a real I/O failure) and used to
 *  carry a byte-identical private copy: two predicates that could drift into
 *  disagreeing about which errnos are benign. */
export function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
