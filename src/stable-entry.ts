/**
 * Turning a RESOLVED module path into one that is safe to PERSIST in a client
 * config.
 *
 * The two are not the same path, and conflating them is what broke every
 * Codex CLI entry written from inside Yaw Terminal.
 *
 * WHY A RESOLVED PATH ROTS. `resolveStableNpmEntry` derives its answer from
 * `import.meta.url`, and Node has ALREADY realpathed that: a broker launched
 * through `...\scoop\apps\yaw\current\...` reports `...\scoop\apps\yaw\2.1.5\...`.
 * The version directory is the thing the app's own updater deletes -- scoop
 * prunes the old release as it links the new one -- so the entry names a file
 * that stops existing on the next upgrade, and `oam run` cannot refetch it the
 * way `npx` would. Verified on Windows: for the same file,
 *   import.meta.url -> .../apps/1.0.0/node_modules/@x/y/dist/index.mjs
 *   process.argv[1] -> ...\apps\current\node_modules\@x\y\dist\index.mjs
 * which is exactly why ~/.claude.json (written from argv[1] by the app) kept
 * working while ~/.codex/config.toml (written from import.meta.url) did not.
 *
 * So the job here is to recover a spelling of the same file that the app's
 * updater MAINTAINS rather than deletes. Two strategies, cheapest first, and
 * both gated on realpath identity so a wrong guess can never redirect the
 * entry at a different file.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Injectable filesystem + process seams. Every one defaults to the real
 *  thing; tests pass fakes rather than building junction trees on disk (which
 *  needs elevation on some Windows configurations). */
export interface StableSpellingDeps {
  argv1?: string | undefined;
  realpath?: (p: string) => string;
  readdir?: (p: string) => string[];
  isSymlink?: (p: string) => boolean;
}

/**
 * Paths that exist only for the lifetime of the process reading them.
 *
 * An AppImage is FUSE-mounted at `/tmp/.mount_<name><random>` and unmounted on
 * exit; a quarantined macOS app is copied to
 * `/private/var/folders/.../AppTranslocation/<uuid>/d/` with a fresh uuid every
 * launch. Persisting either names a file that is gone the moment Yaw exits --
 * and unlike the scoop case NO refresh cadence can save it, because the next
 * launch has a different random path again. A heal pass that rewrote such an
 * entry would rewrite it to a new dead path forever, never converging.
 *
 * The right answer for these is to persist nothing at all and stay on the npx
 * entry, which re-resolves per spawn. Mirrors `runsFromEphemeralMount` in the
 * app (yaw/src/yaw-mcp-entry.ts) -- but tests the PATH rather than
 * `process.execPath`, because here the question is where the broker MODULE
 * lives, not which binary is running it.
 */
export function isEphemeralMountPath(p: string): boolean {
  const posix = p.replace(/\\/g, "/");
  return (
    posix.includes("/AppTranslocation/") ||
    // AppImage's runtime mount. Anchored on the `.mount_` segment the
    // runtime creates, NOT on `/tmp`: the mount lives under $TMPDIR, which
    // is not always /tmp. Matching the segment covers a relocated TMPDIR
    // too, without reading the AppImage runtime's own env var -- which
    // would add an undocumented env knob for no extra coverage.
    /(^|\/)\.mount_/.test(posix)
  );
}

/**
 * The spelling of `entry` that is most likely to survive its owner's next
 * update, or `entry` itself when there is nothing better.
 *
 * NEVER returns a path that names a different file: every candidate is
 * realpath-compared against `entry` before it is returned, so the worst case
 * is that this is a no-op.
 */
export function stableSpellingOf(entry: string, deps: StableSpellingDeps = {}): string {
  const realpath = deps.realpath ?? realpathSync;
  let target: string;
  try {
    target = realpath(entry);
  } catch {
    // Cannot realpath the thing we were handed -- do not speculate about it.
    return entry;
  }

  // Strategy 1: the spelling our own launcher used.
  //
  // `process.argv[1]` is the script path AS WRITTEN on the command line, NOT
  // realpathed. When the broker is the bundled sidecar, the app spawns it by
  // the `current`-junction path, so argv[1] already carries the durable
  // spelling and no directory scanning is needed. The realpath-identity gate
  // is what makes this safe to apply blindly: when this function is called for
  // some OTHER package, argv[1] is a different file and the check simply fails.
  const argv1 = deps.argv1 === undefined ? process.argv[1] : deps.argv1;
  if (typeof argv1 === "string" && argv1.length > 0) {
    try {
      const abs = isAbsolute(argv1) ? argv1 : resolve(argv1);
      if (abs !== entry && realpath(abs) === target) return abs;
    } catch {
      // argv[1] is not a readable path (a REPL, an eval, a deleted script).
    }
  }

  // Strategy 2: an ancestor directory that some sibling LINK points at.
  //
  // Generic on purpose -- the rule is "does this directory have a sibling
  // symlink resolving to it", which the filesystem answers. It picks up
  // scoop's `current`, an fnm/volta `default` over a versioned prefix, and any
  // `/opt/<app>/current` layout, with no per-installer table to keep in sync
  // and no dependence on the literal name `current`.
  return aliasSpellingOf(entry, target, deps) ?? entry;
}

/**
 * Deepest-first, and only ever for a directory whose NAME looks like a version.
 *
 * Both guards were learned the hard way. A shallowest-first walk with only a
 * realpath-identity gate rewrote `C:/Users/...` to
 * `C:\Documents and Settings/...` on a real Windows box: that legacy
 * compatibility junction really does resolve to the same file, so identity
 * alone accepted it -- but it is hidden, its ACL denies traversal to most
 * processes, and persisting it into a client config would hand the client a
 * path it cannot open. Identity proves the alias names the same file; it does
 * NOT prove the alias is a good thing to depend on.
 *
 * The version-segment gate is what makes the substitution principled rather
 * than opportunistic. The defect being fixed is that an updater DELETES the
 * version directory it just replaced, so a version directory is the only
 * segment worth aliasing away. Anything else -- a home directory, a drive
 * root, a shared prefix -- is not rotating and must be left exactly as spelled.
 */
function aliasSpellingOf(entry: string, target: string, deps: StableSpellingDeps): string | null {
  const realpath = deps.realpath ?? realpathSync;
  const readdir = deps.readdir ?? ((p: string): string[] => readdirSync(p));
  const isSymlink =
    deps.isSymlink ??
    ((p: string): boolean => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });

  for (const ancestor of ancestorsOf(entry)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) continue;
    // `parent` may ALREADY carry its trailing separator: `dirname` returns a
    // filesystem root ("C:\", "/") with one attached and everything else
    // without. So the separator is NOT reliably at index `parent.length`.
    //
    // Assuming it was took the first character of the segment NAME as the
    // separator -- for "C:\1.0.0" that gave sep "1" and name ".0.0" -- which
    // failed the version test below AND built a candidate ("C:\1current") that
    // could never resolve. A version directory sitting directly at a
    // filesystem root was therefore silently never aliased.
    //
    // The separator CHARACTER is reused as the caller wrote it rather than
    // going through `join`, which normalises to the platform separator and
    // would emit a mixed-separator path for a forward-slash-spelled Windows
    // input. The result is persisted and later string-compared by the heal
    // recogniser, so it has to come back spelled the way it went in.
    const sepChar = endsWithSeparator(parent) ? "" : ancestor.charAt(parent.length);
    const self = ancestor.slice(parent.length + sepChar.length);
    // Only a version-shaped segment is a rotation candidate. See the header.
    if (!looksLikeVersionDir(self)) continue;
    let names: string[];
    try {
      names = readdir(parent);
    } catch {
      continue;
    }
    let ancestorReal: string;
    try {
      ancestorReal = realpath(ancestor);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === self) continue;
      const link = parent + sepChar + name;
      if (!isSymlink(link)) continue;
      try {
        if (realpath(link) !== ancestorReal) continue;
        const candidate = link + entry.slice(ancestor.length);
        // The rewritten path must name the SAME FILE, not merely exist: a
        // link pointing at the right directory is not proof that the rest of
        // the path is reachable through it.
        if (realpath(candidate) === target) return candidate;
      } catch {
        // Broken link, or the rewritten path is not there. Try the next name.
      }
    }
  }
  return null;
}

/** True when `p` already carries a trailing separator. `dirname` returns a
 *  filesystem root that way ("C:\\", "/", "//server/share/") and returns every
 *  other directory without one. */
function endsWithSeparator(p: string): boolean {
  const last = p.charAt(p.length - 1);
  return last === "/" || last === "\\";
}

/** Directory prefixes of `entry`, DEEPEST first, excluding the filesystem
 *  root and the file itself. */
function ancestorsOf(entry: string): string[] {
  const out: string[] = [];
  let cur = dirname(entry);
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) break;
    out.push(cur);
    cur = parent;
  }
  // Deepest-first, which the walk above already produces: the alias nearest
  // the entry is the most specific one and the least likely to be a system
  // compatibility link higher up the tree.
  // No separator filter here. An earlier version dropped any ancestor without
  // a platform `sep`, which silently disabled the whole alias walk for a
  // forward-slash-spelled Windows path (`C:/Users/...`) -- a spelling that
  // reaches this function from config files and from callers that normalise.
  // The loop above already stops at the filesystem root, which is the only
  // thing that filter was there to exclude.
  return out;
}

/**
 * Does this directory name look like a release directory an updater rotates?
 *
 * Deliberately permissive about the shapes real installers use -- `2.1.5`,
 * `v1.0.0`, `1.0.0-rc.1`, `20240101` -- and deliberately strict about
 * requiring the name to START with digits (after an optional `v`), so an
 * ordinary directory never qualifies.
 */
function looksLikeVersionDir(name: string): boolean {
  const body = name.startsWith("v") ? name.slice(1) : name;
  // Must begin with a digit, then digits/dots, then an optional
  // prerelease or build suffix. Written without regex escapes on purpose.
  return /^[0-9][0-9.]*([-+][0-9A-Za-z.-]+)?$/.test(body);
}
