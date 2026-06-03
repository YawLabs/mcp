import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NAG_ELIGIBLE_SUBCOMMANDS,
  NAG_STATE_FILENAME,
  emptyNagState,
  evaluateNag,
  loadNagState,
  nagStatePath,
  pickThreshold,
  recordTouchPoint,
  saveNagState,
  showNagInterstitial,
} from "../nag.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-nag-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function pathFor(home: string): string {
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  return join(home, CONFIG_DIRNAME, NAG_STATE_FILENAME);
}

describe("NAG_ELIGIBLE_SUBCOMMANDS", () => {
  it("contains the documented human-driven subcommands", () => {
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("install")).toBe(true);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("doctor")).toBe(true);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("servers")).toBe(true);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("bundles")).toBe(true);
  });

  it("excludes the bare server invocation, help, and version", () => {
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("")).toBe(false);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("help")).toBe(false);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("--help")).toBe(false);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("-h")).toBe(false);
    expect(NAG_ELIGIBLE_SUBCOMMANDS.has("--version")).toBe(false);
  });
});

describe("pickThreshold", () => {
  it("returns values in [2, 4] inclusive", () => {
    expect(pickThreshold(() => 0)).toBe(2);
    expect(pickThreshold(() => 0.5)).toBe(3);
    expect(pickThreshold(() => 0.999)).toBe(4);
  });
});

describe("evaluateNag", () => {
  const farPast = 0; // never shown
  const recent = Date.now(); // just shown

  it("does not fire on the first touch when threshold is 2", () => {
    const state = { touchPoints: 0, nextThreshold: 2, lastShownAt: farPast };
    const r = evaluateNag(state, Date.now(), () => 0);
    expect(r.show).toBe(false);
    expect(r.next.touchPoints).toBe(1);
  });

  it("fires on the second touch when threshold is 2 and floor is clear", () => {
    const state = { touchPoints: 1, nextThreshold: 2, lastShownAt: farPast };
    const r = evaluateNag(state, Date.now(), () => 0);
    expect(r.show).toBe(true);
    expect(r.next.touchPoints).toBe(0);
    expect(r.next.lastShownAt).toBeGreaterThan(0);
  });

  it("does not fire while floor is active, but bumps counter to threshold", () => {
    const state = { touchPoints: 1, nextThreshold: 2, lastShownAt: recent };
    const r = evaluateNag(state, recent + 1_000, () => 0);
    expect(r.show).toBe(false);
    // Counter held at threshold so the next touch re-checks floor cleanly.
    expect(r.next.touchPoints).toBe(2);
    expect(r.next.lastShownAt).toBe(recent);
  });

  it("does not accumulate debt across blocked floor period", () => {
    let state = { touchPoints: 2, nextThreshold: 2, lastShownAt: recent };
    // Multiple touches during the floor period -- each is blocked but the
    // counter stays at threshold, not 10.
    for (let i = 0; i < 10; i++) {
      const r = evaluateNag(state, recent + 60_000, () => 0);
      expect(r.show).toBe(false);
      expect(r.next.touchPoints).toBe(2);
      state = r.next;
    }
  });

  it("fires immediately when the floor lifts AND threshold is satisfied", () => {
    const state = { touchPoints: 2, nextThreshold: 2, lastShownAt: 1_000 };
    // Now is 2 days later -- floor (1.5 days) has lifted.
    const now = 1_000 + 2 * 24 * 60 * 60 * 1000;
    const r = evaluateNag(state, now, () => 0);
    expect(r.show).toBe(true);
    expect(r.next.lastShownAt).toBe(now);
  });

  it("randomizes the next threshold after firing", () => {
    const state = { touchPoints: 1, nextThreshold: 2, lastShownAt: 0 };
    const r1 = evaluateNag(state, Date.now(), () => 0);
    const r2 = evaluateNag(state, Date.now(), () => 0.5);
    const r3 = evaluateNag(state, Date.now(), () => 0.999);
    expect(r1.next.nextThreshold).toBe(2);
    expect(r2.next.nextThreshold).toBe(3);
    expect(r3.next.nextThreshold).toBe(4);
  });
});

describe("loadNagState", () => {
  it("returns empty state when file does not exist", async () => {
    const state = await loadNagState(join(synthHome, "nonexistent.json"));
    expect(state).toEqual(emptyNagState());
  });

  it("returns empty state when JSON is corrupt", async () => {
    const p = pathFor(synthHome);
    writeFileSync(p, "{not json");
    const state = await loadNagState(p);
    expect(state).toEqual(emptyNagState());
  });

  it("returns empty state when root is not an object", async () => {
    const p = pathFor(synthHome);
    writeFileSync(p, "[]");
    const state = await loadNagState(p);
    expect(state).toEqual(emptyNagState());
  });

  it("clamps invalid fields to defaults", async () => {
    const p = pathFor(synthHome);
    writeFileSync(p, JSON.stringify({ touchPoints: -1, nextThreshold: 99, lastShownAt: -5 }));
    const state = await loadNagState(p);
    // touchPoints -1 -> 0; nextThreshold > MAX (4) -> clamped to 4; lastShownAt < 0 -> 0
    expect(state.touchPoints).toBe(0);
    expect(state.nextThreshold).toBe(4);
    expect(state.lastShownAt).toBe(0);
  });

  it("clamps nextThreshold below MIN to MIN", async () => {
    const p = pathFor(synthHome);
    writeFileSync(p, JSON.stringify({ touchPoints: 0, nextThreshold: 1, lastShownAt: 0 }));
    const state = await loadNagState(p);
    expect(state.nextThreshold).toBe(2);
  });
});

describe("saveNagState + round-trip", () => {
  it("persists state and reads it back unchanged", async () => {
    const p = pathFor(synthHome);
    const original = { touchPoints: 1, nextThreshold: 3, lastShownAt: 1700000000000 };
    await saveNagState(original, p);
    const round = await loadNagState(p);
    expect(round).toEqual(original);
  });

  it("saveNagState never throws even when the directory is missing", async () => {
    const p = join(synthHome, "no", "such", "dir", "nag.json");
    // Should not throw.
    await expect(saveNagState({ touchPoints: 0, nextThreshold: 2, lastShownAt: 0 }, p)).resolves.toBeUndefined();
  });
});

describe("recordTouchPoint", () => {
  it("persists the bumped counter on a no-show decision", async () => {
    const p = pathFor(synthHome);
    const r = await recordTouchPoint({ filePath: p, now: Date.now(), random: () => 0 });
    expect(r.show).toBe(false);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.touchPoints).toBe(1);
  });

  it("persists the reset state BEFORE the prompt could be dismissed", async () => {
    const p = pathFor(synthHome);
    // Seed with state that will fire on the next touch.
    await saveNagState({ touchPoints: 1, nextThreshold: 2, lastShownAt: 0 }, p);
    const r = await recordTouchPoint({ filePath: p, now: Date.now(), random: () => 0 });
    expect(r.show).toBe(true);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.touchPoints).toBe(0);
    expect(after.lastShownAt).toBeGreaterThan(0);
  });
});

describe("showNagInterstitial", () => {
  it("is a no-op when not a TTY", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let written = "";
    stdout.on("data", (chunk) => {
      written += chunk.toString();
    });
    await showNagInterstitial({ stdout, stdin, isTTY: false });
    expect(written).toBe("");
  });

  it("renders the box and resolves on Enter when TTY", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let written = "";
    stdout.on("data", (chunk) => {
      written += chunk.toString();
    });
    const p = showNagInterstitial({ stdout, stdin, isTTY: true });
    // Microtask hop so the interstitial writes + attaches the listener
    // before we push the keypress.
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write("\n");
    await p;
    expect(written).toContain("Yaw MCP");
    expect(written).toContain("free");
    expect(written).toContain("Yaw Team");
    expect(written).toContain("https://yaw.sh/mcp");
  });
});

describe("nagStatePath", () => {
  it("places the state file inside ~/.yaw-mcp", () => {
    expect(nagStatePath("/home/jeff")).toMatch(/[/\\]\.yaw-mcp[/\\]nag-state\.json$/);
  });
});
