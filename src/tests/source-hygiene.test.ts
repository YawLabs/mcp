import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

// A raw control byte in tracked source, which nothing else in the gate catches.
//
// Writing source through a bash heredoc silently consumes one level of
// backslash escaping, so an intended escape sequence -- backslash, `u`, four
// hex digits -- arrives as a single REAL control byte and gets written into
// the file. The same mangling reaches the Edit tool.
//
// Nothing in the normal gate sees it. A NUL inside a TypeScript string literal
// is semantically valid, so biome stays clean, tsc stays clean, and the whole
// suite passes both before and after. It has reached `main` in this repo
// before: five literal NULs in commit b365955, merged in 0c469da, found only
// by a byte-level scan and fixed in cdcb0e5.
//
// The reason it survives REVIEW is worse than the reason it survives the gate:
// `git diff` renders a file containing one as `Binary file ... matches` and
// prints no hunks at all, so the change is literally unreviewable in the tool
// a reviewer is using.
//
// Every control byte below is built from a numeric code point on purpose.
// Writing one as a literal is how this class of bug is born, and this file is
// the last place that should demonstrate it.
//
// This runs over `git ls-files` rather than a directory walk so it sees
// exactly what is tracked -- an untracked scratch file is not the repo's
// problem, and a file that is tracked is, wherever it lives.

// Tab, LF and CR are the three C0 bytes that belong in text.
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

// Extensions whose bytes are legitimately binary. Checked case-insensitively.
// Deliberately a denylist of BINARY rather than an allowlist of text: a new
// text extension nobody listed should still be scanned, and the failure mode
// of scanning something unexpected is a loud, fixable test failure rather than
// a silent gap.
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".node",
  ".wasm",
]);

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

/** First offending byte in `buf`, or null. Returns the offset as well as the
 *  byte because "there is a NUL somewhere in a 4000-line file" is not an
 *  actionable failure message -- the offset is what makes it findable. */
function firstControlByte(buf: Buffer): { offset: number; byte: number } | null {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] as number;
    if (b < 0x20 && !ALLOWED_CONTROL.has(b)) return { offset: i, byte: b };
  }
  return null;
}

describe("tracked source carries no raw control bytes", () => {
  it("actually scanned the tree, rather than an empty list", () => {
    // A coverage FLOOR, because "no offenders" and "no files" are the same
    // green. `git ls-files` is CWD-relative, so a drift in REPO_ROOT would
    // narrow the scan to a subdirectory -- or to nothing -- and the assertion
    // below would still pass. That is the identical shape to the `git grep -I`
    // bug in the sibling scanner: a check that reports clean on what it never
    // read. The exact number is not the point and would be churn; the point is
    // that it is the whole repo and not a corner of it.
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(100);
    // And that it reached the two directories that matter here.
    expect(files.some((f) => f.startsWith("src/"))).toBe(true);
    expect(files.some((f) => f.startsWith("src/tests/"))).toBe(true);
  });

  it("finds none anywhere in the tracked tree", () => {
    const offenders: string[] = [];
    for (const rel of trackedFiles()) {
      if (BINARY_EXT.has(extname(rel).toLowerCase())) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(join(REPO_ROOT, rel));
      } catch {
        // Tracked but not present (a sparse checkout, a broken symlink). Not
        // this test's business -- it asserts about bytes that exist.
        continue;
      }
      const hit = firstControlByte(buf);
      if (hit) {
        offenders.push(`${rel}: byte 0x${hit.byte.toString(16).padStart(2, "0")} at offset ${hit.offset}`);
      }
    }
    expect(offenders, `raw control bytes in tracked files:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // The scan itself has to be shown to work, or the test above is just an
  // expensive way to assert an empty array. These drive the predicate directly
  // rather than planting a byte in the repo, which would be the one thing this
  // file exists to prevent.
  it("catches a NUL, the byte that actually reached main", () => {
    const buf = Buffer.from([0x61, 0x00, 0x62]);
    expect(firstControlByte(buf)).toEqual({ offset: 1, byte: 0x00 });
  });

  it("catches a bare ESC, the byte a mangled escape sequence produces", () => {
    // 0x1b, 0x5b, 0x32, 0x4a is what a clear-screen sequence collapses to once
    // a heredoc has eaten the backslash level: ESC, then a literal "[2J".
    const buf = Buffer.from([0x78, 0x1b, 0x5b, 0x32, 0x4a]);
    expect(firstControlByte(buf)).toEqual({ offset: 1, byte: 0x1b });
  });

  it("allows tab, LF and CR, so a CRLF file is not a finding", () => {
    expect(firstControlByte(Buffer.from("a\tb\r\nc\n", "utf8"))).toBeNull();
  });

  it("allows ordinary UTF-8 above the control range", () => {
    // A multi-byte character's continuation bytes are all >= 0x80, so this
    // pins that the check reads BYTES and still does not fire on real text.
    expect(firstControlByte(Buffer.from("héllo — ✅", "utf8"))).toBeNull();
  });

  it("reports the FIRST offender, so the offset points at something", () => {
    const buf = Buffer.from([0x61, 0x62, 0x01, 0x63, 0x00]);
    expect(firstControlByte(buf)).toEqual({ offset: 2, byte: 0x01 });
  });

  it("scans a text extension nobody thought to list", () => {
    // The denylist shape is load-bearing: an unlisted extension must be
    // scanned, not skipped. `.md` and `.jsonc` are both tracked here and
    // neither is in BINARY_EXT.
    expect(BINARY_EXT.has(".md")).toBe(false);
    expect(BINARY_EXT.has(".jsonc")).toBe(false);
    expect(BINARY_EXT.has(".ts")).toBe(false);
  });

  it("skips a binary extension case-insensitively", () => {
    expect(BINARY_EXT.has(extname("logo.PNG").toLowerCase())).toBe(true);
  });
});

// Every walk of a client-config container path in tracked source.
//
// Claude Code keys local-scope MCP under projects[<absolute dir>], looks it up
// byte-exactly, and older versions of this tool wrote that key with whatever
// drive-letter case the shell reported -- so one project can have TWO keys in
// ~/.claude.json ("c:/repo" and "C:/repo"), each read by a different set of
// shells. claudeCodeContainerPaths (install-targets.ts) is the ONE place that
// equivalence is resolved, and every reader is supposed to take its paths from
// it. A reader that indexes projects[<key>] directly sees only one of the two
// and reports a state the other contradicts: that is how `uninstall` came to
// strip the permission grant, print "Done: Claude Code no longer launches
// yaw-mcp", and leave the entry that a cmd-started session still reads.
//
// The recurring failure this guards is narrower than "someone writes a bug":
// it is a shared guard that gets exactly ONE adopter, so the command a finding
// named is fixed and every sibling command keeps the same blindness. A
// whitelist is therefore the right shape -- a NEW raw walk fails, and so does
// deleting an existing one, so the table cannot rot quietly in either
// direction.
//
// To update: if the new walk resolves a projects[] key, route it through
// claudeCodeContainerPaths and add the helper-derived shape here. If it must
// stay exact (a write, or a path recorded verbatim in a marker), say WHY in
// its `why` and in a comment at the code.
const CONTAINER_WALK_CALL = /\b(?:readNested|readEntryAt|walkContainer|readContainer)\((?:[^()\n]|\([^()\n]*\))*\)/g;
const CONTAINER_WALK_LOOP = /for \(const [A-Za-z_$][\w$]* of (?:[^()\n]|\([^()\n]*\))*\)/g;
const LOOP_IS_A_WALK = /containerPath|variantPath|claudeCodeContainerPaths/;

interface Walk {
  shape: string;
  why: string;
}

const EXPECTED_WALKS: Record<string, Walk[]> = {
  "src/doctor-cmd.ts": [
    {
      shape: "CALL walkContainer(root: Record<string, unknown>, path: string[])",
      why: "the generic walker's own declaration -- it takes whatever path it is handed",
    },
    {
      shape: "CALL walkContainer(parsed as Record<string, unknown>, variantPaths[i])",
      why: "the probe behind doctor and `install --list`; paths from claudeCodeContainerPaths",
    },
  ],
  "src/import-cmd.ts": [
    { shape: "CALL readContainer(ref: ContainerRef)", why: "declaration of the other-scope container read" },
    { shape: "CALL readContainer(searched[i])", why: "the is-yaw-mcp-wired-in search; folds inside readContainer" },
    {
      shape: "LOOP for (const variantPath of claudeCodeContainerPaths(parsed, ref.containerPath))",
      why: "readContainer: every variant is checked for a yaw-mcp entry",
    },
    {
      shape: "LOOP for (const variantPath of claudeCodeContainerPaths(parsed, resolved.containerPath))",
      why: "the import SOURCE read; sourcePath then carries the key found into the removal",
    },
    { shape: "LOOP for (const key of variantPath)", why: "readContainer walking one helper-derived path" },
    { shape: "LOOP for (const key of variantPath)", why: "the source read walking one helper-derived path" },
  ],
  "src/install-cmd.ts": [
    {
      shape: "CALL readNested(root: Record<string, unknown>, containerPath: string[])",
      why: "the generic walker's own declaration -- it takes whatever path it is handed",
    },
    {
      shape: "CALL readNested(existing, containerPath)",
      why: "readEntryAt's body, the same generic accessor one level up",
    },
    { shape: "CALL readNested(existing, canonicalPath)", why: "install: the container this run writes" },
    { shape: "CALL readNested(existing, variantPath)", why: "install: the drive-case sibling scan it reports" },
    { shape: "CALL readNested(existing, variantPath)", why: "uninstall: every site it has to clear" },
    { shape: "CALL readEntryAt(existing, canonicalPath, ENTRY_NAME)", why: "install: env carried over into the entry" },
    { shape: "LOOP for (const key of containerPath)", why: "readNested's own body" },
    { shape: "LOOP for (const variantPath of variantPaths.slice(1))", why: "install: the sibling scan" },
  ],
  "src/try-cmd.ts": [
    {
      shape: "LOOP for (const segment of containerPath)",
      why: "peelEntryFromConfig: the path a trial MARKER recorded -- must delete that entry and no other",
    },
    {
      shape: "LOOP for (const segment of containerPath)",
      why: "configHasEntry: will the write at THIS path replace something -- the write goes to one path",
    },
  ],
};

function scanContainerWalks(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of trackedFiles()) {
    if (!file.startsWith("src/") || !file.endsWith(".ts") || file.includes("/tests/")) continue;
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const found = [
      ...(src.match(CONTAINER_WALK_CALL) ?? []).map((m) => `CALL ${m}`),
      ...(src.match(CONTAINER_WALK_LOOP) ?? []).filter((m) => LOOP_IS_A_WALK.test(m)).map((m) => `LOOP ${m}`),
    ].sort();
    if (found.length > 0) out[file] = found;
  }
  return out;
}

describe("every client-config container walk goes through claudeCodeContainerPaths", () => {
  it("scanned real files, rather than an empty list", () => {
    // A regex that matches nothing would make every assertion below vacuous.
    const scanned = scanContainerWalks();
    expect(Object.keys(scanned).length).toBeGreaterThanOrEqual(4);
    expect(scanned["src/install-cmd.ts"]?.length ?? 0).toBeGreaterThan(0);
  });

  it("finds exactly the walks the table accounts for", () => {
    const scanned = scanContainerWalks();
    const expected: Record<string, string[]> = {};
    for (const [file, walks] of Object.entries(EXPECTED_WALKS)) expected[file] = walks.map((w) => w.shape).sort();
    // Whole-map compare, so a walk in a file the table does not list fails too
    // -- a new reader module is exactly the shape this is watching for.
    expect(scanned).toEqual(expected);
  });

  it("has a stated reason for every exact, unfolded walk", () => {
    // The three walks that deliberately do NOT fold are the ones a reviewer
    // has to be able to challenge, so each carries its reason here and a
    // comment at the code.
    for (const [file, walks] of Object.entries(EXPECTED_WALKS)) {
      for (const w of walks) {
        expect(w.why.length, `${file}: ${w.shape}`).toBeGreaterThan(10);
      }
    }
  });

  it("keeps every folding reader importing the helper", () => {
    // The compile would catch a removed import, but not a reader that quietly
    // stops calling it while the import lingers -- the shape table above is
    // what catches that. This pins the other half: the three readers that must
    // fold all name the helper.
    for (const file of ["src/install-cmd.ts", "src/doctor-cmd.ts", "src/import-cmd.ts"]) {
      expect(readFileSync(join(REPO_ROOT, file), "utf8"), file).toContain("claudeCodeContainerPaths");
    }
  });
});
