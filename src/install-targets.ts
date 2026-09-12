// The TABLE of client-install targets: the authoritative mapping of
// {client, scope, OS} to a config file path plus the shape of that file
// (`config`: its syntax and its container key). (A pre-rename dashboard
// install mirror has been archived; this file is now the sole source of
// truth.) The tests in install-targets.test.ts lock the specifics (file names,
// container root keys) that would silently break the install flow if
// regressed.
//
// A target is DATA. Every TYPE a row is made of -- and `resolveAppDataDir`,
// `ENTRY_NAME`, `LEGACY_ENTRY_NAMES` -- lives in the leaf module
// install-target-model.ts and is re-exported from here, so a row module can
// import the model without importing this file (which would be a cycle: this
// file's own evaluation builds the row array out of those modules). The six
// oldest ids keep their inline `pathFor` branches below; every newer row
// resolves its own path in its own `target-*.ts`.
//
// Bugs we've discovered in the wild and encode as invariants here:
//   • Claude Code reads MCP servers from `~/.claude.json` (top-level
//     `mcpServers` for user scope; nested under `projects[<absDir>].
//     mcpServers` for local scope). The `mcpServers` key in
//     `~/.claude/settings.json` is silently ignored — settings.json holds
//     hooks/model/permissions only. (We discovered this the hard way in
//     v0.11.0–0.11.1: install wrote to settings.json, /mcp showed nothing.)
//   • Claude Code honors the `CLAUDE_CONFIG_DIR` env var: when set, BOTH
//     `.claude.json` AND `settings.json` move to that dir (`<DIR>/.claude.json`,
//     `<DIR>/settings.json`), not `<HOME>/.claude.json` and
//     `<HOME>/.claude/settings.json`. Wrappers like Yaw Mode use this to
//     overlay a per-session config. If install ignores it, the entry lands
//     in `~/.claude.json` while Claude Code reads from the wrapper dir —
//     and `claude mcp list` shows nothing. We accept `claudeConfigDir`
//     here so install/doctor/list-probe all see the same file Claude does.
//   • VS Code uses `servers` (not `mcpServers`) as the top-level key in
//     `.vscode/mcp.json`. Pasting a Claude Code shape fails silently.
//   • Claude Desktop for Linux exists -- a beta for Ubuntu and Debian -- but
//     Anthropic documents where claude_desktop_config.json lives on macOS
//     and Windows only. So linux stays out of claude-desktop's
//     `availableOn`, and every verb refuses there with the
//     `notConfigurableOn.linux` reason rather than write a guessed path the
//     app may never read. Checked 2026-09-11, and none of these names a
//     Linux path for that file: the install article
//     (support.claude.com/en/articles/10065433-install-claude-desktop), the
//     Linux page (code.claude.com/docs/en/desktop-linux), the Desktop
//     reference (code.claude.com/docs/en/desktop -- Anthropic's own
//     `claude mcp add-from-claude-desktop` is documented there "On macOS and
//     WSL" only) and the MCP guide
//     (modelcontextprotocol.io/docs/develop/connect-local-servers -- its
//     "available for macOS and Windows" predates the Linux beta, so it is no
//     source for where the app ships). Closest is the 3P configuration page
//     (claude.com/docs/third-party/claude-desktop/configuration): it gives
//     the Linux logs dir (~/.config/Claude/logs/) and an admin-deployed
//     /etc/claude-desktop/managed-settings.json that can carry
//     `managedMcpServers` -- a managed-deployment file, not the per-user
//     config install writes, so it is no target either. Once a page names
//     claude_desktop_config.json's Linux path, add "linux" to `availableOn`
//     and the path to pathFor, and drop the reason.
//   • On Windows, `npx` is a `.cmd` shim; MCP clients that spawn it
//     directly get ENOENT. The launch entry must be
//     `{ command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"] }`.
//     (`@latest` is what buildLaunchEntry actually writes -- see the `pkg`
//     default there; the unpinned spelling here read as a second, wrong shape.)
//     Continue is the one exception, and it is the CLIENT's rule, not ours:
//     it adds the cmd.exe wrapper itself, and a pre-wrapped entry breaks it
//     under a WSL remote. That is `entry.windowsLaunch.broker: "bare"` on
//     its row, never a client-id branch in a consumer.
//   • Zed's container key is `context_servers`, not `mcpServers`, and on Linux
//     its directory follows $XDG_CONFIG_HOME -- but only when that value is
//     ABSOLUTE, the rule Zed inherits from the dirs crate.
//   • Cline keeps ONE settings file per runtime, so one (client, scope) pair
//     maps to SEVERAL files: a shared `~/.cline/...` copy plus one per editor
//     its extension has run in. Its row is the only one with a `sites` hook.
//     That file is strict JSON -- Cline parses it with JSON.parse -- so a
//     comment in it stops every server in it from loading, which is why its
//     `config.format` is "json" and not "jsonc".
//   • Continue's file is one yaw-mcp CREATES and owns
//     (`mcpServers/yaw-mcp.json`), not a user config we splice into. That is
//     `config.ownership: "dedicated"`, and it changes the uninstall wording
//     rather than any path.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ConfigSite, effectiveConfigFormat } from "./client-config.js";
import {
  type ClientEnvValues,
  defineTarget,
  type InlineTarget,
  type InstallOS,
  type InstallScope,
  type InstallScopeSpec,
  type LaunchEntry,
  LEGACY_ENTRY_NAMES,
  type ModularTarget,
  type PathBase,
  type ResolvedPath,
} from "./install-target-model.js";
import { CLINE_TARGET } from "./target-cline.js";
import { CONTINUE_TARGET } from "./target-continue.js";
import { ZED_TARGET } from "./target-zed.js";

// Every type and constant a target row is made of lives in the LEAF module
// install-target-model.ts, and is re-exported here so that every pre-existing
// `from "./install-targets.js"` import path keeps resolving to the same name.
export * from "./install-target-model.js";

const TARGET_ROWS = [
  defineTarget({
    clientId: "claude-code",
    label: "Claude Code",
    config: { format: "jsonc", root: "mcpServers" },
    availableOn: ["macos", "linux", "windows"],
    hooks: { permissionsPatch: "claude-code" },
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every project.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Project",
        description: "Commit to share with your team.",
        requiresProjectDir: true,
      },
      {
        scope: "local",
        label: "Local",
        description: "Per-project override; typically gitignored.",
        requiresProjectDir: true,
      },
    ],
  }),
  defineTarget({
    clientId: "claude-desktop",
    label: "Claude Desktop",
    config: { format: "jsonc", root: "mcpServers" },
    availableOn: ["macos", "windows"],
    // Not "no Linux build" -- there is one, a beta. What is missing is a
    // documented Linux path for claude_desktop_config.json; the header note
    // lists the sources checked.
    notConfigurableOn: {
      linux:
        "Claude Desktop for Linux is in beta, and Anthropic has not documented where it reads claude_desktop_config.json",
    },
    // ASCII `--`, not an em-dash: install prints this verbatim (`Note: ...`),
    // and Claude Desktop is a Windows client -- on a console whose codepage is
    // not UTF-8 the em-dash rendered as mojibake in the line the user reads.
    notes: "Claude Desktop reads one file per OS -- no project scope. Restart the app after editing.",
    scopes: [
      {
        scope: "user",
        label: "User",
        description: "The only config file Claude Desktop reads.",
        requiresProjectDir: false,
      },
    ],
  }),
  defineTarget({
    clientId: "cursor",
    label: "Cursor",
    config: { format: "jsonc", root: "mcpServers" },
    availableOn: ["macos", "linux", "windows"],
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every Cursor project.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Project",
        description: "Commit to share with your team.",
        requiresProjectDir: true,
      },
    ],
  }),
  defineTarget({
    clientId: "vscode",
    label: "VS Code",
    config: { format: "jsonc", root: "servers" },
    availableOn: ["macos", "linux", "windows"],
    hooks: { importVariables: "vscode-inputs" },
    notes:
      "VS Code uses `servers` (not `mcpServers`) as the top-level key in mcp.json -- the user-profile file and .vscode/mcp.json share that shape. The user file covers the DEFAULT profile only; a custom profile keeps its own copy under Code/User/profiles/<id>/mcp.json. Needs VS Code 1.102 or newer, before which user-level MCP lived under the `mcp` key in settings.json.",
    scopes: [
      // User FIRST: enumerateProbeSlots walks this array in order, so it
      // decides --list and doctor row order, and every other multi-scope
      // client lists user before project.
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every VS Code workspace.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Workspace",
        description: "Per-project config; commit to share.",
        requiresProjectDir: true,
      },
    ],
  }),
  // APPENDED, never inserted: autoDetectClient returns the first usable probe
  // slot in array order and documents Claude-Code-first as an invariant, so an
  // insert would silently change which client `try` picks for existing users.
  defineTarget({
    clientId: "windsurf",
    label: "Windsurf",
    config: { format: "jsonc", root: "mcpServers" },
    availableOn: ["macos", "linux", "windows"],
    notes:
      "Windsurf reads ~/.codeium/windsurf/mcp_config.json and does not create it on first launch. If the server does not appear, open Cascade -> MCP servers -> Manage plugins -> View raw config and check it is the file above.",
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "The only config file Windsurf reads; it has no workspace scope.",
        requiresProjectDir: false,
      },
    ],
  }),
  defineTarget({
    clientId: "gemini-cli",
    label: "Gemini CLI",
    config: { format: "jsonc", root: "mcpServers" },
    availableOn: ["macos", "linux", "windows"],
    notes:
      "Gemini CLI merges ~/.gemini/settings.json with <project>/.gemini/settings.json, project winning. `mcpServers` is a top-level key, distinct from the sibling `mcp` object that holds discovery knobs.",
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every project.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Project",
        description: "Commit to share with your team; wins over the user file.",
        requiresProjectDir: true,
      },
    ],
  }),
  // APPENDED, never inserted, for the reason spelled out above the windsurf
  // row: `try`'s auto-detect returns the FIRST usable probe slot in this
  // array's order, so inserting a row ahead of an existing one silently
  // changes which client an existing user's `try` picks. New targets go on the
  // end, in the order they land.
  ZED_TARGET,
  CLINE_TARGET,
  CONTINUE_TARGET,
] as const satisfies readonly (InlineTarget | ModularTarget)[];

/** Derived from the rows, never hand-kept beside them: `defineTarget`'s
 *  `const` type parameter preserves each row's `clientId` literal, so adding a
 *  row widens this union by exactly that id. */
export type InstallClientId = (typeof TARGET_ROWS)[number]["clientId"];

/** What every consumer types a row as -- `find`/`filter`/`map` results over
 *  `INSTALL_TARGETS` are assignable to it. */
export type InstallTarget = (InlineTarget | ModularTarget) & { clientId: InstallClientId };

/** Exported WIDENED, not as the `as const` tuple: with the tuple type
 *  `t.availableOn.includes(os)` (install's `--all` filter) does not
 *  type-check, because each row's `availableOn` is its own readonly literal
 *  tuple and `includes` then demands that tuple's member type.
 *
 *  READONLY, so nothing can reorder or extend the table at runtime -- the
 *  append-only order above is an invariant `try`'s auto-detect depends on. A
 *  caller that needs to run a plan over a NARROWER table (the `--all` tests
 *  do) passes it in through `runInstallAll`'s `targets` seam instead of
 *  mutating this array. */
export const INSTALL_TARGETS: readonly InstallTarget[] = TARGET_ROWS;

export interface ResolvePathOptions {
  clientId: InstallClientId;
  scope: InstallScope;
  os: InstallOS;
  projectDir?: string;
  /** Override for tests; defaults to os.homedir(). */
  home?: string;
  /** Windows `%APPDATA%`. Defaults to `<home>/AppData/Roaming` -- the resolver
   *  never reads `process.env.APPDATA` itself, so a caller on a box where
   *  %APPDATA% is redirected must pass it (see `resolveAppDataDir` below, the
   *  one helper that reads the env, shared by install's write path, `--list`,
   *  `doctor` and `try` so none of them can disagree).
   *
   *  An EMPTY string counts as unset and takes the same `<home>/AppData/Roaming`
   *  default: an empty-but-set %APPDATA% is ordinary on Windows and in CI, and
   *  passing it through made every claude-desktop path RELATIVE
   *  (`Claude\claude_desktop_config.json`), which doctor then stat-ed and printed
   *  against the process cwd. */
  appData?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set (truthy), claude-code
   *  user/local scope writes to `<dir>/.claude.json` instead of
   *  `<home>/.claude.json`, matching Claude Code's actual read path.
   *  The resolver never reads this one from the environment on its own:
   *  callers (install-cmd, doctor-cmd, index.ts) read
   *  `process.env.CLAUDE_CONFIG_DIR` and pass it in. Same for `appData` above
   *  -- this function reads NO environment at all. */
  claudeConfigDir?: string;
  /** Every client env var, as `readClientEnv` reported it. Only a MODULAR row
   *  reads it (through `PathBase.env`); the six inline rows take their one
   *  variable from `claudeConfigDir` above. Verbatim values, so each row
   *  applies its own resolution policy -- they differ per client, and one
   *  policy applied here would be wrong for somebody. */
  clientEnv?: ClientEnvValues;
}

export function resolveInstallPath(opts: ResolvePathOptions): ResolvedPath {
  const { target, base } = resolveTargetBase(opts);
  // A MODULAR row resolves its own path; the six inline ids keep their
  // `pathFor` branches, whose bytes (and their `display` spellings) are pinned
  // per client. Testing `resolvePath` first is also what narrows `target` to
  // InlineTarget below, so the switch can end in an exhaustiveness check.
  if (target.resolvePath) return target.resolvePath(base);
  return pathFor(target.clientId, base.scope, base.os, {
    home: base.home,
    appData: base.appData,
    projectDir: base.projectDir,
    claudeConfigDir: base.env.claudeConfigDir,
  });
}

/** Every FILE one (client, scope) reads and writes, as `ConfigSite`s the
 *  client-config core can classify and edit.
 *
 *  One site for every row but Cline, whose `sites` hook fans one pair out to a
 *  shared file plus one copy per editor its extension has run in. The
 *  effective FORMAT is applied here, once, from the target's `config` narrowed
 *  by the scope's `strictJson` -- so a consumer cannot read a site with one
 *  strictness and write it with another.
 *
 *  Validates exactly as `resolveInstallPath` does, and throws the same
 *  messages, because it shares that function's first half. `selectSites` in
 *  client-config.ts is what drops a conditional site whose editor is not
 *  installed; this returns every DECLARED site so a caller can report the
 *  difference. */
export function resolveInstallSites(opts: ResolvePathOptions): ConfigSite[] {
  const { target, scopeSpec, base } = resolveTargetBase(opts);
  const format = effectiveConfigFormat(target.config, scopeSpec);
  if (target.sites) return target.sites(base).map((site) => ({ ...site, format }));
  return [
    {
      // "default" rather than the client id: the id names the SITE within a
      // target, and every single-site row has exactly one.
      id: "default",
      label: target.label,
      resolved: resolveInstallPath(opts),
      format,
      detectDir: null,
    },
  ];
}

/** The target, its scope spec and the `PathBase` one resolve runs against --
 *  the shared first half of `resolveInstallPath` and `resolveInstallSites`.
 *
 *  Shared rather than copied because every refusal in it is a CONTRACT: the
 *  unknown-client, unsupported-scope, unavailable-OS and missing-project-dir
 *  throws are what `resolveInstallSite` in install-cmd.ts pre-empts with its
 *  own worded errors, and two copies of this validation would be two places
 *  for that agreement to drift. */
function resolveTargetBase(opts: ResolvePathOptions): {
  target: InstallTarget;
  scopeSpec: InstallScopeSpec;
  base: PathBase;
} {
  const home = opts.home ?? homedir();
  // PURE: this resolver reads NO environment, and `appData` defaults off `home`
  // alone. It used to consult process.env.APPDATA whenever the caller passed no
  // `home`, which split READ from WRITE: every reader resolves a home first
  // (probeClientsAsync requires `home: string`; doctor, `install --list` and
  // `try` all pass homedir()) and so got `<home>/AppData/Roaming`, while the
  // writer (runInstall) passes `home: undefined` and got the ambient %APPDATA%.
  // On a box where %APPDATA% is redirected away from `<home>\AppData\Roaming`,
  // install wrote the claude_desktop_config.json Claude Desktop actually reads
  // while doctor and --list reported a different path. Choosing %APPDATA% is a
  // CALLER's job -- see `resolveAppDataDir` below, the single helper that reads
  // the env, used by install's write path, `--list`, `doctor` and `try` alike
  // so they cannot disagree. Keeping the env out of here is also what keeps a hermetic run
  // hermetic: claude-desktop is the one client living under %APPDATA%, so a
  // test that overrode `home` but not `appData` would otherwise resolve to (and
  // install would have written) the DEVELOPER's own config file.
  //
  // Empty counts as unset here too (see the `appData` doc above): a caller who
  // threaded through an empty-but-set %APPDATA% otherwise got a RELATIVE
  // claude-desktop path. Still no env read on this branch -- the fallback is the
  // resolved `home`, which is what keeps a hermetic run hermetic.
  const appData = opts.appData && opts.appData.length > 0 ? opts.appData : join(home, "AppData", "Roaming");
  const { clientId, scope, os, projectDir, claudeConfigDir } = opts;
  const target = INSTALL_TARGETS.find((t) => t.clientId === clientId);
  if (!target) throw new Error(`Unknown client: ${clientId}`);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) throw new Error(`Client ${clientId} does not support scope ${scope}`);
  if (!target.availableOn.includes(os)) {
    const why = target.notConfigurableOn?.[os];
    throw new Error(
      why ? `${target.label} cannot be configured on ${os}: ${why}` : `${target.label} is not available on ${os}`,
    );
  }
  if (scopeSpec.requiresProjectDir && !projectDir) {
    throw new Error(`Scope ${scope} for ${clientId} requires a project directory`);
  }

  // Claude Code keys local-scope MCP entries by the ABSOLUTE project dir
  // (projects[<absDir>].mcpServers in ~/.claude.json). A relative
  // projectDir would produce a key that disagrees with what Claude Code
  // writes, so install/doctor/list could each compute a different key
  // and miss the entry. Resolve to absolute here -- the single place all
  // three callers funnel through -- so the key is stable regardless of
  // whether the caller pre-resolved. Already-absolute paths (the common
  // case: callers pass process.cwd() or path.resolve(...)) pass through
  // unchanged, including POSIX-rooted test fixtures on a Windows runner
  // (isAbsolute('/x') is true on win32).
  const absoluteProjectDir = projectDir && !isAbsolute(projectDir) ? resolve(projectDir) : projectDir;

  const cfgDir = claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : undefined;
  // `claudeConfigDir` is a named option of its own AND a member of `env`
  // because both spellings are load-bearing: the option is how install,
  // uninstall and import have always threaded Claude Code's redirect through
  // (index.ts reads it once per verb), while `env` is what a MODULAR row reads
  // for its own variable. The explicit option wins, so a caller that passes
  // only one of the two still gets the same answer either way.
  const env: ClientEnvValues = { ...opts.clientEnv, ...(cfgDir ? { claudeConfigDir: cfgDir } : {}) };
  const base: PathBase = {
    home,
    appData,
    projectDir: absoluteProjectDir ?? "",
    os,
    scope,
    env,
  };
  return { target, scopeSpec, base };
}

/** The `projects[...]` key Claude Code uses for `projectDir` in ~/.claude.json.
 *
 *  Claude Code writes those keys with FORWARD slashes on every OS — a Windows
 *  checkout appears as "C:/Users/me/repo", never "C:\\Users\\me\\repo" (every
 *  project key in a real Windows ~/.claude.json uses `/`). The lookup is an
 *  exact, case-sensitive match on that string, so any other spelling is a NEW
 *  sibling key Claude Code never reads: install prints Done, doctor and
 *  --list confirm "installed" (they compute the same wrong key), and /mcp
 *  shows nothing. Two spellings reach us that way, and both are fixed in the
 *  KEY only — the config-file path itself stays platform-native:
 *
 *  - Backslashes. `resolve(cwd)` on win32 hands us "C:\\...", so every `\`
 *    becomes `/`.
 *  - A lower-case drive letter. Claude Code looks the entry up under the
 *    directory it runs in, spelled the way the shell reported it, and Git
 *    Bash and PowerShell both report an UPPER-case drive letter even after
 *    `cd c:/repo` -- so Claude Code started there reads "C:/repo". `resolve()`
 *    keeps the drive letter's case as given, so `--project-dir c:/repo` (or a
 *    drive-relative "c:repo") used to write "c:/repo", a key those sessions
 *    never read. The leading drive letter is upper-cased; nothing else is --
 *    Git Bash and PowerShell keep the rest of the path as typed (`cd c:/users`
 *    in Git Bash and `cd c:\\users` in PowerShell both report "C:\\users"),
 *    so folding more would break a match.
 *
 *  Residual caveat: cmd.exe keeps the drive letter as typed -- after
 *  `cd c:\\users`, with or without /d, it reports "c:\\Users" (the rest
 *  corrected to on-disk case) -- and a Git Bash started from that prompt
 *  inherits the lower-case drive and keeps it until it runs a `cd` of its
 *  own. A Claude Code started from either looks under "c:/..." and does not
 *  see the "C:/..." entry written here, while doctor run there still reports
 *  it OK. That includes a bare `install --scope local` run from such a shell,
 *  which used to write the matching lower-case key and now writes the
 *  upper-case one: the trade favours PowerShell, which reports "C:" even for
 *  a cwd it inherited as "c:\\...", and any Git Bash that has run a `cd`.
 *  Starting Claude Code from PowerShell, after `cd .` in that Git Bash, or
 *  after `cd /d C:\\...` in cmd reads the entry. (Measured against Claude
 *  Code 2.1.268 with both keys present: each session read only the key
 *  matching its own drive-letter case -- cmd and a Git Bash started from it
 *  read "c:/...", while that Git Bash after `cd .`, a PowerShell started from
 *  it, and cmd after `cd /d C:\\...` read "C:/...".)
 *
 *  The lower-case sibling an OLDER version wrote is no longer invisible to
 *  this tool. Every reader resolves its `projects[...]` lookups through
 *  claudeCodeContainerPaths below, which treats two keys differing only in
 *  drive-letter case as ONE project: `uninstall` removes the entry from both
 *  spellings, and `doctor` / `install --list` name the key an entry was
 *  actually found under. Install still writes only the canonical key -- see
 *  claudeCodeContainerPaths for why it reports the sibling instead of
 *  migrating it.
 *
 *  Scoped to Windows-shaped paths (drive letter or UNC) so a POSIX directory
 *  whose name legitimately contains a backslash is not mangled. A UNC path has
 *  no drive letter, so only its separators change.
 *
 *  Exported for tests: the Windows-shape branch is unreachable through
 *  resolveInstallPath on a POSIX runner (isAbsolute("C:\\...") is false
 *  there, so resolve() rewrites the fixture first). */
export function claudeCodeProjectKey(projectDir: string): string {
  if (WINDOWS_DRIVE_PATH.test(projectDir)) {
    return projectDir[0].toUpperCase() + projectDir.slice(1).replace(/\\/g, "/");
  }
  return projectDir.startsWith("\\\\") ? projectDir.replace(/\\/g, "/") : projectDir;
}

/** A path (or a `projects[...]` key, which is the same string) that starts
 *  with a drive letter. Shared by claudeCodeProjectKey and the key folding
 *  below so the two cannot disagree about what "Windows-shaped" means. A
 *  drive-RELATIVE spelling ("c:repo") is deliberately excluded: it is not a
 *  directory on its own, and resolveInstallPath has already resolved it. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** The `projects` object's own key inside ~/.claude.json, and the first
 *  segment of every local-scope containerPath. */
const PROJECTS_KEY = "projects";

/** True when two `projects[...]` keys name the SAME project directory as far
 *  as this tool is concerned: byte-identical, or Windows-shaped and differing
 *  ONLY in the case of the leading drive letter.
 *
 *  Claude Code's own lookup is byte-exact, so "c:/repo" and "C:/repo" really
 *  are two entries to IT, and which one a session reads depends on how its
 *  shell spelled the cwd (see claudeCodeProjectKey). They are one PROJECT to
 *  the user, though, and a command that sees only one of them reports a state
 *  the other contradicts -- an `uninstall` that leaves the sibling in place
 *  says the client no longer launches yaw-mcp while it still does.
 *
 *  ONLY the drive letter folds. Everything after it is compared byte for byte,
 *  because Claude Code keys the rest of the path case-sensitively and folding
 *  more would merge two directories its lookup keeps apart. A separator
 *  difference is not a drive-letter difference either: "C:\\repo" and "C:/repo"
 *  are NOT the same key here. POSIX and UNC keys have no drive letter, so they
 *  only ever match themselves. */
export function sameClaudeCodeProjectKey(a: string, b: string): boolean {
  if (a === b) return true;
  if (!WINDOWS_DRIVE_PATH.test(a) || !WINDOWS_DRIVE_PATH.test(b)) return false;
  return a[0].toLowerCase() === b[0].toLowerCase() && a.slice(1) === b.slice(1);
}

/** Every containerPath under which an entry for `containerPath`'s project can
 *  ALREADY live in `root` -- the canonical path FIRST, then one more for each
 *  drive-letter-case variant key `root` actually carries.
 *
 *  This is the ONE place a `projects[...]` lookup is resolved. Install writes
 *  the canonical key and nothing else, but a config written by an older
 *  version (or by an install run from a cmd prompt with a lower-case drive)
 *  carries the other spelling, and a reader that looks only at the canonical
 *  key cannot see it: `uninstall` reported "Nothing to do" and printed Done
 *  over an entry that still launched yaw-mcp, and `doctor` / `install --list`
 *  reported "not installed" for a project that was. Every reader takes its
 *  paths from here, and the source-shape scan in
 *  src/tests/source-hygiene.test.ts accounts for each container read in
 *  non-test source by shape, so the four ways a new reader would
 *  reintroduce that split -- indexing the projects object directly, building a
 *  container path with "projects" as its first segment, a C-style index loop
 *  over a container path, or a helper call the formatter wrapped across lines
 *  -- each fail the suite. That scan is textual, so it is a net
 *  under the behavioural tests and not a proof: it cannot follow a container
 *  object handed in by a caller, nor a third local helper a new file declares
 *  for itself. Its own limits are spelled out where it lives.
 *
 *  Callers that deliberately want only the canonical path (a WRITE, or "will
 *  my write at this exact path replace something") take `[0]`, which is always
 *  present even when `root` carries no such key -- the canonical path is where
 *  writes go whether or not anything is there yet.
 *
 *  Install is one of those callers on purpose: it writes the canonical key and
 *  REPORTS a sibling rather than migrating it. Migrating means deleting the
 *  sibling, and the session that reads the sibling is precisely the one that
 *  cannot read the canonical key -- so a migration would silently unwire a
 *  live cmd-started Claude Code and hand it nothing back, which is the one
 *  outcome an ADDITIVE command must not produce. `uninstall` is the
 *  subtractive command and does clear every spelling, so the cleanup the user
 *  is pointed at exists and is one line.
 *
 *  Non-projects container paths (`["mcpServers"]`, `["servers"]`) and
 *  POSIX/UNC project keys get exactly one path back, so every other client and
 *  every non-Windows checkout is untouched. */
export function claudeCodeContainerPaths(root: unknown, containerPath: readonly string[]): string[][] {
  return claudeCodeContainerPathVariants(containerPath, (prefix) => {
    if (prefix.length !== 1 || prefix[0] !== PROJECTS_KEY) return [];
    if (typeof root !== "object" || root === null || Array.isArray(root)) return [];
    const projects = (root as Record<string, unknown>)[PROJECTS_KEY];
    if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return [];
    // Own keys only, in the file's own order, so the result is deterministic
    // and an inherited member cannot conjure a path that is not in the JSON.
    return Object.keys(projects as Record<string, unknown>);
  });
}

/** `claudeCodeContainerPaths` over a KEY LISTER instead of a parsed root.
 *
 *  The rule is the same and lives here, where the `projects[...]` question
 *  belongs; only the way the candidate keys are obtained differs. A consumer
 *  holding a parsed object calls `claudeCodeContainerPaths` above; a consumer
 *  holding the client config's BYTES passes `containerKeysAt` from
 *  client-config.ts, and so never parses a client config itself -- which is
 *  what lets the drive-case fold work for every syntax rather than only for
 *  the ones whose parse a consumer happens to have inlined.
 *
 *  `keysAt` is asked for the keys at ONE prefix (`["projects"]`) and may
 *  answer `[]` for anything else, including a file that does not parse: the
 *  canonical path is always returned, so "no keys" degrades to "write where
 *  writes go". */
export function claudeCodeContainerPathVariants(
  containerPath: readonly string[],
  keysAt: (prefix: readonly string[]) => readonly string[],
): string[][] {
  const canonical = [...containerPath];
  if (containerPath.length < 2 || containerPath[0] !== PROJECTS_KEY) return [canonical];
  const key = containerPath[1];
  if (!WINDOWS_DRIVE_PATH.test(key)) return [canonical];
  const out: string[][] = [canonical];
  for (const candidate of keysAt([PROJECTS_KEY])) {
    if (candidate !== key && sameClaudeCodeProjectKey(candidate, key)) {
      out.push([PROJECTS_KEY, candidate, ...containerPath.slice(2)]);
    }
  }
  return out;
}

function pathFor(
  client: InstallClientId,
  scope: InstallScope,
  os: InstallOS,
  base: { home: string; appData: string; projectDir: string; claudeConfigDir: string | undefined },
): ResolvedPath {
  const { home, appData, projectDir, claudeConfigDir } = base;
  const sep = os === "windows" ? "\\" : "/";
  const joinPath = (...parts: string[]): string => parts.join(sep);

  if (client === "claude-code") {
    if (scope === "user") {
      // Claude Code reads user-scope MCP from ~/.claude.json (top-level
      // mcpServers). The settings.json mcpServers field is silently ignored.
      // CLAUDE_CONFIG_DIR (if set) relocates this to <DIR>/.claude.json.
      if (claudeConfigDir) {
        const absolute = join(claudeConfigDir, ".claude.json");
        return { absolute, display: absolute, containerPath: ["mcpServers"] };
      }
      const display = os === "windows" ? "%USERPROFILE%\\.claude.json" : "~/.claude.json";
      return { absolute: join(home, ".claude.json"), display, containerPath: ["mcpServers"] };
    }
    if (scope === "project") {
      return {
        absolute: join(projectDir, ".mcp.json"),
        display: joinPath("<project folder>", ".mcp.json"),
        containerPath: ["mcpServers"],
      };
    }
    // local — Claude Code stores per-project local-scope MCP under
    // ~/.claude.json projects[<absolute project dir>].mcpServers. The
    // .claude/settings.local.json file is for permissions/hooks, not MCP.
    // Same CLAUDE_CONFIG_DIR redirect applies.
    const projectKey = claudeCodeProjectKey(projectDir);
    if (claudeConfigDir) {
      const absolute = join(claudeConfigDir, ".claude.json");
      return { absolute, display: absolute, containerPath: ["projects", projectKey, "mcpServers"] };
    }
    return {
      absolute: join(home, ".claude.json"),
      display: os === "windows" ? "%USERPROFILE%\\.claude.json" : "~/.claude.json",
      containerPath: ["projects", projectKey, "mcpServers"],
    };
  }

  if (client === "claude-desktop") {
    if (os === "macos") {
      return {
        absolute: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        display: "~/Library/Application Support/Claude/claude_desktop_config.json",
        containerPath: ["mcpServers"],
      };
    }
    if (os === "windows") {
      return {
        absolute: join(appData, "Claude", "claude_desktop_config.json"),
        display: "%APPDATA%\\Claude\\claude_desktop_config.json",
        containerPath: ["mcpServers"],
      };
    }
    // linux -- unreachable: availableOn leaves it out (see notConfigurableOn),
    // and resolveInstallPath refuses before it gets here. Belt and suspenders.
    throw new Error("Claude Desktop's claude_desktop_config.json location on Linux is undocumented");
  }

  if (client === "cursor") {
    if (scope === "user") {
      const display = os === "windows" ? "%USERPROFILE%\\.cursor\\mcp.json" : "~/.cursor/mcp.json";
      return { absolute: join(home, ".cursor", "mcp.json"), display, containerPath: ["mcpServers"] };
    }
    // project
    return {
      absolute: join(projectDir, ".cursor", "mcp.json"),
      display: joinPath("<project folder>", ".cursor", "mcp.json"),
      containerPath: ["mcpServers"],
    };
  }

  if (client === "vscode") {
    if (scope === "user") {
      // The user-profile mcp.json that `MCP: Open User Configuration`
      // opens. Same `servers` root key as the workspace file. Windows uses
      // %APPDATA%, resolved by the CALLER (resolveAppDataDir) for exactly the
      // reason this function stays pure -- see the header note.
      if (os === "windows") {
        return {
          absolute: join(appData, "Code", "User", "mcp.json"),
          display: "%APPDATA%\\Code\\User\\mcp.json",
          containerPath: ["servers"],
        };
      }
      if (os === "macos") {
        return {
          absolute: join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
          display: "~/Library/Application Support/Code/User/mcp.json",
          containerPath: ["servers"],
        };
      }
      // Linux. Hardcoded ~/.config rather than honouring $XDG_CONFIG_HOME:
      // that would need the same caller-resolved threading %APPDATA% gets,
      // and this function reads no environment. On a box that sets it, this
      // path is wrong -- copy resolveAppDataDir's shape if that ever bites.
      return {
        absolute: join(home, ".config", "Code", "User", "mcp.json"),
        display: "~/.config/Code/User/mcp.json",
        containerPath: ["servers"],
      };
    }
    // project / workspace
    return {
      absolute: join(projectDir, ".vscode", "mcp.json"),
      display: joinPath("<project folder>", ".vscode", "mcp.json"),
      containerPath: ["servers"],
    };
  }

  if (client === "windsurf") {
    // One cross-platform path: the `~` expansion is %USERPROFILE% on Windows,
    // so a single join covers all three. Windsurf has no workspace config.
    const display =
      os === "windows" ? "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json" : "~/.codeium/windsurf/mcp_config.json";
    return {
      absolute: join(home, ".codeium", "windsurf", "mcp_config.json"),
      display,
      containerPath: ["mcpServers"],
    };
  }

  if (client === "gemini-cli") {
    if (scope === "user") {
      const display = os === "windows" ? "%USERPROFILE%\\.gemini\\settings.json" : "~/.gemini/settings.json";
      return { absolute: join(home, ".gemini", "settings.json"), display, containerPath: ["mcpServers"] };
    }
    // project
    return {
      absolute: join(projectDir, ".gemini", "settings.json"),
      display: joinPath("<project folder>", ".gemini", "settings.json"),
      containerPath: ["mcpServers"],
    };
  }

  throw new Error(`Unhandled client: ${client as string}`);
}

export interface BuildLaunchEntryOptions {
  os: InstallOS;
  /** Optional override for the `args` binary (defaults to
   *  @yawlabs/mcp@latest -- the `@latest` tag makes `npx` re-resolve
   *  the newest version on every spawn, so a client restart is all it
   *  takes to pick up a new release).
   *
   *  RESERVED SEAM WITH NO LIVE CALLER. Nothing in src/ passes `pkg`:
   *  install-cmd sends {os, oamBinPath, oamEntry}, try-cmd sends {os, upstream},
   *  and `parseInstallArgs` has no `--pkg` flag -- the `@latest` default is what
   *  every caller wants. So the precedence rule documented under `oamBinPath`
   *  (a `pkg` pin beats the oam path) is reached only from
   *  install-targets.test.ts, and combinations of `pkg` with the rest of the
   *  install flow -- notably install-cmd's `previousEnv` carry-over -- have no
   *  coverage at all. Anyone wiring a `--pkg` flag should write those tests
   *  first rather than assume the documented interactions are exercised. */
  pkg?: string;
  /** Optional upstream-shape override: when set, the entry is built for
   *  an arbitrary upstream MCP server (used by `yaw-mcp try` to wire a
   *  one-off trial entry pointing directly at the upstream's launcher,
   *  bypassing yaw-mcp). When `os === "windows"`, the upstream command +
   *  args are wrapped with `cmd /c` to dodge the same `.cmd` shim trap
   *  that bit the default yaw-mcp launcher — keep this path going through
   *  buildLaunchEntry so the wrapping logic stays in one place.
   *  Mutually exclusive with `pkg` (which tunes the default yaw-mcp
   *  entry; with `upstream` it is ignored). */
  upstream?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** Host the broker ITSELF on oam rather than node. Both must be set, and
   *  both are resolved by the caller: `oamBinPath` from the version-gated
   *  probe's `binPath`, `oamEntry` from resolveStableNpmEntry (durable installs
   *  only -- never the npx cache, which a config file must not point at).
   *  Either being null keeps the npx entry.
   *
   *  `binPath`, NOT the probe's `bin`. The two differ for the same reason
   *  resolveNpmEntry and resolveStableNpmEntry do: `bin` is what THIS process
   *  can spawn (`OAM_BIN` or a bare `oam`, already resolved against the shell
   *  PATH by having run it), while this value gets PERSISTED into a config file
   *  some other process reads. oam installs to `$HOME/.oam/bin` and only nudges
   *  the shell profile, so a GUI-launched client (Claude Desktop, Cursor from
   *  Finder/Explorer) inherits no such PATH -- a bare `oam` there is an ENOENT
   *  with no fallback, and doctor cannot even see it (it flags a missing command
   *  only when isAbsolute(command)). A non-absolute value is therefore IGNORED
   *  here, not just filtered by the caller, so the invariant is enforced at the
   *  boundary instead of by convention.
   *
   *  Ignored when `pkg` is set: `oamEntry` is resolved by the caller for a
   *  specific package, so honouring a `pkg` override here would emit an entry
   *  pinned in name only, pointing at whatever version happens to be on disk.
   *
   *  Scope of the safety claim: taking this path is an upgrade AT WRITE TIME.
   *  It cannot replace a launcher that works right now -- but the entry is
   *  baked, never re-resolved, and the client spawns `oam run --no-check <path>`
   *  verbatim, so none of the sidecar protections apply later (no
   *  MIN_OAM_VERSION gate, no ENOENT-to-npx retry, no boot-failure downgrade).
   *  A subsequent `npm rm -g @yawlabs/mcp` or oam uninstall breaks every client,
   *  and doctor reports a clean bill of health because it never checks the entry
   *  path in `args`.
   *
   *  Note this is a DIFFERENT axis from `runtime: "oam"` in bundles.json:
   *  that hosts the sidecars the broker spawns, this hosts the broker. */
  oamBinPath?: string | null;
  oamEntry?: string | null;
  /** Wrap the default broker entry in `cmd /c` on Windows. Defaults to TRUE,
   *  which is what every client but Continue needs -- `npx` is a `.cmd` shim
   *  and a client that spawns it directly gets ENOENT.
   *
   *  Only the DEFAULT branch reads it. The `upstream` branch always wraps (a
   *  third-party launcher's args have to survive cmd's parse, which is what
   *  escapeCmdArg's caret depths are for) and the oam branch is already
   *  unwrapped (oam is a real executable). The policy per client is DATA on
   *  the row -- `entry.windowsLaunch` -- and the caller reads it from there;
   *  this option is how it reaches the builder. */
  windowsWrap?: boolean;
}

/** cmd.exe metacharacters that split or redirect an UNQUOTED command line:
 *  `&` (chain), `|` (pipe), `<` `>` (redirect), `^` (escape), `(` `)`
 *  (grouping). `%` is deliberately absent -- cmd expands %VAR% BEFORE caret
 *  processing, so a caret cannot neutralize it, and mangling every literal
 *  `%` to dodge an expansion that only fires when the variable EXISTS is the
 *  worse trade (a bare `%NAME%` for an unset var is left literal by cmd, the
 *  common case; verified on Windows). */
const CMD_METACHARS = /[&|<>^()]/g;
const HAS_CMD_METACHAR = /[&|<>^()]/;

/** Node launcher names that ship as `.cmd`/`.bat` SHIMS on Windows (npx.cmd,
 *  npm.cmd, yarn.cmd, ...). A shim forwards its args through `%*`, which
 *  cmd.exe RE-PARSES a second time -- so an arg bound for a shim must survive
 *  TWO cmd parses, not one (see escapeCmdArg for the caret depth).
 *
 *  npm's own installers are what put these here: every `node_modules/.bin`
 *  entry and every global npm bin gets a generated `.cmd` wrapper on Windows. */
const KNOWN_CMD_SHIM_LAUNCHERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx"]);

/** Real executables cmd.exe launches DIRECTLY -- one cmd parse, no `%*`
 *  re-parse. Listed so the common direct launchers get single-level
 *  (full-fidelity) escaping instead of the fail-safe shim depth.
 *
 *  `uv`, `uvx` and `pipx` sit here, NOT in the shim set above, even though they
 *  are Python-ecosystem launchers: uv ships `uv.exe` and `uvx.exe` as native
 *  binaries (yaw-mcp's own bootstrap installs exactly that `uv.exe` -- see
 *  uv-bootstrap.ts), and pipx installs `pipx.exe`. Calling them shims cost an
 *  arg a caret level it never spends: a no-space metachar arg was triple-caret
 *  escaped and reached uvx.exe as the corrupted `^&` instead of `&`, after ONE
 *  cmd parse. Bare `uv` (a `uv run <srv>` upstream) was missing from this set
 *  after uvx had been cured of that, so it fell through to the fail-safe shim
 *  depth and uv.exe got the same corrupted arg. The residual risk is a user
 *  who hand-rolls their own `uvx.cmd` on PATH -- that arg is under-escaped --
 *  but an explicit `uvx.cmd` spelling in the config is still caught by the
 *  extension test in isCmdShimLauncher. */
const KNOWN_DIRECT_BINARIES = new Set([
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "uv",
  "uvx",
  "pipx",
  "ruby",
  "php",
  "docker",
  "dotnet",
  "java",
  "go",
]);

/** Is `command` a `.cmd`/`.bat` shim whose `%*` forwarding makes cmd.exe parse
 *  the forwarded args a SECOND time?  npx/npm/yarn are; node/uvx/docker are not.
 *
 *  This sets the caret depth in escapeCmdArg: an arg reaching a shim must
 *  survive two cmd parses (triple-caret), an arg reaching a real exe only one
 *  (single-caret). An UNKNOWN bare name fails SAFE to "shim" -- cmd can resolve
 *  it to a `.cmd` via PATHEXT, and over-escaping a real exe merely corrupts a
 *  hostile metachar arg, whereas under-escaping a shim is a command injection.
 *  Exported for tests. */
export function isCmdShimLauncher(command: string): boolean {
  const base = command.replace(/^.*[\\/]/, "").toLowerCase();
  if (/\.(?:cmd|bat)$/.test(base)) return true;
  if (/\.(?:exe|com)$/.test(base)) return false;
  const stem = base.replace(/\.[^.]*$/, "");
  if (KNOWN_CMD_SHIM_LAUNCHERS.has(stem)) return true;
  if (KNOWN_DIRECT_BINARIES.has(stem)) return false;
  return true;
}

/** Escape one argv element for the Windows `cmd /c` wrap in buildLaunchEntry.
 *
 *  The wrapped entry is spawned by the MCP CLIENT, whose runtime (Node/libuv on
 *  every client we target) quote-WRAPS an argv element only when it contains a
 *  space, tab, or double quote; everything else reaches cmd.exe verbatim -- and
 *  a bare `&` ends the command and runs the tail as a second one. Catalog args
 *  arrive tokenized from upstream install commands, so a plain query-string arg
 *  (`--url https://api/x?a=1&b=2`) silently truncates, and a hostile catalog
 *  entry is a command injection at client-spawn time behind an innocuous config
 *  file. Every case below was derived EMPIRICALLY on a native Windows box by
 *  spawning `cmd /c <target> <arg>` -- through both a `%*`-forwarding `.cmd`
 *  shim and a real exe -- and asserting the argv the child actually received.
 *
 *  Four shapes:
 *
 *    1. Contains a double-quote AND a cmd metacharacter -> REFUSE (throw).
 *       A literal quote forces libuv to quote-WRAP the element and escape the
 *       inner quote as `\"`. cmd.exe's parser counts quotes and does NOT honour
 *       that backslash, so `\"` prematurely CLOSES libuv's quote and flips quote
 *       parity for the rest of the element -- exposing any metacharacter there
 *       as a live splitter (reproduced: `a"&echo X` runs `echo X`). No caret
 *       depth fixes it because parity through libuv's wrapping is unpredictable,
 *       so we refuse the shape loudly rather than emit an exploitable entry.
 *
 *    2. Contains a double-quote but NO metacharacter -> verbatim. libuv wraps +
 *       escapes it and cmd, with nothing to act on, passes it through intact
 *       (`{"a":1}` round-trips). A caret here would land inside libuv's quotes
 *       as a literal and corrupt the value. Keeps legitimate JSON args working.
 *
 *    3. Contains a space/tab (no quote) -> verbatim. libuv quote-wraps it, and
 *       inside those quotes cmd treats metacharacters literally on EVERY parse
 *       (the wrap survives a shim's `%*` re-parse). A caret would corrupt it.
 *
 *    4. No quote, no space/tab -> caret-escape the metacharacters, since libuv
 *       passes the element verbatim and cmd sees them bare. Depth follows how
 *       many times cmd parses the element: a real exe is reached after ONE cmd
 *       parse (single caret, `^&` -> `&`); a `.cmd`/`.bat` shim forwards via
 *       `%*` which cmd RE-PARSES, so the element crosses TWO parses and needs a
 *       caret that survives both (`^^^&` -> `^&` -> `&`). The single-caret form
 *       that shipped before was a no-op against the shim: cmd stripped the one
 *       caret on the outer parse and the bare `&` split inside the shim. */
export function escapeCmdArg(arg: string, opts: { shim: boolean }): string {
  if (arg.includes('"')) {
    if (HAS_CMD_METACHAR.test(arg)) {
      throw new Error(
        `Cannot safely encode an argument that contains BOTH a double-quote and a ` +
          `cmd.exe metacharacter (& | < > ^ ( )) for the Windows cmd /c launcher: ${arg} -- ` +
          `passing it through cmd.exe risks a command injection at client-spawn time. ` +
          `Rework the server's args to drop one of the two.`,
      );
    }
    return arg;
  }
  if (/[ \t]/.test(arg)) return arg;
  const caret = opts.shim ? "^^^" : "^";
  return arg.replace(CMD_METACHARS, (m) => caret + m);
}

export function buildLaunchEntry(opts: BuildLaunchEntryOptions): LaunchEntry {
  if (opts.upstream) {
    // Upstream-shape entry (yaw-mcp try): preserve the upstream command +
    // args verbatim, but wrap on Windows so a `.cmd` shim launcher
    // (npx.cmd, npm.cmd, yarn.cmd) doesn't ENOENT when the client
    // spawns it directly.
    const { command, args, env } = opts.upstream;
    if (opts.os === "windows") {
      // A whitespace-bearing COMMAND cannot survive this wrap at all, so refuse
      // it here rather than persist an entry that dies at client-spawn time.
      // escapeCmdArg leaves such a token verbatim (shape 3) because libuv
      // quote-WRAPS it -- correct for an arg, wrong for the command, because
      // `cmd /c` has a rule of its own: when the line has more than one quoted
      // token, cmd strips the FIRST and LAST quote of the whole line. The
      // command's opening quote is the one that goes, so `"C:\Program Files\x\
      // srv.cmd" "--flag=a b"` is executed as `C:\Program` and the client
      // reports `'C:\Program' is not recognized`. No caret depth reaches it (the
      // quotes are libuv's, added after we return), which is why this is a
      // refusal and not an escape -- same trade as escapeCmdArg's shape 1.
      if (/[ \t]/.test(command)) {
        throw new Error(
          `Cannot safely encode a launcher command that contains whitespace for the Windows cmd /c ` +
            `launcher: ${command} -- cmd.exe strips the outer quotes when the line carries another ` +
            `quoted token, so the client's spawn fails with "'...' is not recognized". Point the ` +
            `server at a whitespace-free launcher (a bare npx/uvx resolved on PATH, or a short path).`,
        );
      }
      // Caret-escape cmd.exe metacharacters (see escapeCmdArg): without it,
      // any upstream token carrying an unquoted `&` / `|` / `<` / `>` splits
      // the `cmd /c` line when the CLIENT spawns the entry, running the tail
      // as a second command. The COMMAND token is parsed by cmd ONCE -- it is
      // resolved and launched, never forwarded through a shim's `%*` -- so it
      // escapes at the single-parse depth. The ARG tokens, when `command` is a
      // `.cmd`/`.bat` shim (npx/npm/yarn), cross a SECOND cmd parse via that
      // shim's `%*`, so they escape at the deeper shim depth. escapeCmdArg
      // throws on a genuinely unsafe shape (quote + metachar); that rejection
      // propagates to the caller's dispatch and surfaces as a clean error.
      const shim = isCmdShimLauncher(command);
      const wrapped: LaunchEntry = {
        command: "cmd",
        args: ["/c", escapeCmdArg(command, { shim: false }), ...args.map((a) => escapeCmdArg(a, { shim }))],
      };
      if (env && Object.keys(env).length > 0) wrapped.env = { ...env };
      return wrapped;
    }
    const entry: LaunchEntry = { command, args: [...args] };
    if (env && Object.keys(env).length > 0) entry.env = { ...env };
    return entry;
  }
  const pkg = opts.pkg ?? "@yawlabs/mcp@latest";
  // Host the broker on oam when the caller resolved both halves. No `cmd /c`
  // wrap on Windows: that exists because `npx` is a `.cmd` shim the client
  // cannot spawn directly, and oam is a real executable. `--no-check` keeps
  // the TypeScript checker off a long-lived stdio server.
  //
  // `opts.pkg` disables this path. `pkg` exists to pin a spec ("@yawlabs/
  // mcp@0.73.0"), and npx honours that on every spawn -- but oamEntry is a
  // resolved path the caller looked up for its OWN package, so combining them
  // would emit an entry that names one version and runs whatever is on disk.
  // Silently ignoring a pin is worse than not taking the oam path.
  //
  // isAbsolute is a hard gate, not an assertion about the caller: a bare `oam`
  // written into a client config resolves against the CLIENT's PATH, which a
  // GUI-launched app does not inherit from the shell that installed oam. Bare
  // names stay on npx -- see oamBinPath above.
  if (opts.oamBinPath && isAbsolute(opts.oamBinPath) && opts.oamEntry && !opts.pkg) {
    return { command: opts.oamBinPath, args: ["run", "--no-check", opts.oamEntry] };
  }
  // No `env` on the default entry: yaw-mcp is local-only, so there is no
  // token to inject. Servers come from ~/.yaw-mcp/bundles.json.
  //
  // `windowsWrap: false` emits the BARE launcher on Windows, for a client that
  // resolves the `.cmd` shim itself (Continue does, and pre-wrapping breaks it
  // under a WSL remote). The policy is the target row's -- `entry.windowsLaunch`
  // -- and the caller reads it off the row; this function only applies it, so
  // the default stays the `cmd /c` wrap every other client needs.
  return opts.os === "windows" && opts.windowsWrap !== false
    ? { command: "cmd", args: ["/c", "npx", "-y", pkg] }
    : { command: "npx", args: ["-y", pkg] };
}

/**
 * Does `entryPath` live in the node_modules of the tree `cwd` sits in?
 *
 * resolveStableNpmEntry calls any non-`_npx` node_modules hit "durable", which
 * includes a project's own `node_modules` -- and install persists that path into
 * a MACHINE-GLOBAL config (~/.claude.json, claude_desktop_config.json). A
 * project tree is much less durable than a global one: `rm -rf node_modules`,
 * `npm prune`, or renaming the checkout invalidates it, and the "npm update -g
 * rewrites that path in place" reasoning that justifies persisting a resolved
 * path at all only covers the global case. So the write is allowed but the user
 * is told, which needs this predicate to distinguish the two shapes.
 *
 * The test is "is cwd inside the tree that owns this node_modules", not a
 * global-prefix pattern match: prefix layouts differ per installer (nvm, fnm,
 * volta, homebrew, %APPDATA%\npm) and a missed layout would warn on a perfectly
 * good global install. It is also precisely the reachable case -- the entry is
 * resolved from the RUNNING broker's own module URL, so a project hit means
 * yaw-mcp was launched from that project's node_modules, which is where the
 * user is.
 *
 * Pure string work on both separators, and case-insensitive: Windows paths
 * compare case-insensitively (including drive-letter case, which differs
 * between `process.cwd()` and a resolved module path), and a POSIX tree whose
 * only difference is case would at worst earn one extra note.
 */
export function isProjectLocalEntry(entryPath: string, cwd: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const entry = norm(entryPath);
  const here = norm(cwd);
  // OUTERMOST node_modules, so a transitively-nested copy is still attributed
  // to the tree the user owns and would delete. Anchoring on the innermost one
  // instead would put the root under node_modules, where cwd never sits.
  const idx = entry.indexOf("/node_modules/");
  if (idx <= 0) return false;
  const root = entry.slice(0, idx);
  // Only this direction. The mirror test ("is the tree inside cwd") looks
  // tempting but misfires on every global install whose prefix happens to live
  // under HOME -- ~/.nvm/versions/node/<v>/lib/node_modules is inside cwd for
  // anyone running install from their home directory.
  return here === root || here.startsWith(`${root}/`);
}

/** The legacy entry key present in `container`, or null -- lets the upgrade
 *  nudge name the actual stale key it found. */
export function findLegacyEntry(container: Record<string, unknown>): string | null {
  return LEGACY_ENTRY_NAMES.find((n) => n in container) ?? null;
}

/** A key along the container path whose existing value is not an object, and so
 *  cannot have the launch entry spliced into it. */
export interface BlockedContainerSegment {
  /** Full key path to the offending key, for naming it in a message. */
  path: string[];
  /** What is there instead of an object. */
  value: unknown;
  /** Whether replacing it with `{}` throws nothing away -- see
   *  `findBlockedContainerSegment`. */
  reparable: boolean;
}

/**
 * First key along `containerPath` that holds a non-object, or null when the
 * chain is spliceable as-is.
 *
 * editJsoncEntry materializes MISSING intermediate keys, but a key that exists
 * and holds a non-object is left to jsonc-parser's `modify`, which throws
 * "Can not add index to parent of type null" -- an internal message naming
 * neither the file nor the key. The
 * pre-existing top-level check catches only a non-object ROOT, so `"mcpServers":
 * null` (hand-edited, or written by a tool that emptied it) reached the splice
 * and failed the whole install. Walking the chain here is what lets the caller
 * either repair the key or refuse while naming it.
 *
 * `reparable` splits the two shapes deliberately. null, a scalar, and an empty
 * array hold no server definitions, so replacing them with `{}` loses nothing
 * and restores the behaviour of the pre-splice merge path (which overwrote any
 * non-object container). A NON-EMPTY array can hold real entries in the wrong
 * shape, and silently dropping those to write ours is not a repair -- that case
 * is the caller's refusal.
 *
 * Lives here, not in install-cmd.ts, because doctor asks the same question of
 * the same file: install-cmd imports doctor-cmd, so doctor could not import it
 * from there without a cycle.
 */
export function findBlockedContainerSegment(
  root: Record<string, unknown>,
  containerPath: string[],
): BlockedContainerSegment | null {
  // EXACT, never folded through claudeCodeContainerPaths: this is the
  // pre-flight for a WRITE, and a write goes to the canonical path only. A
  // drive-case sibling's shape cannot block it and must not be reported as if
  // it did. Registered as such in the source-shape scan in
  // src/tests/source-hygiene.test.ts.
  let node: Record<string, unknown> = root;
  for (let i = 0; i < containerPath.length; i++) {
    const value = node[containerPath[i]];
    // Absent from here down: editJsoncEntry builds the rest of the chain itself.
    if (value === undefined) return null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      node = value as Record<string, unknown>;
      continue;
    }
    return {
      path: containerPath.slice(0, i + 1),
      value,
      reparable: value === null || !Array.isArray(value) || value.length === 0,
    };
  }
  return null;
}

/** How to name a non-object container value in a message. Shape, not contents:
 *  a `~/.claude.json` value can be arbitrarily large and the user needs to know
 *  WHICH key is wrong, not to have it echoed back. Used by install's messages
 *  and by doctor's CLIENTS line, so both name the key the same way. */
export function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  return `a ${typeof value}`;
}

/** The by-hand fix for a client config that exists but does not parse as a
 *  JSON object: invalid JSON, or valid JSON whose root is an array, a scalar or
 *  null. `yaw-mcp install` refuses such a file with exit 1 and writes nothing,
 *  and it refuses before --force, --repair, --skip or --dry-run is acted on --
 *  none of them gets past it (client-config-remedy.test.ts pins each).
 *
 *  ONE wording for every place that describes the state: install's refusal,
 *  doctor's CLIENTS line for the same file, and import's refusal to remove
 *  originals when this is the file install would write. Doctor used to say
 *  "fix or rerun `yaw-mcp install`", and a bare rerun is exactly what hits the
 *  refusal, so half of that advice could never work. `then` is the step once
 *  the file parses: install passes "re-run" (the user just typed the command),
 *  doctor passes the install command for the row it is describing, and import
 *  passes that command plus its own re-run. */
export function unparseableConfigFix(then: string): string {
  return `fix the JSON by hand, or move the file aside, then ${then}`;
}

/** The by-hand fix for a container key install cannot splice its entry into:
 *  one findBlockedContainerSegment reports as NOT reparable (a non-empty
 *  array -- null, a scalar and an empty array are replaced with `{}` instead).
 *  Shared by install's refusal, doctor's CLIENTS line and import's refusal to
 *  remove originals, for the same reason as unparseableConfigFix. */
export function blockedContainerFix(then: string): string {
  return `make it an object (or remove the key), then ${then}`;
}

/** Claude Code's settings.json and the `permissions.allow` grant install adds
 *  to it live in claude-code-settings.ts -- it is a permissions file, not an
 *  MCP server list, and the grant is spliced one array ELEMENT at a time so a
 *  comment inside that list survives. Re-exported here because every caller
 *  reaches this module for the Claude Code path questions. */
export {
  CLAUDE_CODE_ALLOW_PATTERN,
  prepareClaudeCodeSettingsPatch,
  resolveClaudeCodeSettingsPath,
} from "./claude-code-settings.js";
