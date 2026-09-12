// The Cline row, as DATA.
//
// Imports the LEAF model only -- see the header of target-zed.ts for why.
//
// Cline is the one target whose ONE (client, scope) pair maps to SEVERAL
// files: a shared `~/.cline/data/settings/cline_mcp_settings.json` that the
// CLI and the extension's newer runtime read, plus one copy per editor the
// extension has ever run in, under that editor's globalStorage. `sites`
// returns all of them; `selectSites` in client-config.ts keeps the shared one
// unconditionally and an editor copy only when its storage directory exists,
// so an editor the user does not have is never written to.
//
// The file is STRICT JSON -- Cline parses it with JSON.parse, so a comment or
// a trailing comma in it means no server in that file loads. `config.format`
// says "json" rather than "jsonc" for exactly that reason, and the strict
// adapter is what refuses a write into a file Cline could not read.

import { join } from "node:path";
import { defineTarget, type PathBase, type SiteSpec } from "./install-target-model.js";

/** The Cline VS Code extension's publisher.extension id, which names its
 *  globalStorage directory. One constant, because it appears in five paths. */
const CLINE_EXTENSION_ID = "saoudrizwan.claude-dev";

const SETTINGS_FILE = "cline_mcp_settings.json";

/** The editors whose Cline extension keeps its own copy of the settings file.
 *  `dir` is the per-editor directory VS Code and its forks put `User/` under,
 *  which is NOT the display label -- "Code - Insiders" against "VS Code
 *  Insiders" -- so the two are separate fields. `id` is what a `--list` or
 *  doctor row names the site. */
const CLINE_HOSTS = [
  { id: "vscode", label: "VS Code", dir: "Code" },
  { id: "vscode-insiders", label: "VS Code Insiders", dir: "Code - Insiders" },
  { id: "vscodium", label: "VSCodium", dir: "VSCodium" },
  { id: "cursor", label: "Cursor", dir: "Cursor" },
  { id: "windsurf", label: "Windsurf", dir: "Windsurf" },
] as const;

/** Join display SEGMENTS with the target OS's separator, spelling a leading
 *  `~` as `%USERPROFILE%` on Windows like every other row's display strings.
 *
 *  Display is BUILT from the same segments the absolute path is built from,
 *  never derived by comparing the absolute path against the home prefix: that
 *  comparison is defeated by a forward-slash USERPROFILE, by a case-variant
 *  home, and by a sibling directory sharing the prefix -- which is why
 *  paths.ts owns the one helper that does it and nothing here re-rolls it. */
function displayPath(base: PathBase, segments: readonly string[]): string {
  const sep = base.os === "windows" ? "\\" : "/";
  const head = segments[0] === "~" && base.os === "windows" ? "%USERPROFILE%" : segments[0];
  return [head, ...segments.slice(1)].join(sep);
}

/** The directory an editor keeps its User/ tree in, per OS, as BOTH the
 *  absolute path and the display segments naming it, so the two cannot drift.
 *
 *  Linux hardcodes `~/.config` rather than honouring $XDG_CONFIG_HOME -- the
 *  same rule, and the same known gap, as the existing vscode row's user path. */
function editorRoot(base: PathBase, dirName: string): { dir: string; display: string[] } {
  if (base.os === "windows") return { dir: join(base.appData, dirName), display: ["%APPDATA%", dirName] };
  if (base.os === "macos") {
    return {
      dir: join(base.home, "Library", "Application Support", dirName),
      display: ["~", "Library", "Application Support", dirName],
    };
  }
  return { dir: join(base.home, ".config", dirName), display: ["~", ".config", dirName] };
}

/** The shared file's directory: `CLINE_MCP_SETTINGS_PATH` names the FILE
 *  outright, `CLINE_DATA_DIR` its data dir, `CLINE_DIR` the dir above that --
 *  Cline's own precedence. Values arrive verbatim from `readClientEnv` (empty
 *  already counts as unset); a surrounding-whitespace-only value is treated as
 *  unset here because a path made of spaces is not one the user can have
 *  meant.
 *
 *  Cline's own `$HOME`-before-`%USERPROFILE%` rule is deliberately NOT
 *  mirrored on Windows: yaw-mcp resolves every client path from one `home`
 *  (os.homedir(), i.e. %USERPROFILE%), and forking that for one client would
 *  make install and doctor disagree on a box where the two differ. */
function sharedSettingsFile(base: PathBase): { absolute: string; display: string } {
  const trimmed = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && t.length > 0 ? t : undefined;
  };
  // An env-directed path is shown VERBATIM, the `CLAUDE_CONFIG_DIR`
  // precedent: a `~` spelling would hide the redirect that put the file
  // somewhere else.
  const exact = trimmed(base.env.clineMcpSettingsPath);
  if (exact) return { absolute: exact, display: exact };
  const dataDir = trimmed(base.env.clineDataDir);
  if (dataDir) {
    const absolute = join(dataDir, "settings", SETTINGS_FILE);
    return { absolute, display: absolute };
  }
  const clineDir = trimmed(base.env.clineDir);
  if (clineDir) {
    const absolute = join(clineDir, "data", "settings", SETTINGS_FILE);
    return { absolute, display: absolute };
  }
  return {
    absolute: join(base.home, ".cline", "data", "settings", SETTINGS_FILE),
    display: displayPath(base, ["~", ".cline", "data", "settings", SETTINGS_FILE]),
  };
}

function clineSites(base: PathBase): SiteSpec[] {
  const shared = sharedSettingsFile(base);
  const sites: SiteSpec[] = [
    {
      id: "shared",
      label: "shared settings",
      resolved: { absolute: shared.absolute, display: shared.display, containerPath: ["mcpServers"] },
      // Unconditional: this is the file the CLI and the newer extension
      // runtime read, and it is where install creates one if none exists.
      detectDir: null,
    },
  ];
  for (const host of CLINE_HOSTS) {
    const root = editorRoot(base, host.dir);
    const storage = join(root.dir, "User", "globalStorage", CLINE_EXTENSION_ID);
    sites.push({
      id: host.id,
      label: host.label,
      resolved: {
        absolute: join(storage, "settings", SETTINGS_FILE),
        display: displayPath(base, [
          ...root.display,
          "User",
          "globalStorage",
          CLINE_EXTENSION_ID,
          "settings",
          SETTINGS_FILE,
        ]),
        containerPath: ["mcpServers"],
      },
      // Kept only when the extension has actually run in that editor, which
      // is what creates its globalStorage directory.
      detectDir: storage,
    });
  }
  return sites;
}

/** Cline's own per-server fields, carried from a stored entry with each value
 *  type-checked, for the same reason Zed's are: a user who disabled the server
 *  would otherwise see drift on every re-run, and `--repair` would switch it
 *  back on. `type` is carried only when it says `"stdio"` -- any other value
 *  describes a transport this entry is not. */
function carryClineFields(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof stored.disabled === "boolean") out.disabled = stored.disabled;
  if (Array.isArray(stored.autoApprove) && stored.autoApprove.every((v) => typeof v === "string")) {
    out.autoApprove = [...stored.autoApprove];
  }
  if (typeof stored.timeout === "number" && Number.isFinite(stored.timeout) && stored.timeout >= 0) {
    out.timeout = stored.timeout;
  }
  if (stored.type === "stdio") out.type = "stdio";
  return out;
}

/** Cline has written a nested transport form -- `{ transport: { command,
 *  args, env } }` -- alongside the flat one. Folding it here is what lets
 *  every consumer compare, inspect and import ONE shape: the flat fields win
 *  when both spellings are present, because that is what install writes. */
function normalizeClineEntry(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return stored;
  const obj = stored as Record<string, unknown>;
  const transport = obj.transport;
  if (typeof transport !== "object" || transport === null || Array.isArray(transport)) return stored;
  const { transport: _dropped, ...rest } = obj;
  return { ...(transport as Record<string, unknown>), ...rest };
}

export const CLINE_TARGET = defineTarget({
  clientId: "cline",
  label: "Cline",
  // STRICT: Cline parses this file with JSON.parse, so a comment in it stops
  // every server in it from loading. The strict adapter refuses a write into
  // such a file rather than adding a server nothing will read.
  config: { format: "json", root: "mcpServers" },
  availableOn: ["macos", "linux", "windows"],
  // The extension watches the file and reconnects without a restart.
  reload: "live",
  entry: {
    carry: carryClineFields,
    normalize: normalizeClineEntry,
  },
  hooks: {
    // Cline's entries can carry `${env:NAME}`, but there is no inputs block
    // and no workspace folder to resolve against, so import reports such a
    // value as unresolved instead of substituting one.
    importVariables: "cline-env",
  },
  notes:
    "Cline keeps one cline_mcp_settings.json per runtime: ~/.cline/data/settings/ for the Cline CLI and the VS Code extension's newer runtime, and <editor>/User/globalStorage/saoudrizwan.claude-dev/settings/ for the extension's legacy runtime -- so install writes the first always and each editor copy it finds. The file is strict JSON: no comments, no trailing commas. The Cline extension watches it and reconnects without a restart.",
  resolvePath: (base) => clineSites(base)[0].resolved,
  sites: clineSites,
  scopes: [
    {
      scope: "user",
      label: "User (global)",
      description: "Every Cline copy on this machine: the shared ~/.cline file and each editor Cline has run in.",
      requiresProjectDir: false,
    },
  ],
});
