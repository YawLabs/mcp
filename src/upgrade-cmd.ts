// `yaw-mcp upgrade` — installs (or tells the user how to install) the
// newest version of `@yawlabs/mcp`. Detects the invocation mode from
// process.argv[1] so the action matches how yaw-mcp is actually
// reaching this process:
//   - global npm (`npm install -g @yawlabs/mcp`)  → `npm install -g @yawlabs/mcp@latest`
//   - pnpm / bun global store                      → `pnpm add -g` / `bun add -g @yawlabs/mcp@latest`
//   - local node_modules                           → `npm install @yawlabs/mcp@latest` in that tree's root
//   - npx cache                                    → restart the MCP client; `npx -y` always pulls the latest
//   - bundled inside Yaw Terminal (asar.unpacked)  → nothing to run; it updates with the app
//   - standalone SEA binary                        → download the latest build; replace the executable
//   - unknown / dev checkout                       → print the command and let the user decide
//
// The --run flag spawns the owning tool for the global-npm, pnpm-global,
// bun-global, and local-node-modules cases; for "npx" there is nothing
// to do and --run just prints the "restart your client" hint. Never
// spawns destructive commands — only `npm install [-g]` / `pnpm add -g` /
// `bun add -g` of exactly our package is allowed, and stdout/stderr
// stream through to the caller unchanged.
//
// Exit codes:
//   0  already on the latest version, there is nothing to run (npx /
//      bundled-app), OR the registry was unreachable (see OFFLINE below)
//   1  upgrade available but --run was not passed (human-interactive mode)
//   2  usage error (unknown flag), OR --run on an install method that
//      can't be auto-upgraded (binary / dev-checkout / unknown)
//   3  --run attempted the upgrade and the child process failed
//
// OFFLINE — a scripting hazard of the same class as the 1→2 trap below.
// When the registry can't be reached, staleness is UNKNOWN, and EVERY
// method — including a stale global-npm — exits 0 after printing
// "couldn't reach the npm registry (offline? firewall?)". So exit 0 means
// "nothing to do OR never checked", not "up to date": a CI step shaped
// like `yaw-mcp upgrade || yaw-mcp upgrade --run` behind a firewall
// records "up to date" forever while the install never moves. A script
// that must tell the two apart has to read the --json snapshot, where
// `latest: null` is the offline marker (`stale` is false there because
// staleness cannot be computed, not because the install is current).
// Pinned by the offline tests in src/tests/upgrade-cmd.test.ts.
//
// SCRIPTING TRAP — the 1→2 transition for NON-RUNNABLE methods (binary,
// dev-checkout, unknown): for these, plain `upgrade` on a stale install
// returns 1 ("upgrade available, --run not passed"), but they can NEVER
// be auto-run, so the advertised `--run` deterministically returns 2,
// not 0. A script that treats 1 as "retry with --run" will always then
// hit exit 2. This is intentional: these methods require a MANUAL
// upgrade (download a build / `git pull` / inspect the tree), so the
// human-facing message says "manual upgrade required" rather than
// promising --run will fix it. Branch on the `method` field of the
// --json snapshot (or on exit 2) instead of blindly chaining --run.
//
// `yaw-mcp doctor` shows the same staleness status — upgrade is purely
// the "what do I type to fix it" surface. Kept separate so scripts
// that already run doctor can chain into `yaw-mcp upgrade --run` and
// have the shell do the right thing deterministically.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

declare const __VERSION__: string;

/** Where standalone-binary users get a newer build. Single source of truth so
 *  upgrade and doctor point at the same place; confirm the real distribution
 *  channel before the binary install method ships. */
export const BINARY_DOWNLOAD_URL = "https://github.com/YawLabs/mcp/releases/latest";

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
  /** Test hook: replace the `npm prefix -g` probe used to refine
   *  ambiguous install-method detections. */
  npmPrefix?: () => Promise<string | null>;
  /** Test hook: force single-executable (SEA binary) detection. */
  isSea?: () => boolean;
  /** Test hook: replace the `oam --version` probe behind the oam-floor note. */
  oamProbe?: () => OamFloorProbe | Promise<OamFloorProbe>;
}

/** The two fields the oam-floor note reads out of an `oam --version` probe.
 *  Declared structurally (rather than reusing oam-spawn's OamProbe) so
 *  upgrade-cmd keeps oam-spawn out of its static import graph -- see
 *  oamFloorLines for why that matters on the serve startup path. */
export interface OamFloorProbe {
  version: string | null;
  belowMin: boolean;
}

export interface UpgradeCommandResult {
  exitCode: number;
  lines: string[];
}

export type InstallMethod =
  | "global-npm"
  | "pnpm-global"
  | "bun-global"
  | "npx"
  | "local-node-modules"
  | "bundled-app"
  | "dev-checkout"
  | "binary"
  | "unknown";

/** POSIX-style global prefixes keep globals at `<prefix>/lib/node_modules`.
 *  These alternatives each anchor on a prefix shape that really is a Node
 *  install root: a bare `/lib/node_modules/@yawlabs/mcp/` marker also matched a
 *  workspace package directory literally named `lib`
 *  (`<repo>/packages/lib/node_modules/@yawlabs/mcp/...`), which then drove
 *  auto-upgrade's `npm install -g --prefix <repo>/packages` — writing a global
 *  tree plus bin shims into the user's repo and overwriting the
 *  workspace-pinned version.
 *
 *  Anchoring deliberately trades a false POSITIVE (unrecoverable: a `-g`
 *  install into a project tree) for a false NEGATIVE (recoverable: the install
 *  is classified `local-node-modules`, refineInstallMethod's `npm prefix -g`
 *  probe reclassifies it for the CLI, and maybeAutoUpgrade merely logs the
 *  manual path instead of spawning). An exotic prefix that isn't listed here
 *  therefore degrades safely — do NOT widen this back to a bare
 *  `/lib/node_modules/`.
 *    /usr/lib, /usr/local/lib   distro packages and `make install` defaults
 *    /opt/<tool>/lib            homebrew (/opt/homebrew), /opt/node, /opt/nodejs
 *  The optional drive prefix keeps a normalized `C:/usr/local/lib/...`
 *  (MSYS/Cygwin) matching the same shape. */
const POSIX_GLOBAL_LIB_PREFIX = /^(?:[A-Za-z]:)?(?:\/usr(?:\/local)?|\/opt\/[^/]+)\/lib\/node_modules\/@yawlabs\/mcp\//;

/** Version-manager and rootless-user Node roots, which also keep globals at
 *  `<root>/lib/node_modules` but sit at an arbitrary depth under the manager's
 *  own directory (`~/.nvm/versions/node/v22.11.0/lib/node_modules/...`). Same
 *  anchoring rationale as POSIX_GLOBAL_LIB_PREFIX: the manager segment is what
 *  distinguishes a Node root from a project directory named `lib`. */
const MANAGED_NODE_LIB_PREFIX =
  /\/(?:\.local|\.nvm|\.fnm|fnm|\.asdf|\.volta|\.nodenv|\.nvs|n)\/(?:[^/]+\/)*lib\/node_modules\/@yawlabs\/mcp\//;

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

  --run     Run the upgrade in place (global npm, pnpm, bun, and local npm
            installs). No-op for npx installs -- they always fetch the latest.
  --json    Emit a machine-readable snapshot ({ current, latest, stale,
            method, command }) instead of prose.
            NOTE: --json is a report-only snapshot; it never spawns an upgrade
            even when combined with --run. Use --run without --json to
            actually perform the upgrade.`;

export function parseUpgradeArgs(
  argv: string[],
): { ok: true; options: UpgradeCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: UpgradeCommandOptions = {};
  for (const a of argv) {
    if (a === "--run") opts.run = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: UPGRADE_USAGE, help: true };
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
  // `npx -y @yawlabs/mcp` stages packages under ~/.npm/_npx/<hex>/
  // node_modules/@yawlabs/mcp/ (or platform equivalent; on Windows the
  // cache is under npm-cache/_npx/...). Require the full npm-cache
  // context — `_npx/<hex>/node_modules/@yawlabs/mcp/` — rather than a
  // bare `_npx` segment: a user project path that merely CONTAINS a
  // `_npx` directory would otherwise be misclassified as an npx run.
  // Consistent with the global markers below, which all anchor on the
  // `@yawlabs/mcp` segment.
  if (/\/_npx\/[0-9a-f]+\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "npx";
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
  // `<prefix>/lib/node_modules` — anchored on real Node-root shapes; see the
  // two regex definitions above for why a bare `/lib/` marker was unsafe.
  if (POSIX_GLOBAL_LIB_PREFIX.test(normalized)) return "global-npm";
  if (MANAGED_NODE_LIB_PREFIX.test(normalized)) return "global-npm";
  if (/\/AppData\/Roaming\/npm\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  // Windows npm prefixes that live in a `bin` dir (scoop's nodejs persist
  // dir, custom prefixes): globals land at <prefix>/node_modules with
  // <prefix> itself named `bin`. A project tree whose root dir is
  // literally named `bin` is rare enough that this marker is safe, and
  // misclassifying these as local-node-modules made `upgrade --run`
  // npm-install into the node prefix instead of upgrading the global.
  if (/\/bin\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  // pnpm / bun global stores look like local node_modules trees but are
  // internally managed -- running plain `npm install` inside them writes
  // a foreign package-lock + node_modules into the tool's store. Detect
  // them BEFORE the generic node_modules marker and upgrade with the
  // owning tool instead. pnpm: <pnpm-home>/global/<n>/node_modules/...
  // (~/.local/share/pnpm, ~/AppData/Local/pnpm, ~/Library/pnpm); bun:
  // ~/.bun/install/global/node_modules/...
  if (/\/pnpm\/global\/\d+\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "pnpm-global";
  if (/\/\.bun\/install\/global\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "bun-global";
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

/** Ask npm where its global prefix actually is. Returns null when npm
 *  isn't reachable, exits non-zero, or doesn't answer within 3s — refinement
 *  is then skipped and the path-marker classification stands.
 *
 *  Exported because auto-upgrade's multi-prefix warning needs the same probe:
 *  it used to keep its own copy with no timer, no kill, no exit-code check and
 *  no VITEST guard, so a hung `npm prefix -g` left an unresolved promise and a
 *  live child handle for the broker's lifetime. One helper, one timeout, one
 *  test short-circuit. */
export async function npmGlobalPrefix(): Promise<string | null> {
  // Auto-skip under vitest (mirrors doctor-cmd's registry probe) so unit
  // tests never spawn a real npm; tests exercising refinement inject
  // their own probe via opts.npmPrefix.
  if (process.env.VITEST) return null;
  return new Promise((resolve) => {
    const child = spawn("npm", ["prefix", "-g"], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 3000);
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Resolve symlinks/junctions and normalize a path for comparison.
 *  realpath matters on Windows tool managers (scoop's `current` is a
 *  junction into a versioned dir) where the literal argv path and the
 *  npm prefix point at the same files through different names. */
function comparablePath(p: string): string {
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    // Nonexistent or unreadable -- compare the literal path instead.
  }
  const normalized = real.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Second-chance classification for the methods the path markers can't
 *  distinguish: when an install looks like `local-node-modules` (or
 *  `unknown`), ask npm for its real global prefix and reclassify as
 *  `global-npm` when the entrypoint lives inside it. Catches exotic
 *  prefixes the markers don't know (custom NPM_CONFIG_PREFIX, new tool
 *  managers) without spawning npm on the unambiguous fast paths. */
export async function refineInstallMethod(
  method: InstallMethod,
  argvPath: string | undefined,
  npmPrefix: () => Promise<string | null> = npmGlobalPrefix,
): Promise<InstallMethod> {
  if (method !== "local-node-modules" && method !== "unknown") return method;
  if (!argvPath) return method;
  const prefix = await npmPrefix();
  if (!prefix) return method;
  const entry = comparablePath(argvPath);
  const pfx = comparablePath(prefix);
  // Windows global layout: <prefix>/node_modules; POSIX: <prefix>/lib/node_modules.
  if (entry.startsWith(`${pfx}/node_modules/`) || entry.startsWith(`${pfx}/lib/node_modules/`)) {
    return "global-npm";
  }
  return method;
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
    case "pnpm-global":
      command = "pnpm add -g @yawlabs/mcp@latest";
      break;
    case "bun-global":
      command = "bun add -g @yawlabs/mcp@latest";
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
    case "binary":
      command = null; // standalone binary — replace the executable manually.
      break;
    default:
      command = "npm install -g @yawlabs/mcp@latest";
      break;
  }
  return { current, latest, stale, method, command };
}

/** Copy of compareSemver kept local so upgrade-cmd doesn't drag
 *  doctor-cmd into its import graph (keeps the CLI startup fast).
 *
 *  Implements semver.org precedence: split major.minor.patch-prerelease,
 *  compare release fields numerically, then prerelease identifiers per
 *  the spec:
 *    - A version with a prerelease tag has LOWER precedence than the same
 *      release without one (1.2.3-beta < 1.2.3).
 *    - Prerelease identifiers are compared dot-by-dot: numeric identifiers
 *      compare numerically, alphanumerics lexically, numeric < alphanumeric,
 *      a shorter run of identifiers loses to a longer one when all earlier
 *      ones are equal.
 *  Build metadata (`+...`) is ignored per spec. */
function compareSemverLocal(a: string, b: string): number {
  const parse = (s: string): { release: [number, number, number]; prerelease: string[] } | null => {
    // Strip any build-metadata suffix (semver.org §10) before splitting.
    const cleaned = s.replace(/\+.*$/, "");
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
    if (!m) return null;
    const release: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const prerelease = m[4] ? m[4].split(".") : [];
    return { release, prerelease };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.release[i] < pb.release[i]) return -1;
    if (pa.release[i] > pb.release[i]) return 1;
  }
  // Release fields equal -- compare prerelease per semver.org §11.
  // A version WITHOUT prerelease beats a version WITH one.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na < nb) return -1;
      if (na > nb) return 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumerics.
      return aNum ? -1 : 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  // All compared identifiers equal -- longer prerelease wins (1.2.3-alpha.1 > 1.2.3-alpha).
  if (pa.prerelease.length < pb.prerelease.length) return -1;
  if (pa.prerelease.length > pb.prerelease.length) return 1;
  return 0;
}

/** Ask the registry for the newest published version, or null on any failure
 *  (non-2xx, malformed body, offline, or a >3s stall via the AbortController).
 *
 *  Exported because auto-upgrade needs the identical probe at serve startup and
 *  used to keep a byte-identical copy: two copies meant a change to the URL, the
 *  timeout or the response validation landed in one of them only, and that
 *  divergence has already happened once (doctor-cmd's third copy runs a 2000ms
 *  timeout where this one runs 3000ms). */
export async function fetchLatestVersion(): Promise<string | null> {
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

/** Advisory lines for the case where the oam runtime is installed but BELOW the
 *  floor yaw-mcp hosts sidecars on. Empty when oam is absent (node is the
 *  baseline, nothing to say), current, or unprobeable.
 *
 *  Why `upgrade` of all commands: MIN_OAM_VERSION tracks the LATEST oam release
 *  and moves with every one, so the very act of upgrading yaw-mcp can raise the
 *  floor past the user's oam and silently drop every sidecar from oam to
 *  node/npx. That state is otherwise surfaced only as one warn line on the
 *  broker's stderr (which MCP clients hide) and in `yaw-mcp doctor` — while
 *  `upgrade`, the command a user runs precisely to "get current", printed
 *  "nothing to do".
 *
 *  The oam-spawn import is dynamic on purpose: upgrade-cmd sits on the serve
 *  startup path (auto-upgrade.ts imports it), and this probe only matters in the
 *  prose CLI path. The try/catch makes the note strictly advisory — a probe that
 *  throws must never fail `upgrade`. */
async function oamFloorLines(probe?: UpgradeCommandOptions["oamProbe"]): Promise<string[]> {
  // Auto-skip under vitest when no probe was injected (mirrors npmGlobalPrefix):
  // an un-injected unit test must never spawn a real `oam --version`, whose
  // answer varies per machine.
  if (!probe && process.env.VITEST) return [];
  try {
    const { MIN_OAM_VERSION, probeOam } = await import("./oam-spawn.js");
    const oam: OamFloorProbe = probe ? await probe() : await probeOam();
    if (!oam.belowMin) return [];
    return [
      "",
      `oam:     v${oam.version ?? "unknown"} is installed but below the v${MIN_OAM_VERSION} floor yaw-mcp`,
      "         requires, so MCP sidecars run on node instead of oam. Update it:",
      "",
      "  oam self-update",
    ];
  } catch {
    return [];
  }
}

async function defaultSpawn(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", cwd });
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
}

/** True when this process is a Single Executable Application (Node SEA)
 *  blob -- i.e. yaw-mcp was compiled into a standalone binary. Two cheap
 *  gates first so ordinary `node script.js` runs skip the node:sea import
 *  entirely (a micro-optimization, not a correctness guard -- node:sea does
 *  not warn on Node >= 21): a SEA's execPath is the app binary, never `node`,
 *  and Electron-as-node is never a SEA. node:sea exists only on Node >= 20.12
 *  and isSea() is true only inside a SEA, so a missing module or a thrown call
 *  both mean "not a binary". */
export async function detectSea(): Promise<boolean> {
  if (process.env.ELECTRON_RUN_AS_NODE) return false;
  const exe = process.execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (exe === "node" || exe === "node.exe") return false;
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea() === true;
  } catch {
    return false;
  }
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

  const fetcher = opts.fetchLatest ?? fetchLatestVersion;
  const current = opts.currentVersion ?? readCurrentVersion();
  const argvPath = opts.argvPath ?? process.argv[1];
  // A standalone SEA binary has no package manager and no script path in
  // argv[1] (it'd be the first user arg), so path-based detection would
  // mislabel it `unknown` and suggest a bogus `npm install -g`. Detect the
  // SEA blob first and short-circuit to the binary method.
  const sea = opts.isSea ? opts.isSea() : await detectSea();
  const method = sea ? "binary" : await refineInstallMethod(detectInstallMethod(argvPath), argvPath, opts.npmPrefix);

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
    } else if (method === "binary") {
      print("yaw-mcp is a standalone binary — download the latest build and replace");
      print(`this executable: ${BINARY_DOWNLOAD_URL}`);
    } else {
      print("Your install uses `npx -y` — just restart the MCP client when you're back online.");
    }
    return { exitCode: 0, lines };
  }

  print(`Current: ${current}`);
  print(`Latest:  ${latest}`);
  print(`Install: ${method}`);
  // Printed for both the stale and up-to-date paths: "nothing to do" about
  // yaw-mcp itself is exactly when a below-floor oam would otherwise go unsaid.
  for (const line of await oamFloorLines(opts.oamProbe)) print(line);

  if (!plan.stale) {
    print("");
    print("OK: You're on the latest version -- nothing to do.");
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

  if (method === "binary") {
    print("yaw-mcp is running as a standalone binary — manual upgrade required.");
    print("There's no package manager to upgrade it, and `--run` can't automate");
    print("this: download the latest build and replace this executable:");
    print("");
    print(`  ${BINARY_DOWNLOAD_URL}`);
    // 1→2 scripting trap (see the "SCRIPTING TRAP" note in the file header):
    // plain `upgrade` returns 1, but `--run` returns 2 because a binary can
    // never be auto-run. The message above states "manual upgrade required"
    // so scripts don't blindly retry with --run. The exit-code contract is
    // intentionally unchanged.
    return { exitCode: opts.run ? 2 : 1, lines };
  }

  // Auto-runnable methods spawn the OWNING tool with whitelisted args for
  // exactly our package: npm for global/local npm trees, pnpm/bun for
  // their global stores. dev-checkout stays manual — the user owns that
  // tree and the right command depends on their setup. unknown stays
  // manual because we don't know which install we'd be mutating.
  const installRoot = method === "local-node-modules" ? localInstallRoot(argvPath) : null;
  const runSpec: { cmd: string; args: string[]; cwd?: string } | null =
    method === "global-npm"
      ? { cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] }
      : method === "pnpm-global"
        ? { cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"] }
        : method === "bun-global"
          ? { cmd: "bun", args: ["add", "-g", "@yawlabs/mcp@latest"] }
          : method === "local-node-modules" && installRoot !== null
            ? { cmd: "npm", args: ["install", "@yawlabs/mcp@latest"], cwd: installRoot }
            : null;

  if (!opts.run) {
    if (runSpec) {
      print("Run `yaw-mcp upgrade --run` to upgrade in place, or run it yourself:");
    } else {
      // Non-runnable method (dev-checkout / unknown): manual upgrade required.
      // 1→2 scripting trap — see the file-header "SCRIPTING TRAP" note: this
      // returns 1 here, but `--run` returns 2 below, never 0. Don't promise
      // --run will fix it.
      print("Manual upgrade required (--run can't safely automate this install method). Run it yourself:");
    }
    print("");
    if (installRoot) {
      print(`in ${installRoot}:`);
    }
    print(`  ${plan.command}`);
    return { exitCode: 1, lines };
  }

  // --run: attempt the upgrade. Only whitelisted commands — never
  // pass arbitrary user input into a shell.
  if (!runSpec) {
    // Non-runnable method reached via --run: manual upgrade required. This is
    // the exit-2 half of the documented 1→2 scripting trap (file-header note).
    printErr(
      `yaw-mcp upgrade --run: a "${method}" install can't be upgraded automatically (manual upgrade required). Run it yourself:`,
    );
    printErr("");
    printErr(`  ${plan.command}`);
    return { exitCode: 2, lines };
  }

  const runner = opts.spawnImpl ?? defaultSpawn;
  if (runSpec.cwd) {
    print(`Running in ${runSpec.cwd}:`);
  } else {
    print("Running:");
  }
  print(`  ${plan.command}`);
  print("");
  const code = await runner(runSpec.cmd, runSpec.args, runSpec.cwd);
  if (code === 0) {
    print("");
    print(`OK: Upgraded @yawlabs/mcp to ${latest}`);
    return { exitCode: 0, lines };
  }
  printErr(`yaw-mcp upgrade: ${runSpec.cmd} exited ${code}. Try running the command yourself:`);
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
