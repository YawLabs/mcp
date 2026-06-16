import { describe, expect, it, vi } from "vitest";
import { parseSetActiveArgs, runSetActive, type SetActiveDeps } from "../set-active-cmd.js";
import {
  type TeamResource,
  TeamSyncAuthError,
  TeamSyncForbiddenError,
  TeamSyncStaleVersionError,
} from "../team-sync.js";

type Bundles = { version?: number; servers: Array<{ namespace?: string; isActive?: boolean; name?: string }> };

function resource(version: number, servers: Bundles["servers"]): TeamResource<Bundles> {
  return { version, data: { version: 1, servers }, updated_at: null, updated_by: null };
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe("parseSetActiveArgs", () => {
  it("parses <namespace> on", () => {
    const r = parseSetActiveArgs(["github", "on"]);
    expect(r).toEqual({ ok: true, options: { namespace: "github", active: true } });
  });

  it("parses off / true / false / disable as the right boolean", () => {
    expect(parseSetActiveArgs(["gh", "off"])).toMatchObject({ ok: true, options: { active: false } });
    expect(parseSetActiveArgs(["gh", "true"])).toMatchObject({ ok: true, options: { active: true } });
    expect(parseSetActiveArgs(["gh", "disable"])).toMatchObject({ ok: true, options: { active: false } });
  });

  it("captures --json", () => {
    expect(parseSetActiveArgs(["gh", "on", "--json"])).toMatchObject({ ok: true, options: { json: true } });
  });

  it("requires both positionals", () => {
    expect(parseSetActiveArgs(["gh"]).ok).toBe(false);
    expect(parseSetActiveArgs([]).ok).toBe(false);
  });

  it("rejects an invalid namespace and an invalid state", () => {
    expect(parseSetActiveArgs(["Bad NS", "on"]).ok).toBe(false);
    expect(parseSetActiveArgs(["gh", "maybe"]).ok).toBe(false);
  });

  it("rejects extra args and unknown flags", () => {
    expect(parseSetActiveArgs(["gh", "on", "extra"]).ok).toBe(false);
    expect(parseSetActiveArgs(["gh", "on", "--nope"]).ok).toBe(false);
  });

  it("returns help on --help", () => {
    const r = parseSetActiveArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help).toBe(true);
  });
});

describe("runSetActive", () => {
  type PutFn = (name: string, version: number, data: Bundles) => Promise<TeamResource<Bundles>>;
  function deps(get: () => Promise<TeamResource<Bundles>>, put?: PutFn) {
    const putResource = vi.fn(
      put ??
        (async (_n: string, version: number, data: Bundles) => ({
          version: version + 1,
          data,
          updated_at: null,
          updated_by: null,
        })),
    );
    const getResource = vi.fn(get);
    const writeSyncState = vi.fn(async (_home: string, _state: unknown) => {});
    return {
      deps: { getResource, putResource, writeSyncState } as unknown as SetActiveDeps,
      getResource,
      putResource,
      writeSyncState,
    };
  }

  it("enables a server that was off and writes isActive:true", async () => {
    const { out, io } = makeIo();
    const d = deps(async () => resource(5, [{ namespace: "github", isActive: false }]));
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect(d.putResource).toHaveBeenCalledTimes(1);
    const [, version, data] = (d.putResource as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(version).toBe(5); // the version we GET'd, for optimistic concurrency
    expect((data as Bundles).servers[0].isActive).toBe(true);
    // FIX B: stamp the bundles-data schema version so set-active and
    // syncPush agree (both PUT version:1).
    expect((data as Bundles).version).toBe(1);
    expect(out.join("")).toMatch(/now active/);
  });

  it("advances local sync-state to the new version after a successful toggle", async () => {
    const { io } = makeIo();
    const d = deps(async () => resource(5, [{ namespace: "github", isActive: false }]));
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    // Default mock PUT returns version+1 (5 -> 6); sync-state records 6 so an
    // immediate `yaw-mcp sync push` from this machine isn't spuriously stale.
    expect(d.writeSyncState).toHaveBeenCalledTimes(1);
    expect(d.writeSyncState.mock.calls[0][1]).toEqual({ mcp_bundles: { lastPulledVersion: 6 } });
  });

  it("does not write sync-state on a no-op (no PUT, nothing changed)", async () => {
    const { io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github", isActive: true }]));
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect(d.putResource).not.toHaveBeenCalled();
    expect(d.writeSyncState).not.toHaveBeenCalled();
  });

  it("disables a server that was on", async () => {
    const { io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github", isActive: true }]));
    const r = await runSetActive({ namespace: "github", active: false }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect((d.putResource as ReturnType<typeof vi.fn>).mock.calls[0][2].servers[0].isActive).toBe(false);
  });

  it("is a no-op when already in the desired state (no PUT)", async () => {
    const { out, io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github", isActive: true }]));
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect(d.putResource).not.toHaveBeenCalled();
    expect(out.join("")).toMatch(/already active/);
  });

  it("treats a server with absent isActive as active (on is a true no-op)", async () => {
    const { out, io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github" }])); // no isActive field
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect(d.putResource).not.toHaveBeenCalled();
    expect(out.join("")).toMatch(/already active/);
  });

  it("disables a server whose isActive was absent (writes explicit false)", async () => {
    const { io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github" }]));
    const r = await runSetActive({ namespace: "github", active: false }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect((d.putResource as ReturnType<typeof vi.fn>).mock.calls[0][2].servers[0].isActive).toBe(false);
  });

  it("errors when the namespace is not in the team config", async () => {
    const { err, io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "aws", isActive: true }]));
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(1);
    expect(d.putResource).not.toHaveBeenCalled();
    expect(err.join("")).toMatch(/No team server with namespace "github"/);
  });

  it("surfaces a not-signed-in error", async () => {
    const { err, io } = makeIo();
    const d = deps(async () => {
      throw new TeamSyncAuthError();
    });
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toMatch(/Not signed in/);
  });

  it("surfaces a forbidden (no edit permission) error", async () => {
    const { err, io } = makeIo();
    const put = async () => {
      throw new TeamSyncForbiddenError();
    };
    const d = deps(async () => resource(1, [{ namespace: "github", isActive: false }]), put);
    const r = await runSetActive({ namespace: "github", active: true }, io, d.deps);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toMatch(/permission/i);
  });

  it("retries once on a stale-version conflict, then succeeds", async () => {
    const { io } = makeIo();
    let putCalls = 0;
    const put = vi.fn(async (_n: string, version: number, data: unknown) => {
      putCalls++;
      if (putCalls === 1) throw new TeamSyncStaleVersionError(9);
      return { version: version + 1, data: data as Bundles, updated_at: null, updated_by: null };
    });
    // Two GETs: the initial one (version 5) and the re-pull after the conflict (version 9).
    const get = vi
      .fn()
      .mockResolvedValueOnce(resource(5, [{ namespace: "github", isActive: false }]))
      .mockResolvedValueOnce(resource(9, [{ namespace: "github", isActive: false }]));
    const writeSyncState = vi.fn(async (_home: string, _state: unknown) => {});
    const d = { getResource: get, putResource: put, writeSyncState } as unknown as SetActiveDeps;
    const r = await runSetActive({ namespace: "github", active: true }, io, d);
    expect(r.exitCode).toBe(0);
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][1]).toBe(9); // retry uses the freshly-pulled version
    // sync-state advances to the post-retry PUT's new version (9 -> 10).
    expect(writeSyncState).toHaveBeenCalledTimes(1);
    expect(writeSyncState.mock.calls[0][1]).toEqual({ mcp_bundles: { lastPulledVersion: 10 } });
  });

  it("emits machine-readable JSON with --json", async () => {
    const { out, io } = makeIo();
    const d = deps(async () => resource(1, [{ namespace: "github", isActive: false }]));
    const r = await runSetActive({ namespace: "github", active: true, json: true }, io, d.deps);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, namespace: "github", isActive: true, changed: true });
  });
});
