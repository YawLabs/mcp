// `yaw-mcp sidecars install` -- install the configured MCP servers durably.
//
// The problem this exists for. A server configured `npx -y <pkg>@latest` gets
// its package from npm's `_npx` cache, and that arrangement has two properties
// that only became load-bearing once oam started hosting sidecars:
//
//   * The cache is keyed by content hash, so it accumulates every version ever
//     fetched and nothing ever names which one is current.
//   * `npx` re-resolved `@latest` on every spawn, which is what kept those
//     servers up to date. `oam run <entry>` cannot -- oam has no fetch-on-
//     demand -- so once oam is the default, npx stops running for that server
//     and the cache stops being refreshed. The version pins itself.
//
// Installing into a directory yaw-mcp owns fixes both: one copy per package, a
// version that is written down, and a single command that moves it forward.
// resolveNpmEntry prefers this tree over any cache copy (oam-spawn.ts).
//
// Deliberately NOT automatic. Acquiring packages means network and minutes, and
// the connect path is what an MCP client blocks on while waiting for its tools
// -- a first connect that silently turns into an npm install is the wrong
// trade. Nothing breaks without running it; resolution falls back to the cache
// exactly as before.
//
// Why npm and not `oam install`, which sounds like the obvious tool here:
//
//   * It is frozen-lockfile only ("the default and only mode for MVP"), so it
//     reproduces an existing lockfile and cannot acquire `@latest` into an
//     empty directory. Something has to create the lockfile first.
//   * Its `--precompile` buys nothing for this workload. It pre-compiles
//     TypeScript found in installed packages, and MCP servers ship compiled
//     JavaScript to npm -- measured across every sidecar in the default
//     bundle, the count of runnable .ts files is zero and the precompile
//     cache comes back empty.
//   * Running it OVER an npm-installed tree is worse than useless: it skips
//     lifecycle scripts unless the package is trusted (`oam trust add`), so a
//     server that needs a postinstall -- puppeteer downloading a browser --
//     silently loses it and fails at spawn rather than at install.
//
// So npm does the install, and this file does not chain `oam install` after
// it. That is a deliberate decision with the measurement behind it, not an
// oversight to be tidied up later.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { loadLocalBundles } from "./local-bundles.js";
import { packageName } from "./oam-spawn.js";
import { sidecarsNodeModules, sidecarsRoot } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

export { SIDECARS_DIRNAME, sidecarsNodeModules, sidecarsRoot } from "./paths.js";

export interface SidecarSpec {
  /** Bare package name, e.g. "@yawlabs/fetch-mcp". */
  pkg: string;
  /** The spec as configured, e.g. "@yawlabs/fetch-mcp@latest". */
  spec: string;
  /** Namespaces that launch this package -- one package can back several. */
  namespaces: string[];
}

/**
 * The npx-launched packages in a server list, de-duplicated by package name.
 *
 * Only `npx` servers are candidates. `node <abs>` already points at a real
 * file, and docker/uvx/native commands are not npm packages at all. An npx
 * launch carrying flags yaw-mcp does not parse is skipped for the same reason
 * rewriteForOam skips it: the first positional is not reliably the package.
 */
export function collectSidecarSpecs(servers: Array<Partial<UpstreamServerConfig>>): SidecarSpec[] {
  const byPkg = new Map<string, SidecarSpec>();
  for (const s of servers) {
    if (s.type !== "local" || s.command !== "npx") continue;
    const positional = (s.args ?? []).filter((a) => a !== "-y" && a !== "--yes");
    const spec = positional[0];
    if (spec === undefined || spec.startsWith("-")) continue;
    const pkg = packageName(spec);
    if (!pkg) continue;
    const existing = byPkg.get(pkg);
    if (existing) {
      if (s.namespace && !existing.namespaces.includes(s.namespace)) existing.namespaces.push(s.namespace);
      continue;
    }
    byPkg.set(pkg, { pkg, spec, namespaces: s.namespace ? [s.namespace] : [] });
  }
  return [...byPkg.values()];
}

/**
 * The package.json yaw-mcp writes into the managed directory.
 *
 * `private` so a stray `npm publish` in that directory cannot do anything, and
 * the dependency VALUE is the version range from the configured spec -- a bare
 * `<pkg>` with no `@version` becomes `latest`, matching what npx would have
 * resolved.
 */
export function sidecarsManifest(specs: SidecarSpec[]): string {
  const dependencies: Record<string, string> = {};
  for (const { pkg, spec } of specs.slice().sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    // Everything after the name's version separator; "" when none was given.
    const range = spec.slice(pkg.length).replace(/^@/, "");
    dependencies[pkg] = range === "" ? "latest" : range;
  }
  return `${JSON.stringify(
    {
      name: "yaw-mcp-sidecars",
      version: "0.0.0",
      private: true,
      description: "MCP servers installed by `yaw-mcp sidecars install`. Managed file -- edits are overwritten.",
      dependencies,
    },
    null,
    2,
  )}\n`;
}

/** The installed version of a package in the managed tree, or null. */
export function installedVersion(pkg: string, home: string = homedir()): string | null {
  const pj = join(sidecarsNodeModules(home), ...pkg.split("/"), "package.json");
  try {
    const v = JSON.parse(readFileSync(pj, "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export interface SidecarsInstallOptions {
  home?: string;
  cwd?: string;
  json?: boolean;
  out?: (s: string) => void;
  /** Injected in tests. Resolves to the child's exit code. */
  runNpm?: (args: string[], cwd: string) => Promise<number>;
}

export interface SidecarsInstallResult {
  exitCode: number;
  installed: Array<{ pkg: string; version: string | null; namespaces: string[] }>;
  lines: string[];
}

/** Spawn npm, inheriting stdio so the user sees progress on a long install. */
function defaultRunNpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    // npm on Windows is a .cmd shim, and since the CVE-2024-27980 fix Node
    // REFUSES to spawn .cmd/.bat without a shell -- it fails EINVAL before the
    // process starts. So Windows must go through the shell. That is safe here
    // only because every argument is a fixed literal: `cwd` travels as a spawn
    // option rather than in the command line, so no user-controlled path is
    // ever parsed by cmd. Do not interpolate a package name into these args.
    const isWindows = process.platform === "win32";
    const child = spawn(isWindows ? "npm.cmd" : "npm", args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      shell: isWindows,
    });
    child.on("error", () => resolve(-1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
}

export const SIDECARS_USAGE = `Usage: yaw-mcp sidecars install [--json]

  Install the MCP servers from your bundles.json into ~/.yaw-mcp/sidecars,
  so they run from one known version instead of whatever npm's npx cache
  happens to hold.

  Worth running when servers are hosted on oam: oam runs the copy already on
  disk and cannot re-resolve "@latest" the way npx did, so without a managed
  install a server stays pinned at whatever was last fetched. Re-run this to
  move them forward.

  Only npx-launched servers are installed. docker, uvx, and native commands
  are left alone, as are node launches that already name a file.`;

export function parseSidecarsArgs(
  argv: string[],
): { ok: true; options: { json: boolean } } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let sawInstall = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: SIDECARS_USAGE, help: true };
    } else if (a === "install") {
      sawInstall = true;
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp sidecars: unknown argument "${a}"\n\n${SIDECARS_USAGE}` };
    } else {
      return { ok: false, error: `yaw-mcp sidecars: unknown subcommand "${a}"\n\n${SIDECARS_USAGE}` };
    }
  }
  if (!sawInstall) return { ok: false, error: `yaw-mcp sidecars: expected "install"\n\n${SIDECARS_USAGE}` };
  return { ok: true, options: { json } };
}

export async function runSidecarsInstall(opts: SidecarsInstallOptions = {}): Promise<SidecarsInstallResult> {
  const home = opts.home ?? homedir();
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const lines: string[] = [];
  const print = (s = "") => {
    lines.push(s);
    if (!opts.json) write(`${s}\n`);
  };

  const bundles = await loadLocalBundles({ cwd: opts.cwd, home });
  const specs = collectSidecarSpecs(bundles.config?.servers ?? []);

  if (specs.length === 0) {
    print("No npx-launched servers in bundles.json -- nothing to install.");
    if (opts.json) write(`${JSON.stringify({ installed: [], reason: "no-npx-servers" }, null, 2)}\n`);
    return { exitCode: 0, installed: [], lines };
  }

  const root = sidecarsRoot(home);
  mkdirSync(root, { recursive: true });
  await atomicWriteFile(join(root, "package.json"), sidecarsManifest(specs));

  print(`Installing ${specs.length} server package(s) into ${root}`);
  for (const s of specs) print(`  ${s.spec}${s.namespaces.length ? `  (${s.namespaces.join(", ")})` : ""}`);
  print();

  const runNpm = opts.runNpm ?? defaultRunNpm;
  // `--no-audit --no-fund` keep the output about the install; `--install-
  // strategy=nested` is NOT used -- a flat tree is what resolveNpmEntry walks.
  const code = await runNpm(["install", "--no-audit", "--no-fund"], root);
  if (code !== 0) {
    print(`npm install failed (exit ${code}). Servers keep resolving from the npx cache.`);
    if (opts.json) write(`${JSON.stringify({ installed: [], error: `npm exited ${code}` }, null, 2)}\n`);
    return { exitCode: 1, installed: [], lines };
  }

  const installed = specs.map((s) => ({
    pkg: s.pkg,
    version: installedVersion(s.pkg, home),
    namespaces: s.namespaces,
  }));
  const missing = installed.filter((i) => i.version === null);

  print("Installed:");
  for (const i of installed) print(`  ${i.pkg}  ${i.version ?? "NOT FOUND"}`);
  if (missing.length > 0) {
    print();
    print(`${missing.length} package(s) did not land; those servers keep resolving from the npx cache.`);
  }
  print();
  print("These versions are now fixed. Re-run this command to move them forward.");

  if (opts.json) write(`${JSON.stringify({ root, installed }, null, 2)}\n`);
  // Exit non-zero when nothing at all resolved -- a scripted caller should be
  // able to tell "installed" from "npm succeeded but the tree is empty".
  return { exitCode: missing.length === installed.length ? 1 : 0, installed, lines };
}

/** True when a managed install exists (doctor reports it). */
export function hasManagedSidecars(home: string = homedir()): boolean {
  return existsSync(sidecarsNodeModules(home));
}
