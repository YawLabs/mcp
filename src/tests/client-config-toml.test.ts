// Byte-exact pins for the TOML client-config adapter (Codex CLI).
//
// Same discipline as jsonc-splice.test.ts, and for the same reason: the bug
// class here is never a wrong VALUE (a re-serialized config.toml parses to the
// right thing) but wrong BYTES next to the edit -- a sibling's `'node'` turned
// into `"node"`, `20` into `20.0`, an unsorted env table re-sorted, a `#
// comment` dropped, a CRLF file rewritten with LF, a BOM stripped. Every
// assertion whose point is preservation compares WHOLE FILES with toBe.
//
// Where the point is semantics instead -- "Codex will read this as the entry
// we meant" -- the assertion is on the PARSED value, so that a renderer change
// that is only a spelling change does not read as a regression.
//
// FIXTURE PROVENANCE, because the two sets are not equally strong evidence:
//
//   f01-f16  come from the design pass (scratchpad/design/fixtures), copied
//            byte for byte. Every `expected*.toml` in that set was loaded by a
//            real codex-cli 0.144.0 (`codex mcp get <name> --json`) and
//            returned the intended entry, so they are the vendor-verified
//            ground truth for the renderer's field order, its `60.0` spelling
//            and its sorted env sub-table.
//   g01-g21  were added by this package for the splice shapes f01-f16 does not
//            reach (a header inside a multi-line string, first/middle/last
//            position, detached sub-tables, a BOM on the table's own line, the
//            refused spellings, a string that ENDS on a comment-looking line,
//            and backslash escapes). Their `expected*.toml` were produced by
//            running this adapter and then read back with a codex-cli 0.144.0
//            (same read-only probe), so they pin behaviour that was reviewed
//            and loaded rather than behaviour that was merely round-tripped.
//            g18/g19/g20/g21 input AND expected were each loaded by that codex
//            (`codex mcp list --json` / `get mcp --json` under a scratch
//            CODEX_HOME); g21's input returns both `mcp` and `other`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonTomlConfig,
  describeTomlShape,
  detectTomlEol,
  entryAsWritten,
  isTomlTable,
  parseTomlConfig,
  readTomlConfig,
  removeTomlEntry,
  renderTomlEntry,
  scanTomlSections,
  TomlConfigError,
  TomlRenderError,
  TomlSpliceRefusal,
  TomlVerifyError,
  tomlEntryFields,
  tomlEntryNames,
  tomlKey,
  tomlString,
  upsertTomlEntry,
  verifyTomlSplice,
} from "../client-config-toml.js";

// path.join, not a POSIX literal: on a Windows runner the SUT and the fixture
// keys have to agree, and only join() gives the same answer on both.
const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "codex");
const fixture = (id: string, file: string): string => readFileSync(join(FIXTURES, id, file), "utf8");

const CONTAINER = ["mcp_servers"];
const ENTRY = "mcp";

/** The default broker entry install writes (codex-cli.md 5). */
const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"], startup_timeout_sec: 60 };

// Control bytes and the BOM are built from code points, never typed escapes:
// a `\x7f` in this source could collapse to the raw byte on its way through a
// shell heredoc, and a raw control byte in a test file is invisible in
// `git diff` (which reports the file as binary).
const DEL = String.fromCharCode(0x7f);
const BOM = String.fromCharCode(0xfeff);
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
// The same discipline for the two bytes this file is ABOUT rather than merely
// contains: a backslash and a double quote written as code points cannot be
// eaten or doubled by anything between here and disk, and `BS + BS` in an
// assertion is unambiguously two bytes in the fixture, not one escape.
const BS = String.fromCharCode(0x5c);
const QUOTE = String.fromCharCode(0x22);

const lf = (...lines: string[]): string => `${lines.join("\n")}\n`;

/** The text of the line starting at `start`, without its line break -- for
 *  reading a scan's `continuedLines` back as lines a human can check. */
const lineTextAt = (text: string, start: number): string => {
  let i = start;
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
  return text.slice(start, i);
};

describe("the fixtures on disk", () => {
  it("still hold the bytes their tests are about", () => {
    // Not ceremony. The repo's root .gitattributes normalizes every file to LF
    // (`* text=auto eol=lf`), and with `core.autocrlf=true` that stored the
    // CRLF fixture as LF -- 54 bytes instead of 56. Every CRLF assertion below
    // would then have compared LF with LF: green, and testing nothing about
    // CRLF at all. `src/tests/fixtures/codex/.gitattributes` (`* -text`) turns
    // the conversion off; this is the assertion that notices if it stops
    // applying, on a fresh clone or under a different git config.
    expect(fixture("f04-crlf-bom", "input.toml")).toContain("\r\n");
    expect(fixture("f04-crlf-bom", "expected.toml")).toContain("\r\n");
    expect(fixture("f04-crlf-bom", "input.toml").charCodeAt(0)).toBe(0xfeff);
    expect(fixture("g17-bom-first-table", "input.toml").charCodeAt(0)).toBe(0xfeff);
    // ...and the conversion has not run the other way either: an LF fixture
    // pushed to CRLF would break the assertions that pin the LF renderer.
    expect(fixture("f01-missing", "expected.toml")).not.toContain("\r");
    expect(fixture("f03-siblings", "input.toml")).not.toContain("\r");
    expect(fixture("g11-empty", "input.toml")).toBe("");
    expect(fixture("g13-no-trailing-eol", "input.toml")).toBe('model = "gpt-5"');
  });

  it("g20 still holds the four backslash shapes the escape-skip tests are about", () => {
    // Every assertion about the scanner's in-string backslash skip is an
    // assertion about THESE BYTES, and they are exactly the bytes a tool
    // between here and disk is most likely to eat: `BS + BS` is two
    // backslashes in the file, and `BS + QUOTE` is a backslash followed by a
    // quote, whatever any layer in between would have done to a typed `\\`.
    const raw = fixture("g20-backslash", "input.toml");
    // 1. a basic string ending in an ESCAPED BACKSLASH before the terminator
    expect(raw).toContain(`cwd = ${QUOTE}C:${BS}${BS}dir${BS}${BS}${QUOTE}`);
    // 2. an ESCAPED QUOTE immediately before the terminator (and a `[`, a `]`
    //    and a `#` inside the string, which is what makes a mis-skip visible)
    expect(raw).toContain(`${QUOTE}X-Note: ${BS}${QUOTE}[draft] #1${BS}${QUOTE}${QUOTE}`);
    // 3. a `\t` and a `\u` escape, two characters each -- not the byte itself
    expect(raw).toContain(`tab = ${QUOTE}a${BS}tb${QUOTE}`);
    expect(raw).toContain(`uni = ${QUOTE}caf${BS}u00e9${QUOTE}`);
    // 4. a Windows path in an args value, and a literal string whose
    //    backslashes are NOT escapes
    expect(raw).toContain(`${QUOTE}C:${BS}${BS}Users${BS}${BS}jeff${QUOTE}`);
    expect(raw).toContain(`literal = 'C:${BS}dir${BS}raw'`);
    expect(raw.split(BS)).toHaveLength(18); // 17 backslashes, counted
    // The splice must not lose one: the expected file holds the same 17.
    expect(fixture("g20-backslash", "expected.toml").split(BS)).toHaveLength(18);
    // ...and no escape collapsed into the byte it denotes on the way in. A raw
    // control character here would be invisible in `git diff` (which calls the
    // file binary) and would make every assertion above pass for the wrong
    // reason. LF is the only sub-0x20 byte this fixture may hold.
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      expect(code >= 0x20 || code === 0x0a, `raw control byte 0x${code.toString(16)} at offset ${i}`).toBe(true);
    }
  });

  it("g21 still holds the escaped quote that only the mlBasic skip gets past", () => {
    // g20 is about SINGLE-line strings; the same skip exists a second time for
    // `"""` blocks, and only this fixture reaches it. The whole point is four
    // bytes -- backslash, quote, quote, quote -- so they are spelled from code
    // points here and read back from disk, never typed as an escape that a
    // shell or an editor could halve on the way in.
    for (const file of ["input.toml", "expected.toml"]) {
      const raw = fixture("g21-mlbasic-escaped-quote", file);
      expect(raw, file).toContain(`he said ${BS}${QUOTE}${QUOTE}${QUOTE}`);
      // Exactly one backslash in the file, and it is that one: a doubled or
      // eaten backslash would leave every other assertion here passing while
      // testing a different document.
      expect(raw.split(BS), file).toHaveLength(2);
      expect(raw.indexOf(BS), file).toBe(raw.indexOf(`he said ${BS}`) + "he said ".length);
      // The escape has NOT collapsed into the byte it denotes, and no other
      // control byte rode in with it. LF is the only sub-0x20 byte allowed.
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        expect(code >= 0x20 || code === 0x0a, `${file}: raw control byte 0x${code.toString(16)} at offset ${i}`).toBe(
          true,
        );
      }
    }
  });
});

describe("parse and classify", () => {
  it("reads a missing, empty or whitespace-only file as absent", () => {
    expect(readTomlConfig("", CONTAINER)).toEqual({ kind: "absent" });
    expect(readTomlConfig("   \n\n\t", CONTAINER)).toEqual({ kind: "absent" });
    expect(readTomlConfig(fixture("g11-empty", "input.toml"), CONTAINER)).toEqual({ kind: "absent" });
  });

  it("reports a malformed file with the reason and the position (f10)", () => {
    const read = readTomlConfig(fixture("f10-malformed", "input.toml"), CONTAINER, [ENTRY]);
    expect(read.kind).toBe("malformed");
    if (read.kind !== "malformed") return;
    // The position is the one a user can act on: line 2 is the unterminated
    // `command = "npx` and column 15 is where the string runs into the line
    // break. Measured against smol-toml 1.8.0.
    expect(read.line).toBe(2);
    expect(read.column).toBe(15);
    expect(read.reason).toBe("control characters are not allowed in strings");
    expect(read.detail).toBe("line 2, column 15: control characters are not allowed in strings");
    expect(read.syntax).toBe("TOML");
    // The reason must NOT carry smol-toml's multi-line source excerpt: the
    // repo's refusals are one line.
    expect(read.reason).not.toContain("\n");
  });

  it("throws TomlConfigError, not smol-toml's own error, with a one-line message", () => {
    try {
      parseTomlConfig(fixture("f10-malformed", "input.toml"));
      expect.unreachable("expected a parse error");
    } catch (e) {
      expect(e).toBeInstanceOf(TomlConfigError);
      expect((e as TomlConfigError).message).toBe(
        "not valid TOML (line 2, column 15: control characters are not allowed in strings)",
      );
    }
  });

  it("reports a container that is not a table as blocked, never reparable (f11)", () => {
    const read = readTomlConfig(fixture("f11-array-container", "input.toml"), CONTAINER, [ENTRY]);
    expect(read).toEqual({ kind: "blocked", path: ["mcp_servers"], shape: "an array of 1", reparable: false });
  });

  it("does not mistake a date for a table container", () => {
    // smol-toml returns a datetime as a Date subclass, so a `typeof` check
    // would walk into it as a container and append a header to a file Codex
    // already refuses to load.
    const read = readTomlConfig(lf("mcp_servers = 1979-05-27"), CONTAINER, [ENTRY]);
    expect(read).toEqual({ kind: "blocked", path: ["mcp_servers"], shape: "a date", reparable: false });
    expect(isTomlTable(parseTomlConfig(lf("[t]", "x = 1")))).toBe(true);
    expect(describeTomlShape(null)).toBe("null");
    expect(describeTomlShape("none")).toBe("a string");
    expect(describeTomlShape([])).toBe("an empty array");
  });

  it("reads a file with no mcp_servers at all as ok-but-absent (g12)", () => {
    const read = readTomlConfig(fixture("g12-no-container", "input.toml"), CONTAINER, [ENTRY]);
    expect(read).toEqual({ kind: "ok", containerPresent: false, entries: [] });
  });

  it("lists the server names in file order and decodes one entry's fields (f03)", () => {
    const read = readTomlConfig(fixture("f03-siblings", "expected.toml"), CONTAINER, [ENTRY]);
    expect(tomlEntryNames(read)).toEqual(["sib", "mcp"]);
    expect(tomlEntryFields(read, "sib")).toEqual({
      command: "node",
      args: ["x.js", "--flag"],
      startup_timeout_sec: 20,
      unknown_key: 1,
      env: { B: "2", A: "1" },
    });
    expect(tomlEntryFields(read, ENTRY)).toEqual(BROKER);
    expect(tomlEntryFields(read, "nope")).toBeUndefined();
  });

  it("accepts the spellings Codex accepts: quoted, whitespace, BOM, CRLF, big integers", () => {
    // Each of these is a valid config.toml Codex 0.144.0 loads (codex-cli.md
    // F9); a reader that rejected any of them would report a working file as
    // malformed in doctor and refuse to install into it.
    for (const raw of [
      lf('[mcp_servers."mcp"]', 'command = "npx"'),
      lf('[ mcp_servers . "mcp" ]', 'command = "npx"'),
      `${BOM}${lf("[mcp_servers.mcp]", 'command = "npx"')}`,
      '[mcp_servers.mcp]\r\ncommand = "npx"\r\n',
      lf("big = 1152921504606846976", "[mcp_servers.mcp]", 'command = "npx"'),
      lf("[mcp_servers.mcp.env]", 'A = "1"', "[mcp_servers.mcp]", 'command = "npx"'),
    ]) {
      const read = readTomlConfig(raw, CONTAINER);
      expect(read.kind).toBe("ok");
      expect(tomlEntryNames(read)).toContain(ENTRY);
    }
  });
});

describe("scanner", () => {
  it("finds header spans, decodes quoted and whitespace headers, and flags array tables", () => {
    const text = lf(
      "# lead",
      '[ mcp_servers . "mcp.hosting" ]',
      'command = "npx"',
      "",
      "# trailing note",
      "[[fruit]]",
      'name = "apple"',
    );
    const scan = scanTomlSections(text);
    expect(scan.sections.map((s) => s.keyPath)).toEqual([["mcp_servers", "mcp.hosting"], ["fruit"]]);
    expect(scan.sections.map((s) => s.arrayTable)).toEqual([false, true]);
    // The first section's content stops after `command = "npx"`: the blank
    // line and the `# trailing note` read as belonging to what follows, so a
    // replace or a delete leaves them alone.
    expect(text.slice(scan.sections[0].start, scan.sections[0].contentEnd)).toBe(
      lf('[ mcp_servers . "mcp.hosting" ]', 'command = "npx"'),
    );
    expect(text.slice(scan.sections[0].contentEnd, scan.sections[0].end)).toBe(lf("", "# trailing note"));
  });

  it("does not read a table header out of a multi-line basic string (g01)", () => {
    const scan = scanTomlSections(fixture("g01-mlbasic-header", "input.toml"));
    expect(scan.sections.map((s) => s.keyPath)).toEqual([["mcp_servers", "sib"], ["tui"]]);
  });

  it("does not read a table header out of a multi-line literal string (g02)", () => {
    const scan = scanTomlSections(fixture("g02-mlliteral-header", "input.toml"));
    expect(scan.sections.map((s) => s.keyPath)).toEqual([["mcp_servers", "sib"], ["tui"]]);
  });

  it("does not read a table header out of a multi-line array (g15)", () => {
    // The inner line is `  ["[mcp_servers.fake]"],` -- it starts with `[`, so
    // only the value-bracket depth tells it apart from a header.
    const scan = scanTomlSections(fixture("g15-mlarray-header", "input.toml"));
    expect(scan.sections.map((s) => s.keyPath)).toEqual([["mcp_servers", "sib"], ["tui"]]);
  });

  it("records which lines did NOT begin in normal state, and what carried into each", () => {
    // The map exists because a line's TEXT does not say what it is: inside a
    // `"""` block, `# closes it"""` is the string's last line and a line of
    // spaces is string content. Anything that walks lines (the `contentEnd`
    // back-off below) has to ask the scan, not the characters.
    const basic = fixture("g18-mlbasic-hash-close", "input.toml");
    expect(
      [...scanTomlSections(basic).continuedLines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, kind]) => [lineTextAt(basic, start), kind]),
    ).toEqual([
      ["line1", "mlBasic"],
      [`# closes it${QUOTE.repeat(3)}`, "mlBasic"],
    ]);

    const literal = fixture("g02-mlliteral-header", "input.toml");
    expect(
      [...scanTomlSections(literal).continuedLines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, kind]) => [lineTextAt(literal, start), kind]),
    ).toEqual([
      ["[mcp_servers.fake]", "mlLiteral"],
      ['command = "no"', "mlLiteral"],
      ["'''", "mlLiteral"],
    ]);

    // An open value-bracket is recorded the same way. It cannot change the
    // back-off's answer -- the line that closes a bracket holds the `]` that
    // closes it, so it is never blank-or-comment and a backwards walk stops
    // there either way -- but the map is a statement about the document, and
    // the next line-walker will want it.
    const array = fixture("g15-mlarray-header", "input.toml");
    expect(
      [...scanTomlSections(array).continuedLines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, kind]) => [lineTextAt(array, start), kind]),
    ).toEqual([
      ['  ["[mcp_servers.fake]"],', "bracket"],
      ["]", "bracket"],
    ]);

    // A file with no multi-line anything records nothing.
    expect(scanTomlSections(fixture("f03-siblings", "input.toml")).continuedLines.size).toBe(0);
  });

  it("keeps a sibling's whole multi-line string inside that sibling's span (g18)", () => {
    // This is the back-off's real job. `# closes it"""` LOOKS like a trailing
    // comment, so a text-only walk backs off over it and leaves the section
    // ending in the middle of `note`. Everything downstream then aims at that
    // offset: an insert lands INSIDE the string (valid TOML that loads, with
    // our entry nowhere in it) and a replace leaves the closing line behind.
    const raw = fixture("g18-mlbasic-hash-close", "input.toml");
    const scan = scanTomlSections(raw);
    expect(scan.sections.map((s) => s.keyPath)).toEqual([["mcp_servers", "other"]]);
    expect(raw.slice(scan.sections[0].start, scan.sections[0].contentEnd)).toBe(raw);
    // Codex 0.144.0 loads this file and reads `other` from it -- it is a
    // legitimate config, not a corrupt one, so the answer has to be a correct
    // write and not a refusal.
    expect(tomlEntryFields(readTomlConfig(raw, CONTAINER), "other")).toEqual({
      command: "node",
      note: `line1\n# closes it`,
    });
  });

  it("lets a run of extra quotes close a multi-line string, and stays in phase after it", () => {
    // TOML closes `"""he said """"` with the LAST three quotes. A scanner that
    // stops at the first three is one quote out of phase: the stray quote
    // opens a single-line string, the `[` of the next item is then read as an
    // open value-bracket, and that depth carries to the following line -- where
    // it hides the next table header.
    //
    // Both delimiters, because they are two separate runs in the scanner and
    // only one of them had a test.
    const TICK = String.fromCharCode(0x27);
    for (const [q, closer] of [
      [QUOTE, `a${QUOTE}`],
      [TICK, `a${TICK}`],
    ] as const) {
      const text = lf(
        "[mcp_servers.sib]",
        `args = [${q.repeat(3)}a${q.repeat(4)}, "[x]"]`,
        "",
        "[tui]",
        'theme = "dark"',
      );
      expect(parseTomlConfig(text), text).toEqual({
        mcp_servers: { sib: { args: [closer, "[x]"] } },
        tui: { theme: "dark" },
      });
      const scan = scanTomlSections(text);
      expect(
        scan.sections.map((s) => s.keyPath),
        text,
      ).toEqual([["mcp_servers", "sib"], ["tui"]]);
      expect(scan.continuedLines.size, text).toBe(0);
    }
  });

  it("stays in phase across an escaped quote inside a single-line string (g20)", () => {
    // `"X-Note: \"[draft] #1\""` holds an escaped quote, a `[`, a `]` and a
    // `#`. Without the in-string backslash skip the scanner ends that string
    // early, counts the `[` as an open bracket, hits the `#` as a comment and
    // carries a depth of 1 into every line that follows -- so the two headers
    // below it disappear from the scan.
    const raw = fixture("g20-backslash", "input.toml");
    const scan = scanTomlSections(raw);
    expect(scan.sections.map((s) => s.keyPath)).toEqual([
      ["mcp_servers", "other"],
      ["mcp_servers", `café ${QUOTE}x${QUOTE}`],
      ["mcp_servers", "mcp"],
    ]);
    expect(scan.continuedLines.size).toBe(0);
    // The decoded header key is the point of the `\u` and `\"` in it.
    expect(tomlEntryNames(readTomlConfig(raw, CONTAINER))).toEqual(["other", `café ${QUOTE}x${QUOTE}`, "mcp"]);
  });

  it("stays in phase across an escaped quote inside a MULTI-LINE string (g21)", () => {
    // The scanner carries the same in-string backslash skip twice, once per
    // basic-string state, and g20 above only reaches the single-line one. This
    // is the `"""` twin: `he said \"""` is an escaped quote followed by two
    // literal quotes, so the block runs on. Without the skip in `mlBasic` the
    // scanner reads those three raw quotes as the terminator, ends the string
    // two lines early, and the `"""` that really closes it OPENS a new block
    // that swallows the rest of the file -- taking `[mcp_servers.mcp]` with
    // it. Codex 0.144.0 loads this file and lists both servers, so the answer
    // has to be a correct write; the next test is the consequence.
    const raw = fixture("g21-mlbasic-escaped-quote", "input.toml");
    const scan = scanTomlSections(raw);
    expect(scan.sections.map((s) => s.keyPath)).toEqual([
      ["mcp_servers", "other"],
      ["mcp_servers", "mcp"],
    ]);
    // The three lines inside the block, and nothing after it: the closing
    // `"""` line is the last one that did not begin in normal state.
    expect(
      [...scan.continuedLines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, kind]) => [lineTextAt(raw, start), kind]),
    ).toEqual([
      [`he said ${BS}${QUOTE}${QUOTE}${QUOTE}`, "mlBasic"],
      ["still inside", "mlBasic"],
      [QUOTE.repeat(3), "mlBasic"],
    ]);
    // ...and the sibling's span ends at the block's real end, not inside it.
    expect(raw.slice(scan.sections[0].start, scan.sections[0].contentEnd)).toBe(
      raw.slice(0, raw.indexOf(`\n\n[mcp_servers.mcp]`) + 1),
    );
    expect(tomlEntryFields(readTomlConfig(raw, CONTAINER), "other")).toEqual({
      command: "node",
      note: `he said ${QUOTE.repeat(3)}\nstill inside\n`,
    });
  });

  it("keeps a BOM outside every section span (g17)", () => {
    const raw = fixture("g17-bom-first-table", "input.toml");
    const scan = scanTomlSections(raw);
    expect(scan.sections[0].start).toBe(1);
    expect(raw.slice(0, scan.sections[0].start)).toBe(BOM);
  });

  it("records the assignments that define entries without a header", () => {
    const rootDotted = scanTomlSections(fixture("f16-dotted", "input.toml"));
    expect(rootDotted.sections).toEqual([]);
    expect(rootDotted.assignments.map((a) => [a.section, a.keyPath, a.inlineTable])).toEqual([
      [[], ["mcp_servers", "mcp", "command"], false],
      [[], ["mcp_servers", "mcp", "args"], false],
      [[], ["mcp_servers", "mcp", "startup_timeout_sec"], false],
    ]);
    const inlineEntry = scanTomlSections(fixture("f09-inline", "input.toml"));
    expect(inlineEntry.assignments.map((a) => [a.section, a.keyPath, a.inlineTable])).toEqual([
      [["mcp_servers"], ["mcp"], true],
    ]);
    const inlineRoot = scanTomlSections(fixture("g09-inline-root", "input.toml"));
    expect(inlineRoot.assignments[0]).toMatchObject({ section: [], keyPath: ["mcp_servers"], inlineTable: true });
  });

  it("reads the file's own line ending", () => {
    expect(detectTomlEol("a = 1\nb = 2\n")).toBe("\n");
    expect(detectTomlEol("a = 1\r\nb = 2\r\n")).toBe("\r\n");
    expect(detectTomlEol("a = 1")).toBe("\n");
    expect(scanTomlSections(fixture("f04-crlf-bom", "input.toml")).eol).toBe("\r\n");
  });
});

describe("renderer", () => {
  it("writes the broker entry in Codex's own field order (f01)", () => {
    expect(renderTomlEntry(CONTAINER, ENTRY, BROKER)).toBe(fixture("f01-missing", "expected.toml"));
  });

  it("puts auth and enabled where Codex re-serialized them on an HTTP entry", () => {
    // The third bullet above FIELD_ORDER, as an assertion instead of a
    // sentence. MEASURED on codex-cli 0.144.0: a scrambled HTTP entry handed
    // to `codex mcp add <other>` under a scratch CODEX_HOME came back in
    // exactly this order -- `auth` between `bearer_token_env_var` and
    // `enabled`, the two header maps as sub-tables after every key-value line.
    // The value is `chatgpt` and not `oauth` on purpose: `oauth` is the one
    // spelling 0.144.0 drops on the way back out, so it could not have placed
    // the field.
    expect(
      renderTomlEntry(CONTAINER, ENTRY, {
        tool_timeout_sec: 11,
        enabled: false,
        auth: "chatgpt",
        startup_timeout_sec: 22,
        bearer_token_env_var: "TOK",
        url: "https://example.com/mcp",
        env_http_headers: { B: "b" },
        http_headers: { A: "a" },
      }),
    ).toBe(
      lf(
        "[mcp_servers.mcp]",
        'url = "https://example.com/mcp"',
        'bearer_token_env_var = "TOK"',
        'auth = "chatgpt"',
        "enabled = false",
        "startup_timeout_sec = 22.0",
        "tool_timeout_sec = 11.0",
        "",
        "[mcp_servers.mcp.http_headers]",
        'A = "a"',
        "",
        "[mcp_servers.mcp.env_http_headers]",
        'B = "b"',
      ),
    );
  });

  it("spells an integral timeout as a float, the way Codex's f64 serializer does", () => {
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "x", startup_timeout_sec: 60 })).toContain(
      "startup_timeout_sec = 60.0",
    );
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "x", tool_timeout_sec: 60 })).toContain(
      "tool_timeout_sec = 60.0",
    );
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "x", startup_timeout_sec: 7.5 })).toContain(
      "startup_timeout_sec = 7.5",
    );
    // Not every number is an f64 field: a plain integer keeps its spelling.
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "x", callback_port: 8080 })).toContain("callback_port = 8080");
  });

  it("writes env as a sub-table with BYTE-SORTED keys (f13)", () => {
    const rendered = renderTomlEntry(CONTAINER, ENTRY, {
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
      env_vars: ["HTTPS_PROXY"],
      startup_timeout_sec: 60,
      env: { OAM_BIN: "/opt/oam", "A.B": "1" },
    });
    expect(rendered).toBe(fixture("f13-env-vars-carried", "expected-repair.toml"));
    // The sort is on the DECODED key, not the quoted spelling: `"A.B"` sorts
    // before `OAM_BIN` on 'A' < 'O', and would sort after it if the leading
    // quote counted.
    expect(rendered.indexOf('"A.B"')).toBeLessThan(rendered.indexOf("OAM_BIN"));
  });

  it("sorts sub-table keys by UTF-8 BYTES, the way a Rust BTreeMap does", () => {
    // Codex sorts Rust `String` keys, which is a byte comparison of the UTF-8
    // encoding. A JS `<` compares UTF-16 code units, and the two disagree
    // above the BMP: U+1F600's first code unit is 0xD83D, BELOW U+E000, while
    // its UTF-8 encoding f0 9f 98 80 is ABOVE ee 80 80. Measured, both ways:
    const ASTRAL = String.fromCodePoint(0x1f600);
    const PUA = String.fromCodePoint(0xe000);
    expect(ASTRAL < PUA).toBe(true); // JS: astral first
    expect(Buffer.compare(Buffer.from(ASTRAL, "utf8"), Buffer.from(PUA, "utf8"))).toBe(1); // Rust: astral last
    // Only an env var NAME with an astral character reaches the difference and
    // the cost of getting it wrong is a spurious one-line drift diff on the
    // next install -- but the comment claims Codex's order, so the code has to
    // have it.
    const sub = renderTomlEntry(CONTAINER, ENTRY, { command: "npx", env: { [ASTRAL]: "1", [PUA]: "2" } });
    expect(sub.indexOf(PUA)).toBeLessThan(sub.indexOf(ASTRAL));
    // The unknown-scalar tail is sorted by the same comparison, so the whole
    // output is one order and not two.
    const tail = renderTomlEntry(CONTAINER, ENTRY, { command: "npx", [ASTRAL]: 1, [PUA]: 2 });
    expect(tail.indexOf(PUA)).toBeLessThan(tail.indexOf(ASTRAL));
    // Below the BMP the two orders agree, and that is the everyday case.
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "npx", env: { B: "2", A: "1" } })).toContain(
      lf("[mcp_servers.mcp.env]", 'A = "1"', 'B = "2"'),
    );
  });

  it("names the field it would have dropped, for the two table-valued fields Codex has and this writer does not", () => {
    // The decision above FIELD_ORDER, as behaviour: `oauth` and `tools` are
    // tables in Codex, this renderer writes neither, and the answer is a
    // refusal that names the field -- never a silent drop. Measured on
    // codex-cli 0.144.0 under a scratch CODEX_HOME: re-serializing an entry
    // that carried both wrote `[mcp_servers.hh.oauth]` (explicit, flat, and
    // an unknown key inside it dropped) and `[mcp_servers.zz.tools.echo]`
    // (implicit parent, explicit child, no `[...tools]` header) -- five
    // table-valued fields in all, not the three below.
    for (const [key, value] of [
      ["oauth", { client_id: "cid" }],
      ["tools", { echo: { approval_mode: "auto" } }],
    ] as const) {
      const entry = { command: "npx", [key]: value };
      expect(() => renderTomlEntry(CONTAINER, ENTRY, entry)).toThrow(TomlRenderError);
      expect(() => renderTomlEntry(CONTAINER, ENTRY, entry)).toThrow(new RegExp(`would drop your "${key}" table`));
      // The remedy has to be an action, not just a complaint.
      expect(() => renderTomlEntry(CONTAINER, ENTRY, entry)).toThrow(/then re-run/);
    }
    // The three it does write are still written, each as its own header.
    const all = renderTomlEntry(CONTAINER, ENTRY, {
      command: "npx",
      env: { A: "1" },
      http_headers: { B: "2" },
      env_http_headers: { C: "3" },
    });
    expect(all).toContain("[mcp_servers.mcp.env]");
    expect(all).toContain("[mcp_servers.mcp.http_headers]");
    expect(all).toContain("[mcp_servers.mcp.env_http_headers]");
  });

  it("quotes a key that cannot be bare, in the header and in the sub-table header (f15)", () => {
    expect(tomlKey("mcp")).toBe("mcp");
    expect(tomlKey("yaw-mcp")).toBe("yaw-mcp");
    expect(tomlKey("mcp.hosting")).toBe('"mcp.hosting"');
    expect(tomlKey("has space")).toBe('"has space"');
    expect(
      renderTomlEntry(CONTAINER, "yaw-mcp-try-foo.bar", {
        command: "npx",
        args: ["-y", "@acme/foo-mcp"],
        startup_timeout_sec: 60,
        env: { FOO_TOKEN: "t0k" },
      }),
    ).toBe(fixture("f15-trial-quoted-key", "expected.toml"));
  });

  it("escapes a Windows path's backslashes (f14)", () => {
    expect(
      renderTomlEntry(CONTAINER, ENTRY, {
        command: "C:\\Users\\me\\.oam\\bin\\oam.exe",
        args: [
          "run",
          "--no-check",
          "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
        ],
        startup_timeout_sec: 60,
      }),
    ).toBe(fixture("f14-oam-windows", "expected.toml"));
  });

  it("escapes U+007F, which JSON.stringify leaves raw and TOML forbids raw", () => {
    expect(tomlString(`x${DEL}y`)).toBe('"x\\u007Fy"');
    // The point is not the spelling, it is that the result parses: a raw DEL
    // makes smol-toml (and Codex) reject the file.
    expect(parseTomlConfig(`a = ${tomlString(`x${DEL}y`)}`)).toEqual({ a: `x${DEL}y` });
    expect(() => parseTomlConfig(`a = "x${DEL}y"`)).toThrow(TomlConfigError);
  });

  it("round-trips every code point up to U+00FF, and astral characters", () => {
    // One assertion over the whole C0/C1 range rather than a hand-picked
    // escape: the claim is that `tomlString` output always parses back equal.
    for (let code = 0; code <= 0xff; code++) {
      const value = `a${String.fromCharCode(code)}b`;
      const parsed = parseTomlConfig(`k = ${tomlString(value)}`) as { k: string };
      expect(parsed.k, `code point ${code}`).toBe(value);
    }
    for (const value of ["\u{1F600}", "\u2028", `${ESC}[0m`, `${NUL}`, '"quoted"', "back\\slash", "tab\there"]) {
      const parsed = parseTomlConfig(`k = ${tomlString(value)}`) as { k: string };
      expect(parsed.k).toBe(value);
    }
  });

  it("refuses a lone surrogate rather than writing TOML that will not parse", () => {
    // JSON.stringify emits a lone surrogate as a `\udXXX` escape; TOML escapes
    // denote Unicode SCALAR values, and smol-toml rejects that escape
    // ("invalid unicode escape"). There is no spelling to fall back to.
    const lone = String.fromCharCode(0xd800);
    expect(() => tomlString(`x${lone}y`)).toThrow(TomlRenderError);
    expect(() => tomlString(`x${String.fromCharCode(0xdc00)}y`)).toThrow(/lone surrogate/);
    // A well-formed pair is fine.
    expect(tomlString("\u{1F600}")).toBe('"\u{1F600}"');
  });

  it("renders an env_vars table item as an inline table", () => {
    expect(
      renderTomlEntry(CONTAINER, ENTRY, {
        command: "npx",
        env_vars: ["HTTPS_PROXY", { name: "FOO", source: "local" }],
      }),
    ).toBe(
      lf("[mcp_servers.mcp]", 'command = "npx"', 'env_vars = ["HTTPS_PROXY", { name = "FOO", source = "local" }]'),
    );
  });

  it("puts an unknown scalar field after the known ones, in a stable order", () => {
    const a = renderTomlEntry(CONTAINER, ENTRY, { zebra: 1, command: "npx", apple: true });
    const b = renderTomlEntry(CONTAINER, ENTRY, { apple: true, zebra: 1, command: "npx" });
    expect(a).toBe(b);
    expect(a).toBe(lf("[mcp_servers.mcp]", 'command = "npx"', "apple = true", "zebra = 1"));
  });

  it("refuses a value it has no verified spelling for, instead of guessing", () => {
    expect(() =>
      renderTomlEntry(CONTAINER, ENTRY, { command: "x", tools: { echo: { approval_mode: "auto" } } }),
    ).toThrow(TomlRenderError);
    expect(() => renderTomlEntry(CONTAINER, ENTRY, { command: "x", startup_timeout_sec: Number.NaN })).toThrow(
      /not a finite number/,
    );
    expect(() => renderTomlEntry(CONTAINER, ENTRY, { command: "x", env: "nope" })).toThrow(/not a table/);
  });

  it("omits only undefined fields and an empty env, and says so through entryAsWritten", () => {
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "npx", args: undefined, env: {} })).toBe(
      lf("[mcp_servers.mcp]", 'command = "npx"'),
    );
    expect(entryAsWritten({ command: "npx", args: undefined, env: {} })).toEqual({ command: "npx" });
    // An empty array IS written: Codex omits one when it serializes, but the
    // round-trip has to be exact.
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "npx", args: [] })).toBe(
      lf("[mcp_servers.mcp]", 'command = "npx"', "args = []"),
    );
  });

  it("uses the line ending it is given", () => {
    expect(renderTomlEntry(CONTAINER, ENTRY, { command: "npx", env: { A: "1" } }, "\r\n")).toBe(
      '[mcp_servers.mcp]\r\ncommand = "npx"\r\n\r\n[mcp_servers.mcp.env]\r\nA = "1"\r\n',
    );
  });
});

describe("upsert -- byte-exact", () => {
  const cases: Array<[string, string, Record<string, unknown>, string[], string]> = [
    ["f02-trust-only", "expected.toml", BROKER, [], "appends after a file with no servers"],
    ["f03-siblings", "expected.toml", BROKER, [], "appends after the last server table, before [tui]"],
    ["f04-crlf-bom", "expected.toml", BROKER, [], "keeps the BOM and writes CRLF"],
    ["f05-identical", "expected.toml", BROKER, [], "rewrites an identical entry to the same bytes"],
    ["f06-codex-add-shape", "expected-repair.toml", BROKER, [], "adds the timeout to what codex mcp add wrote"],
    ["f08-legacy", "expected.toml", BROKER, ["yaw-mcp"], "takes a legacy table's place"],
    ["f08b-legacy-quoted", "expected.toml", BROKER, ["mcp.hosting"], "takes a quoted legacy table's place"],
    ["g01-mlbasic-header", "expected.toml", BROKER, [], "ignores a header inside a multi-line basic string"],
    ["g02-mlliteral-header", "expected.toml", BROKER, [], "ignores a header inside a multi-line literal string"],
    ["g03-quoted-ws-header", "expected.toml", BROKER, [], "replaces a whitespace-and-quoted header in place"],
    ["g04-comment-above", "expected.toml", BROKER, [], "keeps the comment above the header"],
    ["g05-entry-first", "expected.toml", BROKER, [], "replaces the first server in place"],
    ["g06-entry-middle", "expected.toml", BROKER, [], "replaces a middle server in place"],
    ["g07-entry-last", "expected.toml", BROKER, [], "replaces the last server in place"],
    ["g12-no-container", "expected.toml", BROKER, [], "appends at end of file when there is no container"],
    ["g13-no-trailing-eol", "expected.toml", BROKER, [], "adds the missing final line break first"],
    ["g15-mlarray-header", "expected.toml", BROKER, [], "ignores a bracketed line inside a multi-line array"],
    ["g16-subtable-first", "expected.toml", BROKER, [], "collapses a sub-table written before its parent"],
    ["g17-bom-first-table", "expected.toml", BROKER, [], "keeps a BOM on the replaced table's own line"],
    ["g18-mlbasic-hash-close", "expected.toml", BROKER, [], "appends AFTER a sibling string that ends on a `#` line"],
    ["g19-own-hash-close", "expected.toml", BROKER, [], "replaces our own table whose string ends on a `#` line"],
    ["g20-backslash", "expected.toml", BROKER, [], "keeps every escaped backslash and quote around the edit"],
    ["g21-mlbasic-escaped-quote", "expected.toml", BROKER, [], "replaces our table below a sibling's escaped quote"],
  ];
  for (const [id, expectedFile, entry, legacy, what] of cases) {
    it(`${id}: ${what}`, () => {
      const input = fixture(id, "input.toml");
      const next = upsertTomlEntry(input, CONTAINER, ENTRY, entry, { replaceLegacy: legacy });
      expect(next).toBe(fixture(id, expectedFile));
      // Semantics, not just bytes: Codex must read back the entry we meant.
      expect(tomlEntryFields(readTomlConfig(next, CONTAINER), ENTRY)).toEqual(entryAsWritten(entry));
    });
  }

  it("f01: renders the table on its own for a missing file", () => {
    expect(upsertTomlEntry(null, CONTAINER, ENTRY, BROKER)).toBe(fixture("f01-missing", "expected.toml"));
  });

  it("g11: renders the table on its own for an empty file", () => {
    expect(upsertTomlEntry(fixture("g11-empty", "input.toml"), CONTAINER, ENTRY, BROKER)).toBe(
      fixture("g11-empty", "expected.toml"),
    );
  });

  it("copies a whitespace-only file's line ending into the fresh table", () => {
    expect(upsertTomlEntry("\r\n\r\n", CONTAINER, ENTRY, { command: "npx" })).toBe(
      '[mcp_servers.mcp]\r\ncommand = "npx"\r\n',
    );
  });

  it("f07: --repair keeps the env sub-table wherever it sat, --force drops it", () => {
    const input = fixture("f07-env-elsewhere", "input.toml");
    const repaired = upsertTomlEntry(input, CONTAINER, ENTRY, {
      ...BROKER,
      env: { YAW_MCP_VAULT_PASSPHRASE: "s3cret" },
    });
    expect(repaired).toBe(fixture("f07-env-elsewhere", "expected-repair.toml"));
    expect(upsertTomlEntry(input, CONTAINER, ENTRY, BROKER)).toBe(fixture("f07-env-elsewhere", "expected-force.toml"));
    // The detached `[mcp_servers.mcp.env]` table at the end of the file is
    // gone in both: it belongs to our entry, so it is replaced with it.
    expect(repaired.match(/mcp_servers\.mcp\.env/g)).toHaveLength(1);
  });

  it("f13: carries env_vars and a dotted env key through a rewrite", () => {
    expect(
      upsertTomlEntry(fixture("f13-env-vars-carried", "input.toml"), CONTAINER, ENTRY, {
        ...BROKER,
        env_vars: ["HTTPS_PROXY"],
        env: { "A.B": "1", OAM_BIN: "/opt/oam" },
      }),
    ).toBe(fixture("f13-env-vars-carried", "expected-repair.toml"));
  });

  it("g08: replaces the entry and deletes its detached sub-tables", () => {
    const next = upsertTomlEntry(fixture("g08-subtables", "input.toml"), CONTAINER, ENTRY, {
      ...BROKER,
      env: { A: "1" },
    });
    expect(next).toBe(fixture("g08-subtables", "expected.toml"));
    // The `[mcp_servers.mcp.tools.echo]` table went with the entry it belongs
    // to; `[tui]` did not.
    expect(next).not.toContain("tools");
    expect(next).toContain('theme = "dark"');
  });

  it("g18: the sibling's multi-line string still MEANS what it meant", () => {
    // Bytes are the row above; this is the consequence. Written into the
    // string, our block would leave a file that still parses and still loads
    // -- with `mcp` absent and the sibling's `note` holding our table. That is
    // the shape no amount of "it parses" catches, so assert the value.
    const next = upsertTomlEntry(fixture("g18-mlbasic-hash-close", "input.toml"), CONTAINER, ENTRY, BROKER);
    const read = readTomlConfig(next, CONTAINER);
    expect(tomlEntryNames(read)).toEqual(["other", ENTRY]);
    expect(tomlEntryFields(read, "other")).toEqual({ command: "node", note: `line1\n# closes it` });
    expect(tomlEntryFields(read, ENTRY)).toEqual(entryAsWritten(BROKER));
  });

  it("g19: replacing our own such table leaves no fragment of it behind", () => {
    // The other half of the same back-off. Here the string is OURS, so the
    // write succeeds either way -- and a text-only walk ends our span one line
    // early, leaving `# closes it"""` in the file as a comment that reads like
    // a stray line nobody can account for.
    const next = upsertTomlEntry(fixture("g19-own-hash-close", "input.toml"), CONTAINER, ENTRY, BROKER);
    expect(next).not.toContain("closes it");
    expect(next).not.toContain(QUOTE.repeat(3));
    expect(tomlEntryFields(readTomlConfig(next, CONTAINER), ENTRY)).toEqual(entryAsWritten(BROKER));
  });

  it("g20: an escaped quote and a Windows path next to the edit come back byte for byte", () => {
    const input = fixture("g20-backslash", "input.toml");
    const next = upsertTomlEntry(input, CONTAINER, ENTRY, BROKER);
    for (const line of input.split("\n").filter((l) => l.includes(BS))) {
      expect(next, `lost or rewrote: ${JSON.stringify(line)}`).toContain(line);
    }
    expect(next.split(BS)).toHaveLength(18);
    // and the sibling's values still decode to what they decoded to before
    expect(tomlEntryFields(readTomlConfig(next, CONTAINER), "other")).toEqual({
      command: "node",
      args: [`--header`, `X-Note: ${QUOTE}[draft] #1${QUOTE}`, `C:${BS}Users${BS}jeff`],
      cwd: `C:${BS}dir${BS}`,
      tab: `a\tb`,
      uni: "café",
      literal: `C:${BS}dir${BS}raw`,
    });
  });

  it("g21: a sibling's escaped quote does not turn a legitimate config into a refusal", () => {
    // The g18 failure class, on the `"""` twin of the skip g20 pins. Out of
    // phase, the scan loses `[mcp_servers.mcp]` into a string, the parse still
    // finds the entry, and the two disagree -- which upsert reports as
    // `TomlSpliceRefusal`. A user whose config real codex loads would be told
    // their entry "is not written as a [mcp_servers.mcp] table" and left to
    // edit it by hand. So assert the write SUCCEEDS, and that both entries
    // still mean what they meant.
    const input = fixture("g21-mlbasic-escaped-quote", "input.toml");
    const next = upsertTomlEntry(input, CONTAINER, ENTRY, BROKER);
    const read = readTomlConfig(next, CONTAINER);
    expect(tomlEntryNames(read)).toEqual(["other", ENTRY]);
    expect(tomlEntryFields(read, "other")).toEqual({
      command: "node",
      note: `he said ${QUOTE.repeat(3)}\nstill inside\n`,
    });
    expect(tomlEntryFields(read, ENTRY)).toEqual(entryAsWritten(BROKER));
    // Replaced in place, not appended next to a leftover: one such header.
    expect(next.split("[mcp_servers.mcp]")).toHaveLength(2);
    expect(next).not.toContain('command = "old"');
    // The one backslash survived the splice.
    expect(next.split(BS)).toHaveLength(2);
  });

  it("leaves every other byte alone -- comments, quoting, number spelling, unsorted env (f03)", () => {
    const input = fixture("f03-siblings", "input.toml");
    const next = upsertTomlEntry(input, CONTAINER, ENTRY, BROKER);
    // The sibling's own bytes, verbatim. A writer that re-serialized the
    // document would return `'node'` as `"node"`, `20` as `20.0`, the env
    // table sorted, and would drop both comments.
    expect(next).toContain("# top comment");
    expect(next).toContain('model = "gpt-5"   # inline comment');
    expect(next).toContain("# the sibling server");
    expect(next).toContain("command = 'node'");
    expect(next).toContain('args = [ "x.js" ,"--flag" ]');
    expect(next).toContain("startup_timeout_sec = 20");
    expect(next).toContain("unknown_key = 1");
    expect(next).toContain(lf("[mcp_servers.sib.env]", 'B = "2"', 'A = "1"'));
    // and the trust table, which a splice that miscounted lines would eat
    expect(next).toContain(lf("[projects.'/home/me/repo']", 'trust_level = "trusted"'));
  });
});

describe("remove -- byte-exact", () => {
  for (const id of [
    "g04-comment-above",
    "g05-entry-first",
    "g06-entry-middle",
    "g07-entry-last",
    "g08-subtables",
    "g16-subtable-first",
    "g17-bom-first-table",
  ]) {
    it(`${id}: deletes the entry's tables and one adjacent blank line`, () => {
      const next = removeTomlEntry(fixture(id, "input.toml"), CONTAINER, ENTRY);
      expect(next).toBe(fixture(id, "expected-removed.toml"));
      expect(tomlEntryNames(readTomlConfig(next, CONTAINER))).not.toContain(ENTRY);
    });
  }

  it("returns the SAME string, BOM included, when the entry is absent", () => {
    // Referential equality is the contract try's cleanup and doctor's GC read
    // as "nothing to do": returning a copy would make them write the file back
    // and report a removal that did not happen.
    const raw = `${BOM}${fixture("f02-trust-only", "input.toml")}`;
    expect(removeTomlEntry(raw, CONTAINER, ENTRY)).toBe(raw);
    expect(removeTomlEntry("", CONTAINER, ENTRY)).toBe("");
    const noContainer = fixture("g12-no-container", "input.toml");
    expect(removeTomlEntry(noContainer, CONTAINER, ENTRY)).toBe(noContainer);
  });

  it("returns a whitespace-only file UNCHANGED, not an empty one", () => {
    // The early return is `raw`, deliberately, and nothing pinned it: turning
    // it into `""` left every test green. The two answers say opposite things
    // to the callers the doc comment names -- `next === raw` is "nothing to
    // do" (do not write, do not report a removal), while `""` is "I rewrote
    // your file to nothing", and try's cleanup and doctor's GC would act on it.
    // A whitespace-only config.toml is an ordinary thing to find: Codex reads
    // it exactly like a missing one.
    for (const raw of ["   \n\n\t", " ", "\n", "\r\n \r\n", `${BOM}   \n`]) {
      expect(removeTomlEntry(raw, CONTAINER, ENTRY), JSON.stringify(raw)).toBe(raw);
      expect(removeTomlEntry(raw, CONTAINER, ENTRY)).not.toBe("");
    }
    // The one input whose correct answer IS "" is the one where "" is also the
    // input, so the contract holds there without a special case.
    expect(removeTomlEntry("", CONTAINER, ENTRY)).toBe("");
  });

  it("leaves an empty file when our table was the whole file", () => {
    // Codex reads a 0-byte config.toml as an empty table, so this is the TOML
    // analogue of JSON's leftover `{"mcpServers": {}}`.
    expect(removeTomlEntry(fixture("f01-missing", "expected.toml"), CONTAINER, ENTRY)).toBe("");
  });

  it("keeps a sibling server untouched", () => {
    const next = removeTomlEntry(fixture("f03-siblings", "expected.toml"), CONTAINER, ENTRY);
    expect(next).toBe(fixture("f03-siblings", "input.toml"));
  });
});

describe("round trip", () => {
  for (const id of ["f02-trust-only", "f03-siblings", "f04-crlf-bom", "g01-mlbasic-header", "g12-no-container"]) {
    it(`${id}: remove(upsert(x)) is x, byte for byte`, () => {
      const input = fixture(id, "input.toml");
      expect(removeTomlEntry(upsertTomlEntry(input, CONTAINER, ENTRY, BROKER), CONTAINER, ENTRY)).toBe(input);
    });
  }

  it("f01: uninstalling a file we created leaves it empty", () => {
    const created = upsertTomlEntry(null, CONTAINER, ENTRY, BROKER);
    expect(removeTomlEntry(created, CONTAINER, ENTRY)).toBe("");
  });

  it("upserting twice is idempotent", () => {
    const once = upsertTomlEntry(fixture("f03-siblings", "input.toml"), CONTAINER, ENTRY, BROKER);
    expect(upsertTomlEntry(once, CONTAINER, ENTRY, BROKER)).toBe(once);
  });
});

describe("refusals -- the spellings a span splice will not edit", () => {
  const shapes: Array<[string, string, RegExp, boolean]> = [
    ["f09-inline", ENTRY, /an inline table under \[mcp_servers\] \(mcp = \{ \.\.\. \}\)/, false],
    ["f16-dotted", ENTRY, /dotted keys at the top level/, false],
    ["g14-dotted-in-container", ENTRY, /dotted keys under \[mcp_servers\]/, false],
    ["g10-array-entry", ENTRY, /an array of tables/, true],
    ["g09-inline-root", "sib", /inside the inline table mcp_servers = \{ \.\.\. \}/, false],
  ];
  for (const [id, name, shape, removable] of shapes) {
    it(`${id}: refuses to rewrite it, and names the shape`, () => {
      const input = fixture(id, "input.toml");
      expect(() => upsertTomlEntry(input, CONTAINER, name, BROKER)).toThrow(TomlSpliceRefusal);
      expect(() => upsertTomlEntry(input, CONTAINER, name, BROKER)).toThrow(shape);
      // The read says the same thing, so install learns it before it writes.
      const read = readTomlConfig(input, CONTAINER, [name]);
      expect(read.kind).toBe("unspliceable");
      if (read.kind !== "unspliceable") return;
      expect(read.key).toBe(name);
      expect(read.shape).toMatch(shape);
      expect(read.removable).toBe(removable);
      // Every refusal names an action. "Refuse" without a remedy is the
      // failure mode this assertion exists to stop.
      expect(read.remedy).toMatch(/by hand|re-run/);
    });
  }

  it("refuses to REMOVE only the spellings with no table span to take", () => {
    for (const [id, name] of [
      ["f09-inline", ENTRY],
      ["f16-dotted", ENTRY],
      ["g14-dotted-in-container", ENTRY],
      ["g09-inline-root", "sib"],
    ] as const) {
      expect(() => removeTomlEntry(fixture(id, "input.toml"), CONTAINER, name)).toThrow(TomlSpliceRefusal);
    }
  });

  it("g10: an array-of-tables entry is refused for a rewrite but IS removed", () => {
    // Deleting it is whole lines, and taking them is exactly what uninstall
    // was asked to do; rewriting it in place is what could drop a second
    // element the user wrote.
    const input = fixture("g10-array-entry", "input.toml");
    expect(removeTomlEntry(input, CONTAINER, ENTRY)).toBe(lf("[tui]", 'theme = "dark"'));
  });

  it("refuses to ADD an entry to a root inline container (g09)", () => {
    // `mcp_servers = { ... }` cannot gain `[mcp_servers.mcp]`: TOML forbids
    // extending an inline table, and both smol-toml and Codex reject the
    // result as a redefinition. So the refusal is the only safe answer.
    const input = fixture("g09-inline-root", "input.toml");
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, BROKER)).toThrow(
      /an inline table, which cannot gain an entry/,
    );
    expect(() => parseTomlConfig(`${input}\n[mcp_servers.mcp]\ncommand = "npx"\n`)).toThrow(TomlConfigError);
  });

  it("refuses a container that is not a table (f11)", () => {
    expect(() => upsertTomlEntry(fixture("f11-array-container", "input.toml"), CONTAINER, ENTRY, BROKER)).toThrow(
      /"mcp_servers" is an array of 1, not a TOML table -- make it a table \(or remove the key\), then re-run/,
    );
  });

  it("refuses to splice a malformed file at all (f10)", () => {
    const input = fixture("f10-malformed", "input.toml");
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, BROKER)).toThrow(TomlConfigError);
    expect(() => removeTomlEntry(input, CONTAINER, ENTRY)).toThrow(TomlConfigError);
  });

  it("refuses a --repair that would drop a tools table off our own entry, and writes nothing", () => {
    // The decision above FIELD_ORDER, end to end. --repair re-renders our
    // entry from the fields read off disk, so a `[mcp_servers.mcp.tools.*]`
    // the user hand-wrote is a field the re-render cannot spell. The refusal
    // names it; the file is untouched, so the table survives.
    const input = lf(
      "[mcp_servers.mcp]",
      'command = "old"',
      "",
      "[mcp_servers.mcp.tools.echo]",
      'approval_mode = "auto"',
    );
    const carried = tomlEntryFields(readTomlConfig(input, CONTAINER), ENTRY);
    expect(carried).toEqual({ command: "old", tools: { echo: { approval_mode: "auto" } } });
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, { ...carried, ...BROKER })).toThrow(TomlRenderError);
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, { ...carried, ...BROKER })).toThrow(
      /would drop your "tools" table/,
    );
    // --force is the other half of the decision and is NOT a silent drop: the
    // caller passing BROKER alone has asked for the entry to be replaced, and
    // replacing it takes its sub-tables with it (g08 pins the bytes).
    expect(upsertTomlEntry(input, CONTAINER, ENTRY, BROKER)).not.toContain("tools");
  });

  it("refuses a legacy entry in an unspliceable spelling rather than half-migrating", () => {
    const input = lf("[mcp_servers]", 'yaw-mcp = { command = "npx" }');
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, BROKER, { replaceLegacy: ["yaw-mcp"] })).toThrow(
      /the "yaw-mcp" entry is an inline table/,
    );
  });
});

describe("canon and post-write verification", () => {
  it("canon ignores key order and table order, and tags values JSON cannot hold", () => {
    const a = lf("[mcp_servers.mcp]", 'command = "npx"', "startup_timeout_sec = 60.0");
    const b = lf("[mcp_servers.mcp]", "startup_timeout_sec = 60", 'command = "npx"');
    expect(canonTomlConfig(a, CONTAINER)).toBe(canonTomlConfig(b, CONTAINER));
    expect(canonTomlConfig(lf("big = 1152921504606846976"), CONTAINER)).toBe(
      '{"big":{"$bigint":"1152921504606846976"}}',
    );
    expect(canonTomlConfig(lf("d = 1979-05-27"), CONTAINER)).toBe('{"d":{"$date":"1979-05-27"}}');
    // A date and the string that looks like it must not canonicalise the same,
    // or the comparison would pass on a change it should catch.
    expect(canonTomlConfig(lf('d = "1979-05-27"'), CONTAINER)).not.toBe(
      canonTomlConfig(lf("d = 1979-05-27"), CONTAINER),
    );
  });

  it("canon drops the named entries and treats an emptied container as absent", () => {
    const before = fixture("f03-siblings", "input.toml");
    const after = fixture("f03-siblings", "expected.toml");
    expect(canonTomlConfig(after, CONTAINER, [ENTRY])).toBe(canonTomlConfig(before, CONTAINER, [ENTRY]));
    expect(canonTomlConfig(fixture("f01-missing", "expected.toml"), CONTAINER, [ENTRY])).toBe("{}");
  });

  it("catches an edit that ate a neighbour", () => {
    const before = fixture("f03-siblings", "input.toml");
    // A hand-made "after" that is what a scanner one line long would produce:
    // the sibling's last env line taken with our block.
    const damaged = before.replace('A = "1"\n', "") + lf("", "[mcp_servers.mcp]", 'command = "npx"');
    expect(() =>
      verifyTomlSplice(before, damaged, CONTAINER, { upsert: { name: ENTRY, entry: { command: "npx" } } }),
    ).toThrow(/changed settings outside the entry/);
  });

  it("catches an edit that reordered the other entries", () => {
    const before = lf("[mcp_servers.a]", 'command = "1"', "", "[mcp_servers.b]", 'command = "2"');
    const reordered = lf("[mcp_servers.b]", 'command = "2"', "", "[mcp_servers.a]", 'command = "1"');
    expect(() => verifyTomlSplice(before, reordered, CONTAINER)).toThrow(/reordered/);
  });

  it("catches an edit that no longer parses", () => {
    const before = fixture("f02-trust-only", "input.toml");
    expect(() => verifyTomlSplice(before, `${before}[mcp_servers.mcp]\ncommand = "npx\n`, CONTAINER)).toThrow(
      /does not parse as TOML/,
    );
  });

  it("catches an entry that did not read back as the value written", () => {
    const before = "";
    const after = lf("[mcp_servers.mcp]", 'command = "node"');
    expect(() =>
      verifyTomlSplice(before, after, CONTAINER, { upsert: { name: ENTRY, entry: { command: "npx" } } }),
    ).toThrow(/did not read back as the value written/);
    expect(() =>
      verifyTomlSplice(before, "", CONTAINER, { upsert: { name: ENTRY, entry: { command: "npx" } } }),
    ).toThrow(/did not leave a "mcp" table behind/);
  });

  it("catches a removal that did not remove", () => {
    const raw = fixture("f01-missing", "expected.toml");
    expect(() => verifyTomlSplice(raw, raw, CONTAINER, { removed: [ENTRY] })).toThrow(/did not remove/);
  });

  it("accepts the real splices", () => {
    const before = fixture("f03-siblings", "input.toml");
    const after = fixture("f03-siblings", "expected.toml");
    expect(() => verifyTomlSplice(before, after, CONTAINER, { upsert: { name: ENTRY, entry: BROKER } })).not.toThrow();
    expect(() => verifyTomlSplice(after, before, CONTAINER, { removed: [ENTRY] })).not.toThrow();
  });

  it("is unskippable: every exported write verifies its own output", () => {
    // There is no exported way to obtain spliced text that has not been
    // checked, which is what makes a hand-rolled splicer safe to ship: a
    // scanner bug becomes a throw, never a corrupted config.
    expect(TomlVerifyError.prototype).toBeInstanceOf(Error);
    expect(() => upsertTomlEntry(fixture("f03-siblings", "input.toml"), CONTAINER, ENTRY, BROKER)).not.toThrow();
  });

  // Each of the three CALL SITES, pinned. "verifyTomlSplice is correct" and
  // "upsertTomlEntry calls it" are different claims: every assertion above
  // this point tests the function, and deleting the call from the writer left
  // all of them green. The lever below is the one refusal reachable through
  // the public API -- clause 4, the entry not reading back as the value
  // written.
  //
  // An integer outside the JS safe range does not survive its own round trip:
  // the renderer spells 2^53+2 as `9007199254740994`, valid TOML that Codex
  // loads, and smol-toml hands it back as a BIGINT (`asNeeded` will not narrow
  // it to a number). Written, the entry would mean a subtly different thing
  // than the one asked for; the check is what turns that into nothing written.
  const UNSAFE = 9007199254740994; // 2^53 + 2, exactly representable, prints exact

  it("upsert on an EXISTING file refuses when the entry would not read back as written", () => {
    const input = fixture("f03-siblings", "input.toml");
    const entry = { ...BROKER, request_id: UNSAFE };
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, entry)).toThrow(TomlVerifyError);
    expect(() => upsertTomlEntry(input, CONTAINER, ENTRY, entry)).toThrow(/did not read back as the value written/);
  });

  it("upsert on a MISSING or empty file refuses the same, on its own call site", () => {
    const entry = { ...BROKER, request_id: UNSAFE };
    expect(() => upsertTomlEntry(null, CONTAINER, ENTRY, entry)).toThrow(TomlVerifyError);
    expect(() => upsertTomlEntry("", CONTAINER, ENTRY, entry)).toThrow(TomlVerifyError);
    expect(() => upsertTomlEntry("  \n", CONTAINER, ENTRY, entry)).toThrow(/did not read back as the value written/);
  });

  it("the refused text is what the writer would otherwise have produced", () => {
    // Not a hypothesis about the rejection: the block renders, it is valid
    // TOML, it parses -- and the value that comes back is a different JS type
    // than the one handed in. Both halves measured against smol-toml 1.8.0.
    const rendered = renderTomlEntry(CONTAINER, ENTRY, { command: "npx", request_id: UNSAFE });
    expect(rendered).toContain("request_id = 9007199254740994");
    const back = tomlEntryFields(readTomlConfig(rendered, CONTAINER), ENTRY);
    expect(typeof back?.request_id).toBe("bigint");
    expect(typeof UNSAFE).toBe("number");
    // ...and the same value INSIDE the safe range round-trips, so the refusal
    // is about the boundary and not about the field.
    expect(() =>
      upsertTomlEntry(fixture("f03-siblings", "input.toml"), CONTAINER, ENTRY, {
        ...BROKER,
        request_id: 9007199254740991,
      }),
    ).not.toThrow();
  });

  // NOT pinned, and said out loud rather than left as a gap someone else finds:
  // `removeTomlEntry`'s own `verifyTomlSplice` call has no test that goes red
  // when it is deleted. A delete takes whole lines of tables the scanner
  // already found, and no input this package can construct makes that come out
  // wrong -- so there is nothing for the check to catch and nothing to assert.
  // It stays because the cost is one parse and the thing it guards against is
  // a future scanner change, not a present bug.
});

describe("the vendor claims this file's comments make", () => {
  // A comment asserting something about code it is not looking at is an
  // untested assertion, and this adapter's header makes two of them about
  // libraries it does not control. Prose parity drifts silently; an assertion
  // fails the day it stops being true.

  it("smol-toml DOES export a serializer -- the argument against it is that it re-renders", async () => {
    // The header used to say "smol-toml has no serializer at all", which is
    // false and would send the next reader looking for the wrong thing. It has
    // one; it is unusable HERE because it renders from the parsed value, so
    // formatting and comments are not its to keep. Measured on 1.8.0:
    const smol = await import("smol-toml");
    expect(typeof smol.stringify).toBe("function");
    expect(smol.stringify(smol.parse("a = 1.0"))).toBe("a = 1\n");
    expect(smol.stringify(smol.parse(lf("# lead", "a = 1 # trailing")))).toBe("a = 1\n");
    expect(smol.stringify(smol.parse(lf("a = 'literal'")))).toBe('a = "literal"\n');
  });

  it("the post-write check compares MEANING, so byte preservation is the splice's claim and not its", () => {
    // The header used to credit the check with byte preservation. It compares
    // the canonical JSON of the two PARSED documents, which is blind to
    // everything that is not meaning -- here an `after` with both comments
    // deleted, a 'literal' respelled "basic" and `20` respelled `20.0` passes
    // it. What keeps those bytes is that the splice never touches their spans;
    // the byte-exact fixtures above are what pin THAT.
    const before = lf(
      "# lead",
      "[mcp_servers.sib]",
      "command = 'node'   # inline",
      "startup_timeout_sec = 20",
      "",
      "[mcp_servers.mcp]",
      'command = "npx"',
    );
    const after = lf(
      "[mcp_servers.sib]",
      'command = "node"',
      "startup_timeout_sec = 20.0",
      "",
      "[mcp_servers.mcp]",
      'command = "npx"',
    );
    expect(after).not.toBe(before);
    expect(() =>
      verifyTomlSplice(before, after, CONTAINER, { upsert: { name: ENTRY, entry: { command: "npx" } } }),
    ).not.toThrow();
    expect(canonTomlConfig(before, CONTAINER)).toBe(canonTomlConfig(after, CONTAINER));
  });
});

describe("codex agreement table", () => {
  // Recorded constants, not a live codex run: each shape's verdict from
  // codex-cli 0.144.0 -- measured in the design pass (codex-cli.md 2.4 / F8 /
  // F9) and re-measured for the last five rows while this adapter was written
  // (`codex mcp list --json` / `codex mcp get --json` under a scratch
  // CODEX_HOME) -- against this codec's verdict today. When a future
  // smol-toml disagrees with a row, this test names the row rather than
  // leaving a silent behaviour change in install and doctor.
  //
  // `codexLoads: true` with a non-"ok" kind is not a contradiction and is the
  // distinction worth keeping straight: `unspliceable` says THIS WRITER will
  // not rewrite the file, not that Codex cannot read it. Measured: Codex loads
  // the inline, root-dotted and container-dotted spellings quite happily.
  const rows: Array<{ shape: string; toml: string; codexLoads: boolean; kind: string }> = [
    { shape: "explicit header", toml: lf("[mcp_servers.mcp]", 'command = "npx"'), codexLoads: true, kind: "ok" },
    { shape: "quoted header", toml: lf('[mcp_servers."mcp"]', 'command = "npx"'), codexLoads: true, kind: "ok" },
    {
      shape: "whitespace header",
      toml: lf('[ mcp_servers . "mcp" ]', 'command = "npx"'),
      codexLoads: true,
      kind: "ok",
    },
    { shape: "leading BOM", toml: `${BOM}${lf("[mcp_servers.mcp]", 'command = "npx"')}`, codexLoads: true, kind: "ok" },
    { shape: "CRLF", toml: '[mcp_servers.mcp]\r\ncommand = "npx"\r\n', codexLoads: true, kind: "ok" },
    {
      shape: "sub-table before its parent",
      toml: lf("[mcp_servers.mcp.env]", 'A = "1"', "[mcp_servers.mcp]", 'command = "npx"'),
      codexLoads: true,
      kind: "ok",
    },
    { shape: "big integer elsewhere", toml: lf("big = 1152921504606846976"), codexLoads: true, kind: "ok" },
    {
      shape: "inline entry",
      toml: lf("[mcp_servers]", 'mcp = { command = "npx" }'),
      codexLoads: true,
      kind: "unspliceable",
    },
    { shape: "root dotted keys", toml: lf('mcp_servers.mcp.command = "npx"'), codexLoads: true, kind: "unspliceable" },
    {
      shape: "dotted keys under the container",
      toml: lf("[mcp_servers]", 'mcp.command = "npx"'),
      codexLoads: true,
      kind: "unspliceable",
    },
    {
      shape: "inline root container",
      toml: lf('mcp_servers = { sib = { command = "node" } }'),
      codexLoads: true,
      kind: "ok",
    },
    {
      shape: "array-of-tables entry",
      toml: lf("[[mcp_servers.mcp]]", 'command = "npx"'),
      codexLoads: false,
      kind: "unspliceable",
    },
    {
      shape: "unterminated string",
      toml: lf("[mcp_servers.mcp]", 'command = "npx'),
      codexLoads: false,
      kind: "malformed",
    },
    {
      shape: "duplicate header",
      toml: lf("[mcp_servers.mcp]", 'command = "a"', "[mcp_servers.mcp]", 'command = "b"'),
      codexLoads: false,
      kind: "malformed",
    },
    {
      shape: "inline env plus an env sub-table",
      toml: lf("[mcp_servers.mcp]", 'env = { A = "1" }', "[mcp_servers.mcp.env]", 'B = "2"'),
      codexLoads: false,
      kind: "malformed",
    },
    {
      shape: "array of tables container",
      toml: lf("[[mcp_servers]]", 'command = "npx"'),
      codexLoads: false,
      kind: "blocked",
    },
    { shape: "scalar container", toml: lf('mcp_servers = "none"'), codexLoads: false, kind: "blocked" },
  ];

  for (const row of rows) {
    it(`${row.shape}: codec says ${row.kind} (codex 0.144.0 ${row.codexLoads ? "loads" : "refuses"} it)`, () => {
      expect(readTomlConfig(row.toml, CONTAINER, [ENTRY]).kind).toBe(row.kind);
    });
  }

  it("the two rows where a valid-TOML file is still one Codex refuses are typed, not parsed, problems", () => {
    // `[[mcp_servers]]` and `mcp_servers = "none"` are VALID TOML: smol-toml
    // parses both. Codex refuses to load either ("invalid type: sequence,
    // expected a map" / "invalid type: string"), so the codec has to report
    // them itself -- which is the `blocked` kind above, not `malformed`.
    expect(() => parseTomlConfig(lf("[[mcp_servers]]", 'command = "npx"'))).not.toThrow();
    expect(() => parseTomlConfig(lf('mcp_servers = "none"'))).not.toThrow();
  });
});
