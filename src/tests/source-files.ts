// The ONE walker every source-shape scan enumerates `src/` with.
//
// Not a test file (no `.test.ts`, so vitest's `src/**/*.test.ts` include does
// not pick it up) -- a helper the scans import.
//
// TWO PROPERTIES, each of which one scan previously lacked:
//
//   * RECURSIVE. `home-prefix-compare.test.ts` read `readdirSync(SRC_DIR)`
//     and looked at top-level `src/*.ts` only. Every source file is top-level
//     today, so it saw all of them -- but its coverage rested entirely on
//     that being true, and it is one `src/targets/` away from silently
//     scanning a fraction of the tree.
//   * FILESYSTEM-BACKED, not `git ls-files`. `source-hygiene.test.ts`'s
//     projects-key scan enumerated tracked files, so a NEW module escaped it
//     until someone ran `git add` -- which is exactly the window in which a
//     new reader is written. A directory read sees a file the moment it
//     exists.
//
// `src/tests` is excluded by default: every rule these scans enforce is about
// SOURCE shape, and a test that quotes a forbidden shape in a fixture is not
// an offender. A scan that needs to see the tests passes `includeTests`.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of `src/`. */
export const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Absolute path of the repo root. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface SourceFile {
  /** Repo-relative, forward slashes, so an offender reads the same on every
   *  platform and can be pasted into an editor. */
  path: string;
  /** Absolute path, for a reader that wants to open it. */
  absolute: string;
  text: string;
}

export interface WalkOptions {
  /** Include `src/tests`. Default false -- source-shape rules are about
   *  source, and a fixture quoting a forbidden shape is not an offender. */
  includeTests?: boolean;
}

/** Every `.ts` file under `src/`, recursively, in a deterministic order.
 *
 *  Deterministic because an offender list is compared or printed: `readdirSync`
 *  order is filesystem-dependent, so it is sorted at every level. `.d.ts` is
 *  kept -- a declaration file can still carry a forbidden identifier -- and
 *  nothing else is filtered, so a new extension cannot quietly opt out. */
export function sourceFiles(opts: WalkOptions = {}): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!opts.includeTests && absolute === join(SRC_DIR, "tests")) continue;
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      out.push({
        path: relative(REPO_ROOT, absolute).split("\\").join("/"),
        absolute,
        text: readFileSync(absolute, "utf8"),
      });
    }
  };
  walk(SRC_DIR);
  return out;
}

/** Every immediate SUBDIRECTORY of `src/`, by name.
 *
 *  The structural check the scans keep alongside the recursive walk: `src/`
 *  has no subdirectory but `tests` today, and the walk above is what makes a
 *  future one safe rather than invisible. Belt and braces on purpose -- that
 *  structural assertion is itself one line away from being relaxed by whoever
 *  adds the subdirectory, which is why the walker does not depend on it. */
export function sourceSubdirectories(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
