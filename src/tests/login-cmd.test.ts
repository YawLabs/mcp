import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_USAGE, parseLoginArgs, runLogin } from "../login-cmd.js";

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

  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseLoginArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(LOGIN_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseLoginArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });
});

// -----------------------------------------------------------------------
// runLogin -- exit code discrimination (fix: non-auth errors exit 2, not 1)
// -----------------------------------------------------------------------

vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, signIn: vi.fn() };
});

import { signIn, TeamSyncAuthError } from "../team-sync.js";

describe("runLogin exit codes", () => {
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
  });

  it("exits 1 on TeamSyncAuthError (bad license key)", async () => {
    vi.mocked(signIn).mockRejectedValue(new TeamSyncAuthError("Sign in failed."));
    const result = await runLogin({ key: "bad-key" }, io);
    expect(result.exitCode).toBe(1);
  });

  it("exits 2 on non-auth errors (network failure, unexpected)", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await runLogin({ key: "lk_test" }, io);
    expect(result.exitCode).toBe(2);
  });

  it("exits 0 on success", async () => {
    vi.mocked(signIn).mockResolvedValue({
      email: "user@example.com",
      role: "member",
      order_id: "order-1",
      exp: Date.now() + 86400_000,
    });
    const result = await runLogin({ key: "lk_valid" }, io);
    expect(result.exitCode).toBe(0);
  });
});
