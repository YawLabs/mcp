// Import branches no other test drives:
//   * Claude Code at project scope: `${workspaceFolder}` is an environment
//     variable there (posix-env), never the project directory,
//   * a remote entry with a variable in BOTH its url and a header -- including
//     the same span in both -- gets both hand-add lines,
//   * a run whose only skips are unusable or notImportable entries says every
//     server was skipped, not that the file holds none.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntryTransform } from "../client-config.js";
import { runImport } from "../import-cmd.js";
import {
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallScope,
  resolveInstallPath,
} from "../install-targets.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-import-gaps-"));
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

const bundlesPath = (): string => join(synthHome, CONFIG_DIRNAME, "bundles.json");

const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

describe("runImport -- Claude Code's ${workspaceFolder} is an env var, even at project scope", () => {
  it("skips a project-scope server whose arg holds ${workspaceFolder}, and never rewrites it to the project dir", async () => {
    const path = writeClient(
      "claude-code",
      { mcpServers: { mcp: BROKER, local: { command: "node", args: ["${workspaceFolder}/server.js"] } } },
      "project",
      synthCwd,
    );
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      scope: "project",
      projectDir: synthCwd,
      home: synthHome,
      cwd: synthCwd,
      keepOriginals: true,
      isTTY: false,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    const err = cap.errText();
    expect(err).toMatch(/Skipped \(Claude Code expands these variables itself/);
    expect(err).toContain("local: ${workspaceFolder}");
    expect(existsSync(bundlesPath())).toBe(false);
    expect(cap.text() + err).not.toContain(`${synthCwd}/server.js`);
    // Still Claude Code's to launch: the original stays as written.
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.mcpServers.local.args).toEqual(["${workspaceFolder}/server.js"]);
  });
});

describe("runImport -- a remote entry with a variable in both its url and a header", () => {
  const HEADER_LINE =
    "  a variable in a header: `yaw-mcp add <name> --url <url> --header 'Authorization: Bearer ${secret:NAME}'`";
  const URL_LINE = "  a variable in a url: yaw-mcp does not fill in `${secret:NAME}` in a url";

  async function importRemote(remote: unknown): Promise<string> {
    writeClient("claude-code", { mcpServers: { mcp: BROKER, api: remote } });
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    return cap.errText();
  }

  it("different spans: the multi-line hint names both the header and the url", async () => {
    const err = await importRemote({
      url: "https://${HOST}/mcp",
      headers: { Authorization: "Bearer ${API_KEY}" },
    });
    expect(err).toContain("api: ${HOST}, ${API_KEY}");
    expect(err).toContain(`Add each by hand once you know the value:\n${HEADER_LINE}\n${URL_LINE}`);
    expect(err).not.toContain("--command");
  });

  it("the header repeats the url's span: the header line is still printed", async () => {
    const err = await importRemote({
      url: "https://api.example.com/${API_KEY}/mcp",
      headers: { Authorization: "Bearer ${API_KEY}" },
    });
    expect(err).toContain("api: ${API_KEY}");
    expect(err).toContain(`Add each by hand once you know the value:\n${HEADER_LINE}\n${URL_LINE}`);
  });
});

describe("runImport -- every server skipped for a reason other than a variable", () => {
  it("an entry with no command or url: 'Nothing imported', not 'beyond yaw-mcp's own entry'", async () => {
    writeClient("claude-code", { mcpServers: { mcp: BROKER, srv: { comand: "node" } } });
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.text()).toMatch(/Nothing imported: every server in .* was skipped \(see the reasons below\)\./);
    expect(cap.text()).not.toContain("beyond yaw-mcp's own entry");
    expect(cap.errText()).toContain("Skipped (no command or url to launch): srv");
    expect(existsSync(bundlesPath())).toBe(false);
  });

  it("an entry the row's forImport hook refuses: 'Nothing imported', not 'beyond yaw-mcp's own entry'", async () => {
    // No shipped row sets skipReason yet, so the Codex row's hook is wrapped
    // for this one test, as import-cmd.test.ts does.
    const row = INSTALL_TARGETS.find((t) => t.clientId === "codex-cli") as unknown as { entry: EntryTransform };
    const original = row.entry.forImport;
    if (original === undefined) throw new Error("codex-cli row lost its forImport hook");
    row.entry.forImport = (stored) =>
      stored.command === "ext-only"
        ? { ...original(stored), skipReason: "Codex resolves it through an extension" }
        : original(stored);
    try {
      const dir = join(synthHome, ".codex");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.toml"), '[mcp_servers.viaext]\ncommand = "ext-only"\n');
      const cap = capture();
      const r = await runImport({
        clientId: "codex-cli",
        home: synthHome,
        cwd: synthCwd,
        keepOriginals: true,
        isTTY: false,
        ...cap,
      });
      expect(r.exitCode).toBe(0);
      expect(r.written).toEqual([]);
      expect(cap.text()).toMatch(/Nothing imported: every server in .* was skipped \(see the reasons below\)\./);
      expect(cap.text()).not.toContain("beyond yaw-mcp's own entry");
      expect(cap.errText()).toContain(
        "Skipped (Codex CLI says these cannot be imported):\n  viaext: Codex resolves it through an extension\n",
      );
    } finally {
      row.entry.forImport = original;
    }
  });
});
