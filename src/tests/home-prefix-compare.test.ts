import { describe, expect, it } from "vitest";
import { sourceFiles } from "./source-files.js";

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
// `startsWith(home)` away from the same bug. A scan catches that shape; a test
// pinned to install-cmd.ts does not.
//
// It narrows the obvious shape; it does not prove the bug absent. It does NOT
// see a home compared some other way (`abs.indexOf(home) === 0`,
// `abs.slice(0, home.length) === home`) or held in a variable whose name lacks
// "home" (`h`, `base`, `root`). Source only -- tests compare paths they built
// themselves. Comment lines are skipped: prose quoting the old shape (this
// file's siblings do) is not a comparison.
//
// The walk is `sourceFiles()`, the RECURSIVE walker every source-shape scan in
// this suite shares. It used to be `readdirSync(src/)` with no recursion:
// every source file is top-level today, so that saw all of them -- but the
// coverage rested on a comment saying so, and one `src/targets/` would have
// made it scan a fraction of the tree in silence.

/** A `.startsWith(` whose argument opens with an identifier naming a home
 *  dir -- `home`, `opts.home`, `homeDir`, `userHome`, `os.homedir()`,
 *  `process.env.HOME` -- or a template literal that opens with one. The
 *  identifier may sit inside calls (`resolve(home)`, `path.resolve(home)`,
 *  `normalizeForCompare(home)`): resolving or folding the home alone leaves
 *  the sibling match in place, and resolving alone leaves the case one.
 *  Case-insensitive, so `HOME` and `userHome` count. `\s` spans a line break,
 *  so a call the formatter wraps after its `(` still matches. A string-literal
 *  argument (`startsWith("~/")`) is not a home comparison and does not match. */
const RAW_HOME_PREFIX = /\.startsWith\(\s*(?:[\w$.]+\(\s*)*(?:[\w$.]*home|`\$\{\s*[\w$.]*home)/i;

/** `//` line comments and the body lines of block / JSDoc comments. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

/** The 1-based line of every RAW_HOME_PREFIX match in `source`. Comment lines
 *  are blanked (not dropped, so the numbers still point into the file), and
 *  the pattern then runs over the whole text rather than line by line -- a
 *  per-line test never sees a `startsWith(` whose argument the formatter
 *  moved onto the next line. */
function rawHomePrefixLines(source: string): number[] {
  const code = source
    .split("\n")
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
  const every = new RegExp(RAW_HOME_PREFIX.source, "gi");
  return [...code.matchAll(every)].map((m) => code.slice(0, m.index ?? 0).split("\n").length);
}

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
      "x.startsWith(resolve(home))",
      "x.startsWith(path.resolve(home))",
      "x.startsWith(normalizeForCompare(home))",
    ];
    for (const line of caught) expect(RAW_HOME_PREFIX.test(line), line).toBe(true);
    const ignored = [
      'value.startsWith("~/")',
      "line.startsWith(prefix)",
      "x.startsWith(resolve(prefix))",
      "return tildePath(abs, home, sep);",
    ];
    for (const line of ignored) expect(RAW_HOME_PREFIX.test(line), line).toBe(false);
    expect(COMMENT_LINE.test("  // A raw `abs.startsWith(home)` never matched")).toBe(true);
    expect(COMMENT_LINE.test(" * `abs.startsWith(home)` in a JSDoc body")).toBe(true);
    expect(COMMENT_LINE.test("  if (abs.startsWith(home)) {")).toBe(false);
  });

  it("finds a call the formatter wrapped across lines, and not one quoted in a comment", () => {
    const source = [
      "const a = 1;",
      "  // a raw abs.startsWith(home) quoted in prose",
      "  if (",
      "    abs.startsWith(",
      "      homeResolved,",
      "    )",
      "  ) {",
    ].join("\n");
    expect(rawHomePrefixLines(source)).toEqual([4]);
  });

  it("finds none -- home-relative checks go through tildePath or isUnderHome", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = file.text.split("\n");
      for (const n of rawHomePrefixLines(file.text)) {
        offenders.push(`${file.path}:${n}  ${lines[n - 1].trim().slice(0, 100)}`);
      }
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
