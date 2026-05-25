import { describe, expect, it } from "vitest";
import { SYNC_USAGE, parseSyncArgs } from "../sync-cmd.js";

describe("parseSyncArgs", () => {
  it("accepts push", () => {
    const r = parseSyncArgs(["push"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("push");
  });

  it("accepts pull", () => {
    const r = parseSyncArgs(["pull"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("pull");
  });

  it("accepts status", () => {
    const r = parseSyncArgs(["status"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("status");
  });

  it("accepts --json alongside an action", () => {
    const r = parseSyncArgs(["pull", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("pull");
      expect(r.options.json).toBe(true);
    }
  });

  it("rejects missing action", () => {
    const r = parseSyncArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing action/);
  });

  it("rejects multiple actions", () => {
    const r = parseSyncArgs(["push", "pull"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/multiple actions/);
  });

  it("rejects unknown args", () => {
    const r = parseSyncArgs(["push", "--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "--bogus"/);
  });

  it("--help returns usage", () => {
    const r = parseSyncArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(SYNC_USAGE);
  });
});
