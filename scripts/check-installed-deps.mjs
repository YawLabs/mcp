#!/usr/bin/env node
/**
 * Does node_modules hold what package-lock.json says it should?
 *
 * release.sh runs this in its pre-flight, right after the node_modules/.bin
 * check. That check proves the toolchain was installed at some point; it does
 * not prove the install is CURRENT. A checkout that pulled a dependency bump
 * (#220 moved @modelcontextprotocol/server 2.3.1 -> 2.4.0) without re-running
 * `npm ci` keeps every bin in place, so the old tree went on to run the full
 * suite -- five minutes in, a test that depends on 2.4.0's behaviour failed
 * with an assertion that said nothing about the install.
 *
 * The check: for every installed-package entry in the lockfile's `packages`
 * map (keys under node_modules/), read that directory's package.json and
 * compare its version to the locked one. A package that is absent counts as
 * drift unless the lockfile marks it optional or devOptional -- mostly the
 * per-platform binaries (biome, esbuild, rollup) that npm skips on every
 * platform but one, plus the dependencies only those binaries pull in. An
 * optional package that IS installed must still be at its locked version.
 * Links, their workspace targets (keys outside node_modules/) and bundled
 * deps are skipped: a bundled dep ships inside its parent's tarball. A
 * lockfile with no `packages` map has nothing to compare and passes.
 *
 * Exit 0 when the tree matches, 1 with one line per drifted package (the
 * first MAX_LISTED, then a count), 2 when package-lock.json cannot be read.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_LISTED = 10;

/** The installed version at a lockfile key, or null when it is not installed. */
export function readInstalledVersion(root, key) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, key, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Every lockfile entry whose installed copy is missing or at another version,
 * as { name, locked, installed } with installed null for a missing package.
 */
export function findDrift(lock, readVersion) {
  const packages = lock && typeof lock === "object" ? lock.packages : undefined;
  if (!packages || typeof packages !== "object") return [];
  const drift = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.includes("node_modules/") || !entry || typeof entry !== "object") continue;
    if (entry.link || entry.inBundle || typeof entry.version !== "string") continue;
    const installed = readVersion(key);
    if (installed === entry.version) continue;
    if (installed === null && (entry.optional || entry.devOptional)) continue;
    drift.push({ name: key, locked: entry.version, installed });
  }
  return drift;
}

/** The report release.sh prints after its own headline. */
export function formatDrift(drift, max = MAX_LISTED) {
  const lines = drift.slice(0, max).map((d) => `${d.name}: locked ${d.locked}, installed ${d.installed ?? "nothing"}`);
  if (drift.length > max) lines.push(`... and ${drift.length - max} more`);
  return lines.join("\n");
}

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

if (isMainModule(process.argv[1], import.meta.url)) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch (err) {
    process.stdout.write(`cannot read package-lock.json: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const drift = findDrift(lock, (key) => readInstalledVersion(root, key));
  if (drift.length > 0) {
    process.stdout.write(`${formatDrift(drift)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
