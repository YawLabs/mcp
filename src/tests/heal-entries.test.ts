import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HealedEntry, healStaleBrokerEntries } from "../heal-entries.js";
import type { OamProbe } from "../oam-spawn.js";

/** An oam that is installed and healthy, at a path we never have to create:
 *  buildLaunchEntry only requires the string be absolute. */
const OAM_BIN = process.platform === "win32" ? "C:\\tools\\oam.exe" : "/usr/local/bin/oam";
const probe = (): OamProbe => ({
  bin: "oam",
  binPath: OAM_BIN,
  version: "0.16.2",
  belowMin: false,
  failure: null,
  failureDetail: null,
});

let home: string;
/** A real file, so the "already works" gate can see it exist. */
let liveEntry: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-heal-"));
  const pkgDir = join(home, "live", "node_modules", "@yawlabs", "mcp", "dist");
  mkdirSync(pkgDir, { recursive: true });
  liveEntry = join(pkgDir, "index.js");
  writeFileSync(liveEntry, "// broker\n");
});

afterEach(() => {
  // Left in the OS temp dir on purpose: these are tiny, and deleting a tree
  // on Windows races AV/indexer handles often enough to flake a suite.
});

/** The dead path an app upgrade leaves behind -- version dir that is gone. */
const DEAD =
  process.platform === "win32"
    ? "C:\\Users\\x\\scoop\\apps\\yaw\\2.1.2\\resources\\app.asar.unpacked\\node_modules\\@yawlabs\\mcp\\dist\\index.js"
    : "/opt/yaw/2.1.2/resources/node_modules/@yawlabs/mcp/dist/index.js";

function writeCodexConfig(body: string): string {
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.toml");
  writeFileSync(p, body);
  return p;
}

function tomlEntry(entryPath: string, extra = ""): string {
  return (
    "[projects.'/some/repo']\ntrust_level = \"trusted\"\n\n" +
    "[mcp_servers.mcp]\n" +
    `command = ${JSON.stringify(OAM_BIN)}\n` +
    `args = ["run", "--no-check", ${JSON.stringify(entryPath)}]\n` +
    "startup_timeout_sec = 60.0\n" +
    extra
  );
}

/** Heal against the fake home, with oam forced present and the resolver
 *  answering with a path that really exists. */
async function heal(over: Record<string, unknown> = {}): Promise<HealedEntry[]> {
  return (await healResult(over)).healed;
}

/** The whole sweep result, for the cases that assert on what it DECLINED to
 *  read as well as on what it repaired. */
function healResult(over: Record<string, unknown> = {}) {
  return healStaleBrokerEntries({
    home,
    cwd: home,
    oamProbe: probe,
    resolveOamEntry: () => liveEntry,
    ...over,
  });
}

describe("healStaleBrokerEntries", () => {
  it("re-points an entry whose launch file no longer exists", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const healed = await heal();

    const codex = healed.filter((h) => h.clientId === "codex-cli");
    expect(codex.length).toBeGreaterThan(0);
    expect(codex[0].from).toBe(DEAD);
    expect(codex[0].to).toBe(liveEntry);

    const after = readFileSync(p, "utf8");
    expect(after).toContain(liveEntry.split("\\").join("\\\\"));
    expect(after).not.toContain("2.1.2");
  });

  it("carries the client's own extra fields through the rewrite", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    await heal();
    // Codex needs this to start the server at all; losing it in a repair
    // would trade one broken entry for another.
    expect(readFileSync(p, "utf8")).toContain("startup_timeout_sec");
  });

  it("leaves a sibling table above the entry untouched", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    await heal();
    const after = readFileSync(p, "utf8");
    expect(after).toContain("[projects.'/some/repo']");
    expect(after).toContain('trust_level = "trusted"');
  });

  it("does NOT touch an entry that still works", async () => {
    const p = writeCodexConfig(tomlEntry(liveEntry));
    const before = readFileSync(p, "utf8");
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("does NOT touch an oam entry pointing at somebody else's server", async () => {
    const foreign =
      process.platform === "win32" ? "C:\\gone\\other-server\\dist\\index.js" : "/gone/other-server/dist/index.js";
    const p = writeCodexConfig(tomlEntry(foreign));
    const before = readFileSync(p, "utf8");
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("does NOT touch a hand-written npx entry", async () => {
    const p = writeCodexConfig('[mcp_servers.mcp]\ncommand = "npx"\nargs = ["-y", "@yawlabs/mcp@0.79.0"]\n');
    const before = readFileSync(p, "utf8");
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("writes nothing when read-only diagnostics is set", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const before = readFileSync(p, "utf8");
    const healed = await heal({ env: { YAW_MCP_READONLY_DIAGNOSTICS: "1" } });
    expect(healed).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("writes nothing on a dry run, but still reports the repair", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const before = readFileSync(p, "utf8");
    const healed = await heal({ dryRun: true });
    expect(healed.filter((h) => h.clientId === "codex-cli").length).toBeGreaterThan(0);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("reports one repair, not two, when user and project scopes alias one file", async () => {
    // cwd === home is what Yaw Terminal's main process actually does
    // (process.chdir(os.homedir())), which makes Codex's project scope resolve
    // to the very same ~/.codex/config.toml the user scope resolves to. The
    // same physical entry must not be counted -- or rewritten -- twice.
    writeCodexConfig(tomlEntry(DEAD));
    const healed = await heal({ cwd: home });
    expect(healed.filter((h) => h.clientId === "codex-cli")).toHaveLength(1);
  });

  it("falls back to the self-refetching npx entry when no durable path resolves", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const healed = await heal({ resolveOamEntry: () => null });
    const codex = healed.filter((h) => h.clientId === "codex-cli");
    expect(codex).toHaveLength(1);
    expect(codex[0].to).toBe("npx");
    expect(readFileSync(p, "utf8")).toContain("npx");
  });

  it("does not reject when a config file is unreadable", async () => {
    // A directory where a config file should be: the read fails, and the sweep
    // has to keep going rather than take the whole pass down.
    mkdirSync(join(home, ".codex", "config.toml"), { recursive: true });
    await expect(heal()).resolves.toBeInstanceOf(Array);
  });
});

describe("healStaleBrokerEntries -- gate 2 and unreadable configs", () => {
  it("treats a DIRECTORY at the entry path as broken, not as healthy", async () => {
    // oam run <a directory> cannot start the broker any more than a missing
    // path can, but existsSync is true for both -- so this entry used to be
    // declared healthy and left unstartable forever.
    const dirEntry = join(home, "adirectory");
    mkdirSync(dirEntry, { recursive: true });
    const p = writeCodexConfig(tomlEntry(join(dirEntry, "node_modules", "@yawlabs", "mcp", "dist")));
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toHaveLength(1);
    expect(readFileSync(p, "utf8")).not.toContain("adirectory");
  });

  it("reports a config it could not read into instead of calling it clean", async () => {
    // A root-level TOML inline table parses fine and holds our entry, but the
    // splicer refuses it -- so the sweep can make no claim about the entry
    // inside. Saying "no stale entries found" for this is the misleading half.
    writeCodexConfig(["mcp_servers = { mcp = { command = 'oam' } }", ""].join("\n"));
    const r = await healResult();
    const codex = r.unhealable.filter((u) => u.clientId === "codex-cli");
    expect(codex.length).toBeGreaterThan(0);
    expect(r.healed.filter((h) => h.clientId === "codex-cli")).toEqual([]);
  });

  it("does not report an ABSENT config as unreadable", async () => {
    // No file at all is the ordinary case for a client the user never
    // installed to, and must not be dressed up as a problem.
    const r = await healResult();
    expect(r.unhealable.filter((u) => u.reason === "absent")).toEqual([]);
  });
});
