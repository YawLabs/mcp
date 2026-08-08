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
//
// It DOES take two npm steps: `install` acquires, and `update` is the only one
// of the two that can move an already-locked `@latest` forward on a re-run. See
// the note at the update call for the measurement behind that.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { describeDefaultRuntime, describeServerRuntime } from "./default-runtime.js";
import { loadLocalBundles, localBundlesPath } from "./local-bundles.js";
import { isRegistrySpec, npxSpec, type OamProbe, packageName, probeOam } from "./oam-spawn.js";
import { sidecarsNodeModules, sidecarsRoot, userConfigDir } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

// paths.ts owns these; they are re-exported for the callers that think of them
// as part of this command's surface (doctor-cmd + the tests). SIDECARS_DIRNAME
// is deliberately NOT among them -- it had no importer here, and one more
// re-export hides paths.ts as the actual owner.
export { sidecarsNodeModules, sidecarsRoot } from "./paths.js";

// isRegistrySpec is imported from oam-spawn.ts rather than reimplemented here.
// The two files want it for DIFFERENT reasons -- oam-spawn needs a package NAME
// it can use as an on-disk lookup key, this file needs one it can use as a
// dependency KEY in a generated manifest -- but the predicate that answers both
// is the same one, and it was maintained twice as a byte-identical copy. Two
// copies of a spec-parsing rule is how the spawn path and the install path come
// to disagree about which servers are registry packages, which is exactly the
// pair that must not drift: a server the manifest installs but the rewrite
// skips (or vice versa) is a tree nothing reads.
//
// Why THIS file cares, since the reason no longer sits on the function:
// `packageName` passes a git or path spec through whole -- there is no
// `@version` separator to cut at -- so `npx -y github:owner/repo` would land in
// the manifest as `{"github:owner/repo": "latest"}`. npm rejects that as an
// invalid name and fails the WHOLE install, so one unusually-configured server
// would stop every other package from installing.
//
// A git or path spec is legitimate configuration, so both call sites below skip
// rather than error: those servers keep resolving through npx exactly as
// before, and collectNonRegistrySpecs reports which ones were passed over.
// Resolving them properly would mean fetching the target just to learn the name
// it declares, which is more than this command should do.

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
    // Which argument is the package spec is oam-spawn's rule, not a second copy
    // of it: this collector and collectNonRegistrySpecs PARTITION the same
    // server set into "installed" and "skipped", so a rule that lives in two
    // places can drop a server out of both reports with nothing to say why.
    const spec = npxSpec(s.args ?? []);
    if (spec === null) continue;
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
    // Same shared rule as collectSidecarSpecs -- see the note there.
    const spec = npxSpec(s.args ?? []);
    if (spec === null || isRegistrySpec(spec)) continue;
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
  /** Where load-time diagnostics go. Defaults to stderr, which is what keeps
   *  them out of the `--json` document on stdout -- the same split bundles-cmd
   *  and local-add-cmd already use. Injected in tests. */
  err?: (s: string) => void;
  /** Injected in tests. Resolves to the child's exit code. */
  runNpm?: (args: string[], cwd: string) => Promise<number>;
  /** Injected in tests. Answers "can oam host these servers", which decides
   *  whether anything will READ the tree this command fills. Defaults to the
   *  real (process-cached) probe. */
  oamProbe?: () => Promise<OamProbe>;
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
  /** Why the refresh step failed, else null. Separate from `error` because the
   *  install itself SUCCEEDED: the packages are on disk and usable, they just
   *  may not have moved forward. A consumer that treats this as fatal would
   *  discard a perfectly good tree. */
  updateError: string | null;
  /** Why nothing on this machine will READ the tree that was just filled -- one
   *  entry per distinct reason, from the same verdicts as the human note (see
   *  unhostedReasons). Empty means at least one server resolves to oam, which
   *  is the healthy case; NON-empty is the state where `installed` is full and
   *  every server nonetheless still resolves through the npx cache, so a
   *  consumer reporting install health has to look here and not only at
   *  `error`. Empty on the paths that installed nothing, where the question
   *  does not arise. */
  unhosted: string[];
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
    updateError: null,
    unhosted: [],
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
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(isWindows ? "npm.cmd" : "npm", args, {
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
    } catch {
      // spawn can fail SYNCHRONOUSLY rather than emitting 'error' -- an option
      // the platform rejects (the EINVAL above, before the shell workaround) or
      // a cwd that vanished between mkdir and here. Without this catch the
      // throw escapes the executor, rejects runSidecarsInstall, and the CLI
      // prints a raw Node message instead of the "keeps resolving from the npx
      // cache" degradation the ENOENT path reports. Same -1 as that path.
      resolve(-1);
      return;
    }
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

/**
 * Why NOTHING will read the tree this command just filled -- the distinct
 * reasons, or [] when at least one server would be hosted on oam.
 *
 * collectSidecarSpecs filters on `command === "npx"` and nothing else -- it
 * cannot see per-server `runtime: "node"`, the config default, or whether oam
 * is installed at all. But the managed tree is consumed ONLY by resolveNpmEntry
 * on the oam rewrite path (oam-spawn.ts): a server that resolves to the node
 * runtime spawns through npx and never looks here. So on a machine with no oam,
 * "These versions are now fixed" on its own is a claim the user cannot act on
 * -- every spawn still goes through the npx cache. Say which gate is closed,
 * using describeServerRuntime's own reason strings so this and doctor cannot
 * drift apart.
 *
 * The install is still worth having in that state -- the copies are used the
 * moment oam arrives -- so this is a note, not a failure.
 *
 * Returns the REASONS rather than the finished prose so the human note and the
 * `--json` document are the same verdict rendered twice, not two computations
 * that can disagree. The probe is paid for in both modes deliberately: the
 * cheaper alternative was skipping it under `--json`, but the caller that most
 * needs this answer is a script -- the Yaw Terminal MCP panel shells out to
 * `sidecars install --json` and would otherwise read a full `installed` array
 * with `error: null` as a healthy install on a machine where every server still
 * resolves through the npx cache. probeOam is process-cached, so the cost is one
 * `oam --version` per run.
 */
async function unhostedReasons(
  servers: Array<Partial<UpstreamServerConfig>>,
  opts: SidecarsInstallOptions,
  home: string,
): Promise<string[]> {
  const npx = servers.filter((s) => s.type === "local" && s.command === "npx");
  if (npx.length === 0) return [];
  const probe = await (opts.oamProbe ?? probeOam)();
  const { runtime: configDefault } = await describeDefaultRuntime({ cwd: opts.cwd, home });
  const verdicts = npx.map((s) =>
    // `args` rides along because describeServerRuntime now mirrors
    // rewriteForOam's launch-shape gates too: a spec it refuses (a git/path
    // target, a version range, an npx flag yaw-mcp does not parse) never
    // reaches oam, and dropping the args here would report those servers as
    // hosted while the spawn keeps npx.
    describeServerRuntime(
      { type: "local", command: s.command, args: s.args, runtime: s.runtime },
      configDefault,
      probe,
    ),
  );
  if (verdicts.some((v) => v.runtime === "oam")) return [];
  return [...new Set(verdicts.map((v) => v.reason))];
}

export async function runSidecarsInstall(opts: SidecarsInstallOptions = {}): Promise<SidecarsInstallResult> {
  const home = opts.home ?? homedir();
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const lines: string[] = [];
  const print = (s = "") => {
    lines.push(s);
    if (!opts.json) write(`${s}\n`);
  };

  const printErr = opts.err ?? ((s: string) => process.stderr.write(`${s}\n`));

  const bundles = await loadLocalBundles({ cwd: opts.cwd, home });
  // Surface the loader's diagnostics, the way bundles-cmd and local-add-cmd
  // already do. Without this an invalid JSON / non-array `servers` / EACCES
  // read reached the user as "you have no servers" with the one line that names
  // the actual defect thrown away. stderr, so a `--json` consumer's stdout stays
  // parseable.
  for (const w of bundles.warnings) printErr(`warning: ${w}`);

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
    // Four different empty states, and telling a first-time user with no config
    // at all that their bundles.json has no npx servers describes a file that
    // does not exist. Each wants a different next step.
    //
    // A null `config` is TWO of them, which is the distinction this branch
    // exists to keep: loadLocalBundles also returns config=null for a file that
    // IS there and could not be used -- invalid JSON, a non-array `servers`, an
    // EACCES read -- and it reports which by leaving `path` set. Reporting that
    // as "no servers configured yet" tells the user to add a server to a file
    // whose real problem is that it cannot be parsed, and hands a scripted
    // caller `reason: "no-config", error: null` for a broken machine.
    if (bundles.config === null && bundles.path !== null) {
      // Non-zero, and `error` non-null with it: nothing was installed and the
      // cause is a defect the user has to fix, not an empty config. The npm-
      // failure path below reports the same shape for the same reason.
      const detail =
        bundles.warnings.length > 0 ? bundles.warnings.join("; ") : `${bundles.path}: could not be read or parsed`;
      print(`Could not read ${bundles.path} -- nothing to install.`);
      print("Fix the file (the warning above says what is wrong), then run this again.");
      if (opts.json) write(jsonDocument(root, { reason: "unreadable-config", error: detail }));
      return { exitCode: 1, installed: [], lines };
    }
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
  // Name the config the list came from. The managed tree is keyed on HOME
  // alone, while the server list can come from an approved PROJECT
  // bundles.json -- so an install run in project A writes A's dependency set
  // into the one directory every project shares, and npm prunes whatever B put
  // there. The broker in B then resolves out of that same tree (managed wins
  // over the npx cache, oam-spawn.ts), on A's versions, with nothing in B to
  // say why. The in-config conflict note below cannot see this: it compares
  // specs WITHIN one config. Naming the source is the cheap half of the fix.
  if (bundles.path !== null) {
    print(`  from ${bundles.path}`);
    if (bundles.path !== localBundlesPath(userConfigDir(home))) {
      print(`  note: ${root} is shared by every project on this machine; installing from a project`);
      print("        bundles.json replaces what another project's install put there.");
    }
  }
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

  // The second step is what makes "re-run this command to move them forward"
  // true. `npm install` CANNOT re-resolve a dist-tag against an existing tree:
  // with a lockfile present, arborist's dep-valid treats a `tag` spec as
  // satisfied by ANY node that already carries a `resolved` URL, so a package
  // locked at 0.3.6 under a `latest` range reports "up to date" and stays
  // there. Measured against npm on a real tree -- dep at 3.0.0 with the spec
  // rewritten to `latest` and 3.0.1 published: `install` printed "up to date"
  // and left 3.0.0; `update` moved it to 3.0.1. Without this the version pins
  // itself permanently, which is the exact failure this module exists to fix.
  //
  // `update` honours the manifest's ranges, so an exact-pinned spec
  // (`pkg@1.0.0`) still cannot drift -- only the ranges that asked to float do.
  // Fixed literals only, like the install above: see defaultRunNpm on why the
  // Windows shell is safe here, and do not interpolate a package name.
  const updateCode = await runNpm(["update", "--no-audit", "--no-fund"], root);
  const updateError = updateCode === 0 ? null : `npm update exited ${updateCode}`;

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
  if (updateError !== null) {
    print();
    print(`npm update failed (exit ${updateCode}). The installed copies are usable, but a server`);
    print('configured "@latest" may still be on the version it was already on.');
  }
  print();
  print("These versions are now fixed. Re-run this command to move them forward.");
  const unhosted = await unhostedReasons(servers, opts, home);
  if (unhosted.length > 0) {
    print();
    print("Nothing reads these copies yet:");
    for (const reason of unhosted) print(`  ${reason}`);
    print("Those servers keep resolving through the npx cache; the managed copies are read only");
    print("on the oam runtime.");
  }

  // npm exited 0 but not one requested package resolved in the tree. A
  // scripted caller has to be able to tell that from a real install, so it
  // exits non-zero AND fills in `error` -- the field this document exists to
  // make the single success/failure discriminator. Reporting exit 1 with
  // `error: null` meant a consumer branching on `error` read it as clean.
  const nothingLanded = missing.length === installed.length;
  const error = nothingLanded ? "npm exited 0 but no requested package resolved in the managed tree" : null;

  if (opts.json) write(jsonDocument(root, { installed, conflicts, skipped, error, updateError, unhosted }));
  return { exitCode: nothingLanded ? 1 : 0, installed, lines };
}

/** True when a managed install exists. Lets a caller skip the per-package
 *  reads entirely when the tree was never created. */
export function hasManagedSidecars(home: string = homedir()): boolean {
  return existsSync(sidecarsNodeModules(home));
}
