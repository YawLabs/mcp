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
//     ~/.config/typed (its version-check cache is the same shape), so the row
//     reads no client env var at all;
//   * the file is STRICT JSON: typed parses it with JSON.parse, so a comment
//     in it loads no server, and `config.format` is "json" -- the strict
//     adapter then refuses to write into such a file, as it does for Cline;
//   * typed ranks this file above Claude Code's user-scope files (~/.mcp.json,
//     <configDir>/.mcp.json, ~/.claude.json and <configDir>/.claude.json) and
//     below a trusted project's .mcp.json and a .claude.json local-scope entry,
//     later winning for the same server name. So an "mcp" entry here beats the
//     one Yaw Terminal manages in ~/.claude.json, and a project still wins --
//     the same local > project > user order Claude Code applies;
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
//     row's entry is still in place.
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
  const segments = [".config", "typed", "mcp.json"];
  const display =
    base.os === "windows" ? ["%USERPROFILE%", ...segments].join(WINDOWS_SEP) : ["~", ...segments].join("/");
  return {
    absolute: join(base.home, ...segments),
    display,
    containerPath: [CONTAINER_KEY],
  };
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
  hooks: { permissionsPatch: "claude-code" },
  notes:
    "typed reads ~/.config/typed/mcp.json at startup, ahead of Claude Code's user-scope files, so this entry wins over an \"mcp\" entry Yaw Terminal manages in ~/.claude.json; a project's .mcp.json still wins over it. The file is strict JSON: no comments, no trailing commas. The mcp__mcp__* grant goes in Claude Code's user settings.json, which typed reads too. There is no project scope here: <project>/.mcp.json is Claude Code's project file, which typed also reads -- use `yaw-mcp install mcp` for it. Needs a typed CLI newer than 1.5.0; older typed reads only Claude Code's files, so use `yaw-mcp install claude-code` there. Restart typed after editing.",
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
