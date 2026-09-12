// The TYPES a client-install target is made of, plus the two constants and the
// one resolver that every target row and every consumer needs.
//
// A LEAF on purpose. Its only runtime imports are `node:os` and `node:path`;
// everything it borrows from client-config.ts is `import type`, which
// `isolatedModules` requires be spelled that way and which both tsc and the
// bundler erase. So client-config.ts can import ENTRY_NAME and friends from
// HERE without a runtime cycle, and a `target-*.ts` row module can import the
// model without pulling in install-targets.ts (whose own evaluation builds the
// row array out of those modules -- the import that WOULD be a cycle, and the
// TDZ hazard the boundary test pins).
//
// `install-targets.ts` re-exports this file wholesale (`export * from
// "./install-target-model.js"`), so every pre-existing
// `from "./install-targets.js"` import path keeps resolving to the same names.
// Nothing here reads the environment or the filesystem except
// `resolveAppDataDir`, which exists to be the ONE reader of %APPDATA%.

import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigShape, EntryTransform, ImportView, ReloadKind } from "./client-config.js";

// Re-exported so a target row module has ONE import specifier to reach for.
// Types only, so this adds no runtime edge back to client-config.ts.
export type { ConfigShape, EntryTransform, ImportView, ReloadKind };

export type InstallOS = "macos" | "linux" | "windows";
export type InstallScope = "user" | "project" | "local";

export const CURRENT_OS: InstallOS =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

export interface ResolvedPath {
  /** Absolute path to the config file (with ~ / env vars expanded). */
  absolute: string;
  /** Human-friendly display path with ~ / env-var form preserved. */
  display: string;
  /** JSON key path to the mcpServers/servers container that holds the
   *  ENTRY_NAME entry. Almost always `[config.root]`, but Claude Code's
   *  local scope nests under `["projects", <absProjectDir>, "mcpServers"]`
   *  inside `~/.claude.json`. The client-config adapters walk this array to
   *  read/merge the entry while preserving every sibling at every level; no
   *  consumer walks it itself (the boundary test's R4 pins that). */
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
  /** This scope's file is read by the client as STRICT JSON, narrowing the
   *  target's `config.format` from "jsonc" to "json" for this scope alone
   *  (Claude Code's project scope: it parses `.mcp.json` with JSON.parse, so
   *  a comment in it means no server in that file loads). `effectiveConfigFormat`
   *  in client-config.ts is what applies it. */
  strictJson?: boolean;
  /** A caveat printed after the target's own `notes`, for something true of
   *  this SCOPE rather than the client. */
  notes?: string;
}

/** The MCP client `mcpServers["mcp"]` entry — what `install` writes. The key
 *  is ENTRY_NAME (`mcp`); `yaw-mcp` is a LEGACY_ENTRY_NAME nothing writes any
 *  more, so naming it here sent readers looking for the wrong key. */
export interface LaunchEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The entry key we write into `mcpServers` (Claude Code / Desktop / Cursor),
 *  `servers` (VS Code) or `context_servers` (Zed). Stable across clients so
 *  doctor can detect collisions deterministically. */
export const ENTRY_NAME = "mcp";

/** Entry keys earlier installers wrote under: the dead `mcp.hosting` / `mcph`
 *  brand and the interim `yaw-mcp` key. Doctor + install detect these so users
 *  upgrading get a visible nudge instead of silently running two parallel
 *  servers from the same client config. Nothing writes these keys anymore. */
export const LEGACY_ENTRY_NAMES = ["mcp.hosting", "mcph", "yaw-mcp"] as const;

/** What a target's own `resolvePath` / `sites` hooks are handed: the resolved
 *  directories, already defaulted, plus the client env-var values read through
 *  `readClientEnv`. A row NEVER reads `process.env` itself -- the boundary
 *  test's R7 confines those seven names to this module's neighbourhood. */
export interface PathBase {
  home: string;
  /** Windows `%APPDATA%`, chosen by the caller via `resolveAppDataDir`. */
  appData: string;
  /** Absolute project dir, or "" for a user-scope resolve. */
  projectDir: string;
  os: InstallOS;
  scope: InstallScope;
  /** Every client env var, as `readClientEnv` reported it -- verbatim, so each
   *  row applies its own resolution policy (they differ per client). */
  env: ClientEnvValues;
}

/** The env values a row may consult, named rather than typed as the whole
 *  `ClientEnv` so this module stays a leaf. Field names mirror `ClientEnv` in
 *  client-config.ts exactly; a test pins that the two agree. */
export interface ClientEnvValues {
  appData?: string;
  claudeConfigDir?: string;
  clineDataDir?: string;
  clineDir?: string;
  clineMcpSettingsPath?: string;
  codexHome?: string;
  continueGlobalDir?: string;
  xdgConfigHome?: string;
}

/** One copy of a target's config file. A target with no `sites` hook has
 *  exactly one, `detectDir: null`, at its `resolvePath` result. */
export interface SiteSpec {
  /** Stable per-target id, used in `--list` / doctor rows and in messages. */
  id: string;
  /** What the run prints for this copy ("shared settings", "VS Code"). */
  label: string;
  resolved: ResolvedPath;
  /** A directory whose existence decides whether this copy is real. null keeps
   *  the site unconditionally. `selectSites` in client-config.ts applies it. */
  detectDir: string | null;
}

/** Behaviour a row opts into by NAME rather than by the consumer testing its
 *  `clientId` -- the three `clientId === "claude-code"` branches and the one
 *  `clientId === "vscode"` branch this replaces are what R6 now forbids. */
export interface TargetHooks {
  /** Patch this client's own permission file alongside the launch entry.
   *  "claude-code" is the only scheme there is; the value names it rather than
   *  carrying a function so the row stays data. */
  permissionsPatch?: "claude-code";
  /** Which `${...}` expansion rules `import` applies to this client's entries.
   *  BOTH handlers live in import-cmd.ts; a row only names the value.
   *  "vscode-inputs" is the inputs-block + `${workspaceFolder}` logic. */
  importVariables?: "vscode-inputs" | "cline-env";
}

/** Every field of a row, with `clientId: string` so the literal ids can be
 *  DERIVED from the array below without circularity: a row typed with an id
 *  union that is itself derived from the rows widens to `string`, and the
 *  union collapses. `defineTarget`'s `const` type parameter is what keeps each
 *  row's own literal. */
export interface InstallTargetBase {
  clientId: string;
  label: string;
  /** Where and in what syntax this client keeps its server list. Replaces the
   *  old `jsonShape`, which was documentation only (nothing in src/ read it,
   *  so it could disagree with `containerPath` silently). */
  config: ConfigShape;
  /** How this client's stored entry differs from the canonical one: fields to
   *  carry, a normalisation, extra fields to write, the import spelling. */
  entry?: EntryTransform;
  /** READONLY arrays on purpose: a `const` type parameter infers a row's
   *  arrays as readonly tuples, and a mutable-array constraint would make TS
   *  widen them (and the row) back. Every consumer only reads. */
  scopes: readonly InstallScopeSpec[];
  /** OSes yaw-mcp can configure this client on -- the ones where it knows the
   *  config file path. Every verb refuses on any other OS. Normally that is
   *  every OS the client ships on; `notConfigurableOn` records the exception. */
  availableOn: readonly InstallOS[];
  /** An OS the client DOES ship on but that is still left out of
   *  `availableOn`, mapped to the reason, worded as one clause. The refusal
   *  (install, uninstall, import, try), the resolver's throw, doctor and the
   *  `--all` skip line print it; `install --list` only keys its "not
   *  supported yet" label off its presence. Either way the claim about a
   *  third party lives in one place. An OS missing from `availableOn` with no
   *  entry here is reported as one the client is not available on. */
  notConfigurableOn?: Partial<Record<InstallOS, string>>;
  /** Extra user-facing caveats (e.g., "restart the app after editing"). */
  notes?: string;
  /** How the client picks up a config change. Default "restart", which is the
   *  Done line every existing row prints. */
  reload?: ReloadKind;
  /** Every copy of the file for one (client, scope) -- a fan-out only Cline
   *  needs. Absent means one site at `resolvePath`/`pathFor`, `detectDir: null`. */
  sites?: (base: PathBase) => SiteSpec[];
  hooks?: TargetHooks;
}

/** The six rows that keep their inline `pathFor` branches. `resolvePath` is
 *  ABSENT here, which is what lets `pathFor` narrow: `if (t.resolvePath) return
 *  t.resolvePath(base)` leaves an InlineTarget, and the switch over the inline
 *  ids can end in a `never` check. */
export type InlineClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "windsurf" | "gemini-cli";

export interface InlineTarget extends InstallTargetBase {
  clientId: InlineClientId;
  resolvePath?: undefined;
}

/** New targets resolve their own paths; the six existing ids keep the inline
 *  `pathFor` branches so their bytes cannot move. */
export interface ModularTarget extends InstallTargetBase {
  resolvePath: (base: PathBase) => ResolvedPath;
}

/** Identity with a `const` type parameter: the row's `clientId` literal
 *  survives inference, which is what lets `InstallClientId` be derived from
 *  the row array instead of hand-kept beside it. Every `target-*.ts` row is
 *  `export const ZED_TARGET = defineTarget({ clientId: "zed", ... })`. */
export function defineTarget<const T extends InlineTarget | ModularTarget>(t: T): T {
  return t;
}

/** The one place that decides where %APPDATA% lives for a caller.
 *
 *  `resolveInstallPath` is deliberately pure, which makes picking this the
 *  CALLER's job -- and every caller has to pick it the SAME way or read and
 *  write disagree. They did: `doctor` and `try` each derived it from `home`
 *  alone, so on a box with %APPDATA% redirected away from
 *  `<home>\AppData\Roaming` they reported the home-derived path while install
 *  wrote the real one. An explicit `appData` wins; an overridden `home` keeps a
 *  hermetic run inside that home; otherwise the ambient %APPDATA% is
 *  authoritative, because that is the directory Claude Desktop itself reads.
 *
 *  EMPTY counts as UNSET at both env-shaped steps -- matching `cacheDir()` in
 *  paths.ts and the `claudeConfigDir` guards in install-targets.ts. A
 *  nullish-only check let an empty-but-set %APPDATA% (ordinary on Windows and
 *  in CI) return "", which `resolveInstallPath` passed straight through,
 *  resolving claude-desktop to the RELATIVE
 *  `Claude\claude_desktop_config.json` -- a file doctor stat-ed and printed
 *  against the process cwd. `home` is deliberately NOT guarded that way:
 *  falling an empty `home` through to the ambient %APPDATA% would point a run
 *  that asked for a synthetic home at the developer's REAL config file. */
export function resolveAppDataDir(opts: { appData?: string; home?: string; env?: NodeJS.ProcessEnv }): string {
  if (opts.appData !== undefined && opts.appData.length > 0) return opts.appData;
  if (opts.home !== undefined) return join(opts.home, "AppData", "Roaming");
  const env = opts.env ?? process.env;
  const fromEnv = env.APPDATA;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), "AppData", "Roaming");
}
