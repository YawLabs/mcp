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

describe("healStaleBrokerEntries -- a config written for another OS", () => {
  /** A Windows-spelled entry, exactly what a Yaw install on Windows writes. */
  const WIN_OAM = "C:\\tools\\oam.exe";
  const WIN_ENTRY = "C:\\Users\\x\\scoop\\apps\\yaw\\2.1.2\\node_modules\\@yawlabs\\mcp\\dist\\index.js";

  function winEntryToml(): string {
    // TOML literal strings (single quotes) take a Windows path verbatim, which
    // is what install itself writes.
    return ["[mcp_servers.mcp]", `command = '${WIN_OAM}'`, `args = ['run', '--no-check', '${WIN_ENTRY}']`, ""].join(
      "\n",
    );
  }

  it("leaves it alone when inspected from POSIX -- the WSL case", async () => {
    // Every recogniser says yes: oam.exe IS an oam command and the path IS
    // inside an @yawlabs/mcp tree. But statSync on C:... from Linux throws, so
    // gate 2 would read BROKEN and the sweep would rewrite a WORKING Windows
    // entry with Linux paths, breaking the client that owns it. Doctor already
    // refuses to judge this shape; the healer writes, so it matters more.
    const p = writeCodexConfig(winEntryToml());
    const before = readFileSync(p, "utf8");
    const healed = await heal({ platform: "linux" });
    expect(healed.filter((x) => x.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("leaves a POSIX-spelled entry alone when inspected from win32", async () => {
    // The other direction: win32 isAbsolute accepts "/opt/...", so statSync
    // would answer about the current drive rather than about the file meant.
    const p = writeCodexConfig(
      [
        "[mcp_servers.mcp]",
        "command = '/usr/local/bin/oam'",
        "args = ['run', '--no-check', '/opt/yaw/node_modules/@yawlabs/mcp/dist/index.js']",
        "",
      ].join("\n"),
    );
    const before = readFileSync(p, "utf8");
    const healed = await heal({ platform: "win32" });
    expect(healed.filter((x) => x.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

describe("healStaleBrokerEntries -- machines with no oam binary", () => {
  it("repairs to the npx entry when oam publishes nothing for this chip", async () => {
    // oamPublishesBinaryFor: win32/darwin get x64 + arm64, linux gets x64
    // ONLY -- so a linux-arm64 box (a Pi, an arm server, an arm container)
    // has no oam at all. probeOam answers with a null binPath there, and the
    // repair has to land on the self-refetching npx entry rather than write
    // an oam entry naming a binary that does not exist.
    const p2 = writeCodexConfig(tomlEntry(DEAD));
    const noOam = (): OamProbe => ({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: null,
      failureDetail: null,
    });
    const healed = await heal({ oamProbe: noOam });
    const codex = healed.filter((h) => h.clientId === "codex-cli");
    expect(codex).toHaveLength(1);
    expect(codex[0].to).toBe("npx");
    const after = readFileSync(p2, "utf8");
    expect(after).toContain("npx");
    expect(after).not.toContain("oam");
  });
});

describe("healStaleBrokerEntries -- wrapper shapes", () => {
  /** A broken entry reached through a shell wrapper rather than directly. */
  function wrapped(command: string, args: string[]): string {
    return ["[mcp_servers.mcp]", `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, ""].join(
      "\n",
    );
  }

  it("repairs an entry wrapped in pwsh -Command", async () => {
    const p2 = writeCodexConfig(wrapped("pwsh", ["-NoProfile", "-Command", "oam", "run", "--no-check", DEAD]));
    const healed = await heal();
    const codex = healed.filter((h) => h.clientId === "codex-cli");
    expect(codex).toHaveLength(1);
    expect(codex[0].from).toBe(DEAD);
    // The repair writes the shape install writes, so the hand-rolled wrapper
    // does not survive it. That is the deal gate 2 makes: the entry was not
    // starting, and a working entry beats a broken one in the users chosen
    // spelling.
    expect(readFileSync(p2, "utf8")).not.toContain("2.1.2");
  });

  it("repairs an entry wrapped in fish -c", async () => {
    const p2 = writeCodexConfig(wrapped("fish", ["-c", `oam run --no-check ${DEAD}`]));
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toHaveLength(1);
    expect(readFileSync(p2, "utf8")).not.toContain("2.1.2");
  });

  it("leaves a WORKING pwsh-wrapped entry alone", async () => {
    const p2 = writeCodexConfig(wrapped("pwsh", ["-Command", "oam", "run", "--no-check", liveEntry]));
    const before = readFileSync(p2, "utf8");
    const healed = await heal();
    expect(healed.filter((h) => h.clientId === "codex-cli")).toEqual([]);
    expect(readFileSync(p2, "utf8")).toBe(before);
  });
});
