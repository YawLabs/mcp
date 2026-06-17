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
// Never blocks serving: the registry fetch has a short timeout, the
// npm spawn's stdio is ignored (no parent I/O contention) and stays a
// child of this process so it dies with yaw-mcp, and the whole thing is
// fire-and-forget. A failure is a no-op -- worst case the user runs
// the current version for one more session.
//
// Opt-out: set YAW_MCP_AUTO_UPGRADE=0 (or =false) to suppress the check
// entirely -- useful for pinned-version setups or sudo-installed
// globals where `npm install -g` would always EACCES.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { log } from "./logger.js";
import { buildUpgradePlan, detectInstallMethod, detectSea } from "./upgrade-cmd.js";

declare const __VERSION__: string;

/** Resolve the global install prefix of the CURRENTLY running yaw-mcp by
 *  walking up from `process.argv[1]` (realpath-resolved so a symlinked
 *  shim like `/usr/local/bin/yaw-mcp -> /opt/node/lib/node_modules/@yawlabs/mcp/...`
 *  points at the real install root) until we find a `node_modules/.bin`
 *  ancestor. The directory whose immediate child is `node_modules/.bin`
 *  is the npm prefix that owns this install.
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
  // Walk up until we find a `<prefix>/node_modules/.bin` shape OR we
  // hit the filesystem root. Cap the climb at 24 segments to guard
  // against pathological symlink loops.
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

/** Run `npm prefix -g` and emit a stderr warning when the configured
 *  global prefix differs from the detected running-install prefix.
 *  Best-effort -- a spawn failure or non-zero exit just silently skips
 *  the warning. Never blocks the caller; intentionally fire-and-forget. */
async function compareWithNpmPrefix(detected: string): Promise<void> {
  await new Promise<void>((res) => {
    const child = spawn("npm", ["prefix", "-g"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("close", () => {
      const npmPrefix = out.trim();
      if (npmPrefix && npmPrefix !== detected) {
        process.stderr.write(
          `yaw-mcp self-upgrade: detected running prefix differs from \`npm prefix -g\`:\n` +
            `  running:  ${detected}\n` +
            `  npm -g:   ${npmPrefix}\n` +
            `  Installing into the running prefix so the upgrade lands in the same tree the client spawned from.\n`,
        );
      }
      res();
    });
    child.on("error", () => res());
  });
}

// Kept local (a ~15-line fetch) rather than imported, matching the
// existing pattern in upgrade-cmd.ts / doctor-cmd.ts -- each module
// owns its tiny registry probe so startup import graphs stay shallow.
async function fetchLatestVersion(): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch("https://registry.npmjs.org/@yawlabs/mcp/latest", {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    // Stay a child of this process (not detached) so it dies with yaw-mcp
    // if yaw-mcp exits mid-install -- a half-finished install is fine
    // (npm/pnpm/bun are atomic per package) and a re-run next startup completes it.
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
  const runningPrefix = method === "global-npm" ? detectRunningInstallPrefix(deps.argvPath ?? process.argv[1]) : null;
  const globalSpec =
    method === "global-npm"
      ? {
          cmd: "npm",
          args: runningPrefix
            ? ["install", "-g", "--prefix", runningPrefix, "@yawlabs/mcp@latest"]
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
      prefix: runningPrefix ?? undefined,
    });
    // If we have a detected prefix AND can cheaply discover npm's
    // configured global prefix, warn when they differ -- the user
    // likely has a multi-prefix setup and may be confused why one
    // copy updates while another stays stale. Best-effort, async,
    // never blocks the upgrade itself.
    if (method === "global-npm" && runningPrefix) {
      void compareWithNpmPrefix(runningPrefix);
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
    // A standalone binary has no package manager to self-upgrade -- the user
    // replaces the executable. Nothing safe to spawn; log it and move on.
    log("info", "yaw-mcp (standalone binary) is behind npm; download the latest build to update", { current, latest });
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
  } else {
    // local-node-modules / unknown: a restart re-runs the SAME stale install
    // (a custom-prefix global or a pinned local node_modules), so it won't
    // pick up the new version. Point the user at the manual recovery path.
    log(
      "info",
      "yaw-mcp is out of date; run `yaw-mcp upgrade --run` to update this install (a restart won't refresh a stale global)",
      {
        current,
        latest,
        method,
      },
    );
  }
}
