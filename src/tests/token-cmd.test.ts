import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTokenArgs, runTokenCmd, TOKEN_USAGE } from "../token-cmd.js";

describe("parseTokenArgs", () => {
  it("accepts no args", () => {
    const r = parseTokenArgs([]);
    expect(r.ok).toBe(true);
  });

  it("accepts --json", () => {
    const r = parseTokenArgs(["--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("rejects unknown args", () => {
    const r = parseTokenArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "--bogus"/);
  });

  it("--help sets help:true so the dispatcher routes to stdout+exit0", () => {
    const r = parseTokenArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(TOKEN_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
});

vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSessionWithCookie: vi.fn() };
});

import { getSessionWithCookie } from "../team-sync.js";

describe("runTokenCmd", () => {
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
  });

  it("exits 1 and prints nothing to stdout when not signed in", async () => {
    vi.mocked(getSessionWithCookie).mockResolvedValue(null);
    const r = await runTokenCmd({}, io);
    expect(r.exitCode).toBe(1);
    expect(io.out).not.toHaveBeenCalled();
  });

  it("prints the raw token on success (plain mode)", async () => {
    vi.mocked(getSessionWithCookie).mockResolvedValue({
      cookie: "ck_abc.sig",
      session: { email: "u@x.com", role: "admin", order_id: "o1", exp: Date.now() + 86_400_000 },
    });
    const r = await runTokenCmd({}, io);
    expect(r.exitCode).toBe(0);
    expect(io.out).toHaveBeenCalledWith("ck_abc.sig\n");
  });

  it("emits { ok, token, email, exp } on --json", async () => {
    const exp = Date.now() + 86_400_000;
    vi.mocked(getSessionWithCookie).mockResolvedValue({
      cookie: "ck_abc.sig",
      session: { email: "u@x.com", role: "admin", order_id: "o1", exp },
    });
    const r = await runTokenCmd({ json: true }, io);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0][0])).toEqual({ ok: true, token: "ck_abc.sig", email: "u@x.com", exp });
  });
});
