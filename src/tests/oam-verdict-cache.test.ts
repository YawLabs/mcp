import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAM_VERDICT_FILENAME, oamBinaryIdentity, readOamVerdict, writeOamVerdict } from "../oam-verdict-cache.js";

// The cross-process `oam --version` cache. Every case runs against a scratch
// HOME so nothing reaches the developer's real ~/.yaw-mcp.
describe("oam verdict cache", () => {
  let home: string;
  let bin: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["HOME", "USERPROFILE", "YAW_MCP_DISABLE_PERSISTENCE"];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-verdict-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
    bin = join(home, "oam.exe");
    writeFileSync(bin, "not really oam");
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const file = () => join(home, ".yaw-mcp", OAM_VERDICT_FILENAME);

  it("misses before anything is written, then returns what a clean probe printed", async () => {
    const id = oamBinaryIdentity(bin);
    expect(id).not.toBeNull();
    if (!id) return;
    expect(readOamVerdict(id)).toBeUndefined();
    await writeOamVerdict(id, "0.18.0");
    expect(readOamVerdict(id)).toBe("0.18.0");
    // null is an answer too ("exited cleanly, nothing parsable"), distinct
    // from a miss.
    await writeOamVerdict(id, null);
    expect(readOamVerdict(id)).toBeNull();
  });

  it("misses once the binary changes (a self-update rewrites it)", async () => {
    const before = oamBinaryIdentity(bin);
    if (!before) throw new Error("no identity");
    await writeOamVerdict(before, "0.18.0");
    writeFileSync(bin, "a different, longer oam build");
    utimesSync(bin, new Date(), new Date(Date.now() + 5_000));
    const after = oamBinaryIdentity(bin);
    if (!after) throw new Error("no identity");
    expect(readOamVerdict(after)).toBeUndefined();
  });

  it("has no identity for a path that is not a file", () => {
    expect(oamBinaryIdentity(join(home, "missing.exe"))).toBeNull();
    expect(oamBinaryIdentity(home)).toBeNull();
  });

  it("treats a malformed or foreign-schema file as a miss", async () => {
    const id = oamBinaryIdentity(bin);
    if (!id) throw new Error("no identity");
    await writeOamVerdict(id, "0.18.0");
    writeFileSync(file(), "{ not json");
    expect(readOamVerdict(id)).toBeUndefined();
    writeFileSync(file(), JSON.stringify({ schema: 99, entries: {} }));
    expect(readOamVerdict(id)).toBeUndefined();
  });

  it("a damaged entry does not stop later writes: the next write replaces the file without it", async () => {
    // The writer sorts on each entry's probedAt, so a null entry made it throw
    // (caught, debug-logged) and nothing was written -- and since the write is
    // what replaces the file, the damage stayed and every process re-probed.
    const id = oamBinaryIdentity(bin);
    if (!id) throw new Error("no identity");
    await writeOamVerdict(id, "0.18.0");
    const good = { size: 1, mtimeMs: 2, version: "0.17.0", probedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(
      file(),
      JSON.stringify({
        schema: 1,
        entries: { "/a/null": null, "/a/number": 7, "/a/partial": { size: 1 }, "/a/good": good },
      }),
    );
    expect(readOamVerdict(id)).toBeUndefined();

    await writeOamVerdict(id, "0.19.5");

    expect(readOamVerdict(id)).toBe("0.19.5");
    const written = JSON.parse(readFileSync(file(), "utf8")) as { entries: Record<string, unknown> };
    // The well-shaped neighbour survives; the damaged values are gone.
    expect(Object.keys(written.entries)).toHaveLength(2);
    expect(written.entries["/a/good"]).toEqual(good);

    // An `entries` that is an array is not a map of anything.
    writeFileSync(file(), JSON.stringify({ schema: 1, entries: [null] }));
    await writeOamVerdict(id, "0.19.5");
    expect(readOamVerdict(id)).toBe("0.19.5");
  });

  it("reads and writes nothing under YAW_MCP_DISABLE_PERSISTENCE", async () => {
    const id = oamBinaryIdentity(bin);
    if (!id) throw new Error("no identity");
    process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";
    await writeOamVerdict(id, "0.18.0");
    expect(() => readFileSync(file())).toThrow();
    delete process.env.YAW_MCP_DISABLE_PERSISTENCE;
    await writeOamVerdict(id, "0.18.0");
    process.env.YAW_MCP_DISABLE_PERSISTENCE = "1";
    expect(readOamVerdict(id)).toBeUndefined();
  });
});
