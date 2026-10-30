import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALIASES,
  findEntry,
  lanes,
  parseClientIds,
  parseConfig,
  parseWrotePaths,
  SHARED_FILE_LANE,
  sandboxEnv,
} from "../../scripts/verify-clients.mjs";
import { CLIENT_ALIASES, clientChoices } from "../client-aliases.js";
import { INSTALL_TARGETS } from "../install-targets.js";

// The pure half of scripts/verify-clients.mjs, the release gate that installs
// the built dist/ into every client and launches what it wrote. The gate itself
// spawns real processes for ~100 s, so it runs from release.sh, not here; what
// these pin is every place the script RESTATES something the source owns, so a
// new client, alias or shared-file row cannot slip past the matrix.

describe("verify-clients: what it reads off the CLI", () => {
  it("parses every id `install --help` names, aliases included", () => {
    // The usage line is built from clientChoices(); the script's regex has to
    // accept every character an id can hold.
    const usage = `Usage: yaw-mcp install <${clientChoices("install").join("|")}> [--scope user|project|local]`;
    expect(parseClientIds(usage)).toEqual(clientChoices("install"));
  });

  it("returns no ids for text with no usage line, so the gate fails instead of passing over nothing", () => {
    expect(parseClientIds("Unknown flag: --help")).toEqual([]);
  });

  it("reads each Wrote path and drops the permissions patch line", () => {
    const out = [
      "Target: Claude Code (user)",
      "Wrote C:\\h\\.claude.json",
      "Wrote C:\\h\\.claude\\settings.json (added mcp__mcp__* to permissions.allow)",
      "Wrote /h/.cline/data/settings/cline_mcp_settings.json  ",
    ].join("\n");
    expect(parseWrotePaths(out)).toEqual(["C:\\h\\.claude.json", "/h/.cline/data/settings/cline_mcp_settings.json"]);
  });
});

describe("verify-clients: the tables it keeps", () => {
  it("installs exactly the alias table's ids as aliases", () => {
    expect([...ALIASES].sort()).toEqual(CLIENT_ALIASES.map((a) => a.id).sort());
  });

  it("serializes every row that patches Claude Code's settings.json", () => {
    // Two installs patching the same settings.json in parallel is the one
    // shared-file race the gate's lanes exist to avoid.
    const patchers = INSTALL_TARGETS.filter((t) => t.hooks?.permissionsPatch).map((t) => t.clientId as string);
    expect(patchers.length).toBeGreaterThan(0);
    for (const id of patchers) expect(SHARED_FILE_LANE.has(id)).toBe(true);
  });

  it("puts the shared ids in one lane and every other id in its own", () => {
    expect(lanes(["cursor", "claude-code", "zed", "typed"])).toEqual([["claude-code", "typed"], ["cursor"], ["zed"]]);
  });
});

describe("verify-clients: finding the entry", () => {
  const entry = { command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"] };

  it.each(["mcpServers", "servers", "context_servers", "mcp_servers"])("finds it under %s", (key) => {
    expect(findEntry({ [key]: { other: {}, mcp: entry } }, "user", "/p")).toEqual(entry);
  });

  it("reads Claude Code's local scope from projects[<dir>], not the top level", () => {
    const dir = join("/tmp", "proj");
    const root = { mcpServers: { mcp: { command: "top" } }, projects: { [dir]: { mcpServers: { mcp: entry } } } };
    expect(findEntry(root, "local", dir)).toEqual(entry);
    expect(findEntry(root, "local", join("/tmp", "elsewhere"))).toBeNull();
  });

  it("returns null when there is no mcp entry", () => {
    expect(findEntry({ mcpServers: { other: entry } }, "user", "/p")).toBeNull();
    expect(findEntry(null, "user", "/p")).toBeNull();
  });

  it("parses TOML by extension and JSONC otherwise, and throws on a broken file", () => {
    expect(parseConfig("c.toml", '[mcp_servers.mcp]\ncommand = "npx"\n')).toEqual({
      mcp_servers: { mcp: { command: "npx" } },
    });
    expect(parseConfig("s.json", '{ // c\n "servers": { "mcp": {} }, }')).toEqual({ servers: { mcp: {} } });
    expect(() => parseConfig("s.json", '{ "servers": ')).toThrow(/parse error/);
  });
});

describe("verify-clients: the sandbox environment", () => {
  it("points every home variable at the sandbox and drops what would leak the real one", () => {
    // A plain object, not process.env: on Windows process.env folds case, so
    // it cannot hold the `Codex_Home` / `NPM_CONFIG_USERCONFIG` spellings a
    // parent process really can hand down -- vitest itself passes npm's
    // variables through upper-cased.
    const env = sandboxEnv("/sb/home", {
      PATH: "/bin",
      NPM_CONFIG_USERCONFIG: "/real/.npmrc",
      npm_config_cache: "/real/cache",
      Claude_Config_Dir: "/real/claude",
      Codex_Home: "/real/codex",
      oam_bin: "/real/oam",
      YAW_MCP_TRUST_PROJECT: "1",
      Home: "/real/home",
    });
    const named = (re: RegExp) => Object.keys(env).filter((k) => re.test(k));
    expect(env.PATH).toBe("/bin");
    expect(named(/^home$/i)).toEqual(["HOME"]);
    expect(env.HOME).toBe("/sb/home");
    expect(env.USERPROFILE).toBe("/sb/home");
    expect(named(/^codex_home$/i)).toEqual(["CODEX_HOME"]);
    expect(env.CODEX_HOME).toBe(join("/sb/home", ".codex"));
    expect(named(/^npm_/i)).toEqual([]);
    expect(named(/^(claude_config_dir|oam_bin|yaw_mcp_trust_project)$/i)).toEqual([]);
    expect(env.YAW_MCP_AUTO_HEAL).toBe("0");
  });
});
