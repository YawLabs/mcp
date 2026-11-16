import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStateClassified, STATE_SCHEMA_VERSION } from "../persistence.js";
import { parseGrade } from "../reward-grader.js";

// The three state shapes loadStateClassified refuses after a successful parse,
// each with the warn line it writes on the server surface (structured JSON).
const REFUSED_STATES: { name: string; body: string; msg: string; fileVersion?: number }[] = [
  { name: "top-level array", body: "[1,2,3]", msg: "yaw-mcp state file is not a JSON object; not read" },
  {
    name: "newer schema version",
    body: JSON.stringify({ version: STATE_SCHEMA_VERSION + 1, learning: {}, packHistory: [] }),
    msg: "yaw-mcp state file was written by a newer yaw-mcp; not read, and flagged so a save cannot overwrite it",
    fileVersion: STATE_SCHEMA_VERSION + 1,
  },
  {
    name: "version 0",
    body: JSON.stringify({ version: 0, learning: {}, packHistory: [] }),
    msg: "yaw-mcp state file has an unreadable schema version; not read",
    fileVersion: 0,
  },
];

describe("persistence.loadStateClassified: warn lines for a parsed but refused state file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-state-gaps-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes exactly one warn line per refused shape, worded for that shape", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const shape of REFUSED_STATES) {
        writeFileSync(file, shape.body, "utf8");
        spy.mockClear();
        await loadStateClassified(file);
        const lines = spy.mock.calls
          .map((c) => String(c[0]))
          .join("")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        expect(lines, shape.name).toHaveLength(1);
        const entry = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(entry.level, shape.name).toBe("warn");
        expect(entry.msg, shape.name).toBe(shape.msg);
        if (shape.fileVersion !== undefined) {
          expect(entry.fileVersion, shape.name).toBe(shape.fileVersion);
          expect(entry.reads, shape.name).toBe(STATE_SCHEMA_VERSION);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("quiet suppresses those three warn lines and returns the same classification", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const shape of REFUSED_STATES) {
        writeFileSync(file, shape.body, "utf8");
        spy.mockClear();
        const loud = await loadStateClassified(file);
        // The loud half proves the spy sees the line the quiet half must not produce.
        expect(spy, shape.name).toHaveBeenCalled();
        spy.mockClear();
        const quiet = await loadStateClassified(file, { quiet: true });
        expect(spy, shape.name).not.toHaveBeenCalled();
        expect(quiet, shape.name).toEqual(loud);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("reward-grader: parseGrade bare verdicts wrapped in markdown or quotes", () => {
  it("grades a bolded, blockquoted or quoted verdict word with no GRADE label", () => {
    expect(parseGrade("**Yes**, the list came back")).toBe(1.0);
    expect(parseGrade("The call returned an auth error.\n**No**")).toBe(0.0);
    expect(parseGrade("> Partial: half the rows")).toBe(0.5);
    expect(parseGrade('It returned an auth error, so the answer is "no".')).toBe(0.0);
  });

  it("still ignores a lowercase bolded word in the middle of a line", () => {
    expect(parseGrade("The call returned **no** errors")).toBeNull();
  });
});
