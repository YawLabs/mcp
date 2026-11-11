// The "is this git build finished?" signal, in a module that imports nothing
// at runtime beyond node and paths.ts (types.ts is a type-only import), so
// upstream.ts (activation) can read it without statically importing
// git-source.ts, which imports upstream.ts.
//
// The marker lives OUTSIDE the checkout, at `<ns>/<sha12>.built` next to
// `<sha12>.failed`. A repo controls every file in its own tree, so a marker
// inside it could be committed by the repo and would read as a finished build
// the moment the clone is checked out -- before consent, before install. A
// `.yaw-build.json` a repo ships means nothing here.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { GIT_BUILD_SHA_LEN, gitBuildDir } from "./paths.js";
import type { GitSource } from "./types.js";

export type PackageManagerName = "npm" | "pnpm" | "yarn";

export interface GitBuildMarker {
  url: string;
  commit: string;
  subdir?: string;
  entry: string;
  node: string;
  platform: string;
  arch: string;
  pm: PackageManagerName;
  pmVersion: string;
  builtAt: string;
}

/** The `.built` file of the build directory `dir`. */
export function builtMarkerPath(dir: string): string {
  return `${dir}.built`;
}

function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function isFileInside(base: string, segments: string[]): boolean {
  const abs = resolve(base, ...segments);
  const rel = relative(base, abs);
  if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * The finished build's marker for the build directory `dir`, or null when the
 * build is not finished. Null unless every check holds:
 * - `<dir>.built` parses, with string `commit` and `entry`;
 * - its commit is a full SHA naming this directory, and equals `commit` when
 *   the caller knows the pin;
 * - its entry (under its subdir) is a file inside `dir`;
 * - it is not older than the checkout's `.git/HEAD`, which the checkout writes:
 *   a marker left from an earlier build of a directory since re-cloned does
 *   not vouch for the new tree.
 */
export function readBuildMarker(dir: string, commit?: string): GitBuildMarker | null {
  const file = builtMarkerPath(dir);
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const marker = m as Record<string, unknown>;
  if (typeof marker.commit !== "string" || typeof marker.entry !== "string") return null;
  if (!/^[0-9a-f]{40}$/.test(marker.commit)) return null;
  if (marker.commit.slice(0, GIT_BUILD_SHA_LEN) !== basename(dir)) return null;
  if (commit !== undefined && marker.commit !== commit) return null;
  if (marker.subdir !== undefined && typeof marker.subdir !== "string") return null;
  const split = (p: string): string[] => p.split(/[\\/]/).filter(Boolean);
  if (!isFileInside(dir, [...split(marker.subdir ?? ""), ...split(marker.entry)])) return null;
  const built = mtimeMs(file);
  const head = mtimeMs(join(dir, ".git", "HEAD"));
  if (built === null || head === null || built < head) return null;
  return marker as unknown as GitBuildMarker;
}

/** Write the marker that makes `dir` a finished build. Called last. */
export function writeBuildMarker(dir: string, marker: GitBuildMarker): void {
  writeFileSync(builtMarkerPath(dir), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
}

/** Does the entry's pinned commit have a finished build on this machine? */
export function gitEntryBuilt(namespace: string, git: GitSource, home?: string): boolean {
  return git.commit !== undefined && readBuildMarker(gitBuildDir(namespace, git.commit, home), git.commit) !== null;
}
