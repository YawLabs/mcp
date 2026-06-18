import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CachedGrade } from "../grades-cache.js";
import { gradesCachePath, readGradesCache, writeGrade } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write grades.json directly into the synthetic home dir. */
function writeGradesFile(home: string, content: string): void {
  const dir = join(home, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grades.json"), content, "utf8");
}

const VALID_ENTRY: CachedGrade = {
  grade: "A",
  score: 97.7,
  gradedAt: "2026-06-11T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-grades-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// gradesCachePath
// ---------------------------------------------------------------------------

describe("gradesCachePath", () => {
  it("returns <home>/.yaw-mcp/grades.json", () => {
    expect(gradesCachePath("/Users/test")).toBe(join("/Users/test", CONFIG_DIRNAME, "grades.json"));
  });
});

// ---------------------------------------------------------------------------
// readGradesCache
// ---------------------------------------------------------------------------

describe("readGradesCache -- ENOENT (first run)", () => {
  it("returns an empty map when grades.json does not exist", async () => {
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });
});

describe("readGradesCache -- valid file", () => {
  it("parses and returns entries from a well-formed grades.json", async () => {
    writeGradesFile(
      synthHome,
      JSON.stringify({
        ctxlint: VALID_ENTRY,
        github: { grade: "B", score: 83.0, gradedAt: "2026-06-10T12:00:00.000Z" },
      }),
    );

    const result = await readGradesCache(synthHome);
    expect(Object.keys(result).sort()).toEqual(["ctxlint", "github"]);
    expect(result.ctxlint).toEqual(VALID_ENTRY);
    expect(result.github).toEqual({ grade: "B", score: 83.0, gradedAt: "2026-06-10T12:00:00.000Z" });
  });

  it("drops individual entries that are malformed, preserving valid ones", async () => {
    writeGradesFile(
      synthHome,
      JSON.stringify({
        good: VALID_ENTRY,
        bad: { grade: "Z", score: 0, gradedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    const result = await readGradesCache(synthHome);
    expect(Object.keys(result)).toEqual(["good"]);
    expect(result.good).toEqual(VALID_ENTRY);
  });
});

describe("readGradesCache -- corrupt JSON", () => {
  it("returns an empty map when grades.json contains invalid JSON", async () => {
    writeGradesFile(synthHome, "{ this is not valid json !!");
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });

  it("returns an empty map when grades.json root is a non-object (e.g. array)", async () => {
    writeGradesFile(synthHome, JSON.stringify([{ grade: "A", score: 100, gradedAt: "2026-01-01T00:00:00.000Z" }]));
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateEntry (exercised through readGradesCache)
// ---------------------------------------------------------------------------

describe("validateEntry -- exercised via readGradesCache", () => {
  const cases: Array<{ label: string; entry: unknown }> = [
    { label: "missing grade", entry: { score: 90, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "invalid grade letter", entry: { grade: "E", score: 90, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "missing score", entry: { grade: "A", gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "non-finite score (NaN)", entry: { grade: "A", score: NaN, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "missing gradedAt", entry: { grade: "A", score: 90 } },
    { label: "empty gradedAt string", entry: { grade: "A", score: 90, gradedAt: "" } },
    { label: "null entry", entry: null },
    { label: "array entry", entry: [1, 2, 3] },
  ];

  for (const { label, entry } of cases) {
    it(`returns false (entry dropped) for: ${label}`, async () => {
      writeGradesFile(synthHome, JSON.stringify({ ns: entry }));
      const result = await readGradesCache(synthHome);
      expect(result).toEqual({});
    });
  }

  it("returns true (entry kept) for a valid entry with grade letter lowercased in JSON", async () => {
    // grade.toUpperCase() is applied inside validateEntry -- lowercase input should work
    writeGradesFile(synthHome, JSON.stringify({ ns: { grade: "b", score: 75, gradedAt: "2026-06-01T00:00:00.000Z" } }));
    const result = await readGradesCache(synthHome);
    expect(result.ns).toEqual({ grade: "B", score: 75, gradedAt: "2026-06-01T00:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// writeGrade
// ---------------------------------------------------------------------------

describe("writeGrade -- add new entry", () => {
  it("writes a new namespace entry to grades.json and returns the path", async () => {
    const path = await writeGrade("ctxlint", VALID_ENTRY, synthHome);

    expect(path).toBe(gradesCachePath(synthHome));

    const disk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(disk.ctxlint).toEqual(VALID_ENTRY);
  });

  it("adds to an existing cache without losing prior entries", async () => {
    const firstEntry: CachedGrade = { grade: "B", score: 80, gradedAt: "2026-06-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ existing: firstEntry }));

    await writeGrade("new-ns", VALID_ENTRY, synthHome);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.existing).toEqual(firstEntry);
    expect(disk["new-ns"]).toEqual(VALID_ENTRY);
  });

  it("overwrites an existing entry for the same namespace", async () => {
    const old: CachedGrade = { grade: "C", score: 70, gradedAt: "2026-01-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ ctxlint: old }));

    await writeGrade("ctxlint", VALID_ENTRY, synthHome);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.ctxlint).toEqual(VALID_ENTRY);
  });
});

describe("writeGrade -- concurrent writes (serialization)", () => {
  it("two simultaneous writeGrade calls do not lose either entry", async () => {
    const entryA: CachedGrade = { grade: "A", score: 99, gradedAt: "2026-06-11T00:00:00.000Z" };
    const entryB: CachedGrade = { grade: "B", score: 80, gradedAt: "2026-06-11T01:00:00.000Z" };

    // Fire both writes concurrently without await between them so they both
    // land on the chain before either read-modify-write starts.
    await Promise.all([writeGrade("ns-a", entryA, synthHome), writeGrade("ns-b", entryB, synthHome)]);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk["ns-a"]).toEqual(entryA);
    expect(disk["ns-b"]).toEqual(entryB);
  });

  it("concurrent writes to different namespaces preserve all pre-existing entries", async () => {
    const pre: CachedGrade = { grade: "C", score: 70, gradedAt: "2026-01-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ pre }));

    const newA: CachedGrade = { grade: "A", score: 95, gradedAt: "2026-06-11T02:00:00.000Z" };
    const newB: CachedGrade = { grade: "F", score: 42, gradedAt: "2026-06-11T03:00:00.000Z" };

    await Promise.all([writeGrade("new-a", newA, synthHome), writeGrade("new-b", newB, synthHome)]);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.pre).toEqual(pre);
    expect(disk["new-a"]).toEqual(newA);
    expect(disk["new-b"]).toEqual(newB);
  });
});
