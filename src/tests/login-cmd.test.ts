import { describe, expect, it } from "vitest";
import { LOGIN_USAGE, parseLoginArgs } from "../login-cmd.js";

describe("parseLoginArgs", () => {
  it("accepts --key <license-key>", () => {
    const r = parseLoginArgs(["--key", "lk_abc123"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.key).toBe("lk_abc123");
  });

  it("accepts --json alongside --key", () => {
    const r = parseLoginArgs(["--key", "lk_abc", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.key).toBe("lk_abc");
      expect(r.options.json).toBe(true);
    }
  });

  it("rejects missing --key", () => {
    const r = parseLoginArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--key is required/);
  });

  it("rejects --key without a value", () => {
    const r = parseLoginArgs(["--key"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--key requires a value/);
  });

  it("rejects unknown args", () => {
    const r = parseLoginArgs(["--key", "k", "--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "--bogus"/);
  });

  it("--help returns usage", () => {
    const r = parseLoginArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(LOGIN_USAGE);
  });
});
