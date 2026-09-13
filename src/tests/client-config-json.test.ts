// The JSON-family adapter, exercised through the PUBLIC contract: classify,
// then applyClientConfigEdits, then the bytes.
//
// This module is imported FIRST on purpose. client-config.ts and
// client-config-json.ts import each other (the model owns the shared helpers;
// the registry reaches the adapters), so a top-level read of an adapter
// binding in the model would throw a TDZ ReferenceError in exactly this import
// order. The first `adapterFor` call below is what proves it does not.

import { describe, expect, it } from "vitest";
import {
  adapterFor,
  applyClientConfigEdits,
  type ClientConfigEdit,
  ClientConfigWriteError,
  type ConfigFormat,
  type ConfigSite,
  classifyClientConfig,
  type EntryTransform,
  type StrictViolation,
  terminateWithNewline,
  unloadableConfigFix,
  unloadableConfigProblem,
} from "../client-config.js";
import { buildFreshConfig, JSON_ADAPTER, JSONC_ADAPTER, UTF8_BOM } from "../client-config-json.js";
import { deepEqualJson } from "../install-cmd.js";
// findBlockedContainerSegment lives in install-targets.ts, which is where
// doctor reads it from too; install-cmd.ts only imports it.
import { findBlockedContainerSegment } from "../install-targets.js";

// TAB is built from its code point, never typed as an escape: a backslash-t
// that loses a level on its way into this file becomes a REAL tab inside a
// string literal, which is valid TypeScript, passes the linter and the
// type-check, and silently changes what these byte-exact expectations mean.
// A mangled backslash-n or backslash-r cannot hide the same way -- it ends the
// literal and the file stops parsing -- so those stay readable escapes.
const TAB = String.fromCharCode(9);

const ENTRY: Record<string, unknown> = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

/** The 137-byte document a fresh install renders. */
const FRESH =
  '{\n  "mcpServers": {\n    "mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
  '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n';

const site = (containerPath: string[], format: ConfigFormat = "jsonc"): ConfigSite => ({
  id: "default",
  label: "Test Client",
  format,
  // A literal, not path.join: nothing in this file touches the filesystem, so
  // the string is only ever compared and interpolated into a message.
  resolved: { absolute: "/home/u/cfg.json", display: "~/cfg.json", containerPath },
  detectDir: null,
});

const FLAT = site(["mcpServers"]);
const STRICT = site(["mcpServers"], "json");

/** Install (or re-install) `entry` under `key`, through the public path. */
function install(
  raw: string | null,
  where: ConfigSite = FLAT,
  key = "mcp",
  entry: Record<string, unknown> = ENTRY,
  extra: readonly ClientConfigEdit[] = [],
): string {
  const view = classifyClientConfig(raw, where);
  return applyClientConfigEdits(view, [{ op: "upsert", key, entry }, ...extra], where);
}

function uninstall(raw: string, where: ConfigSite = FLAT, key = "mcp"): string {
  const view = classifyClientConfig(raw, where);
  return applyClientConfigEdits(view, [{ op: "remove", key }], where);
}

/** The refusal `fn` throws, as the typed error -- so a test can compare the
 *  WHOLE message with toBe. `toThrow(/fragment/)` only proves the fragment is
 *  somewhere in it, which is how a dropped clause stays green. Anything that
 *  is not a ClientConfigWriteError, or no throw at all, fails the test. */
function refusalOf(fn: () => unknown): ClientConfigWriteError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClientConfigWriteError) return err;
    throw err;
  }
  throw new Error("expected a ClientConfigWriteError, and the call returned normally");
}

/** The message `JSON.parse` itself throws for `text` -- the client's own
 *  complaint, which a violation's `detail` is supposed to carry verbatim. */
function jsonParseMessageOf(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected JSON.parse to reject the text");
}

/** The violation on a view, or a failed test -- never a silent `?.` chain that
 *  turns a missing violation into an `undefined === undefined` pass. */
function violationOf(raw: string, where: ConfigSite): StrictViolation {
  const violation = classifyClientConfig(raw, where).unloadable();
  if (violation === null) throw new Error("expected the file to be strict-unloadable");
  return violation;
}

/** The upsert refusal for a strict-unloadable file, composed from the shared
 *  helpers -- the same composition every surface is meant to print. */
function unloadableRefusal(where: string, violation: StrictViolation): string {
  return `${where} ${unloadableConfigProblem(violation)} -- refusing to write into it; ${unloadableConfigFix("re-run")}`;
}

describe("a JSONC file keeps every neighbouring byte", () => {
  // CRLF, tab-indented, a header comment, and a one-line sibling carrying a
  // trailing comment -- the shape a hand-edited config actually has.
  const USER =
    `{\r\n${TAB}// my servers\r\n${TAB}"mcpServers": {\r\n${TAB}${TAB}"fs": ` +
    '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]} // keep' +
    `\r\n${TAB}}\r\n}\r\n`;
  const INSTALLED =
    `{\r\n${TAB}// my servers\r\n${TAB}"mcpServers": {\r\n${TAB}${TAB}"fs": ` +
    '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}, // keep' +
    `\r\n${TAB}${TAB}"mcp": {\r\n${TAB}${TAB}${TAB}"command": "npx",\r\n${TAB}${TAB}${TAB}"args": [\r\n` +
    `${TAB}${TAB}${TAB}${TAB}"-y",\r\n${TAB}${TAB}${TAB}${TAB}"@yawlabs/mcp@latest"\r\n${TAB}${TAB}${TAB}]\r\n` +
    `${TAB}${TAB}}\r\n${TAB}}\r\n}\r\n`;

  it("splices the entry in, byte for byte, keeping the sibling's comment", () => {
    expect(install(USER)).toBe(INSTALLED);
  });

  it("changes the sibling's line by exactly one comma", () => {
    // The separator JSON needs, placed straight after the sibling's value and
    // AHEAD of its comment -- the one byte that line is allowed to gain.
    const lineOf = (text: string) => text.split("\r\n").find((l) => l.includes('"fs"')) ?? "";
    const before = lineOf(USER);
    const after = lineOf(INSTALLED);
    expect(after).not.toBe(before);
    expect(after.replace("}, // keep", "} // keep")).toBe(before);
  });

  it("re-installs as a byte-identical no-op", () => {
    expect(install(INSTALLED)).toBe(INSTALLED);
  });

  it("uninstalls back to the original bytes", () => {
    expect(uninstall(INSTALLED)).toBe(USER);
  });

  it("keeps tab indentation when the file uses tabs", () => {
    const raw = `{\n${TAB}"mcpServers": {\n${TAB}${TAB}"fs": {"command": "npx"}\n${TAB}}\n}\n`;
    const out = install(raw);
    expect(out).toContain(`\n${TAB}${TAB}"mcp": {\n${TAB}${TAB}${TAB}"command": "npx",`);
    expect(out).not.toContain('  "mcp"');
  });

  it("keeps a four-space indent step", () => {
    const raw = '{\n    "mcpServers": {\n        "fs": {"command": "npx"}\n    }\n}\n';
    const out = install(raw);
    expect(out).toContain('\n        "mcp": {\n            "command": "npx",');
  });

  it("keeps CRLF on a two-space file", () => {
    const raw = '{\r\n  "mcpServers": {\r\n    "fs": {"command": "npx"}\r\n  }\r\n}\r\n';
    const out = install(raw);
    expect(out.includes("\r\n")).toBe(true);
    // Every line break is a CRLF: no lone LF was introduced by the splice.
    expect(out.split("\n").length - 1).toBe(out.split("\r\n").length - 1);
  });

  it("leaves a file with no final newline unterminated, and terminates it on request", () => {
    const raw = '{\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}';
    const out = install(raw);
    expect(out.endsWith("\n")).toBe(false);
    expect(terminateWithNewline(out)).toBe(`${out}\n`);
    // Idempotent: a file that already ends in one keeps exactly the one it had.
    expect(terminateWithNewline(FRESH)).toBe(FRESH);
  });

  it("opens an empty container onto lines of its own", () => {
    const raw = '{\n  "mcpServers": {}\n}\n';
    expect(install(raw)).toBe(
      '{\n  "mcpServers": {\n    "mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
        '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n',
    );
  });

  it("reports an empty container as present with no entries", () => {
    const view = classifyClientConfig('{\n  "mcpServers": {}\n}\n', FLAT);
    expect(view.read.kind === "ok" && view.read.containerPresent).toBe(true);
    expect(view.count()).toBe(0);
    expect(view.entry()).toBeUndefined();
    expect(view.otherServerKeys()).toEqual([]);
  });

  it("creates a container that is not there yet, keeping the other keys", () => {
    const raw = '{\n  "theme": "dark"\n}\n';
    const view = classifyClientConfig(raw, FLAT);
    expect(view.read.kind === "ok" && view.read.containerPresent).toBe(false);
    expect(view.count()).toBe(0);
    const out = applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT);
    expect(out).toContain('"theme": "dark"');
    expect(classifyClientConfig(out, FLAT).entry()?.launch).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
    });
  });

  it("splices a one-line document without expanding it", () => {
    expect(install("{}\n")).toBe('{"mcpServers":{"mcp":{"command":"npx","args":["-y","@yawlabs/mcp@latest"]}}}\n');
  });

  it("renders a fresh document when there is no file", () => {
    expect(install(null)).toBe(FRESH);
  });

  it("nests a fresh document exactly as the merge it replaced did", () => {
    // These two objects, and the FRESH bytes above, are what
    // `mergeClientConfig({}, containerPath, entry)` produced in install-cmd.ts
    // before every consumer moved onto this adapter. That function is gone, so
    // the pin is the SHAPE itself rather than a comparison against a second
    // implementation of it -- having two was the thing being fixed.
    expect(buildFreshConfig(["mcpServers"], "mcp", ENTRY)).toEqual({ mcpServers: { mcp: ENTRY } });
    expect(buildFreshConfig(["projects", "C:/r", "mcpServers"], "mcp", ENTRY)).toEqual({
      projects: { "C:/r": { mcpServers: { mcp: ENTRY } } },
    });
    expect(`${JSON.stringify(buildFreshConfig(["mcpServers"], "mcp", ENTRY), null, 2)}\n`).toBe(FRESH);
  });
});

describe("a nested container", () => {
  const NESTED = site(["projects", "C:/repo", "mcpServers"]);

  it("is created, read and removed at its own path", () => {
    const raw = '{\n  "projects": {\n    "C:/other": {\n      "mcpServers": {}\n    }\n  }\n}\n';
    const installed = install(raw, NESTED);
    const view = classifyClientConfig(installed, NESTED);
    expect(view.entry()?.launch).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    // The other project is untouched, and its container is not counted here.
    expect(installed).toContain('"C:/other"');
    expect(view.count()).toBe(1);
    expect(uninstall(installed, NESTED)).toContain('"C:/other"');
  });

  it("names itself in a message the way install already spells it", () => {
    // Byte-identical to describeContainer(file, containerPath) in
    // install-cmd.ts, which is not exported -- so the wording is pinned here
    // and the consumer's copy is deleted when it adopts this adapter.
    const addr = { format: "jsonc" as const, containerPath: NESTED.resolved.containerPath };
    expect(JSONC_ADAPTER.describeLocation("/home/u/.claude.json", addr)).toBe(
      '/home/u/.claude.json under projects["C:/repo"].mcpServers',
    );
    expect(JSONC_ADAPTER.describeLocation("/home/u/cfg.json", { format: "jsonc", containerPath: ["mcpServers"] })).toBe(
      "/home/u/cfg.json",
    );
  });
});

describe("strict JSON refuses what its client cannot read", () => {
  const WITH_COMMENT = '{\n  // mine\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}\n';
  const WITH_TRAILING_COMMA = '{\n  "mcpServers": {\n    "fs": {"command": "npx"},\n  }\n}\n';

  it("classifies a commented file as unloadable, and still reads its entries", () => {
    const view = classifyClientConfig(WITH_COMMENT, STRICT);
    expect(view.read.kind).toBe("ok");
    const violation = view.unloadable();
    expect(violation).not.toBeNull();
    expect(violation?.syntax).toBe("JSON");
    // The position is against the ORIGINAL bytes and points at the comment.
    expect(violation?.position?.line).toBe(2);
    expect(WITH_COMMENT.slice(violation?.position?.offset ?? 0, (violation?.position?.offset ?? 0) + 2)).toBe("//");
    // Reading still works, which is what lets doctor say WHICH server is dead.
    expect(view.otherServerKeys()).toEqual(["fs"]);
  });

  it("refuses to write into a commented file, and leaves the bytes alone", () => {
    const view = classifyClientConfig(WITH_COMMENT, STRICT);
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], STRICT)).toThrow(
      /comments or trailing commas/,
    );
    // Nothing was written because nothing was returned: the caller never got
    // text to persist, and the input string is untouched.
    expect(view.raw).toBe(WITH_COMMENT);
  });

  it("refuses to write into a file with a trailing comma", () => {
    const view = classifyClientConfig(WITH_TRAILING_COMMA, STRICT);
    expect(view.unloadable()).not.toBeNull();
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], STRICT)).toThrow(
      /refusing to write into it/,
    );
    expect(view.raw).toBe(WITH_TRAILING_COMMA);
  });

  it("still lets uninstall take our entry out of an unloadable file", () => {
    // Removing our entry from a file the client skips is correct; refusing it
    // would leave the user unable to uninstall.
    const raw = '{\n  // mine\n  "mcpServers": {\n    "mcp": {"command": "npx"}\n  }\n}\n';
    const view = classifyClientConfig(raw, STRICT);
    expect(view.unloadable()).not.toBeNull();
    const out = applyClientConfigEdits(view, [{ op: "remove", key: "mcp" }], STRICT);
    expect(out).toContain("// mine");
    expect(classifyClientConfig(out, STRICT).entry()).toBeUndefined();
  });

  it("accepts the same file when the target is JSONC", () => {
    const view = classifyClientConfig(WITH_COMMENT, FLAT);
    expect(view.unloadable()).toBeNull();
    expect(install(WITH_COMMENT)).toContain("// mine");
  });

  it("accepts a lone BOM, which the clients themselves accept", () => {
    const view = classifyClientConfig(`${UTF8_BOM}{"mcpServers":{}}`, STRICT);
    expect(view.read.kind).toBe("ok");
    expect(view.unloadable()).toBeNull();
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(UTF8_BOM.length).toBe(1);
  });

  it("reports a genuinely broken strict file as malformed, not as unloadable", () => {
    const read = classifyClientConfig('{\n  "mcpServers": {\n', STRICT).read;
    expect(read.kind).toBe("malformed");
    if (read.kind === "malformed") expect(read.reason).toBe("syntax");
  });

  it("refuses with the WHOLE message: the path, the problem, the client's own complaint and the remedy", () => {
    // Every other refusal assertion in this file matches a fragment
    // (/refusing to write into it/, /comments or trailing commas/), so deleting
    // the remedy clause -- the part that tells the user what to DO -- leaves
    // them all green. `try` surfaces this error verbatim, so the clause is
    // user-facing and has to be pinned whole.
    //
    // MUTATION: drop `; ${unloadableConfigFix("re-run")}` from the throw in
    // applyClientConfigEdits (client-config.ts), and this goes red.
    for (const [label, raw] of [
      ["comment", WITH_COMMENT],
      ["trailing comma", WITH_TRAILING_COMMA],
    ] as const) {
      const view = classifyClientConfig(raw, STRICT);
      const violation = violationOf(raw, STRICT);
      // The middle of the message is the CLIENT's parser speaking: its syntax
      // and JSON.parse's own words, not a paraphrase. No BOM here, so the text
      // JSON.parse sees is the file.
      expect(violation.detail, label).toBe(jsonParseMessageOf(raw));
      const problem = unloadableConfigProblem(violation);
      expect(problem, label).toContain(
        `which its client reads as invalid JSON (${violation.detail}), so no server in it is loading`,
      );
      expect(unloadableConfigFix("re-run").endsWith(", then re-run"), label).toBe(true);

      const err = refusalOf(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], STRICT));
      expect(err.message, label).toBe(
        `/home/u/cfg.json ${problem} -- refusing to write into it; ${unloadableConfigFix("re-run")}`,
      );
      expect(view.raw, label).toBe(raw);
    }
  });

  it("refuses a MIXED edit list in either order: one write in it is enough", () => {
    // The gate asks whether ANY edit writes. Every other case here hands it a
    // single upsert or a pure removal, where "any edit writes" and "every edit
    // writes" -- or "the first edit writes" -- all give the same answer. A
    // legacy migration is the real mixed list: upsert ours, drop the old key.
    //
    // MUTATIONS: `edits.some(...)` -> `edits.every(...)` in
    // applyClientConfigEdits turns both orders red; a gate on `edits[0]` only
    // turns the removal-first order red.
    const raw = '{\n  // mine\n  "mcpServers": {\n    "yaw-mcp": {"command": "npx"}\n  }\n}\n';
    const view = classifyClientConfig(raw, STRICT);
    expect(view.legacyKey()).toBe("yaw-mcp");
    const expected = unloadableRefusal("/home/u/cfg.json", violationOf(raw, STRICT));
    const upsert: ClientConfigEdit = { op: "upsert", key: "mcp", entry: ENTRY };
    const remove: ClientConfigEdit = { op: "remove", key: "yaw-mcp" };
    for (const edits of [
      [upsert, remove],
      [remove, upsert],
    ]) {
      const order = edits.map((e) => e.op).join(",");
      expect(refusalOf(() => applyClientConfigEdits(view, edits, STRICT)).message, order).toBe(expected);
    }
    expect(view.raw).toBe(raw);
    // The control: the removal ALONE goes through on the same view, so the
    // refusals above are the upsert's doing, not something about the file.
    const removed = applyClientConfigEdits(view, [remove], STRICT);
    expect(classifyClientConfig(removed, STRICT).legacyKey()).toBeNull();
    expect(removed).toContain("// mine");
  });

  it("locates a comment behind a BOM in the ORIGINAL bytes, one past where JSON.parse counts", () => {
    // Hand-computed against the file as it sits on disk:
    //   [0] U+FEFF  [1] {  [2] LF  [3] [4] spaces  [5] the first slash
    // Line 2 starts at [3], so the slash is line 2 column 3.
    // JSON.parse is handed the text AFTER the BOM, so its own offset is one
    // less (4); the reported position has to add the stripped BOM back.
    //
    // MUTATION: pass `0` instead of `had ? 1 : 0` to strictPosition in
    // readStrictJson (client-config-json.ts) -- the offset comes back 4,
    // which points at a space, and this goes red.
    const raw = `${UTF8_BOM}{\n  // mine\n  "mcpServers": {}\n}\n`;
    expect(raw.slice(5, 7)).toBe("//");
    const view = classifyClientConfig(raw, STRICT);
    // Still readable by us -- a BOM is not the problem, the comment is.
    expect(view.read.kind).toBe("ok");
    const violation = violationOf(raw, STRICT);
    expect(violation.position).toEqual({ offset: 5, line: 2, column: 3 });
    // The reference the shift corrects: V8's own count, against the de-BOM'd
    // text (measured on Node 22.22.2).
    expect(violation.detail).toBe(jsonParseMessageOf(raw.slice(1)));
    expect(violation.detail).toMatch(/at position 4\b/);
    // And the refusal still carries the whole remedy on a BOM-prefixed file.
    expect(refusalOf(() => install(raw, STRICT)).message).toBe(unloadableRefusal("/home/u/cfg.json", violation));
  });

  it("locates a syntax error behind a BOM in the ORIGINAL bytes when BOTH parsers refuse", () => {
    // A missing comma between two members: JSON.parse and the lenient parse
    // both reject it, so the read is plain `malformed`, positioned by
    // jsonc-parser's scanner. Hand-computed against the file:
    //   [0] U+FEFF, [1] {, [2] LF                       -- line 1
    //   [3..19] `  "mcpServers": {`, [20] LF            -- line 2
    //   line 3 starts at [21]; in `    "fs": {"command": "npx"} "x": 1`
    //   the `"x"` token is at index 29, so offset 50, column 30.
    //
    // MUTATION: pass `0` instead of `shift` to jsoncPosition in classifyJson
    // (client-config-json.ts) -- the offset comes back 49 and the column 29.
    const raw = `${UTF8_BOM}{\n  "mcpServers": {\n    "fs": {"command": "npx"} "x": 1\n  }\n}\n`;
    expect(raw.slice(50, 53)).toBe('"x"');
    expect(raw.lastIndexOf("\n", 49)).toBe(20);
    for (const where of [STRICT, FLAT]) {
      const view = classifyClientConfig(raw, where);
      const read = view.read;
      expect(read.kind, where.format).toBe("malformed");
      if (read.kind !== "malformed") continue;
      expect(read.reason, where.format).toBe("syntax");
      expect(view.unloadable(), where.format).toBeNull();
      expect(read.position, where.format).toEqual({ offset: 50, line: 3, column: 30 });
      // The same position, rendered the way the refusal prints it.
      expect(refusalOf(() => install(raw, where)).message, where.format).toBe(
        `/home/u/cfg.json is not valid JSON at line 3 column 30 (${read.detail})`,
      );
    }
  });

  // KNOWN DEFECT, pinned with it.fails so the suite stays green until it is
  // fixed -- flip both of these to `it` in the same change as the fix.
  //
  // On LINE 1 of a BOM-prefixed file the COLUMN counts the BOM. positionAt
  // derives the column from an offset that (correctly, per ConfigPosition's
  // doc) includes the BOM, and line 1 is the only line whose start is BEFORE
  // the BOM. ConfigPosition promises "the spelling every editor uses", no
  // editor shows a BOM as a column, and V8's own message disagrees with the
  // position in the SAME refusal line. Measured on Node 22.22.2:
  //   BOM + `{// c ...`   -> position {offset 2, line 1, column 3}; V8 says column 2
  //   BOM + `{"a" "b"}`   -> position {offset 6, line 1, column 7}; V8 says column 6
  // Lines 2+ are unaffected (the two tests above).
  it.fails("KNOWN DEFECT: reports an editor column for a comment on line 1 of a BOM-prefixed file", () => {
    // [0] U+FEFF  [1] {  [2] the first slash -- the 2nd character an editor
    // shows on line 1, so column 2. The offset keeps counting the BOM.
    const raw = `${UTF8_BOM}{// c\n"mcpServers":{}}\n`;
    expect(raw.slice(2, 4)).toBe("//");
    expect(violationOf(raw, STRICT).position).toEqual({ offset: 2, line: 1, column: 2 });
  });

  it.fails("KNOWN DEFECT: renders an editor column for a syntax error on line 1 of a BOM-prefixed file", () => {
    // [0] U+FEFF  [1] {  [2..4] "a"  [5] space  [6] "b" -- the 6th character
    // an editor shows on line 1. Both parsers refuse (no colon), so this is
    // the malformed path and its rendered refusal.
    const raw = `${UTF8_BOM}{"a" "b"}\n`;
    expect(raw.slice(6, 9)).toBe('"b"');
    const read = classifyClientConfig(raw, STRICT).read;
    if (read.kind !== "malformed") throw new Error(`expected malformed, got ${read.kind}`);
    expect(refusalOf(() => install(raw, STRICT)).message).toBe(
      `/home/u/cfg.json is not valid JSON at line 1 column 6 (${read.detail})`,
    );
  });
});

describe("malformed and blocked files", () => {
  it("reports a reason and a position, and writes nothing", () => {
    const raw = '{\n  "mcpServers": {\n    "mcp": {\n      "command": "npx",\n';
    const view = classifyClientConfig(raw, FLAT);
    const read = view.read;
    expect(read.kind).toBe("malformed");
    if (read.kind !== "malformed") return;
    expect(read.reason).toBe("syntax");
    expect(read.syntax).toBe("JSON");
    expect(read.detail.length).toBeGreaterThan(0);
    // Measured against the original bytes: offset 57 is the end of the
    // truncated document, on line 5.
    expect(read.position).toEqual({ offset: 57, line: 5, column: 1 });
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /is not valid JSON at line 5 column 1/,
    );
  });

  it("locates the failure past a comment, where the parser's own message cannot", () => {
    // parseJsonc strips comments before JSON.parse, so the position inside its
    // message counts the stripped text. This one is against the file.
    const raw = '{\n  // a comment that shifts every offset after it\n  "mcpServers": {\n';
    const read = classifyClientConfig(raw, FLAT).read;
    expect(read.kind === "malformed" && read.position?.line).toBe(4);
  });

  it("reports a non-object root as a root problem, naming the shape", () => {
    const read = classifyClientConfig("[1, 2]\n", FLAT).read;
    expect(read.kind).toBe("malformed");
    if (read.kind !== "malformed") return;
    expect(read.reason).toBe("root");
    expect(read.detail).toBe("an array of 2");
  });

  it("treats an empty file as absent, not as malformed", () => {
    expect(classifyClientConfig("   \n", FLAT).read.kind).toBe("absent");
    expect(classifyClientConfig(null, FLAT).read.kind).toBe("absent");
  });

  it("reports a null container as blocked-but-reparable, and repairs it in one pass", () => {
    const raw = '{\n  "theme": "dark",\n  "mcpServers": null\n}\n';
    const view = classifyClientConfig(raw, FLAT);
    const read = view.read;
    expect(read.kind).toBe("blocked");
    if (read.kind !== "blocked") return;
    expect(read.path).toEqual(["mcpServers"]);
    expect(read.shape).toBe("null");
    expect(read.reparable).toBe(true);
    const out = applyClientConfigEdits(
      view,
      [
        { op: "repair", path: ["mcpServers"] },
        { op: "upsert", key: "mcp", entry: ENTRY },
      ],
      FLAT,
    );
    expect(out).toContain('"theme": "dark"');
    expect(classifyClientConfig(out, FLAT).entry()?.launch?.command).toBe("npx");
  });

  it("refuses a repair that is not the FIRST edit", () => {
    // Ordering is the whole point of the repair edit: splicing into a key that
    // still holds a non-object is exactly what it exists to prevent, so a
    // repair queued behind the upsert is refused rather than silently
    // reordered.
    const view = classifyClientConfig('{\n  "mcpServers": null\n}\n', FLAT);
    expect(() =>
      applyClientConfigEdits(
        view,
        [
          { op: "upsert", key: "mcp", entry: ENTRY },
          { op: "repair", path: ["mcpServers"] },
        ],
        FLAT,
      ),
    ).toThrow(/has to be the FIRST edit/);
  });

  it("carries the strict violation on a blocked read, so a repair into an unloadable file is refused", () => {
    // A file can be BOTH: its client cannot load it AND its container is the
    // wrong shape. Repairing it would print Done over a file nothing reads, so
    // the violation has to survive the blocked classification.
    const raw = '{\n  // mine\n  "mcpServers": null\n}\n';
    const view = classifyClientConfig(raw, STRICT);
    expect(view.read.kind).toBe("blocked");
    expect(view.unloadable()).not.toBeNull();
    expect(() =>
      applyClientConfigEdits(
        view,
        [
          { op: "repair", path: ["mcpServers"] },
          { op: "upsert", key: "mcp", entry: ENTRY },
        ],
        STRICT,
      ),
    ).toThrow(/refusing to write into it/);
    // The same file under a JSONC target repairs and installs normally: the
    // refusal is the client's parser, never the bytes.
    const lenient = classifyClientConfig(raw, FLAT);
    expect(lenient.unloadable()).toBeNull();
    const out = applyClientConfigEdits(
      lenient,
      [
        { op: "repair", path: ["mcpServers"] },
        { op: "upsert", key: "mcp", entry: ENTRY },
      ],
      FLAT,
    );
    expect(out).toContain("// mine");
    expect(classifyClientConfig(out, FLAT).entry()?.launch?.command).toBe("npx");
  });

  it("refuses an upsert into a blocked container with no repair edit", () => {
    const view = classifyClientConfig('{\n  "mcpServers": null\n}\n', FLAT);
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /has to be repaired/,
    );
  });

  it("refuses a container that is a non-empty array, which could hold real servers", () => {
    const raw = '{"mcpServers": [{"name": "mcp", "command": "npx"}]}\n';
    const view = classifyClientConfig(raw, FLAT);
    const read = view.read;
    expect(read.kind).toBe("blocked");
    if (read.kind !== "blocked") return;
    expect(read.reparable).toBe(false);
    expect(read.shape).toBe("an array of 1");
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /refusing to overwrite it/,
    );
  });

  it("agrees with install-cmd's own blocked-segment walk", () => {
    // The adapter has its own copy while the consumer still has one; pinned
    // against each other so they cannot drift apart unnoticed.
    for (const [label, doc] of [
      ["null", { mcpServers: null }],
      ["scalar", { mcpServers: 3 }],
      ["empty array", { mcpServers: [] }],
      ["full array", { mcpServers: [{ a: 1 }] }],
      ["fine", { mcpServers: { mcp: {} } }],
      ["deep", { projects: 5 }],
    ] as const) {
      const path = label === "deep" ? ["projects", "C:/r", "mcpServers"] : ["mcpServers"];
      const theirs = findBlockedContainerSegment(doc as Record<string, unknown>, path);
      const read = classifyClientConfig(JSON.stringify(doc), site(path)).read;
      if (theirs === null) {
        expect(read.kind, label).not.toBe("blocked");
      } else {
        expect(read.kind, label).toBe("blocked");
        if (read.kind !== "blocked") continue;
        expect(read.path, label).toEqual(theirs.path);
        expect(read.reparable, label).toBe(theirs.reparable);
      }
    }
  });
});

describe("reading the entry map", () => {
  const RAW =
    '{"mcpServers":{"fs":{"command":"npx"},"yaw-mcp":{"command":"npx"},"mcp":{"command":"npx","env":{"A":"1","B":2}},"broken":7}}';

  it("returns every entry in file order, with the launch view normalised", () => {
    const view = classifyClientConfig(RAW, FLAT);
    expect(view.entries().map((e) => e.key)).toEqual(["fs", "yaw-mcp", "mcp", "broken"]);
    expect(view.count()).toBe(4);
    // `broken` is a number: present as a KEY, with nothing to launch.
    expect(view.entry("broken")?.launch).toBeNull();
    expect(view.entry("broken")?.value).toBe(7);
    // A non-string env value is filtered per key, never all-or-nothing.
    expect(view.entry()?.launch?.env).toEqual({ A: "1" });
  });

  it("finds the legacy key and leaves it out of the other-servers list", () => {
    const view = classifyClientConfig(RAW, FLAT);
    expect(view.legacyKey()).toBe("yaw-mcp");
    expect(view.otherServerKeys()).toEqual(["fs"]);
  });

  it("carries env the way the entry accessor it replaced filtered it", () => {
    // `readEntryAt` in install-cmd.ts filtered an entry's env to its STRING
    // values, PER KEY, and reported undefined when nothing was left. Those are
    // the two answers it gave for this fixture -- "mcp" carries a string A
    // beside a numeric key, "fs" carries no env at all. It is gone, so the
    // values are pinned here rather than against a second copy of the rule.
    const view = classifyClientConfig(RAW, FLAT);
    expect(view.carryableEnv()).toEqual({ A: "1" });
    expect(view.carryableEnv("fs")).toBeUndefined();
  });

  it("migrates a legacy entry in one pass", () => {
    const legacy =
      '{\n  "mcpServers": {\n    "yaw-mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
      '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}\n';
    const view = classifyClientConfig(legacy, FLAT);
    expect(view.legacyKey()).toBe("yaw-mcp");
    const out = applyClientConfigEdits(
      view,
      [
        { op: "upsert", key: "mcp", entry: ENTRY },
        { op: "remove", key: "yaw-mcp" },
      ],
      FLAT,
    );
    expect(out).toBe(FRESH);
  });

  it("folds a nested transport form through the target's normalize hook", () => {
    const transform: EntryTransform = {
      normalize: (stored) => {
        if (typeof stored !== "object" || stored === null) return stored;
        const t = (stored as { transport?: unknown }).transport;
        if (typeof t !== "object" || t === null) return stored;
        const { type: _type, ...rest } = t as Record<string, unknown>;
        return { ...(stored as Record<string, unknown>), ...rest, transport: undefined };
      },
    };
    const raw = '{"mcpServers":{"mcp":{"transport":{"type":"stdio","command":"npx","args":["-y","x"]}}}}';
    const view = classifyClientConfig(raw, FLAT, { transform });
    expect(view.entry()?.launch).toEqual({ command: "npx", args: ["-y", "x"] });
    // `value` is still what the file holds, which is what drift compares.
    expect((view.entry()?.value as Record<string, unknown>).transport).toBeDefined();
  });

  it("previews only the entry, at its container path", () => {
    expect(JSONC_ADAPTER.renderPreview({ format: "jsonc", containerPath: ["servers"] }, "mcp", ENTRY, true)).toBe(
      '{\n  "servers": {\n    "mcp": {\n      "command": "npx",\n      "args": [\n        "-y",\n' +
        '        "@yawlabs/mcp@latest"\n      ]\n    }\n  }\n}',
    );
  });

  it("answers with the same syntax word for both flavours, which is what install prints", () => {
    expect(JSONC_ADAPTER.syntax).toBe("JSON");
    expect(JSON_ADAPTER.syntax).toBe("JSON");
    expect(adapterFor("jsonc")).toBe(JSONC_ADAPTER);
    expect(adapterFor("json")).toBe(JSON_ADAPTER);
  });
});

describe("the post-write check is what makes a splicer safe to ship", () => {
  /** An adapter whose upsert also drops a sibling -- the shape of a splicer
   *  bug. Everything else delegates, so only the damage is synthetic. */
  const saboteur = {
    ...JSONC_ADAPTER,
    upsert(
      raw: string | null,
      addr: { format: ConfigFormat; containerPath: readonly string[] },
      key: string,
      entry: Record<string, unknown>,
    ) {
      const spliced = JSONC_ADAPTER.upsert(raw, addr, key, entry);
      return spliced.replace(/\s*"fs": \{[^}]*\},?/, "");
    },
  };

  it("refuses a write that would have eaten a neighbouring entry", () => {
    const raw = '{\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}\n';
    const view = { ...classifyClientConfig(raw, FLAT), adapter: saboteur };
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /which other servers it holds/,
    );
  });

  it("refuses a write that would have changed a value elsewhere in the file", () => {
    const raw = '{\n  "theme": "dark",\n  "mcpServers": {}\n}\n';
    const wrecker = {
      ...JSONC_ADAPTER,
      upsert(
        r: string | null,
        a: { format: ConfigFormat; containerPath: readonly string[] },
        k: string,
        e: Record<string, unknown>,
      ) {
        return JSONC_ADAPTER.upsert(r, a, k, e).replace('"dark"', '"light"');
      },
    };
    const view = { ...classifyClientConfig(raw, FLAT), adapter: wrecker };
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /other settings in the file/,
    );
  });

  it("names the neighbouring entry whose VALUE a write would have changed", () => {
    // The whole-document fingerprint would also catch this, with the generic
    // "other settings in the file" wording. The per-entry check exists to say
    // WHICH neighbour, so the message is what pins it.
    const raw = '{\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}\n';
    const meddler = {
      ...JSONC_ADAPTER,
      upsert(
        r: string | null,
        a: { format: ConfigFormat; containerPath: readonly string[] },
        k: string,
        e: Record<string, unknown>,
      ) {
        // The first "npx" in the spliced text is the sibling's, not ours.
        return JSONC_ADAPTER.upsert(r, a, k, e).replace('"npx"', '"nope"');
      },
    };
    const view = { ...classifyClientConfig(raw, FLAT), adapter: meddler };
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /changed the "fs" entry beside it/,
    );
  });

  it("refuses a write that REORDERED the entries beside it, which canonical equality cannot see", () => {
    // Two neighbours with identical values: the key list and its ORDER are the
    // only evidence left, since a canonical rendering sorts keys away.
    const raw = '{"mcpServers":{"a":{"command":"npx"},"b":{"command":"npx"}}}';
    const shuffler = {
      ...JSONC_ADAPTER,
      upsert(
        r: string | null,
        ad: { format: ConfigFormat; containerPath: readonly string[] },
        k: string,
        e: Record<string, unknown>,
      ) {
        return JSONC_ADAPTER.upsert(r, ad, k, e).replace(
          '"a":{"command":"npx"},"b":{"command":"npx"}',
          '"b":{"command":"npx"},"a":{"command":"npx"}',
        );
      },
    };
    const view = { ...classifyClientConfig(raw, FLAT), adapter: shuffler };
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], FLAT)).toThrow(
      /which other servers it holds, or their order/,
    );
  });

  it("refuses a write that would have made a loadable strict file unloadable", () => {
    // The input parses with JSON.parse; the output would not. Nothing else in
    // the check sees it -- the fingerprint parses leniently on purpose -- so
    // this is the clause that keeps a splicer from silently unloading every
    // server in the file.
    const raw = '{\n  "mcpServers": {\n    "fs": {"command": "npx"}\n  }\n}\n';
    const commenter = {
      ...JSON_ADAPTER,
      upsert(
        r: string | null,
        a: { format: ConfigFormat; containerPath: readonly string[] },
        k: string,
        e: Record<string, unknown>,
      ) {
        return `// added by a splicer that should not have\n${JSON_ADAPTER.upsert(r, a, k, e)}`;
      },
    };
    const view = { ...classifyClientConfig(raw, STRICT), adapter: commenter };
    expect(view.unloadable()).toBeNull();
    expect(() => applyClientConfigEdits(view, [{ op: "upsert", key: "mcp", entry: ENTRY }], STRICT)).toThrow(
      /its client cannot load/,
    );
  });

  it("agrees with install-cmd's deepEqualJson about what counts as a change", () => {
    // The verification compares canonical renderings; install compares values.
    // Same question, so the two must answer alike -- including on key order and
    // on an undefined-valued key, which has no JSON spelling.
    const pairs: Array<[unknown, unknown]> = [
      [
        { command: "npx", args: ["a"] },
        { args: ["a"], command: "npx" },
      ],
      [{ command: "npx" }, { command: "npx", env: undefined }],
      [{ command: "npx" }, { command: "cmd" }],
      [{ a: [1, 2] }, { a: [2, 1] }],
      [null, null],
      [3, "3"],
    ];
    for (const [a, b] of pairs) {
      const viaCanon = JSON.stringify(a) === JSON.stringify(b) || canonEqual(a, b);
      expect(viaCanon, JSON.stringify([a, b])).toBe(deepEqualJson(a, b));
    }
  });
});

/** Canonical-rendering equality, the relation the post-write check uses. */
function canonEqual(a: unknown, b: unknown): boolean {
  const view = classifyClientConfig(JSON.stringify({ mcpServers: { x: a } }), FLAT);
  const other = classifyClientConfig(JSON.stringify({ mcpServers: { x: b } }), FLAT);
  return (
    JSONC_ADAPTER.canon(view.raw as string, { format: "jsonc", containerPath: ["mcpServers"] }) ===
    JSONC_ADAPTER.canon(other.raw as string, { format: "jsonc", containerPath: ["mcpServers"] })
  );
}
