import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetComplianceWarningLatch, gradeRank, parseMinCompliance, passesMinCompliance } from "../compliance.js";
import { log } from "../logger.js";

// Hoisted file-wide, which also silences the warn lines every other case in
// this file provokes. Harmless: logger.ts exports nothing but `log`.
vi.mock("../logger.js", () => ({ log: vi.fn() }));

describe("gradeRank", () => {
  it("maps A-F to descending ranks", () => {
    expect(gradeRank("A")).toBe(4);
    expect(gradeRank("B")).toBe(3);
    expect(gradeRank("C")).toBe(2);
    expect(gradeRank("D")).toBe(1);
    expect(gradeRank("F")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(gradeRank("a")).toBe(4);
    expect(gradeRank("f")).toBe(0);
  });

  it("returns -1 for unknown or missing grades (ungraded)", () => {
    expect(gradeRank(undefined)).toBe(-1);
    expect(gradeRank(null)).toBe(-1);
    expect(gradeRank("")).toBe(-1);
    expect(gradeRank("Z")).toBe(-1);
    expect(gradeRank("E")).toBe(-1); // no E grade in A-F scale
  });
});

describe("parseMinCompliance", () => {
  beforeEach(() => {
    // One-shot warning latch resets between tests so each invalid-value
    // case exercises the warn path rather than silently passing on the
    // second run.
    __resetComplianceWarningLatch();
  });

  it("returns null when the env var is unset", () => {
    expect(parseMinCompliance(undefined)).toBeNull();
  });

  it("returns null when the env var is empty / whitespace", () => {
    expect(parseMinCompliance("")).toBeNull();
    expect(parseMinCompliance("   ")).toBeNull();
  });

  it("accepts every valid A-F grade", () => {
    expect(parseMinCompliance("A")).toBe("A");
    expect(parseMinCompliance("B")).toBe("B");
    expect(parseMinCompliance("C")).toBe("C");
    expect(parseMinCompliance("D")).toBe("D");
    expect(parseMinCompliance("F")).toBe("F");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseMinCompliance("a")).toBe("A");
    expect(parseMinCompliance(" b ")).toBe("B");
    expect(parseMinCompliance("c\n")).toBe("C");
  });

  it("returns null for invalid values (filter disabled, warning logged)", () => {
    expect(parseMinCompliance("Z")).toBeNull();
    expect(parseMinCompliance("AA")).toBeNull();
    expect(parseMinCompliance("9")).toBeNull();
    expect(parseMinCompliance("grade-a")).toBeNull();
  });
});

describe("passesMinCompliance", () => {
  it("returns true for every grade when the filter is null (disabled)", () => {
    expect(passesMinCompliance("A", null)).toBe(true);
    expect(passesMinCompliance("F", null)).toBe(true);
    expect(passesMinCompliance(undefined, null)).toBe(true);
    expect(passesMinCompliance("unknown", null)).toBe(true);
  });

  it("returns true for ungraded servers regardless of min (don't punish absent)", () => {
    expect(passesMinCompliance(undefined, "A")).toBe(true);
    expect(passesMinCompliance(null, "B")).toBe(true);
    expect(passesMinCompliance("", "F")).toBe(true);
    expect(passesMinCompliance("   ", "A")).toBe(true); // whitespace-only counts as ungraded
  });

  it("fails closed on unrecognized grade strings when a min is set", () => {
    __resetComplianceWarningLatch();
    expect(passesMinCompliance("Z", "A")).toBe(false);
    expect(passesMinCompliance("AAA", "A")).toBe(false);
    expect(passesMinCompliance("E", "F")).toBe(false); // no E in A-F scale
    expect(passesMinCompliance("grade-a", "A")).toBe(false);
  });

  it("unrecognized grade with no min set still passes (no gate to apply)", () => {
    __resetComplianceWarningLatch();
    expect(passesMinCompliance("Z", null)).toBe(true);
    expect(passesMinCompliance("AAA", null)).toBe(true);
  });

  it("passes when grade equals min (A passes min=A)", () => {
    expect(passesMinCompliance("A", "A")).toBe(true);
  });

  it("passes when grade exceeds min (A passes min=B)", () => {
    expect(passesMinCompliance("A", "B")).toBe(true);
    expect(passesMinCompliance("B", "C")).toBe(true);
    expect(passesMinCompliance("C", "D")).toBe(true);
    expect(passesMinCompliance("D", "F")).toBe(true);
  });

  it("fails when grade is below min (D fails min=B)", () => {
    expect(passesMinCompliance("D", "B")).toBe(false);
    expect(passesMinCompliance("C", "B")).toBe(false);
    expect(passesMinCompliance("F", "D")).toBe(false);
  });

  it("F fails every non-F minimum, passes only min=F", () => {
    expect(passesMinCompliance("F", "A")).toBe(false);
    expect(passesMinCompliance("F", "B")).toBe(false);
    expect(passesMinCompliance("F", "C")).toBe(false);
    expect(passesMinCompliance("F", "D")).toBe(false);
    expect(passesMinCompliance("F", "F")).toBe(true);
  });

  it("is case-insensitive on the server-reported grade", () => {
    expect(passesMinCompliance("a", "B")).toBe(true);
    expect(passesMinCompliance("d", "B")).toBe(false);
  });
});

// The two warn lines are the ONLY signal for a fail-open and a fail-closed
// decision, and nothing in the suite watched the logger: both branches and
// both one-shot latches could be deleted wholesale with every case above
// still green. Assertions are on the message AND the data payload, so a bare
// log() left behind after deleting a branch still fails.
//
// The latch cases live in their own describe on purpose: the beforeEach in
// `parseMinCompliance` above clears the latch before EVERY case, which would
// turn "a second call stays quiet" into an assertion of the opposite.
describe("compliance warning logging", () => {
  const logged = vi.mocked(log);

  beforeEach(() => {
    logged.mockClear();
    __resetComplianceWarningLatch();
  });

  it("warns once when YAW_MCP_MIN_COMPLIANCE is invalid, naming the value", () => {
    // Without this line an operator who typos the env var gets no refusals and
    // no clue why: the filter is silently OFF.
    expect(parseMinCompliance("b1")).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("warn", "Invalid YAW_MCP_MIN_COMPLIANCE; filter disabled", { value: "b1" });
  });

  it("stays quiet on a later invalid value in the same process", () => {
    // The latch is per-process, not per-value -- and it is NOT reset between
    // the two calls here, which is the behaviour under test.
    parseMinCompliance("Z");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockClear();
    parseMinCompliance("Q");
    expect(logged).not.toHaveBeenCalled();
  });

  it("never warns for a valid, empty or unset min", () => {
    expect(parseMinCompliance("a")).toBe("A");
    expect(parseMinCompliance(" b ")).toBe("B");
    expect(parseMinCompliance("")).toBeNull();
    expect(parseMinCompliance(undefined)).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });

  it("warns once per unrecognized server grade, naming the grade and the min", () => {
    // The only structured record of WHY a server was refused.
    expect(passesMinCompliance("Pass", "B")).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      "warn",
      "Unrecognized server compliance grade; failing closed under YAW_MCP_MIN_COMPLIANCE",
      { grade: "Pass", min: "B" },
    );

    // Same garbled grade again: one warn per value, not one per activate call.
    logged.mockClear();
    expect(passesMinCompliance("Pass", "B")).toBe(false);
    expect(logged).not.toHaveBeenCalled();

    // A DIFFERENT garbled grade is a different misconfiguration and gets its
    // own line -- the latch is a Set keyed on the raw string, not a boolean.
    expect(passesMinCompliance("AAA", "B")).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      "warn",
      "Unrecognized server compliance grade; failing closed under YAW_MCP_MIN_COMPLIANCE",
      { grade: "AAA", min: "B" },
    );
  });

  it("stays quiet when there is no gate to apply or the grade is fine", () => {
    expect(passesMinCompliance("Pass", null)).toBe(true); // no min -> no refusal to explain
    expect(passesMinCompliance(undefined, "A")).toBe(true); // ungraded passes
    expect(passesMinCompliance("   ", "A")).toBe(true);
    expect(passesMinCompliance("A", "B")).toBe(true);
    expect(passesMinCompliance("F", "A")).toBe(false); // a recognized grade below min is not a warn
    expect(logged).not.toHaveBeenCalled();
  });
});
