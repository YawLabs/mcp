// The "was this file run as a script, or imported?" test that the scripts in
// this directory which tests also import (check-installed-deps, verify-clients,
// verify-oam-floor) guard their run block with. Its own module, importing node builtins
// only, because check-installed-deps.mjs runs in release.sh's pre-flight
// against a node_modules that may be stale or half-installed: it must not pull
// in a script that imports a dependency to get this.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `argv1` (process.argv[1]) names the module at `moduleUrl`. Node
 * realpaths the main module's URL (unless --preserve-symlinks-main) but leaves
 * argv[1] as typed, so from a junctioned or symlinked checkout a raw compare
 * of the two was false: the caller's run block was skipped, and the script --
 * a bad flag included -- printed nothing and exited 0, a silence that reads as
 * a pass. Both sides are realpath'd, so the answer holds with or without
 * --preserve-symlinks-main.
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}
