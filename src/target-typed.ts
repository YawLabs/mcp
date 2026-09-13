// The typed row, as DATA.
//
// Imports the LEAF model only -- see the header of target-zed.ts for why.
//
// typed (https://typed.cloud) is a coding CLI that reads Claude Code's MCP
// files AND one file of its own, `<home>/.config/typed/mcp.json`. This row
// writes that file and none of Claude Code's, because each of Claude Code's
// would lose the entry somewhere typed is commonly run:
//   * `CLAUDE_CONFIG_DIR` in a Yaw Mode pane is a disposable per-session
//     overlay: a fresh pane keeps none of it, so an entry written under it is
//     gone when the pane closes, and an augment pane carries only its
//     `.claude.json` home -- where the next bullet applies;
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
//   * reload "next-session": typed reads its MCP config once, when a session
//     starts, and never re-reads it, so install's Done line says the entry
//     reaches typed's next session and uninstall's says the server goes in
//     its next session (typed's own `typed mcp add` prints "takes effect next
//     session");
//   * `uninstallNote`: typed's CLI PRELOADS Yaw MCP by itself when no config it
//     reads references Yaw MCP (a textual match, or a server named "mcp" or
//     "yaw") and it finds a `yaw-mcp` bin on PATH or a `~/.yaw-mcp` directory,
//     unless TYPED_CLI_NO_YAW_MCP=1 (typed apps/cli/src/mcp/config.ts,
//     resolveYawMcpPreload). So removing this entry can leave typed starting
//     Yaw MCP anyway, and the note says so and names the opt-out;
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
//     does not, so under a set one it is scoped to that config dir, and
//     install says so. A Yaw Mode pane is the exception, handled for every
//     row with the hook alike (prepareGrantPatches in install-cmd.ts): an
//     augment pane also writes the grant to ~/.claude/settings.json, and a
//     fresh one says the grant goes with the pane.
//
// NO PROJECT SCOPE, deliberately. typed reads `<project>/.mcp.json`, but that
// file is already claude-code's project scope and the `mcp` alias. A second
// row on the same file would double-report it in --list, doctor and try, so
// the notes point at `yaw-mcp install mcp` instead.
//
// VERSION FLOOR: THIS ROW NEEDS A TYPED CLI NEWER THAN 1.5.0. Released typed
// 1.5.0 -- the newest release as of 2026-09-13 -- does not read this file, so
// with it an entry here loads nothing. The notes, README and CHANGELOG say
// "newer than 1.5.0" rather than naming the next version, which has not
// shipped.
//
// AND A PROBE FOR IT, because a typed CLI too old for this file ignores it
// without a word. `programProbe` reads the typed CLI bundle typed's launcher
// runs -- `$TYPED_CLI_BUNDLE`, else `~/.config/typed/typed-cli/cli.mjs`
// (typed tools/typed, "Bundle path contract") -- and looks for the quoted
// path segment `"mcp.json"` in its bytes. typed's loader spells this file
// `path.join(homedirFn(), '.config', 'typed', 'mcp.json')`
// (apps/cli/src/mcp/config.ts, typedUserMcpConfigFile), which esbuild emits
// with double quotes: measured 2026-09-13, a bundle built from the typed
// branch that adds the file carries `"mcp.json"` exactly once, while the
// released 1.5.0 bundle and every older one on this machine carry it zero
// times. The quotes are the point -- an unquoted `mcp.json` is a substring of
// `.mcp.json`, which every typed CLI names. The single-quoted spelling is
// accepted too, for a bundle built without esbuild's re-quoting. The probe is
// of the capability, never of a version string: the typed branch that adds
// the file still says 1.5.0 in apps/cli/package.json -- the version of the
// release that does not read it.
//
// The warning names `typed update`, the launcher's own command that re-runs
// typed's installer and replaces the default bundle (tools/typed, `update)`).
// That installs the newest RELEASED bundle, so it clears the warning only once
// a typed release newer than 1.5.0 is live: measured 2026-09-13, the bundle it
// downloads (app.typed.cloud/typed-cli/cli.mjs) is 1.5.0 and carries no
// "mcp.json". Naming it is correct only because this row does not ship before
// that release -- the floor above -- and a release of yaw-mcp carrying this row
// ahead of it would make the advice a loop. With TYPED_CLI_BUNDLE set that
// command does not touch the bundle actually run, so that case says so
// instead.

import { isAbsolute, join, resolve } from "node:path";
import { defineTarget, type PathBase, type ResolvedPath } from "./install-target-model.js";

/** The container key, shared with Claude Code's files -- typed reads the same
 *  `{"mcpServers": {...}}` shape from each. */
const CONTAINER_KEY = "mcpServers";

/** A single backslash, from its code point -- the separator the other rows
 *  spell a Windows display path with. An escape typed into this file is one
 *  shell layer away from collapsing into something else. */
const WINDOWS_SEP = String.fromCharCode(92);

/** The bundle segments under the home, as typed's installer lays them out. */
const DEFAULT_BUNDLE_SEGMENTS = [".config", "typed", "typed-cli", "cli.mjs"];

/** The typed CLI bundle typed's launcher runs: `TYPED_CLI_BUNDLE` when set
 *  (empty already counts as unset, the launcher's `${TYPED_CLI_BUNDLE:-...}`
 *  rule), resolved against the current directory when relative, else the
 *  installed default under the home. */
function typedCliBundle(base: PathBase): string {
  const override = base.env.typedCliBundle;
  if (override !== undefined) return isAbsolute(override) ? override : resolve(override);
  return join(base.home, ...DEFAULT_BUNDLE_SEGMENTS);
}

function staleTypedCliWarning(bundle: string, base: PathBase): string {
  return base.env.typedCliBundle !== undefined
    ? `the typed CLI bundle at ${bundle} (TYPED_CLI_BUNDLE) predates ~/.config/typed/mcp.json, so that typed will not load this entry until the bundle is rebuilt or replaced -- \`typed update\` updates only the default ~/.config/typed/typed-cli/cli.mjs.`
    : `the typed CLI at ${bundle} predates ~/.config/typed/mcp.json, so it will not load this entry until it updates -- run \`typed update\`.`;
}

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
  // typed reads its MCP config once per session and does not watch the file.
  reload: "next-session",
  uninstallNote:
    "typed's CLI preloads Yaw MCP on its own when no config it reads references it and it finds a yaw-mcp on PATH or a ~/.yaw-mcp directory -- set TYPED_CLI_NO_YAW_MCP=1 to keep it out.",
  entry: {
    windowsLaunch: { broker: "bare", upstream: "cmd-wrap" },
  },
  // The grant is Claude Code's scheme, and typed reads it from the same file.
  hooks: { permissionsPatch: "claude-code", alsoReads: typedAlsoReads },
  // See AND A PROBE FOR IT in the header.
  programProbe: {
    programFile: typedCliBundle,
    markers: ['"mcp.json"', "'mcp.json'"],
    warning: staleTypedCliWarning,
  },
  notes:
    "typed reads ~/.config/typed/mcp.json when a session starts, ahead of the user-scope files it shares with Claude Code, so this entry wins over an \"mcp\" entry Yaw Terminal manages in ~/.claude.json; a project's .mcp.json still wins over it. On a Yaw Terminal machine that means an npx entry here replaces Yaw Terminal's local launch for typed, and npx resolves @latest on every typed start, which can outlast typed's MCP connect timeout -- `npm i -g @yawlabs/mcp` with oam installed, then re-run install, writes a fast absolute-path entry instead, or raise MCP_TIMEOUT. The file is strict JSON: no comments, no trailing commas. The mcp__mcp__* grant goes in Claude Code's user settings.json, which typed reads too; under a set CLAUDE_CONFIG_DIR that is <CLAUDE_CONFIG_DIR>/settings.json, so the grant is scoped to that config dir while this file is not. There is no project scope here: <project>/.mcp.json is Claude Code's project file, which typed also reads -- use `yaw-mcp install mcp` for it. Needs a typed CLI newer than 1.5.0; older typed reads only Claude Code's files, so use `yaw-mcp install claude-code` there. typed picks the change up in its next session.",
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
