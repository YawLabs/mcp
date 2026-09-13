// The Zed row, as DATA.
//
// Imports the LEAF model only, never install-targets.ts -- that module's own
// evaluation builds INSTALL_TARGETS out of this one, so an import back would
// be a cycle and a TDZ hazard (the boundary test's R11 pins both directions).
//
// What is Zed-specific and lives here rather than in a consumer:
//   * the container key is `context_servers`, not `mcpServers`;
//   * the Linux path follows $XDG_CONFIG_HOME when it is ABSOLUTE;
//   * Zed watches settings.json and starts/stops servers on save, so the Done
//     line says no restart is needed (`reload: "live"`);
//   * `enabled`, `remote` and `timeout` are Zed's own per-server fields and
//     are carried from a stored entry on every path but --force, the way `env`
//     already is -- otherwise a user who set `"enabled": false` would see
//     drift on every re-run and `--repair` would silently switch the server
//     back on.

import { isAbsolute, join } from "node:path";
import { defineTarget, type PathBase, type ResolvedPath } from "./install-target-model.js";

/** Zed's config root on this OS.
 *
 *  `$XDG_CONFIG_HOME` is honoured ONLY when it is absolute, which is the rule
 *  Zed inherits from the dirs-rs crate it resolves its paths with: a relative
 *  value is ignored there rather than resolved against the process cwd. The
 *  value arrives verbatim from `readClientEnv` (empty already counts as
 *  unset), so this function is where the policy lives and the reader stays
 *  policy-free -- the two other clients that read a directory variable resolve
 *  a relative one, and one rule in the reader would be wrong for somebody.
 *
 *  Not modelled, and named in `notes`: the Flatpak build, which reads
 *  `$FLATPAK_XDG_CONFIG_HOME/zed` instead, and `zed --user-data-dir <dir>`. */
function zedConfigDir(base: PathBase): { dir: string; display: string } | null {
  if (base.os === "windows") {
    return { dir: join(base.appData, "Zed"), display: "%APPDATA%\\Zed" };
  }
  const xdg = base.env.xdgConfigHome;
  if (base.os === "linux" && xdg && isAbsolute(xdg)) {
    return { dir: join(xdg, "zed"), display: `$XDG_CONFIG_HOME/zed` };
  }
  return { dir: join(base.home, ".config", "zed"), display: "~/.config/zed" };
}

function resolveZedPath(base: PathBase): ResolvedPath {
  if (base.scope === "project") {
    const sep = base.os === "windows" ? "\\" : "/";
    return {
      absolute: join(base.projectDir, ".zed", "settings.json"),
      display: ["<project folder>", ".zed", "settings.json"].join(sep),
      containerPath: ["context_servers"],
    };
  }
  const cfg = zedConfigDir(base);
  // Unreachable: zedConfigDir returns a directory on every OS. Kept as a
  // total-function guard rather than a non-null assertion, so a future OS
  // branch that forgets to return cannot resolve to `undefined/settings.json`.
  if (!cfg) throw new Error(`Zed's settings.json location on ${base.os} is unknown`);
  const sep = base.os === "windows" ? "\\" : "/";
  return {
    absolute: join(cfg.dir, "settings.json"),
    display: [cfg.display, "settings.json"].join(base.os === "windows" ? sep : "/"),
    containerPath: ["context_servers"],
  };
}

/** Zed's own per-server fields, carried from a stored entry. Each is checked
 *  for the TYPE Zed gives it, because carrying an ill-typed value forward
 *  would write back something Zed rejects: `enabled` and `remote` are bools
 *  (project.rs `ContextServerSettingsContent`), `timeout` a non-negative
 *  number of seconds that falls back to the global `context_server_timeout`.
 *  A stored `source` is deliberately NOT carried -- current Zed migrates that
 *  key away from the user file, so carrying it would put it straight back. */
function carryZedFields(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof stored.enabled === "boolean") out.enabled = stored.enabled;
  if (typeof stored.remote === "boolean") out.remote = stored.remote;
  if (typeof stored.timeout === "number" && Number.isFinite(stored.timeout) && stored.timeout >= 0) {
    out.timeout = stored.timeout;
  }
  return out;
}

export const ZED_TARGET = defineTarget({
  clientId: "zed",
  label: "Zed",
  config: { format: "jsonc", root: "context_servers" },
  availableOn: ["macos", "linux", "windows"],
  // Zed's `watch_config_file` restarts, starts or stops servers when
  // settings.json is saved, so the Done line must not tell the user to
  // restart the editor.
  reload: "live",
  entry: {
    carry: carryZedFields,
  },
  notes:
    "Zed reads context_servers from settings.json, which allows // comments and trailing commas, and starts, restarts or stops servers when the file is saved -- no restart needed. On Linux the path follows $XDG_CONFIG_HOME when it is set; the Flatpak build reads $FLATPAK_XDG_CONFIG_HOME/zed/settings.json instead, which install does not follow. Zed ignores a project's .zed/settings.json until you trust the project. Needs Zed v0.214.5 (2025-11-26) or newer: earlier versions reject this entry shape.",
  resolvePath: resolveZedPath,
  scopes: [
    // User FIRST, like every other multi-scope row: the probe walks this array
    // in order and it decides `--list` and doctor row order.
    {
      scope: "user",
      label: "User (global)",
      description: "Private to this machine; applies to every Zed project.",
      requiresProjectDir: false,
    },
    {
      scope: "project",
      label: "Project",
      description: "Commit to share with your team; Zed applies it once the project is trusted.",
      requiresProjectDir: true,
    },
  ],
});
