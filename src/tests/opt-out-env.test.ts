// The ONE opt-out parse every YAW_MCP_* background feature goes through.
// Pinned here once, so the per-feature suites (auto-upgrade, sidecar-refresh,
// server-prewarm-optout, server-start's CONFIG_RELOAD cases, heal-entries)
// only have to prove their feature CALLS it, not re-prove the spellings.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isFeatureDisabled } from "../opt-out-env.js";

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
