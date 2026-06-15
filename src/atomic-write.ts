// Atomic file write helper. Writes to a sibling .tmp file then renames
// onto the target -- fs.rename is atomic on the same filesystem on POSIX
// and on modern Windows Node, so a process killed mid-write (SIGINT,
// OOM, antivirus) leaves the original target intact instead of a half-
// written file. The pid+timestamp suffix avoids tmp name collisions
// across concurrent processes; in-process serialization is the caller's
// concern (see persistence.ts:saveState for an example).

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
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
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmp, contents, encoding);
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so we don't leak orphan temp files when the
    // write or rename fails. Swallow the unlink error -- the original
    // failure is what the caller cares about.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
