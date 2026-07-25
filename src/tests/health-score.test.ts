import { describe, expect, it } from "vitest";
import {
  ACTIVATION_FAILURE_TTL_MS,
  activationFailureFactor,
  errorRateFactor,
  formatHealthWarning,
  healthFactor,
} from "../health-score.js";

describe("errorRateFactor", () => {
  it("returns 1.0 when health is undefined", () => {
    expect(errorRateFactor(undefined)).toBe(1.0);
  });

  it("returns 1.0 below the observation floor", () => {
    expect(errorRateFactor({ totalCalls: 2, errorCount: 2, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("returns 1.0 for perfect reliability", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("applies linear penalty for low error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 1, totalLatencyMs: 0 })).toBeCloseTo(0.9);
  });

  it("floors at 0.5 for high error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 8, totalLatencyMs: 0 })).toBe(0.5);
    expect(errorRateFactor({ totalCalls: 10, errorCount: 10, totalLatencyMs: 0 })).toBe(0.5);
  });
});

describe("activationFailureFactor", () => {
  it("returns 1.0 when no failure", () => {
    expect(activationFailureFactor(undefined)).toBe(1.0);
  });

  it("returns 0.5 for a recent failure", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - 1000, message: "boom" }, now)).toBe(0.5);
  });

  it("returns 1.0 for a stale failure past the TTL", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - ACTIVATION_FAILURE_TTL_MS - 1, message: "boom" }, now)).toBe(1.0);
  });
});

describe("healthFactor", () => {
  it("returns 1.0 when both signals are clean", () => {
    expect(healthFactor({ totalCalls: 5, errorCount: 0, totalLatencyMs: 10 }, undefined)).toBe(1.0);
  });

  it("takes the strictest penalty", () => {
    const now = 1_000_000;
    // 50% error rate = 0.5 factor; recent activation failure also 0.5.
    expect(healthFactor({ totalCalls: 10, errorCount: 5, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });

  it("picks the worse of two signals", () => {
    const now = 1_000_000;
    // Healthy history but recent activation failure should still penalize.
    expect(healthFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });
});

describe("formatHealthWarning", () => {
  it("returns null when both signals are clean", () => {
    expect(formatHealthWarning(undefined, undefined)).toBeNull();
    expect(formatHealthWarning({ totalCalls: 0, errorCount: 0, totalLatencyMs: 0 }, undefined)).toBeNull();
    expect(formatHealthWarning({ totalCalls: 10, errorCount: 0, totalLatencyMs: 5 }, undefined)).toBeNull();
  });

  it("hides low-sample error rates to avoid over-fitting to one flake", () => {
    // 2/2 is 100% fail — but below the 3-call observation floor. Silent.
    expect(formatHealthWarning({ totalCalls: 2, errorCount: 2, totalLatencyMs: 5 }, undefined)).toBeNull();
  });

  it("surfaces a sub-30% nonzero error rate so the ranking penalty isn't silent", () => {
    // 1 of 5 = 20% error, above the observation floor. errorRateFactor
    // down-ranks this (factor 0.8), so the health block must show it rather
    // than staying silent below the old 30% warn threshold.
    const w = formatHealthWarning({ totalCalls: 5, errorCount: 1, totalLatencyMs: 5 }, undefined);
    expect(w).toBe("warn: 1 of last 5 calls failed");
  });

  it("warns when the recent error rate clears 30%", () => {
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 3, totalLatencyMs: 5, lastErrorMessage: "503 Service Unavailable" },
      undefined,
    );
    expect(w).toBe("warn: 3 of last 10 calls failed: 503 Service Unavailable");
  });

  it("omits the tail message when there is no lastErrorMessage", () => {
    const w = formatHealthWarning({ totalCalls: 10, errorCount: 4, totalLatencyMs: 5 }, undefined);
    expect(w).toBe("warn: 4 of last 10 calls failed");
  });

  it("reports a recent activation failure in preference to error rate", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: "bad call" },
      { at: now - 90_000, message: "spawn ENOENT npx" },
      now,
    );
    // Activation failure (~2m old) takes priority over per-call rate.
    expect(w).toBe("warn: last activation failed 2m ago: spawn ENOENT npx");
  });

  it("skips a stale activation failure past the TTL", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(undefined, { at: now - ACTIVATION_FAILURE_TTL_MS - 1, message: "boom" }, now);
    expect(w).toBeNull();
  });

  it("collapses whitespace and truncates very long error messages", () => {
    const long = "x".repeat(500);
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: long },
      undefined,
    );
    // 120-char cap (117 + "...") on the tail, not on the warning prefix.
    expect(w).toContain("5 of last 10 calls failed");
    expect(w!.endsWith("...")).toBe(true);
    expect(w!.length).toBeLessThan("warn: 5 of last 10 calls failed: ".length + 125);
  });
});
