import { describe, expect, it } from "vitest";
import { formatPlain, parseStatsArgs, STATS_USAGE } from "../stats-cmd.js";
import type { AnalyticsEvent } from "../team-sync.js";

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

  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseStatsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(STATS_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseStatsArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });
});

function makeEvent(ts: number): AnalyticsEvent {
  return {
    ts,
    seat_email: "test@example.com",
    tool_namespace: "gh",
    tool_name: "list_issues",
    status: "success",
    latency_ms: 42,
    client_name: "claude-code",
    client_version: "1.0.0",
  };
}

describe("formatPlain -- showing count respects --limit", () => {
  it("shows full count when events <= limit (default 50)", () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, {}, "ord-123", 5);
    // 5 events, default limit 50 -> renderedCount = min(5, 50) = 5
    expect(out).toMatch(/^Showing 5 of 5 events/m);
  });

  it("shows limit count when events > limit", () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, { limit: 10 }, "ord-123", 100);
    // 100 events, limit 10 -> renderedCount = min(100, 10) = 10
    expect(out).toMatch(/^Showing 10 of 100 events/m);
  });

  it("default limit 50 caps rendering when events > 50", () => {
    const events = Array.from({ length: 80 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, {}, "ord-123", 80);
    // 80 events, default limit 50 -> renderedCount = min(80, 50) = 50
    expect(out).toMatch(/^Showing 50 of 80 events/m);
  });

  it("default window pluralizes 'days' correctly (days defaults to 7)", () => {
    const events = Array.from({ length: 3 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, {}, "ord-123", 3);
    expect(out).toMatch(/from the last 7 days\./m);
  });

  it("singular 'day' when --days 1", () => {
    const events = Array.from({ length: 3 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, { days: 1 }, "ord-123", 3);
    expect(out).toMatch(/from the last 1 day\./m);
  });
});

describe("formatPlain -- aggregate-vs-recent caveat surfaces in plain output", () => {
  it("notes that Recent is capped while By-server spans the full window when events > limit", () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, { limit: 10 }, "ord-123", 100);
    expect(out).toMatch(/Recent events \(newest first, capped at --limit; By-server/);
    expect(out).toMatch(/span the full window/);
  });

  it("uses the plain Recent header (no caveat) when all events fit under the limit", () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(1_000_000 + i));
    const out = formatPlain(events, {}, "ord-123", 5);
    expect(out).toMatch(/^Recent events \(newest first\):$/m);
    expect(out).not.toMatch(/capped at --limit/);
  });
});
