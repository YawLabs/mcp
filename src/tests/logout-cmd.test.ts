import { describe, expect, it } from "vitest";
import { LOGOUT_USAGE, parseLogoutArgs } from "../logout-cmd.js";

describe("parseLogoutArgs", () => {
  it("defaults to no flags", () => {
    const r = parseLogoutArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBeUndefined();
  });

  it("accepts --json", () => {
    const r = parseLogoutArgs(["--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("rejects unknown args", () => {
    const r = parseLogoutArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "--bogus"/);
  });

  it("--help sets help:true so the dispatcher routes to stdout + exit 0", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parseLogoutArgs([flag]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
    }
  });

  it("--help returns usage", () => {
    const r = parseLogoutArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(LOGOUT_USAGE);
  });
});
