// doctor (and audit) health checks that no other test pinned: a broken entry
// in an editor copy of Cline's settings, a file-less editor copy, the
// alternate remote endpoint keys (httpUrl, serverUrl), a command-less TOML
// entry through the adapter path, a git row that also has an env ref under a
// different name, and audit's build preflight ahead of the vault resolve.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit } from "../audit-cmd.js";
import { type DoctorOptions, runDoctor } from "../doctor-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";
import { CONFIG_DIRNAME } from "../paths.js";

/** probeOam's answer when oam is not installed: keeps the real probe (a spawn
 *  of `oam --version`) out of the suite. */
const oamNotInstalled = () => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-doctor-gaps-")));
  cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function doctor(opts: DoctorOptions = {}) {
  const lines: string[] = [];
  const result = await runDoctor({
    cwd,
    home,
    env: {},
    os: "linux",
    out: (s) => lines.push(s),
    err: () => {},
    oamProbe: oamNotInstalled,
    skipRegistryCheck: true,
    ...opts,
  });
  return { result, text: lines.join("") };
}

/** The file doctor probes for one (client, scope) in this temp home, read off
 *  a first run rather than spelled here, so the row's own path rule decides. */
async function probedPath(clientId: string, scope = "user"): Promise<string> {
  const { result } = await doctor();
  const path = result.snapshot.clients.find((c) => c.clientId === clientId && c.scope === scope)?.path;
  expect(path).toBeTruthy();
  return path as string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const BROKER = { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] };

/** Cline's shared settings file, with the broker wired in. */
function writeClineShared(): string {
  const file = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
  writeJson(file, { mcpServers: { [ENTRY_NAME]: BROKER } });
  return file;
}

/** The VS Code extension's globalStorage dir (Linux layout): its presence is
 *  what makes doctor probe the VS Code copy. */
const vsCodeStorage = (): string => join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");

describe("doctor -- Cline's editor copies", () => {
  it("a broken entry in the VS Code copy moves the exit code and names that copy's path", async () => {
    const shared = writeClineShared();
    const copy = join(vsCodeStorage(), "settings", "cline_mcp_settings.json");
    writeJson(copy, { mcpServers: { [ENTRY_NAME]: {} } });

    const { result, text } = await doctor();
    expect(result.exitCode).toBe(2);
    expect(text).toMatch(/Cline \(user, shared settings\): OK/);
    expect(text).toMatch(/Cline \(user, VS Code\): has "mcp" entry, but it has no launch command/);
    const warnings = result.snapshot.config.warnings.filter((w) => w.includes("has no launch command"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(copy);
    expect(warnings[0]).not.toContain(shared);
  });

  it("a VS Code copy with the detect dir but no settings file is an exists:false row, exit 0, no warning", async () => {
    const shared = writeClineShared();
    mkdirSync(vsCodeStorage(), { recursive: true });
    const copy = join(vsCodeStorage(), "settings", "cline_mcp_settings.json");

    const { result, text } = await doctor({ json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(text);
    const cline = (parsed.clients as Array<{ clientId: string; site?: string; path: string; exists: boolean }>)
      .filter((c) => c.clientId === "cline")
      .map((c) => [c.site, c.path, c.exists]);
    expect(cline).toEqual([
      ["shared settings", shared, true],
      ["VS Code", copy, false],
    ]);
    expect(JSON.stringify(parsed.warnings)).not.toContain("cline_mcp_settings.json");
  });
});

describe("doctor -- remote entries spelled with the alternate endpoint keys", () => {
  it.each([
    ["gemini-cli", "httpUrl"],
    ["windsurf", "serverUrl"],
  ])("%s: an entry with %s and no command is not flagged as having no launch command", async (clientId, key) => {
    const path = await probedPath(clientId);
    writeJson(path, { mcpServers: { [ENTRY_NAME]: { [key]: "https://mcp.example.com/mcp" } } });

    const { result, text } = await doctor();
    const row = result.snapshot.clients.find((c) => c.clientId === clientId && c.scope === "user");
    expect(row?.hasMcpEntry).toBe(true);
    expect(row?.launchNoCommand).toBe(false);
    expect(text).not.toContain("has no launch command");
    expect(result.exitCode).toBe(0);
  });
});

describe("doctor -- a command-less TOML entry (adapter path)", () => {
  it("flags a Codex [mcp_servers.mcp] table with args and no command, with a warning and exit 2", async () => {
    const path = await probedPath("codex-cli");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `[mcp_servers.${ENTRY_NAME}]\nargs = ["-y", "@yawlabs/mcp"]\n`);

    const { result, text } = await doctor();
    const row = result.snapshot.clients.find((c) => c.clientId === "codex-cli" && c.scope === "user");
    expect(row?.hasMcpEntry).toBe(true);
    expect(row?.launchNoCommand).toBe(true);
    expect(text).toContain(`has "${ENTRY_NAME}" entry, but it has no launch command`);
    expect(result.snapshot.config.warnings.join("\n")).toContain("has no launch command");
    expect(result.exitCode).toBe(2);
  });
});

describe("doctor vault section -- a git row that also has a different start-time ref", () => {
  it("lists both names, spells each by its kind, and keeps the locked-vault note", async () => {
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      join(home, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            namespace: "mixed",
            name: "Mixed",
            git: {
              url: "https://example.test/acme/server.git",
              commit: "0123456789abcdef0123456789abcdef01234567",
              entry: "dist/index.js",
              tokenSecret: "T",
            },
            env: { API_KEY: "${secret:X}" },
          },
        ],
      }),
    );

    const json = await doctor({ json: true });
    expect(JSON.parse(json.text).vault.refs).toEqual([
      { namespace: "mixed", secretNames: ["T", "X"], gitTokenSecret: "T" },
    ]);

    const { text } = await doctor();
    expect(text).toContain("    mixed: ${secret:X}, git.tokenSecret: T (needed to clone or update)");
    expect(text).not.toContain("${secret:T}");
    expect(text).toContain("note:       the servers above FAIL TO START OR CONNECT while the vault is locked");
  });
});

describe("audit -- the build preflight runs before the vault resolve", () => {
  let savedPassphrase: string | undefined;
  beforeEach(() => {
    savedPassphrase = process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    if (savedPassphrase === undefined) delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    else process.env.YAW_MCP_VAULT_PASSPHRASE = savedPassphrase;
  });

  it("refuses an unbuilt git server with a vault ref on the build, not on the locked vault", async () => {
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      join(home, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            namespace: "acme",
            name: "acme",
            type: "local",
            transport: "stdio",
            git: {
              url: "git@github.com:acme/tools-mcp.git",
              ref: "main",
              commit: "2222222222222222222222222222222222222222",
              entry: "dist/index.js",
            },
            env: { API_KEY: "${secret:ACME_KEY}" },
          },
        ],
      }),
    );
    const out: string[] = [];
    const err: string[] = [];
    let called = false;
    const r = await runAudit({
      namespace: "acme",
      home,
      cwd: home,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      runner: async () => {
        called = true;
        return { grade: "A", score: 100 };
      },
    });
    expect(called).toBe(false);
    expect(r.exitCode).toBe(2);
    const text = err.join("\n");
    expect(text).toContain('"acme" is not built on this machine');
    expect(text).not.toContain("references vault secrets");
    expect(text).not.toContain("could not be resolved");
  });
});
