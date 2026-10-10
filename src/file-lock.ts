// Cross-process sidecar lock for a read-modify-write of one small JSON file.
//
// Shared by grades-cache.ts (grades.json, written by one-shot `yaw-mcp audit`
// processes) and persistence.ts (state.json, written by every running
// `yaw-mcp serve` -- one per MCP client pane). Both files are rewritten whole
// by tmp+rename (atomic-write.ts), which stops a torn file but not a
// last-writer-wins overwrite: two processes that each read the pre-write
// file and each publish their own version silently drop one side. The lock
// serializes the read-modify-write so the second writer reads the first
// writer's result before it publishes.
//
// The serializer is a SIDECAR LOCK FILE beside the target, `<path>.lock`,
// taken with `wx` (O_EXCL), which is atomic on POSIX and Windows: two
// processes racing it cannot both win. Same primitive as auto-upgrade.ts's
// install lock, with the same three rules that lock learned the hard way:
//
//   - The holder is not guaranteed to release (an MCP client can tear the
//     process tree down mid-write), so a lock older than the stale age
//     (DEFAULT_LOCK_STALE_MS) is treated as abandoned. The critical section
//     is one read, one stringify and one atomic write -- milliseconds, tens of
//     them on a Windows rename retry -- so ten seconds is three orders of
//     magnitude past any live holder.
//   - A stale lock is stolen by RENAME, never unlink. Two stealers that both
//     unlink cannot tell "I removed the stale file" from "I removed the lock
//     the other stealer just took", and end up inside the critical section
//     together; only one rename of the inode can succeed.
//   - Release is ownership-checked. The lock carries a token this call wrote,
//     and release unlinks only while that token is still there -- otherwise a
//     lock that went stale and was retaken would be pulled out from under its
//     new holder.
//
// A writer waits up to its wait budget on a LIVE lock before giving up with
// a FileLockTimeoutError; what giving up MEANS is the caller's decision
// (grades-cache reports it as exit 3, persistence keeps the pending delta for
// the next save). A release that fails (a Windows AV handle on the lock file)
// leaves it to go stale, so the worst case for the NEXT writer is one
// stale-age wait. A release that SUCCEEDS has a Windows hazard of its own: a
// take landing inside its unlink fails EPERM, not EEXIST, so the take paces
// and retries that errno for up to the transient budget rather than failing
// the write. In-process concurrency rides the same lock -- the second caller
// simply polls until the first releases -- so there is exactly one mechanism
// and one set of rules to reason about.

import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isWin32TransientFsError } from "./atomic-write.js";

/** Sidecar beside the locked file: `<path>.lock`. */
export const LOCK_SUFFIX = ".lock";
/** Age past which a lock is abandoned, not held. See the header above. */
export const DEFAULT_LOCK_STALE_MS = 10_000;
/** Default wait on a LIVE lock. Longer than the stale age on purpose, so
 *  waiting out a crashed holder always fits inside it. Callers with a tighter
 *  budget (persistence.ts, which must not hold up shutdown) pass their own. */
export const DEFAULT_LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;
/** How long the take may keep failing with a transient win32 errno
 *  (isWin32TransientFsError) before that errno is thrown. The usual cause is
 *  the holder's release in flight: a create landing inside its unlink fails
 *  EPERM rather than EEXIST, and one poll later the path is free. A failure
 *  still going after a second is not a release -- it is a directory this
 *  process cannot create files in, and the real errno says so better than
 *  a lock timeout would. The give-up deadline still applies if it is shorter. */
export const DEFAULT_LOCK_TRANSIENT_MS = 1_000;
/** How far ahead of Date.now() a lock's mtime may sit and still count as
 *  "taken just now": filesystem timestamp granularity routinely reports an
 *  mtime a hair ahead of the clock, and without the margin a lock taken
 *  microseconds ago reads as future-dated and is stolen at once. Anything
 *  further ahead is a stepped clock, and a lock no live process on this clock
 *  could have written is stale too. */
const LOCK_FUTURE_SKEW_MS = 5_000;

/** Bumped per lock take so two calls in ONE process never share a token --
 *  the pid alone cannot tell them apart, and the ownership check on release
 *  would then let the first caller unlink the second caller's lock. */
let lockSeq = 0;

/** Timing knobs for one lock acquisition. Production callers pick budgets;
 *  tests shrink them. */
export interface FileLockOptions {
  /** How long to wait on a live lock before throwing FileLockTimeoutError. */
  lockWaitMs?: number;
  /** Age past which a lock is treated as abandoned and stolen. */
  lockStaleMs?: number;
  /** How long the take may keep failing with a transient win32 errno before
   *  that errno is thrown (DEFAULT_LOCK_TRANSIENT_MS). */
  lockTransientMs?: number;
}

/** Thrown when the wait budget ran out on a lock someone else holds. A
 *  distinct class so a caller can tell "busy, try later" from a real I/O
 *  failure (EACCES on the directory) without matching message text. */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  /** How old the lock was at the last look, or null when it had vanished. */
  readonly heldMs: number | null;
  constructor(message: string, lockPath: string, heldMs: number | null) {
    super(message);
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
    this.heldMs = heldMs;
  }
}

/** Create the lock with O_EXCL, carrying `token`. False when someone else
 *  holds it; any other failure (EACCES, a vanished directory) throws, because
 *  a lock this process cannot create sits in the directory the target itself
 *  could not have been written into. The one exception is withFileLock's to
 *  make, not this function's: on Windows it retries a transient errno for up
 *  to the transient budget before letting it through.
 *
 *  `times`, when given, is applied through the HANDLE this call created, after
 *  the token write and before the close -- so it can only ever reach the file
 *  this take made. A path-based utimes after the take could land on a
 *  different holder's lock (see stealStaleLock's restore). Best-effort: a
 *  failed utimes leaves the lock held, merely younger. */
async function takeLock(lockPath: string, token: string, times?: { atime: Date; mtime: Date }): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    await fh.writeFile(token);
    if (times) await fh.utimes(times.atime, times.mtime).catch(() => undefined);
    await fh.close();
  } catch (err) {
    // The O_EXCL open succeeded, so a lock now sits at lockPath and NOBODY
    // will release it: this throw escapes before withFileLock's try/finally
    // is entered, and the next writer would wait the whole stale age on a
    // lock that never held anything. Both the write and the close are inside
    // the guard -- a close failure after a successful write orphans a fully
    // formed lock the same way. Remove it before rethrowing.
    await fh.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

/** Steal an abandoned lock by RENAME (see the header), then discard it. When
 *  the file the rename caught turns out to be LIVE -- another stealer retook
 *  the path with a fresh lock between our stat and our rename -- it is put
 *  back under its own token, O_EXCL so a third taker is never clobbered, and
 *  the caller goes back to waiting on it.
 *
 *  True when the path is (probably) free and the caller should retake it at
 *  once; false when the stale file could not be moved -- on Windows an AV or
 *  indexer handle on it surfaces as EPERM/EBUSY, the same transient hold
 *  atomicWriteFile retries its publish rename around. That is not an error
 *  to throw: the caller waits it out exactly like a live lock, paced and
 *  bounded by its deadline, and either the hold clears and the next steal
 *  lands or the deadline names the lock in its diagnostic.
 *
 *  Exported for the test that pins the live-restore path: the window it
 *  covers (a fresh lock landing between our stat and our rename) cannot be
 *  hit deterministically through a locked write. */
export async function stealStaleLock(lockPath: string, isLive: (ageMs: number) => boolean): Promise<boolean> {
  const stolenPath = `${lockPath}.stale-${process.pid}-${++lockSeq}`;
  try {
    await rename(lockPath, stolenPath);
  } catch (err) {
    // ENOENT: the holder released, or another stealer's rename won. Either
    // way the path may be free now; the caller's next take settles it.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  let holder: { token: string; atime: Date; mtime: Date } | null = null;
  try {
    const st = await stat(stolenPath);
    if (isLive(Date.now() - st.mtimeMs)) {
      holder = { token: await readFile(stolenPath, "utf8"), atime: st.atime, mtime: st.mtime };
    }
  } catch {
    // Vanished under us: nothing to restore.
  }
  if (holder !== null) {
    // EEXIST here means a THIRD process took the path meanwhile. The live
    // holder's lock is then simply gone, and the cost is bounded to one
    // possible lost write in that three-way race -- the pre-lock behavior.
    //
    // The holder's ORIGINAL times ride into the take: the restored file is a
    // NEW file, so without them it carries a fresh mtime and the holder's
    // lease is silently extended by up to the whole stale age -- a crashed
    // holder's lock would then survive one extra round of waiting for every
    // stealer that caught it live. They are applied through the take's own
    // handle, never by path afterwards: once takeLock has closed, the
    // restored holder may already have released and a third process taken
    // the path fresh, and a path-based backdate would age THAT live lock
    // toward stale.
    await takeLock(lockPath, holder.token, { atime: holder.atime, mtime: holder.mtime }).catch(() => false);
  }
  // A failed rm here (an AV or indexer handle on Windows, the same transient
  // hold the rename above can meet) leaves `<lock>.stale-<pid>-<n>` behind.
  // Nothing ever looks for that file again, so it is swept, best-effort, by
  // the next lock take in this directory -- see sweepStaleLitter.
  await rm(stolenPath, { force: true }).catch(() => undefined);
  return true;
}

/** Remove `<lock>.stale-*` siblings older than the stale age: the litter a
 *  stealer leaves when its final rm fails (above). Best-effort and bounded
 *  by age on purpose -- a YOUNG stale-file is another stealer mid-flight,
 *  about to be read for a possible restore, and must not be pulled out from
 *  under it. Every failure is swallowed: this is housekeeping beside the
 *  take, never a reason for the take to fail. */
async function sweepStaleLitter(lockPath: string, staleMs: number): Promise<void> {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.stale-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const litter = join(dir, name);
    try {
      if (now - (await stat(litter)).mtimeMs > staleMs) await rm(litter, { force: true });
    } catch {
      // Gone already, or held open: it stays for the next sweep.
    }
  }
}

/** Unlink the lock -- only while it still carries OUR token. A lock that went
 *  stale and was retaken belongs to its new holder; a read failure gets the
 *  same answer, because nothing is unlinked that this call cannot prove it
 *  owns. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== token) return;
    await rm(lockPath, { force: true });
  } catch {
    // Already gone, or held open by a scanner: it goes stale on its own.
  }
}

/** Run `fn` while holding the sidecar lock for `path` (`<path>.lock`).
 *  `describeTimeout` builds the message of the FileLockTimeoutError thrown
 *  when the wait budget runs out, so each caller can name its own remedy. */
export async function withFileLock<T>(
  path: string,
  opts: FileLockOptions,
  describeTimeout: (lockPath: string, heldMs: number | null) => string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}${LOCK_SUFFIX}`;
  const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const waitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const transientMs = opts.lockTransientMs ?? DEFAULT_LOCK_TRANSIENT_MS;
  const token = `${process.pid}-${++lockSeq}\n`;
  const isLive = (ageMs: number): boolean => ageMs > -LOCK_FUTURE_SKEW_MS && ageMs < staleMs;

  // The lock lives beside the target, so on the first-ever write its
  // directory does not exist yet.
  await mkdir(dirname(path), { recursive: true });
  await sweepStaleLitter(lockPath, staleMs);
  const deadline = Date.now() + waitMs;
  // When the current unbroken run of transient take failures began; null
  // whenever the last take answered normally. See DEFAULT_LOCK_TRANSIENT_MS.
  let transientSince: number | null = null;
  for (;;) {
    let taken: boolean;
    try {
      taken = await takeLock(lockPath, token);
    } catch (err) {
      if (!isWin32TransientFsError(err)) throw err;
      const now = Date.now();
      transientSince ??= now;
      if (now >= deadline || now - transientSince >= transientMs) throw err;
      // No stat or steal. Usually the create itself failed, which says nothing
      // about a lock at the path. Otherwise the create worked and the token
      // write or close after it failed, and takeLock has already removed that
      // half-made lock -- or, if its removal failed too, left a fresh file the
      // next take will meet as EEXIST and wait out like any live lock. Neither
      // leaves anything to judge stale here. Just pace.
      await delay(LOCK_POLL_MS);
      continue;
    }
    if (taken) break;
    transientSince = null;
    let ageMs: number | null;
    try {
      ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch {
      // Vanished between the open and the stat: the holder released, and the
      // next take should win. Still paced and still bounded by the deadline,
      // so a path that keeps flickering cannot spin here forever.
      ageMs = null;
    }
    // A stolen stale lock is retaken at once, unpaced: the path was just
    // freed and nothing is being waited on. A stale lock that would not move
    // (see stealStaleLock) falls through to the same pacing and deadline as
    // a live one, so neither a scanner's handle nor a flickering path can
    // spin here without bound.
    if (ageMs !== null && !isLive(ageMs) && (await stealStaleLock(lockPath, isLive))) continue;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(describeTimeout(lockPath, ageMs), lockPath, ageMs);
    await delay(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
