// The typed row, as DATA.
//
// Imports the LEAF model only -- see the header of target-zed.ts for why.
//
// typed (https://typed.cloud) is a coding CLI that reads Claude Code's MCP
// files AND one file of its own, `<home>/.config/typed/mcp.json`. This row
// writes that file and none of Claude Code's, because each of Claude Code's
// would lose the entry somewhere typed is commonly run:
//   * `CLAUDE_CONFIG_DIR` in a Yaw Mode pane is a disposable per-session
//     overlay, so an entry written under it is gone when the pane closes;
//   * Yaw Terminal rewrites an `@yawlabs/mcp@latest` npx entry in
//     `.claude.json` to the copy it bundles and pins;
//   * `~/.mcp.json` is a PROJECT-scope file to Claude Code, not a user one.
//
// WHAT IS TYPED-SPECIFIC AND LIVES HERE:
//   * the path is `<home>/.config/typed/mcp.json` on EVERY OS, Windows
//     included -- os.homedir(), never %APPDATA%, $XDG_CONFIG_HOME or
//     CLAUDE_CONFIG_DIR. That is how typed resolves every file it keeps under
//     ~/.config/typed (its version-check cache is the same shape), so the
//     row's PATH reads no client env var at all;
//   * the file is STRICT JSON: typed parses it with JSON.parse, so a comment
//     in it loads no server, and `config.format` is "json" -- the strict
//     adapter then refuses to write into such a file, as it does for Cline;
//   * typed ranks this file above the user-scope slots it also reads:
//     ~/.mcp.json and <configDir>/.mcp.json (user files to typed only; Claude
//     Code reads the first as a project file and never reads the second), and
//     the top-level mcpServers of ~/.claude.json and <configDir>/.claude.json
//     -- and below a trusted project's .mcp.json and a .claude.json
//     local-scope entry, later winning for the same server name. So an "mcp"
//     entry here beats the one Yaw Terminal manages in ~/.claude.json, and a
//     project still wins -- the same local > project > user order Claude Code
//     applies. Those four lower-ranked files are `hooks.alsoReads`, where
//     <configDir> IS read from CLAUDE_CONFIG_DIR, because typed resolves it
//     from that variable (see typedAlsoReads);
//   * an npx entry here SHADOWS a local launch in those files -- Yaw Terminal's
//     bundled copy in ~/.claude.json is the common one -- and npx resolves
//     @latest on every typed start, which can outlast typed's MCP connect
//     timeout. install says so when it writes one over such a launch;
//   * a BARE npx on Windows: typed resolves a `.cmd` shim itself (it walks
//     PATH and PATHEXT before spawning), so the broker entry needs no
//     `cmd /c`. A `try` upstream keeps the shared wrap, as on every row that
//     declares a bare broker: that entry names a third-party launcher whose
//     args have to survive cmd's parse;
//   * reload "restart": typed reads its MCP config once, at startup;
//   * `hooks.permissionsPatch: "claude-code"`: typed reads `permissions.allow`
//     from the same user-scope settings.json Claude Code does
//     (`<CLAUDE_CONFIG_DIR>/settings.json` when that variable is non-empty,
//     else `~/.claude/settings.json`), which is exactly the file
//     `resolveClaudeCodeSettingsPath` names for scope "user". MCP tools are
//     named `mcp__<server>__<tool>` there too, so the `mcp__mcp__*` grant
//     install adds for Claude Code covers typed's "mcp" server as well. Both
//     rows now share that ONE grant, and `uninstall` keeps it while the other
//     row's entry -- or an "mcp" entry in one of typed's `alsoReads` files --
//     is still in place. The grant FOLLOWS CLAUDE_CONFIG_DIR where this file
//     does not, so under a set one it is scoped to that config dir; install
//     says so, and names a Yaw Mode pane overlay as the disposable case.
//
// NO PROJECT SCOPE, deliberately. typed reads `<project>/.mcp.json`, but that
// file is already claude-code's project scope and the `mcp` alias. A second
// row on the same file would double-report it in --list, doctor and try, so
// the notes point at `yaw-mcp install mcp` instead.
//
// VERSION FLOOR. Released typed 1.5.0 does not read this file. The notes say
// "newer than 1.5.0" rather than naming the next version, which has not
// shipped.

import { join } from "node:path";
import { defineTarget, type PathBase, type ResolvedPath } from "./install-target-model.js";

/** The container key, shared with Claude Code's files -- typed reads the same
 *  `{"mcpServers": {...}}` shape from each. */
const CONTAINER_KEY = "mcpServers";

/** A single backslash, from its code point -- the separator the other rows
 *  spell a Windows display path with. An escape typed into this file is one
 *  shell layer away from collapsing into something else. */
const WINDOWS_SEP = String.fromCharCode(92);

function resolveTypedPath(base: PathBase): ResolvedPath {
  // One scope, and it reads no project directory, so `base.scope` and
  // `base.projectDir` do not enter into it; the resolver has already refused
  // any other scope before this runs.
  return underHome(base, [".config", "typed", "mcp.json"]);
}

/** A home-relative file, displayed for the target OS the way the row's own
 *  path is. */
function underHome(base: PathBase, segments: string[]): ResolvedPath {
  return {
    absolute: join(base.home, ...segments),
    display: base.os === "windows" ? ["%USERPROFILE%", ...segments].join(WINDOWS_SEP) : ["~", ...segments].join("/"),
    containerPath: [CONTAINER_KEY],
  };
}

/** The four user-scope slots typed loads an "mcp" entry from BELOW its own
 *  file, lowest first -- `collectMcpConfigSources` in the typed CLI
 *  (apps/cli/src/mcp/config.ts): `<home>/.mcp.json`, `<configDir>/.mcp.json`,
 *  and the top-level mcpServers of `<home>/.claude.json` and
 *  `<configDir>/.claude.json`, with `<configDir>` resolved as typed's
 *  `resolveConfigDir` does -- CLAUDE_CONFIG_DIR when non-empty, else
 *  `<home>/.claude`. That is also the rule `resolveClaudeCodeSettingsPath`
 *  applies, so these and the grant move together. typed reads all four
 *  whatever CLAUDE_CONFIG_DIR says; the variable only moves the two
 *  `<configDir>` ones. */
function typedAlsoReads(base: PathBase): ResolvedPath[] {
  const cfg = base.env.claudeConfigDir;
  const inConfigDir = (name: string): ResolvedPath =>
    cfg !== undefined && cfg.length > 0
      ? {
          absolute: join(cfg, name),
          display: [cfg, name].join(base.os === "windows" ? WINDOWS_SEP : "/"),
          containerPath: [CONTAINER_KEY],
        }
      : underHome(base, [".claude", name]);
  return [
    underHome(base, [".mcp.json"]),
    inConfigDir(".mcp.json"),
    underHome(base, [".claude.json"]),
    inConfigDir(".claude.json"),
  ];
}

export const TYPED_TARGET = defineTarget({
  clientId: "typed",
  label: "typed",
  // STRICT: typed parses this file with JSON.parse.
  config: { format: "json", root: CONTAINER_KEY },
  availableOn: ["macos", "linux", "windows"],
  // typed reads its MCP config at startup and does not watch the file.
  reload: "restart",
  entry: {
    windowsLaunch: { broker: "bare", upstream: "cmd-wrap" },
  },
  // The grant is Claude Code's scheme, and typed reads it from the same file.
  hooks: { permissionsPatch: "claude-code", alsoReads: typedAlsoReads },
  notes:
    "typed reads ~/.config/typed/mcp.json at startup, ahead of the user-scope files it shares with Claude Code, so this entry wins over an \"mcp\" entry Yaw Terminal manages in ~/.claude.json; a project's .mcp.json still wins over it. On a Yaw Terminal machine that means an npx entry here replaces Yaw Terminal's local launch for typed, and npx resolves @latest on every typed start, which can outlast typed's MCP connect timeout -- `npm i -g @yawlabs/mcp` with oam installed, then re-run install, writes a fast absolute-path entry instead, or raise MCP_TIMEOUT. The file is strict JSON: no comments, no trailing commas. The mcp__mcp__* grant goes in Claude Code's user settings.json, which typed reads too; under a set CLAUDE_CONFIG_DIR that is <CLAUDE_CONFIG_DIR>/settings.json, so the grant is scoped to that config dir while this file is not -- run install from a shell without it (not a Yaw Mode pane, whose config dir is discarded when the pane closes) for a grant that lasts. There is no project scope here: <project>/.mcp.json is Claude Code's project file, which typed also reads -- use `yaw-mcp install mcp` for it. Needs a typed CLI newer than 1.5.0; older typed reads only Claude Code's files, so use `yaw-mcp install claude-code` there. Restart typed after editing.",
  resolvePath: resolveTypedPath,
  scopes: [
    {
      scope: "user",
      label: "User (global)",
      description: "typed's own MCP file; applies to every project.",
      requiresProjectDir: false,
    },
  ],
});
