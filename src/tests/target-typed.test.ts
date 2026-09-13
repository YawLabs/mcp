// The typed target, end to end.
//
// typed (https://typed.cloud) gets a file of its own, `<home>/.config/typed/
// mcp.json`, on every OS. What these tests pin, and the typed-side facts each
// rests on (the contract with the typed CLI; released typed 1.5.0 does not read
// the file yet, which the row's notes say):
//
//   * the path is os.homedir()-based on EVERY OS, Windows included, and follows
//     none of CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME or APPDATA -- typed resolves
//     every file it keeps under ~/.config/typed that way;
//   * the file is STRICT JSON (typed reads it with JSON.parse), so install
//     refuses to splice into a commented one rather than print Done over a
//     file typed loads nothing from;
//   * the broker entry is a BARE npx on Windows: typed resolves the `.cmd` shim
//     itself;
//   * typed reads `permissions.allow` from `<CLAUDE_CONFIG_DIR>/settings.json`
//     when that variable is non-empty and `~/.claude/settings.json` otherwise
//     -- exactly the file `resolveClaudeCodeSettingsPath("user", ...)` names --
//     so `install typed` adds the same `mcp__mcp__*` grant Claude Code's
//     user-scope install adds, to the same file;
//   * that grant is therefore SHARED, and `uninstall` of either row keeps it
//     while the other row still has its "mcp" entry.
//
// HERMETIC: a synthetic home per test, the oam probe and the bundles.json read
// seamed, every env value passed in rather than read.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientChoices } from "../client-aliases.js";
import { reloadDoneClause } from "../client-config.js";
import { runDoctor } from "../doctor-cmd.js";
import {
  type BundlesSummary,
  INSTALL_USAGE,
  parseInstallArgs,
  parseUninstallArgs,
  runInstall,
  runUninstall,
} from "../install-cmd.js";
import {
  CLAUDE_CODE_ALLOW_PATTERN,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallOS,
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "../install-targets.js";
import type { OamProbe } from "../oam-spawn.js";

/** A single backslash, from its code point -- an escape written through a
 *  shell collapses, and this is also an independent spelling of the separator
 *  the row joins its Windows display path with. */
const BACKSLASH = String.fromCharCode(92);
const LF = String.fromCharCode(10);

/** What `install typed` writes into an absent file, byte for byte, on every
 *  OS: two-space JSON, a bare npx (no `cmd /c`, even on Windows), and a
 *  trailing newline. */
const FRESH = [
  "{",
  '  "mcpServers": {',
  '    "mcp": {',
  '      "command": "npx",',
  '      "args": [',
  '        "-y",',
  '        "@yawlabs/mcp@latest"',
  "      ]",
  "    }",
  "  }",
  "}",
  "",
].join(LF);

const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

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
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-typed-home-"));
  cwd = mkdtempSync(join(tmpdir(), "yaw-mcp-typed-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const row = INSTALL_TARGETS.find((t) => t.clientId === "typed");
if (row === undefined) throw new Error("no typed row in INSTALL_TARGETS");

/** typed's file for this run's synthetic home. Built with `join`, never a
 *  POSIX literal, so it agrees with the row on a Windows runner. */
const typedFile = (): string => join(home, ".config", "typed", "mcp.json");
const userSettings = (): string => join(home, ".claude", "settings.json");
const claudeJson = (): string => join(home, ".claude.json");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function allowOf(path: string): unknown[] {
  const parsed = JSON.parse(read(path)) as { permissions?: { allow?: unknown[] } };
  return parsed.permissions?.allow ?? [];
}

type Client = "typed" | "claude-code";

async function install(
  clientId: Client,
  opts: {
    os?: InstallOS;
    claudeConfigDir?: string;
    dryRun?: boolean;
    projectDir?: string;
    scope?: "user" | "project";
  } = {},
) {
  const cap = captureIo();
  const result = await runInstall({
    clientId,
    scope: opts.scope ?? "user",
    os: opts.os ?? "linux",
    home,
    cwd,
    projectDir: opts.projectDir,
    claudeConfigDir: opts.claudeConfigDir,
    dryRun: opts.dryRun,
    io: cap.io,
    oamProbe: OAM_ABSENT,
    bundlesSummary: BUNDLES_EMPTY,
  });
  return { result, stdout: cap.stdout(), stderr: cap.stderr() };
}

async function uninstall(
  clientId: Client,
  opts: { claudeConfigDir?: string; dryRun?: boolean; projectDir?: string; scope?: "user" | "project" } = {},
) {
  const cap = captureIo();
  const result = await runUninstall({
    clientId,
    scope: opts.scope ?? "user",
    os: "linux",
    home,
    cwd,
    projectDir: opts.projectDir,
    claudeConfigDir: opts.claudeConfigDir,
    dryRun: opts.dryRun,
    force: true,
    io: cap.io,
  });
  return { result, stdout: cap.stdout(), stderr: cap.stderr() };
}

// ---------------------------------------------------------------------------

describe("the typed row, as data", () => {
  it("is APPENDED after every row that landed before it", () => {
    // `try`'s auto-detect returns the first usable probe slot in table order,
    // so an insert would change which client an existing user's `try` picks.
    const ids = INSTALL_TARGETS.map((t) => t.clientId);
    expect(ids.slice(0, 10)).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "windsurf",
      "gemini-cli",
      "zed",
      "cline",
      "continue",
      "codex-cli",
    ]);
    expect(ids.indexOf("typed")).toBeGreaterThan(ids.indexOf("codex-cli"));
  });

  it("declares a STRICT json file keyed mcpServers, on every OS, user scope only", () => {
    expect(row.config).toEqual({ format: "json", root: "mcpServers" });
    expect([...row.availableOn].sort()).toEqual(["linux", "macos", "windows"]);
    expect(row.notConfigurableOn).toBeUndefined();
    // ONE scope. <project>/.mcp.json is claude-code's project scope (and the
    // `mcp` alias); a second row on it would double-report it.
    expect(row.scopes.map((s) => s.scope)).toEqual(["user"]);
    expect(row.scopes[0].requiresProjectDir).toBe(false);
    expect(() =>
      resolveInstallPath({ clientId: "typed", scope: "project", os: "linux", home, projectDir: cwd }),
    ).toThrow("Client typed does not support scope project");
  });

  it("restarts to pick up a change, shares Claude Code's grant, and takes a bare npx on Windows", () => {
    expect(row.reload).toBe("restart");
    expect(reloadDoneClause(row.reload, row.label)).toBe("Restart it to pick up the new MCP server.");
    expect(row.hooks).toEqual({ permissionsPatch: "claude-code" });
    expect(row.entry?.windowsLaunch).toEqual({ broker: "bare", upstream: "cmd-wrap" });
  });

  it("says what a user needs in its notes, in ASCII", () => {
    const notes = row.notes ?? "";
    expect(notes).toContain("newer than 1.5.0");
    expect(notes).toContain("`yaw-mcp install mcp`");
    expect(notes).toContain("`yaw-mcp install claude-code`");
    expect(notes).toContain("~/.claude.json");
    // install prints the notes verbatim; a non-ASCII byte turns to mojibake on
    // a Windows console whose codepage is not UTF-8.
    expect([...notes].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)).toBe(true);
  });

  it("is a choice every client verb accepts", () => {
    expect(clientChoices("install")).toContain("typed");
    expect(clientChoices("try")).toContain("typed");
    expect(INSTALL_USAGE).toContain("|typed|");
    const i = parseInstallArgs(["typed"]);
    expect(i.ok && i.options.clientId).toBe("typed");
    const u = parseUninstallArgs(["typed", "-y"]);
    expect(u.ok && u.options.clientId).toBe("typed");
  });

  it("names both grant-sharing clients in uninstall's usage, derived from the rows' hook", () => {
    const usage = parseUninstallArgs([]);
    expect(usage.ok).toBe(false);
    const text = usage.ok ? "" : usage.error;
    expect(text).toContain(
      `and for Claude Code and typed drops${LF}  ${CLAUDE_CODE_ALLOW_PATTERN} from permissions.allow`,
    );
    expect(text).toContain("keeps the grant and says so");
  });
});

describe("where the file goes", () => {
  it("resolves <home>/.config/typed/mcp.json on every OS, with each OS's display spelling", () => {
    const cases: Array<{ os: InstallOS; display: string }> = [
      { os: "linux", display: "~/.config/typed/mcp.json" },
      { os: "macos", display: "~/.config/typed/mcp.json" },
      { os: "windows", display: ["%USERPROFILE%", ".config", "typed", "mcp.json"].join(BACKSLASH) },
    ];
    for (const { os, display } of cases) {
      const r = resolveInstallPath({ clientId: "typed", scope: "user", os, home });
      expect(r.absolute, os).toBe(typedFile());
      expect(r.display, os).toBe(display);
      expect(r.containerPath, os).toEqual(["mcpServers"]);
    }
  });

  it("follows none of CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME or APPDATA", () => {
    // typed resolves this file from os.homedir() alone. CLAUDE_CONFIG_DIR in
    // particular is a disposable overlay in a Yaw Mode pane -- following it
    // would write an entry that is gone when the pane closes.
    for (const os of ["linux", "macos", "windows"] as const) {
      const redirected = resolveInstallPath({
        clientId: "typed",
        scope: "user",
        os,
        home,
        appData: join(home, "elsewhere-appdata"),
        claudeConfigDir: join(home, "overlay"),
        clientEnv: {
          claudeConfigDir: join(home, "overlay"),
          xdgConfigHome: join(home, "xdg"),
          appData: join(home, "elsewhere-appdata"),
        },
      });
      expect(redirected.absolute, os).toBe(typedFile());
    }
  });
});

describe("install writes typed's strict-JSON file", () => {
  it("creates the file with exactly the fresh bytes, and the same bytes on every OS", async () => {
    const written: string[] = [];
    for (const os of ["linux", "macos", "windows"] as const) {
      rmSync(join(home, ".config"), { recursive: true, force: true });
      const { result } = await install("typed", { os });
      expect(result.exitCode, os).toBe(0);
      expect(read(typedFile()), os).toBe(FRESH);
      written.push(read(typedFile()));
    }
    // Identical across the three, which is the bare-npx assertion on Windows:
    // a `cmd /c` entry would carry "cmd" and "/c".
    expect(new Set(written).size).toBe(1);
    // STRICT: what typed's JSON.parse reads.
    expect(JSON.parse(FRESH)).toEqual({ mcpServers: { mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } } });
  });

  it("prints the row's note and the restart Done line", async () => {
    const { stdout } = await install("typed");
    expect(stdout).toContain(`Note: ${row.notes}`);
    expect(stdout).toContain("Done: typed is configured. Restart it to pick up the new MCP server.");
  });

  it("refuses a commented file, which typed would load no server from, and leaves its bytes", async () => {
    const commented = ["{", "  // mine", '  "mcpServers": {', '    "fs": { "command": "node" }', "  }", "}", ""].join(
      LF,
    );
    seed(typedFile(), commented);
    const { result, stderr } = await install("typed");
    expect(result.exitCode).toBe(1);
    expect(result.written).toEqual([]);
    expect(stderr).toContain("comments or trailing commas");
    expect(read(typedFile())).toBe(commented);
    // And no grant either: the refusal returns before the settings patch.
    expect(existsSync(userSettings())).toBe(false);
  });

  it("keeps a sibling server and adds ours after it", async () => {
    seed(typedFile(), '{\n  "mcpServers": {\n    "fs": { "command": "node", "args": [] }\n  }\n}\n');
    const { result } = await install("typed");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(read(typedFile())) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["fs", ENTRY_NAME]);
  });
});

describe("install adds the mcp__mcp__* grant typed reads", () => {
  it("unions the grant into ~/.claude/settings.json and names both files it wrote", async () => {
    const { result, stdout } = await install("typed");
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(result.written).toEqual([typedFile(), userSettings()]);
    expect(stdout).toContain(`Wrote ${userSettings()} (added ${CLAUDE_CODE_ALLOW_PATTERN} to permissions.allow)`);
  });

  it("lands the grant where typed's reader looks: <CLAUDE_CONFIG_DIR>/settings.json when set, mcp.json unmoved", async () => {
    const cfg = join(home, "overlay");
    const { result } = await install("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(allowOf(join(cfg, "settings.json"))).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(existsSync(userSettings())).toBe(false);
    // typed's own file does NOT follow the variable.
    expect(read(typedFile())).toBe(FRESH);
    expect(existsSync(join(cfg, ".config"))).toBe(false);
  });

  it("treats an EMPTY CLAUDE_CONFIG_DIR as unset, as typed's truthiness check does", async () => {
    // typed: `env.CLAUDE_CONFIG_DIR ? join(dir, "settings.json") : join(home, ".claude", "settings.json")`.
    expect(resolveClaudeCodeSettingsPath("user", { home, claudeConfigDir: "" })).toBe(userSettings());
    const { result } = await install("typed", { claudeConfigDir: "" });
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("previews the grant under --dry-run and writes nothing", async () => {
    const { result, stdout } = await install("typed", { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.wouldWrite).toEqual([typedFile(), userSettings()]);
    expect(stdout).toContain(`# ${userSettings()}${LF}permissions.allow += ["${CLAUDE_CODE_ALLOW_PATTERN}"]`);
    expect(existsSync(typedFile())).toBe(false);
    expect(existsSync(userSettings())).toBe(false);
  });

  it("does not add the grant twice when Claude Code already put it there", async () => {
    await install("claude-code");
    const before = read(userSettings());
    const mtime = statSync(userSettings()).mtimeMs;
    const { result } = await install("typed");
    expect(result.exitCode).toBe(0);
    expect(result.written).toEqual([typedFile()]);
    expect(read(userSettings())).toBe(before);
    expect(statSync(userSettings()).mtimeMs).toBe(mtime);
  });
});

describe("uninstall and the SHARED grant", () => {
  const keepLine = (holder: string, file: string): string =>
    `Keeping ${CLAUDE_CODE_ALLOW_PATTERN} in ${userSettings()}: ${holder} still launches yaw-mcp from ${file} and reads that grant.`;

  it("removes typed's entry AND the grant when no other row uses it", async () => {
    await install("typed");
    const { result, stdout } = await uninstall("typed");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(read(typedFile()))).toEqual({ mcpServers: {} });
    expect(allowOf(userSettings())).toEqual([]);
    expect(result.written).toEqual([typedFile(), userSettings()]);
    expect(stdout).not.toContain("Keeping");
    expect(stdout).toContain("Done: typed no longer launches yaw-mcp.");
  });

  it("keeps the grant on `uninstall typed` while Claude Code's user entry still has it", async () => {
    await install("claude-code");
    await install("typed");
    const settingsBefore = read(userSettings());
    const { result, stdout } = await uninstall("typed");
    expect(result.exitCode).toBe(0);
    // typed's entry is gone ...
    expect(JSON.parse(read(typedFile()))).toEqual({ mcpServers: {} });
    // ... the grant Claude Code still reads is not, byte for byte ...
    expect(read(userSettings())).toBe(settingsBefore);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(result.written).toEqual([typedFile()]);
    // ... and the run says which client is keeping it, in one line.
    expect(stdout).toContain(keepLine("Claude Code (user)", claudeJson()));
    expect(stdout.split(LF).filter((l) => l.startsWith("Keeping "))).toHaveLength(1);
  });

  it("keeps the grant on `uninstall claude-code --scope user` while typed's file still has it", async () => {
    await install("typed");
    await install("claude-code");
    const { result, stdout } = await uninstall("claude-code");
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(read(claudeJson())) as { mcpServers: object }).mcpServers).toEqual({});
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(result.written).toEqual([claudeJson()]);
    expect(stdout).toContain(keepLine("typed (user)", typedFile()));
  });

  it("removes the grant with the LAST of the two, whichever order they go in", async () => {
    await install("typed");
    await install("claude-code");
    await uninstall("claude-code");
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    const { result, stdout } = await uninstall("typed");
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([]);
    expect(stdout).not.toContain("Keeping");
  });

  it("previews the kept grant under --dry-run: no grant line, no settings.json in wouldWrite", async () => {
    await install("claude-code");
    await install("typed");
    const { result, stdout } = await uninstall("typed", { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.wouldWrite).toEqual([typedFile()]);
    expect(stdout).not.toContain("grant:");
    expect(stdout).toContain(keepLine("Claude Code (user)", claudeJson()));
    // A preview writes nothing.
    expect(JSON.parse(read(typedFile()))).toEqual({
      mcpServers: { mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } },
    });
  });

  it("keeps a grant it cannot rule out: an unreadable peer config counts as still using it", async () => {
    await install("claude-code");
    // A DIRECTORY where typed's file goes reads as `unreadable` (EISDIR), not
    // absent -- whether it holds an entry cannot be told.
    mkdirSync(typedFile(), { recursive: true });
    const { result, stdout } = await uninstall("claude-code");
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(
      `Keeping ${CLAUDE_CODE_ALLOW_PATTERN} in ${userSettings()}: could not read ${typedFile()} to tell whether typed (user) still uses it.`,
    );
  });

  it("checks the peer in the SAME CLAUDE_CONFIG_DIR the grant lives under", async () => {
    const cfg = join(home, "overlay");
    await install("claude-code", { claudeConfigDir: cfg });
    await install("typed", { claudeConfigDir: cfg });
    const cfgSettings = join(cfg, "settings.json");
    expect(allowOf(cfgSettings)).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    const { result, stdout } = await uninstall("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(allowOf(cfgSettings)).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(
      `Keeping ${CLAUDE_CODE_ALLOW_PATTERN} in ${cfgSettings}: Claude Code (user) still launches yaw-mcp from ${join(cfg, ".claude.json")} and reads that grant.`,
    );
  });

  it("does not let a peer entry whose grant is in ANOTHER settings file keep this one's", async () => {
    // A project folder that is NOT the home: its grant lives in
    // <project>/.claude/settings.json, while typed's and Claude Code's user
    // entries read ~/.claude/settings.json. Both user entries are present and
    // resolvable -- only the same-file test keeps them from counting.
    await install("claude-code");
    await install("typed");
    await install("claude-code", { scope: "project", projectDir: cwd });
    const projectSettings = join(cwd, ".claude", "settings.json");
    expect(allowOf(projectSettings)).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    const { result, stdout } = await uninstall("claude-code", { scope: "project", projectDir: cwd });
    expect(result.exitCode).toBe(0);
    expect(allowOf(projectSettings)).toEqual([]);
    expect(stdout).not.toContain("Keeping");
    // And the user-scope grant the two user entries share is untouched.
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("covers Claude Code's project scope when the project folder IS the home", async () => {
    // <home>/.claude/settings.json is then both the user-scope and the
    // project-scope settings file, so the generic same-file check applies.
    await install("claude-code");
    await install("claude-code", { scope: "project", projectDir: home });
    const { result, stdout } = await uninstall("claude-code", { scope: "project", projectDir: home });
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(keepLine("Claude Code (user)", claudeJson()));
  });
});

describe("--list and doctor", () => {
  function listRow(out: string): string[] {
    const rows = out
      .split(LF)
      .map((l) => l.trim().split(/ {2,}/))
      .filter((cells) => cells[0] === "typed" && cells[1] === "user");
    expect(rows, `exactly one typed (user) row in:\n${out}`).toHaveLength(1);
    return rows[0];
  }

  async function list(): Promise<string> {
    const cap = captureIo();
    await runInstall({ listOnly: true, os: "linux", home, cwd, io: cap.io });
    return cap.stdout();
  }

  it("shows one typed row whose status walks not installed -> installed", async () => {
    const before = listRow(await list());
    expect(before[3]).toBe("not installed");
    expect(before[2].split(BACKSLASH).join("/")).toBe("~/.config/typed/mcp.json");
    await install("typed");
    expect(listRow(await list())[3]).toBe("installed");
  });

  it("reports the entry in doctor", async () => {
    await install("typed");
    const out: string[] = [];
    await runDoctor({
      home,
      cwd,
      os: "linux",
      env: {},
      out: (s) => out.push(s),
      err: () => {},
      skipRegistryCheck: true,
      oamProbe: OAM_ABSENT,
    });
    expect(out.join("")).toContain('typed (user): OK -- has "mcp" entry');
  });
});
