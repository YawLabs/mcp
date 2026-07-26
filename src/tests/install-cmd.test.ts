import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  runInstall,
  TOKEN_FLAG_DEPRECATION,
} from "../install-cmd.js";
import { CLAUDE_CODE_ALLOW_PATTERN, ENTRY_NAME } from "../install-targets.js";

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
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
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
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not valid JSON/);
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
    const r = await runInstall({ ...parsed.options, os: "linux", home: synthHome, io: cap.io });
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
