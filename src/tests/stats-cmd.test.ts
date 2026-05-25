import { describe, expect, it } from "vitest";
import { STATS_USAGE, parseStatsArgs } from "../stats-cmd.js";

describe("parseStatsArgs", () => {
  it("defaults to no flags", () => {
    const r = parseStatsArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.limit).toBeUndefined();
      expect(r.options.days).toBeUndefined();
      expect(r.options.json).toBeUndefined();
    }
  });

  it("accepts --limit <n>", () => {
    const r = parseStatsArgs(["--limit", "20"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.limit).toBe(20);
  });

  it("rejects non-numeric --limit", () => {
    const r = parseStatsArgs(["--limit", "huge"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--limit must be a positive integer/);
  });

  it("rejects --limit above 1000", () => {
    const r = parseStatsArgs(["--limit", "5000"]);
    expect(r.ok).toBe(false);
  });

  it("accepts --days <n>", () => {
    const r = parseStatsArgs(["--days", "30"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.days).toBe(30);
  });

  it("rejects --days above 365", () => {
    const r = parseStatsArgs(["--days", "999"]);
    expect(r.ok).toBe(false);
  });

  it("accepts --json", () => {
    const r = parseStatsArgs(["--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("combines flags", () => {
    const r = parseStatsArgs(["--limit", "10", "--days", "14", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.limit).toBe(10);
      expect(r.options.days).toBe(14);
      expect(r.options.json).toBe(true);
    }
  });

  it("rejects unknown args", () => {
    const r = parseStatsArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "--bogus"/);
  });

  it("--help returns usage", () => {
    const r = parseStatsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(STATS_USAGE);
  });
});
