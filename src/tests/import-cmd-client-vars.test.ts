// Import follow-ups that are row data rather than importer branches:
//   * client-expanded variables are refused by NAME for every row that
//     declares `hooks.importVariables` (Claude Code, Cursor; VS Code and Cline
//     are covered in import-cmd.test.ts),
//   * Gemini CLI's `httpUrl` spelling of a remote is imported,
//   * a broker wired under a key that is not its own counts as wiring,
//   * a write that deletes stored env values says so, by name.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyClientConfig } from "../client-config.js";
import { runImport } from "../import-cmd.js";
import {
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallScope,
  resolveInstallPath,
  resolveInstallSites,
} from "../install-targets.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-import-vars-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/** Write a client's config file at the path its own row resolves. */
function writeClient(
  clientId: InstallClientId,
  content: unknown,
  scope: InstallScope = "user",
  projectDir?: string,
): string {
  const path = resolveInstallPath({ clientId, scope, os: CURRENT_OS, home: synthHome, projectDir }).absolute;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

function bundles(): Array<Record<string, unknown>> {
  const path = join(synthHome, CONFIG_DIRNAME, "bundles.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { servers: Array<Record<string, unknown>> }).servers;
}

const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

describe("runImport -- client-expanded variables are refused by name, per the row's hook", () => {
  it("declares the scheme on the row, and import reads no client id for it", () => {
    const hook = (id: string) => INSTALL_TARGETS.find((t) => t.clientId === id)?.hooks?.importVariables;
    expect(hook("claude-code")).toBe("posix-env");
    expect(hook("cursor")).toBe("cursor-env");
    expect(hook("vscode")).toBe("vscode-inputs");
    expect(hook("cline")).toBe("cline-env");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "import-cmd.ts"), "utf8");
    expect(src).not.toMatch(/clientId\s*===\s*["']/);
  });

  it("Claude Code: ${VAR} and ${VAR:-default} skip the server; other spans are literal text and are carried", async () => {
    const path = writeClient("claude-code", {
      mcpServers: {
        mcp: BROKER,
        api: { command: "npx", args: ["-y", "srv", "--root=${HOME}/data"], env: { API_KEY: "prefix-${API_KEY}" } },
        remote: { url: "${API_BASE:-https://api.example.com}/mcp" },
        // Not Claude Code variables: literal to it, so literal here -- and
        // ${secret:NAME} is yaw-mcp's own reference.
        literal: { command: "node", args: ["${input:x}", "${env:Y}"], env: { T: "${secret:TOKEN}" } },
      },
    });
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const rows = bundles();
    expect(rows.map((s) => s.namespace)).toEqual(["literal"]);
    expect(rows[0].args).toEqual(["${input:x}", "${env:Y}"]);
    expect(rows[0].env).toEqual({ T: "${secret:TOKEN}" });
    const err = cap.errText();
    expect(err).toMatch(/Skipped \(Claude Code expands these variables itself/);
    expect(err).toMatch(/api: \$\{HOME\}, \$\{API_KEY\}/);
    expect(err).toContain("remote: ${API_BASE:-https://api.example.com}");
    // The span only, never the text around it; and no hedged "carried" note.
    expect(err).not.toContain("prefix-");
    expect(err).not.toContain("as literal text");
    // A skipped server is still Claude Code's to launch: it is not removed.
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["api", "mcp", "remote"]);
  });

  it("Cursor: ${env:NAME} and ${userHome} skip the server; ${workspaceFolder} expands at project scope", async () => {
    writeClient(
      "cursor",
      {
        mcpServers: {
          needsenv: { command: "node", args: ["a.js"], env: { TOKEN: "${env:MY_TOKEN}" } },
          home: { command: "${userHome}/bin/srv" },
          local: { command: "node", args: ["${workspaceFolder}/server.js"] },
          plain: { command: "node", args: ["${NOT_CURSOR}"] },
        },
      },
      "project",
      synthCwd,
    );
    const cap = capture();
    const r = await runImport({
      clientId: "cursor",
      scope: "project",
      projectDir: synthCwd,
      home: synthHome,
      cwd: synthCwd,
      keepOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const rows = bundles();
    expect(rows.map((s) => s.namespace).sort()).toEqual(["local", "plain"]);
    expect(rows.find((s) => s.namespace === "local")?.args).toEqual([`${synthCwd}/server.js`]);
    expect(rows.find((s) => s.namespace === "plain")?.args).toEqual(["${NOT_CURSOR}"]);
    const err = cap.errText();
    expect(err).toMatch(/Skipped \(Cursor expands these variables itself/);
    expect(err).toContain("needsenv: ${env:MY_TOKEN}");
    expect(err).toContain("home: ${userHome}");
  });

  it("Cursor at user scope: ${workspaceFolder} has no value here, so the server is skipped", async () => {
    writeClient("cursor", { mcpServers: { local: { command: "node", args: ["${workspaceFolder}/server.js"] } } });
    const cap = capture();
    await runImport({ clientId: "cursor", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(cap.errText()).toContain("local: ${workspaceFolder}");
  });
});

describe("runImport -- Gemini CLI's httpUrl", () => {
  it("imports an httpUrl server as a streamable-http remote, headers included", async () => {
    writeClient("gemini-cli", {
      mcpServers: {
        cloud: {
          httpUrl: "https://my-gcp-service.run.app/mcp",
          url: "https://ignored.example/sse",
          type: "sse",
          headers: { Authorization: "Bearer g_x" },
        },
        events: { url: "https://example.test/sse", type: "sse" },
        stdio: { command: "node", args: ["s.js"] },
      },
    });
    const cap = capture();
    const r = await runImport({ clientId: "gemini-cli", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(r.exitCode).toBe(0);
    const rows = bundles();
    expect(rows.map((s) => s.namespace).sort()).toEqual(["cloud", "events", "stdio"]);
    const cloud = rows.find((s) => s.namespace === "cloud");
    // httpUrl wins over `url` and is streamable-http whatever `type` says.
    expect(cloud).toMatchObject({
      type: "remote",
      url: "https://my-gcp-service.run.app/mcp",
      headers: { Authorization: "Bearer g_x" },
    });
    expect(cloud?.transport).not.toBe("sse");
    expect(rows.find((s) => s.namespace === "events")).toMatchObject({ type: "remote", transport: "sse" });
    expect(cap.errText()).not.toMatch(/no command or url to launch/);
  });
});

// Which launch shapes count as the broker (the npx spec, `cmd /c npx`, the
// bin, and the sibling package and bin-as-argument that do not) is pinned
// through runImport in import-cmd.test.ts ("never imports an entry that
// LAUNCHES yaw-mcp"); these cover what the wiring question does with it.
describe("runImport -- a broker wired under another key is wiring", () => {
  it("the view reports it through otherBrokerKeys, which entry() and legacyKey() do not see", () => {
    const site = resolveInstallSites({ clientId: "claude-code", scope: "user", os: CURRENT_OS, home: synthHome })[0];
    const view = classifyClientConfig(
      JSON.stringify({ mcpServers: { yaw: BROKER, fs: { command: "npx", args: ["-y", "fs"] } } }),
      site,
    );
    expect(view.entry()).toBeUndefined();
    expect(view.legacyKey()).toBeNull();
    expect(view.otherServerKeys()).toEqual(["yaw", "fs"]);
    expect(view.otherBrokerKeys()).toEqual(["yaw"]);
  });

  it("--remove-originals removes the originals when yaw-mcp is wired only as `yaw`", async () => {
    const path = writeClient("claude-code", {
      mcpServers: { yaw: BROKER, github: { command: "npx", args: ["-y", "gh"] } },
    });
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      isTTY: false,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(bundles().map((s) => s.namespace)).toEqual(["github"]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["yaw"]);
    expect(cap.errText()).not.toContain("yaw-mcp install claude-code");
  });

  it("a `try` trial entry is NOT wiring, even when it launches the package", async () => {
    const path = writeClient("claude-code", {
      mcpServers: { "yaw-mcp-try-demo": BROKER, github: { command: "npx", args: ["-y", "gh"] } },
    });
    const cap = capture();
    await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      isTTY: false,
      ...cap,
    });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["github", "yaw-mcp-try-demo"]);
    expect(cap.errText()).toContain("yaw-mcp install claude-code");
  });
});

describe("runImport -- a stdio entry replaced by a remote one names the env values it lost", () => {
  it("prints the names-only note beside the launch-change note", async () => {
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bundles.json"),
      `${JSON.stringify(
        {
          version: 1,
          servers: [
            {
              id: "local-linear",
              name: "linear",
              namespace: "linear",
              type: "local",
              transport: "stdio",
              command: "npx",
              args: ["-y", "linear-mcp"],
              env: { LINEAR_TOKEN: "lin_secret_value", BLANK: "" },
              isActive: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeClient("windsurf", { mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } });
    const cap = capture();
    const r = await runImport({
      clientId: "windsurf",
      home: synthHome,
      cwd: synthCwd,
      keepOriginals: true,
      force: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const row = bundles().find((s) => s.namespace === "linear");
    expect(row?.type).toBe("remote");
    expect(row?.env).toBeUndefined();
    const err = cap.errText();
    expect(err).toContain(
      "Note: importing linear deleted the env value stored on the entry (LINEAR_TOKEN): a remote server spawns no process, so nothing would read it.",
    );
    expect(cap.text() + err).not.toContain("lin_secret_value");
  });
});
