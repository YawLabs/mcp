import { describe, expect, it } from "vitest";
import {
  ACTIVATION_FAILURE_TTL_MS,
  activationFailureFactor,
  errorRateFactor,
  formatHealthWarning,
  healthFactor,
  scrubForWarning,
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

  it("stays silent for a nonzero error rate below WARN_RATE_FLOOR", () => {
    // 1 of 100 = 1% error, above the 3-call observation floor but below the
    // 10% WARN_RATE_FLOOR. Because totalCalls/errorCount never decay, a lone
    // old error in a large sample must NOT emit a permanent "N of last M
    // failed" line at a negligible penalty -- that would train the model to
    // skip a fine server. Reverting the gate at health-score.ts:88 to rate>0
    // would surface this line and fail the assertion.
    expect(formatHealthWarning({ totalCalls: 100, errorCount: 1, totalLatencyMs: 5 }, undefined)).toBeNull();
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

describe("formatHealthWarning -- credential scrubbing", () => {
  // error-category.ts refuses to print raw upstream text next to a category
  // because third-party MCP servers echo secrets in errors. This surface used
  // to contradict that by pasting up to 120 raw chars into discover output.
  it("redacts a query-string api_key but keeps the actionable rest", () => {
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 3,
        totalLatencyMs: 5,
        lastErrorMessage: "GET https://api.example.com/v1/x?api_key=abc123secretvalue&page=2 failed",
      },
      undefined,
    );
    expect(w).not.toContain("abc123secretvalue");
    expect(w).toContain("<redacted>");
    expect(w).toContain("api.example.com");
    expect(w).toContain("3 of last 10 calls failed");
  });

  it("redacts an Authorization header value, scheme word and all", () => {
    // Scheme-first ordering matters: with the name/value rule running first,
    // "Authorization" + ":" + "Bearer" matched, so the WORD Bearer was
    // redacted and the token itself survived.
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: "401 rejected Authorization: Bearer eyJhbGciOiJIUzI1NiJ9dEADbEEF",
      },
      undefined,
    );
    expect(w).not.toContain("eyJhbGciOiJIUzI1NiJ9dEADbEEF");
    expect(w).toContain("401 rejected");
  });

  it("redacts a bare vendor-prefixed key that carries no name", () => {
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: "config error: ghp_AbCdEf0123456789zzzz is not valid",
      },
      undefined,
    );
    expect(w).not.toContain("ghp_AbCdEf0123456789zzzz");
    expect(w).toContain("is not valid");
  });

  it("scrubs the ACTIVATION-failure excerpt on the same terms", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(undefined, { at: now - 60_000, message: "spawn failed: token=hunter2hunter2" }, now);
    expect(w).not.toContain("hunter2hunter2");
    expect(w).toContain("last activation failed");
    expect(w).toContain("<redacted>");
  });

  it("leaves an ordinary status/errno excerpt untouched", () => {
    // The excerpt earns its place -- "502 bad gateway" tells the model to try
    // elsewhere where a bare category would not. Over-scrubbing would be as
    // bad a regression as leaking.
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: "502 bad gateway (upstream unreachable)" },
      undefined,
    );
    expect(w).toBe("warn: 5 of last 10 calls failed: 502 bad gateway (upstream unreachable)");
  });

  it("does not mistake 'unauthorized' for a credential name", () => {
    // "auth" is a redacted key name, and "unauthorized: 401" would be gutted
    // by a rule that ignored word boundaries.
    expect(scrubForWarning("unauthorized: 401")).toBe("unauthorized: 401");
  });
});
