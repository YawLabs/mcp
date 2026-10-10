// Concurrent yaw-mcp panes saving the same ~/.yaw-mcp/state.json.
//
// Every running `yaw-mcp serve` (one per MCP client pane) loads state.json at
// startup and saves it on a 1s debounce. Before StateSync each save published
// the whole document from the snapshot that process loaded, so with two panes
// open the later save silently erased the earlier one's learning. These tests
// pin the fix: a cross-process lock, a re-read under it, and a DELTA merge
// that neither drops the other pane's work nor counts anything twice.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LearningStore } from "../learning.js";
import { PackDetector } from "../pack-detect.js";
import {
  loadState,
  mergeStateDelta,
  type PersistedState,
  type PersistedToolCacheEntry,
  STATE_SCHEMA_VERSION,
  StateSync,
} from "../persistence.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One simulated `yaw-mcp serve`: the same three stores ConnectServer keeps,
 *  wired to a StateSync exactly the way server.ts wires its own. */
class Pane {
  readonly learning = new LearningStore();
  readonly packs = new PackDetector();
  readonly toolCache = new Map<string, PersistedToolCacheEntry>();
  readonly sync: StateSync;

  constructor(file: string, lockWaitMs?: number) {
    this.sync = new StateSync(
      {
        exportCurrent: () => ({
          learning: this.learning.exportSnapshot(),
          packHistory: this.packs.exportSnapshot(),
          toolCache: Object.fromEntries(this.toolCache),
        }),
        applyMerged: (merged) => {
          this.learning.loadSnapshot(merged.learning);
          this.packs.loadSnapshot(merged.packHistory);
        },
      },
      { filePath: file, lock: lockWaitMs === undefined ? {} : { lockWaitMs } },
    );
  }

  /** ConnectServer.start(): hydrate, then baseline on the hydrated view. */
  async start(file: string): Promise<void> {
    const persisted = await loadState(file);
    this.learning.loadSnapshot(persisted.learning);
    this.packs.loadSnapshot(persisted.packHistory);
    for (const [ns, e] of Object.entries(persisted.toolCache)) this.toolCache.set(ns, e);
    this.sync.setBaseline({
      learning: this.learning.exportSnapshot(),
      packHistory: this.packs.exportSnapshot(),
      toolCache: Object.fromEntries(this.toolCache),
    });
  }

  save(): Promise<boolean> {
    return this.sync.save();
  }
}

function readState(file: string): PersistedState {
  return JSON.parse(readFileSync(file, "utf8")) as PersistedState;
}

describe("StateSync: two panes, interleaved", () => {
  let dir: string;
  let file: string;
  const now = Date.now();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-statesync-"));
    file = join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: 1,
        learning: { gh: { dispatched: 10, succeeded: 8, lastUsedAt: 1_000 } },
        packHistory: [{ namespace: "gh", toolName: "listPrs", at: 1_000 }],
        toolCache: { gh: { tools: [{ name: "listPrs" }], learnedAt: now - 60_000 } },
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("A loads, B loads, B saves, A saves: both panes' changes land, nothing double-counted", async () => {
    const a = new Pane(file);
    const b = new Pane(file);
    await a.start(file);
    await b.start(file);

    // B: two good gh calls and a first-ever fs call.
    b.learning.recordOutcome("gh", 1);
    b.learning.recordOutcome("gh", 1);
    b.learning.recordOutcome("fs", 1);
    b.packs.recordCall("fs", "read", 2_000);
    expect(await b.save()).toBe(true);

    // A: three failed gh calls, one pack call, and a freshly learned tool list.
    a.learning.recordOutcome("gh", 0);
    a.learning.recordOutcome("gh", 0);
    a.learning.recordOutcome("gh", 0);
    a.packs.recordCall("gh", "getIssue", 3_000);
    a.toolCache.set("linear", { tools: [{ name: "createIssue" }], learnedAt: now });
    expect(await a.save()).toBe(true);

    const disk = readState(file);
    // 10 on disk + 2 from B + 3 from A. A plain overwrite (the old behavior)
    // leaves 13 and no fs row; a naive totals-sum leaves 25.
    expect(disk.learning.gh.dispatched).toBe(15);
    expect(disk.learning.gh.succeeded).toBe(10);
    expect(disk.learning.fs).toMatchObject({ dispatched: 1, succeeded: 1 });
    expect(disk.packHistory.map((c) => `${c.namespace}.${c.toolName}`)).toEqual([
      "gh.listPrs",
      "fs.read",
      "gh.getIssue",
    ]);
    expect(Object.keys(disk.toolCache).sort()).toEqual(["gh", "linear"]);

    // A refreshed its memory from the merge: it now routes on B's learning.
    expect(a.learning.get("gh")?.dispatched).toBe(15);
    expect(a.learning.get("fs")?.dispatched).toBe(1);
    expect(a.packs.getHistory()).toHaveLength(3);

    // Saving again with nothing new changes nothing -- from either pane. B's
    // memory still says 12 for gh, but its baseline says 12 too: no delta.
    expect(await a.save()).toBe(true);
    expect(await b.save()).toBe(true);
    const again = readState(file);
    expect(again.learning.gh.dispatched).toBe(15);
    expect(again.learning.gh.succeeded).toBe(10);
    expect(again.packHistory).toHaveLength(3);
    // ...and B caught up with A on that save.
    expect(b.learning.get("gh")?.dispatched).toBe(15);
  });

  it("a negative credit revision (adjustSucceeded) merges as a delta too", async () => {
    const a = new Pane(file);
    const b = new Pane(file);
    await a.start(file);
    await b.start(file);
    b.learning.recordOutcome("gh", 1);
    expect(await b.save()).toBe(true);
    // The reward grader revising a heuristic 1.0 down to 0.0 on A's side.
    a.learning.recordOutcome("gh", 1);
    a.learning.adjustSucceeded("gh", -1);
    expect(await a.save()).toBe(true);
    const disk = readState(file);
    expect(disk.learning.gh.dispatched).toBe(12);
    expect(disk.learning.gh.succeeded).toBe(9);
  });

  it("does not resurrect rows another writer removed (reset-learning deleting the file)", async () => {
    const a = new Pane(file);
    await a.start(file);
    rmSync(file);
    a.learning.recordOutcome("fs", 1);
    expect(await a.save()).toBe(true);
    const disk = readState(file);
    // Only what A recorded since its baseline; the pre-reset gh row and the
    // untouched gh tool list stay gone.
    expect(Object.keys(disk.learning)).toEqual(["fs"]);
    expect(disk.packHistory).toEqual([]);
    expect(disk.toolCache).toEqual({});
    // A adopted the reset in memory as well.
    expect(a.learning.get("gh")).toBeUndefined();
    // And a second save still does not bring the tool list back.
    expect(await a.save()).toBe(true);
    expect(readState(file).toolCache).toEqual({});
  });

  it("a corrupt file is replaced by this pane's full view (the documented start-over)", async () => {
    const a = new Pane(file);
    await a.start(file);
    writeFileSync(file, "{ not json");
    a.learning.recordOutcome("fs", 1);
    expect(await a.save()).toBe(true);
    const disk = readState(file);
    expect(disk.learning.gh.dispatched).toBe(10);
    expect(disk.learning.fs.dispatched).toBe(1);
  });

  it("calls recorded while a save is in flight are kept in memory and land on the next save", async () => {
    const a = new Pane(file);
    await a.start(file);
    a.learning.recordOutcome("gh", 1);
    const saving = a.save();
    // Lands after save() took its snapshot (the lock + re-read are async).
    await Promise.resolve();
    a.learning.recordOutcome("gh", 1);
    expect(await saving).toBe(true);
    expect(a.learning.get("gh")?.dispatched).toBe(12);
    expect(await a.save()).toBe(true);
    expect(readState(file).learning.gh.dispatched).toBe(12);
  });
});

describe("StateSync: the lock", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-statelock-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes over a stale lock left by a crashed holder", async () => {
    const lock = `${file}.lock`;
    writeFileSync(lock, "99999-1\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const a = new Pane(file, 2_000);
    await a.start(file);
    a.learning.recordOutcome("gh", 1);
    expect(await a.save()).toBe(true);
    expect(readState(file).learning.gh.dispatched).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("a lock timeout keeps the pending delta, which lands exactly once on the next save", async () => {
    const lock = `${file}.lock`;
    const a = new Pane(file, 100);
    await a.start(file);
    a.learning.recordOutcome("gh", 1);
    a.packs.recordCall("gh", "listPrs", 1_000);
    expect(await a.save()).toBe(true);

    // Another pane holds a LIVE lock past A's wait budget.
    writeFileSync(lock, "99999-2\n");
    a.learning.recordOutcome("gh", 1);
    a.packs.recordCall("gh", "getIssue", 2_000);
    expect(await a.save()).toBe(false);
    expect(readState(file).learning.gh.dispatched).toBe(1);

    // The holder releases; more calls arrive; the next save carries both.
    rmSync(lock);
    a.learning.recordOutcome("gh", 0);
    expect(await a.save()).toBe(true);
    const disk = readState(file);
    expect(disk.learning.gh.dispatched).toBe(3);
    expect(disk.learning.gh.succeeded).toBe(2);
    expect(disk.packHistory.map((c) => c.toolName)).toEqual(["listPrs", "getIssue"]);
  });
});

describe("mergeStateDelta", () => {
  it("toolCache: the newer learnedAt wins in both directions", () => {
    const disk = {
      learning: {},
      packHistory: [],
      toolCache: { a: { tools: [{ name: "disk" }], learnedAt: 200 }, b: { tools: [{ name: "disk" }], learnedAt: 100 } },
    };
    const baseline = {
      learning: {},
      packHistory: [],
      toolCache: { a: { tools: [], learnedAt: 50 }, b: { tools: [], learnedAt: 50 } },
    };
    const current = {
      learning: {},
      packHistory: [],
      toolCache: { a: { tools: [{ name: "mine" }], learnedAt: 150 }, b: { tools: [{ name: "mine" }], learnedAt: 150 } },
    };
    const merged = mergeStateDelta(disk, baseline, current);
    expect(merged.toolCache.a.tools[0].name).toBe("disk");
    expect(merged.toolCache.b.tools[0].name).toBe("mine");
  });

  it("does not re-append pack calls already on disk (a retried save is idempotent)", () => {
    const call = { namespace: "gh", toolName: "x", at: 5 };
    const merged = mergeStateDelta(
      { learning: {}, packHistory: [call], toolCache: {} },
      { learning: {}, packHistory: [] },
      { learning: {}, packHistory: [call] },
    );
    expect(merged.packHistory).toHaveLength(1);
  });
});

// Real processes, real lock contention. Each child is a Pane that records a
// fixed set of calls and saves after every one; the parent sums the
// increments it handed out and checks the file holds exactly that sum.
describe("StateSync across real processes", () => {
  const CHILDREN = 3;
  const ITERATIONS = 25;
  let dir: string;
  let childScript: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-statemp-"));
    // esbuild bundles the child (TS sources and all) in memory; node writes
    // it, for the first-run AV reason broker-bundle.ts documents.
    const out = await build({
      stdin: {
        contents: CHILD_SOURCE,
        resolveDir: HERE,
        sourcefile: "state-child.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      logLevel: "silent",
    });
    childScript = join(dir, "state-child.mjs");
    writeFileSync(childScript, out.outputFiles[0].text);
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("final counts equal the sum of every process's increments", async () => {
    const file = join(dir, "state.json");
    const runs = Array.from({ length: CHILDREN }, (_, i) => runChild(childScript, file, `w${i}`, ITERATIONS));
    // Barrier: every child has LOADED before any starts saving, so they all
    // begin from the same snapshot -- the multi-pane shape -- instead of a
    // slow spawn letting each one start from its predecessor's final file.
    const deadline = Date.now() + 120_000;
    while (!Array.from({ length: CHILDREN }, (_, i) => existsSync(`${file}.ready-w${i}`)).every(Boolean)) {
      if (Date.now() > deadline) throw new Error("children never became ready");
      await delay(20);
    }
    writeFileSync(`${file}.go`, "");
    const codes = await Promise.all(runs);
    for (const r of codes) expect(r.code, r.stderr).toBe(0);

    const disk = readState(file);
    expect(disk.learning.shared.dispatched).toBe(CHILDREN * ITERATIONS);
    expect(disk.learning.shared.succeeded).toBe(CHILDREN * ITERATIONS);
    for (let i = 0; i < CHILDREN; i++) expect(disk.learning[`w${i}`].dispatched).toBe(ITERATIONS);
    expect(disk.packHistory).toHaveLength(CHILDREN * ITERATIONS);
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 180_000);
});

function runChild(
  script: string,
  file: string,
  id: string,
  iterations: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, file, id, String(iterations)], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, YAW_MCP_LOG_LEVEL: "error" },
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stderr: stderr.slice(-4000) }));
  });
}

// The child: start like a pane, then record + save in a loop. A save that
// loses the lock race (false) is not retried on the spot -- the delta rides
// on the next iteration's save, as it would in a real pane -- and the final
// loop drains whatever is still pending.
const CHILD_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { LearningStore } from "../learning.js";
import { PackDetector } from "../pack-detect.js";
import { loadState, StateSync } from "../persistence.js";

const [file, id, n] = process.argv.slice(2);
const learning = new LearningStore();
const packs = new PackDetector({ maxHistory: 1000 });
const sync = new StateSync(
  {
    exportCurrent: () => ({ learning: learning.exportSnapshot(), packHistory: packs.exportSnapshot(), toolCache: {} }),
    applyMerged: (m) => {
      learning.loadSnapshot(m.learning);
      packs.loadSnapshot(m.packHistory);
    },
  },
  { filePath: file, lock: { lockWaitMs: 200 } },
);
const persisted = await loadState(file);
learning.loadSnapshot(persisted.learning);
packs.loadSnapshot(persisted.packHistory);
sync.setBaseline({ learning: learning.exportSnapshot(), packHistory: packs.exportSnapshot(), toolCache: {} });
writeFileSync(file + ".ready-" + id, "");
while (!existsSync(file + ".go")) await sleep(10);
for (let i = 0; i < Number(n); i++) {
  // Jitter so the children's saves interleave rather than run in lockstep.
  await sleep(Math.floor(Math.random() * 15));
  learning.recordOutcome("shared", 1);
  learning.recordOutcome(id, 1);
  packs.recordCall(id, "t" + i, Date.now() * 1000 + i);
  await sync.save();
}
for (let tries = 0; tries < 200 && !(await sync.save()); tries++) {}
`;
