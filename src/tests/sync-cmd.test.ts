import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_USAGE, parseSyncArgs, runSync } from "../sync-cmd.js";
import { TeamSyncStaleVersionError, getResource, putResource } from "../team-sync.js";

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

const mockGetResource = vi.mocked(getResource);
const mockPutResource = vi.mocked(putResource);

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

// -----------------------------------------------------------------------
// FIX A: isActive is remote-authoritative. A push from a machine whose
// local bundles.json predates a team `set-active <ns> off` must NOT flip
// it back on. Genuinely-new local servers (not on the remote) keep their
// local isActive.
// -----------------------------------------------------------------------
describe("syncPush -- isActive is remote-authoritative (FIX A)", () => {
  let home: string;
  const io = { out: vi.fn(), err: vi.fn() };

  function writeBundles(servers: unknown[]): void {
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-pushA-"));
    io.out.mockReset();
    io.err.mockReset();
    mockGetResource.mockReset();
    mockPutResource.mockReset();
    mockPutResource.mockResolvedValue({ version: 3, data: null, updated_at: null, updated_by: null });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves remote isActive=false over a stale local isActive=true", async () => {
    // Local thinks github is on (stale); remote authority says off.
    writeBundles([{ namespace: "github", isActive: true, env: { GITHUB_TOKEN: "secret" } }]);
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: false }] },
      version: 2,
      updated_at: null,
      updated_by: null,
    });

    const r = await runSync({ action: "push", home }, io);
    expect(r.exitCode).toBe(0);
    expect(mockPutResource).toHaveBeenCalledTimes(1);
    const payload = mockPutResource.mock.calls[0][2] as { servers: Array<{ namespace?: string; isActive?: boolean }> };
    const github = payload.servers.find((s) => s.namespace === "github");
    expect(github?.isActive).toBe(false); // remote value won, NOT the stale local true
  });

  it("keeps local isActive for a new server not on the remote (seeding)", async () => {
    // github is on the remote (off); aws is brand new locally (on) and not remote.
    writeBundles([
      { namespace: "github", isActive: true },
      { namespace: "aws", isActive: true },
    ]);
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: false }] },
      version: 2,
      updated_at: null,
      updated_by: null,
    });

    const r = await runSync({ action: "push", home }, io);
    expect(r.exitCode).toBe(0);
    const payload = mockPutResource.mock.calls[0][2] as { servers: Array<{ namespace?: string; isActive?: boolean }> };
    expect(payload.servers.find((s) => s.namespace === "github")?.isActive).toBe(false); // remote-authoritative
    expect(payload.servers.find((s) => s.namespace === "aws")?.isActive).toBe(true); // seeded from local
  });
});

// -----------------------------------------------------------------------
// FIX C: push submits the LAST-PULLED version (optimistic concurrency),
// not a freshly-GET'd one. status reports the persisted last-pulled
// version.
// -----------------------------------------------------------------------
describe("sync optimistic concurrency (FIX C)", () => {
  let home: string;
  const io = { out: vi.fn(), err: vi.fn() };

  function writeBundles(servers: unknown[]): void {
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));
  }
  function readSyncStateFile(): { mcp_bundles?: { lastPulledVersion: number } } | null {
    const p = join(home, ".yaw-mcp", "sync-state.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-pushC-"));
    io.out.mockReset();
    io.err.mockReset();
    mockGetResource.mockReset();
    mockPutResource.mockReset();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("pull persists lastPulledVersion; a subsequent push submits that version", async () => {
    writeBundles([{ namespace: "github", isActive: true }]);
    // Pull from remote v7.
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: true }] },
      version: 7,
      updated_at: null,
      updated_by: null,
    });
    const pull = await runSync({ action: "pull", home }, io);
    expect(pull.exitCode).toBe(0);
    expect(readSyncStateFile()?.mcp_bundles?.lastPulledVersion).toBe(7);

    // Push: remote still at v7, no concurrent edit.
    mockPutResource.mockResolvedValue({ version: 8, data: null, updated_at: null, updated_by: null });
    const push = await runSync({ action: "push", home }, io);
    expect(push.exitCode).toBe(0);
    expect(mockPutResource.mock.calls[0][1]).toBe(7); // pushed the last-pulled version, not a re-GET
    // After success, sync-state advances to the new version.
    expect(readSyncStateFile()?.mcp_bundles?.lastPulledVersion).toBe(8);
  });

  it("409s when the remote moved ahead of the last-pulled version", async () => {
    writeBundles([{ namespace: "github", isActive: true }]);
    // Pull at v7.
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: true }] },
      version: 7,
      updated_at: null,
      updated_by: null,
    });
    await runSync({ action: "pull", home }, io);
    io.err.mockReset();

    // Remote moved to v9 (someone else pushed). GET sees v9, but we push
    // against last-pulled v7 -> the server rejects with a stale-version 409.
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: true }] },
      version: 9,
      updated_at: null,
      updated_by: null,
    });
    mockPutResource.mockRejectedValue(new TeamSyncStaleVersionError(9));

    const push = await runSync({ action: "push", home }, io);
    expect(push.exitCode).toBe(1);
    expect(mockPutResource.mock.calls[0][1]).toBe(7); // pushed the stale last-pulled version
    expect(io.err.mock.calls.map((c: string[]) => c[0]).join("")).toMatch(/pull/i);
  });

  it("first push with no sync-state seeds against the GET'd version", async () => {
    writeBundles([{ namespace: "github", isActive: true }]);
    expect(readSyncStateFile()).toBeNull(); // never pulled
    mockGetResource.mockResolvedValue({
      data: { version: 0, servers: [] },
      version: 0,
      updated_at: null,
      updated_by: null,
    });
    mockPutResource.mockResolvedValue({ version: 1, data: null, updated_at: null, updated_by: null });

    const push = await runSync({ action: "push", home }, io);
    expect(push.exitCode).toBe(0);
    expect(mockPutResource.mock.calls[0][1]).toBe(0); // fell back to the GET'd remote version
    expect(readSyncStateFile()?.mcp_bundles?.lastPulledVersion).toBe(1);
  });

  it("status reports the persisted lastPulledVersion", async () => {
    writeBundles([{ namespace: "github", isActive: true }]);
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: true }] },
      version: 7,
      updated_at: null,
      updated_by: null,
    });
    await runSync({ action: "pull", home }, io);
    io.out.mockReset();

    // Remote now at v9 in status; last-pulled stays 7.
    mockGetResource.mockResolvedValue({
      data: { version: 1, servers: [{ namespace: "github", isActive: true }] },
      version: 9,
      updated_at: null,
      updated_by: null,
    });
    const status = await runSync({ action: "status", home, json: true }, io);
    expect(status.exitCode).toBe(0);
    const json = JSON.parse(io.out.mock.calls.map((c: string[]) => c[0]).join(""));
    expect(json.remoteVersion).toBe(9);
    expect(json.lastPulledVersion).toBe(7);
  });
});
