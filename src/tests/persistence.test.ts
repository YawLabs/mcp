import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningStore } from "../learning.js";
import { PackDetector } from "../pack-detect.js";
import {
  DISABLE_PERSISTENCE_ENV,
  emptyState,
  isPersistenceDisabled,
  isReadableStateVersion,
  loadState,
  loadStateClassified,
  STATE_SCHEMA_VERSION,
  saveState,
  TOOLCACHE_MAX_DESCRIPTION_CHARS,
  TOOLCACHE_MAX_NAMESPACES,
  TOOLCACHE_MAX_TOOLS_PER_NAMESPACE,
  TOOLCACHE_TTL_MS,
} from "../persistence.js";

describe("persistence.loadState", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty state when file does not exist", async () => {
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("flags loadFailed when the file EXISTS but cannot be read", async () => {
    // A directory at the state path makes readFile fail with EISDIR --
    // standing in for the transient EACCES/EBUSY handle class. The state
    // on disk is presumed healthy, so the caller must be told not to save
    // the empty stand-in over it: server.ts leaves persistenceReady false
    // when this flag is set.
    mkdirSync(file, { recursive: true });
    const s = await loadState(file);
    expect(s.loadFailed).toBe(true);
    expect(s.learning).toEqual({});
    expect(s.packHistory).toEqual([]);
  });

  it("does NOT flag loadFailed for a missing or unparseable file", async () => {
    // Missing: nothing on disk to protect.
    expect((await loadState(file)).loadFailed).toBeUndefined();
    // Unparseable: the file is genuinely unusable -- starting fresh (and
    // letting the next save replace it) is the documented behavior.
    writeFileSync(file, "not json at all", "utf8");
    expect((await loadState(file)).loadFailed).toBeUndefined();
  });

  it("does NOT flag loadFailed when a path component is a regular file", async () => {
    // POSIX reports this ENOTDIR; win32 reports ENOENT. Either way the
    // state file cannot exist -- there is nothing to protect, so it must
    // behave like a missing file (empty state, saves stay enabled),
    // matching the grades-cache/config-loader errno split.
    writeFileSync(join(dir, "blocker"), "i am a file", "utf8");
    const s = await loadState(join(dir, "blocker", "state.json"));
    expect(s).toEqual(emptyState());
    expect(s.loadFailed).toBeUndefined();
  });

  it("parses a valid state file", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 123,
      learning: { gh: { dispatched: 4, succeeded: 3, lastUsedAt: 100 } },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 101 }],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s.learning.gh).toEqual({ dispatched: 4, succeeded: 3, lastUsedAt: 100 });
    expect(s.packHistory).toHaveLength(1);
    expect(s.packHistory[0]).toEqual({ namespace: "gh", toolName: "listPrs", at: 101 });
  });

  it("parses a state file with a leading UTF-8 BOM (Notepad hand-edit)", async () => {
    // Regression: Notepad on Windows saves BOM-prefixed UTF-8, and
    // JSON.parse throws on the BOM -- without the strip in loadState, one
    // hand-edit dropped ALL learning, pack history, and tool cache via the
    // empty-state fallback.
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 123,
      learning: { gh: { dispatched: 4, succeeded: 3, lastUsedAt: 100 } },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 101 }],
    };
    writeFileSync(file, `\uFEFF${JSON.stringify(payload)}`, "utf8");
    const s = await loadState(file);
    expect(s.learning.gh).toEqual({ dispatched: 4, succeeded: 3, lastUsedAt: 100 });
    expect(s.packHistory).toHaveLength(1);
  });

  it("returns empty state on unparseable JSON", async () => {
    writeFileSync(file, "not json at all", "utf8");
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("drops state with a version mismatch", async () => {
    const payload = {
      version: 99,
      savedAt: 0,
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("sanitizes invalid learning entries", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {
        good: { dispatched: 2, succeeded: 1, lastUsedAt: 10 },
        badNegative: { dispatched: -1, succeeded: 0, lastUsedAt: 0 },
        badMissingField: { dispatched: 1, succeeded: 1 },
        badType: "not an object",
        "": { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
      },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(Object.keys(s.learning)).toEqual(["good"]);
  });

  it("sanitizeLearning rejects a JSON array outright, like sanitizeToolCache does", async () => {
    // Object.entries on an array yields "0"/"1" keys, so a hand-edited
    // `"learning": [...]` used to land as namespaces literally named 0 and 1 --
    // rows that can never match a real namespace but persist forever.
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: [
        { dispatched: 2, succeeded: 1, lastUsedAt: 10 },
        { dispatched: 5, succeeded: 5, lastUsedAt: 20 },
      ],
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s.learning).toEqual({});
  });

  it("sanitizeLearning rejects an entry with negative lastUsedAt", async () => {
    // persistence.ts sanitizeLearning: lastUsedAt < 0 must be rejected (dropped).
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {
        valid: { dispatched: 2, succeeded: 1, lastUsedAt: 10 },
        negLastUsed: { dispatched: 3, succeeded: 2, lastUsedAt: -1 },
      },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    // "valid" survives; "negLastUsed" is dropped.
    expect(s.learning.valid).toBeDefined();
    expect(s.learning.negLastUsed).toBeUndefined();
    expect(Object.keys(s.learning)).toEqual(["valid"]);
  });

  // Fix 3: succeeded must not exceed dispatched -- clamp on load.
  it("clamps succeeded to dispatched when succeeded > dispatched (fix 3)", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {
        // Corrupted/hand-edited entry: succeeded exceeds dispatched.
        overcount: { dispatched: 3, succeeded: 7, lastUsedAt: 10 },
        // Normal entry should be untouched.
        normal: { dispatched: 5, succeeded: 4, lastUsedAt: 20 },
        // Equal is fine.
        equal: { dispatched: 2, succeeded: 2, lastUsedAt: 30 },
      },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    // Overcount entry is kept but succeeded is clamped.
    expect(s.learning.overcount).toBeDefined();
    expect(s.learning.overcount.succeeded).toBe(3);
    expect(s.learning.overcount.dispatched).toBe(3);
    // Normal entry is unchanged.
    expect(s.learning.normal.succeeded).toBe(4);
    expect(s.learning.normal.dispatched).toBe(5);
    // Equal entry is unchanged.
    expect(s.learning.equal.succeeded).toBe(2);
    expect(s.learning.equal.dispatched).toBe(2);
  });

  // loadStateClassified is the ONE read+parse: loadState is a thin wrapper
  // over it, and the classification rides along so a reporting caller
  // (reset-learning) never has to open the file a second time with a
  // second, drift-prone parser.
  describe("loadStateClassified", () => {
    it("classifies a readable file as clean and returns the same state loadState does", async () => {
      const payload = {
        version: STATE_SCHEMA_VERSION,
        savedAt: 5,
        learning: { gh: { dispatched: 2, succeeded: 1, lastUsedAt: 7 } },
        packHistory: [],
        toolCache: {},
      };
      writeFileSync(file, JSON.stringify(payload), "utf8");
      const c = await loadStateClassified(file);
      expect(c.parsedCleanly).toBe(true);
      expect(c.state).toEqual(await loadState(file));
      expect(c.state.learning.gh.dispatched).toBe(2);
    });

    it("classifies a v1 file as clean (it migrates, so its counts are real)", async () => {
      writeFileSync(
        file,
        JSON.stringify({ version: 1, savedAt: 0, learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } } }),
        "utf8",
      );
      const c = await loadStateClassified(file);
      expect(c.parsedCleanly).toBe(true);
      expect(Object.keys(c.state.learning)).toEqual(["gh"]);
    });

    it("classifies a missing file as clean (empty state IS what is on disk)", async () => {
      const c = await loadStateClassified(join(dir, "absent.json"));
      expect(c.parsedCleanly).toBe(true);
      expect(c.state).toEqual(emptyState());
    });

    it("classifies malformed JSON, a non-object root, and an unreadable version as NOT clean", async () => {
      writeFileSync(file, "{ not json", "utf8");
      expect((await loadStateClassified(file)).parsedCleanly).toBe(false);

      writeFileSync(file, JSON.stringify([1, 2, 3]), "utf8");
      expect((await loadStateClassified(file)).parsedCleanly).toBe(false);

      writeFileSync(file, JSON.stringify({ version: 99, learning: {}, packHistory: [] }), "utf8");
      const c = await loadStateClassified(file);
      expect(c.parsedCleanly).toBe(false);
      expect(c.state).toEqual(emptyState());
    });

    it("reports rawCounts from the FILE, before the sanitizers drop anything", async () => {
      // What the file HELD, not what survived: reset-learning reports on
      // content it is about to delete, and the sanitized state would tell the
      // user "0 removed" about rows that were plainly there.
      writeFileSync(
        file,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION,
          savedAt: 0,
          learning: {
            gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
            handEdited: { dispatched: 1, succeeded: 1, lastUsedAt: -1 },
          },
          packHistory: [
            { namespace: "gh", toolName: "t", at: 1 },
            { namespace: "", toolName: "t", at: 2 },
          ],
          toolCache: { expired: { tools: [{ name: "t" }], learnedAt: Date.now() - TOOLCACHE_TTL_MS - 1000 } },
        }),
        "utf8",
      );
      const c = await loadStateClassified(file);
      expect(c.rawCounts).toEqual({ learning: 2, packHistory: 2, toolCache: 1 });
      // The sanitized state is the narrower view, and still is.
      expect(Object.keys(c.state.learning)).toEqual(["gh"]);
      expect(c.state.packHistory).toHaveLength(1);
      expect(c.state.toolCache).toEqual({});
    });

    it("reports all-zero rawCounts for a missing file and for one it could not parse", async () => {
      expect((await loadStateClassified(join(dir, "absent.json"))).rawCounts).toEqual({
        learning: 0,
        packHistory: 0,
        toolCache: 0,
      });
      writeFileSync(file, "{ not json", "utf8");
      expect((await loadStateClassified(file)).rawCounts).toEqual({ learning: 0, packHistory: 0, toolCache: 0 });
    });

    it("classifies a BOM-prefixed file as clean, matching loadState's own strip", async () => {
      // Built, never hand-typed: U+FEFF as a fixture escape is exactly the
      // shape that drifted the old separate peek away from the loader.
      const BOM = String.fromCharCode(0xfeff);
      writeFileSync(
        file,
        `${BOM}${JSON.stringify({
          version: STATE_SCHEMA_VERSION,
          savedAt: 0,
          learning: { gh: { dispatched: 3, succeeded: 3, lastUsedAt: 1 } },
          packHistory: [],
          toolCache: {},
        })}`,
        "utf8",
      );
      const c = await loadStateClassified(file);
      expect(c.parsedCleanly).toBe(true);
      expect(c.state.learning.gh.dispatched).toBe(3);
    });
  });

  it("sanitizes invalid pack history entries", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {},
      packHistory: [
        { namespace: "gh", toolName: "listPrs", at: 1 },
        { namespace: "", toolName: "x", at: 2 },
        { namespace: "y", toolName: "", at: 3 },
        { namespace: "z", toolName: "fn", at: "bad" },
        "not an object",
      ],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s.packHistory).toHaveLength(1);
    expect(s.packHistory[0].namespace).toBe("gh");
  });
});

// Schema v2 added `toolCache`. The bump is purely additive, so a v1 file is
// MIGRATED (learning + pack signal kept, cache starts empty) rather than
// discarded -- an unreadable version is still dropped wholesale.
describe("persistence state schema v1 -> v2 migration", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("current schema version is 2", () => {
    expect(STATE_SCHEMA_VERSION).toBe(2);
  });

  it("isReadableStateVersion accepts v1 and v2 only", () => {
    expect(isReadableStateVersion(1)).toBe(true);
    expect(isReadableStateVersion(2)).toBe(true);
    expect(isReadableStateVersion(3)).toBe(false);
    expect(isReadableStateVersion(0)).toBe(false);
    expect(isReadableStateVersion("2")).toBe(false);
    expect(isReadableStateVersion(undefined)).toBe(false);
  });

  it("keeps learning + packHistory from a v1 file and reads the cache as empty", async () => {
    // A v1 file has no `toolCache` key at all.
    const v1 = {
      version: 1,
      savedAt: 42,
      learning: { gh: { dispatched: 4, succeeded: 3, lastUsedAt: 100 } },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 101 }],
    };
    writeFileSync(file, JSON.stringify(v1), "utf8");

    const s = await loadState(file);
    expect(s.learning.gh).toEqual({ dispatched: 4, succeeded: 3, lastUsedAt: 100 });
    expect(s.packHistory).toHaveLength(1);
    expect(s.toolCache).toEqual({});
    // Normalized to the current version so the next save writes v2.
    expect(s.version).toBe(STATE_SCHEMA_VERSION);
  });

  it("still drops a file whose version is not readable at all", async () => {
    const future = {
      version: STATE_SCHEMA_VERSION + 1,
      savedAt: 0,
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [],
      toolCache: {},
    };
    writeFileSync(file, JSON.stringify(future), "utf8");
    expect(await loadState(file)).toEqual(emptyState());
  });
});

describe("persistence tool cache", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeState(toolCache: unknown): void {
    writeFileSync(
      file,
      JSON.stringify({ version: STATE_SCHEMA_VERSION, savedAt: 0, learning: {}, packHistory: [], toolCache }),
      "utf8",
    );
  }

  it("round-trips a tool cache through save + load", async () => {
    const learnedAt = Date.now();
    await saveState(
      {
        learning: {},
        packHistory: [],
        toolCache: { gh: { tools: [{ name: "create_issue", description: "open an issue" }], learnedAt } },
      },
      file,
    );
    const loaded = await loadState(file);
    expect(loaded.toolCache.gh).toEqual({
      tools: [{ name: "create_issue", description: "open an issue" }],
      learnedAt,
    });
  });

  it("persists an empty cache when the caller omits toolCache", async () => {
    await saveState({ learning: {}, packHistory: [] }, file);
    expect(JSON.parse(readFileSync(file, "utf8")).toolCache).toEqual({});
  });

  it("drops malformed entries without losing the good ones", async () => {
    const learnedAt = Date.now();
    writeState({
      good: { tools: [{ name: "t" }], learnedAt },
      "": { tools: [{ name: "t" }], learnedAt },
      notAnObject: "nope",
      missingLearnedAt: { tools: [{ name: "t" }] },
      negativeLearnedAt: { tools: [{ name: "t" }], learnedAt: -1 },
      toolsNotArray: { tools: "t", learnedAt },
      // An entry whose tools all fail validation collapses to empty and is
      // dropped -- otherwise pre-warm would skip the server forever while
      // never surfacing a single tool.
      allToolsBad: { tools: [{ description: "no name" }, null, 7], learnedAt },
    });

    const loaded = await loadState(file);
    expect(Object.keys(loaded.toolCache)).toEqual(["good"]);
  });

  it("keeps a genuinely empty tool list but still drops one that only collapsed to empty", async () => {
    // The two are indistinguishable after validation, so the RAW length is
    // what separates them. A resources/prompts-only upstream really does
    // expose zero tools, and that is an observation worth persisting -- when
    // it was dropped, hasKnownTools never saw an answer and pre-warm
    // re-spawned the server on every session start. A corrupt entry whose
    // tools all failed validation is not that, and must still be re-learned.
    const learnedAt = Date.now();
    writeState({
      zeroToolServer: { tools: [], learnedAt },
      corrupt: { tools: [{ description: "no name" }, null, 7], learnedAt },
    });

    const loaded = await loadState(file);
    expect(Object.keys(loaded.toolCache)).toEqual(["zeroToolServer"]);
    expect(loaded.toolCache.zeroToolServer).toEqual({ tools: [], learnedAt });
  });

  it("round-trips a zero-tool entry through save, not just load", async () => {
    // The drop used to happen on BOTH paths, so a load-only fix would still
    // lose the entry on the next flush.
    const learnedAt = Date.now();
    await saveState({ learning: {}, packHistory: [], toolCache: { zeroToolServer: { tools: [], learnedAt } } }, file);
    const loaded = await loadState(file);
    expect(loaded.toolCache.zeroToolServer).toEqual({ tools: [], learnedAt });
  });

  it("expires entries older than the TTL but keeps fresh and future-stamped ones", async () => {
    const now = Date.now();
    writeState({
      fresh: { tools: [{ name: "t" }], learnedAt: now - 1000 },
      stale: { tools: [{ name: "t" }], learnedAt: now - TOOLCACHE_TTL_MS - 1000 },
      // Clock skew / hand-edited: a future stamp must not be treated as
      // expired (now - learnedAt is negative).
      future: { tools: [{ name: "t" }], learnedAt: now + 60_000 },
    });

    const loaded = await loadState(file);
    expect(Object.keys(loaded.toolCache).sort()).toEqual(["fresh", "future"]);
  });

  it("caps namespaces, keeping the most recently learned", async () => {
    const now = Date.now();
    const oversized: Record<string, unknown> = {};
    for (let i = 0; i < TOOLCACHE_MAX_NAMESPACES + 10; i++) {
      // Older index => older learnedAt, so the first 10 are the evictees.
      oversized[`ns${i}`] = { tools: [{ name: "t" }], learnedAt: now - (TOOLCACHE_MAX_NAMESPACES + 10 - i) * 1000 };
    }
    writeState(oversized);

    const loaded = await loadState(file);
    const kept = Object.keys(loaded.toolCache);
    expect(kept).toHaveLength(TOOLCACHE_MAX_NAMESPACES);
    expect(kept).toContain(`ns${TOOLCACHE_MAX_NAMESPACES + 9}`);
    expect(kept).not.toContain("ns0");
  });

  it("caps tools per namespace and truncates long descriptions", async () => {
    const tools = Array.from({ length: TOOLCACHE_MAX_TOOLS_PER_NAMESPACE + 5 }, (_, i) => ({
      name: `tool${i}`,
      description: "x".repeat(TOOLCACHE_MAX_DESCRIPTION_CHARS + 500),
    }));
    writeState({ gh: { tools, learnedAt: Date.now() } });

    const loaded = await loadState(file);
    expect(loaded.toolCache.gh.tools).toHaveLength(TOOLCACHE_MAX_TOOLS_PER_NAMESPACE);
    expect(loaded.toolCache.gh.tools[0].description).toHaveLength(TOOLCACHE_MAX_DESCRIPTION_CHARS);
  });

  it("enforces the caps on WRITE, not just on read", async () => {
    // A save must not put bytes on disk that a later load would trim -- the
    // point of the caps is bounding the file itself.
    const tools = Array.from({ length: TOOLCACHE_MAX_TOOLS_PER_NAMESPACE + 5 }, (_, i) => ({ name: `tool${i}` }));
    await saveState(
      {
        learning: {},
        packHistory: [],
        toolCache: {
          gh: { tools, learnedAt: Date.now() },
          expired: { tools: [{ name: "t" }], learnedAt: Date.now() - TOOLCACHE_TTL_MS - 1000 },
        },
      },
      file,
    );

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.toolCache.gh.tools).toHaveLength(TOOLCACHE_MAX_TOOLS_PER_NAMESPACE);
    expect(onDisk.toolCache.expired).toBeUndefined();
  });
});

describe("persistence.saveState", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-"));
    file = join(dir, "nested", "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the target directory recursively", async () => {
    await saveState({ learning: {}, packHistory: [] }, file);
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(STATE_SCHEMA_VERSION);
  });

  it("writes with the current schema version and a timestamp", async () => {
    const before = Date.now();
    await saveState({ learning: {}, packHistory: [] }, file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(STATE_SCHEMA_VERSION);
    expect(parsed.savedAt).toBeGreaterThanOrEqual(before);
  });

  it("round-trips learning + packHistory without loss", async () => {
    await saveState(
      {
        learning: { gh: { dispatched: 5, succeeded: 4, lastUsedAt: 200 } },
        packHistory: [
          { namespace: "gh", toolName: "listPrs", at: 1 },
          { namespace: "linear", toolName: "createIssue", at: 2 },
        ],
      },
      file,
    );
    const loaded = await loadState(file);
    expect(loaded.learning.gh).toEqual({ dispatched: 5, succeeded: 4, lastUsedAt: 200 });
    expect(loaded.packHistory).toHaveLength(2);
    expect(loaded.packHistory[0].namespace).toBe("gh");
    expect(loaded.packHistory[1].namespace).toBe("linear");
  });

  it("does NOT reject/throw when atomicWriteFile fails (best-effort swallow)", async () => {
    // Point saveState at a path whose parent is a regular file. The
    // underlying atomicWriteFile fails in its mkdir -p step with EEXIST
    // (recursive mkdir only swallows EEXIST for directories, not for a
    // regular file already sitting at that path). saveState must swallow
    // the error -- callers must never have an unhandled rejection from it.
    const blockingParent = join(dir, "block.txt");
    writeFileSync(blockingParent, "blocker", "utf8");
    const badPath = join(blockingParent, "state.json");
    await expect(saveState({ learning: {}, packHistory: [] }, badPath)).resolves.toBeUndefined();
  });

  it("serializes concurrent saves so the later call's data wins on disk", async () => {
    const stateA = {
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [{ namespace: "gh", toolName: "a", at: 1 }],
    };
    const stateB = {
      learning: { linear: { dispatched: 9, succeeded: 9, lastUsedAt: 99 } },
      packHistory: [{ namespace: "linear", toolName: "b", at: 99 }],
    };
    await Promise.all([saveState(stateA, file), saveState(stateB, file)]);
    const loaded = await loadState(file);
    expect(loaded.learning).toEqual(stateB.learning);
    expect(loaded.packHistory).toEqual(stateB.packHistory);
    expect(loaded.learning.gh).toBeUndefined();
  });
});

describe("LearningStore snapshot round-trip", () => {
  it("export then load reproduces usage", () => {
    const a = new LearningStore();
    a.recordDispatch("gh");
    a.recordSuccess("gh");
    a.recordDispatch("linear");
    const snapshot = a.exportSnapshot();

    const b = new LearningStore();
    b.loadSnapshot(snapshot);
    expect(b.get("gh")?.dispatched).toBe(1);
    expect(b.get("gh")?.succeeded).toBe(1);
    expect(b.get("linear")?.dispatched).toBe(1);
    expect(b.get("linear")?.succeeded).toBe(0);
  });

  it("loadSnapshot replaces prior state", () => {
    const s = new LearningStore();
    s.recordDispatch("old");
    s.loadSnapshot({ fresh: { dispatched: 2, succeeded: 1, lastUsedAt: 99 } });
    expect(s.get("old")).toBeUndefined();
    expect(s.get("fresh")?.succeeded).toBe(1);
  });
});

describe("PackDetector snapshot round-trip", () => {
  it("export then load reproduces history", () => {
    const a = new PackDetector();
    a.recordCall("gh", "listPrs", 1);
    a.recordCall("linear", "createIssue", 2);
    const snapshot = a.exportSnapshot();

    const b = new PackDetector();
    b.loadSnapshot(snapshot);
    expect(b.getHistory()).toHaveLength(2);
    expect(b.getHistory()[0]).toEqual({ namespace: "gh", toolName: "listPrs", at: 1 });
  });

  it("loadSnapshot honors maxHistory cap — drops oldest", () => {
    const d = new PackDetector({ maxHistory: 3 });
    const oversized = [
      { namespace: "a", toolName: "t", at: 1 },
      { namespace: "b", toolName: "t", at: 2 },
      { namespace: "c", toolName: "t", at: 3 },
      { namespace: "d", toolName: "t", at: 4 },
      { namespace: "e", toolName: "t", at: 5 },
    ];
    d.loadSnapshot(oversized);
    const hist = d.getHistory();
    expect(hist).toHaveLength(3);
    expect(hist[0].namespace).toBe("c");
    expect(hist[2].namespace).toBe("e");
  });

  it("exported snapshot is a defensive copy", () => {
    const d = new PackDetector();
    d.recordCall("gh", "t", 1);
    const snap = d.exportSnapshot();
    snap[0].namespace = "tampered";
    expect(d.getHistory()[0].namespace).toBe("gh");
  });
});

// sanitizeLearning rebuilds the map with plain assignment onto a fresh {},
// which drops a "__proto__" namespace (assignment hits Object.prototype's
// inherited setter) and leaves the map inheriting that entry's fields. Its
// own doc comment scopes it to salvaging corrupted/hand-edited state files,
// which is exactly where such a key comes from. See src/json-key.ts.
describe("persistence.loadState -- a __proto__ learning key", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-proto-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps it as an own property without touching the prototype", async () => {
    // Raw JSON text, not an object literal: `{ __proto__: ... }` in source
    // SETS the prototype rather than creating an own key -- the very bug
    // under test -- so a literal fixture would be empty and pass for the
    // wrong reason.
    writeFileSync(
      file,
      `{"version":${STATE_SCHEMA_VERSION},"savedAt":0,"learning":{"__proto__":{"dispatched":4,"succeeded":3,"lastUsedAt":100},"gh":{"dispatched":1,"succeeded":1,"lastUsedAt":1}}}`,
    );

    const s = await loadState(file);

    expect(Object.hasOwn(s.learning, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(s.learning)).toBe(Object.prototype);
    expect(s.learning.gh).toEqual({ dispatched: 1, succeeded: 1, lastUsedAt: 1 });
    expect(Object.keys(s.learning).sort()).toEqual(["__proto__", "gh"]);
    // Without the fix `learning` inherits the entry's fields, so a namespace
    // named "dispatched" resolves to a number instead of undefined.
    expect(s.learning.dispatched).toBeUndefined();
  });
});

describe("persistence.isPersistenceDisabled", () => {
  // The canonical YAW_MCP_DISABLE_PERSISTENCE predicate. server.ts, doctor and
  // reset-learning each carried their own copy until they were folded into
  // this one; the table is here so a change to the truthiness rule shows up as
  // one failing suite rather than as doctor reporting persistence ON while the
  // broker has it OFF.
  const cases: Array<[string | undefined, boolean]> = [
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["", false],
    [undefined, false],
    ["0", false],
    ["false", false],
    // Deliberately NOT accepted -- the point of one shared predicate is that
    // "yes"/"on" mean the same thing (nothing) everywhere, not that they get
    // added to one copy.
    ["yes", false],
    ["on", false],
    ["2", false],
  ];

  for (const [raw, want] of cases) {
    it(`${raw === undefined ? "(unset)" : JSON.stringify(raw)} -> ${want}`, () => {
      const env: NodeJS.ProcessEnv = raw === undefined ? {} : { YAW_MCP_DISABLE_PERSISTENCE: raw };
      expect(isPersistenceDisabled(env)).toBe(want);
    });
  }

  it("defaults to process.env, re-read on every call", () => {
    // The default argument is evaluated per call, which is what lets server.ts
    // drop its own process.env copy: a value exported after module load still
    // counts.
    delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
    expect(isPersistenceDisabled()).toBe(false);
    process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";
    try {
      expect(isPersistenceDisabled()).toBe(true);
    } finally {
      delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
    }
  });

  it("names the env var it reads", () => {
    expect(DISABLE_PERSISTENCE_ENV).toBe("YAW_MCP_DISABLE_PERSISTENCE");
  });
});
