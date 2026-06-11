import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGOUT_USAGE, parseLogoutArgs, runLogout } from "../logout-cmd.js";

// Mock team-sync to control session state in runLogout tests.
vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSession: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined) };
});

import { getSession, signOut } from "../team-sync.js";

// -----------------------------------------------------------------------
// runLogout -- exit code discrimination and prose output (fix 3)
// -----------------------------------------------------------------------
describe("runLogout exit codes and prose", () => {
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    vi.mocked(getSession).mockReset();
    vi.mocked(signOut).mockReset();
    vi.mocked(signOut).mockResolvedValue(undefined);
  });

  it("exits 0 and prints signed-out message when a session exists", async () => {
    vi.mocked(getSession).mockResolvedValue({
      email: "user@example.com",
      role: "member",
      order_id: "order-1",
      exp: Date.now() + 86400_000,
    } as never);
    const result = await runLogout({}, io);
    expect(result.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c: string[]) => c[0]).join("");
    expect(out).toMatch(/signed out/i);
    expect(out).toContain("user@example.com");
    expect(vi.mocked(signOut)).toHaveBeenCalled();
  });

  it("exits 0 with 'already signed out' when no session exists", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const result = await runLogout({}, io);
    expect(result.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c: string[]) => c[0]).join("");
    expect(out).toMatch(/already signed out/i);
    expect(vi.mocked(signOut)).not.toHaveBeenCalled();
  });

  it("--json emits machine-readable JSON on success", async () => {
    vi.mocked(getSession).mockResolvedValue({
      email: "user@example.com",
      role: "member",
      order_id: "order-1",
      exp: Date.now() + 86400_000,
    } as never);
    const result = await runLogout({ json: true }, io);
    expect(result.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c: string[]) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.wasSignedIn).toBe(true);
    expect(parsed.email).toBe("user@example.com");
  });

  it("--json emits machine-readable JSON when already signed out", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const result = await runLogout({ json: true }, io);
    expect(result.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c: string[]) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.wasSignedIn).toBe(false);
  });
});

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
