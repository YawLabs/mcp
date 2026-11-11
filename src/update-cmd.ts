// `yaw-mcp update [<name>]`: move git servers (`add --git`) forward.
//
// One verb apart from `upgrade`, which updates yaw-mcp itself; the help and
// the "no git servers" answer both say so.
//
//   update [name]     re-resolve the tracked ref, build the new commit beside
//                     the current build, then repoint bundles.json
//   update --check    ls-remote only: behind / up to date / pinned, plus
//                     newer version tags; recorded in ~/.yaw-mcp/git/state.json
//                     so doctor can report it without asking the remote
//   update --to <sha> back to a build kept on this machine
//
// A failed build changes nothing: the pin stays, the old build keeps running,
// and the command exits 1. So does a build that finishes but then fails its
// start check (the one real handshake): the entry reports `status: "failed"`
// with `started: false` and the reason, and the command exits 1 with
// `ok: false`. On a move to a new commit bundles.json is not touched (no
// commit, ref or token change is written): the previous build stays pinned
// and on disk, and the new build is left on disk unpinned (the next GC takes
// it), so a re-run once the cause is fixed reuses it. When the commit does not
// move (only --ref or --git-token-secret changed) the build that failed is the
// pinned build itself, so the server is already broken and refusing the
// change would protect nothing: the ref / token change IS written, the entry's
// `to` is that unmoved commit, and its error says the change was written and
// the pinned build does not start.
// --no-start-check runs no check, so there is nothing to fail. Ctrl+C at a
// repo's script-consent prompt stops the run with exit 130.
// Only `git.commit` (and `ref` / `tokenSecret` when
// asked) is spliced into the file, so comments survive. Old builds are
// collected under the git lock, keeping the current and the previous one and
// every build any bundles.json still pins -- the user file, every trusted
// project file, the project file found from cwd, and the files refs.json
// records -- since the build directory is shared by namespace across all of
// them, and it deletes nothing when one of those cannot be read. A project
// file is read only once the loader would honour it.

import { homedir } from "node:os";
import { join } from "node:path";
import { scriptConsentConfirm } from "./git-consent-prompt.js";
import {
  asciiLines,
  buildGitSource,
  buildMatchesHost,
  discardBuild,
  forgetGitPin,
  GIT_MISSING_MESSAGE,
  type GitBuildContext,
  type GitBuildResult,
  type GitRefKind,
  type GitSpec,
  type GitStateEntry,
  gcGitBuilds,
  gitAvailable,
  gitLivenessWarning,
  gitRefProblem,
  keptBuilds,
  listRemoteRefs,
  newerTags,
  normalizeRepoUrl,
  type PreparedGit,
  parseGitSpec,
  prepareGit,
  readGitState,
  recordGitPin,
  resolveRefIn,
  scrubRepoUrlUserinfo,
  writeGitState,
} from "./git-source.js";
import { defaultStartCheck, startFailureTail } from "./local-add-cmd.js";
import {
  type GitPinPatch,
  gitNodeCommand,
  gitSourceFromRaw,
  localBundlesPath,
  probeProjectTrust,
  projectFileIsHonoured,
  readBundlesServersSync,
  updateGitPin,
} from "./local-bundles.js";
import { createStreamWriter } from "./logger.js";
import { findProjectConfigDir, userConfigDir } from "./paths.js";
import type { YesNoOptions } from "./readline-question.js";
import { SECRET_NAME_RE } from "./secrets-vault.js";
import type { GitSource, UpstreamServerConfig } from "./types.js";

export const UPDATE_USAGE = `Usage: yaw-mcp update [<name>] [--check] [--ref <ref>] [--to <sha>]
                      [--git-token-secret <name>] [--project] [--yes]
                      [--no-start-check] [--json]

  Move git servers (added with yaw-mcp add --git) to the commit the ref they
  track points at now. The new commit is built beside the current build, and
  only then does bundles.json point at it. With no name, every git server in
  the file. A server tracking a tag or a commit is pinned: it is reported, not
  moved. This does not update yaw-mcp itself -- that is yaw-mcp upgrade.

  --check           Only ask the remote (git ls-remote): report each server
                    as up to date, behind, or pinned, and the newer version
                    tags for one tracking a tag. Builds nothing.
  --ref <ref>       Track another branch, tag or commit (one server).
  --to <sha>        Go back to a build kept on this machine (one server). The
                    current build and the one before it are kept, and so is
                    any build another bundles.json here still pins.
  --git-token-secret <name>
                    HTTPS only: the vault secret holding a token (one server).
  --project         The project's .yaw-mcp/bundles.json instead of yours. Only
                    the pin changes, and comments survive; commit the file.
  --yes, -y         Allow a repo's install and build scripts to run. Asked
                    once per repo; when stdin or stdout is not a TTY, required
                    until the repo is allowed here. Ctrl+C at that question
                    stops the run (exit 130).
  --no-start-check  Skip the one real handshake after the build. Without this
                    flag a build that fails the handshake is reported with
                    why it did not start, and the exit code is 1. On a move
                    to a new commit nothing in bundles.json changes (no new
                    commit, --ref or token is written) and the previous build
                    stays pinned. When the commit does not move, the build
                    that failed is the one already pinned: a --ref or token
                    change is still written, and the output says so.
  --json            Print a JSON document.`;

export interface UpdateCommandOptions {
  name?: string;
  check?: boolean;
  ref?: string;
  to?: string;
  gitTokenSecret?: string;
  project?: boolean;
  yes?: boolean;
  noStartCheck?: boolean;
  json?: boolean;
  /** Test seams, as `add --git` has them. */
  isTTY?: boolean;
  promptAnswer?: string;
  io?: YesNoOptions["io"];
  runPm?: GitBuildContext["runPm"];
  resolveToken?: GitBuildContext["resolveToken"];
  startCheck?: (config: UpstreamServerConfig) => Promise<{ ok: true; tools: number } | { ok: false; error: string }>;
  now?: () => Date;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

type Parsed<T> = { ok: true; options: T } | { ok: false; error: string; help?: boolean };

export function parseUpdateArgs(argv: string[]): Parsed<UpdateCommandOptions> {
  const opts: UpdateCommandOptions = {};
  const usage = (msg: string): { ok: false; error: string } => ({
    ok: false,
    error: `yaw-mcp update: ${msg}\n\n${UPDATE_USAGE}`,
  });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) return null;
      i++;
      return v;
    };
    switch (a) {
      case "--check":
        opts.check = true;
        break;
      case "--project":
        opts.project = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--no-start-check":
        opts.noStartCheck = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        return { ok: false, error: UPDATE_USAGE, help: true };
      case "--ref": {
        const v = value();
        if (v === null) return usage("--ref requires a branch, tag or commit");
        const problem = gitRefProblem(v);
        if (problem) return usage(`--ref: ${problem}`);
        opts.ref = v;
        break;
      }
      case "--to": {
        const v = value();
        if (v === null || !/^[0-9a-f]{4,40}$/i.test(v)) return usage("--to requires a commit SHA (4 to 40 hex digits)");
        opts.to = v.toLowerCase();
        break;
      }
      case "--git-token-secret": {
        const v = value();
        if (v === null || !SECRET_NAME_RE.test(v)) return usage("--git-token-secret requires a vault secret name");
        opts.gitTokenSecret = v;
        break;
      }
      default:
        if (a.startsWith("-")) return usage(`unknown flag "${a}"`);
        if (opts.name !== undefined) return usage(`one server at a time; got "${opts.name}" and "${a}"`);
        opts.name = a;
    }
  }
  const single = [opts.ref && "--ref", opts.to && "--to", opts.gitTokenSecret && "--git-token-secret"].filter(Boolean);
  if (single.length > 0 && opts.name === undefined) return usage(`${single.join(" and ")} needs a server name`);
  if (opts.ref && opts.to) return usage("--ref and --to cannot be combined");
  if (opts.check && single.length > 0) return usage(`--check cannot be combined with ${single.join(" or ")}`);
  return { ok: true, options: opts };
}

/// --- reading the file ---------------------------------------------------------

/** A git entry as bundles.json spells it, before the loader derives a launch. */
export interface RawGitEntry {
  namespace: string;
  slug?: string;
  git: GitSource;
  args: string[];
  env: Record<string, string>;
  description?: string;
}

export interface GitEntriesFile {
  path: string;
  /** Set for a project file. */
  configDir?: string;
  entries: RawGitEntry[];
  /** Every other entry's namespace and slug, to tell "not a git server" from
   *  "no such server". `refused`: a git entry the loader would refuse. */
  others: Array<{ namespace: string; slug?: string; refused?: true }>;
  /** The loader's skip warnings for git entries it would refuse. */
  warnings: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The git entries of one bundles.json, each checked the way the loader
 *  checks it; a missing file has none. */
export function readGitEntries(path: string, configDir?: string): GitEntriesFile | { error: string } {
  const read = readBundlesServersSync(path);
  const base = { path, ...(configDir ? { configDir } : {}) };
  if (read.kind === "absent") return { ...base, entries: [], others: [], warnings: [] };
  if (read.kind === "error") return { error: read.message };
  const entries: RawGitEntry[] = [];
  const others: GitEntriesFile["others"] = [];
  const warnings: string[] = [];
  for (const s of read.servers) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const namespace = str(o.namespace);
    if (!namespace) continue;
    const slug = str(o.slug);
    const git = o.git === undefined ? null : gitSourceFromRaw(o.git, namespace, warnings);
    if (!git) {
      others.push({ namespace, ...(slug ? { slug } : {}), ...(o.git !== undefined ? { refused: true as const } : {}) });
      continue;
    }
    const env: Record<string, string> = {};
    if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
    }
    entries.push({
      namespace,
      ...(slug ? { slug } : {}),
      git,
      args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [],
      env,
      ...(str(o.description) ? { description: str(o.description) } : {}),
    });
  }
  return { ...base, entries, others, warnings };
}

/** The user's bundles.json, or with `project` the project's. */
export async function targetBundlesFile(
  project: boolean,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; configDir?: string } | { error: string }> {
  if (!project) return { path: localBundlesPath(userConfigDir(home)) };
  const dir = await findProjectConfigDir(cwd, home, env).catch(() => null);
  if (!dir) return { error: `no project .yaw-mcp/ directory at or above ${cwd}.` };
  return { path: localBundlesPath(dir), configDir: dir };
}

/**
 * The git entries of the user file or (`project`) the project file -- the
 * latter only once the loader would honour it. An untrusted project file
 * names the URL git is sent to and the vault secret handed to it, so nothing
 * here reads one, resolves its secret or spawns git for it.
 */
export async function readTargetGitEntries(
  project: boolean,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<GitEntriesFile | { error: string }> {
  const target = await targetBundlesFile(project, home, cwd, env);
  if ("error" in target) return target;
  if (target.configDir !== undefined) {
    const probe = await probeProjectTrust({ cwd, home, env });
    if (probe.path !== null && probe.status !== "none" && !projectFileIsHonoured(probe)) {
      return { error: `${target.path} is not trusted; review it with yaw-mcp trust` };
    }
  }
  return readGitEntries(target.path, target.configDir);
}

/** Find `name` (a namespace or slug) among the file's entries. */
export function pickGitEntry(
  file: GitEntriesFile,
  name: string,
): { ok: true; entry: RawGitEntry } | { ok: false; exitCode: number; message: string } {
  const hit = file.entries.find((e) => e.namespace === name || e.slug === name);
  if (hit) return { ok: true, entry: hit };
  const other = file.others.find((o) => o.namespace === name || o.slug === name);
  if (other?.refused) {
    return {
      ok: false,
      exitCode: 2,
      message: `"${name}" has a git block yaw-mcp refuses (see the warning above); nothing was run.`,
    };
  }
  if (other) {
    return {
      ok: false,
      exitCode: 2,
      message: `"${name}" is not a git server (yaw-mcp add --git). To update yaw-mcp itself, run: yaw-mcp upgrade`,
    };
  }
  return { ok: false, exitCode: 1, message: `no server named "${name}" in ${file.path}.` };
}

// --- running ------------------------------------------------------------------

export type UpdateStatus = "current" | "behind" | "pinned" | "missing" | "updated" | "rolled-back" | "failed";

export interface UpdateReport {
  namespace: string;
  ref: string | null;
  kind: GitRefKind | null;
  /** The commit pinned before this run. */
  from: string | null;
  /** The commit pinned after it (or, under --check, the remote's). */
  to: string | null;
  status: UpdateStatus;
  commits: number | null;
  newerTags: string[];
  error: string | null;
  /** Did the new build start? null when no start check ran. */
  started: boolean | null;
  /** Why it did not, redacted; null otherwise. */
  startError: string | null;
}

const sha7 = (c: string | null | undefined): string => (c ? c.slice(0, 7) : "(none)");

function interactiveFor(opts: UpdateCommandOptions): boolean {
  if (opts.json) return false;
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function statusText(r: UpdateReport): string {
  const tags = r.newerTags.length > 0 ? `; newer tags: ${r.newerTags.join(", ")}` : "";
  switch (r.status) {
    case "current":
      return `up to date${tags}`;
    case "behind":
      return `behind (${sha7(r.to)})`;
    case "pinned":
      return `pinned (${r.kind === "tag" ? "tag" : "commit"}), nothing to update${tags}`;
    case "missing":
      return "ref not found on the remote";
    case "updated":
      return `updated to ${sha7(r.to)}`;
    case "rolled-back":
      return `rolled back to ${sha7(r.to)}`;
    default:
      return "failed";
  }
}

export async function runUpdate(opts: UpdateCommandOptions = {}): Promise<{ exitCode: number }> {
  const out = opts.out ?? createStreamWriter(process.stdout);
  const err = opts.err ?? createStreamWriter(process.stderr);
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${asciiLines(s)}\n`);
  // Progress belongs with the result on a terminal, and off stdout under
  // --json, where stdout is the document.
  const progress = opts.json ? printErr : (s: string) => print(asciiLines(s));
  const warn = (w: string): void => printErr(`warning: ${w}`);
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const interactive = interactiveFor(opts);
  const now = opts.now ?? (() => new Date());
  const fail = (exitCode: number, message: string): { exitCode: number } => {
    // Under --json the failure is the result, so it leaves as a document on
    // stdout alongside the human line on stderr -- a caller must not have to
    // tell an empty stdout apart from a silent success. No entry has been
    // touched at any point fail() is reachable, so the doc stays truthful.
    if (opts.json) print(JSON.stringify({ ok: false, error: `yaw-mcp update: ${message}`, exitCode }, null, 2));
    printErr(`yaw-mcp update: ${message}`);
    return { exitCode };
  };

  const file = await readTargetGitEntries(opts.project === true, home, cwd, env);
  if ("error" in file) return fail(1, file.error);
  for (const w of file.warnings) warn(w);
  let entries = file.entries;
  if (opts.name !== undefined) {
    const pick = pickGitEntry(file, opts.name);
    if (!pick.ok) return fail(pick.exitCode, pick.message);
    entries = [pick.entry];
  }
  if (entries.length === 0) {
    if (opts.json)
      print(JSON.stringify({ ok: true, path: file.path, check: opts.check === true, entries: [] }, null, 2));
    else {
      print(`No git servers in ${file.path} (they are added with yaw-mcp add --git).`);
      print("To update yaw-mcp itself, run: yaw-mcp upgrade");
    }
    return { exitCode: 0 };
  }
  // `--to` is the one mode that can finish without git: a kept build made for
  // this host is re-pinned from disk. rollBack asks for git itself, and only
  // on its rebuild path, so a machine that lost git can still go back.
  if (opts.to === undefined && !(await gitAvailable({ env, interactive }))) return fail(2, GIT_MISSING_MESSAGE);

  const state: Record<string, GitStateEntry> = {};
  const reports: UpdateReport[] = [];
  let projectTrust: "regranted" | "untrusted" | undefined;
  // Ctrl+C at a repo's consent prompt: the entries after it are not tried.
  let cancelled = false;
  const buildCtx = (prepared?: PreparedGit): GitBuildContext => ({
    home,
    env,
    interactive,
    yes: opts.yes === true,
    progress: (l) => progress(`  ${l}`),
    warn,
    // Ctrl+C there fails the build with `cancelled`, and the loop stops.
    confirm: scriptConsentConfirm(opts, print),
    runPm: opts.runPm,
    resolveToken: opts.resolveToken,
    ...(prepared ? { git: prepared } : {}),
    now,
  });

  for (const e of entries) {
    const base: UpdateReport = {
      namespace: e.namespace,
      ref: e.git.ref ?? null,
      kind: null,
      from: e.git.commit ?? null,
      to: null,
      status: "failed",
      commits: null,
      newerTags: [],
      error: null,
      started: null,
      startError: null,
    };
    const failed = (message: string, status: UpdateStatus = "failed"): void => {
      const error = asciiLines(message);
      reports.push({ ...base, status, error });
      printErr(`yaw-mcp update: ${e.namespace}: ${error}`);
    };
    // `onFail` replaces the default failure entry when the caller has a truer
    // one to push (the same-commit start-check failure below).
    const writePin = async (patch: GitPinPatch, onFail?: (message: string) => void): Promise<boolean> => {
      try {
        const w = await updateGitPin(e.namespace, e.git.commit, patch, {
          home,
          ...(file.configDir ? { configDir: file.configDir } : {}),
        });
        projectTrust = w.projectTrust ?? projectTrust;
        return true;
      } catch (x) {
        // updateGitPin writes nothing when it throws.
        if (onFail) onFail((x as Error).message);
        else failed(`${(x as Error).message}\nThe pin did not move.`);
        return false;
      }
    };
    const parsed = parseGitSpec(e.git.url);
    if (!parsed.ok) {
      failed(parsed.error);
      continue;
    }
    const tokenSecret = opts.gitTokenSecret ?? e.git.tokenSecret;
    // Only an HTTPS URL sends a token; prepareGit warns that one is ignored.
    const tokenChanged =
      opts.gitTokenSecret !== undefined &&
      opts.gitTokenSecret !== e.git.tokenSecret &&
      parsed.spec.protocol === "https";
    const tokenPatch = tokenChanged ? { tokenSecret: opts.gitTokenSecret } : {};
    const tokenNote = (): void => {
      if (tokenChanged && !opts.json) print(`  It now authenticates with vault secret ${opts.gitTokenSecret}.`);
    };

    // A rollback to a build on disk needs no remote, so no token either: the
    // vault is read only when the kept build must be rebuilt for this host.
    if (opts.to !== undefined) {
      const r = await rollBack(e, parsed.spec, opts.to, tokenSecret, buildCtx(), file.path, { cwd, env });
      if (!r.ok) {
        // Same exit 2 and same document as the gate the other modes pass
        // before the loop. Nothing has been touched when no entry has been
        // reported yet -- and `--to` names one server, so none has.
        if (r.gitMissing && reports.length === 0) return fail(2, GIT_MISSING_MESSAGE);
        failed(r.message);
        if (r.cancelled) {
          cancelled = true;
          break;
        }
        continue;
      }
      const moved = r.commit !== e.git.commit;
      if ((moved || tokenChanged) && !(await writePin({ commit: r.commit, ...tokenPatch }))) continue;
      if (moved) {
        // The last check's remote tip is still what it was; only the pin moved.
        const prev = readGitState(home)[e.namespace];
        if (prev && typeof prev === "object" && normalizeRepoUrl(prev.url ?? "") === normalizeRepoUrl(e.git.url)) {
          state[e.namespace] = { ...prev, pinned: r.commit };
        }
        // GC BEFORE the record: recording repairs a refs.json that does not
        // parse, and a GC that ran after it would see a clean file naming only
        // this build -- deleting everything the corrupt one held.
        await collect(e.namespace, [r.commit, e.git.commit], home, warn, { cwd, env });
      }
      await recordGitPin(e.namespace, file.path, r.commit, home, warn);
      reports.push({ ...base, to: r.commit, status: moved ? "rolled-back" : "current" });
      if (!opts.json) {
        if (!moved) {
          print(`${e.namespace}  already at ${sha7(r.commit)}${r.rebuilt ? "; rebuilt for this machine" : ""}.`);
        } else {
          print(
            `Rolled back "${e.namespace}" to ${sha7(r.commit)}.${e.git.commit ? ` Previous build kept: yaw-mcp update ${e.namespace} --to ${sha7(e.git.commit)}` : ""}`,
          );
        }
      }
      tokenNote();
      continue;
    }

    const prepared = await prepareGit(parsed.spec, tokenSecret, {
      home,
      env,
      interactive,
      warn,
      resolveToken: opts.resolveToken,
    });
    if (!prepared.ok) {
      failed(prepared.message);
      continue;
    }
    const listed = await listRemoteRefs(parsed.spec, prepared, tokenSecret, file.configDir !== undefined);
    if (!listed.ok) {
      failed(`${listed.message}\nNothing was changed; the current build keeps working.`);
      continue;
    }
    const ref = opts.ref ?? e.git.ref;
    const resolved = resolveRefIn({ ...parsed.spec, ref }, listed);
    if (!resolved.ok) {
      state[e.namespace] = stateEntry(e, null, null, null, [], now);
      failed(`${resolved.message}\nNothing was changed; the current build keeps working.`, "missing");
      continue;
    }
    const tags = resolved.kind === "tag" ? newerTags(resolved.ref, listed.refs) : [];
    const remote = resolved.commit ?? null;
    state[e.namespace] = stateEntry(e, resolved.ref, resolved.kind, remote, tags, now);
    const pinnedKind = resolved.kind === "tag" || resolved.kind === "sha";
    const report: UpdateReport = { ...base, ref: resolved.ref, kind: resolved.kind, newerTags: tags };

    if (opts.check) {
      const status: UpdateStatus = pinnedKind ? "pinned" : remote === e.git.commit ? "current" : "behind";
      reports.push({ ...report, to: remote, status });
      continue;
    }
    const moving = opts.ref !== undefined;
    if (!moving && pinnedKind) {
      // Nothing to move, but a new token is still the user's to keep.
      if (tokenChanged && !(await writePin({ ...tokenPatch }))) continue;
      if (e.git.commit) await recordGitPin(e.namespace, file.path, e.git.commit, home, warn);
      reports.push({ ...report, to: e.git.commit ?? null, status: "pinned" });
      if (!opts.json)
        print(`${e.namespace}  ${resolved.ref}  ${sha7(e.git.commit)}  ${statusText(reports.at(-1) as UpdateReport)}`);
      tokenNote();
      continue;
    }
    const refChanged = moving && resolved.ref !== e.git.ref;
    if (remote !== null && remote === e.git.commit && !refChanged && !tokenChanged) {
      await recordGitPin(e.namespace, file.path, remote, home, warn);
      reports.push({ ...report, to: remote, status: "current" });
      if (!opts.json) print(`${e.namespace}  ${resolved.ref}  ${sha7(remote)}  up to date`);
      continue;
    }
    const want = resolved.commit ?? resolved.shortSha ?? "";
    progress(`${e.namespace}  ${resolved.ref}  ${sha7(e.git.commit)} -> ${want.slice(0, 7)}`);
    const ancestor = !moving && e.git.commit && (resolved.kind === "branch" || resolved.kind === "head");
    const build = await buildGitSource(
      {
        spec: parsed.spec,
        ref: resolved.ref,
        commit: want,
        namespace: e.namespace,
        subdir: e.git.subdir ?? "",
        entry: e.git.entry,
        ...(tokenSecret ? { tokenSecret } : {}),
        ...(ancestor ? { ancestor: e.git.commit } : {}),
        shared: file.configDir !== undefined,
        pinFile: file.path,
      },
      buildCtx(prepared),
    );
    if (!build.ok) {
      failed(build.message);
      if (build.cancelled) {
        cancelled = true;
        break;
      }
      continue;
    }
    const started = opts.noStartCheck ? null : await startCheck(e, build, opts);
    if (started) progress(`  Checking it starts ... ${started.ok ? `ok -- ${started.tools} tools` : "failed"}`);
    if (started && !started.ok) {
      // The build finished but does not start. Nothing is collected. Three
      // cases:
      //  - a real move (a new commit over a pinned one): not one byte of
      //    bundles.json is written -- no commit, and no ref or token change
      //    either, since they are part of the same update. The pinned build
      //    stays, and the new build stays on disk unpinned for a re-run to
      //    reuse once the cause is fixed (the next GC removes it otherwise);
      //  - the same commit under a new --ref or --git-token-secret: the build
      //    that failed IS the pinned one, so the server is already broken and
      //    refusing the change protects nothing (a token only authenticates
      //    the clone). The ref / token change is written as asked, the pin
      //    stays where it was, and the entry still fails (exit 1, ok: false)
      //    because the server does not start. If that write itself fails, the
      //    entry says so, keeps the old ref, and still reports the check;
      //  - an entry with no commit pinned: there is no previous build, and
      //    bundles.json is not written.
      // buildGitSource recorded this file in refs.json as using the new build:
      // put the record back on the pin the file still holds, or drop it when
      // the file pins no commit, so GC does not keep a build nothing pins.
      if (e.git.commit) await recordGitPin(e.namespace, file.path, e.git.commit, home, warn);
      else await forgetGitPin(e.namespace, file.path, build.commit, home, warn);
      const startError = startFailureTail(started.error, prepared.secrets);
      if (e.git.commit && build.commit === e.git.commit) {
        // Same commit: the failed build is the pinned one. Write the ref /
        // token change anyway. A write that fails still reports the start
        // check that ran, with the ref the file still holds.
        const changed = refChanged || tokenChanged;
        // Only builds `--to` accepts: rollBack refuses one made from another
        // repository URL.
        const others = keptBuilds(e.namespace, home)
          .filter((k) => normalizeRepoUrl(k.marker.url) === normalizeRepoUrl(e.git.url))
          .map((k) => k.marker.commit)
          .filter((c) => c !== build.commit);
        const project = file.configDir !== undefined ? " --project" : "";
        const back =
          others.length > 0
            ? `, or go back to a build kept on this machine: yaw-mcp update ${e.namespace} --to <sha>${project} (kept: ${others.map(sha7).join(", ")})`
            : "";
        const head = `the pinned build ${sha7(build.commit)} itself does not start: ${startError}\n`;
        // `from` is the entry the file holds after this branch: `base` (the
        // old ref, with no kind or newerTags worked out for it) when the write
        // failed, `report` (the new ref and its metadata) otherwise.
        const report1 = (from: UpdateReport, message: string): void => {
          const error = asciiLines(message);
          reports.push({ ...from, to: build.commit, status: "failed", error, started: false, startError });
          printErr(`yaw-mcp update: ${e.namespace}: ${error}`);
        };
        const patch = { ...(refChanged ? { ref: resolved.ref } : {}), ...tokenPatch };
        let writeError: string | null = null;
        if (changed && !(await writePin(patch, (m) => (writeError = m)))) {
          report1(
            base,
            `${head}The ${refChanged && tokenChanged ? "ref and token changes" : refChanged ? "ref change" : "token change"} could NOT be written to bundles.json: ${writeError}\nNothing was changed, and "${e.namespace}" still does not start. Fix the cause${back}.`,
          );
          continue;
        }
        const written = [
          ...(refChanged ? [`"${e.namespace}" now tracks ${resolved.ref}`] : []),
          ...(tokenChanged ? [`it authenticates with vault secret ${opts.gitTokenSecret}`] : []),
        ].join(", and ");
        report1(
          report,
          head +
            (changed
              ? `The change was written to bundles.json anyway (${written}); the commit did not move, so "${e.namespace}" still does not start.`
              : `Nothing was written to bundles.json; "${e.namespace}" still does not start.`) +
            ` Fix the cause${back}.`,
        );
        continue;
      }
      const rerun = [
        `yaw-mcp update ${e.namespace}`,
        ...(refChanged ? [`--ref ${resolved.ref}`] : []),
        ...(tokenChanged ? [`--git-token-secret ${opts.gitTokenSecret}`] : []),
        ...(file.configDir !== undefined ? ["--project"] : []),
      ].join(" ");
      const error = asciiLines(
        e.git.commit
          ? `${sha7(build.commit)} built but did not start: ${startError}\nNothing was changed: "${e.namespace}" stays on ${sha7(e.git.commit)}, which keeps running. Fix the cause and run ${rerun} again (the new build stays on disk until the next cleanup, so a re-run of the same commit does not rebuild it), or pin it without the check: ${rerun} --no-start-check`
          : `${sha7(build.commit)} built but did not start: ${startError}\nNothing was changed: "${e.namespace}" has no commit pinned, and bundles.json was not written. Fix the cause and run ${rerun} again (the new build stays on disk until the next cleanup, so a re-run of the same commit does not rebuild it), or pin it without the check: ${rerun} --no-start-check`,
      );
      reports.push({ ...report, status: "failed", commits: build.ahead ?? null, error, started: false, startError });
      printErr(`yaw-mcp update: ${e.namespace}: ${error}`);
      continue;
    }
    if (!(await writePin({ commit: build.commit, ...(refChanged ? { ref: resolved.ref } : {}), ...tokenPatch }))) {
      continue;
    }
    state[e.namespace] = { ...stateEntry(e, resolved.ref, resolved.kind, remote, tags, now), pinned: build.commit };
    // The same commit under a new ref or token moved nothing, so nothing goes.
    if (build.commit !== e.git.commit)
      await collect(e.namespace, [build.commit, e.git.commit], home, warn, { cwd, env });
    const commits = build.ahead ?? null;
    reports.push({
      ...report,
      to: build.commit,
      status: "updated",
      commits,
      started: started === null ? null : true,
    });
    if (!opts.json) {
      const count = commits !== null ? ` (${commits} commit${commits === 1 ? "" : "s"})` : "";
      print(`Updated "${e.namespace}" to ${sha7(build.commit)}${count}.`);
      if (e.git.commit && e.git.commit !== build.commit) {
        print(`  Previous build kept: yaw-mcp update ${e.namespace} --to ${sha7(e.git.commit)}`);
      }
    }
    tokenNote();
  }

  try {
    await writeGitState(home, state);
  } catch (x) {
    warn(`could not record the check in ~/.yaw-mcp/git/state.json: ${(x as Error).message}`);
  }
  const bad = reports.some((r) => r.status === "failed" || r.status === "missing");
  if (opts.json) {
    print(
      JSON.stringify(
        {
          ok: !bad,
          path: file.path,
          check: opts.check === true,
          entries: reports,
          ...(projectTrust ? { projectTrust } : {}),
        },
        null,
        2,
      ),
    );
  } else if (opts.check) {
    const rows = reports.map((r) => [r.namespace, r.ref ?? "(default)", sha7(r.from), statusText(r)]);
    const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => (row[i] as string).length)));
    for (const row of rows) print(row.map((c, i) => (i < 3 ? c.padEnd(widths[i] as number) : c)).join("  "));
  }
  if (projectTrust === "regranted") {
    printErr(`Note: ${file.path} was trusted before this edit, so the new contents are trusted too. Commit it.`);
  } else if (projectTrust === "untrusted") {
    printErr(`Note: ${file.path} is not trusted on this machine, so it does not load until you run yaw-mcp trust.`);
  }
  // 130 (128 + SIGINT), as every prompt in the CLI exits for Ctrl+C. Only a
  // TTY run asks, so no --json document ever carries it.
  if (cancelled) return { exitCode: 130 };
  return { exitCode: bad ? 1 : 0 };
}

/** The git/state.json row for one entry. Its `url` is the entry's url with
 *  only the credential replaced (scrubRepoUrlUserinfo), so doctor's and
 *  share's normalizeRepoUrl comparisons still see the same host. Exported
 *  for tests. */
export function stateEntry(
  e: RawGitEntry,
  ref: string | null,
  kind: GitRefKind | null,
  remote: string | null,
  tags: string[],
  now: () => Date,
): GitStateEntry {
  return {
    url: scrubRepoUrlUserinfo(e.git.url),
    ref: ref ?? e.git.ref ?? null,
    kind,
    pinned: e.git.commit ?? null,
    remote,
    newerTags: tags,
    checkedAt: now().toISOString(),
  };
}

async function startCheck(
  e: RawGitEntry,
  build: GitBuildResult,
  opts: UpdateCommandOptions,
): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
  const pkgDir = join(build.dir, ...(build.subdir ?? "").split(/[\\/]/).filter(Boolean));
  // A check that throws is a check that failed: escaping here would end the
  // run half-way, with later entries untried and state.json unwritten.
  try {
    return await (opts.startCheck ?? defaultStartCheck)({
      id: `local-${e.namespace}`,
      name: e.namespace,
      namespace: e.namespace,
      type: "local",
      transport: "stdio",
      command: gitNodeCommand(),
      args: [join(pkgDir, ...build.entry.split(/[\\/]/)), ...e.args],
      cwd: pkgDir,
      ...(Object.keys(e.env).length > 0 ? { env: e.env } : {}),
      isActive: true,
    });
  } catch (x) {
    return { ok: false, error: x instanceof Error ? x.message : String(x) };
  }
}

/** `--to`: the kept build whose commit starts with `prefix`. One made for
 *  another platform, arch or node major is rebuilt first, and that rebuild is
 *  the only step here that runs git: it is checked for BEFORE the kept build
 *  is discarded, so a machine without git keeps the build it has. The discard
 *  has to come first (the builder would otherwise reuse the foreign build), so
 *  a rebuild that then fails says the foreign build is gone, instead of the
 *  builder's own "Nothing was changed". */
async function rollBack(
  e: RawGitEntry,
  spec: GitSpec,
  prefix: string,
  tokenSecret: string | undefined,
  ctx: GitBuildContext,
  pinFile: string,
  where: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<
  { ok: true; commit: string; rebuilt: boolean } | { ok: false; message: string; gitMissing?: true; cancelled?: true }
> {
  const kept = keptBuilds(e.namespace, ctx.home);
  const hits = kept.filter((k) => k.marker.commit.startsWith(prefix));
  if (hits.length === 0) {
    const names = kept.map((k) => sha7(k.marker.commit)).join(", ") || "none";
    return {
      ok: false,
      message: `no kept build of ${prefix} for "${e.namespace}" (kept: ${names}). To build another commit: yaw-mcp update ${e.namespace} --ref <sha>`,
    };
  }
  if (hits.length > 1) return { ok: false, message: `${prefix} matches more than one kept build; give more digits.` };
  const hit = hits[0] as (typeof hits)[number];
  if (normalizeRepoUrl(hit.marker.url) !== normalizeRepoUrl(e.git.url)) {
    return { ok: false, message: `the kept build ${sha7(hit.marker.commit)} was made from another repository.` };
  }
  if (buildMatchesHost(hit.marker)) return { ok: true, commit: hit.marker.commit, rebuilt: false };
  if (!(await gitAvailable({ env: ctx.env, interactive: ctx.interactive }))) {
    return { ok: false, message: GIT_MISSING_MESSAGE, gitMissing: true };
  }
  const discarded = await discardBuild(e.namespace, hit.marker.commit, ctx.home, where);
  if (!discarded.ok) return { ok: false, message: discarded.message };
  const target = hit.marker.commit;
  const pinStays =
    e.git.commit === target
      ? `"${e.namespace}" still pins ${sha7(target)}, which now has no build here; once the cause is fixed, build it with: yaw-mcp sidecars install`
      : `The pin did not move${e.git.commit ? ` (${sha7(e.git.commit)})` : ""}.`;
  const gone = `The kept build of ${sha7(target)} was made for another machine and was deleted to rebuild it. ${pinStays}`;
  const build = await buildGitSource(
    {
      spec,
      ...(e.git.ref ? { ref: e.git.ref } : {}),
      commit: target,
      namespace: e.namespace,
      subdir: e.git.subdir ?? "",
      entry: e.git.entry,
      ...(tokenSecret ? { tokenSecret } : {}),
      pinFile,
      unchanged: gone,
    },
    ctx,
  );
  if (!build.ok) {
    // `unchanged` reaches only an install or build failure; every other
    // failure (clone, checkout, a declined consent) gets the line here.
    const message = build.message.includes(gone) ? build.message : `${build.message}\n${gone}`;
    return { ok: false, message, ...(build.cancelled ? { cancelled: true as const } : {}) };
  }
  return { ok: true, commit: build.commit, rebuilt: true };
}

/** GC after a move: keep the new pin and the one before it. gcGitBuilds also
 *  keeps every build another bundles.json still pins -- the user file, every
 *  trusted project file, the project file found from `cwd`, and the files
 *  refs.json records -- since the build directory is shared by namespace
 *  across all of them, and it deletes nothing when one cannot be read. */
async function collect(
  namespace: string,
  keep: Array<string | undefined>,
  home: string,
  warn: (w: string) => void,
  where: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  const res = await gcGitBuilds(
    namespace,
    keep.filter((c): c is string => typeof c === "string"),
    home,
    where,
  );
  if ("locked" in res) {
    warn(res.message);
    return;
  }
  for (const n of res.notes) warn(n);
  if (res.unreadable.length > 0) warn(gitLivenessWarning(namespace, res.unreadable));
  for (const x of res.errors) warn(`an old build could not be removed (it may be in use): ${x}`);
}
