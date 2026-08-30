// The probe's DEBUG diagnostic for an oam whose --version says nothing
// parsable.
//
// Its own file for the same reason oam-pin-notice-debug.test.ts has one: the
// level has to be raised before oam-spawn's import graph is built, and a
// static import would pull logger.js in during hoisting -- i.e. before any
// statement in the file runs. (logger.js reads LOG_LEVEL per call today, but
// setting it before the import is correct either way, and this file must not
// depend on which of the two the logger is doing.)

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Set BEFORE the dynamic import below.
const priorLogLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "debug";

const { MIN_OAM_VERSION, probeOam, resetOamBinCache } = await import("../oam-spawn.js");

// Put it back: vitest gives each FILE a fresh module registry, not a fresh
// process.env, so a worker reused for a later file would otherwise inherit
// debug -- and sibling files assert that certain notices stay SILENT.
afterAll(() => {
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

/** Every log line written while `fn` runs. */
async function captureLines(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("probeOam version-gate diagnostics", () => {
  beforeEach(() => resetOamBinCache());

  it("says so when a clean probe produced no version to gate on", async () => {
    // The probe only pipes stdout, so an oam that prints its version to
    // stderr exits 0 with nothing parsable -- which is treated as usable
    // (a working --version proves oam exists). The consequence is invisible:
    // the below-min branch is guarded on `version !== null`, so the
    // MIN_OAM_VERSION gate never ran for this binary, and the old-build hangs
    // it guards read as server bugs with nothing anywhere to connect them.
    const lines = await captureLines(() => probeOam(async () => "oam, the runtime\n"));
    const note = lines.find((l) => String(l.msg ?? "").includes("no parsable version"));
    expect(note, "a clean probe with no version said nothing at all").toBeDefined();
    // Debug, not warn: the binary works. This is context for a hang, not
    // something the user has to act on.
    expect(note?.level).toBe("debug");
    expect(note?.minVersion).toBe(MIN_OAM_VERSION);
  });

  it("stays quiet when the probe DID produce a version", async () => {
    // The gate ran, so there is nothing to report -- and a line per probe on
    // every working setup would be noise in the one log a hang is diagnosed
    // from.
    const lines = await captureLines(() => probeOam(async () => `oam ${MIN_OAM_VERSION}\n`));
    expect(lines.filter((l) => String(l.msg ?? "").includes("no parsable version"))).toEqual([]);
  });
});
