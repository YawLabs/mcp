// The tool cache and pre-warm failures as state SHARED by every broker on the
// machine. Each Claude Code / typed pane starts its own yaw-mcp, so state.json
// is written by many processes; these pin that (a) the launch-config
// fingerprint and upstream version survive the round trip, (b) a pre-warm
// failure is persisted and expires, and (c) a broker's merging save
// (StateSync) lands its delta on top of the file instead of letting an older
// broker's snapshot erase a newer list or resurrect a cleared failure.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadState,
  mergePrewarmFailures,
  PREWARM_FAILURE_BACKOFF_MS,
  PREWARM_FAILURE_MAX_MESSAGE_CHARS,
  type SavableState,
  STATE_SCHEMA_VERSION,
  StateSync,
  saveState,
  TOOLCACHE_MAX_META_CHARS,
} from "../persistence.js";

/** One broker's save: it hydrated `baseline` at startup and holds `current`
 *  now, so `current - baseline` is what it lands on top of the file. */
function brokerSave(file: string, baseline: SavableState, current: SavableState): Promise<boolean> {
  const sync = new StateSync(
    { exportCurrent: () => current, applyMerged: () => {} },
    { filePath: file, lock: { lockWaitMs: 200 } },
  );
  sync.setBaseline(baseline);
  return sync.save();
}

describe("shared tool cache persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-shared-state-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips configKey and serverVersion on a tool-cache entry", async () => {
    const learnedAt = Date.now();
    await saveState(
      {
        learning: {},
        packHistory: [],
        toolCache: { gh: { tools: [{ name: "get_me" }], learnedAt, configKey: "abc123", serverVersion: "0.9.1" } },
      },
      file,
    );
    expect((await loadState(file)).toolCache.gh).toEqual({
      tools: [{ name: "get_me" }],
      learnedAt,
      configKey: "abc123",
      serverVersion: "0.9.1",
    });
  });

  it("drops non-string metadata and bounds long metadata", async () => {
    const learnedAt = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: 1,
        learning: {},
        packHistory: [],
        toolCache: {
          a: { tools: [{ name: "t" }], learnedAt, configKey: 42, serverVersion: "" },
          b: { tools: [{ name: "t" }], learnedAt, configKey: "k".repeat(500) },
        },
      }),
    );
    const loaded = await loadState(file);
    expect(loaded.toolCache.a).toEqual({ tools: [{ name: "t" }], learnedAt });
    expect(loaded.toolCache.b.configKey).toHaveLength(TOOLCACHE_MAX_META_CHARS);
  });

  it("persists a pre-warm failure, truncates its message, and omits the key when there are none", async () => {
    const failedAt = Date.now();
    await saveState(
      {
        learning: {},
        packHistory: [],
        prewarmFailures: { github: { failedAt, configKey: "k1", message: "x".repeat(1000) } },
      },
      file,
    );
    const loaded = await loadState(file);
    expect(loaded.prewarmFailures?.github.failedAt).toBe(failedAt);
    expect(loaded.prewarmFailures?.github.message).toHaveLength(PREWARM_FAILURE_MAX_MESSAGE_CHARS);

    await saveState({ learning: {}, packHistory: [] }, file);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("prewarmFailures");
    expect(await loadState(file)).not.toHaveProperty("prewarmFailures");
  });

  it("drops a pre-warm failure older than the backoff and one without a configKey", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: 1,
        learning: {},
        packHistory: [],
        toolCache: {},
        prewarmFailures: {
          old: { failedAt: Date.now() - PREWARM_FAILURE_BACKOFF_MS - 1000, configKey: "k", message: "m" },
          nokey: { failedAt: Date.now(), message: "m" },
          fresh: { failedAt: Date.now(), configKey: "k", message: "m" },
        },
      }),
    );
    expect(Object.keys((await loadState(file)).prewarmFailures ?? {})).toEqual(["fresh"]);
  });

  describe("a broker's merging save (StateSync)", () => {
    it("keeps a NEWER list another broker wrote instead of overwriting it with an older snapshot", async () => {
      const now = Date.now();
      const oldGithub = { tools: [{ name: "old_tool" }], learnedAt: now - 60_000 };
      // Broker A (started later) learned github and wrote it.
      await saveState(
        { learning: {}, packHistory: [], toolCache: { github: { tools: [{ name: "get_me" }], learnedAt: now } } },
        file,
      );
      // Broker B hydrated the old github list before that, then learned
      // fetch -- with its fingerprint -- and flushes.
      const fetch = { tools: [{ name: "fetch" }], learnedAt: now, configKey: "f1", serverVersion: "1.2.3" };
      expect(
        await brokerSave(
          file,
          { learning: {}, packHistory: [], toolCache: { github: oldGithub } },
          { learning: {}, packHistory: [], toolCache: { github: oldGithub, fetch } },
        ),
      ).toBe(true);
      const loaded = await loadState(file);
      expect(loaded.toolCache.github.tools).toEqual([{ name: "get_me" }]);
      expect(loaded.toolCache.fetch).toEqual(fetch);
    });

    it("saveState (not a broker) still replaces the cache: the caller owns the snapshot", async () => {
      const now = Date.now();
      await saveState(
        { learning: {}, packHistory: [], toolCache: { github: { tools: [{ name: "get_me" }], learnedAt: now } } },
        file,
      );
      await saveState({ learning: {}, packHistory: [], toolCache: {} }, file);
      expect((await loadState(file)).toolCache).toEqual({});
    });

    it("clears a failure on disk once any broker has learned the server since", async () => {
      const now = Date.now();
      await saveState(
        {
          learning: {},
          packHistory: [],
          prewarmFailures: { github: { failedAt: now - 5000, configKey: "k", message: "docker down" } },
        },
        file,
      );
      await brokerSave(
        file,
        { learning: {}, packHistory: [] },
        { learning: {}, packHistory: [], toolCache: { github: { tools: [{ name: "get_me" }], learnedAt: now } } },
      );
      const loaded = await loadState(file);
      expect(loaded.prewarmFailures).toBeUndefined();
      expect(loaded.toolCache.github.tools).toEqual([{ name: "get_me" }]);
    });

    it("lands a failure this broker recorded, but not one it only hydrated and another broker since cleared", async () => {
      const now = Date.now();
      const hydrated = { failedAt: now - 30_000, configKey: "k", message: "docker down" };
      const recorded = { failedAt: now, configKey: "k2", message: "no binary" };
      // The file no longer carries the github failure (another broker's save
      // dropped it); only this broker's stale copy remembers it.
      await saveState({ learning: {}, packHistory: [] }, file);
      await brokerSave(
        file,
        { learning: {}, packHistory: [], prewarmFailures: { github: hydrated } },
        { learning: {}, packHistory: [], prewarmFailures: { github: hydrated, fetch: recorded } },
      );
      expect((await loadState(file)).prewarmFailures).toEqual({ fetch: recorded });
    });

    it("a corrupt (unparseable) file is replaced by the broker's full view, hydrated failures included", async () => {
      writeFileSync(file, "{ not json");
      const now = Date.now();
      // The start-over branch has no baseline to subtract, so a failure this
      // broker only hydrated lands too -- the file carries nothing else.
      const hydrated = { failedAt: now - 30_000, configKey: "k", message: "docker down" };
      await brokerSave(
        file,
        { learning: {}, packHistory: [], prewarmFailures: { github: hydrated } },
        {
          learning: {},
          packHistory: [],
          toolCache: { a: { tools: [], learnedAt: now } },
          prewarmFailures: { github: hydrated },
        },
      );
      const loaded = await loadState(file);
      expect(loaded.toolCache).toEqual({ a: { tools: [], learnedAt: now } });
      expect(loaded.prewarmFailures).toEqual({ github: hydrated });
    });
  });

  it("mergePrewarmFailures: newer failure wins; a list learned at or after it supersedes it", () => {
    const merged = mergePrewarmFailures(
      { a: { failedAt: 10, configKey: "k2", message: "ours" } },
      { a: { failedAt: 5, configKey: "k1", message: "disk" }, b: { failedAt: 7, configKey: "k", message: "b" } },
      { b: { tools: [], learnedAt: 7 } },
    );
    expect(merged).toEqual({ a: { failedAt: 10, configKey: "k2", message: "ours" } });
  });
});
