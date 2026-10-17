// settingsFingerprint's errno split, in its own file because it mocks
// node:fs/promises for the whole module graph. A stat that fails with anything
// but ENOENT must NOT read as "absent": that path skips the read and renders a
// fresh settings.json holding only permissions.allow, which install would then
// publish over the user's hooks/model/env.

import { describe, expect, it, vi } from "vitest";

const statFailure: { code: string | null } = { code: null };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (statFailure.code !== null) {
        throw Object.assign(new Error(`${statFailure.code}: simulated stat failure`), { code: statFailure.code });
      }
      return actual.stat(...args);
    },
  };
});

const { prepareClaudeCodeSettingsPatch } = await import("../claude-code-settings.js");

const opts = { scope: "user" as const, home: "/nonexistent-home", projectDir: undefined, claudeConfigDir: undefined };

describe("prepareClaudeCodeSettingsPatch -- stat errno split", () => {
  it("reports a non-ENOENT stat failure as unreadable and leaves the file alone", async () => {
    statFailure.code = "ELOOP";
    try {
      const patch = await prepareClaudeCodeSettingsPatch(opts);
      expect(patch?.changed).toBe(false);
      expect(patch?.nextJson).toBe("");
      expect(patch?.malformed).toBe(true);
      expect(patch?.malformedReason).toContain("could not stat it");
      expect(patch?.malformedReason).toContain("ELOOP");
    } finally {
      statFailure.code = null;
    }
  });

  it("still treats ENOENT as absent and renders a fresh document", async () => {
    statFailure.code = "ENOENT";
    try {
      const patch = await prepareClaudeCodeSettingsPatch(opts);
      expect(patch?.changed).toBe(true);
      expect(patch?.malformed).toBeUndefined();
    } finally {
      statFailure.code = null;
    }
  });
});
