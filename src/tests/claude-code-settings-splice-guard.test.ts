import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_ALLOW_PATTERN, prepareClaudeCodeSettingsPatch } from "../claude-code-settings.js";

// A splice that silently changes nothing -- the shape the recoverable-parse-
// error bug had. Whatever the next cause is, prepareClaudeCodeSettingsPatch
// must check the bytes it is about to write, not the parsed value it computed
// the report from.
vi.mock("../jsonc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jsonc.js")>();
  // Both ops: patchPermissionsAllowText routes add through addJsoncArrayElement
  // and remove through removeJsoncArrayElements, and the guard's byte check is
  // the same one either way.
  return {
    ...actual,
    addJsoncArrayElement: (src: string) => src,
    removeJsoncArrayElements: (src: string) => src,
  };
});

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("prepareClaudeCodeSettingsPatch -- splice guard", () => {
  it("never reports a removal when the splice left the pattern in the bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "yaw-ccs-guard-"));
    homes.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      `{\n  "permissions": {\n    "allow": ["${CLAUDE_CODE_ALLOW_PATTERN}"]\n  }\n}\n`,
      "utf8",
    );
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
      op: "remove",
    });
    expect(patch?.changed).toBe(false);
    expect(patch?.removed).toEqual([]);
    expect(patch?.malformed).toBe(true);
    expect(patch?.malformedReason).toContain("could not splice permissions.allow");
  });

  it("never reports an addition when the add splice left the pattern out of the bytes", async () => {
    // The add side of the same guard: the report is computed from the PARSED
    // allow, the bytes are what install publishes, and a splice that no-ops
    // must not read as "changed: true, added: [pattern]". The mocked
    // removeJsoncArrayElements above no-ops every call, and
    // patchPermissionsAllowText routes the add through addJsoncArrayElement,
    // which is NOT mocked -- so pin the mock to the op the test drives.
    const home = mkdtempSync(join(tmpdir(), "yaw-ccs-guard-"));
    homes.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), `{\n  "permissions": { "allow": [] }\n}\n`, "utf8");
    const patch = await prepareClaudeCodeSettingsPatch({
      scope: "user",
      home,
      projectDir: undefined,
      claudeConfigDir: undefined,
      op: "add",
    });
    expect(patch?.changed).toBe(false);
    expect(patch?.added).toEqual([]);
    expect(patch?.malformed).toBe(true);
    expect(patch?.malformedReason).toContain("could not splice permissions.allow");
  });
});
