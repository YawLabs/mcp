import { describe, expect, it } from "vitest";
import { FLAG_ALIASES, KNOWN_SUBCOMMANDS, suggestFlag, suggestSubcommand } from "../subcommands.js";

// The dispatcher in index.ts runs at import time (top-level side effects),
// so it cannot be imported directly. The did-you-mean logic it uses lives
// in the side-effect-free ./subcommands.js helpers, which we test here.

describe("suggestSubcommand", () => {
  it("suggests a close subcommand for a bare typo", () => {
    expect(suggestSubcommand("instal")).toContain("install");
  });

  it("keeps `help` in the pool (halp -> help)", () => {
    // Regression: index.ts used to filter `help` out of the suggestion
    // pool, so `yaw-mcp halp` could never suggest `help`.
    expect(suggestSubcommand("halp")).toContain("help");
  });

  it("never suggests a leading-dash flag alias", () => {
    // Bare typos should only suggest real subcommands, not --help/-V etc.
    for (const input of ["versio", "hepl", "instal"]) {
      for (const s of suggestSubcommand(input)) {
        expect(s.startsWith("-")).toBe(false);
      }
    }
  });

  it("returns [] for a wild non-match", () => {
    expect(suggestSubcommand("zzzzzzzzzz")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(suggestSubcommand("set", 1).length).toBeLessThanOrEqual(1);
  });
});

describe("suggestFlag", () => {
  it("suggests --version for a long typo like --versionn", () => {
    expect(suggestFlag("--versionn")).toContain("--version");
  });

  it("suggests --help for --hepl", () => {
    expect(suggestFlag("--hepl")).toContain("--help");
  });

  it("returns only known flag aliases", () => {
    const aliases = [...FLAG_ALIASES];
    for (const s of suggestFlag("--versionn")) {
      expect(aliases).toContain(s);
    }
  });

  it("passes through short single-letter flags (no hijack of -v as -V)", () => {
    // A genuine server flag `-v` must NOT be intercepted by a case-only
    // match against `-V`; length-gating keeps short flags falling through.
    expect(suggestFlag("-v")).toEqual([]);
    expect(suggestFlag("-x")).toEqual([]);
  });

  it("passes through genuine long server flags with no close match", () => {
    expect(suggestFlag("--verbose")).toEqual([]);
    expect(suggestFlag("--config")).toEqual([]);
  });
});

describe("KNOWN_SUBCOMMANDS table", () => {
  it("includes foundry (dispatched in index.ts)", () => {
    expect(KNOWN_SUBCOMMANDS).toContain("foundry");
  });

  it("ends with the flag aliases", () => {
    for (const f of FLAG_ALIASES) {
      expect(KNOWN_SUBCOMMANDS).toContain(f);
    }
  });
});
