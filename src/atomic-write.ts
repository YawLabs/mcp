// Atomic file write helper. Writes to a sibling .tmp file then renames
// onto the target -- fs.rename is atomic on the same filesystem on POSIX
// and on modern Windows Node, so a process killed mid-write (SIGINT,
// OOM, antivirus) leaves the original target intact instead of a half-
// written file. The pid+timestamp suffix avoids tmp name collisions
// across concurrent processes; in-process serialization is the caller's
// concern (see persistence.ts:saveState for an example).

import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
  // Optional creation mode for the tmp file. Pass 0o600 for secret-bearing
  // files (token config, session cookie, vault) so the file is born
  // owner-only and never sits at the default-umask perms (often 0644) in the
  // window between rename and a post-hoc chmod. The bits are masked by the
  // process umask like any creat(2); callers that need an exact mode should
  // still chmod afterward as belt-and-suspenders.
  mode?: number,
  // Optional mode for the parent-directory chain. Pass 0o700 for secret-
  // bearing paths (vault, team-session cookie) so newly-created parent
  // directories aren't born group/other-readable -- mkdir(2)'s default of
  // 0o777-&-umask typically lands at 0o755, which lets others list the
  // directory and observe filenames/timestamps of secret files inside.
  // No-op on Windows (POSIX-mode bits aren't meaningful there). Only
  // applies to directories CREATED by this call -- pre-existing parents
  // are left alone (we don't want to tighten the user's $HOME).
  dirMode?: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  // The tmp file is a SIBLING of the target (same directory => same
  // filesystem), so fs.rename is atomic. Atomicity holds ONLY on the same
  // filesystem: a cross-device rename throws EXDEV. We never cross devices
  // here because tmp and target share a dir, but callers must not point
  // filePath at a special/overlay mount whose dirname resolves to a
  // different fs than where the tmp would be written -- that would surface
  // as an EXDEV throw rather than an atomic swap. (If a real cross-device
  // need ever arises, fall back to writeFile-in-place, losing atomicity.)
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdirpWithMode(dir, dirMode);
  try {
    await writeFile(tmp, contents, mode === undefined ? { encoding } : { encoding, mode });
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so we don't leak orphan temp files when the
    // write or rename fails. Swallow the unlink error -- the original
    // failure is what the caller cares about.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * mkdir -p with an optional POSIX mode applied to every directory we
 * actually CREATE (pre-existing parents are not re-chmodded -- we don't
 * want to tighten the user's $HOME just because we wrote a vault under it).
 * Walks the path from root to leaf, stat-then-mkdir at each segment; on
 * a successful mkdir, chmod to dirMode. On Windows or when dirMode is
 * undefined this is just a recursive mkdir.
 */
async function mkdirpWithMode(dir: string, dirMode: number | undefined): Promise<void> {
  if (dirMode === undefined || process.platform === "win32") {
    await mkdir(dir, { recursive: true });
    return;
  }
  // Walk leaf -> root collecting segments that don't exist yet, then create
  // them root -> leaf, chmodding each one we created. We stat-walk UP rather
  // than splitting and walking DOWN so we don't have to reason about the
  // POSIX leading-slash / "" first-segment shape (path.dirname handles that
  // correctly on every platform).
  const resolved = path.resolve(dir);
  const toCreate: string[] = [];
  let cursor = resolved;
  // Stop at the filesystem root (path.dirname("/" ) === "/").
  while (true) {
    let exists = true;
    try {
      await stat(cursor);
    } catch {
      exists = false;
    }
    if (exists) break;
    toCreate.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // hit the root without finding an existing ancestor
    cursor = parent;
  }
  if (toCreate.length === 0) return; // every parent already exists
  // recursive:true tolerates a concurrent racer creating any of these dirs
  // between our stat and our mkdir.
  await mkdir(resolved, { recursive: true });
  for (const created of toCreate) {
    try {
      await chmod(created, dirMode);
    } catch {
      // Best-effort -- some filesystems (FAT-shaped mounts) reject chmod.
    }
  }
}
