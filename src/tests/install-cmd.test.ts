import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_USAGE,
  mergeClientConfig,
  mergePermissionsAllow,
  NO_CONFIG_FLAG_DEPRECATION,
  parseInstallArgs,
  readEntryAt,
  runInstall,
  TOKEN_FLAG_DEPRECATION,
} from "../install-cmd.js";
import { CLAUDE_CODE_ALLOW_PATTERN, ENTRY_NAME } from "../install-targets.js";
import { parseJsonc } from "../jsonc.js";
import { MIN_OAM_VERSION, OAM_INSTALL_PS1, OAM_INSTALL_SH, type OamProbe } from "../oam-spawn.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-home-"));
  synthCwd = mkdtempSync(join(tmpdir(), "yaw-mcp-install-cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (arr: string[]): NodeJS.WritableStream => {
    return new Writable({
      write(chunk: Buffer, _enc, cb): void {
        arr.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
  };
  return {
    io: {
      stdin: process.stdin,
      stdout: sink(out),
      stderr: sink(err),
      isTTY: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

describe("parseInstallArgs", () => {
  it("rejects empty argv with usage", () => {
    const r = parseInstallArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage:");
  });

  it("--help returns ok:true with helpRequested so dispatcher routes to stdout+exit0", () => {
    // Parser shape changed: --help is now a SUCCESSFUL parse carrying
    // helpRequested in options (was ok:false + help:true). The dispatcher
    // in index.ts checks `parsed.ok && parsed.options.helpRequested` and
    // prints USAGE to stdout + exit 0.
    const r = parseInstallArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.helpRequested).toBe(true);
  });

  it("-h returns ok:true with helpRequested", () => {
    const r = parseInstallArgs(["-h"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.helpRequested).toBe(true);
  });

  it("parses positional client", () => {
    const r = parseInstallArgs(["claude-code"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.clientId).toBe("claude-code");
  });

  it("rejects unknown client", () => {
    const r = parseInstallArgs(["zed"]);
    expect(r.ok).toBe(false);
  });

  it("parses --scope", () => {
    const r = parseInstallArgs(["claude-code", "--scope", "project"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.scope).toBe("project");
  });

  it("rejects invalid --scope", () => {
    const r = parseInstallArgs(["claude-code", "--scope", "machine"]);
    expect(r.ok).toBe(false);
  });

  it("parses --token, --os, --project-dir, --force, --skip, --dry-run, --no-yaw-mcp-config", () => {
    const r = parseInstallArgs([
      "cursor",
      "--token",
      "mcp_pat_abc",
      "--os",
      "linux",
      "--project-dir",
      "/tmp/repo",
      "--force",
      "--dry-run",
      "--no-yaw-mcp-config",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.token).toBe("mcp_pat_abc");
      expect(r.options.os).toBe("linux");
      expect(r.options.projectDir).toBe("/tmp/repo");
      expect(r.options.force).toBe(true);
      expect(r.options.dryRun).toBe(true);
      expect(r.options.skipYawMcpConfig).toBe(true);
    }
  });

  it("rejects unknown flags", () => {
    const r = parseInstallArgs(["claude-code", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --token that swallows a following flag as its value", () => {
    // `--token --force` must not set token="--force"; the free-form flag
    // guards mirror the enum-flag allow-list rejection.
    const r = parseInstallArgs(["claude-code", "--token", "--force"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--token requires a value");
  });

  it("rejects --project-dir that swallows a following flag as its value", () => {
    const r = parseInstallArgs(["claude-code", "--project-dir", "--dry-run"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--project-dir requires a value");
  });

  it("rejects more than one positional", () => {
    const r = parseInstallArgs(["claude-code", "cursor"]);
    expect(r.ok).toBe(false);
  });
});

describe("mergeClientConfig", () => {
  it("preserves other servers in mcpServers", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcp"] });
    expect(merged.mcpServers).toEqual({
      other: { command: "x" },
      [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] },
    });
  });

  it("preserves sibling top-level keys (e.g., model, hooks)", () => {
    const existing = { model: "claude-opus-4-7", mcpServers: {} };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcp"] });
    expect(merged.model).toBe("claude-opus-4-7");
    expect((merged.mcpServers as Record<string, unknown>)[ENTRY_NAME]).toBeDefined();
  });

  it("creates the container if missing", () => {
    const merged = mergeClientConfig({}, ["servers"], { command: "npx", args: [] });
    expect(merged.servers).toEqual({ [ENTRY_NAME]: { command: "npx", args: [] } });
  });

  it("uses the right container key for VS Code (servers, not mcpServers)", () => {
    const merged = mergeClientConfig({}, ["servers"], { command: "x", args: [] });
    expect(merged.mcpServers).toBeUndefined();
    expect(merged.servers).toBeDefined();
  });

  it("does not mutate the input", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const snapshot = JSON.stringify(existing);
    mergeClientConfig(existing, ["mcpServers"], { command: "y", args: [] });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("walks a nested containerPath and preserves siblings at every level", () => {
    // Claude Code local scope: ["projects", "/abs/dir", "mcpServers"].
    // Must preserve other projects + every top-level key in ~/.claude.json.
    const existing = {
      userID: "abc",
      projects: {
        "/other/project": { mcpServers: { foo: { command: "f" } }, history: ["x"] },
        "/abs/dir": { history: ["y"] },
      },
    };
    const merged = mergeClientConfig(existing, ["projects", "/abs/dir", "mcpServers"], {
      command: "npx",
      args: ["-y", "@yawlabs/mcp"],
    });
    expect(merged.userID).toBe("abc");
    const projects = merged.projects as Record<string, Record<string, unknown>>;
    // Other project untouched.
    expect(projects["/other/project"].mcpServers).toEqual({ foo: { command: "f" } });
    expect(projects["/other/project"].history).toEqual(["x"]);
    // Target project: history preserved, mcpServers added.
    expect(projects["/abs/dir"].history).toEqual(["y"]);
    expect((projects["/abs/dir"].mcpServers as Record<string, unknown>)[ENTRY_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcp"],
    });
  });

  it("creates intermediate path segments when missing", () => {
    const merged = mergeClientConfig({}, ["projects", "/new/dir", "mcpServers"], { command: "npx", args: [] });
    const projects = merged.projects as Record<string, Record<string, unknown>>;
    expect(projects["/new/dir"].mcpServers).toEqual({ [ENTRY_NAME]: { command: "npx", args: [] } });
  });
});

describe("mergePermissionsAllow", () => {
  it("adds the pattern to an empty settings object", () => {
    const merged = mergePermissionsAllow({}, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect(merged).toEqual({ permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } });
  });

  it("preserves unrelated top-level keys (hooks, model, mcpServers)", () => {
    const existing = {
      model: "claude-opus-4-7",
      hooks: { PreToolUse: [{ matcher: "Bash" }] },
      mcpServers: { other: { command: "x" } },
    };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect(merged.model).toBe("claude-opus-4-7");
    expect(merged.hooks).toEqual(existing.hooks);
    expect(merged.mcpServers).toEqual(existing.mcpServers);
    expect((merged.permissions as { allow: string[] }).allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("unions with existing allow entries instead of replacing", () => {
    const existing = { permissions: { allow: ["Bash(git *)", "Read"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow).toEqual(["Bash(git *)", "Read", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("does not duplicate a pattern already present", () => {
    const existing = { permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow.filter((x) => x === CLAUDE_CODE_ALLOW_PATTERN)).toHaveLength(1);
  });

  it("preserves other permissions fields like deny / additionalDirectories", () => {
    const existing = { permissions: { deny: ["Bash(rm -rf *)"], additionalDirectories: ["/tmp"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const perms = merged.permissions as { allow: string[]; deny: string[]; additionalDirectories: string[] };
    expect(perms.deny).toEqual(["Bash(rm -rf *)"]);
    expect(perms.additionalDirectories).toEqual(["/tmp"]);
    expect(perms.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("strips the pre-rename mcp__mcp_hosting__* legacy pattern on upgrade", () => {
    const existing = { permissions: { allow: ["Bash(git *)", "mcp__mcp_hosting__*"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow).not.toContain("mcp__mcp_hosting__*");
    expect(allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    expect(allow).toContain("Bash(git *)");
  });
});

/** Deterministic oam seams. `runInstall` probes the real machine by default,
 *  so a maintainer with oam + a global @yawlabs/mcp would get an oam entry
 *  where CI gets npx -- these pin the world each test means to assert.
 *
 *  Annotated `Promise<OamProbe>` deliberately: a fixture built from an
 *  un-annotated object literal drifts silently when the probe gains a field,
 *  and `binPath` is exactly the field whose absence let a bare-name entry ship. */
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
// Derived from the constant, not pinned: MIN_OAM_VERSION tracks the latest oam
// release and so moves every release. A hardcoded version here would silently
// become a below-min build that the fixture still claims is usable.
const OAM_PRESENT = async (): Promise<OamProbe> => ({
  bin: "/usr/local/bin/oam",
  binPath: "/usr/local/bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** The shape the REAL probe returns without OAM_BIN: a bare spawnable name,
 *  resolved to an absolute path against PATH x PATHEXT. Every fixture used to
 *  pass an absolute `bin`, which is why the bare-name entry shipped untested. */
const OAM_BARE_RESOLVED = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: "/home/j/.oam/bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** Bare name that PATH could not locate as a file (a shell function, an alias,
 *  a sanitized child env). Usable here, not persistable anywhere. */
const OAM_BARE_UNRESOLVED = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: null,
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** A binPath that PATH resolved to a RELATIVE hit. resolveBinAbsolute joins the
 *  bin onto each PATH dir in turn, so a PATH carrying `.` or `node_modules/.bin`
 *  yields a relative path -- which buildLaunchEntry rejects (isAbsolute gate)
 *  while the probe still reports it as found. */
const OAM_RELATIVE_BINPATH = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: "node_modules/.bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
// Safe to hardcode below-min, unlike the usable fixtures above: MIN_OAM_VERSION
// only ever moves forward, so a version below today's floor stays below it.
const OAM_BELOW_MIN = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: "0.8.2",
  belowMin: true,
  failure: null,
  failureDetail: null,
});
/** Present on disk but unusable -- distinct from absent, which is why the probe
 *  carries `failure` at all. */
const OAM_BROKEN = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: "timeout",
  failureDetail: "oam --version timed out after 3000ms",
});
const OAM_ENTRY = "/opt/nm/@yawlabs/mcp/dist/index.js";

describe("runInstall — settings.json merge edge cases (claude-code)", () => {
  it("preserves existing settings.json content when patching", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-7",
        hooks: { PreToolUse: [] },
        permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm -rf *)"] },
      }),
    );

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("claude-opus-4-7");
    expect(settings.hooks).toEqual({ PreToolUse: [] });
    expect(settings.permissions.deny).toEqual(["Bash(rm -rf *)"]);
    expect(settings.permissions.allow).toEqual(["Bash(git *)", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("is a no-op on settings.json when the pattern is already present", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const initial = JSON.stringify({ permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } }, null, 2);
    writeFileSync(join(settingsDir, "settings.json"), initial);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // settings.json not listed as written because no change was needed.
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
    // Contents untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(initial);
  });

  it("warns (not silent) when settings.json is malformed and cannot be patched", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const malformed = "{ this is not json";
    writeFileSync(join(settingsDir, "settings.json"), malformed);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // Settings patch is best-effort, so the install itself still succeeds.
    expect(r.exitCode).toBe(0);
    // But the malformed file is surfaced, not silently skipped -- and the
    // warning names the file + the by-hand fix.
    expect(cap.stderr()).toMatch(/could not patch/);
    expect(cap.stderr()).toMatch(/settings\.json/);
    expect(cap.stderr()).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // The malformed file is left untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(malformed);
    // settings.json is not in the written list (no patch applied).
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
  });

  // Distinct from the malformed (unparseable-bytes) case above: this file
  // parses cleanly as JSON but is NOT a plain object (array or null). The
  // parse succeeds, so the catch branch never fires; instead the non-object
  // branch returns malformedReason "not a JSON object". runInstall must still
  // warn ("could not patch" + "(not a JSON object)") and skip the patch
  // rather than throw or silently no-op.
  it.each([
    ["array", "[]"],
    ["null", "null"],
  ])("warns and skips the patch when settings.json is valid JSON but not an object (%s)", async (_label, contents) => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), contents);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // Settings patch is best-effort, so the install itself still succeeds
    // (no throw, exit 0).
    expect(r.exitCode).toBe(0);
    // The skip is surfaced, not silent -- warning names the by-hand fix and
    // the specific reason for THIS branch ("not a JSON object"), which
    // distinguishes it from the unparseable-bytes malformed case.
    expect(cap.stderr()).toMatch(/could not patch/);
    expect(cap.stderr()).toContain("(not a JSON object)");
    expect(cap.stderr()).toMatch(/settings\.json/);
    expect(cap.stderr()).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // The non-object file is left byte-for-byte untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(contents);
    // settings.json is not in the written list (no patch applied).
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
  });

  it("does not touch settings.json for non-claude-code clients", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "cursor",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
  });
});

describe("runInstall — happy path (claude-code, user scope, fresh install)", () => {
  it("writes client config and patches settings.json permissions, and never touches ~/.yaw-mcp/config.json", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Two files touched: ~/.claude.json (mcpServers) and ~/.claude/settings.json
    // (permissions.allow so the client stops prompting). ~/.yaw-mcp/config.json
    // used to be a third -- it carried the account token, which is gone.
    expect(r.written.length).toBe(2);

    const clientPath = join(synthHome, ".claude.json");
    const settingsPath = join(synthHome, ".claude", "settings.json");
    expect(existsSync(clientPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);

    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcp@latest"]);
    expect(client.mcpServers[ENTRY_NAME].env).toBeUndefined();

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("warns when a legacy `mcp.hosting` entry is present in the client config", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "mcp.hosting": { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/legacy "mcp\.hosting" entry remains/);
    expect(cap.stdout()).toMatch(/running yaw-mcp twice/);
    // New entry written without removing the legacy one (commit chose no auto-migration).
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
    expect(client.mcpServers["mcp.hosting"]).toBeDefined();
  });

  it("--dry-run with a legacy entry says `would remain`, not `remains`", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "mcp.hosting": { command: "npx" } } }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/legacy "mcp\.hosting" entry .* would remain/);
    // File is untouched on dry-run.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeUndefined();
  });

  it("--skip on existing yaw-mcp entry does not log the legacy hint", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [ENTRY_NAME]: { command: "npx" },
          "mcp.hosting": { command: "npx" },
        },
      }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).not.toMatch(/legacy "mcp\.hosting"/);
  });
});

describe("runInstall — claudeConfigDir override (CLAUDE_CONFIG_DIR wrapper)", () => {
  // Locks the v0.47.2 fix: when Claude Code runs under a wrapper that
  // sets CLAUDE_CONFIG_DIR, BOTH the mcpServers config AND the
  // permissions.allow patch must follow the redirect. Otherwise the
  // user sees a "successful" install but `claude mcp list` shows nothing.

  it("writes .claude.json + settings.json into the wrapper dir, not home", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "yaw-mcp-wrapper-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        claudeConfigDir: wrapperDir,
        io: cap.io,
        // Pins the npx assertion below. Without the seam this calls the real
        // probeOam (a live `oam --version` spawn) plus the real
        // resolveStableNpmEntry, so the entry depends on the machine: it passes
        // from a repo checkout only because there is no node_modules segment in
        // import.meta.url, and fails from an installed copy on a box with oam.
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);

      // The two claude-code files land in the wrapper dir.
      const wrapperClient = join(wrapperDir, ".claude.json");
      const wrapperSettings = join(wrapperDir, "settings.json");
      expect(existsSync(wrapperClient)).toBe(true);
      expect(existsSync(wrapperSettings)).toBe(true);
      const client = JSON.parse(readFileSync(wrapperClient, "utf8"));
      expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
      const settings = JSON.parse(readFileSync(wrapperSettings, "utf8"));
      expect(settings.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);

      // Crucially, the home-based defaults are NOT created — that was
      // the original bug (entry written, but to a file Claude Code
      // doesn't read under the wrapper).
      expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
      expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);

      // ~/.yaw-mcp/config.json is never written any more, in the wrapper
      // dir or in home.
      expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
      expect(existsSync(join(wrapperDir, "config.json"))).toBe(false);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("local scope under wrapper writes to <wrapperDir>/.claude.json projects[<dir>].mcpServers", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "yaw-mcp-wrapper-local-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "local",
        os: "linux",
        home: synthHome,
        projectDir: synthCwd,
        claudeConfigDir: wrapperDir,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);

      const wrapperClient = join(wrapperDir, ".claude.json");
      expect(existsSync(wrapperClient)).toBe(true);
      const client = JSON.parse(readFileSync(wrapperClient, "utf8"));
      // Nested under projects[<absDir>].mcpServers — locks the local-scope
      // shape against accidental flattening when redirecting.
      expect(client.projects[synthCwd].mcpServers[ENTRY_NAME].command).toBe("npx");

      // Home version not created.
      expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("empty claudeConfigDir falls back to home (treated as unset)", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      claudeConfigDir: "",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(true);
  });
});

describe("runInstall — Windows uses cmd /c", () => {
  it("emits cmd-wrapped command on --os windows", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "windows",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("cmd");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
  });
});

describe("runInstall — VS Code servers shape", () => {
  it("writes under top-level `servers`, not `mcpServers`", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: synthHome,
      projectDir: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthCwd, ".vscode", "mcp.json"), "utf8"));
    expect(client.mcpServers).toBeUndefined();
    expect(client.servers[ENTRY_NAME]).toBeDefined();
  });
});

describe("runInstall — preserves existing entries", () => {
  it("does not clobber unrelated mcpServers when adding yaw-mcp", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ model: "claude-opus-4-7", mcpServers: { spend: { url: "https://x" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.model).toBe("claude-opus-4-7");
    expect(client.mcpServers.spend).toEqual({ url: "https://x" });
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
  });
});

describe("runInstall — collision handling", () => {
  it("non-TTY without --force/--skip refuses with exit 1 when entry exists", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: { ...cap.io, isTTY: false },
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/already has/);
    // Original entry untouched.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
  });

  it("--force overwrites existing entry", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });

  it("--dry-run on a collision says `Would overwrite`, not `Overwriting`", async () => {
    // dryRun maps onto decision="overwrite" so the collision path is exercised,
    // but the run returns before any write. The present-tense line told a user
    // scanning the transcript that their preview had already mutated the file.
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Would overwrite existing "${ENTRY_NAME}" entry.`);
    expect(cap.stdout()).not.toContain(`Overwriting existing "${ENTRY_NAME}" entry.`);
    expect(r.written).toEqual([]);
    // And the claim is true: the file is byte-identical.
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });

  it("--skip leaves existing entry untouched", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
    // ~/.yaw-mcp/config.json should NOT have been written either, since we short-circuited.
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("promptAnswer override exercises the interactive branch deterministically", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      promptAnswer: "overwrite",
      io: { ...cap.io, isTTY: true },
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });
});

describe("runInstall — malformed existing JSON", () => {
  it("refuses to overwrite a malformed client config", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ this is not json");
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not valid JSON/);
  });
});

// A container key holding a non-object is the one shape valid-JSON files reach
// the splice with, and jsonc-parser throws on it ("Can not add index to parent
// of type null") -- a message that names neither the file nor the key. The
// pre-splice merge path repaired such a key and installed fine, so an abort here
// is a regression as well as an unreadable one.
describe("runInstall — non-object container key", () => {
  for (const [label, bad] of [
    ["null", null],
    ["an empty array", []],
    ["a number", 7],
    ["a string", "mcpServers"],
  ] as const) {
    it(`repairs an "mcpServers" key holding ${label} and installs`, async () => {
      const clientPath = join(synthHome, ".claude.json");
      writeFileSync(clientPath, `${JSON.stringify({ model: "opus", mcpServers: bad }, null, 2)}\n`, "utf8");

      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      // No jsonc-parser internals in the output, either as an error or a warning.
      expect(cap.stderr()).not.toMatch(/Can not add index/);
      const parsed = parseJsonc(readFileSync(clientPath, "utf8")) as {
        model: string;
        mcpServers: Record<string, unknown>;
      };
      expect(parsed.mcpServers[ENTRY_NAME]).toBeDefined();
      // Siblings of the repaired key are untouched -- only that key is rewritten.
      expect(parsed.model).toBe("opus");
      // ...and the user is told, naming the key, since a value did disappear.
      const msg = r.messages.join(" ");
      expect(msg).toContain('"mcpServers"');
      expect(msg).toContain(`is ${label}, not an object`);
    });
  }

  it("repairs a non-object INTERMEDIATE key on the project-scope chain", async () => {
    // Claude Code local scope nests under projects[<absDir>].mcpServers, so the
    // blocked key can be two levels above the container. jsonc-parser
    // materializes the segments BELOW the repair, which is why one repair is
    // enough regardless of depth.
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, `${JSON.stringify({ projects: null }, null, 2)}\n`, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      projectDir: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const parsed = parseJsonc(readFileSync(clientPath, "utf8")) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    expect(parsed.projects[synthCwd].mcpServers[ENTRY_NAME]).toBeDefined();
    const msg = r.messages.join(" ");
    expect(msg).toContain('"projects"');
    expect(msg).toContain("is null, not an object");
  });

  it("keeps the user's comments while repairing the key", async () => {
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, ["{", "  // keep me", '  "mcpServers": null', "}", ""].join("\n"), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(clientPath, "utf8")).toContain("// keep me");
  });

  it("refuses, naming the key, when the container holds entries in the wrong shape", async () => {
    // The one non-object shape that can carry real server definitions. The old
    // merge path dropped them silently to write ours; refusing names the key and
    // leaves the file alone.
    const clientPath = join(synthHome, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: [{ name: "spend", url: "https://x" }] }, null, 2)}\n`;
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    const stderr = cap.stderr();
    expect(stderr).toContain('"mcpServers"');
    expect(stderr).toMatch(/an array of 1/);
    expect(stderr).toMatch(/not a JSON object/);
    expect(stderr).not.toMatch(/Can not add index/);
    // Refusal means refusal: the file is byte-identical.
    expect(readFileSync(clientPath, "utf8")).toBe(original);
  });

  it("previews the repair in the conditional under --dry-run without writing", async () => {
    const clientPath = join(synthHome, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: null }, null, 2)}\n`;
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join(" ")).toMatch(/would replace it with an empty object/);
    expect(readFileSync(clientPath, "utf8")).toBe(original);
  });
});

// SOFT deprecation, not a removal: `--token` and `--no-yaw-mcp-config` must
// keep parsing, keep exiting 0, and warn -- a scripted
// `yaw-mcp install --all --token mcp_pat_...` in someone's provisioning
// script must not start failing.
describe("runInstall — deprecated --token / --no-yaw-mcp-config", () => {
  it("accepts --token, warns on stderr, exits 0, and writes no ~/.yaw-mcp/config.json", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_scripted_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toContain(TOKEN_FLAG_DEPRECATION);
    // The PAT itself is never echoed back.
    expect(cap.stderr()).not.toContain("mcp_pat_scripted_aaaa");
    expect(cap.stdout()).not.toContain("mcp_pat_scripted_aaaa");
    // The client install still happened; the token file did not.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("names the deprecation reason and tells the user to revoke the PAT", () => {
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/deprecated and ignored/);
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/local-only/);
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/revoke that PAT/);
  });

  it("accepts --no-yaw-mcp-config, warns, and exits 0", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skipYawMcpConfig: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toContain(NO_CONFIG_FLAG_DEPRECATION);
  });

  it("leaves an existing ~/.yaw-mcp/config.json completely untouched", async () => {
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const cfgPath = join(synthHome, ".yaw-mcp", "config.json");
    const originalBytes = JSON.stringify({ token: "mcp_pat_existing_aaaa", version: 1 });
    writeFileSync(cfgPath, originalBytes, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_new_bbbb",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Byte-identical: no rewrite, no rotation, and no `.bak-*` sibling.
    expect(readFileSync(cfgPath, "utf8")).toBe(originalBytes);
    expect(readdirSync(join(synthHome, ".yaw-mcp")).filter((f) => f.startsWith("config.json.bak-"))).toHaveLength(0);
  });

  it("warns ONCE under --all, not once per client", async () => {
    const cap = captureIo();
    const r = await runInstall({
      all: true,
      os: "linux",
      home: synthHome,
      token: "mcp_pat_all_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const hits = cap.stderr().split(TOKEN_FLAG_DEPRECATION).length - 1;
    expect(hits).toBe(1);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("a scripted `install --all --token <pat>` parses and runs clean end to end", async () => {
    const parsed = parseInstallArgs(["--all", "--token", "mcp_pat_scripted_zzzz"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cap = captureIo();
    const r = await runInstall({
      ...parsed.options,
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
  });
});

describe("runInstall — --dry-run", () => {
  it("does not write any files but reports what would be written", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    // Would-write list covers client config + settings.json patch.
    expect(r.wouldWrite.length).toBe(2);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
    expect(cap.stdout()).toMatch(/dry run/i);
  });

  it("never echoes a passed --token into the dry-run dump", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_super_secret_value",
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Nothing renders the token any more -- the config.json dump is gone.
    expect(cap.stdout()).not.toContain("mcp_pat_super_secret_value");
    expect(cap.stderr()).not.toContain("mcp_pat_super_secret_value");
  });
});

describe("runInstall — Claude Desktop on Linux refused", () => {
  it("exits 2 with helpful message", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-desktop",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/not available on linux/i);
    expect(cap.stderr()).toMatch(/Claude Code or Cursor/);
  });
});

describe("runInstall — mutually exclusive flags", () => {
  it("--force + --skip refused with exit 2", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      force: true,
      skip: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });

  it("--list + --all refused with exit 2", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      listOnly: true,
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });
});

describe("parseInstallArgs — --list / --all", () => {
  it("accepts --list with no positional", () => {
    const r = parseInstallArgs(["--list"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.listOnly).toBe(true);
      expect(r.options.clientId).toBeUndefined();
    }
  });

  it("accepts --all with no positional", () => {
    const r = parseInstallArgs(["--all"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.all).toBe(true);
      expect(r.options.clientId).toBeUndefined();
    }
  });

  it("rejects --list combined with a client positional", () => {
    const r = parseInstallArgs(["claude-code", "--list"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--list does not take a client argument");
  });

  it("rejects --all combined with a client positional", () => {
    const r = parseInstallArgs(["cursor", "--all"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--all does not take a client argument");
  });

  it("accepts --all combined with --token", () => {
    const r = parseInstallArgs(["--all", "--token", "mcp_pat_xyz"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.all).toBe(true);
      expect(r.options.token).toBe("mcp_pat_xyz");
    }
  });
});

describe("runInstall --list (read-only)", () => {
  it("enumerates all clients on linux and shows `not installed` by default", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toContain("CLIENT");
    expect(out).toContain("SCOPE");
    expect(out).toContain("STATUS");
    // Claude Desktop is unavailable on linux.
    expect(out).toMatch(/Claude Desktop\s+user\s+\(n\/a\)\s+unavailable/);
    // Nothing seeded, so every other client reads "not installed".
    expect(out).toContain("not installed");
    expect(out).not.toContain("installed "); // "installed" word only appears in status heading/rows
    expect(out).toContain("0/");
  });

  it("detects an installed yaw-mcp entry in ~/.claude.json", async () => {
    // Seed Claude Code user-scope config with the entry.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
      "utf8",
    );
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toMatch(/Claude Code\s+user\s+~[\\/].claude\.json\s+installed/);
    // At least one scope is configured; headline reflects that.
    expect(out).toMatch(/^\d+\/\d+ client scopes have yaw-mcp configured on linux\./m);
  });

  it("reports `malformed` for unparseable client config", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{not valid json", "utf8");
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/Claude Code\s+user\s+~[\\/].claude\.json\s+malformed/);
  });

  it("does not require a token", async () => {
    // No token anywhere. --list should still work.
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toBe("");
  });
});

describe("runInstall --all", () => {
  it("installs into every user-scope client on linux", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Claude Code user → ~/.claude.json exists.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    // Cursor user → ~/.cursor/mcp.json exists.
    expect(existsSync(join(synthHome, ".cursor", "mcp.json"))).toBe(true);
    // Claude Desktop is unavailable on linux, so skipped — no claude_desktop_config.
    // VS Code requires project-dir (user-scope unsupported); it's reported as skipped.
    const out = cap.stdout();
    expect(out).toContain("skip vscode");
    expect(out).toMatch(/Done: \d+\/\d+ clients installed successfully\./);
    // ~/.yaw-mcp/config.json is not part of an install any more.
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("refuses with exit 1 when no clients are installable on the OS", async () => {
    const cap = captureIo();
    const r = await runInstall({
      // Synthetic OS value. Cast to bypass the TS guard since we're
      // probing the runtime error path.
      os: "plan9" as unknown as "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toContain("no installable clients");
  });

  it("returns exit 1 when at least one sub-install fails", async () => {
    // Seed a malformed ~/.claude.json so Claude Code user-scope install
    // refuses (exit 1); Cursor install still succeeds. Aggregate fails.
    writeFileSync(join(synthHome, ".claude.json"), "{oops", "utf8");
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/client install.*failed/);
  });

  it("consolidates collision-without-flag refusals into ONE hint", async () => {
    // Seed BOTH user-scope clients (claude-code, cursor) with an existing
    // yaw-mcp entry so each sub-install collides. Non-TTY + no --force/--skip
    // => each would emit its own "already has entry and stdin is not a TTY"
    // refusal. The consolidated path collapses them into one hint.
    const seeded = { mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } };
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify(seeded), "utf8");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(join(synthHome, ".cursor", "mcp.json"), JSON.stringify(seeded), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    const stderr = cap.stderr();
    // Exactly ONE "not a TTY" line, naming both clients, with the re-run hint.
    const ttyLines = stderr.split("\n").filter((l) => /stdin is not a TTY/.test(l));
    expect(ttyLines).toHaveLength(1);
    expect(stderr).toContain("claude-code");
    expect(stderr).toContain("cursor");
    expect(stderr).toMatch(/--all --force/);
    expect(stderr).toMatch(/--skip/);
  });

  it("--all --force overwrites colliding clients without the consolidated hint", async () => {
    const seeded = { mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } };
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify(seeded), "utf8");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(join(synthHome, ".cursor", "mcp.json"), JSON.stringify(seeded), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).not.toMatch(/stdin is not a TTY/);
  });
});

describe("install usage", () => {
  it("lists --token and --no-yaw-mcp-config as deprecated rather than dropping them", () => {
    // They must still be discoverable -- a user whose script breaks needs to
    // find out WHY from `install --help`, not just see the flag vanish.
    expect(INSTALL_USAGE).toMatch(/Deprecated \(accepted, ignored, warns\)/);
    expect(INSTALL_USAGE).toContain("--token");
    expect(INSTALL_USAGE).toContain("--no-yaw-mcp-config");
    expect(INSTALL_USAGE).toMatch(/local-only/);
  });
});

describe("runInstall — oam launch entry", () => {
  it("writes an oam entry when oam and a durable install both resolve", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("/usr/local/bin/oam");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", OAM_ENTRY]);
  });

  it("persists the absolute binPath, never the bare name the probe spawns", async () => {
    // The regression the whole binPath split exists for. `bin` is "oam" without
    // OAM_BIN -- correct to spawn from a shell-launched CLI, fatal to persist:
    // Claude Desktop launched from the Dock has no ~/.oam/bin on PATH, so the
    // broker ENOENTs with no fallback and doctor exempts non-absolute commands.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BARE_RESOLVED,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("/home/j/.oam/bin/oam");
    expect(client.mcpServers[ENTRY_NAME].command).not.toBe("oam");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", OAM_ENTRY]);
  });

  it("stays on npx, and says why, when oam runs but has no persistable path", async () => {
    // oam works in THIS process and yaw-mcp is durably installed -- both halves
    // the old check looked at. There is still nothing portable to write, so npx
    // wins, and the user gets told rather than left with a silent downgrade.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BARE_UNRESOLVED,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    expect(out).toMatch(/absolute path could not be resolved/);
    expect(out).toContain("OAM_BIN");
  });

  it("does not claim the oam runtime when the resolved binPath is relative", async () => {
    // The Runtime line used to be derived from `oamBinPath && oamEntry` while
    // buildLaunchEntry additionally required isAbsolute(oamBinPath), so this
    // machine got "will run on oam" printed over an `npx` entry -- and no line
    // at all explaining why the broker was not on oam.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_RELATIVE_BINPATH,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    expect(out).not.toMatch(/will run on oam/);
    // ...and the fallback is named, with the offending path and the remedy.
    expect(out).toMatch(/relative path/);
    expect(out).toContain("node_modules/.bin/oam");
    expect(out).toContain("OAM_BIN");
  });

  it("explains a below-min oam instead of printing the oam-absent output", async () => {
    // Before this, a below-min oam took the same branch as no oam at all and
    // said nothing -- byte-identical human output for two different machines.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BELOW_MIN,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    // Both versions, so "upgrade oam" is actionable without a second command.
    expect(out).toContain("0.8.2");
    expect(out).toContain(MIN_OAM_VERSION);
  });

  it("distinguishes a broken oam from an absent one", async () => {
    const broken = captureIo();
    const withBroken = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: broken.io,
      oamProbe: OAM_BROKEN,
    });
    expect(withBroken.exitCode).toBe(0);
    const brokenOut = withBroken.messages.join(" ");
    expect(brokenOut).toMatch(/installed but unusable/);
    expect(brokenOut).toContain("did not answer in time");

    // Absence now gets a line too -- it used to be the one branch of the chain
    // that said nothing, so a fresh machine got an npx entry with no hint that
    // oam existed. What must NOT leak across is the broken wording: sending
    // someone with no oam to "fix or reinstall" it is the inverse of the bug the
    // branches above exist to prevent.
    const absentHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-absent-"));
    try {
      const absent = captureIo();
      const withAbsent = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: absentHome,
        io: absent.io,
        oamProbe: OAM_ABSENT,
      });
      expect(withAbsent.exitCode).toBe(0);
      const absentOut = withAbsent.messages.join(" ");
      expect(absentOut).toMatch(/Runtime: node \(oam is not installed/);
      expect(absentOut).toContain(OAM_INSTALL_SH);
      expect(absentOut).not.toMatch(/unusable/);
      // Nothing is broken, so it must not read as a repair instruction.
      expect(absentOut).not.toMatch(/Fix or reinstall/);
    } finally {
      rmSync(absentHome, { recursive: true, force: true });
    }
  });

  it("prints the oam-absent note ONCE under --all, not once per client", async () => {
    // Absence is a machine-level fact and the common case, so the per-client
    // Runtime line would stack up one identical copy per installed client --
    // the same noise the collision refusal is consolidated to avoid. The other
    // Runtime reasons are rare misconfigurations and still print per client.
    const allHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-all-absent-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        all: true,
        os: "linux",
        home: allHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      const out = r.messages.join("\n");
      // More than one client must actually have been installed, or this pins
      // nothing -- a single-client run would read as "once" either way.
      expect(out.split("──").length - 1).toBeGreaterThan(1);
      expect(out.split(OAM_INSTALL_SH).length - 1).toBe(1);
    } finally {
      rmSync(allHome, { recursive: true, force: true });
    }
  });

  it("names the windows installer when install is asked about windows", async () => {
    // The install command is selected from the --os the report is ABOUT, never
    // process.platform: a report generated on linux for a windows machine that
    // hands back the curl line is a command that machine cannot run.
    const winHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-absent-win-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "windows",
        home: winHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      const out = r.messages.join(" ");
      expect(out).toContain(OAM_INSTALL_PS1);
      expect(out).not.toContain(OAM_INSTALL_SH);
    } finally {
      rmSync(winHome, { recursive: true, force: true });
    }
  });

  it("warns when the durable entry is a project-local node_modules", async () => {
    // resolveStableNpmEntry calls any non-_npx hit durable, including a repo's
    // own node_modules -- and this config is machine-global, so an `rm -rf
    // node_modules` weeks later kills the broker in every project at once.
    // Built with path.join so the fixture matches the runner's separators.
    const projectEntry = join(synthCwd, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      io: cap.io,
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => projectEntry,
    });
    expect(r.exitCode).toBe(0);
    // The entry is still written -- this is a note, not a refusal.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", projectEntry]);
    const out = r.messages.join(" ");
    expect(out).toMatch(/project-local install/);
    expect(out).toContain("npm i -g @yawlabs/mcp");
  });

  it("does not warn when the durable entry is a global install", async () => {
    const globalHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-global-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: globalHome,
        cwd: synthCwd,
        io: cap.io,
        oamProbe: OAM_PRESENT,
        resolveOamEntry: () => "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      });
      expect(r.exitCode).toBe(0);
      expect(r.messages.join(" ")).not.toMatch(/project-local/);
    } finally {
      rmSync(globalHome, { recursive: true, force: true });
    }
  });

  it("stays on npx when oam is present but nothing durable resolves", async () => {
    // The common shape: launched via `npx -y`, so yaw-mcp lives only in the
    // npx cache and there is no path safe to persist.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      home: synthHome,
      io: cap.io,
      os: "linux",
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => null,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(r.messages.join(" ")).toContain("not durably installed");
  });

  it("keeps an existing entry's env across a reinstall", async () => {
    // OAM_BIN pins WHICH oam hosts the sidecars. The merge replaces our entry
    // wholesale and the default entry carries no env, so without this the
    // setting silently vanished and the sidecars moved runtime.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "old"], env: { OAM_BIN: "/custom/oam" } } },
      }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      home: synthHome,
      io: cap.io,
      os: "linux",
      force: true,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].env).toEqual({ OAM_BIN: "/custom/oam" });
    // and the command was still refreshed -- preservation must not freeze the entry
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcp@latest"]);
  });
});

describe("runInstall — preserves the user's bytes and perms", () => {
  it("keeps comments in a pre-existing client config instead of flattening it", async () => {
    // `.vscode/mcp.json` is documented JSONC and its `inputs` array is
    // routinely commented; ~/.claude.json carries user comments too. install
    // used to read-modify-write through JSON.parse + JSON.stringify, deleting
    // every one of them with no warning -- while `yaw-mcp try`, writing the
    // SAME files, preserved them.
    const clientPath = join(synthHome, ".claude.json");
    const original = [
      "{",
      "  // keep me: pinned for the design review",
      '  "model": "claude-opus-4-7",',
      '  "mcpServers": {',
      "    /* the spend server is scoped to the finance workspace */",
      '    "spend": { "url": "https://x" }',
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const after = readFileSync(clientPath, "utf8");
    expect(after).toContain("// keep me: pinned for the design review");
    expect(after).toContain("/* the spend server is scoped to the finance workspace */");
    // ...and the entry actually landed, next to what was already there.
    const parsed = parseJsonc(after) as {
      model: string;
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.model).toBe("claude-opus-4-7");
    expect(parsed.mcpServers.spend).toEqual({ url: "https://x" });
    expect(parsed.mcpServers[ENTRY_NAME]).toBeDefined();
  });

  it("keeps comments in settings.json when patching permissions.allow", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const original = [
      "{",
      "  // team baseline -- do not reorder",
      '  "permissions": { "allow": ["Bash(git *)"] }',
      "}",
      "",
    ].join("\n");
    writeFileSync(settingsPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const after = readFileSync(settingsPath, "utf8");
    expect(after).toContain("// team baseline -- do not reorder");
    const allow = (parseJsonc(after) as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow).toEqual(["Bash(git *)", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  // POSIX-only: Windows does not carry these mode bits.
  it.skipIf(process.platform === "win32")(
    "does not widen an owner-only client config to the umask default",
    async () => {
      // atomicWriteFile renames a NEW inode over the target, so install used to
      // hand a 0600 ~/.claude.json back at 0644 -- including one `yaw-mcp try`
      // had chmod'd 0600 because it holds an inline API key, which install then
      // rewrites (it deliberately carries a prior entry's env forward).
      const clientPath = join(synthHome, ".claude.json");
      writeFileSync(
        clientPath,
        JSON.stringify({ mcpServers: { "yaw-mcp-try-demo": { command: "npx", env: { API_KEY: "s" } } } }),
        { mode: 0o600 },
      );
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        force: true,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      expect(statSync(clientPath).mode & 0o777).toBe(0o600);
      // The secret-bearing trial entry is still in the file it was protecting.
      const client = JSON.parse(readFileSync(clientPath, "utf8"));
      expect(client.mcpServers["yaw-mcp-try-demo"].env.API_KEY).toBe("s");
    },
  );
});

describe("runInstall — legacy allow-pattern stripping", () => {
  function seedSettings(allow: string[]): string {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow } }), "utf8");
    return settingsPath;
  }

  it("keeps mcp__yaw_mcp__* while the legacy `yaw-mcp` entry is still wired", async () => {
    // install does NOT remove the legacy mcpServers entry -- it only warns
    // that it "remains". Stripping its allow-pattern in the same run revoked
    // a still-running server's grant, so Claude Code re-prompted on every one
    // of its tool calls until the user deleted the entry by hand.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "yaw-mcp": { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
      "utf8",
    );
    const settingsPath = seedSettings(["Bash(git *)", "mcp__yaw_mcp__*"]);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // The warning still fires -- the entry is what should go, not the grant.
    expect(cap.stdout()).toMatch(/legacy "yaw-mcp" entry remains/);
    const allow = (JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions: { allow: string[] } }).permissions
      .allow;
    expect(allow).toContain("mcp__yaw_mcp__*");
    expect(allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("strips mcp__yaw_mcp__* once the legacy entry is gone", async () => {
    // Nothing can match the wildcard any more, so it is genuinely dead and
    // should not accumulate forever.
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const settingsPath = seedSettings(["Bash(git *)", "mcp__yaw_mcp__*"]);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const allow = (JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions: { allow: string[] } }).permissions
      .allow;
    expect(allow).not.toContain("mcp__yaw_mcp__*");
    expect(allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });
});

describe("runInstall — cwd override drives project-scope writes", () => {
  it("resolves project scope against opts.cwd, not process.cwd()", async () => {
    // `cwd` is documented as the cwd override and --list honors it, but the
    // write path read process.cwd() directly -- so a call that looked hermetic
    // created .vscode/mcp.json in whatever directory the runner was in.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthCwd, ".vscode", "mcp.json"))).toBe(true);
    expect(r.written).toContain(join(synthCwd, ".vscode", "mcp.json"));
  });
});

describe("runInstall — returned messages match what was printed", () => {
  it("--all carries the deprecation notice and the aggregate lines, not just the sub-installs", async () => {
    const cap = captureIo();
    const r = await runInstall({
      all: true,
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_all_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const trail = r.messages.join("\n");
    // Emitted by the --all layer itself; a second, locally-built array dropped
    // every one of these while the user saw them all on stdout/stderr.
    expect(trail).toContain(TOKEN_FLAG_DEPRECATION);
    expect(trail).toMatch(/Installing into \d+ clients?…/);
    expect(trail).toContain("── claude-code (user) ──");
    expect(trail).toMatch(/Done: \d+\/\d+ clients installed successfully\./);
    // ...and still carries each sub-install's own trail.
    expect(trail).toContain(`Wrote ${join(synthHome, ".claude.json")}`);
  });

  it("--list carries the deprecation notice alongside the table", async () => {
    const cap = captureIo();
    const r = await runInstall({
      listOnly: true,
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_list_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const trail = r.messages.join("\n");
    expect(trail).toContain(TOKEN_FLAG_DEPRECATION);
    expect(trail).toContain("CLIENT");
  });
});

describe("readEntryAt", () => {
  it("returns the entry, or null for every shape that is not one", () => {
    const cfg = { mcpServers: { [ENTRY_NAME]: { command: "npx", env: { A: "1" } } } };
    expect(readEntryAt(cfg, ["mcpServers"], ENTRY_NAME)?.env).toEqual({ A: "1" });
    // Absent container, absent entry, and non-object shapes must all be null
    // rather than throw: these come from a user-editable config file.
    expect(readEntryAt({}, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: {} }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: [] }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: "nope" }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: { [ENTRY_NAME]: "nope" } }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: { [ENTRY_NAME]: [] } }, ["mcpServers"], ENTRY_NAME)).toBeNull();
  });
});
