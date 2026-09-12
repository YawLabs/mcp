// The Continue target, end to end.
//
// Continue is the ONE row whose config file yaw-mcp creates and owns:
// `<continue global dir>/mcpServers/yaw-mcp.json` for the user scope and
// `<project>/.continue/mcpServers/yaw-mcp.json` for the project one. Continue's
// IDE core reads the `.json` files in those folders, so a dedicated block file
// needs no YAML reader, splices into nobody's settings, and is ours to assert
// WHOLE: where every other client's test can only check that our entry landed
// and the neighbours survived, these compare the entire file byte for byte.
//
// "the `.json` files" rather than "every `.json` file", deliberately: the
// loader reads that folder through `walkDir` with Continue's own
// DEFAULT_IGNORE_FILETYPES minus `config.json` and `settings.json`, so
// `appsettings.json`, `auth.json` and anything matching `*-lock.json` in it are
// SKIPPED (core/indexing/ignore.ts). `yaw-mcp.json` matches none of them, which
// is one of the reasons the file is named that and not `mcp.json`.
//
// WHAT THE VENDOR FACTS ARE, and where they were checked (continuedev/continue
// at main = 5522c6f, re-read 2026-09-12 with curl against raw.githubusercontent
// rather than a markdown-converting fetch):
//
//   * The GLOBAL folder is read, not just the workspace one. `loadJsonMcpConfigs`
//     (core/context/mcp/json/loadJsonMcpConfigs.ts) maps the workspace dirs to
//     `<dir>/.continue/mcpServers` and then, `if (includeGlobal)`, pushes
//     `getGlobalFolderWithName("mcpServers")`. Both call sites pass `true`:
//     core/config/yaml/loadYaml.ts (the config.yaml and Hub-agent path) and
//     core/config/load.ts (the legacy config.json path), which are the only two
//     branches core/config/profile/doLoadConfig.ts has. That is why the notes
//     say "whichever agent is selected".
//     It is CODE-VERIFIED AND UNDOCUMENTED: docs.continue.dev's MCP page names
//     only ".continue/mcpServers at the top level of your workspace" and never
//     mentions ~/.continue at all. The whole no-YAML decision rests on a path
//     with no documentation behind it -- see REPORT.md.
//   * `CONTINUE_GLOBAL_DIR` resolves a RELATIVE value against the process cwd
//     (core/util/paths.ts: `path.isAbsolute(v) ? v : path.resolve(process.cwd(), v)`),
//     and an unset or empty value falls back to `~/.continue`.
//   * Continue wraps `npx` in `cmd.exe /c` ITSELF on win32
//     (core/context/mcp/MCPConnection.ts, WINDOWS_BATCH_COMMANDS), and skips
//     that wrap when the Windows host is attached to a WSL remote. So the
//     broker entry is a bare `npx`.
//   * No file watcher covers either mcpServers folder. VsCodeExtension.ts
//     (extensions/vscode) has exactly four: fs.watchFile on config.json,
//     config.yaml and config.ts, and fs.watch on the global `rules` directory.
//     It also forwards VS Code's own onDidSaveTextDocument / onDidCreateFiles,
//     so opening this file IN the editor and saving it does reload the config
//     -- but VS Code's typings say onDidCreateFiles "is *not* fired when files
//     change on disk, e.g triggered by another application", which is exactly
//     what a yaw-mcp write is. Hence "reload-window" rather than "live", and
//     hence the note telling the user to reload. JetBrains is UNVERIFIED: its
//     plugin forwards VFS_CHANGES, and whether an external write under
//     ~/.continue reaches the IntelliJ VFS without a refresh was not measured.
//
// HERMETIC: a synthetic home per test, the oam probe and the bundles.json read
// both seamed, and nothing reads the developer's own client config. The one
// deliberate exception is the relative-`CONTINUE_GLOBAL_DIR` case, whose whole
// subject is the PROCESS cwd -- it asserts against `process.cwd()`, which is
// what Continue itself would use.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reloadDoneClause } from "../client-config.js";
import { runDoctor } from "../doctor-cmd.js";
import { type BundlesSummary, runInstall, runUninstall } from "../install-cmd.js";
import {
  buildLaunchEntry,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallOS,
  resolveInstallPath,
} from "../install-targets.js";
import type { OamProbe } from "../oam-spawn.js";

/** A single backslash, from its code point. A typed escape is one backslash
 *  level away from collapsing into something else when a file is written
 *  through a shell -- a class of bug this repo has shipped -- and the Windows
 *  display strings below are the only place in this file that needs the
 *  character. It is also an INDEPENDENT spelling of the separator the row
 *  itself joins with, so a regression there cannot rewrite the expectation. */
const BACKSLASH = String.fromCharCode(92);
/** TAB and CR, same reasoning, for the hand-edited user file. */
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const CRLF = CR + String.fromCharCode(10);

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "continue");

/** One byte-exact fixture. They are stored LF-only (see that directory's
 *  README) and read as text, so the string is the file. */
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), "utf8");
}

const FRESH = fixture("fresh");
const DRIFT_CMD = fixture("drift-cmd");
const LEGACY_KEY = fixture("legacy-key");
const UNINSTALLED = fixture("uninstalled");
const TRUNCATED = fixture("truncated");
const CONTAINER_ARRAY = fixture("container-array");
const CONTAINER_NULL = fixture("container-null");

/** A hand-edited user file: CRLF, tab indent, a leading comment, a sibling
 *  server and a TRAILING comment on that sibling's line. Every one of those is
 *  a thing a splice can eat, and the four together are what "round-trips"
 *  means for this target. Built here rather than committed as a fixture
 *  because `.gitattributes` normalises a committed CRLF file to LF. */
const USER_FILE =
  [
    "{",
    `${TAB}// my servers`,
    `${TAB}"mcpServers": {`,
    `${TAB}${TAB}"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]} // keep`,
    `${TAB}}`,
    "}",
  ].join(CRLF) + CRLF;

/** The same file after `install continue`: our entry appended AFTER the
 *  sibling, in the file's own line ending and its own tab indent, with the
 *  separating comma placed before the sibling's trailing comment rather than
 *  after it. */
const USER_FILE_INSTALLED =
  [
    "{",
    `${TAB}// my servers`,
    `${TAB}"mcpServers": {`,
    `${TAB}${TAB}"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}, // keep`,
    `${TAB}${TAB}"mcp": {`,
    `${TAB}${TAB}${TAB}"command": "npx",`,
    `${TAB}${TAB}${TAB}"args": [`,
    `${TAB}${TAB}${TAB}${TAB}"-y",`,
    `${TAB}${TAB}${TAB}${TAB}"@yawlabs/mcp@latest"`,
    `${TAB}${TAB}${TAB}]`,
    `${TAB}${TAB}}`,
    `${TAB}}`,
    "}",
  ].join(CRLF) + CRLF;

/** oam absent, so the entry written is the npx one on every machine. Without
 *  it the bytes asserted below would depend on whether the box running the
 *  tests happens to have oam plus a durable @yawlabs/mcp install. */
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

/** The bundles.json summary, seamed so no test walks up from the real cwd
 *  looking for one. The path is the fixture's own string and is never compared
 *  against a resolved one. */
const BUNDLES_EMPTY = (): BundlesSummary => ({
  state: "empty",
  count: 0,
  path: "/synth/.yaw-mcp/bundles.json",
  warnings: [],
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (arr: string[]): NodeJS.WritableStream =>
    new Writable({
      write(chunk: Buffer, _enc, cb): void {
        arr.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    io: { stdin: process.stdin, stdout: sink(out), stderr: sink(err), isTTY: false },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

let home: string;
let projectDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-continue-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "yaw-mcp-continue-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Where the user-scope file lands for a run with this synthetic home. Built
 *  with `join` from node:path, never a POSIX literal: `join` is what the row
 *  uses, so on a Windows runner both sides come back with backslashes and
 *  agree. */
function userFilePath(): string {
  return join(home, ".continue", "mcpServers", "yaw-mcp.json");
}

function seed(text: string, at: string = userFilePath()): void {
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, text, "utf8");
}

function read(at: string = userFilePath()): string {
  return readFileSync(at, "utf8");
}

/** One `install continue` run against the synthetic home. */
async function install(opts: { os?: InstallOS; scope?: "user" | "project"; repair?: boolean; force?: boolean } = {}) {
  const cap = captureIo();
  const result = await runInstall({
    clientId: "continue",
    scope: opts.scope ?? "user",
    os: opts.os ?? "linux",
    home,
    cwd: projectDir,
    projectDir: opts.scope === "project" ? projectDir : undefined,
    repair: opts.repair,
    force: opts.force,
    io: cap.io,
    oamProbe: OAM_ABSENT,
    bundlesSummary: BUNDLES_EMPTY,
  });
  return { result, stdout: cap.stdout(), stderr: cap.stderr() };
}

async function uninstall(clientId: "continue" | "cursor" = "continue") {
  const cap = captureIo();
  const result = await runUninstall({
    clientId,
    scope: "user",
    os: "linux",
    home,
    cwd: projectDir,
    force: true,
    io: cap.io,
  });
  return { result, stdout: cap.stdout() };
}

async function list() {
  const cap = captureIo();
  await runInstall({ listOnly: true, os: "linux", home, cwd: projectDir, io: cap.io });
  return cap.stdout();
}

/** The cells of one `install --list` row, split on the two-space gutter the
 *  table pads with so a single space inside a cell stays in it. */
function listRow(out: string, scope: string): string[] {
  const rows = out
    .split("\n")
    .map((l) => l.trim().split(/ {2,}/))
    .filter((cells) => cells[0] === "Continue" && cells[1] === scope);
  expect(rows, `exactly one Continue (${scope}) row in:\n${out}`).toHaveLength(1);
  return rows[0];
}

async function doctor() {
  const out: string[] = [];
  await runDoctor({
    home,
    cwd: projectDir,
    os: "linux",
    env: {},
    out: (s) => out.push(s),
    err: () => {},
    skipRegistryCheck: true,
    oamProbe: OAM_ABSENT,
  });
  return out.join("");
}

const row = INSTALL_TARGETS.find((t) => t.clientId === "continue");
if (row === undefined) throw new Error("no continue row in INSTALL_TARGETS");

// ---------------------------------------------------------------------------

describe("the fixtures themselves", () => {
  it("are stored LF-only, so a checkout cannot quietly change what is asserted", () => {
    // `.gitattributes` says `* text=auto eol=lf`. If that ever stopped holding,
    // every byte-exact expectation below would shift by one byte per line and
    // the failure would read as a splicer regression. This is the check that
    // names the real cause instead.
    for (const [name, text] of Object.entries({
      FRESH,
      DRIFT_CMD,
      LEGACY_KEY,
      UNINSTALLED,
      TRUNCATED,
      CONTAINER_ARRAY,
      CONTAINER_NULL,
    })) {
      expect(text.includes(CR), `${name} carries a CR`).toBe(false);
      expect(text.includes(TAB), `${name} carries a TAB`).toBe(false);
    }
    // And the sizes the design named, so a fixture edited by hand is caught
    // here rather than as a mystifying diff in an install test.
    expect(FRESH.length).toBe(137);
    expect(DRIFT_CMD.length).toBe(166);
    expect(LEGACY_KEY.length).toBe(141);
    expect(UNINSTALLED.length).toBe(26);
    expect(TRUNCATED.length).toBe(57);
  });

  it("builds the hand-edited user file out of real CR and TAB bytes", () => {
    // The point of the round-trip test is the bytes, so this pins that the
    // constructed string actually carries them -- a mangled escape would leave
    // the literal characters and the round trip would prove nothing.
    expect(USER_FILE.charCodeAt(USER_FILE.indexOf("{") + 1)).toBe(13);
    expect(USER_FILE).toContain(TAB);
    expect(USER_FILE.length).toBe(147);
    expect(USER_FILE_INSTALLED.length).toBe(245);
    // Every line ending is CRLF: no bare LF survives once the CRLFs are gone.
    expect(USER_FILE.split(CRLF).join("")).not.toContain(String.fromCharCode(10));
  });
});

describe("the continue row, as data", () => {
  // The invariant is APPENDED-NEVER-INSERTED, not "continue is the last row":
  // `try`'s auto-detect returns the first usable probe slot in array order, so
  // inserting a row AHEAD of the six that shipped in 1.0.0 would silently
  // change which client an existing user's `try` picks. Landing a row after
  // them cannot. This test asserted `at(-1)` while continue happened to be the
  // newest row; codex-cli landed after it, so the literal-last form was a
  // statement about merge order rather than about the invariant.
  it("is APPENDED after the rows that shipped in 1.0.0, so try's auto-detect picks the same client it did before", () => {
    const ids = INSTALL_TARGETS.map((t) => t.clientId);
    const shippedIn100 = ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "gemini-cli"];
    expect(ids.slice(0, shippedIn100.length)).toEqual(shippedIn100);
    expect(ids.indexOf("continue")).toBeGreaterThanOrEqual(shippedIn100.length);
    expect(ids[0]).toBe("claude-code");
  });

  it("declares a DEDICATED jsonc file keyed mcpServers, on every OS, user before project", () => {
    expect(row.config).toEqual({ format: "jsonc", root: "mcpServers", ownership: "dedicated" });
    expect([...row.availableOn].sort()).toEqual(["linux", "macos", "windows"]);
    expect(row.scopes.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(row.scopes[1].requiresProjectDir).toBe(true);
    // No `local` scope, and no strict-JSON narrowing on either.
    expect(row.scopes.some((s) => s.strictJson === true)).toBe(false);
  });

  it("reloads the WINDOW rather than restarting the editor", () => {
    expect(row.reload).toBe("reload-window");
    expect(reloadDoneClause(row.reload, row.label)).toBe("Reload the IDE window to pick up the new MCP server.");
    // Not vacuous: the default every older row still takes says something else.
    expect(reloadDoneClause(undefined, row.label)).toBe("Restart it to pick up the new MCP server.");
  });

  it("takes a BARE npx for the broker on Windows, and keeps the escaped wrap for a trial", () => {
    expect(row.entry?.windowsLaunch).toEqual({ broker: "bare", upstream: "cmd-wrap" });
    // What that policy makes install write. Continue adds `cmd.exe /c` itself
    // for any command in its WINDOWS_BATCH_COMMANDS list, and deliberately does
    // NOT when the Windows host is on a WSL remote -- so a pre-wrapped entry is
    // wrong in exactly the mode Continue went out of its way to support.
    expect(buildLaunchEntry({ os: "windows", windowsWrap: false })).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp@latest"],
    });
    // Not vacuous: the default for every other client is the wrap.
    expect(buildLaunchEntry({ os: "windows" })).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"],
    });
    // And a trial entry keeps the wrap even under this row's policy: it names a
    // third-party launcher whose args have to survive cmd's own parse, which is
    // what escapeCmdArg exists for. Continue does not double-wrap it -- `cmd`
    // is not in WINDOWS_BATCH_COMMANDS.
    const upstream = buildLaunchEntry({
      os: "windows",
      windowsWrap: false,
      upstream: { command: "npx", args: ["-y", "some-server"] },
    });
    expect(upstream.command).toBe("cmd");
    expect(upstream.args[0]).toBe("/c");
  });
});

describe("where the file goes", () => {
  it("resolves user and project scope per OS", () => {
    const cases: Array<{ os: InstallOS; display: string }> = [
      { os: "linux", display: "~/.continue/mcpServers/yaw-mcp.json" },
      { os: "macos", display: "~/.continue/mcpServers/yaw-mcp.json" },
      {
        os: "windows",
        display: `%USERPROFILE%${BACKSLASH}.continue${BACKSLASH}mcpServers${BACKSLASH}yaw-mcp.json`,
      },
    ];
    for (const { os, display } of cases) {
      const user = resolveInstallPath({ clientId: "continue", scope: "user", os, home });
      expect(user.absolute, os).toBe(join(home, ".continue", "mcpServers", "yaw-mcp.json"));
      expect(user.display, os).toBe(display);
      expect(user.containerPath, os).toEqual(["mcpServers"]);
    }

    const projectDisplays: Array<{ os: InstallOS; display: string }> = [
      { os: "linux", display: "<project folder>/.continue/mcpServers/yaw-mcp.json" },
      {
        os: "windows",
        display: `<project folder>${BACKSLASH}.continue${BACKSLASH}mcpServers${BACKSLASH}yaw-mcp.json`,
      },
    ];
    for (const { os, display } of projectDisplays) {
      const project = resolveInstallPath({ clientId: "continue", scope: "project", os, home, projectDir });
      expect(project.absolute, os).toBe(join(projectDir, ".continue", "mcpServers", "yaw-mcp.json"));
      expect(project.display, os).toBe(display);
      expect(project.containerPath, os).toEqual(["mcpServers"]);
    }
  });

  it("follows an ABSOLUTE CONTINUE_GLOBAL_DIR and shows it verbatim", () => {
    const redirected = resolveInstallPath({
      clientId: "continue",
      scope: "user",
      os: "linux",
      home,
      clientEnv: { continueGlobalDir: "/elsewhere" },
    });
    expect(redirected.absolute).toBe(join("/elsewhere", "mcpServers", "yaw-mcp.json"));
    // Shown as-is, the CLAUDE_CONFIG_DIR precedent: a `~` spelling would hide
    // the very redirect that moved the file.
    expect(redirected.display).toBe(redirected.absolute);
  });

  it("resolves a RELATIVE CONTINUE_GLOBAL_DIR against the process cwd, not against home", () => {
    // Continue's own rule, from core/util/paths.ts:
    //   path.isAbsolute(v) ? v : path.resolve(process.cwd(), v)
    // `process.cwd()` is spelled out here rather than reached through
    // node:path.resolve so this expectation does not go through the same
    // function the row does. `home` is a tmpdir, so a row that resolved
    // against home instead would land somewhere else entirely and this fails.
    const relative = resolveInstallPath({
      clientId: "continue",
      scope: "user",
      os: "linux",
      home,
      clientEnv: { continueGlobalDir: "conf" },
    });
    expect(relative.absolute).toBe(join(process.cwd(), "conf", "mcpServers", "yaw-mcp.json"));
    expect(relative.display).toBe(relative.absolute);
    expect(relative.absolute.startsWith(home)).toBe(false);
    // A relative value is inherently a guess -- the IDE resolves it against
    // ITS process cwd, not ours -- which is what --help says and why an
    // absolute value is the safe one.
  });

  it("treats an EMPTY CONTINUE_GLOBAL_DIR as unset, exactly as Continue's core does", () => {
    // paths.ts guards with `if (configPath)`, so "" falls through to
    // `path.join(os.homedir(), ".continue")`. Anything else would resolve an
    // empty-but-set variable (ordinary in CI) to the process cwd.
    const empty = resolveInstallPath({
      clientId: "continue",
      scope: "user",
      os: "linux",
      home,
      clientEnv: { continueGlobalDir: "" },
    });
    expect(empty.absolute).toBe(join(home, ".continue", "mcpServers", "yaw-mcp.json"));
    expect(empty.display).toBe("~/.continue/mcpServers/yaw-mcp.json");
  });

  it("ignores CONTINUE_GLOBAL_DIR for the PROJECT scope, which is anchored to the folder", () => {
    const project = resolveInstallPath({
      clientId: "continue",
      scope: "project",
      os: "linux",
      home,
      projectDir,
      clientEnv: { continueGlobalDir: "/elsewhere" },
    });
    expect(project.absolute).toBe(join(projectDir, ".continue", "mcpServers", "yaw-mcp.json"));
  });
});

describe("install creates the file it owns", () => {
  it("writes the fresh document byte for byte, and the same bytes on every OS", async () => {
    const written: string[] = [];
    for (const os of ["linux", "macos", "windows"] as const) {
      // A fresh home per OS: the point is the CREATE path, not an overwrite.
      home = mkdtempSync(join(tmpdir(), "yaw-mcp-continue-home-"));
      const { result } = await install({ os });
      expect(result.exitCode, os).toBe(0);
      expect(read(), os).toBe(FRESH);
      written.push(read());
    }
    // Identical across the three, which is the Windows-launch assertion too:
    // a `cmd /c` entry on the windows run would be 29 bytes longer.
    expect(new Set(written).size).toBe(1);
  });

  it("creates the mcpServers folder, which is the only new filesystem behaviour", async () => {
    // Nothing under ~/.continue exists before the run -- not the folder, not
    // its parent. Every other client's file sits in a directory the client
    // itself made.
    expect(() => statSync(join(home, ".continue"))).toThrow();
    await install();
    expect(statSync(join(home, ".continue", "mcpServers")).isDirectory()).toBe(true);
  });

  it("prints the client note and the reload-window Done line", async () => {
    const { stdout } = await install();
    expect(stdout).toContain(`Note: ${row.notes}`);
    expect(stdout).toContain("Done: Continue is configured. Reload the IDE window to pick up the new MCP server.");
    expect(stdout).not.toContain("Restart it to pick up");
  });

  it("is a no-op on a second run: same bytes, same mtime, no note", async () => {
    await install();
    const before = statSync(userFilePath()).mtimeMs;
    const { result, stdout } = await install();
    expect(result.exitCode).toBe(0);
    expect(read()).toBe(FRESH);
    expect(statSync(userFilePath()).mtimeMs).toBe(before);
    expect(stdout).toContain("Nothing to do: Continue is already configured.");
    // The note rides on a WRITE. Printing it over a no-op would tell the user
    // to reload a window for a change that did not happen.
    expect(stdout).not.toContain("Note: Continue's IDE extensions");
  });

  it("writes the project scope into the project folder", async () => {
    const { result } = await install({ scope: "project" });
    expect(result.exitCode).toBe(0);
    expect(read(join(projectDir, ".continue", "mcpServers", "yaw-mcp.json"))).toBe(FRESH);
  });
});

describe("install repairs what is already there", () => {
  it("refuses a cmd /c entry off a TTY, naming the difference", async () => {
    // The refusal and its diff go to STDERR, so a script that pipes stdout
    // still sees why nothing was written.
    seed(DRIFT_CMD);
    const { result, stderr } = await install();
    expect(result.exitCode).toBe(2);
    expect(result.collisionRefused).toBe(true);
    expect(stderr).toContain('command: "cmd" -> "npx"');
    expect(stderr).toContain('args: ["/c","npx","-y","@yawlabs/mcp@latest"] -> ["-y","@yawlabs/mcp@latest"]');
    expect(stderr).toContain("Re-run with --repair");
    // A refusal writes nothing.
    expect(read()).toBe(DRIFT_CMD);
  });

  it("--repair rewrites the drifted entry to exactly the fresh bytes", async () => {
    seed(DRIFT_CMD);
    const { result } = await install({ repair: true });
    expect(result.exitCode).toBe(0);
    expect(read()).toBe(FRESH);
  });

  it("trims a legacy yaw-mcp key in the same pass and lands the fresh bytes", async () => {
    // Nothing yaw-mcp has ever shipped wrote this file, so a legacy key in it
    // can only be a hand edit -- but the trim is the shared install pass, not
    // a Continue branch, so it works here like everywhere else.
    seed(LEGACY_KEY);
    const { result, stdout } = await install();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Removed the legacy "yaw-mcp" entry');
    expect(read()).toBe(FRESH);
  });

  it("refuses a truncated file and leaves its bytes alone", async () => {
    seed(TRUNCATED);
    const { result, stderr } = await install();
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("is not valid JSON");
    expect(stderr).toContain("fix the JSON by hand, or move the file aside, then re-run");
    expect(read()).toBe(TRUNCATED);
  });

  it("refuses a LIST-shaped mcpServers, and repairs a null one", async () => {
    // The list shape is what config.yaml uses, so it is the plausible paste --
    // and it can hold real servers, so replacing it is not a repair.
    seed(CONTAINER_ARRAY);
    const blocked = await install();
    expect(blocked.result.exitCode).toBe(1);
    expect(blocked.stderr).toContain('"mcpServers" in');
    expect(blocked.stderr).toContain("is an array of 1, not a JSON object -- refusing to overwrite it");
    expect(read()).toBe(CONTAINER_ARRAY);

    // null holds nothing, so it is replaced and the entry written.
    seed(CONTAINER_NULL);
    const repaired = await install();
    expect(repaired.result.exitCode).toBe(0);
    expect(repaired.stdout).toContain("is null, not an object -- replaced it with an empty object");
    expect(read()).toContain(`"${ENTRY_NAME}"`);
  });
});

describe("a hand-edited file round-trips", () => {
  it("keeps CRLF, tab indent and both comments, and appends after the sibling", async () => {
    seed(USER_FILE);
    const { result } = await install();
    expect(result.exitCode).toBe(0);
    expect(read()).toBe(USER_FILE_INSTALLED);
  });

  it("uninstall puts those exact bytes back", async () => {
    seed(USER_FILE);
    await install();
    const { result } = await uninstall();
    expect(result.exitCode).toBe(0);
    expect(read()).toBe(USER_FILE);
  });
});

describe("uninstall", () => {
  it("leaves the file and the folder, holding an empty container", async () => {
    // Continue reads `{"mcpServers": {}}` as zero servers with no error, so the
    // leftover is inert -- and leaving it keeps uninstall symmetrical with
    // every other client, none of which deletes a file either.
    await install();
    const { result, stdout } = await uninstall();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Removed the "mcp" entry.');
    expect(read()).toBe(UNINSTALLED);
    expect(statSync(join(home, ".continue", "mcpServers")).isDirectory()).toBe(true);
  });

  it("says exactly what a SHARED client's uninstall says -- `ownership` changes no wording", async () => {
    // `config.ownership: "dedicated"` is DATA the core carries and nothing in
    // src/ reads. This pins that: the Done line for the one dedicated-file
    // client differs from a shared client's only in the label and the id it
    // tells you to re-run. A future change that makes the wording depend on
    // ownership -- "the file stays behind", say -- fails here, which is the
    // point at which the comment on the row can start claiming it.
    await install();
    const dedicated = await uninstall("continue");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      `{"mcpServers":{"${ENTRY_NAME}":{"command":"npx","args":["-y","@yawlabs/mcp@latest"]}}}\n`,
    );
    const shared = await uninstall("cursor");
    const doneLine = (s: string): string => {
      const line = s.split("\n").find((l) => l.startsWith("Done:"));
      expect(line, `no Done line in:\n${s}`).toBeDefined();
      return line ?? "";
    };
    expect(doneLine(dedicated.stdout).replace("Continue", "X").replace("continue", "Y")).toBe(
      doneLine(shared.stdout).replace("Cursor", "X").replace("cursor", "Y"),
    );
    expect(doneLine(dedicated.stdout)).not.toContain("file");
  });
});

describe("--list and doctor", () => {
  it("shows two Continue rows whose status walks not installed -> installed -> no-entries", async () => {
    const before = await list();
    expect(listRow(before, "user")[3]).toBe("not installed");
    expect(listRow(before, "project")[3]).toBe("not installed");
    // The user row's path cell is the `~`-shortened display; the project row's
    // is absolute. Separators are the HOST's, so they are normalised here --
    // the per-OS display spellings are asserted against the resolver above.
    const slash = (s: string) => s.split(BACKSLASH).join("/");
    expect(slash(listRow(before, "user")[2])).toBe("~/.continue/mcpServers/yaw-mcp.json");
    expect(slash(listRow(before, "project")[2])).toBe(slash(join(projectDir, ".continue/mcpServers/yaw-mcp.json")));

    await install();
    expect(listRow(await list(), "user")[3]).toBe("installed");

    await uninstall();
    // Not "not installed": the file is still there and still ours, it just
    // holds nothing. That distinction is what tells a user whether a re-install
    // would create a file or fill one in.
    expect(listRow(await list(), "user")[3]).toBe("no-entries");
  });

  it("reports the entry, and names a malformed file as one install will not overwrite", async () => {
    await install();
    expect(await doctor()).toContain('Continue (user): OK -- has "mcp" entry');

    seed(TRUNCATED);
    const malformed = await doctor();
    expect(malformed).toContain("Continue (user): exists but JSON is malformed -- install refuses to overwrite it");
    expect(malformed).toContain("then run `yaw-mcp install continue`");
  });

  it("offers the project scope by name when only the user scope is wired", async () => {
    await install();
    expect(await doctor()).toContain(
      "Continue (project): not configured -- run `yaw-mcp install continue --scope project`",
    );
  });
});
