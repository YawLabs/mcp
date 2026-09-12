// The Continue row, as DATA.
//
// Imports the LEAF model only -- see the header of target-zed.ts for why.
//
// Continue is the one target whose file yaw-mcp OWNS: every other client is
// handed a user config we splice one entry into, while Continue's IDE
// extensions load each JSON file in an `mcpServers/` folder, so install
// creates `mcpServers/yaw-mcp.json` and nothing else is ever in it. That is
// what `ownership: "dedicated"` records, and the only thing it changes today
// is wording -- an uninstall from a shared file says the file stays.

import { isAbsolute, join, resolve } from "node:path";
import { defineTarget, type PathBase, type ResolvedPath } from "./install-target-model.js";

/** The file name inside `mcpServers/`. Named for the tool, not for
 *  ENTRY_NAME: the entry KEY inside it is `mcp` like every other client's, but
 *  the file is one of several in a folder and has to say whose it is. */
const CONTINUE_FILE = "yaw-mcp.json";

/** Continue's global dir. `CONTINUE_GLOBAL_DIR` is resolved against the
 *  process cwd when relative -- Continue's own IDE-core rule, and the reason
 *  `readClientEnv` reports the value verbatim instead of applying one policy
 *  for every client (Zed's variable is ignored when relative; this one is
 *  not). A relative value is inherently a guess, because the IDE resolves it
 *  against ITS process cwd, not ours. */
function continueGlobalDir(base: PathBase): { dir: string; display: string } {
  const raw = base.env.continueGlobalDir;
  if (raw && raw.length > 0) {
    const dir = isAbsolute(raw) ? raw : resolve(raw);
    // Shown verbatim, the CLAUDE_CONFIG_DIR precedent: a `~` spelling would
    // hide the redirect that put the file somewhere else.
    return { dir, display: dir };
  }
  return {
    dir: join(base.home, ".continue"),
    display: base.os === "windows" ? "%USERPROFILE%\\.continue" : "~/.continue",
  };
}

function resolveContinuePath(base: PathBase): ResolvedPath {
  const sep = base.os === "windows" ? "\\" : "/";
  if (base.scope === "project") {
    return {
      absolute: join(base.projectDir, ".continue", "mcpServers", CONTINUE_FILE),
      display: ["<project folder>", ".continue", "mcpServers", CONTINUE_FILE].join(sep),
      containerPath: ["mcpServers"],
    };
  }
  const global = continueGlobalDir(base);
  const absolute = join(global.dir, "mcpServers", CONTINUE_FILE);
  // An env-directed dir is already absolute and is shown as-is; the default
  // keeps the `~` / `%USERPROFILE%` spelling the other rows use.
  const display = global.display === global.dir ? absolute : [global.display, "mcpServers", CONTINUE_FILE].join(sep);
  return { absolute, display, containerPath: ["mcpServers"] };
}

export const CONTINUE_TARGET = defineTarget({
  clientId: "continue",
  label: "Continue",
  // DEDICATED: this file is created by install and holds nothing else, unlike
  // every other row's shared user config.
  config: { format: "jsonc", root: "mcpServers", ownership: "dedicated" },
  availableOn: ["macos", "linux", "windows"],
  // Continue's VS Code extension does not watch the mcpServers folder, so the
  // user has to reload the IDE window -- not restart the whole editor.
  reload: "reload-window",
  entry: {
    // Continue adds the cmd.exe wrapper itself, so the broker entry is a BARE
    // npx on Windows; pre-wrapping it breaks under a WSL remote, where
    // Continue deliberately does not wrap. A `try` upstream still takes the
    // shared wrap: that entry names a third-party launcher whose args have to
    // survive cmd's parse, which is what escapeCmdArg's depths are for.
    windowsLaunch: { broker: "bare", upstream: "cmd-wrap" },
  },
  notes:
    "Continue's IDE extensions load the JSON files in that mcpServers folder, whichever agent is selected -- its `cn` CLI does not read the folder. Reload the IDE window after installing or uninstalling (VS Code: Developer: Reload Window); Continue's VS Code extension does not watch that folder. On Windows the entry is bare npx, not cmd /c npx: Continue adds the cmd.exe wrapper itself.",
  resolvePath: resolveContinuePath,
  scopes: [
    {
      scope: "user",
      label: "User (global)",
      description: "Private to this machine; loaded whichever Continue agent is selected.",
      requiresProjectDir: false,
    },
    {
      scope: "project",
      label: "Project",
      description: "Commit to share with your team; loaded while this folder is open in the IDE.",
      requiresProjectDir: true,
    },
  ],
});
