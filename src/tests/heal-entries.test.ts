import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HealedEntry,
  type HealResult,
  healStaleBrokerEntries,
  maybeHealStaleBrokerEntries,
} from "../heal-entries.js";
import { MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";

/** An oam that is installed and healthy, at a path we never have to create:
 *  buildLaunchEntry only requires the string be absolute. The version is
 *  derived from MIN_OAM_VERSION, as the other usable fixtures are, so it stays
 *  a state probeOam can produce; heal reads only binPath, so it is inert here. */
const OAM_BIN = process.platform === "win32" ? "C:\\tools\\oam.exe" : "/usr/local/bin/oam";
const probe = (): OamProbe => ({
  bin: "oam",
  binPath: OAM_BIN,
  version: MIN_OAM_VERSION,
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
    // A heal re-points the entry and changes nothing else: the file comes
    // back as the same fixture naming the live path. In particular it does
    // not gain the root-level mcp_optional_startup_grace_ms = 0 that install
    // sets for Codex -- heal edits config.toml as it always has, and install
    // is the one command that writes that key.
    expect(after).not.toContain("mcp_optional_startup_grace_ms");
    expect(after).toBe(tomlEntry(liveEntry));
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

describe("maybeHealStaleBrokerEntries -- YAW_MCP_AUTO_HEAL", () => {
  /** The startup wrapper against the same fake home. */
  function maybeHeal(env: NodeJS.ProcessEnv): Promise<HealResult> {
    return maybeHealStaleBrokerEntries({ home, cwd: home, env, oamProbe: probe, resolveOamEntry: () => liveEntry });
  }

  // The gate used to be a bare `=== "0"` under a comment claiming it matched
  // its siblings' parse -- so "false" did nothing, and neither did the "0 "
  // that cmd.exe's `set YAW_MCP_AUTO_HEAL=0 && ...` delivers. All three are
  // opt-outs now, through the one shared parser.
  it.each(["0", "false", "FALSE", "0 "])("writes nothing and reports nothing under %j", async (value) => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const before = readFileSync(p, "utf8");
    const r = await maybeHeal({ YAW_MCP_AUTO_HEAL: value });
    expect(r).toEqual({ healed: [], unhealable: [] });
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it.each(["no", "off", "1", "00"])("still heals under the near-miss %j", async (value) => {
    // Only the two documented spellings turn it off. A near-miss that
    // silently disabled the heal would leave a dead entry in place for a user
    // who meant to keep the feature.
    const p = writeCodexConfig(tomlEntry(DEAD));
    const r = await maybeHeal({ YAW_MCP_AUTO_HEAL: value });
    expect(r.healed.filter((h) => h.clientId === "codex-cli")).toHaveLength(1);
    expect(readFileSync(p, "utf8")).not.toContain("2.1.2");
  });

  it("still honours the read-only gate, which the verb-level opt-out does not replace", async () => {
    const p = writeCodexConfig(tomlEntry(DEAD));
    const before = readFileSync(p, "utf8");
    const r = await maybeHeal({ YAW_MCP_READONLY_DIAGNOSTICS: "1" });
    expect(r.healed).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

describe("healStaleBrokerEntries -- client config redirects come from the environment", () => {
  // The sweep used to build its sites from `opts.claudeConfigDir` /
  // `opts.appData` alone, and neither caller passed them, so a redirected
  // client was inspected at its DEFAULT path: "No stale yaw-mcp entries found"
  // while doctor -- which reads every redirect through readClientEnv -- kept
  // flagging the dead entry in the file the client actually reads.

  it("heals the config.toml CODEX_HOME points at, not ~/.codex/config.toml", async () => {
    const codexHome = join(home, "elsewhere", "codex");
    mkdirSync(codexHome, { recursive: true });
    const redirected = join(codexHome, "config.toml");
    writeFileSync(redirected, tomlEntry(DEAD));

    const healed = await heal({ env: { CODEX_HOME: codexHome } });
    const codex = healed.filter((h) => h.clientId === "codex-cli");
    expect(codex).toHaveLength(1);
    expect(codex[0].path).toBe(redirected);
    expect(readFileSync(redirected, "utf8")).not.toContain("2.1.2");
    // And the default location was neither created nor consulted.
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("heals the .claude.json under CLAUDE_CONFIG_DIR -- what every Yaw Terminal pane sets", async () => {
    const configDir = join(home, "overlay");
    mkdirSync(configDir, { recursive: true });
    const redirected = join(configDir, ".claude.json");
    writeFileSync(
      redirected,
      JSON.stringify({ mcpServers: { mcp: { command: OAM_BIN, args: ["run", "--no-check", DEAD] } } }, null, 2),
    );

    const healed = await heal({ env: { CLAUDE_CONFIG_DIR: configDir } });
    const claude = healed.filter((h) => h.clientId === "claude-code");
    expect(claude).toHaveLength(1);
    expect(claude[0].path).toBe(redirected);
    expect(claude[0].from).toBe(DEAD);
    expect(readFileSync(redirected, "utf8")).not.toContain("2.1.2");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  it("lets an explicit claudeConfigDir option win over the environment", async () => {
    // Install, doctor and the tests all pin the redirect as an option; the
    // env is the fallback for the two callers that pass nothing.
    const fromOpt = join(home, "from-opt");
    const fromEnv = join(home, "from-env");
    mkdirSync(fromOpt, { recursive: true });
    mkdirSync(fromEnv, { recursive: true });
    const entry = { mcpServers: { mcp: { command: OAM_BIN, args: ["run", "--no-check", DEAD] } } };
    writeFileSync(join(fromOpt, ".claude.json"), JSON.stringify(entry));
    writeFileSync(join(fromEnv, ".claude.json"), JSON.stringify(entry));

    const healed = await heal({ claudeConfigDir: fromOpt, env: { CLAUDE_CONFIG_DIR: fromEnv } });
    const claude = healed.filter((h) => h.clientId === "claude-code");
    expect(claude.map((h) => h.path)).toEqual([join(fromOpt, ".claude.json")]);
    expect(readFileSync(join(fromEnv, ".claude.json"), "utf8")).toContain("2.1.2");
  });

  it("treats an empty CLAUDE_CONFIG_DIR as unset, the rule the one reader already applies", async () => {
    const p = join(home, ".claude.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { mcp: { command: OAM_BIN, args: ["run", "--no-check", DEAD] } } }));
    const healed = await heal({ env: { CLAUDE_CONFIG_DIR: "" } });
    expect(healed.filter((h) => h.clientId === "claude-code").map((h) => h.path)).toEqual([p]);
  });
});

describe("healStaleBrokerEntries -- a client whose one scope is SEVERAL files", () => {
  // Cline fans one (client, scope) out to a shared file plus one copy per
  // editor its extension has run in, and install writes ALL of them. The
  // sweep used to take `[0]` -- the shared file -- and never looked at the
  // editor copies, so a dead entry in one of them was never repaired.
  //
  // `os` is passed explicitly so the editor root is a known path under the
  // fake home on every runner (target-cline.ts resolves it per OS).
  const CLINE_ENTRY = { mcpServers: { mcp: { command: OAM_BIN, args: ["run", "--no-check", DEAD] } } };

  function seedClineFiles(): { shared: string; vscode: string } {
    const shared = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    const storage = join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
    const vscode = join(storage, "settings", "cline_mcp_settings.json");
    mkdirSync(dirname(shared), { recursive: true });
    mkdirSync(dirname(vscode), { recursive: true });
    writeFileSync(shared, JSON.stringify(CLINE_ENTRY, null, 2));
    writeFileSync(vscode, JSON.stringify(CLINE_ENTRY, null, 2));
    return { shared, vscode };
  }

  it("heals the shared file AND each editor copy this machine has", async () => {
    const { shared, vscode } = seedClineFiles();
    const healed = await heal({ os: "linux" });
    const cline = healed.filter((h) => h.clientId === "cline");
    expect(cline.map((h) => h.path).sort()).toEqual([shared, vscode].sort());
    expect(readFileSync(shared, "utf8")).not.toContain("2.1.2");
    expect(readFileSync(vscode, "utf8")).not.toContain("2.1.2");
  });

  it("reads an editor copy only where the editor's storage directory exists", async () => {
    // selectSites is install's own filter, and the sweep applies the same
    // one: a copy whose editor has never run Cline is not a slot here. The
    // shared file is unconditional.
    const shared = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, JSON.stringify(CLINE_ENTRY, null, 2));
    const healed = await heal({ os: "linux" });
    expect(healed.filter((h) => h.clientId === "cline").map((h) => h.path)).toEqual([shared]);
  });

  it("reports a malformed editor copy separately, and still heals the shared file", async () => {
    const { shared, vscode } = seedClineFiles();
    // A copy the sweep cannot read INTO is named as such rather than folded
    // into "nothing stale here": the user may be sitting on a dead entry in
    // it. One bad copy must not stop the shared file being repaired.
    writeFileSync(vscode, '{ "mcpServers": { "mcp": \n');
    const r = await healResult({ os: "linux" });
    expect(r.healed.filter((h) => h.clientId === "cline").map((h) => h.path)).toEqual([shared]);
    const bad = r.unhealable.filter((u) => u.clientId === "cline");
    expect(bad.map((u) => u.path)).toEqual([vscode]);
    expect(bad[0].reason).toBe("malformed");
  });
});

describe("healStaleBrokerEntries -- the file's final line break", () => {
  // heal used to write the splice's output exactly as it came back, and a
  // splice leaves the bytes outside its own span alone -- so a client config
  // that did not end in a line break still did not after a heal, while
  // install, try and import all terminate what they write. The line break a
  // heal adds is the file's own (a bare LF on a CRLF file is mixed line
  // endings), and a file that already ends in one keeps exactly one.
  //
  // `env: {}` keeps every case on the fake home: an ambient CLAUDE_CONFIG_DIR
  // or CODEX_HOME would send the sweep to another file.
  const EOLS = [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ] as const;

  /** ~/.claude.json holding a broker entry for `entryPath`, in `eol`. */
  function claudeJson(entryPath: string, eol: string, terminated: boolean): string {
    const body = JSON.stringify(
      { mcpServers: { mcp: { command: OAM_BIN, args: ["run", "--no-check", entryPath] } } },
      null,
      2,
    );
    return body.split("\n").join(eol) + (terminated ? eol : "");
  }

  /** A Codex config.toml whose entry is NOT the last table. When it is last,
   *  the splice rewrites the file's tail itself and ends it in a line break;
   *  a sibling table after it is what leaves the tail to the file. */
  function codexToml(entryPath: string, eol: string, terminated: boolean): string {
    const lines = [
      "[mcp_servers.mcp]",
      `command = ${JSON.stringify(OAM_BIN)}`,
      `args = ["run", "--no-check", ${JSON.stringify(entryPath)}]`,
      "startup_timeout_sec = 60.0",
      "",
      "[projects.'/some/repo']",
      'trust_level = "trusted"',
    ];
    return lines.join(eol) + (terminated ? eol : "");
  }

  describe.each([
    { file: "~/.claude.json", clientId: "claude-code", at: () => join(home, ".claude.json"), build: claudeJson },
    {
      file: "a config.toml whose entry is not the last table",
      clientId: "codex-cli",
      at: () => join(home, ".codex", "config.toml"),
      build: codexToml,
    },
  ])("$file", ({ clientId, at, build }) => {
    it.each(EOLS)("%s with no final line break gets exactly one, in its own line ending", async (_, eol) => {
      const p = at();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, build(DEAD, eol, false));
      const healed = await heal({ env: {} });
      expect(healed.filter((h) => h.clientId === clientId).map((h) => h.path)).toEqual([p]);
      expect(readFileSync(p, "utf8")).toBe(build(liveEntry, eol, true));
    });

    it.each(EOLS)("%s already ending in a line break keeps exactly one", async (_, eol) => {
      const p = at();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, build(DEAD, eol, true));
      const healed = await heal({ env: {} });
      expect(healed.filter((h) => h.clientId === clientId).map((h) => h.path)).toEqual([p]);
      expect(readFileSync(p, "utf8")).toBe(build(liveEntry, eol, true));
    });
  });
});
