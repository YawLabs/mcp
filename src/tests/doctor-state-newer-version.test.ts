// doctor's STATE section, for a state.json this build cannot read.
//
// A version ABOVE this build's was written by a newer yaw-mcp that is still
// using it (persistence.ts flags it so no save can overwrite it). The fix line
// used to advise `yaw-mcp reset-learning` for every unreadable version, which
// for that one deletes the newer broker's live learning.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../doctor-cmd.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";

/** probeOam's answer when oam is not installed: keeps the real probe (a spawn
 *  of `oam --version`) out of the suite. */
const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-state-newer-"));
  cwd = mkdtempSync(join(home, "cwd-"));
  mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function stateSection(version: unknown): Promise<string> {
  writeFileSync(
    join(home, ".yaw-mcp", STATE_FILENAME),
    JSON.stringify({ version, savedAt: Date.now(), learning: {}, packHistory: [] }),
  );
  const lines: string[] = [];
  await runDoctor({
    cwd,
    home,
    env: {},
    os: "linux",
    out: (s: string) => lines.push(s),
    err: () => {},
    oamProbe: oamNotInstalled,
    skipRegistryCheck: true,
  });
  const text = lines.join("");
  const start = text.indexOf("STATE\n");
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("\n\n", start));
}

describe("doctor STATE -- a state file this build cannot read", () => {
  it("a NEWER file is not something to reset: upgrade this install", async () => {
    const section = await stateSection(STATE_SCHEMA_VERSION + 1);
    expect(section).toContain(
      `schema mismatch (file is v${STATE_SCHEMA_VERSION + 1}, this yaw-mcp reads v${STATE_SCHEMA_VERSION})`,
    );
    expect(section).toContain(
      "fix:    written by a newer yaw-mcp -- upgrade this install; this process will not save over it",
    );
    expect(section).not.toContain("reset-learning");
  });

  it("an OLDER or version-less file keeps the reset-learning advice", async () => {
    for (const version of [0, undefined, "2"]) {
      const section = await stateSection(version);
      expect(section, String(version)).toContain(
        "fix:    `yaw-mcp reset-learning` to drop the old file -- learning will rebuild on use",
      );
      expect(section, String(version)).not.toContain("newer yaw-mcp");
    }
  });
});
