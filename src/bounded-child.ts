// Expiry teardown for a child process that was given a deadline.
//
// A LEAF module (node types only) on purpose: uv-bootstrap.ts's probePath and
// runCommand and oam-spawn.ts's spawnVersionProbe all need it, and
// uv-bootstrap.ts imports oam-spawn.ts, so it could live in neither without a
// cycle. It used to be written out in both.

import type { ChildProcess } from "node:child_process";

/**
 * Kill a bounded child whose deadline passed, and stop it holding the PARENT
 * open.
 *
 * SIGKILL by default, not the SIGTERM a trapping child simply ignores. Then
 * DETACH, not merely kill: a still-live child -- or one open pipe to it --
 * keeps the parent's event loop alive, so settling the caller's promise
 * without this trades an activation hang for a shutdown hang. The kill may
 * not land at all (a child in uninterruptible sleep takes no signal, and on
 * win32 a `shell: true` spawn's kill lands on cmd.exe), which is why every
 * caller settles its promise independently of it.
 *
 * Both output pipes are destroyed, whichever the caller opened: a pipe the
 * child was spawned without is undefined and that step is a no-op. Each step
 * has its own guard, so a throw from one (the child already gone) cannot
 * skip the next -- in particular a failed destroy never skips the unref.
 *
 * The caller attaches its own no-op 'error' listener to a pipe it reads: a
 * wedged child may still be writing when the pipe is destroyed here.
 */
export function killAndDetach(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
  try {
    child.stdout?.destroy();
  } catch {
    /* already gone */
  }
  try {
    child.stderr?.destroy();
  } catch {
    /* already gone */
  }
  try {
    child.unref();
  } catch {
    /* already gone */
  }
}
