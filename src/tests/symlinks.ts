import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether this runner can create a file symlink at all -- Windows refuses
 *  without Developer Mode / SeCreateSymbolicLinkPrivilege. Probed in a temp
 *  dir of its own. Callers probe ONCE at module load and hand the result to
 *  `it.skipIf(!SYMLINKS_AVAILABLE)`, so a symlink test reports SKIPPED rather
 *  than bailing with a bare `return` that vitest scores as a PASS: the
 *  severed-link regressions those tests exist for would otherwise read as
 *  covered on every Windows box that cannot make links. */
export function symlinksAvailable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "yaw-mcp-symlink-probe-"));
  try {
    symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
