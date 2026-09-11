import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `install --list` printed the full absolute path in every home-rooted row,
// instead of `~\.cursor\mcp.json`, whenever USERPROFILE was spelled with
// forward slashes (Git Bash, CI). On win32 os.homedir() returns that spelling
// verbatim, path.join rebuilds every config path with backslashes, and the
// check between the two was a raw `abs.startsWith(home)`. A spelling
// difference defeats that shape, so does a case-variant home on a
// case-insensitive filesystem, and without a separator anchor it also matches
// a SIBLING (`C:\Users\jeff-old` against `C:\Users\jeff`).
//
// The fix moved the comparison into ONE helper, tildePath in paths.ts, next to
// isUnderHome -- the containment predicate, which already case-folds and
// compares through path.relative. What makes it worth a guard rather than
// just a fix is that the raw shape is the obvious one to type: the next
// home-relative display, or the next "is this under home" check, is one
// `startsWith(home)` away from the same bug. A scan catches that; a test
// pinned to install-cmd.ts does not.
//
// Top-level src/*.ts only, like count-plurals.test.ts -- tests compare paths
// they built themselves. Comment lines are skipped: prose quoting the old
// shape (this file's siblings do) is not a comparison.

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** A `.startsWith(` whose argument opens with an identifier naming a home
 *  dir -- `home`, `opts.home`, `homeDir`, `userHome`, `os.homedir()`,
 *  `process.env.HOME` -- or a template literal that opens with one.
 *  Case-insensitive, so `HOME` and `userHome` count. A string-literal argument
 *  (`startsWith("~/")`) is not a home comparison and does not match. */
const RAW_HOME_PREFIX = /\.startsWith\(\s*(?:[\w$.]*home|`\$\{\s*[\w$.]*home)/i;

/** `//` line comments and the body lines of block / JSDoc comments. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

describe("no raw startsWith(home) comparison in src", () => {
  it("recognises the shapes it exists to catch, and not the ones it must not", () => {
    // Pins the regex itself: a scan that matches nothing proves nothing.
    const caught = [
      "  if (home && abs.startsWith(home) && endsAtBoundary) {", // the line tildePath replaced
      "p.startsWith(opts.home)",
      "dir.startsWith(homeDir + sep)",
      "x.startsWith(userHome)",
      "x.startsWith(os.homedir())",
      "x.startsWith(process.env.HOME ?? '')",
      "x.startsWith(`${home}/`)",
    ];
    for (const line of caught) expect(RAW_HOME_PREFIX.test(line), line).toBe(true);
    const ignored = ['value.startsWith("~/")', "line.startsWith(prefix)", "return tildePath(abs, home, sep);"];
    for (const line of ignored) expect(RAW_HOME_PREFIX.test(line), line).toBe(false);
    expect(COMMENT_LINE.test("  // A raw `abs.startsWith(home)` never matched")).toBe(true);
    expect(COMMENT_LINE.test(" * `abs.startsWith(home)` in a JSDoc body")).toBe(true);
    expect(COMMENT_LINE.test("  if (abs.startsWith(home)) {")).toBe(false);
  });

  it("finds none -- home-relative checks go through tildePath or isUnderHome", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const lines = readFileSync(join(SRC_DIR, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
        if (RAW_HOME_PREFIX.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      "These compare a path against a home dir with a raw startsWith, which a " +
        "forward-slash USERPROFILE, a case-variant home and a sibling dir sharing " +
        "the prefix all defeat. Use tildePath (display) or isUnderHome " +
        "(containment) from paths.ts:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
