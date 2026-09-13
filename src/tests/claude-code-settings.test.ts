import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_ALLOW_PATTERN,
  patchPermissionsAllowText,
  prepareClaudeCodeSettingsPatch,
  resolveClaudeCodeSettingsPath,
} from "../claude-code-settings.js";

// Every fixture below is a string literal built in this file, and the only
// control character any of them contains is a line feed, spelled as a readable
// escape. A tab would be built from its code point instead: a backslash-t that
// lost a level on its way into this file becomes a REAL tab inside a string
// literal, which is valid TypeScript, passes the linter and the type-check,
// and silently changes what a byte-exact expectation means.
const TAB = String.fromCharCode(9);

const homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "yaw-ccs-"));
  homes.push(h);
  return h;
}
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("patchPermissionsAllowText -- the grant is one array ELEMENT", () => {
  it("keeps a comment INSIDE the allow list across an add and a remove", () => {
    // The regression this function exists for: the previous implementation
    // wrote the whole `allow` VALUE, so jsonc-parser re-rendered the array and
    // every comment in it was gone -- on install AND on uninstall.
    const before =
      "{\n" +
      '  "permissions": {\n' +
      '    "allow": [\n' +
      "      // the team agreed on this one\n" +
      '      "Bash(ls:*)"\n' +
      "    ]\n" +
      "  },\n" +
      '  "model": "opus"\n' +
      "}\n";
    const added = patchPermissionsAllowText(before, [CLAUDE_CODE_ALLOW_PATTERN], "add");
    expect(added).toBe(
      "{\n" +
        '  "permissions": {\n' +
        '    "allow": [\n' +
        "      // the team agreed on this one\n" +
        '      "Bash(ls:*)",\n' +
        '      "mcp__mcp__*"\n' +
        "    ]\n" +
        "  },\n" +
        '  "model": "opus"\n' +
        "}\n",
    );
    // And back to the original bytes, comment included.
    expect(patchPermissionsAllowText(added, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(before);
  });

  it("keeps a comment that sits ABOVE the list and one on the element beside ours", () => {
    const before =
      "{\n" +
      "  // permissions are reviewed quarterly\n" +
      '  "permissions": {\n' +
      '    "allow": [\n' +
      '      "Bash(ls:*)", // harmless\n' +
      '      "Read(**)"\n' +
      "    ],\n" +
      '    "deny": ["Bash(rm:*)"]\n' +
      "  }\n" +
      "}\n";
    const added = patchPermissionsAllowText(before, [CLAUDE_CODE_ALLOW_PATTERN], "add");
    expect(added).toContain("// permissions are reviewed quarterly");
    expect(added).toContain('"Bash(ls:*)", // harmless');
    expect(added).toContain('"Read(**)",\n      "mcp__mcp__*"');
    expect(patchPermissionsAllowText(added, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(before);
  });

  it("copies the file's own line ending and indent rather than imposing two spaces", () => {
    // A CRLF, tab-indented settings.json is ordinary on Windows. Re-rendering
    // the array through a formatter rewrote its members at two spaces and left
    // the rest of the file at tabs.
    const CRLF = "\r\n";
    const before = `{${CRLF}${TAB}"permissions": {${CRLF}${TAB}${TAB}"allow": [${CRLF}${TAB}${TAB}${TAB}"Bash(ls:*)"${CRLF}${TAB}${TAB}]${CRLF}${TAB}}${CRLF}}${CRLF}`;
    const added = patchPermissionsAllowText(before, [CLAUDE_CODE_ALLOW_PATTERN], "add");
    expect(added).toBe(
      `{${CRLF}${TAB}"permissions": {${CRLF}${TAB}${TAB}"allow": [${CRLF}${TAB}${TAB}${TAB}"Bash(ls:*)",${CRLF}${TAB}${TAB}${TAB}"mcp__mcp__*"${CRLF}${TAB}${TAB}]${CRLF}${TAB}}${CRLF}}${CRLF}`,
    );
    expect(added.includes('\n  "mcp')).toBe(false);
    expect(patchPermissionsAllowText(added, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(before);
  });

  it("mirrors a trailing comma, and adding twice is a byte-for-byte no-op", () => {
    const before = '{\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)",\n    ]\n  }\n}\n';
    const once = patchPermissionsAllowText(before, [CLAUDE_CODE_ALLOW_PATTERN], "add");
    expect(once).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)",\n      "mcp__mcp__*",\n    ]\n  }\n}\n',
    );
    expect(patchPermissionsAllowText(once, [CLAUDE_CODE_ALLOW_PATTERN], "add")).toBe(once);
  });

  it("removes EVERY copy when the list carries our pattern twice", () => {
    // `mergePermissionsAllow` dedupes, so install never writes a duplicate --
    // but a hand-edited settings.json can carry one, and an uninstall that
    // dropped only the first would print Done over a grant that is still
    // live. Each removal therefore re-parses the text the LAST one produced:
    // one set of edits taken from a single parse would land the second at a
    // stale offset.
    const before =
      "{\n" +
      '  "permissions": {\n' +
      '    "allow": [\n' +
      '      "mcp__mcp__*",\n' +
      '      "Bash(ls:*)",\n' +
      '      "mcp__mcp__*"\n' +
      "    ]\n" +
      "  }\n" +
      "}\n";
    expect(patchPermissionsAllowText(before, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(
      '{\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)"\n    ]\n  }\n}\n',
    );
  });

  it("leaves an emptied list as [] and a list it is not in untouched", () => {
    const only = '{\n  "permissions": {\n    "allow": [\n      "mcp__mcp__*"\n    ]\n  }\n}\n';
    expect(patchPermissionsAllowText(only, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(
      '{\n  "permissions": {\n    "allow": []\n  }\n}\n',
    );
    const other = '{\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n';
    expect(patchPermissionsAllowText(other, [CLAUDE_CODE_ALLOW_PATTERN], "remove")).toBe(other);
  });
});

describe("prepareClaudeCodeSettingsPatch", () => {
  it("splices into a commented allow list and reports exactly what it added", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const path = join(home, ".claude", "settings.json");
    const before = '{\n  "permissions": {\n    "allow": [\n      // keep me\n      "Bash(ls:*)"\n    ]\n  }\n}\n';
    writeFileSync(path, before, "utf8");
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
    });
    expect(patch?.changed).toBe(true);
    expect(patch?.added).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(patch?.nextJson).toContain("// keep me");
    expect(patch?.nextJson).toContain('"Bash(ls:*)",\n      "mcp__mcp__*"');
  });

  it("reports a non-object `permissions` by shape instead of repairing it", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), '{"permissions": [1, 2]}', "utf8");
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
    });
    expect(patch?.malformed).toBe(true);
    expect(patch?.malformedReason).toBe('"permissions" is an array of 2, not a JSON object');
    expect(patch?.changed).toBe(false);
  });

  it("reports an `allow` that is not an array rather than replacing it", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), '{"permissions": {"allow": "everything"}}', "utf8");
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
    });
    expect(patch?.malformed).toBe(true);
    expect(patch?.malformedReason).toContain("could not splice permissions.allow");
    expect(patch?.malformedReason).toContain("not an array");
  });

  it("renders a fresh settings.json when the file is absent, and is a no-op on a second add", async () => {
    const home = freshHome();
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
    });
    expect(patch?.path).toBe(join(home, ".claude", "settings.json"));
    expect(patch?.nextJson).toBe(
      `${JSON.stringify({ permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } }, null, 2)}\n`,
    );
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), patch?.nextJson ?? "", "utf8");
    const again = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
    });
    expect(again?.changed).toBe(false);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(patch?.nextJson);
  });

  it("sends each scope to its own file, and honours CLAUDE_CONFIG_DIR for user scope", () => {
    expect(resolveClaudeCodeSettingsPath("user", { home: "/h" })).toBe(join("/h", ".claude", "settings.json"));
    expect(resolveClaudeCodeSettingsPath("user", { home: "/h", claudeConfigDir: "/cfg" })).toBe(
      join("/cfg", "settings.json"),
    );
    expect(resolveClaudeCodeSettingsPath("project", { home: "/h", projectDir: "/p" })).toBe(
      join("/p", ".claude", "settings.json"),
    );
    expect(resolveClaudeCodeSettingsPath("local", { home: "/h", projectDir: "/p" })).toBe(
      join("/p", ".claude", "settings.local.json"),
    );
    expect(resolveClaudeCodeSettingsPath("project", { home: "/h" })).toBeNull();
  });
});
