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

/**
 * Whether a launch spec names a plain REGISTRY package, the only kind that can
 * go in the generated manifest.
 *
 * npx also accepts git and path specs -- `npx -y github:owner/repo`,
 * `npx -y ./local-server`, `file:../x` -- and `packageName` passes those
 * through whole, because there is no `@version` separator to cut at. Used as a
 * dependency KEY that produces `{"github:owner/repo": "latest"}`, which npm
 * rejects as an invalid name. npm then fails the WHOLE install, so one
 * unusually-configured server would stop every other package from installing.
 *
 * A git or path spec is legitimate configuration, so this is a skip rather
 * than an error: those servers keep resolving through npx exactly as before,
 * and the command says which ones it passed over. Resolving them properly
 * would mean fetching the target just to learn the name it declares, which is
 * more than this command should do.
 */
export function isRegistrySpec(spec: string): boolean {
  // A protocol (github:, file:, git+ssh:, http:) or a filesystem path.
  if (spec.includes(":") || /^[./~\\]/.test(spec)) return false;
  // @scope/name, or a bare name. npm forbids a leading "." or "_".
  return /^(@[^/@\s]+\/)?[^./_@\s][^/@\s]*$/.test(packageName(spec));
}

export interface SidecarSpec {
  /** Bare package name, e.g. "@yawlabs/fetch-mcp". */
  pkg: string;
  /** The spec as configured, e.g. "@yawlabs/fetch-mcp@latest". */
  spec: string;
  /** Namespaces that launch this package -- one package can back several. */
  namespaces: string[];
  /** Other specs configured for this same package, when they disagree with
   *  `spec`. A flat node_modules holds ONE version, so the others cannot be
   *  honoured -- they are carried here so the command can say so instead of
   *  dropping them silently. Empty in the ordinary case. */
  conflicting: string[];
}

/**
 * The npx-launched packages in a server list, de-duplicated by package name.
 *
 * Only `npx` servers are candidates. `node <abs>` already points at a real
 * file, and docker/uvx/native commands are not npm packages at all. An npx
 * launch carrying flags yaw-mcp does not parse is skipped for the same reason
 * rewriteForOam skips it: the first positional is not reliably the package.
 *
 * When the same package is configured twice at DIFFERENT versions, the first
 * spec wins and the rest are recorded in `conflicting`. One flat node_modules
 * cannot hold two versions of a package, so a loser is unavoidable -- but a
 * server configured `pkg@1.0.0` that silently starts on `@latest` is a lie the
 * caller should get to see, so the runner prints it.
 */
export function collectSidecarSpecs(servers: Array<Partial<UpstreamServerConfig>>): SidecarSpec[] {
  const byPkg = new Map<string, SidecarSpec>();
  for (const s of servers) {
    if (s.type !== "local" || s.command !== "npx") continue;
    const positional = (s.args ?? []).filter((a) => a !== "-y" && a !== "--yes");
    const spec = positional[0];
    if (spec === undefined || spec.startsWith("-")) continue;
    // A git or path spec cannot be a dependency key; including it would make
    // npm reject the manifest and fail the install for every other package
    // too. See isRegistrySpec.
    if (!isRegistrySpec(spec)) continue;
    const pkg = packageName(spec);
    if (!pkg) continue;
    const existing = byPkg.get(pkg);
    if (existing) {
      if (s.namespace && !existing.namespaces.includes(s.namespace)) existing.namespaces.push(s.namespace);
      // Only a DIFFERENT spec is a conflict; the same package pinned the same
      // way by two servers is the common case and says nothing.
      if (spec !== existing.spec && !existing.conflicting.includes(spec)) existing.conflicting.push(spec);
      continue;
    }
    byPkg.set(pkg, { pkg, spec, namespaces: s.namespace ? [s.namespace] : [], conflicting: [] });
  }
  return [...byPkg.values()];
}

/**
 * npx servers whose spec is a git or path target rather than a registry
 * package, paired with the namespace that configured them. Reported so the
 * skip is visible -- a server missing from the install list with no
 * explanation reads as a bug.
 */
export function collectNonRegistrySpecs(
  servers: Array<Partial<UpstreamServerConfig>>,
): Array<{ namespace: string; spec: string }> {
  const out: Array<{ namespace: string; spec: string }> = [];
  for (const s of servers) {
    if (s.type !== "local" || s.command !== "npx") continue;
    const spec = (s.args ?? []).filter((a) => a !== "-y" && a !== "--yes")[0];
    if (spec === undefined || spec.startsWith("-") || isRegistrySpec(spec)) continue;
    out.push({ namespace: s.namespace ?? "(unnamed)", spec });
  }
  return out;
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

/** Every key the `--json` document carries, on every path. */
interface SidecarsJson {
  /** The managed directory. Present even when nothing was installed, so a
   *  consumer never has to branch on its absence to learn where it looks. */
  root: string;
  installed: Array<{ pkg: string; version: string | null; namespaces: string[] }>;
  /** Why nothing was installed, else null. */
  reason: string | null;
  /** What went wrong, else null. */
  error: string | null;
  /** Packages configured at two different versions; the winner is the version
   *  reported in `installed`. Empty in the ordinary case. */
  conflicts: Array<{ pkg: string; used: string; ignored: string[] }>;
  /** npx servers passed over because their spec is a git or path target, not
   *  a registry package. They keep resolving through npx. */
  skipped: Array<{ namespace: string; spec: string }>;
}

/**
 * Emit the `--json` document.
 *
 * One shape on EVERY path. The three exit paths previously emitted three
 * different objects -- `{root, installed}`, `{installed, reason}`, and
 * `{installed, error}` -- so a caller could not read `root` without first
 * working out which path it had hit, and had to probe for keys to tell
 * success from failure. Defaulting every field here means the document has
 * the same keys whether the install worked, found nothing, or failed.
 */
function jsonDocument(root: string, over: Partial<SidecarsJson> = {}): string {
  const doc: SidecarsJson = {
    root,
    installed: [],
    reason: null,
    error: null,
    conflicts: [],
    skipped: [],
    ...over,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Spawn npm so the user sees progress on a long install. */
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
      // npm's own progress ("added 220 packages in 12s") goes to its STDOUT,
      // and inheriting that put it ahead of the JSON document under --json --
      // enough to make `yaw-mcp sidecars install --json | jq` fail outright.
      // Routing the child's stdout to fd 2 keeps the progress visible while
      // leaving OUR stdout carrying only the result, which is what a caller
      // parses. Unconditional rather than --json-only: progress belongs on
      // stderr in both modes, and a mode-dependent stdio is a second shape to
      // get wrong.
      stdio: ["ignore", 2, "inherit"],
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

  Only npx-launched servers naming a registry package are installed. docker,
  uvx, and native commands are left alone, as are node launches that already
  name a file and npx launches pointing at a git or path target.`;

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
  const servers = bundles.config?.servers ?? [];
  const specs = collectSidecarSpecs(servers);
  const skipped = collectNonRegistrySpecs(servers);
  const root = sidecarsRoot(home);
  const conflicts = specs
    .filter((s) => s.conflicting.length > 0)
    .map((s) => ({ pkg: s.pkg, used: s.spec, ignored: s.conflicting }));

  // Printed on every path INCLUDING the nothing-to-do one: a config whose only
  // npx servers are git targets would otherwise report "nothing to install"
  // and leave the reason to be guessed at.
  const printSkipped = () => {
    if (skipped.length === 0) return;
    print();
    for (const k of skipped) {
      print(`  note: ${k.namespace} launches ${k.spec}, not a registry package; it keeps using npx`);
    }
  };

  if (specs.length === 0) {
    // Three different empty states, and telling a first-time user with no
    // config at all that their bundles.json has no npx servers describes a
    // file that does not exist. `config` is null exactly when neither the
    // user-global nor an approved project file was found, so the cases are
    // distinguishable -- and each wants a different next step.
    if (bundles.config === null) {
      print("No servers configured yet -- nothing to install.");
      print("Add one with `yaw-mcp add <slug>`, then run this again.");
      printSkipped();
      if (opts.json) write(jsonDocument(root, { reason: "no-config", skipped }));
      return { exitCode: 0, installed: [], lines };
    }
    if (skipped.length > 0) {
      // Every npx server was a git or path target. Saying "no npx-launched
      // servers" here would flatly contradict the config the user is looking
      // at, so lead with the skips instead of appending them as a footnote.
      print("Nothing to install -- every npx server points at a git or path target.");
      printSkipped();
      if (opts.json) write(jsonDocument(root, { reason: "only-non-registry-specs", skipped }));
      return { exitCode: 0, installed: [], lines };
    }
    print("No npx-launched servers in bundles.json -- nothing to install.");
    print("docker, uvx, and native commands run as configured; only npx servers are installed here.");
    if (opts.json) write(jsonDocument(root, { reason: "no-npx-servers", skipped }));
    return { exitCode: 0, installed: [], lines };
  }

  mkdirSync(root, { recursive: true });
  await atomicWriteFile(join(root, "package.json"), sidecarsManifest(specs));

  print(`Installing ${specs.length} server package(s) into ${root}`);
  for (const s of specs) print(`  ${s.spec}${s.namespaces.length ? `  (${s.namespaces.join(", ")})` : ""}`);
  printSkipped();
  // A flat tree holds one version per package, so a second spec for the same
  // package cannot be honoured. Say which one won rather than letting a server
  // pinned to an exact version quietly start on something else.
  if (conflicts.length > 0) {
    print();
    for (const c of conflicts) {
      print(`  note: ${c.pkg} is also configured as ${c.ignored.join(", ")}; installing ${c.used}`);
    }
  }
  print();

  const runNpm = opts.runNpm ?? defaultRunNpm;
  // `--no-audit --no-fund` keep the output about the install; `--install-
  // strategy=nested` is NOT used -- a flat tree is what resolveNpmEntry walks.
  const code = await runNpm(["install", "--no-audit", "--no-fund"], root);
  if (code !== 0) {
    print(`npm install failed (exit ${code}). Servers keep resolving from the npx cache.`);
    if (opts.json) write(jsonDocument(root, { error: `npm exited ${code}`, conflicts, skipped }));
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

  // npm exited 0 but not one requested package resolved in the tree. A
  // scripted caller has to be able to tell that from a real install, so it
  // exits non-zero AND fills in `error` -- the field this document exists to
  // make the single success/failure discriminator. Reporting exit 1 with
  // `error: null` meant a consumer branching on `error` read it as clean.
  const nothingLanded = missing.length === installed.length;
  const error = nothingLanded ? "npm exited 0 but no requested package resolved in the managed tree" : null;

  if (opts.json) write(jsonDocument(root, { installed, conflicts, skipped, error }));
  return { exitCode: nothingLanded ? 1 : 0, installed, lines };
}

/** True when a managed install exists. Lets a caller skip the per-package
 *  reads entirely when the tree was never created. */
export function hasManagedSidecars(home: string = homedir()): boolean {
  return existsSync(sidecarsNodeModules(home));
}
