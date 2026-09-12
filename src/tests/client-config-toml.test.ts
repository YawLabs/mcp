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
//   g01-g17  were added by this package for the splice shapes f01-f16 does not
//            reach (a header inside a multi-line string, first/middle/last
//            position, detached sub-tables, a BOM on the table's own line, the
//            refused spellings). Their `expected*.toml` were produced by
//            running this adapter and then read back with a codex-cli 0.144.0
//            (same read-only probe), so they pin behaviour that was reviewed
//            and loaded rather than behaviour that was merely round-tripped.

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

const lf = (...lines: string[]): string => `${lines.join("\n")}\n`;

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
