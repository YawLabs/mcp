import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_USAGE, parseSyncArgs, runSync } from "../sync-cmd.js";

// Mock team-sync so runSync tests don't need real credentials or network.
vi.mock("../team-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn().mockResolvedValue({
      email: "test@example.com",
      role: "admin",
      order_id: "order-1",
    }),
    getResource: vi.fn().mockResolvedValue({
      data: { servers: [] },
      version: 1,
      updated_at: null,
      updated_by: null,
    }),
    putResource: vi.fn().mockResolvedValue({ version: 2 }),
  };
});

// -----------------------------------------------------------------------
// readLocalBundles -- corrupt bundles.json must produce an actionable
// error, not a raw SyntaxError reaching the user (fix 2).
// -----------------------------------------------------------------------
describe("runSync readLocalBundles -- corrupt bundles.json", () => {
  let synthHome: string;
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(() => {
    synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-sync-"));
    io.out.mockReset();
    io.err.mockReset();
  });

  afterEach(() => {
    rmSync(synthHome, { recursive: true, force: true });
  });

  it("sync pull surfaces an actionable message on corrupt bundles.json (not a raw SyntaxError)", async () => {
    // Write an invalid JSON file at the expected path.
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{ not valid json");

    const result = await runSync({ action: "pull", home: synthHome }, io);
    expect(result.exitCode).toBe(1);
    // err output must mention the file and give a hint, not just "SyntaxError".
    const errOutput = io.err.mock.calls.map((c: string[]) => c[0]).join("");
    expect(errOutput).toMatch(/invalid JSON/i);
    expect(errOutput).not.toMatch(/^SyntaxError/);
  });

  it("sync push surfaces an actionable message on corrupt bundles.json", async () => {
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{broken");

    const result = await runSync({ action: "push", home: synthHome }, io);
    expect(result.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c: string[]) => c[0]).join("");
    expect(errOutput).toMatch(/invalid JSON/i);
  });
});

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

  it("--help sets help:true so the dispatcher routes to stdout + exit 0", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parseSyncArgs([flag]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
    }
  });

  it("--help returns usage", () => {
    const r = parseSyncArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(SYNC_USAGE);
  });
});
