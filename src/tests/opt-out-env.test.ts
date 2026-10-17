// The ONE opt-out parse every YAW_MCP_* background feature goes through.
// Pinned here once, so the per-feature suites (auto-upgrade, sidecar-refresh,
// server-prewarm-optout, server-start's CONFIG_RELOAD cases, heal-entries)
// only have to prove their feature CALLS it, not re-prove the spellings.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isFeatureDisabled, isFeatureEnabled, isTestSandbox, resolveNonNegativeIntEnv } from "../opt-out-env.js";

const NAME = "YAW_MCP_TEST_OPT_OUT";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isFeatureDisabled", () => {
  // The two documented off spellings, case-insensitively.
  it.each(["0", "false", "False", "FALSE"])("is off for %j", (value) => {
    expect(isFeatureDisabled(NAME, { [NAME]: value })).toBe(true);
  });

  // cmd.exe's `set VAR=0 && yaw-mcp serve` keeps the space before `&&`, so the
  // value arrives as "0 ". This is the case that used to split the copies:
  // an untrimmed check read it as "not an opt-out" and the feature ran --
  // silently, since the variable reads as set everywhere the user can look.
  it.each(["0 ", " 0", " false ", "\tFALSE\t"])("is off for the padded spelling %j", (value) => {
    expect(isFeatureDisabled(NAME, { [NAME]: value })).toBe(true);
  });

  // Near-misses stay ON, and so do the opt-IN spellings a user might reach for
  // by habit: an opt-out that engaged on anything vaguely zero-ish would turn
  // a typo into an invisible loss of the feature, which is the wrong
  // direction to fail in. "" is here too: a variable set to nothing is not a
  // request to turn anything off.
  it.each(["", " ", "1", "true", "yes", "on", "00", "0abc", "no", "off", "disable"])("stays on for %j", (value) => {
    expect(isFeatureDisabled(NAME, { [NAME]: value })).toBe(false);
  });

  it("stays on when the variable is not set at all", () => {
    expect(isFeatureDisabled(NAME, {})).toBe(false);
  });

  it("reads process.env when no environment is injected", () => {
    // The readers that have no injected env (server.ts, auto-upgrade.ts) lean
    // on this default; doctor threads its own, which the cases above cover.
    vi.stubEnv(NAME, "0");
    expect(isFeatureDisabled(NAME)).toBe(true);
    vi.stubEnv(NAME, "1");
    expect(isFeatureDisabled(NAME)).toBe(false);
  });

  it("reads ONLY the injected environment when one is given", () => {
    // An injected env must not fall through to process.env: doctor's whole
    // point in passing one is to answer for THAT environment.
    vi.stubEnv(NAME, "0");
    expect(isFeatureDisabled(NAME, {})).toBe(false);
    expect(isFeatureDisabled(NAME, { [NAME]: "1" })).toBe(false);
  });

  it("looks at the named variable and no other", () => {
    expect(isFeatureDisabled(NAME, { YAW_MCP_OTHER: "0" })).toBe(false);
  });
});

describe("isFeatureEnabled", () => {
  // The two documented on spellings, any case, padded or not (cmd.exe's
  // `set VAR=1 && ...` delivers "1 ").
  it.each(["1", "true", "TRUE", "True", "1 ", " true ", "\t1\t"])("is on for %j", (value) => {
    expect(isFeatureEnabled(NAME, { [NAME]: value })).toBe(true);
  });

  // Everything else fails CLOSED, the right direction for an opt-in.
  it.each(["", " ", "0", "false", "yes", "on", "11", "1abc", "tru"])("is off for %j", (value) => {
    expect(isFeatureEnabled(NAME, { [NAME]: value })).toBe(false);
  });

  it("is off when unset, and defaults to process.env", () => {
    expect(isFeatureEnabled(NAME, {})).toBe(false);
    vi.stubEnv(NAME, "1");
    expect(isFeatureEnabled(NAME)).toBe(true);
  });
});

describe("resolveNonNegativeIntEnv", () => {
  it.each([
    ["0", 0],
    ["7", 7],
    [" 12 ", 12],
    ["100000", 100_000],
  ])("parses the digit run %j", (value, expected) => {
    expect(resolveNonNegativeIntEnv(NAME, 6, { [NAME]: value })).toBe(expected);
  });

  // parseInt would read every one of these as a prefix -- 0 (the disable
  // sentinel for the caps) or 1 -- instead of falling back.
  it.each([
    "",
    " ",
    "0x10",
    "0.5",
    "0abc",
    "1e2",
    "100_000",
    "-1",
    "+5",
    "abc",
  ])("falls back to the default for %j", (value) => {
    expect(resolveNonNegativeIntEnv(NAME, 6, { [NAME]: value })).toBe(6);
  });

  it("falls back when unset, and for a run too long to be finite", () => {
    expect(resolveNonNegativeIntEnv(NAME, 6, {})).toBe(6);
    expect(resolveNonNegativeIntEnv(NAME, 6, { [NAME]: "9".repeat(400) })).toBe(6);
  });

  it("rejects a value under `min` to the default", () => {
    expect(resolveNonNegativeIntEnv(NAME, 10, { [NAME]: "0" }, 1)).toBe(10);
    expect(resolveNonNegativeIntEnv(NAME, 10, { [NAME]: "1" }, 1)).toBe(1);
  });
});

describe("isTestSandbox", () => {
  // The ONE reader of VITEST. Every default that would touch the machine
  // (registry, lock, memos, npm) gates on it; the per-feature suites prove
  // their defaults call it, this proves what it says.
  it("is true for any non-empty value -- vitest exports `true`, but the spelling is not the contract", () => {
    expect(isTestSandbox({ VITEST: "true" })).toBe(true);
    expect(isTestSandbox({ VITEST: "1" })).toBe(true);
    expect(isTestSandbox({ VITEST: "anything" })).toBe(true);
  });

  it("is false when unset or empty", () => {
    expect(isTestSandbox({})).toBe(false);
    expect(isTestSandbox({ VITEST: "" })).toBe(false);
  });

  it("reads process.env when no environment is injected -- and this suite IS one", () => {
    expect(isTestSandbox()).toBe(true);
    vi.stubEnv("VITEST", "");
    expect(isTestSandbox()).toBe(false);
  });
});
