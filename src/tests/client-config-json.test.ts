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
  type ConfigFormat,
  type ConfigSite,
  classifyClientConfig,
  type EntryTransform,
  terminateWithNewline,
} from "../client-config.js";
import { buildFreshConfig, JSON_ADAPTER, JSONC_ADAPTER, UTF8_BOM } from "../client-config-json.js";
import { deepEqualJson, mergeClientConfig, readEntryAt } from "../install-cmd.js";
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

  it("renders that fresh document the same way install-cmd's merge does", () => {
    // Two spellings of one rule: the adapter's own nesting and the
    // mergeClientConfig the missing-file path uses today. Pinned against each
    // other so the pair cannot drift while the consumer still has its copy.
    expect(buildFreshConfig(["mcpServers"], "mcp", ENTRY)).toEqual(mergeClientConfig({}, ["mcpServers"], ENTRY));
    expect(buildFreshConfig(["projects", "C:/r", "mcpServers"], "mcp", ENTRY)).toEqual(
      mergeClientConfig({}, ["projects", "C:/r", "mcpServers"], ENTRY),
    );
    expect(`${JSON.stringify(mergeClientConfig({}, ["mcpServers"], ENTRY), null, 2)}\n`).toBe(FRESH);
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

  it("carries env exactly as install-cmd's readEntryAt filters it", () => {
    const parsed = JSON.parse(RAW) as Record<string, unknown>;
    const view = classifyClientConfig(RAW, FLAT);
    expect(view.carryableEnv()).toEqual(readEntryAt(parsed, ["mcpServers"], "mcp")?.env);
    expect(view.carryableEnv("fs")).toEqual(readEntryAt(parsed, ["mcpServers"], "fs")?.env);
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
