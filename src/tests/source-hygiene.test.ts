import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./source-files.js";

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

// Every read of a client-config container in non-test source, by shape --
// enumerated off the FILESYSTEM (sourceFiles), so a module escapes it only by
// not existing, not by not being tracked yet.
//
// Claude Code keys local-scope MCP under projects[<absolute dir>], looks it up
// byte-exactly, and older versions of this tool wrote that key with whatever
// drive-letter case the shell reported -- so one project can have TWO keys in
// ~/.claude.json ("c:/repo" and "C:/repo"), each read by a different set of
// shells. claudeCodeContainerPaths (install-targets.ts) is the ONE place that
// equivalence is resolved, and every reader is supposed to take its paths from
// it. A reader that resolves a projects key by hand sees only one of the two
// and reports a state the other contradicts: that is how `uninstall` came to
// strip the permission grant, print "Done: Claude Code no longer launches
// yaw-mcp", and leave the entry that a cmd-started session still reads.
//
// The recurring failure this guards is narrower than "someone writes a bug":
// it is a shared guard that gets exactly ONE adopter, so the command a finding
// named is fixed and every sibling command keeps the same blindness. A
// whitelist is therefore the right shape -- a NEW read fails, and so does
// deleting an existing one, so the table cannot rot quietly in either
// direction.
//
// WHAT THE SCAN SEES, exactly -- the claim is bounded on purpose, because an
// overstated guard is worse than a narrow one. Over each tracked non-test
// `src/*.ts` with comments stripped:
//
//  1. Any call to one of the four container accessors named in WALK_HELPERS,
//     read with a balanced-paren scan and whitespace-normalized, so a call the
//     formatter wrapped across lines has the SAME shape as a one-liner.
//  2. Any `for (...)` header -- `of`, `in` or C-style `for (let i = 0; ...)`
//     -- that names containerPath, variantPath or claudeCodeContainerPaths.
//  3. Any raw read of the `projects` container itself, by property access,
//     string index, or the PROJECTS_KEY constant -- the shape a new reader
//     reaches for first -- and any container PATH built with "projects" as its
//     first segment, which is the other way to the container. Both are caught
//     wherever they appear, including in a file the table has never heard of,
//     because the compare below is whole-map and an unlisted file fails.
//
// WHAT IT DOES NOT SEE, stated so nobody trusts it further than it reaches: a
// reader handed an already-resolved container object, or an already-built
// path, by its caller -- that caller is the reader, and callers are in the
// table -- and a reader that walks a handed-in path through some third local
// helper it declares itself, whose loop names neither containerPath nor
// variantPath. A textual scan cannot follow either. So the `scanSource` unit
// tests at the bottom of this file pin exactly the shapes it does catch, one
// assertion per claim, instead of asserting a general property it cannot hold.
// The behavioural tests in install-cmd / doctor-cmd / import-cmd are what
// cover the fold itself; this is the anti-regression net around them.
//
// To update: if the new read resolves a projects[] key, route it through
// claudeCodeContainerPaths and add the helper-derived shape here. If it must
// stay exact (a write, or a path recorded verbatim in a marker), say WHY in
// its `why` and in a comment at the code.

/** The container accessors whose every call site is accounted for below. */
const WALK_HELPERS = ["readNested", "readEntryAt", "walkContainer", "readContainer"] as const;
const HELPER_CALL = new RegExp(`\\b(${WALK_HELPERS.join("|")})\\s*\\(`, "g");
const FOR_HEADER = /\bfor\s*\(/g;
const LOOP_IS_A_WALK = /containerPath|variantPath|claudeCodeContainerPaths/;
/** A raw read of the `projects` container -- property access, string index, or
 *  the PROJECTS_KEY constant -- and a container PATH built with "projects" as
 *  its first segment, which is the other way to reach the container without
 *  the helper. `[` then the key then `]` catches the index; `[` then the key
 *  then `,` catches the path literal. Display text naming a key in a message
 *  has no bracket in front of the word and is not a match. */
const PROJECTS_READ = /\.projects\b|\[\s*(?:"projects"|'projects'|PROJECTS_KEY)\s*[,\]]/g;

/** Comments blanked, newlines and offsets preserved, string literals left
 *  alone. Without this the prose in this repo's doc comments -- which
 *  necessarily quotes the very shapes being scanned for -- would register as
 *  code, and the table would fill up with sentences. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Offset of the `)` closing the `(` at `open`, or null. Quotes are skipped so
 *  a paren inside a string literal cannot unbalance the scan. */
function matchParen(src: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Whitespace runs to one space, trailing comma dropped -- the two things a
 *  formatter adds when it wraps a call, and the reason the previous
 *  line-anchored version of this scan could be defeated by `biome check
 *  --write` alone. */
function normalizeShape(s: string): string {
  return s.replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
}

/** Every container-read shape in one source text. The unit tests at the
 *  bottom of this file drive it on synthetic input, which is what makes the
 *  claims about this scan measured rather than asserted. */
function scanSource(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  for (const [re, kind] of [
    [HELPER_CALL, "CALL"],
    [FOR_HEADER, "LOOP"],
  ] as const) {
    re.lastIndex = 0;
    let m = re.exec(code);
    while (m !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      if (close !== null) {
        const inner = normalizeShape(code.slice(open + 1, close));
        if (kind === "CALL") found.push(`CALL ${m[1]}(${inner})`);
        else if (LOOP_IS_A_WALK.test(inner)) found.push(`LOOP for (${inner})`);
      }
      m = re.exec(code);
    }
  }
  PROJECTS_READ.lastIndex = 0;
  let hit = PROJECTS_READ.exec(code);
  while (hit !== null) {
    const from = code.lastIndexOf("\n", hit.index) + 1;
    const to = code.indexOf("\n", hit.index);
    found.push(`INDEX ${normalizeShape(code.slice(from, to < 0 ? code.length : to))}`);
    hit = PROJECTS_READ.exec(code);
  }
  return found.sort();
}

interface Walk {
  shape: string;
  why: string;
}

const EXPECTED_WALKS: Record<string, Walk[]> = {
  "src/client-config-json.ts": [
    {
      shape: "LOOP for (let i = 0; i < containerPath.length - 1; i++)",
      why:
        "buildFreshConfig: builds the chain of a file that does not exist yet, on the canonical path a write " +
        "goes to. Nothing to fold -- an absent file carries no drive-case sibling key to find",
    },
  ],
  "src/doctor-cmd.ts": [
    {
      shape: "CALL walkContainer(root: Record<string, unknown>, path: string[])",
      why: "the generic walker's own declaration -- it takes whatever path it is handed",
    },
    {
      shape: "CALL walkContainer(parsed as Record<string, unknown>, variantPaths[i])",
      why: "the probe behind doctor and `install --list`; paths from claudeCodeContainerPaths",
    },
    {
      shape: "LOOP for (let i = 0; i < variantPaths.length; i++)",
      why: "that probe's own loop over the helper's paths; the index is what names entryProjectKey",
    },
  ],
  // import reads and writes through the client-config core now, so the two
  // per-variant WALKS are gone. `driveCaseVariants` is this file's one call of
  // the fold helper, over `containerKeysAt` rather than a parsed root, and
  // readContainer's own fold consumes it through `classifyClientConfig`.
  "src/import-cmd.ts": [
    { shape: "CALL readContainer(ref: ContainerRef)", why: "declaration of the other-scope container read" },
    { shape: "CALL readContainer(searched[i])", why: "the is-yaw-mcp-wired-in search; folds inside readContainer" },
    {
      shape: "LOOP for (const variantPath of driveCaseVariants(targetSite, view.raw))",
      why: "the import SOURCE read; sourcePath then carries the key found into the removal",
    },
  ],
  "src/install-cmd.ts": [
    {
      shape: "CALL readNested(root: Record<string, unknown>, containerPath: string[])",
      why: "the generic walker's own declaration -- it takes whatever path it is handed",
    },
    {
      shape:
        "CALL readEntryAt(existing: Record<string, unknown>, containerPath: string[], " +
        "entryName: string = ENTRY_NAME)",
      why: "declaration of the entry accessor one level up; same generic contract, same handed-in path",
    },
    {
      shape: "CALL readNested(existing, containerPath)",
      why: "readEntryAt's body, the same generic accessor one level up",
    },
    // install and uninstall no longer walk a container at all: both read
    // through the client-config core, which asks its own adapter for the
    // entries at the address it was handed. What is left in this file is the
    // two generic accessors' declarations and their bodies, kept while
    // try-cmd still calls mergeClientConfig.
    { shape: "LOOP for (const key of containerPath)", why: "readNested's own body" },
    { shape: "LOOP for (const variantPath of variantPaths.slice(1))", why: "install: the sibling scan" },
    {
      shape: "LOOP for (let i = 0; i < variantPaths.length; i++)",
      why: "uninstall: builds one RemovalSite per helper-derived path",
    },
    {
      shape: "LOOP for (let i = 0; i < containerPath.length - 1; i++)",
      why: "mergeClientConfig: clones the chain it WRITES into -- one path, never a variant",
    },
  ],
  // Every hit here is in the module that OWNS the projects key. That is the
  // point of listing them: a container path built with "projects" as its first
  // segment anywhere else is a second owner, and the fold has one.
  "src/install-targets.ts": [
    {
      shape: "INDEX const projects = (root as Record<string, unknown>)[PROJECTS_KEY];",
      why: "claudeCodeContainerPaths itself -- the one raw read of the projects object, which the fold is built from",
    },
    {
      shape: "INDEX for (const candidate of keysAt([PROJECTS_KEY])) {",
      why:
        "claudeCodeContainerPathVariants asking its key lister for the projects keys -- the same one read as " +
        "above, for the caller that holds the file's BYTES rather than a parsed root and so must not parse it",
    },
    {
      shape: "INDEX out.push([PROJECTS_KEY, candidate, ...containerPath.slice(2)]);",
      why: "claudeCodeContainerPaths building one variant path per case-variant key it found",
    },
    {
      shape: 'INDEX containerPath: ["projects", projectKey, "mcpServers"]',
      why: "resolveInstallPath: the local-scope container path, from claudeCodeProjectKey -- the canonical spelling",
    },
    {
      shape:
        "INDEX return { absolute, display: absolute, " + 'containerPath: ["projects", projectKey, "mcpServers"] };',
      why: "resolveInstallPath's other return, same canonical path for the explicit --project-dir branch",
    },
    {
      shape: "LOOP for (let i = 0; i < containerPath.length; i++)",
      why:
        "findBlockedContainerSegment: the pre-WRITE non-object check, on the canonical path a write goes to. " +
        "It lives here, not in install-cmd.ts, so doctor and import can ask the same question without an " +
        "import cycle -- and every caller hands it a path it must NOT fold",
    },
  ],
  // `src/try-cmd.ts` used to sit here with two walks -- peelEntryFromConfig's
  // and configHasEntry's. Both are gone: every `try` read and write goes
  // through the client-config core, which asks its own adapter for the entries
  // at the address it was handed. The path a trial MARKER recorded is still
  // read verbatim and handed to `markerSite`, and is still deliberately NOT
  // folded through claudeCodeContainerPaths -- a sweep must delete the key the
  // trial wrote and no other -- but that is now an address, not a walk.
};

function scanContainerWalks(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // `sourceFiles()`, the shared RECURSIVE FILESYSTEM walker -- not
  // `trackedFiles()`. Enumerating `git ls-files` meant a NEW module escaped
  // this scan until somebody ran `git add`, which is exactly the window in
  // which a new container reader gets written: the whole-map compare below
  // could not fail on a file git had never heard of. A directory read sees a
  // file the moment it exists. (The BYTE scans above still walk the tracked
  // set: their subject is what the repo ships, not what is on disk.)
  for (const file of sourceFiles()) {
    const found = scanSource(file.text);
    if (found.length > 0) out[file.path] = found;
  }
  return out;
}

describe("every client-config container read goes through claudeCodeContainerPaths", () => {
  it("scanned real files, and saw all three shape kinds", () => {
    // A coverage floor. A regex that matched nothing -- or one of the three
    // kinds silently breaking, which is exactly how the previous version of
    // this scan stayed green over a raw index and over a wrapped call --
    // would make the compare below pass on an empty or partial view.
    const scanned = scanContainerWalks();
    expect(Object.keys(scanned).length).toBeGreaterThanOrEqual(5);
    const all = Object.values(scanned).flat();
    expect(all.filter((s) => s.startsWith("CALL ")).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.startsWith("LOOP ")).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.startsWith("INDEX ")).length).toBeGreaterThan(0);
  });

  it("finds exactly the reads the table accounts for", () => {
    const scanned = scanContainerWalks();
    const expected: Record<string, string[]> = {};
    for (const [file, walks] of Object.entries(EXPECTED_WALKS)) expected[file] = walks.map((w) => w.shape).sort();
    // Whole-map compare, so a read in a file the table does not list fails too
    // -- a new reader module is exactly the shape this is watching for.
    expect(scanned).toEqual(expected);
  });

  it("has a stated reason for every read in the table", () => {
    // The reads that deliberately do NOT fold -- the writes, and the paths a
    // trial marker recorded -- are the ones a reviewer has to be able to
    // challenge, so each carries its reason here and a comment at the code.
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
    //
    // Either SPELLING counts. The rule and the sibling-key list live in one
    // place; `claudeCodeContainerPaths` takes a parsed root and
    // `claudeCodeContainerPathVariants` takes a key lister, and a reader that
    // holds the client config's BYTES rather than a parsed object must use the
    // second -- so requiring the first name would push a migrated reader back
    // to parsing a client config itself.
    for (const file of ["src/install-cmd.ts", "src/doctor-cmd.ts", "src/import-cmd.ts"]) {
      expect(readFileSync(join(REPO_ROOT, file), "utf8"), file).toMatch(
        /claudeCodeContainerPaths\b|claudeCodeContainerPathVariants\b/,
      );
    }
  });
});

// The scan's own coverage, driven on synthetic sources. Every claim made above
// about what this scan catches is one of the assertions below -- and the first
// four are precisely the shapes that defeated the previous, line-anchored
// version of it while every comment around it said otherwise.
describe("scanSource catches the shapes a new reader actually reaches for", () => {
  it("catches a raw projects-key index, the first thing a new reader writes", () => {
    const src = "const e = parsed.projects[key].mcpServers.mcp;\n";
    expect(scanSource(src)).toEqual(["INDEX const e = parsed.projects[key].mcpServers.mcp;"]);
  });

  it("catches the string-index and constant spellings of the same read", () => {
    expect(scanSource('const p = root["projects"];\n')).toEqual(['INDEX const p = root["projects"];']);
    expect(scanSource("const p = root[PROJECTS_KEY];\n")).toEqual(["INDEX const p = root[PROJECTS_KEY];"]);
  });

  it("catches a container path built with projects as its first segment", () => {
    // The other route to the container: skip the read, build the path. Only
    // install-targets is allowed to, and the table says so.
    expect(scanSource('const p = ["projects", key, "mcpServers"];\n')).toEqual([
      'INDEX const p = ["projects", key, "mcpServers"];',
    ]);
  });

  it("catches a helper call the formatter wrapped across lines", () => {
    // Identical shape to the one-liner, which is the point: running `biome
    // check --write` was enough to hide a call from the old scan.
    const wrapped = "const c = readNested(\n  existing,\n  containerPath,\n);\n";
    expect(scanSource(wrapped)).toEqual(["CALL readNested(existing, containerPath)"]);
    expect(scanSource(wrapped)).toEqual(scanSource("const c = readNested(existing, containerPath);\n"));
  });

  it("catches a C-style index loop over a container path", () => {
    const src = "for (let i = 0; i < containerPath.length; i++) {\n  node = node[containerPath[i]];\n}\n";
    expect(scanSource(src)).toEqual(["LOOP for (let i = 0; i < containerPath.length; i++)"]);
  });

  it("does not fire on display text that merely names a projects key", () => {
    // Every uninstall / doctor message names the key it acted on. Those are
    // strings, not reads, and flagging them would push the table into noise.
    expect(scanSource("log(`Removed the entry under projects[${JSON.stringify(k)}].`);\n")).toEqual([]);
    expect(scanSource('const isProject = containerPath[0] === "projects";\n')).toEqual([]);
  });

  it("does not fire on the same shapes inside a comment", () => {
    expect(scanSource("// const e = parsed.projects[key];\n")).toEqual([]);
    expect(scanSource("/* readNested(existing, containerPath) */\n")).toEqual([]);
  });

  it("ignores a for-loop that has nothing to do with a container path", () => {
    expect(scanSource("for (const line of preview) log(line);\n")).toEqual([]);
  });
});
