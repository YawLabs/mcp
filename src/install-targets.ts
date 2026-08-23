// Per-client, per-OS config file metadata for `yaw-mcp install <client>`.
// This is the authoritative mapping of {client, scope, OS} → file path +
// JSON shape. (A pre-rename dashboard install mirror has been archived; this
// file is now the sole source of truth.) The tests in install-targets.test.ts lock the
// specifics (file names, JSON root keys) that would silently break the
// install flow if regressed.
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
//   • Claude Desktop has no Linux build, so install on Linux for that
//     client must refuse with a clear message rather than writing a
//     file the app will never read.
//   • On Windows, `npx` is a `.cmd` shim; MCP clients that spawn it
//     directly get ENOENT. The launch entry must be
//     `{ command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp"] }`.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type InstallOS = "macos" | "linux" | "windows";
export type InstallClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode";
export type InstallScope = "user" | "project" | "local";
export type JsonShape = "mcpServers" | "servers";

export interface ResolvedPath {
  /** Absolute path to the config file (with ~ / env vars expanded). */
  absolute: string;
  /** Human-friendly display path with ~ / env-var form preserved. */
  display: string;
  /** JSON key path to the mcpServers/servers container that holds the
   *  ENTRY_NAME entry. Almost always `[jsonShape]`, but Claude Code's
   *  local scope nests under `["projects", <absProjectDir>, "mcpServers"]`
   *  inside `~/.claude.json`. install-cmd + doctor walk this array to
   *  read/merge the entry while preserving every sibling at every level. */
  containerPath: string[];
}

export interface InstallScopeSpec {
  scope: InstallScope;
  /** Short label for help output. */
  label: string;
  /** Why you'd choose this scope. */
  description: string;
  /** Whether project folder is needed to resolve the path. */
  requiresProjectDir: boolean;
}

export interface InstallTarget {
  clientId: InstallClientId;
  label: string;
  jsonShape: JsonShape;
  /** Scopes this client supports. Empty = client unavailable. */
  scopes: InstallScopeSpec[];
  /** OSes the client ships on. Install on other OSes refuses. */
  availableOn: InstallOS[];
  /** Extra user-facing caveats (e.g., "restart the app after editing"). */
  notes?: string;
}

export const CURRENT_OS: InstallOS =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

export const INSTALL_TARGETS: InstallTarget[] = [
  {
    clientId: "claude-code",
    label: "Claude Code",
    jsonShape: "mcpServers",
    availableOn: ["macos", "linux", "windows"],
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
  },
  {
    clientId: "claude-desktop",
    label: "Claude Desktop",
    jsonShape: "mcpServers",
    availableOn: ["macos", "windows"],
    notes: "Claude Desktop reads one file per OS — no project scope. Restart the app after editing.",
    scopes: [
      {
        scope: "user",
        label: "User",
        description: "The only config file Claude Desktop reads.",
        requiresProjectDir: false,
      },
    ],
  },
  {
    clientId: "cursor",
    label: "Cursor",
    jsonShape: "mcpServers",
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
  },
  {
    clientId: "vscode",
    label: "VS Code",
    jsonShape: "servers",
    availableOn: ["macos", "linux", "windows"],
    notes: "VS Code uses `servers` (not `mcpServers`) as the top-level key in .vscode/mcp.json.",
    scopes: [
      {
        scope: "project",
        label: "Workspace",
        description: "Per-project config; commit to share.",
        requiresProjectDir: true,
      },
    ],
  },
];

export interface ResolvePathOptions {
  clientId: InstallClientId;
  scope: InstallScope;
  os: InstallOS;
  projectDir?: string;
  /** Override for tests; defaults to os.homedir(). */
  home?: string;
  /** Override for tests; defaults to process.env.APPDATA (Windows). */
  appData?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set (truthy), claude-code
   *  user/local scope writes to `<dir>/.claude.json` instead of
   *  `<home>/.claude.json`, matching Claude Code's actual read path.
   *  Resolver stays pure: callers (install-cmd, doctor-cmd, index.ts)
   *  read `process.env.CLAUDE_CONFIG_DIR` and pass it in. */
  claudeConfigDir?: string;
}

export function resolveInstallPath(opts: ResolvePathOptions): ResolvedPath {
  const home = opts.home ?? homedir();
  const appData = opts.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const { clientId, scope, os, projectDir, claudeConfigDir } = opts;
  const target = INSTALL_TARGETS.find((t) => t.clientId === clientId);
  if (!target) throw new Error(`Unknown client: ${clientId}`);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) throw new Error(`Client ${clientId} does not support scope ${scope}`);
  if (!target.availableOn.includes(os)) {
    throw new Error(`${target.label} is not available on ${os}`);
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

  const p = pathFor(clientId, scope, os, {
    home,
    appData,
    projectDir: absoluteProjectDir ?? "",
    claudeConfigDir: claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : undefined,
  });
  return p;
}

/** The `projects[...]` key Claude Code uses for `projectDir` in ~/.claude.json.
 *
 *  Claude Code writes those keys with FORWARD slashes on every OS — a Windows
 *  checkout appears as "C:/Users/me/repo", never "C:\\Users\\me\\repo" (every
 *  project key in a real Windows ~/.claude.json uses `/`). `resolve(cwd)` on
 *  win32 hands us the backslash spelling, and writing it verbatim creates a
 *  NEW sibling key Claude Code never reads: install prints Done, doctor and
 *  --list confirm "installed" (they compute the same wrong key), and /mcp
 *  shows nothing. Normalize the KEY only — the config-file path itself stays
 *  platform-native.
 *
 *  Scoped to Windows-shaped paths (drive letter or UNC) so a POSIX directory
 *  whose name legitimately contains a backslash is not mangled.
 *
 *  Exported for tests: the Windows-shape branch is unreachable through
 *  resolveInstallPath on a POSIX runner (isAbsolute("C:\\...") is false
 *  there, so resolve() rewrites the fixture first). */
export function claudeCodeProjectKey(projectDir: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(projectDir) ? projectDir.replace(/\\/g, "/") : projectDir;
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
    // linux — unreachable because availableOn guards this, but belt+suspenders.
    throw new Error("Claude Desktop is not available on Linux");
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
    // VS Code only supports workspace/project scope today.
    return {
      absolute: join(projectDir, ".vscode", "mcp.json"),
      display: joinPath("<project folder>", ".vscode", "mcp.json"),
      containerPath: ["servers"],
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
}

/** The MCP client `mcpServers["yaw-mcp"]` entry — what `install` writes. */
export interface LaunchEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** cmd.exe metacharacters that split or redirect an UNQUOTED command line:
 *  `&` (chain), `|` (pipe), `<` `>` (redirect), `^` (escape), `(` `)`
 *  (grouping). `%` is deliberately absent — cmd expands %VAR% BEFORE caret
 *  processing, so a caret cannot neutralize it, and mangling every literal
 *  `%` to dodge an expansion that only fires when the variable exists is the
 *  worse trade. */
const CMD_METACHARS = /[&|<>^()]/g;

/** Escape one argv element for the Windows `cmd /c` wrap in buildLaunchEntry.
 *
 *  The wrapped entry is spawned by the MCP CLIENT, whose runtime (Node/libuv
 *  on every client we target) only quotes an argv element containing a space,
 *  tab, or double quote. Everything else reaches cmd.exe verbatim — where a
 *  bare `&` ends the command and runs the tail as a second one. Catalog args
 *  come to us tokenized from upstream install commands, so a plain
 *  query-string arg (`--url https://api/x?a=1&b=2`) silently truncates, and a
 *  hostile catalog entry is a command injection at client-spawn time with an
 *  innocuous-looking config file.
 *
 *  Two shapes, two treatments:
 *    - arg the client will NOT quote (no space/tab/quote): caret-escape the
 *      metacharacters; cmd strips the carets and hands the original string
 *      to the child.
 *    - arg the client WILL quote: leave it alone — inside the double quotes
 *      the client adds, cmd.exe treats metacharacters literally, and a caret
 *      there would survive as a literal character and corrupt the value. */
export function escapeCmdArg(arg: string): string {
  if (/[ \t"]/.test(arg)) return arg;
  return arg.replace(CMD_METACHARS, "^$&");
}

export function buildLaunchEntry(opts: BuildLaunchEntryOptions): LaunchEntry {
  if (opts.upstream) {
    // Upstream-shape entry (yaw-mcp try): preserve the upstream command +
    // args verbatim, but wrap on Windows so a `.cmd` shim launcher
    // (npx.cmd, uvx.cmd, pipx.cmd) doesn't ENOENT when the client
    // spawns it directly.
    const { command, args, env } = opts.upstream;
    if (opts.os === "windows") {
      // Caret-escape cmd.exe metacharacters (see escapeCmdArg): without it,
      // any upstream token carrying an unquoted `&` / `|` / `<` / `>` splits
      // the `cmd /c` line when the CLIENT spawns the entry, running the tail
      // as a second command.
      const wrapped: LaunchEntry = {
        command: "cmd",
        args: ["/c", escapeCmdArg(command), ...args.map(escapeCmdArg)],
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
  return opts.os === "windows"
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

/** The entry key we write into `mcpServers` (Claude Code / Desktop / Cursor)
 *  or `servers` (VS Code). Stable across clients so doctor can detect
 *  collisions deterministically. */
export const ENTRY_NAME = "mcp";

/** Entry keys earlier installers wrote under: the dead `mcp.hosting` / `mcph`
 *  brand and the interim `yaw-mcp` key. Doctor + install detect these so users
 *  upgrading get a visible nudge instead of silently running two parallel
 *  servers from the same client config. Nothing writes these keys anymore. */
export const LEGACY_ENTRY_NAMES = ["mcp.hosting", "mcph", "yaw-mcp"] as const;

/** The legacy entry key present in `container`, or null -- lets the upgrade
 *  nudge name the actual stale key it found. */
export function findLegacyEntry(container: Record<string, unknown>): string | null {
  return LEGACY_ENTRY_NAMES.find((n) => n in container) ?? null;
}

/** Pattern added to Claude Code's `permissions.allow` on install so the
 *  user isn't re-prompted for each yaw-mcp MCP tool call. Only matters for
 *  Claude Code (Claude Desktop / Cursor / VS Code have their own models).
 *  Keep in sync with the tool-name prefix our proxy exposes -- Claude Code
 *  derives the prefix from ENTRY_NAME by replacing non-alphanumeric chars
 *  with underscores, so "mcp" becomes "mcp__mcp__". */
export const CLAUDE_CODE_ALLOW_PATTERN = "mcp__mcp__*";

/** Resolve the Claude Code settings.json file that holds `permissions.allow`.
 *  Different from the mcpServers path (`~/.claude.json`): permissions live
 *  in `settings.json`, not the user config. Returns null for clients that
 *  don't use this scheme.
 *
 *  When `claudeConfigDir` is set, user-scope `settings.json` lives at
 *  `<DIR>/settings.json` (NOT `<DIR>/.claude/settings.json` — the `.claude`
 *  segment is absorbed by the env redirect). Project/local scopes are
 *  project-relative and unaffected. */
export function resolveClaudeCodeSettingsPath(
  scope: InstallScope,
  opts: { home: string; projectDir?: string; os: InstallOS; claudeConfigDir?: string },
): string | null {
  const { home, projectDir, claudeConfigDir } = opts;
  const cfgDir = claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : null;
  if (scope === "user") return cfgDir ? join(cfgDir, "settings.json") : join(home, ".claude", "settings.json");
  if (scope === "project" && projectDir) return join(projectDir, ".claude", "settings.json");
  if (scope === "local" && projectDir) return join(projectDir, ".claude", "settings.local.json");
  return null;
}
