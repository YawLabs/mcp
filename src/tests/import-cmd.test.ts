import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseImportArgs, runImport } from "../import-cmd.js";
import { loadLocalBundles } from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-import-"));
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

/** Claude Code's user-scope file: `~/.claude.json`, `mcpServers` at the root. */
function writeClaudeCode(content: unknown): string {
  const path = join(synthHome, ".claude.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

/** VS Code's WORKSPACE file: `<project>/.vscode/mcp.json`, whose top-level key
 *  is `servers`, not `mcpServers`. Pasting a Claude Code shape here fails
 *  silently, which is exactly why the importer reads the shape off
 *  INSTALL_TARGETS instead of assuming one. */
function writeVsCodeWorkspace(content: unknown): string {
  mkdirSync(join(synthCwd, ".vscode"), { recursive: true });
  const path = join(synthCwd, ".vscode", "mcp.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function bundles(): Array<Record<string, unknown>> {
  const path = join(synthHome, CONFIG_DIRNAME, "bundles.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { servers: Array<Record<string, unknown>> }).servers;
}

/** A client config with yaw-mcp already wired in (what `yaw-mcp install`
 *  writes) plus two servers of the user's own. The broker entry is what makes
 *  removing the originals safe -- without it the servers would be reachable
 *  from nowhere at all. */
const WIRED = {
  mcpServers: {
    mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_x" } },
    linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_x" } },
  },
};

describe("parseImportArgs", () => {
  it("requires a client", () => {
    expect(parseImportArgs([]).ok).toBe(false);
  });

  it("rejects a client that is not in the install target table", () => {
    const r = parseImportArgs(["emacs"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("emacs");
  });

  it("parses a client plus the scope flags", () => {
    const r = parseImportArgs(["vscode", "--scope", "project", "--project-dir", "/tmp/p"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.clientId).toBe("vscode");
      expect(r.options.scope).toBe("project");
      expect(r.options.projectDir).toBe("/tmp/p");
    }
  });

  it("refuses --remove-originals together with --keep-originals", () => {
    // They are opposite answers to one question, and picking a winner silently
    // is exactly the class of thing this command must not do to a file the
    // user did not ask it to touch.
    const r = parseImportArgs(["claude-code", "--remove-originals", "--keep-originals"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--remove-originals|--keep-originals/);
  });

  it("routes --help to stdout with exit 0", () => {
    const r = parseImportArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help).toBe(true);
  });
});

describe("runImport -- reading a client config", () => {
  it("imports the servers a Claude Code config already has", async () => {
    writeClaudeCode(WIRED);
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      keepOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const rows = bundles();
    expect(rows.map((s) => s.namespace).sort()).toEqual(["github", "linear"]);
    const gh = rows.find((s) => s.namespace === "github");
    expect(gh?.command).toBe("npx");
    expect(gh?.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    // The entry's NAME is the key the user's client shows, which is the only
    // identity an imported server has -- there is no catalog slug.
    expect(gh?.name).toBe("github");
    expect(gh?.slug).toBeUndefined();
  });

  it("never imports yaw-mcp's own entry, under any of its names", async () => {
    // Importing the broker into itself makes yaw-mcp spawn yaw-mcp on every
    // activation. The current key is `mcp`; the three legacy ones are still on
    // disk in upgraded installs, and `try` writes `yaw-mcp-try-<slug>`.
    writeClaudeCode({
      mcpServers: {
        mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
        "mcp.hosting": { command: "npx", args: ["-y", "mcp.hosting"] },
        mcph: { command: "npx", args: ["-y", "mcph"] },
        "yaw-mcp": { command: "npx", args: ["-y", "@yawlabs/mcp"] },
        "yaw-mcp-try-brave": { command: "npx", args: ["-y", "brave"] },
        github: { command: "npx", args: ["-y", "gh"] },
      },
    });
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...capture() });
    expect(bundles().map((s) => s.namespace)).toEqual(["github"]);
  });

  it("reads VS Code's `servers` key, not `mcpServers`", async () => {
    // VS Code is the one client in the table whose top-level key differs. The
    // shape comes off INSTALL_TARGETS, so this is the case that proves the
    // importer is not assuming a single spelling.
    writeVsCodeWorkspace({ servers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } });
    const cap = capture();
    const r = await runImport({
      clientId: "vscode",
      scope: "project",
      projectDir: synthCwd,
      home: synthHome,
      cwd: synthCwd,
      keepOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    expect(bundles().map((s) => s.namespace)).toEqual(["fetch"]);
  });

  it("carries a remote entry across as a remote entry", async () => {
    writeClaudeCode(WIRED);
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...capture() });
    const linear = bundles().find((s) => s.namespace === "linear");
    expect(linear?.type).toBe("remote");
    expect(linear?.url).toBe("https://mcp.linear.app/mcp");
    expect(linear?.headers).toEqual({ Authorization: "Bearer lin_x" });
    expect(linear?.command).toBeUndefined();
  });

  it("carries env across, and reports the KEY names without their values", async () => {
    // The env is what makes an imported server actually work, so dropping it
    // would import a server that cannot start. It is also where the
    // credentials are, so the transcript names the keys and points at the
    // vault -- and never prints a value.
    writeClaudeCode(WIRED);
    const cap = capture();
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(bundles().find((s) => s.namespace === "github")?.env).toEqual({ GITHUB_TOKEN: "ghp_x" });
    const all = cap.text() + cap.errText();
    expect(all).toContain("GITHUB_TOKEN");
    expect(all).not.toContain("ghp_x");
    expect(all).not.toContain("lin_x");
    expect(all).toContain("yaw-mcp secrets set");
  });

  it("derives a namespace and reports a collision rather than silently keeping one", async () => {
    // Two client keys can derive one namespace ("my-tool" and "My Tool" both
    // land on "mytool"). The second overwrites the first through the upsert,
    // so the user has to be told which key won.
    writeClaudeCode({ mcpServers: { "my-tool": { command: "a" }, "My Tool": { command: "b" } } });
    const cap = capture();
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    const all = cap.text() + cap.errText();
    expect(all).toMatch(/collision|collide/i);
    expect(all).toContain("mytool");
  });

  it("says so, and writes nothing, when there is nothing to import", async () => {
    writeClaudeCode({ mcpServers: { mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] } } });
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, ...cap });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/nothing to import|no servers/i);
    expect(r.written).toEqual([]);
  });

  it("reports a missing client config instead of writing an empty import", async () => {
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/does not exist|not found/i);
  });

  it("refuses to act on a client config that is not valid JSON", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ not json");
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, ...cap });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/JSON/);
  });

  it("writes nothing under --dry-run", async () => {
    writeClaudeCode(WIRED);
    const before = readFileSync(join(synthHome, ".claude.json"), "utf8");
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, dryRun: true, ...cap });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.text()).toContain("github");
    // Neither file moved.
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(before);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers ?? []).toEqual([]);
  });
});

describe("runImport -- the duplicate-run trap", () => {
  it("warns that the originals keep loading, and asks before removing them", async () => {
    // The trap this command exists to close: after an import the client is
    // still launching the server DIRECTLY as well as through yaw-mcp, so the
    // user is running two copies of every server they imported.
    writeClaudeCode(WIRED);
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const all = cap.text() + cap.errText();
    expect(all).toMatch(/twice|both|still/i);
    // Declined: the client config is byte-identical.
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["github", "linear", "mcp"]);
  });

  it("removes exactly the imported entries when the user says yes", async () => {
    writeClaudeCode(WIRED);
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "y",
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    // The yaw-mcp entry stays -- it is how the imported servers are reached now.
    expect(Object.keys(after.mcpServers)).toEqual(["mcp"]);
    expect(r.written).toContain(join(synthHome, ".claude.json"));
  });

  it("never removes an original without being asked", async () => {
    // Off a TTY with no explicit flag, the import still happens and the
    // originals STAY -- silently unwiring a user's working client config is a
    // worse outcome than running a server twice.
    writeClaudeCode(WIRED);
    const cap = capture();
    const r = await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, isTTY: false, ...cap });
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["github", "linear", "mcp"]);
    // ...and it names the flag that would have done it.
    expect(cap.text() + cap.errText()).toContain("--remove-originals");
  });

  it("--remove-originals removes them with no prompt", async () => {
    writeClaudeCode(WIRED);
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      isTTY: false,
      ...capture(),
    });
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["mcp"]);
  });

  it("REFUSES to remove the originals when the client is not wired to yaw-mcp", async () => {
    // Without a yaw-mcp entry in the client config, removing the originals
    // leaves the client with no way to reach ANY of them -- the import would
    // read as a success and take every server offline.
    writeClaudeCode({ mcpServers: { github: { command: "npx", args: ["-y", "gh"] } } });
    const cap = capture();
    const r = await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      ...cap,
    });
    expect(r.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(Object.keys(after.mcpServers)).toEqual(["github"]);
    expect(cap.errText()).toContain("yaw-mcp install claude-code");
  });

  it("leaves every sibling key in the client config alone", async () => {
    // ~/.claude.json holds far more than mcpServers. A removal that rewrote
    // the file wholesale would take the rest of the user's Claude Code state
    // with it.
    writeClaudeCode({
      numStartups: 42,
      projects: { "/some/dir": { allowedTools: ["Bash"] } },
      mcpServers: { mcp: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] }, github: { command: "npx" } },
    });
    await runImport({
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      removeOriginals: true,
      ...capture(),
    });
    const after = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(after.numStartups).toBe(42);
    expect(after.projects["/some/dir"].allowedTools).toEqual(["Bash"]);
    expect(Object.keys(after.mcpServers)).toEqual(["mcp"]);
  });
});

describe("runImport -- what the imported entry can then be managed by", () => {
  it("writes a name `yaw-mcp remove` can resolve, since there is no slug", async () => {
    // The other half of the slug-less trap: an imported entry has no catalog
    // slug, so the ONLY identities it carries are its namespace and its name.
    // Both have to be reachable, or the import is a one-way door.
    writeClaudeCode({ mcpServers: { "GitHub Copilot": { command: "npx", args: ["-y", "x"] } } });
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...capture() });
    const [entry] = bundles();
    expect(entry.name).toBe("GitHub Copilot");
    expect(entry.namespace).toBe("githubcopilot");
    const { runRemove } = await import("../local-add-cmd.js");
    const r = await runRemove({
      target: "GitHub Copilot",
      home: synthHome,
      cwd: synthCwd,
      force: true,
      out: () => {},
      err: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(bundles()).toHaveLength(0);
  });

  it("re-importing updates rather than duplicating", async () => {
    writeClaudeCode(WIRED);
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...capture() });
    const cap = capture();
    await runImport({ clientId: "claude-code", home: synthHome, cwd: synthCwd, keepOriginals: true, ...cap });
    expect(
      bundles()
        .map((s) => s.namespace)
        .sort(),
    ).toEqual(["github", "linear"]);
    expect(cap.text()).toMatch(/updated/i);
  });
});
