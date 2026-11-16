// StateSync against a state.json that a NEWER yaw-mcp wrote while this
// process was already running. Every save is deferred for as long as that
// file stays, and the server re-arms a deferred save, so anything logged per
// attempt repeats for the life of the process. Pinned here: the file is left
// alone, and the deferral is logged once, not twice per attempt.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadState, type SavableState, STATE_SCHEMA_VERSION, StateSync } from "../persistence.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-newer-"));
  file = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CURRENT: SavableState = {
  learning: { gh: { dispatched: 3, succeeded: 2, lastUsedAt: Date.now() } },
  packHistory: [],
  toolCache: {},
};

function newSync(target: string): StateSync {
  return new StateSync(
    { exportCurrent: () => CURRENT, applyMerged: () => {} },
    { filePath: target, lock: { lockWaitMs: 200 } },
  );
}

/** Run `fn` with stderr captured; returns one string per logged line. */
async function captured(fn: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await fn();
    return spy.mock.calls
      .map((c) => String(c[0]))
      .join("")
      .split("\n")
      .filter((l) => l.length > 0);
  } finally {
    spy.mockRestore();
  }
}

describe("StateSync and a state.json written by a newer yaw-mcp", () => {
  it("defers every save, leaves the file alone, and logs the deferral once", async () => {
    const newer = JSON.stringify({ version: STATE_SCHEMA_VERSION + 1, savedAt: 1, learning: {}, packHistory: [] });
    writeFileSync(file, newer, "utf8");
    const sync = newSync(file);
    const lines = await captured(async () => {
      for (let i = 0; i < 3; i++) expect(await sync.save()).toBe(false);
    });
    expect(readFileSync(file, "utf8")).toBe(newer);
    // RED with the non-quiet re-read and the unlatched warn: six lines, two
    // per attempt.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("state save deferred: state.json was written by a newer yaw-mcp");
  });

  it("says it again when the newer file comes back after a save that completed", async () => {
    const newer = JSON.stringify({ version: STATE_SCHEMA_VERSION + 1, savedAt: 1, learning: {}, packHistory: [] });
    writeFileSync(file, newer, "utf8");
    const sync = newSync(file);
    const lines = await captured(async () => {
      expect(await sync.save()).toBe(false);
      rmSync(file);
      expect(await sync.save()).toBe(true);
      writeFileSync(file, newer, "utf8");
      expect(await sync.save()).toBe(false);
      expect(await sync.save()).toBe(false);
    });
    expect(lines.filter((l) => l.includes("written by a newer yaw-mcp"))).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });

  it("a transient unreadable re-read still logs one line per attempt, with the read error", async () => {
    // A directory where the file should be: readFile fails with EISDIR, the
    // same "exists but could not be read" class as a win32 EBUSY.
    const asDir = join(dir, "state-as-dir.json");
    mkdirSync(asDir);
    const sync = newSync(asDir);
    const lines = await captured(async () => {
      expect(await sync.save()).toBe(false);
      expect(await sync.save()).toBe(false);
    });
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("state save deferred: state.json could not be re-read; pending changes kept");
      expect(l).toContain("EISDIR");
    }
  });

  it("a corrupt file is replaced, with one line saying so", async () => {
    writeFileSync(file, "{ not json", "utf8");
    const sync = newSync(file);
    const lines = await captured(async () => {
      expect(await sync.save()).toBe(true);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("state file was unusable at save time; replacing it with this process's state");
    expect((await loadState(file)).learning.gh?.dispatched).toBe(3);
  });
});
