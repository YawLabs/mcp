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
  return { ...actual, removeJsoncArrayElements: (src: string) => src };
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
});
