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
