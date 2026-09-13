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
//     while the other row still has its "mcp" entry -- or typed still loads
//     one from the lower-ranked files it also reads (~/.mcp.json,
//     <configDir>/.mcp.json, both .claude.json maps);
//   * the grant follows CLAUDE_CONFIG_DIR where typed's file does not, and an
//     npx entry here shadows a local launch in those lower-ranked files; the
//     run says so in both cases rather than doing anything about it.
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
  resolveAlsoReadSites,
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
    oamProbe?: () => Promise<OamProbe>;
    resolveOamEntry?: (pkg: string) => string | null;
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
    oamProbe: opts.oamProbe ?? OAM_ABSENT,
    resolveOamEntry: opts.resolveOamEntry,
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
    expect(row.hooks?.permissionsPatch).toBe("claude-code");
    expect(typeof row.hooks?.alsoReads).toBe("function");
    expect(row.entry?.windowsLaunch).toEqual({ broker: "bare", upstream: "cmd-wrap" });
  });

  it("says what a user needs in its notes, in ASCII", () => {
    const notes = row.notes ?? "";
    expect(notes).toContain("newer than 1.5.0");
    expect(notes).toContain("`yaw-mcp install mcp`");
    expect(notes).toContain("`yaw-mcp install claude-code`");
    expect(notes).toContain("~/.claude.json");
    // The npx-over-a-local-launch cost, and the config-dir scope of the grant.
    expect(notes).toContain("MCP_TIMEOUT");
    expect(notes).toContain("scoped to that config dir");
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

  it("names the four lower-ranked files typed also loads an entry from, where typed's loader finds them", () => {
    // typed's collectMcpConfigSources: ~/.mcp.json, <configDir>/.mcp.json and
    // the top-level mcpServers of ~/.claude.json and <configDir>/.claude.json,
    // <configDir> being CLAUDE_CONFIG_DIR when non-empty, else ~/.claude.
    const files = (claudeConfigDir?: string) =>
      resolveAlsoReadSites({ clientId: "typed", scope: "user", os: "linux", home, claudeConfigDir }).map((s) => {
        expect(s.resolved.containerPath).toEqual(["mcpServers"]);
        // STRICT, like typed's own file: typed JSON.parses every one of them.
        expect(s.format).toBe("json");
        return s.resolved.absolute;
      });
    const underClaude = [
      join(home, ".mcp.json"),
      join(home, ".claude", ".mcp.json"),
      join(home, ".claude.json"),
      join(home, ".claude", ".claude.json"),
    ];
    expect(files()).toEqual(underClaude);
    expect(files("")).toEqual(underClaude);
    const cfg = join(home, "overlay");
    expect(files(cfg)).toEqual([
      join(home, ".mcp.json"),
      join(cfg, ".mcp.json"),
      join(home, ".claude.json"),
      join(cfg, ".claude.json"),
    ]);
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

describe("a grant scoped to CLAUDE_CONFIG_DIR, beside an entry that is not", () => {
  const scopedNote = (settings: string): string =>
    `Note: the ${CLAUDE_CODE_ALLOW_PATTERN} grant typed reads is in ${settings}, under CLAUDE_CONFIG_DIR, so it is ` +
    `scoped to that config dir: a typed started without it reads ${userSettings()} instead, while ${typedFile()} ` +
    "does not follow the variable.";
  const noteLines = (stdout: string): string[] =>
    stdout.split(LF).filter((l) => l.startsWith(`Note: the ${CLAUDE_CODE_ALLOW_PATTERN} grant`));

  it("says, once, that the grant is scoped to that config dir while typed's own file is not", async () => {
    const cfg = join(home, "overlay");
    const { result, stdout } = await install("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(noteLines(stdout)).toEqual([scopedNote(join(cfg, "settings.json"))]);
    // An ordinary config dir is not a Yaw Mode overlay, and nothing is written
    // outside it: the grant stays where typed under that dir reads it.
    expect(stdout).not.toContain("per-pane overlay");
    expect(existsSync(userSettings())).toBe(false);
  });

  it("names a Yaw Mode pane overlay as discarded with the pane, and the shell to re-run from", async () => {
    // The per-PTY shape, recognised by the directory's NAME alone.
    const cfg = join(home, "Temp", "yaw-mode-16224-9qm92t8-pty-40");
    const { result, stdout } = await install("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(noteLines(stdout)).toEqual([
      `${scopedNote(join(cfg, "settings.json"))} ${cfg} is a Yaw Mode per-pane overlay, discarded when the pane ` +
        `closes while ${typedFile()} stays -- re-run \`yaw-mcp install typed\` from a shell without ` +
        `CLAUDE_CONFIG_DIR to put the grant in ${userSettings()}.`,
    ]);
    // Said, not done: ~/.claude/settings.json is not written from the overlay.
    expect(existsSync(userSettings())).toBe(false);
  });

  it("previews the same note under --dry-run, in the conditional", async () => {
    const cfg = join(home, "overlay");
    const { stdout } = await install("typed", { claudeConfigDir: cfg, dryRun: true });
    expect(noteLines(stdout)).toEqual([
      scopedNote(join(cfg, "settings.json")).replace("grant typed reads is in", "grant typed reads would go in"),
    ]);
  });

  it("says nothing where the grant and the entry move together, or the grant is in the default file anyway", async () => {
    // No CLAUDE_CONFIG_DIR at all.
    expect(noteLines((await install("typed")).stdout)).toEqual([]);
    // Claude Code's user entry follows the variable too, so both live and die
    // with the config dir.
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    expect(noteLines((await install("claude-code", { claudeConfigDir: join(home, "overlay") })).stdout)).toEqual([]);
    // CLAUDE_CONFIG_DIR=<home>/.claude names the default settings.json.
    rmSync(typedFile(), { force: true });
    expect(noteLines((await install("typed", { claudeConfigDir: join(home, ".claude") })).stdout)).toEqual([]);
  });

  it("tells uninstall, too, which settings.json it looked in and what to re-run outside the overlay", async () => {
    const cfg = join(home, "Temp", "yaw-mode-16224-9qm92t8-pty-40");
    await install("typed", { claudeConfigDir: cfg });
    const { result, stdout } = await uninstall("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(stdout.split(LF).filter((l) => l.startsWith("Note: this run looks for"))).toEqual([
      `Note: this run looks for the ${CLAUDE_CODE_ALLOW_PATTERN} grant only in ${join(cfg, "settings.json")}, under ` +
        `CLAUDE_CONFIG_DIR; ${userSettings()}, which a typed started without that variable reads, is left as it is. ` +
        `${cfg} is a Yaw Mode per-pane overlay -- re-run \`yaw-mcp uninstall typed\` from a shell without ` +
        `CLAUDE_CONFIG_DIR to take the grant out of ${userSettings()}.`,
    ]);
  });
});

describe("an npx entry over a LOCAL launch typed also loads", () => {
  /** Yaw Terminal's shape in ~/.claude.json: its own executable running the
   *  bundled copy as node, no npx step. */
  const localLaunch = {
    command: "/opt/Yaw/yaw",
    args: ["resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const seedLaunch = (file: string, entry: Record<string, unknown>): void =>
    seed(file, `${JSON.stringify({ mcpServers: { [ENTRY_NAME]: entry } }, null, 2)}\n`);
  const shadowLines = (stdout: string): string[] => stdout.split(LF).filter((l) => l.startsWith("Note: typed ranks "));
  const shadowNote = (shadowed: string): string =>
    `Note: typed ranks ${typedFile()} above ${shadowed}, whose "${ENTRY_NAME}" entry launches yaw-mcp locally -- so ` +
    "this npx entry replaces that local launch for typed, and npx resolves @yawlabs/mcp@latest on every typed " +
    "start: slow, and it can exceed typed's MCP connect timeout. For a fast absolute-path entry, install yaw-mcp " +
    "globally (`npm i -g @yawlabs/mcp`) with oam available and re-run `yaw-mcp install typed`, or raise MCP_TIMEOUT.";

  it("says the npx entry replaces Yaw Terminal's local launch in ~/.claude.json, and what it costs", async () => {
    seedLaunch(claudeJson(), localLaunch);
    const { result, stdout } = await install("typed");
    expect(result.exitCode).toBe(0);
    expect(shadowLines(stdout)).toEqual([shadowNote(claudeJson())]);
    // Written anyway: it is the entry the user asked for.
    expect(read(typedFile())).toBe(FRESH);
  });

  it("finds that launch in <CLAUDE_CONFIG_DIR>/.claude.json too", async () => {
    const cfg = join(home, "overlay");
    seedLaunch(join(cfg, ".claude.json"), localLaunch);
    const { stdout } = await install("typed", { claudeConfigDir: cfg });
    expect(shadowLines(stdout)).toEqual([shadowNote(join(cfg, ".claude.json"))]);
  });

  it("says nothing when the launch it replaces is npx already, bare or cmd-wrapped", async () => {
    seedLaunch(claudeJson(), { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(shadowLines((await install("typed")).stdout)).toEqual([]);
    rmSync(typedFile(), { force: true });
    seedLaunch(claudeJson(), { command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"] });
    expect(shadowLines((await install("typed")).stdout)).toEqual([]);
  });

  it("says nothing when the entry it writes is the absolute oam one, not npx", async () => {
    seedLaunch(claudeJson(), localLaunch);
    const oam = join(home, "bin", "oam");
    const { result, stdout } = await install("typed", {
      oamProbe: async () => ({
        bin: oam,
        binPath: oam,
        version: "1.0.0",
        belowMin: false,
        failure: null,
        failureDetail: null,
      }),
      resolveOamEntry: () => join(home, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js"),
    });
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(read(typedFile())) as { mcpServers: { mcp: { command: string } } }).mcpServers.mcp.command).toBe(
      oam,
    );
    expect(shadowLines(stdout)).toEqual([]);
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
    // Claude Code first, typed last.
    await install("typed");
    await install("claude-code");
    await uninstall("claude-code");
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    const typedLast = await uninstall("typed");
    expect(typedLast.result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([]);
    expect(typedLast.stdout).not.toContain("Keeping");

    // typed first, Claude Code last. typed also loads ~/.claude.json's "mcp"
    // entry, which is the very entry `uninstall claude-code` is removing -- so
    // that slot must not keep the grant for it.
    await install("typed");
    await install("claude-code");
    const typedFirst = await uninstall("typed");
    expect(typedFirst.stdout).toContain(keepLine("Claude Code (user)", claudeJson()));
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    const claudeLast = await uninstall("claude-code");
    expect(claudeLast.result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([]);
    expect(claudeLast.stdout).not.toContain("Keeping");
  });

  it("does not look for a holder when there is no grant to remove", async () => {
    // Claude Code's entry would hold a grant -- but the grant is already gone,
    // so a "Keeping" line would be about a grant that is not there.
    await install("claude-code");
    await install("typed");
    seed(userSettings(), `{${LF}  "permissions": { "allow": [] }${LF}}${LF}`);
    const before = read(userSettings());
    const { result, stdout } = await uninstall("typed");
    expect(result.exitCode).toBe(0);
    expect(stdout).not.toContain("Keeping");
    expect(result.written).toEqual([typedFile()]);
    expect(read(userSettings())).toBe(before);
  });

  it("keeps the grant on `uninstall typed` while Claude Code's project entry in the HOME folder still has it", async () => {
    // `yaw-mcp install mcp` run from ~ -- <home>/.mcp.json, and its grant in
    // <home>/.claude/settings.json, which is also the user-scope file.
    await install("claude-code", { scope: "project", projectDir: home });
    await install("typed");
    const { result, stdout } = await uninstall("typed");
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(keepLine("Claude Code (project)", join(home, ".mcp.json")));
  });

  it("keeps the grant on `uninstall claude-code --scope user` while its project entry in the HOME folder still has it", async () => {
    await install("claude-code");
    await install("claude-code", { scope: "project", projectDir: home });
    const { result, stdout } = await uninstall("claude-code");
    expect(result.exitCode).toBe(0);
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(keepLine("Claude Code (project)", join(home, ".mcp.json")));
  });

  it("keeps the grant while typed still loads an entry from ~/.claude.json, outside the CLAUDE_CONFIG_DIR it ran under", async () => {
    // Claude Code wired with the variable unset; typed installed and
    // uninstalled under an overlay. typed reads ~/.claude.json whatever
    // CLAUDE_CONFIG_DIR says, so it still launches yaw-mcp from there.
    await install("claude-code");
    const cfg = join(home, "overlay");
    await install("typed", { claudeConfigDir: cfg });
    const cfgSettings = join(cfg, "settings.json");
    const { result, stdout } = await uninstall("typed", { claudeConfigDir: cfg });
    expect(result.exitCode).toBe(0);
    expect(allowOf(cfgSettings)).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(stdout).toContain(
      `Keeping ${CLAUDE_CODE_ALLOW_PATTERN} in ${cfgSettings}: typed (user) still launches yaw-mcp from ${claudeJson()} and reads that grant.`,
    );
  });

  it("keeps the grant while an entry an older `typed mcp add` wrote to ~/.claude/.mcp.json still launches yaw-mcp", async () => {
    const oldSlot = join(home, ".claude", ".mcp.json");
    // typed's own uninstall ...
    await install("typed");
    seed(
      oldSlot,
      `${JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } } })}\n`,
    );
    const self = await uninstall("typed");
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(self.stdout).toContain(keepLine("typed (user)", oldSlot));
    // ... and Claude Code's, where typed is the peer that still loads it.
    await install("claude-code");
    const peer = await uninstall("claude-code");
    expect(allowOf(userSettings())).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(peer.stdout).toContain(keepLine("typed (user)", oldSlot));
  });

  // A STRICT typed file that parses for us -- as `ok`, entries listed -- but
  // not for typed's JSON.parse, which loads no server from it.
  const unloadableEntry = `"${ENTRY_NAME}": { "command": "npx", "args": ["-y", "@yawlabs/mcp@latest"] }`;
  for (const [shape, text] of [
    ["a comment", `{${LF}  // mine${LF}  "mcpServers": { ${unloadableEntry} }${LF}}${LF}`],
    ["a trailing comma", `{${LF}  "mcpServers": { ${unloadableEntry}, }${LF}}${LF}`],
  ] as const) {
    it(`does not count a typed file carrying ${shape}, which typed loads no server from, as a holder`, async () => {
      await install("claude-code");
      seed(typedFile(), text);
      const { result, stdout } = await uninstall("claude-code");
      expect(result.exitCode).toBe(0);
      expect(allowOf(userSettings())).toEqual([]);
      expect(stdout).not.toContain("Keeping");
    });
  }

  it.runIf(process.platform === "win32")(
    "matches the home's settings.json through a project folder spelled in another letter case (win32 host)",
    async () => {
      const driveFlipped =
        home.charAt(0) === home.charAt(0).toLowerCase()
          ? home.charAt(0).toUpperCase() + home.slice(1)
          : home.charAt(0).toLowerCase() + home.slice(1);
      for (const spelled of [driveFlipped, home.toUpperCase()]) {
        rmSync(join(home, ".claude"), { recursive: true, force: true });
        rmSync(claudeJson(), { force: true });
        rmSync(join(home, ".mcp.json"), { force: true });
        await install("claude-code");
        await install("claude-code", { scope: "project", projectDir: spelled });
        const { result, stdout } = await uninstall("claude-code", { scope: "project", projectDir: spelled });
        expect(result.exitCode, spelled).toBe(0);
        expect(allowOf(userSettings()), spelled).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
        expect(stdout, spelled).toContain(`Claude Code (user) still launches yaw-mcp from ${claudeJson()}`);
      }
    },
  );

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

describe("install --all", () => {
  it("names the shared settings.json once in a --dry-run's wouldWrite, as the live run writes it once", async () => {
    const cap = captureIo();
    const both = INSTALL_TARGETS.filter((t) => t.clientId === "claude-code" || t.clientId === "typed");
    const opts = {
      all: true,
      os: "linux" as const,
      home,
      cwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      bundlesSummary: BUNDLES_EMPTY,
      targets: both,
    };
    // Each sub-install's preview plans the grant on its own ...
    const preview = await runInstall({ ...opts, dryRun: true });
    expect(preview.exitCode).toBe(0);
    // ... and the run lists the file once, in first-seen order.
    expect(preview.wouldWrite).toEqual([claudeJson(), userSettings(), typedFile()]);
    const live = await runInstall(opts);
    expect(live.exitCode).toBe(0);
    expect(live.written).toEqual([claudeJson(), userSettings(), typedFile()]);
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
