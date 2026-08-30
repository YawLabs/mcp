// Fire-and-forget self-upgrade check, run once per yaw-mcp serve startup.
//
// yaw-mcp cannot hot-swap its own running code, so "auto-update" means:
// detect a stale install and upgrade it in the background so the NEXT
// spawn (the next time the MCP client restarts) runs the new version.
//
// Global install methods are acted on with their owning tool -- `npm
// install -g` / `pnpm add -g` / `bun add -g @yawlabs/mcp@latest` are
// whitelisted, non-destructive commands.
//   - npx installs self-heal already: `yaw-mcp install` now writes
//     `@yawlabs/mcp@latest`, so `npx` re-resolves the newest version on
//     every spawn. A stale npx cache without `@latest` in the client
//     config is a config problem this process can't safely fix from
//     inside serve, so it is logged, not acted on.
//   - local-node-modules / dev-checkout: the user owns that tree; we
//     never run package installs against it.
//   - bundled-app (inside Yaw Terminal): only an app update can refresh
//     it; logged, never touched.
//
// Never blocks serving: the registry fetch has a short timeout, the npm
// spawn's stdio is ignored (no parent I/O contention), and the whole
// thing is fire-and-forget. A failure is a no-op -- worst case the user
// runs the current version for one more session.
//
// KNOWN GAPS in the background install (documented rather than papered
// over -- see defaultSpawn):
//   - Nothing serializes concurrent runs. Two MCP clients starting at
//     once fire two `npm install -g` into the same prefix; npm's own
//     cache lock makes that slow rather than corrupting, but it is not
//     safe by construction. A lockfile in the prefix is the real fix.
//   - The child is NOT detached, which on POSIX does not mean it dies
//     with yaw-mcp -- it only dies when the client kills the whole
//     process group/tree (which MCP clients commonly do). If it IS
//     killed mid-install, the install is not guaranteed to be intact:
//     npm's reify removes the existing package dir before moving the new
//     one in and writes bin shims separately, so the window leaves a
//     partial install. There is no repair logic; recovery is a manual
//     `npm install -g @yawlabs/mcp@latest`.
//
// Opt-out: set YAW_MCP_AUTO_UPGRADE=0 (or =false) to suppress the check
// entirely -- useful for pinned-version setups or sudo-installed
// globals where `npm install -g` would always EACCES.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { log } from "./logger.js";
import {
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  npmGlobalPrefix,
} from "./upgrade-cmd.js";

declare const __VERSION__: string;

/** Quote a single argv entry for the shell the npm spawn actually uses.
 *
 *  Only win32 spawns with `shell: true`, so only win32 needs quoting; on
 *  POSIX the arg is passed through execve untouched and quoting it would
 *  put literal quotes INTO the path. Returns null when the value cannot be
 *  safely quoted, so the caller drops `--prefix` entirely rather than
 *  emitting a mangled command line -- npm's own prefix resolution is a
 *  worse-but-safe fallback, and a broken `--prefix` is not.
 *
 *  Narrower sibling of quoteForShell in compliance-cmd.ts; kept local so a
 *  background upgrade path does not depend on a CLI command module. */
export function quoteShellArgIfNeeded(arg: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return arg;
  // A newline or NUL terminates the command line regardless of quoting, and
  // cmd.exe expands %VAR% and breaks on a literal " even inside quotes.
  if (/[\r\n\0"%]/.test(arg)) return null;
  if (!/[\s&|<>^]/.test(arg)) return arg; // nothing the shell would act on
  return `"${arg}"`;
}

/** Quote a single argv entry for DISPLAY in a printed command line.
 *
 *  quoteShellArgIfNeeded above quotes for the shell the spawn actually uses,
 *  which on POSIX is no shell at all -- so the SPAWN argv must stay raw
 *  there. But a printed suggestion gets pasted into an interactive shell,
 *  which splits on whitespace: a prefix like `/Users/j/My Tools` printed raw
 *  makes npm read `/Users/j/My` as the prefix and install a package named
 *  `Tools`. The display form therefore quotes independently of the spawn
 *  argv: on win32 it reuses quoteShellArgIfNeeded so the printed line stays
 *  byte-identical to what the shell:true spawn joins; on POSIX it
 *  single-quotes anything outside the shell-inert character set (with the
 *  standard '\'' escape for embedded single quotes). Returns null exactly
 *  when quoteShellArgIfNeeded does (win32 unquotable) -- POSIX display
 *  quoting always succeeds. */
export function quoteArgForDisplay(arg: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return quoteShellArgIfNeeded(arg, platform);
  // Allowlist of characters no POSIX shell acts on; anything else (spaces,
  // `$`, backticks, globs, ...) gets the arg single-quoted. Quoting a tad
  // too eagerly is harmless; under-quoting silently splits the paste.
  if (/^[A-Za-z0-9_\-./+,:@=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Resolve the global install prefix of the CURRENTLY running yaw-mcp by
 *  walking up from `process.argv[1]` (realpath-resolved so a symlinked shim
 *  like `/usr/local/bin/yaw-mcp -> /opt/node/lib/node_modules/@yawlabs/mcp/...`
 *  points at the real install root) until a path segment `node_modules` is
 *  found. The directory ABOVE that `node_modules` is the prefix that owns this
 *  install -- minus a trailing `lib`, which POSIX globals insert
 *  (`<prefix>/lib/node_modules/...`) and `npm prefix -g` does not report. No
 *  `.bin` directory is involved: the walk matches the bare `node_modules`
 *  segment and never reads the filesystem beyond the initial realpath.
 *
 *  We need this because `npm prefix -g` reports the user's *configured*
 *  global prefix -- which can differ from the prefix the running install
 *  actually lives under (custom prefixes, multiple Node versions, nvm,
 *  Yaw Terminal's bundled Node). Installing into the configured global
 *  prefix while the running install is rooted elsewhere produces a
 *  silent no-op upgrade: a second copy is updated but the spawned-from-
 *  client one stays stale. */
export function detectRunningInstallPrefix(argvPath: string | undefined): string | null {
  if (!argvPath) return null;
  let resolved: string;
  try {
    resolved = realpathSync(argvPath);
  } catch {
    return null;
  }
  let dir = dirname(resolved);
  // Walk up until a `node_modules` segment appears OR we hit the filesystem
  // root (`dir !== prev` terminates there -- dirname() is monotonic and
  // symlinks are already resolved, so the loop cannot cycle). The 24-segment
  // cap is a belt-and-braces bound, not a loop guard; its observable effect is
  // that an install nested deeper than 24 segments returns null and gets no
  // `--prefix` (pinned by the safety-cap test in tests/auto-upgrade.test.ts).
  let prev = "";
  let safety = 24;
  while (dir !== prev && safety-- > 0) {
    // Two recognized shapes:
    //   1. <prefix>/node_modules/<pkg>/...    -> prefix is the dir above node_modules
    //   2. <prefix>/lib/node_modules/<pkg>/.. -> common on Linux global installs
    const idx = dir.lastIndexOf(`${sep}node_modules${sep}`);
    if (idx !== -1) {
      const candidate = dir.slice(0, idx);
      // Linux-style global: strip a trailing `/lib` if present so the
      // prefix is the bin/lib parent (matches `npm prefix -g` output).
      if (candidate.endsWith(`${sep}lib`)) return candidate.slice(0, -`${sep}lib`.length);
      return candidate;
    }
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}

/** Normalize a prefix for comparison. Windows paths are case-insensitive, so
 *  `C:\Users\Jeff\AppData\Roaming\npm` and the lowercased form npm may report
 *  are the SAME prefix and must not produce a "your prefixes differ" warning. */
function comparablePrefix(p: string): string {
  const trimmed = p.trim();
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Emit a stderr warning when npm's configured global prefix differs from the
 *  detected running-install prefix. `detected` must be the RAW (unquoted)
 *  prefix -- comparing the shell-quoted form against npm's unquoted answer
 *  never matches, so every startup on a Windows account with a space in the
 *  username (npm's DEFAULT global prefix path) warned about a multi-prefix
 *  setup the user does not have.
 *
 *  The probe itself is upgrade-cmd's npmGlobalPrefix: shared so there is one
 *  timeout, one kill and one VITEST short-circuit instead of two divergent
 *  copies. Best-effort -- a spawn failure, non-zero exit or timeout resolves
 *  null and silently skips the warning. Never blocks the caller. */
async function compareWithNpmPrefix(
  detected: string,
  probe: () => Promise<string | null> = npmGlobalPrefix,
): Promise<void> {
  const npmPrefix = await probe();
  // Null is the probe's own "couldn't answer"; blank output is the same thing
  // said differently, and comparing a path against "" would always "differ".
  if (!npmPrefix?.trim()) return;
  if (comparablePrefix(npmPrefix) === comparablePrefix(detected)) return;
  process.stderr.write(
    `yaw-mcp self-upgrade: detected running prefix differs from \`npm prefix -g\`:\n` +
      `  running:  ${detected}\n` +
      `  npm -g:   ${npmPrefix}\n` +
      `  Installing into the running prefix so the upgrade lands in the same tree the client spawned from.\n`,
  );
}

export interface AutoUpgradeDeps {
  /** Test hook: override the current version (defaults to __VERSION__). */
  currentVersion?: string;
  /** Test hook: override the argv path used for install-method detection. */
  argvPath?: string;
  /** Test hook: replace the npm registry fetch. */
  fetchLatestImpl?: () => Promise<string | null>;
  /** Test hook: replace the background npm spawn. */
  spawnImpl?: (cmd: string, args: string[]) => void;
  /** Test hook: replace the `npm prefix -g` probe behind the multi-prefix
   *  warning. Needed in tests because the shared probe short-circuits to null
   *  under VITEST so no unit test ever spawns a real npm. */
  npmPrefixImpl?: () => Promise<string | null>;
  /** Test hook: force single-executable (SEA binary) detection. */
  isSeaImpl?: () => boolean | Promise<boolean>;
}

function defaultSpawn(cmd: string, args: string[]): void {
  // Track whether the error handler already fired so the close handler
  // stays silent after it -- both handlers fire for ENOENT, but the
  // error handler has the right message and fires first.
  let errorFired = false;

  // Build the corrective command the user should run for their tool.
  // Only npm gets the EACCES/sudo hint -- pnpm and bun manage their own
  // permissions and the sudo suggestion doesn't apply to them.
  const correctiveCmd =
    cmd === "npm"
      ? "npm install -g @yawlabs/mcp@latest"
      : cmd === "pnpm"
        ? "pnpm add -g @yawlabs/mcp@latest"
        : "bun add -g @yawlabs/mcp@latest";

  const child = spawn(cmd, args, {
    stdio: "ignore",
    // Not detached, so the install shares yaw-mcp's process group and an MCP
    // client that tears down the whole tree takes it with it. Two things this
    // does NOT buy (the file header lists both as known gaps): on POSIX a
    // plain parent exit does not kill it, and if it IS killed mid-install the
    // result is not guaranteed intact -- npm reify removes the existing
    // package dir before moving the new one in, and nothing here repairs a
    // partial install on the next startup.
    detached: false,
    shell: process.platform === "win32",
  });
  child.on("close", (code) => {
    if (errorFired) return; // error handler already logged; stay silent here.
    if (code === 0) {
      log("info", "yaw-mcp self-upgrade complete; the next client restart will run the new version");
    } else {
      // stdio is "ignore" so we can't surface the underlying tool error.
      // The common cause for npm is a non-user-writable global prefix
      // (yaw-mcp was installed with sudo); pnpm/bun have analogous issues.
      const hint = cmd === "npm" ? " (often EACCES on a sudo-installed global -- run with the right permissions)" : "";
      log(
        "warn",
        `yaw-mcp self-upgrade: ${cmd} exited non-zero${hint}. Run \`${correctiveCmd}\` manually, or set YAW_MCP_AUTO_UPGRADE=0 to silence this.`,
        { code },
      );
    }
  });
  child.on("error", (err: Error) => {
    errorFired = true;
    log("warn", `yaw-mcp self-upgrade: ${cmd} spawn failed`, { error: err?.message });
  });
}

/** Fire-and-forget startup self-upgrade check. Resolves once the check
 *  completes; callers must NOT await it on the serve hot path. */
export async function maybeAutoUpgrade(deps: AutoUpgradeDeps = {}): Promise<void> {
  // Opt-out escape hatch -- checked before everything else so pinned-
  // version users / sudo-installed globals can suppress with one env var.
  const optOut = process.env.YAW_MCP_AUTO_UPGRADE;
  if (optOut === "0" || optOut?.toLowerCase() === "false") return;

  const current = deps.currentVersion ?? (typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev");
  // An unbuilt checkout has no real version to compare; never touch it.
  if (current === "dev") return;

  // NOTE: maybeAutoUpgrade deliberately uses detectInstallMethod (the
  // fast, synchronous path-pattern heuristic) rather than the async
  // refineInstallMethod (which runs `npm prefix -g` -- a ~3s npm
  // subprocess -- to distinguish a real global-npm install from a local
  // node_modules install that happens to share a path prefix). The serve
  // hot path must not block on a 3s probe at startup. Consequence: a
  // custom-prefix global install whose argv[1] pattern doesn't match
  // the default npm prefix heuristic is classified as "local-node-modules"
  // (or "unknown") and silently skipped -- no background upgrade fires for
  // it even when stale. Users in that setup should run `yaw-mcp upgrade
  // --run` manually, or set the standard npm global prefix.
  const method = (deps.isSeaImpl ? await deps.isSeaImpl() : await detectSea())
    ? "binary"
    : detectInstallMethod(deps.argvPath ?? process.argv[1]);

  const latest = await (deps.fetchLatestImpl ?? fetchLatestVersion)();
  // Offline / registry unreachable / malformed response -- no-op.
  if (latest === null) return;

  const plan = buildUpgradePlan({ current, latest, method });
  if (!plan.stale) return;

  // Global installs self-upgrade with their OWNING tool -- same whitelist
  // as `upgrade --run` (exactly our package, fixed args).
  //
  // For npm specifically, we resolve the prefix from the RUNNING install
  // (argv[1] -> walk up to node_modules parent) and pass it explicitly
  // via `--prefix <dir>` so the upgrade lands in the same tree the
  // client just spawned us from -- not whatever `npm prefix -g` reports.
  // The two can drift (nvm, multiple Node versions, custom prefixes, the
  // bundled-Node Yaw Terminal ships), in which case installing into
  // npm's reported prefix is a no-op for the running copy.
  const rawPrefix = method === "global-npm" ? detectRunningInstallPrefix(deps.argvPath ?? process.argv[1]) : null;
  // The npm spawn below runs with `shell: true` on win32 (npm is npm.cmd and
  // Node refuses to spawn a .cmd without a shell). With a shell, argv is
  // joined on spaces and NOT quoted -- so an unquoted prefix containing a
  // space was split into two tokens:
  //   passed:   C:\Users\Jeff Smith\AppData\Roaming\npm
  //   npm saw:  --prefix C:\Users\Jeff   +   a stray positional
  // npm then installs into the wrong tree, leaving the running copy stale --
  // exactly the silent no-op `--prefix` exists to prevent. This is not exotic:
  // C:\Users\<First Last>\AppData\Roaming\npm is npm's DEFAULT Windows global
  // prefix, so any account with a space in its name hit it on every stale
  // startup. Quote for the shell we actually invoke.
  const quotedPrefix = rawPrefix === null ? null : quoteShellArgIfNeeded(rawPrefix);
  const globalSpec =
    method === "global-npm"
      ? {
          cmd: "npm",
          args: quotedPrefix
            ? ["install", "-g", "--prefix", quotedPrefix, "@yawlabs/mcp@latest"]
            : ["install", "-g", "@yawlabs/mcp@latest"],
        }
      : method === "pnpm-global"
        ? { cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"] }
        : method === "bun-global"
          ? { cmd: "bun", args: ["add", "-g", "@yawlabs/mcp@latest"] }
          : null;
  if (globalSpec) {
    log("info", "yaw-mcp is out of date; upgrading the global install in the background", {
      current,
      latest,
      tool: globalSpec.cmd,
      // The RAW prefix, not the shell-quoted argv form -- a log field is read
      // by a human, and stray quotes read as part of the path. Omitted when
      // quoting failed, because then no `--prefix` was passed at all and npm
      // resolves its own prefix.
      prefix: quotedPrefix === null ? undefined : (rawPrefix ?? undefined),
    });
    // If we have a detected prefix AND can cheaply discover npm's
    // configured global prefix, warn when they differ -- the user
    // likely has a multi-prefix setup and may be confused why one
    // copy updates while another stays stale. Best-effort, async,
    // never blocks the upgrade itself. Gated on quotedPrefix because the
    // warning claims we install into the running prefix, which is only true
    // when the `--prefix` flag actually survived quoting.
    if (method === "global-npm" && rawPrefix !== null && quotedPrefix !== null) {
      void compareWithNpmPrefix(rawPrefix, deps.npmPrefixImpl);
    }
    (deps.spawnImpl ?? defaultSpawn)(globalSpec.cmd, globalSpec.args);
    return;
  }

  if (method === "bundled-app") {
    // The copy Yaw Terminal ships in its resources -- only an app update
    // can refresh it, so there is nothing to spawn and nothing to ask of
    // the user beyond keeping the app current.
    log("info", "yaw-mcp (bundled with Yaw Terminal) is behind npm; it updates with the app", { current, latest });
    return;
  }

  if (method === "binary") {
    // A standalone binary has no package manager to self-upgrade -- and the
    // binary track was retired in 0.70.3, so the only way forward is the
    // npm install. Nothing safe to spawn; log it and move on.
    log(
      "info",
      "yaw-mcp (standalone binary) is behind npm; the binary track was retired -- npm install -g @yawlabs/mcp@latest, then delete the old executable",
      { current, latest },
    );
    return;
  }

  // npx / local-node-modules / dev-checkout / unknown: nothing safe to
  // spawn from here. Log a one-liner so a stale install is at least visible.
  if (method === "npx") {
    // For npx the `@latest` client config (written by `yaw-mcp install`)
    // makes the next restart fetch the newest version, so a restart fixes it.
    log("info", "yaw-mcp is out of date; restart your MCP client to pick up the latest version", {
      current,
      latest,
      method,
    });
  } else if (method === "local-node-modules") {
    // A restart re-runs the SAME version the project's node_modules pins, so
    // it won't pick up the new one. `upgrade --run` DOES work here: it runs
    // `npm install @yawlabs/mcp@latest` in the tree root (upgrade-cmd's
    // local-node-modules runSpec), so advertise it.
    log(
      "info",
      "yaw-mcp is out of date; run `yaw-mcp upgrade --run` to update this install (a restart re-runs the version pinned in your project's node_modules)",
      {
        current,
        latest,
        method,
      },
    );
  } else {
    // dev-checkout / unknown: a restart re-runs the same stale install, and
    // `upgrade --run` CANNOT fix it -- upgrade-cmd leaves runSpec null for both
    // methods and exits 2 with "can't be upgraded automatically" (the 1->2
    // scripting trap its header documents). Advertising `--run` here sent users
    // to a command that always refuses, so point at plain `upgrade`, which
    // prints the command for their install and exits 1.
    log(
      "info",
      "yaw-mcp is out of date; run `yaw-mcp upgrade` for the command that updates this install (`--run` can't automate this install method)",
      {
        current,
        latest,
        method,
      },
    );
  }
}
