// `yaw-mcp upgrade` — installs (or tells the user how to install) the
// newest version of `@yawlabs/mcp`. Detects the invocation mode from
// process.argv[1] so the action matches how yaw-mcp is actually
// reaching this process:
//   - global npm (`npm install -g @yawlabs/mcp`)  → `npm install -g @yawlabs/mcp@latest`
//   - local node_modules                           → `npm install @yawlabs/mcp@latest` in that tree's root
//   - npx cache                                    → restart the MCP client; `npx -y` always pulls the latest
//   - bundled inside Yaw Terminal (asar.unpacked)  → nothing to run; it updates with the app
//   - unknown / dev checkout                       → print the command and let the user decide
//
// The --run flag spawns the command for the global-npm and
// local-node-modules cases; for "npx" there is nothing to do and --run
// just prints the "restart your client" hint. Never spawns destructive
// commands — only `npm install [-g] <exactly-our-package>@latest` is
// allowed, and stdout/stderr stream through to the caller unchanged.
//
// Exit codes:
//   0  already on the latest version, OR there is nothing to run (npx /
//      bundled-app)
//   1  upgrade available but --run was not passed (human-interactive mode)
//   2  usage error (unknown flag), OR --run on an install method that
//      can't be auto-upgraded (dev-checkout / unknown)
//   3  --run attempted the upgrade and the child process failed
//
// `yaw-mcp doctor` shows the same staleness status — upgrade is purely
// the "what do I type to fix it" surface. Kept separate so scripts
// that already run doctor can chain into `yaw-mcp upgrade --run` and
// have the shell do the right thing deterministically.

import { spawn } from "node:child_process";

declare const __VERSION__: string;

export interface UpgradeCommandOptions {
  /** When true, actually spawn the upgrade command (only for global-npm mode). */
  run?: boolean;
  /** Emit a machine-readable JSON snapshot instead of prose. */
  json?: boolean;
  /** Test hook: replace the npm registry fetch. */
  fetchLatest?: () => Promise<string | null>;
  /** Test hook: override the argv path detection. */
  argvPath?: string;
  /** Test hook: override the current version. */
  currentVersion?: string;
  /** Test hook: override stdout. */
  out?: (s: string) => void;
  /** Test hook: override stderr. */
  err?: (s: string) => void;
  /** Test hook: override the spawn invocation (returns exit code). */
  spawnImpl?: (cmd: string, args: string[], cwd?: string) => Promise<number>;
}

export interface UpgradeCommandResult {
  exitCode: number;
  lines: string[];
}

export type InstallMethod = "global-npm" | "npx" | "local-node-modules" | "bundled-app" | "dev-checkout" | "unknown";

export interface UpgradePlan {
  current: string;
  latest: string | null;
  stale: boolean;
  method: InstallMethod;
  /** Command to run to move to the latest version. Null when method=npx (nothing to do). */
  command: string | null;
}

export const UPGRADE_USAGE = `Usage: yaw-mcp upgrade [--run] [--json]

  Show (or execute) the command to upgrade @yawlabs/mcp to the latest version.

  --run     Run the upgrade in place (global and local npm installs).
            No-op for npx installs — they always fetch the latest.
  --json    Emit a machine-readable snapshot ({ current, latest, stale,
            method, command }) instead of prose.`;

export function parseUpgradeArgs(
  argv: string[],
): { ok: true; options: UpgradeCommandOptions } | { ok: false; error: string } {
  const opts: UpgradeCommandOptions = {};
  for (const a of argv) {
    if (a === "--run") opts.run = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: UPGRADE_USAGE };
    else return { ok: false, error: `yaw-mcp upgrade: unknown argument "${a}"\n\n${UPGRADE_USAGE}` };
  }
  return { ok: true, options: opts };
}

/** Classify how yaw-mcp is being invoked. The argv[1] path is the most
 *  reliable signal — npm/npx land it in distinct directories. Falls
 *  through to `unknown` rather than guessing, which lets --json
 *  consumers branch without false positives.  */
export function detectInstallMethod(argvPath: string | undefined): InstallMethod {
  if (!argvPath) return "unknown";
  const normalized = argvPath.replace(/\\/g, "/");
  // `npx -y @yawlabs/mcp` stages packages under ~/.npm/_npx/ (or
  // platform equivalent with a hash dir). On Windows the cache is
  // under npm-cache/_npx/... — same marker works.
  if (/\/_npx\//.test(normalized)) return "npx";
  // The copy Yaw Terminal ships inside its Electron resources
  // (resources/app.asar.unpacked/node_modules/@yawlabs/mcp). It LOOKS
  // like local-node-modules, but running `npm install` against the
  // app's resources dir would corrupt the install — this copy only
  // updates when the app itself updates. Must be checked BEFORE the
  // generic node_modules marker below.
  if (/\/app\.asar\.unpacked\//.test(normalized)) return "bundled-app";
  // npm i -g writes to the global prefix. Can be detected by
  // "npm/node_modules/@yawlabs/mcp" or "/usr/local/lib/node_modules"
  // style paths, or the npm global prefix (varies). Most dependable
  // signal: the path lives under a `node_modules` that is NOT inside
  // the current project's node_modules. Since we can't reliably tell
  // global vs local from argv alone, use the npm prefix marker on
  // common platforms and a `\\npm\\node_modules\\` Windows marker.
  if (/\/npm\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  if (/\/lib\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  if (/\/AppData\/Roaming\/npm\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  if (/\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "local-node-modules";
  // `npm run dev` or direct `node ./dist/index.js` from a checkout --
  // not installed at all. Match either yaw-mcp (renamed dir) or mcph
  // (legacy on-disk dir name, repo at github.com/YawLabs/mcp (renamed from /mcph 2026-05-25)).
  if (/\/(yaw-mcp|mcph)\/(dist|src)\//.test(normalized)) return "dev-checkout";
  return "unknown";
}

/** For a local-node-modules install, the directory `npm install` must run
 *  in: the package-tree root, i.e. everything before the FIRST
 *  `/node_modules/` segment of the entrypoint path. Null when the path
 *  doesn't contain a node_modules segment. */
export function localInstallRoot(argvPath: string | undefined): string | null {
  if (!argvPath) return null;
  // Separator normalization preserves length, so an index found in the
  // normalized string addresses the same spot in the original — slicing
  // the original keeps Windows drive letters and backslashes intact.
  const idx = argvPath.replace(/\\/g, "/").indexOf("/node_modules/");
  return idx > 0 ? argvPath.slice(0, idx) : null;
}

/** Assemble the upgrade plan from method + version info. Single source
 *  of truth for both the prose and --json paths. */
export function buildUpgradePlan(input: {
  current: string;
  latest: string | null;
  method: InstallMethod;
}): UpgradePlan {
  const { current, latest, method } = input;
  const stale = latest !== null && current !== "dev" && compareSemverLocal(current, latest) < 0;

  let command: string | null;
  switch (method) {
    case "global-npm":
      command = "npm install -g @yawlabs/mcp@latest";
      break;
    case "npx":
      command = null; // npx -y refreshes on its own; nothing to run.
      break;
    case "bundled-app":
      command = null; // ships inside Yaw Terminal; updates with the app.
      break;
    case "local-node-modules":
      command = "npm install @yawlabs/mcp@latest";
      break;
    case "dev-checkout":
      command = "git pull && npm run build";
      break;
    default:
      command = "npm install -g @yawlabs/mcp@latest";
      break;
  }
  return { current, latest, stale, method, command };
}

/** Copy of compareSemver kept local so upgrade-cmd doesn't drag
 *  doctor-cmd into its import graph (keeps the CLI startup fast). */
function compareSemverLocal(a: string, b: string): number {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

async function defaultFetchLatest(): Promise<string | null> {
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

async function defaultSpawn(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", cwd });
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
}

export async function runUpgrade(opts: UpgradeCommandOptions = {}): Promise<UpgradeCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const fetcher = opts.fetchLatest ?? defaultFetchLatest;
  const current = opts.currentVersion ?? readCurrentVersion();
  const argvPath = opts.argvPath ?? process.argv[1];
  const method = detectInstallMethod(argvPath);

  let latest: string | null;
  try {
    latest = await fetcher();
  } catch {
    latest = null;
  }

  const plan = buildUpgradePlan({ current, latest, method });

  if (opts.json) {
    print(JSON.stringify(plan, null, 2));
    return { exitCode: plan.stale && !opts.run ? 1 : 0, lines };
  }

  // Offline or registry unreachable — still useful to print the method +
  // suggested command so the user can run it when they're back online.
  if (latest === null) {
    print("yaw-mcp upgrade: couldn't reach the npm registry (offline? firewall?).");
    if (plan.command) {
      print("When you're back online, run:");
      print("");
      print(`  ${plan.command}`);
    } else if (method === "bundled-app") {
      print("This copy of yaw-mcp ships inside Yaw Terminal and updates with the app — nothing to run.");
    } else {
      print("Your install uses `npx -y` — just restart the MCP client when you're back online.");
    }
    return { exitCode: 0, lines };
  }

  print(`Current: ${current}`);
  print(`Latest:  ${latest}`);
  print(`Install: ${method}`);

  if (!plan.stale) {
    print("");
    print("✓ You're on the latest version — nothing to do.");
    return { exitCode: 0, lines };
  }

  print("");
  if (method === "npx") {
    print("Your install uses `npx -y` — restart the MCP client and it will fetch the new version.");
    return { exitCode: 0, lines };
  }

  if (method === "bundled-app") {
    print("This copy of yaw-mcp ships inside Yaw Terminal and updates with the app —");
    print("there is nothing to run here. Update Yaw Terminal to get the new version.");
    return { exitCode: 0, lines };
  }

  if (!plan.command) {
    print("No upgrade command available for this install method.");
    return { exitCode: 0, lines };
  }

  // global-npm and local-node-modules are auto-runnable (whitelisted npm
  // install of exactly our package). dev-checkout stays manual — the user
  // owns that tree and the right command depends on their setup. unknown
  // stays manual because we don't know which install we'd be mutating.
  const installRoot = method === "local-node-modules" ? localInstallRoot(argvPath) : null;
  const autoRunnable = method === "global-npm" || (method === "local-node-modules" && installRoot !== null);

  if (!opts.run) {
    if (autoRunnable) {
      print("Run `yaw-mcp upgrade --run` to upgrade in place, or run it yourself:");
    } else {
      print("Run it yourself (--run can't safely automate this install method):");
    }
    print("");
    print(`  ${plan.command}`);
    return { exitCode: 1, lines };
  }

  // --run: attempt the upgrade. Only whitelisted commands — never
  // pass arbitrary user input into a shell.
  if (!autoRunnable) {
    printErr(`yaw-mcp upgrade --run: a "${method}" install can't be upgraded automatically. Run it yourself:`);
    printErr("");
    printErr(`  ${plan.command}`);
    return { exitCode: 2, lines };
  }

  const runner = opts.spawnImpl ?? defaultSpawn;
  const npmArgs =
    method === "global-npm" ? ["install", "-g", "@yawlabs/mcp@latest"] : ["install", "@yawlabs/mcp@latest"];
  if (installRoot) {
    print(`Running in ${installRoot}:`);
  } else {
    print("Running:");
  }
  print(`  ${plan.command}`);
  print("");
  const code = await runner("npm", npmArgs, installRoot ?? undefined);
  if (code === 0) {
    print("");
    print(`✓ Upgraded @yawlabs/mcp to ${latest}`);
    return { exitCode: 0, lines };
  }
  printErr(`yaw-mcp upgrade: npm exited ${code}. Try running the command yourself:`);
  printErr("");
  printErr(`  ${plan.command}`);
  return { exitCode: 3, lines };
}

/** Read the version tsup inlines at build time; falls back to "dev"
 *  for unbuilt runs. tsup substitutes the bare `__VERSION__`
 *  identifier; a property access (e.g. `globalThis.__VERSION__`)
 *  isn't replaced, which left the shipped bundle reporting "dev". */
function readCurrentVersion(): string {
  return typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
}
