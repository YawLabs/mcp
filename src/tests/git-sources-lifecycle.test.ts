// Git entries after `add --git`: `sidecars install` builds the pinned commit
// (never moving it), `trust` shows the source and offers that same build after
// a grant, and `remove` shows and deletes the entry's checkout. Real git against
// file:// bare repos; the package manager is a stand-in that performs the
// fixture's build, so these stay fast (git-source-build.test.ts runs the real
// npm / pnpm / yarn).

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discardBuild, GIT_LOCK_NAME, gitRefsPath, recordGitPin, recordRepoConsent } from "../git-source.js";
import { parseRemoveArgs, runRemove } from "../local-add-cmd.js";
import { localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME, gitBuildDir, gitBuiltPath, gitRoot, userConfigDir } from "../paths.js";
import { backgroundInstallOptions } from "../sidecar-refresh.js";
import { acquireSidecarsLock, parseSidecarsArgs, type RunNpmOptions, runSidecarsInstall } from "../sidecars-cmd.js";
import { runTrust } from "../trust-cmd.js";
import { ENV, fakeFinishedBuild, git, makeRepo, NPM_FILES, newTmp, type Repo } from "./git-fixture.js";

/** Stands in for npm: install is a no-op, `run build` does what the fixture's
 *  build.js does, and `--version` answers. Records every call. */
function fakePm(calls: string[][]) {
  return async (args: string[], cwd: string, opts: RunNpmOptions): Promise<number> => {
    calls.push(args);
    if (args.includes("--version")) {
      opts.output?.("10.9.0\n");
      return 0;
    }
    if (args.includes("build")) {
      mkdirSync(join(cwd, "dist"), { recursive: true });
      copyFileSync(join(cwd, "src", "server.js"), join(cwd, "dist", "index.js"));
    }
    return 0;
  };
}

/** Make `dir` impossible to delete until the returned release runs: on
 *  Windows another process holds a file in it open with no sharing (EBUSY,
 *  as a running server's native addon does); elsewhere the directory is made
 *  read-only, so its entries cannot be unlinked. */
async function holdUndeletable(dir: string): Promise<() => Promise<void>> {
  const held = join(dir, "held.bin");
  writeFileSync(held, "x");
  if (process.platform !== "win32") {
    chmodSync(dir, 0o555);
    return async () => chmodSync(dir, 0o755);
  }
  const child = spawn(
    "powershell",
    ["-NoProfile", "-Command", '$h=[IO.File]::Open($env:HELD,"Open","Read","None"); Start-Sleep 60'],
    { env: { ...process.env, HELD: held }, stdio: "ignore" },
  );
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      closeSync(openSync(held, "r+"));
    } catch {
      break;
    }
    if (Date.now() > deadline) throw new Error("could not lock the file");
    await new Promise((r) => setTimeout(r, 100));
  }
  return async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
  };
}

function gitEntry(repo: Repo, namespace: string, commit: string | undefined) {
  return {
    namespace,
    name: namespace,
    type: "local",
    transport: "stdio",
    git: { url: repo.url, ref: "main", ...(commit ? { commit } : {}), entry: "dist/index.js" },
  };
}

function writeUserBundles(home: string, servers: unknown[]): void {
  mkdirSync(userConfigDir(home), { recursive: true });
  writeFileSync(localBundlesPath(userConfigDir(home)), JSON.stringify({ version: 1, servers }, null, 2));
}

const JSON_KEYS = [
  "root",
  "installed",
  "reason",
  "error",
  "updateError",
  "markerError",
  "unhosted",
  "conflicts",
  "skipped",
  "git",
].sort();

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = newTmp("yaw git life-");
  out = [];
  err = [];
});

describe("sidecars install builds pinned git entries", () => {
  async function install(over: Parameters<typeof runSidecarsInstall>[0] = {}) {
    return runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      isTTY: false,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...over,
    });
  }

  it("builds the pinned commit on the no-npx path, reports it in --json, and reuses it next time", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    const calls: string[][] = [];

    const res = await install({ json: true, yes: true, runPm: fakePm(calls) });
    expect(res.exitCode, err.join("")).toBe(0);
    const doc = JSON.parse(out.join(""));
    expect(Object.keys(doc).sort()).toEqual(JSON_KEYS);
    expect(doc.reason).toBe("no-npx-servers");
    expect(doc.error).toBeNull();
    expect(doc.git).toEqual([{ namespace: "fx", commit: head, status: "built", error: null }]);
    expect(existsSync(gitBuiltPath("fx", head, home))).toBe(true);
    expect(calls.some((c) => c.includes("build"))).toBe(true);
    const refs = { [localBundlesPath(userConfigDir(home))]: head };
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual(refs);

    out = [];
    calls.length = 0;
    rmSync(gitRefsPath("fx", home));
    const again = await install({ json: true, runPm: fakePm(calls) });
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(out.join("")).git).toEqual([{ namespace: "fx", commit: head, status: "ready", error: null }]);
    expect(calls).toEqual([]);
    // A build already here is recorded as used by this file too.
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual(refs);
  }, 120_000);

  it("reports a built entry as ready without waiting on the build lock", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    expect((await install({ yes: true, runPm: fakePm([]) })).exitCode).toBe(0);
    const release = acquireSidecarsLock(gitRoot(home), GIT_LOCK_NAME);
    expect(release).not.toBeNull();
    try {
      out = [];
      const res = await install({ json: true, runPm: fakePm([]) });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(out.join("")).git[0].status).toBe("ready");
    } finally {
      release?.();
    }
  }, 120_000);

  it("never moves the pin: a branch that moved on still builds the pinned commit", async () => {
    const repo = makeRepo(NPM_FILES);
    const pinned = git(repo.work, ["rev-parse", "HEAD"]);
    const moved = repo.commit({ "README.md": "later\n" });
    writeUserBundles(home, [gitEntry(repo, "fx", pinned)]);

    const res = await install({ yes: true, runPm: fakePm([]) });
    expect(res.exitCode, err.join("")).toBe(0);
    expect(existsSync(gitBuiltPath("fx", pinned, home))).toBe(true);
    expect(existsSync(gitBuildDir("fx", moved, home))).toBe(false);
    const text = out.join("");
    expect(text).toContain("Git sources:");
    expect(text).toContain(`  fx  ${pinned.slice(0, 12)}  built`);
    expect(text).toContain("No npx-launched servers in bundles.json.");
    expect(text).not.toContain("nothing to install");
  }, 120_000);

  it("refuses an entry with no commit, clones nothing, and exits 1 with error set", async () => {
    const repo = makeRepo(NPM_FILES);
    writeUserBundles(home, [gitEntry(repo, "nc", undefined)]);
    const calls: string[][] = [];

    const res = await install({ json: true, yes: true, runPm: fakePm(calls) });
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(out.join(""));
    expect(Object.keys(doc).sort()).toEqual(JSON_KEYS);
    expect(doc.git).toEqual([
      {
        namespace: "nc",
        commit: null,
        status: "refused",
        error: 'nc has no "commit" -- refusing to build a moving ref. Pin one with: yaw-mcp update nc',
      },
    ]);
    expect(doc.error).toBe("1 git source(s) did not build");
    expect(calls).toEqual([]);
    expect(existsSync(join(gitRoot(home), "nc"))).toBe(false);
  }, 60_000);

  it("a pinned root entry whose repo moved into a subdir names the manifest subdir and a re-add, not --subdir", async () => {
    const repo = makeRepo({
      "yaw-mcp.json": JSON.stringify({ version: 1, subdir: "packages/server" }),
      "packages/server/package.json": JSON.stringify({ name: "srv", version: "1.0.0", main: "index.js" }),
      "packages/server/index.js": "",
    });
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    const res = await install({ json: true, yes: true, runPm: fakePm([]) });
    expect(res.exitCode).toBe(1);
    const [report] = JSON.parse(out.join("")).git;
    expect(report.status).toBe("failed");
    expect(report.error).toContain('the repo\'s yaw-mcp.json now puts the server in "packages/server"');
    expect(report.error).toContain(`yaw-mcp add fx --git ${repo.url}#main --subdir packages/server`);
    expect(report.error).not.toContain("pass --subdir");
  }, 60_000);

  it("a run with both a failed and an unconsented source names both counts", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "nc", undefined), gitEntry(repo, "fx", head)]);
    const res = await install({ json: true, runPm: fakePm([]) });
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(out.join(""));
    expect(doc.git.map((g: { status: string }) => g.status)).toEqual(["refused", "needs-consent"]);
    expect(doc.error).toBe(
      "1 git source(s) did not build; 1 git source(s) were not built: their repo's scripts need consent (re-run with --yes)",
    );
  }, 60_000);

  it("off a TTY asks for --yes once per repo, and a stored repo grant is enough", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    const calls: string[][] = [];

    const refused = await install({ json: true, runPm: fakePm(calls) });
    expect(refused.exitCode).toBe(1);
    const refusedDoc = JSON.parse(out.join(""));
    const [report] = refusedDoc.git;
    expect(report.status).toBe("needs-consent");
    expect(report.error).toContain("re-run with --yes");
    expect(refusedDoc.error).toContain("need consent");
    expect(refusedDoc.error).not.toContain("did not build");
    expect(calls).toEqual([]);
    expect(existsSync(gitBuildDir("fx", head, home))).toBe(false);

    await recordRepoConsent(repo.url, home);
    out = [];
    const ok = await install({ json: true, runPm: fakePm(calls) });
    expect(ok.exitCode, err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).git[0].status).toBe("built");
  }, 120_000);

  it("carries the git reports on the npm path too (here: the npm failure)", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [
      gitEntry(repo, "fx", head),
      { namespace: "fetch", name: "fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@1.0.0"] },
    ]);
    // Not the locked tree any more: a held lock now stops the run BEFORE the
    // git build (nothing to report), so the path that still has both halves
    // to report is one where npm itself fails under the build's reports.
    const res = await install({ json: true, yes: true, runPm: fakePm([]), runNpm: async () => 1 });
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(out.join(""));
    expect(Object.keys(doc).sort()).toEqual(JSON_KEYS);
    expect(doc.git).toEqual([{ namespace: "fx", commit: head, status: "built", error: null }]);
    expect(doc.error).toContain("npm exited 1");
  }, 120_000);

  it("the background refresh never builds a git entry", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    await recordRepoConsent(repo.url, home);
    const opts = backgroundInstallOptions(home);
    expect(opts.buildGit).toBe(false);
    const res = await runSidecarsInstall({ ...opts, env: ENV, json: true, out: (s) => out.push(s) });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(out.join("")).git).toEqual([]);
    expect(existsSync(join(gitRoot(home), "fx"))).toBe(false);
  }, 60_000);

  it("parses --yes and -y", () => {
    expect(parseSidecarsArgs(["install", "--yes"])).toMatchObject({ ok: true, options: { yes: true } });
    expect(parseSidecarsArgs(["install", "-y", "--json"])).toMatchObject({
      ok: true,
      options: { yes: true, json: true },
    });
    expect(parseSidecarsArgs(["install"])).toMatchObject({ ok: true, options: { yes: false } });
  });
});

describe("trust shows git sources and offers the build after a grant", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(home, "proj");
    mkdirSync(join(cwd, CONFIG_DIRNAME), { recursive: true });
  });
  function writeProject(servers: unknown[]): void {
    writeFileSync(localBundlesPath(join(cwd, CONFIG_DIRNAME)), JSON.stringify({ version: 1, servers }, null, 2));
  }
  async function trust(over: Parameters<typeof runTrust>[0] = {}) {
    return runTrust({ home, cwd, env: ENV, out: (s) => out.push(s), err: (s) => err.push(s), ...over });
  }

  it("renders the source, the pin gaps, and builds nothing on a --yes grant", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeProject([gitEntry(repo, "fx", head), gitEntry(repo, "nc", undefined)]);

    const res = await trust({ yes: true, isTTY: false, runPm: fakePm([]) });
    // Approved, but nothing was built: the file it points at does not run yet,
    // so a script must not read a clean exit as done (the TTY path gives a
    // failed build the same verdict).
    expect(res.exitCode, err.join("")).toBe(1);
    const text = out.join("");
    expect(text).toContain(`git ${repo.url} @ ${head.slice(0, 12)} (tracking main) [not built]`);
    expect(text).toContain(`git ${repo.url} (tracking main) [no commit]`);
    expect(text).toContain("! NOT covered by the pin: nc has no commit -- it builds whatever main points at.");
    expect(text.match(/! building runs this repo's install and build lifecycle scripts/g)).toHaveLength(2);
    expect(text).not.toContain(join(gitRoot(home), "fx"));
    // ONE line, naming the command that works off a TTY: with no stored grant
    // the bare install refuses, so the --yes that IS the consent rides along
    // rather than as a second line about a different command.
    expect(text).toContain(
      "1 git server is not built on this machine. Build it with: yaw-mcp sidecars install --yes (runs the repo's install/build scripts; asked once per repo)",
    );
    expect(text).not.toContain("Off a TTY that needs --yes");
    expect(existsSync(join(gitRoot(home), "fx"))).toBe(false);
  }, 60_000);

  it("drops the --yes hint once the repo's scripts were allowed here", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    await recordRepoConsent(repo.url, home);
    writeProject([gitEntry(repo, "fx", head)]);
    const res = await trust({ yes: true, isTTY: false, runPm: fakePm([]) });
    // Unbuilt, so still 1 -- consent only changes WHICH command the hint is.
    expect(res.exitCode, err.join("")).toBe(1);
    expect(out.join("")).toContain("Build it with: yaw-mcp sidecars install");
    expect(out.join("")).not.toContain("--yes");
  }, 60_000);

  it("shows the vault secret a git entry sends, and the host it goes to", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    const https = {
      ...gitEntry(repo, "fx", head),
      git: { url: "https://git.evil.example/x.git", commit: head, entry: "dist/index.js", tokenSecret: "AWS_KEY" },
    };
    const ssh = {
      ...gitEntry(repo, "sx", head),
      git: { url: "git@github.com:acme/x.git", commit: head, entry: "dist/index.js", tokenSecret: "GH_READ" },
    };
    writeProject([https, ssh]);
    const res = await trust({ yes: true, isTTY: false, runPm: fakePm([]) });
    // Neither is built off a TTY (both lack consent), which is not a
    // successful end state for the caller.
    expect(res.exitCode, err.join("")).toBe(1);
    const text = out.join("");
    expect(text).toContain("token: vault secret AWS_KEY -> sent to git.evil.example");
    expect(text).toContain(
      "! approving lets yaw-mcp read vault secret AWS_KEY and send it to git.evil.example whenever it fetches this repo",
    );
    expect(text).toContain("token: vault secret GH_READ -> sent to nothing (ignored: not an https URL)");
  }, 60_000);

  it("a declined grant builds nothing and offers nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    writeProject([gitEntry(repo, "fx", git(repo.work, ["rev-parse", "HEAD"]))]);
    const calls: string[][] = [];
    const res = await trust({ promptAnswer: "n", runPm: fakePm(calls) });
    expect(res.exitCode).toBe(1);
    expect(out.join("")).not.toContain("Build it now?");
    expect(calls).toEqual([]);
    expect(existsSync(gitRoot(home))).toBe(false);
  }, 60_000);

  it("after a TTY grant, builds the not-built entry with the sidecars builder (repo consent asked once)", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeProject([gitEntry(repo, "fx", head)]);
    const res = await trust({ promptAnswer: "y", runPm: fakePm([]) });
    expect(res.exitCode, err.join("")).toBe(0);
    const text = out.join("");
    const CONSENT = "This will run code from the repo on this machine:";
    expect(text.split(CONSENT).length - 1).toBe(1);
    expect(text).toContain(`fx ready (${head.slice(0, 7)}).`);
    expect(existsSync(gitBuiltPath("fx", head, home))).toBe(true);

    // A later build of the same repo, off a TTY and without --yes, is not asked again.
    const next = repo.commit({ "README.md": "later\n" });
    writeUserBundles(home, [gitEntry(repo, "fy", next)]);
    out = [];
    const later = await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      isTTY: false,
      json: true,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      runPm: fakePm([]),
    });
    expect(later.exitCode, err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).git).toEqual([{ namespace: "fy", commit: next, status: "built", error: null }]);
    expect(out.join("") + err.join("")).not.toContain(CONSENT);
  }, 120_000);

  it("shows [built] for a commit already built here, and offers nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      yes: true,
      isTTY: false,
      out: () => {},
      err: () => {},
      runPm: fakePm([]),
    });
    writeProject([gitEntry(repo, "fx", head)]);
    const res = await trust({ promptAnswer: "y", runPm: fakePm([]) });
    expect(res.exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain(`@ ${head.slice(0, 12)} (tracking main) [built]`);
    expect(out.join("")).not.toContain("not built");
  }, 120_000);
});

describe("remove deletes a git entry's checkout", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  function seedCheckout(ns: string): string {
    const build = gitBuildDir(ns, COMMIT, home);
    fakeFinishedBuild(build, COMMIT, { entry: "dist/index.js" });
    writeFileSync(join(build, "dist", "index.js"), "x".repeat(2 * 1024 * 1024));
    return join(gitRoot(home), ns);
  }
  function seedEntry(ns: string): void {
    writeUserBundles(home, [
      { namespace: ns, name: ns, git: { url: "git@github.com:acme/fx.git", commit: COMMIT, entry: "dist/index.js" } },
      { namespace: "other", name: "other", command: "node", args: ["x.js"] },
    ]);
  }
  async function remove(argv: string[]) {
    const parsed = parseRemoveArgs(argv);
    if (!parsed.ok) throw new Error(parsed.error);
    return runRemove({
      ...parsed.options,
      home,
      cwd: home,
      env: ENV,
      isTTY: false,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
  }

  it("previews the source and the checkout size, then deletes only that namespace's checkout", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const otherDir = seedCheckout("keepme");

    const refused = await remove(["fx"]);
    expect(refused.exitCode).toBe(2);
    expect(out.join("")).toContain(`launch:    git git@github.com:acme/fx.git @ ${COMMIT.slice(0, 12)}`);
    expect(out.join("")).toContain(`checkout:  deletes ${dir} (2.0 MB)`);
    expect(out.join("")).toContain(`builds ${COMMIT.slice(0, 7)}`);
    expect(existsSync(dir)).toBe(true);

    out = [];
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain(`Deleted its git checkout at ${dir} (build ${COMMIT.slice(0, 7)}).`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(otherDir)).toBe(true);
  });

  it("--keep-checkout keeps it, and says so in the preview", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    await remove(["fx", "--keep-checkout"]);
    expect(out.join("")).toContain(`checkout:  keeps ${dir} (2.0 MB; --keep-checkout)`);
    const res = await remove(["fx", "--keep-checkout", "--force"]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("removes the entry but keeps the checkout while a build holds the lock", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const release = acquireSidecarsLock(gitRoot(home), GIT_LOCK_NAME);
    expect(release).not.toBeNull();
    try {
      const res = await remove(["fx", "--force"]);
      expect(res.exitCode).toBe(0);
      expect(err.join("")).toContain("another yaw-mcp is building git sources");
      expect(err.join("")).toContain(`Note: its git builds under ${dir} were left in place: `);
      expect(err.join("")).not.toContain("Delete that directory");
      expect(existsSync(dir)).toBe(true);
    } finally {
      release?.();
    }
  });

  it("keeps a build another bundles.json still pins, and says which and why", async () => {
    const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const otherBuild = gitBuildDir("fx", OTHER, home);
    fakeFinishedBuild(otherBuild, OTHER);
    const projDir = join(home, "proj", CONFIG_DIRNAME);
    mkdirSync(projDir, { recursive: true });
    const projFile = localBundlesPath(projDir);
    const projEntry = (commit: string) => ({
      namespace: "fx",
      name: "fx",
      git: { url: "git@github.com:acme/fx.git", commit, entry: "dist/index.js" },
    });
    writeFileSync(projFile, JSON.stringify({ version: 1, servers: [projEntry(OTHER)] }));
    await recordGitPin("fx", localBundlesPath(userConfigDir(home)), COMMIT, home);
    await recordGitPin("fx", projFile, OTHER, home);

    await remove(["fx"]);
    const preview = out.join("");
    expect(preview).toContain(`checkout:  deletes 1 build under ${dir} (2.0 MB)`);
    expect(preview).toContain(`keeps ${OTHER.slice(0, 7)}: still pinned by ${projFile}`);

    out = [];
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain(`keeps ${OTHER.slice(0, 7)}: still pinned by ${projFile}`);
    expect(existsSync(gitBuildDir("fx", COMMIT, home))).toBe(false);
    expect(existsSync(otherBuild)).toBe(true);
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual({ [projFile]: OTHER });

    // The project pinning the SAME commit keeps it too.
    seedEntry("fx");
    seedCheckout("fx");
    writeFileSync(projFile, JSON.stringify({ version: 1, servers: [projEntry(COMMIT)] }));
    out = [];
    expect((await remove(["fx", "--force"])).exitCode).toBe(0);
    expect(existsSync(gitBuildDir("fx", COMMIT, home))).toBe(true);
    expect(existsSync(otherBuild)).toBe(false);

    // A recorded file that is gone pins nothing: the last build goes, and the
    // namespace directory with it.
    rmSync(projFile);
    seedEntry("fx");
    expect((await remove(["fx", "--force"])).exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the build a project approved before it existed pins, though nothing recorded that project", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    const proj = join(home, "proj-b");
    mkdirSync(join(proj, CONFIG_DIRNAME), { recursive: true });
    const projFile = localBundlesPath(join(proj, CONFIG_DIRNAME));
    writeFileSync(projFile, JSON.stringify({ version: 1, servers: [gitEntry(repo, "fx", head)] }, null, 2));
    // Approved off a TTY while no build exists: trust records nothing.
    const granted = await runTrust({
      home,
      cwd: proj,
      env: ENV,
      yes: true,
      isTTY: false,
      out: () => {},
      err: () => {},
    });
    // The grant landed; the build did not (nothing consented here yet), so the
    // run still reports unfinished work.
    expect(granted.exitCode).toBe(1);
    expect(existsSync(join(gitRoot(home), "fx"))).toBe(false);
    // The user file then builds the same commit; only it is recorded.
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);
    const built = await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      yes: true,
      isTTY: false,
      out: () => {},
      err: () => {},
      runPm: fakePm([]),
    });
    expect(built.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8")))).toEqual([
      localBundlesPath(userConfigDir(home)),
    ]);

    await remove(["fx"]);
    expect(out.join("")).toContain(`keeps ${head.slice(0, 7)}: still pinned by ${projFile}`);
    out = [];
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode, err.join("")).toBe(0);
    expect(existsSync(gitBuiltPath("fx", head, home))).toBe(true);
    expect(out.join("")).toContain(`keeps ${head.slice(0, 7)}: still pinned by ${projFile}`);
    expect(out.join("")).not.toContain("Deleted its git checkout");
  }, 120_000);

  it("keeps a build the project file found from the cwd pins, trusted or not", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const proj = join(home, "proj-c");
    mkdirSync(join(proj, CONFIG_DIRNAME), { recursive: true });
    const projFile = localBundlesPath(join(proj, CONFIG_DIRNAME));
    writeFileSync(
      projFile,
      JSON.stringify({
        version: 1,
        servers: [
          {
            namespace: "fx",
            name: "fx",
            git: { url: "git@github.com:acme/fx.git", commit: COMMIT, entry: "dist/index.js" },
          },
        ],
      }),
    );
    const res = await runRemove({
      target: "fx",
      force: true,
      home,
      cwd: proj,
      env: ENV,
      isTTY: false,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(res.exitCode, err.join("")).toBe(0);
    expect(existsSync(join(dir, COMMIT.slice(0, 12)))).toBe(true);
  });

  it("deletes nothing when refs.json does not parse, says so, and moves it to refs.json.bad", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const refs = gitRefsPath("fx", home);
    writeFileSync(refs, `{ "C:/elsewhere/bundles.json": "${COMMIT}", }`);
    await remove(["fx"]);
    expect(out.join("")).toContain(`checkout:  deletes nothing under ${dir}: could not read ${refs}`);
    expect(existsSync(refs)).toBe(true);
    expect(existsSync(`${refs}.bad`)).toBe(false);

    out = [];
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode, err.join("")).toBe(0);
    expect(existsSync(join(dir, COMMIT.slice(0, 12)))).toBe(true);
    expect(err.join("")).toContain(`warning: ${refs} is not a JSON object; moved it to ${refs}.bad`);
    expect(err.join("")).toContain(`Note: no build of fx was deleted: yaw-mcp could not read ${refs}`);
    expect(existsSync(refs)).toBe(false);
    expect(readFileSync(`${refs}.bad`, "utf8")).toContain(COMMIT);
  });

  it("an empty refs.json is unreadable too, never an empty record", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    writeFileSync(gitRefsPath("fx", home), "");
    expect((await remove(["fx", "--force"])).exitCode).toBe(0);
    expect(existsSync(join(dir, COMMIT.slice(0, 12)))).toBe(true);
    expect(err.join("")).toContain("is empty; moved it to");
  });

  it("deletes nothing while a recorded file's directory is missing, as on an unmounted drive", async () => {
    seedEntry("fx");
    const dir = seedCheckout("fx");
    const offline = join(home, "unmounted", "proj", CONFIG_DIRNAME, "bundles.json");
    await recordGitPin("fx", offline, COMMIT, home);
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode, err.join("")).toBe(0);
    expect(existsSync(join(dir, COMMIT.slice(0, 12)))).toBe(true);
    expect(err.join("")).toContain(`could not read ${offline}`);
    // The record survives for when the drive comes back.
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual({ [offline]: COMMIT });
  });

  it("on a failed delete, names only the build that failed, never the namespace directory", async () => {
    const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
    seedEntry("fx");
    const dir = seedCheckout("fx");
    fakeFinishedBuild(gitBuildDir("fx", OTHER, home), OTHER);
    const projDir = join(home, "proj", CONFIG_DIRNAME);
    mkdirSync(projDir, { recursive: true });
    const projFile = localBundlesPath(projDir);
    writeFileSync(
      projFile,
      JSON.stringify({
        version: 1,
        servers: [
          {
            namespace: "fx",
            name: "fx",
            git: { url: "git@github.com:acme/fx.git", commit: OTHER, entry: "dist/index.js" },
          },
        ],
      }),
    );
    // The other file's pin is recorded, as add/update/trust record it when
    // they use a build. Without a record or an approval, liveness has no way
    // to see this file -- the same rule the "deletes nothing when refs.json
    // does not parse" test relies on.
    await recordGitPin("fx", projFile, OTHER, home);
    const doomed = gitBuildDir("fx", COMMIT, home);
    const release = await holdUndeletable(doomed);
    try {
      const res = await remove(["fx", "--force"]);
      expect(res.exitCode).toBe(0);
      const text = err.join("");
      expect(text).toContain(`Note: could not delete ${doomed}: `);
      expect(text).toContain("Delete it once nothing runs from it.");
      expect(text).not.toContain("Delete that directory");
      expect(out.join("")).toContain(`keeps ${OTHER.slice(0, 7)}: still pinned by ${projFile}`);
      expect(existsSync(gitBuildDir("fx", OTHER, home))).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await release();
    }
  }, 60_000);

  it("leaves the checkout of a command entry's namespace alone", async () => {
    writeUserBundles(home, [{ namespace: "fx", name: "fx", command: "node", args: ["x.js"] }]);
    const dir = seedCheckout("fx");
    const res = await remove(["fx", "--force"]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "deletes a pnpm-style tree holding junctions without following them out of the tree",
    async () => {
      seedEntry("fx");
      const dir = seedCheckout("fx");
      const build = gitBuildDir("fx", COMMIT, home);
      const store = join(build, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "index.js"), "module.exports = 1;\n");
      symlinkSync(store, join(build, "node_modules", "dep"), "junction");
      const outside = newTmp("git-life-outside-");
      writeFileSync(join(outside, "keep.txt"), "still here\n");
      symlinkSync(outside, join(build, "node_modules", "escape"), "junction");

      const res = await remove(["fx", "--force"]);
      expect(res.exitCode, err.join("")).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(outside)).toEqual(["keep.txt"]);
    },
  );
});

describe.runIf(process.platform === "win32")("paths over MAX_PATH on Windows", () => {
  const SEGS = Array.from({ length: 7 }, (_, i) => `${i}${"a".repeat(40)}`);

  it("builds a repo holding a file past 260 characters, and remove deletes it with a deep node_modules", async () => {
    const repo = makeRepo(NPM_FILES);
    git(repo.work, ["config", "core.longpaths", "true"]);
    const rel = [...SEGS, "deep.txt"].join("/");
    const head = repo.commit({ [rel]: "deep\n" });
    writeUserBundles(home, [gitEntry(repo, "fx", head)]);

    const res = await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      isTTY: false,
      yes: true,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      runPm: fakePm([]),
    });
    expect(res.exitCode, err.join("")).toBe(0);
    const build = gitBuildDir("fx", head, home);
    const deep = join(build, ...rel.split("/"));
    expect(deep.length).toBeGreaterThan(260);
    expect(readFileSync(deep, "utf8")).toBe("deep\n");

    const modules = join(build, "node_modules", ...SEGS);
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "index.js"), "module.exports = 1;\n");
    expect(join(modules, "index.js").length).toBeGreaterThan(260);

    const parsed = parseRemoveArgs(["fx", "--force"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const removed = await runRemove({
      ...parsed.options,
      home,
      cwd: home,
      env: ENV,
      isTTY: false,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(removed.exitCode, err.join("")).toBe(0);
    expect(existsSync(join(gitRoot(home), "fx"))).toBe(false);
  }, 120_000);
});

describe("recordGitPin and the git lock", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  it("waits for a held lock and records once it frees, never writing unlocked", async () => {
    mkdirSync(join(gitRoot(home), "fx"), { recursive: true });
    const file = join(home, "p", CONFIG_DIRNAME, "bundles.json");
    const release = acquireSidecarsLock(gitRoot(home), GIT_LOCK_NAME);
    expect(release).not.toBeNull();
    let done = false;
    const pending = recordGitPin("fx", file, COMMIT, home).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect(existsSync(gitRefsPath("fx", home))).toBe(false);
    release?.();
    await pending;
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual({ [file]: COMMIT });
  });

  it("skips the record when the lock stays busy past the wait", async () => {
    mkdirSync(join(gitRoot(home), "fx"), { recursive: true });
    const release = acquireSidecarsLock(gitRoot(home), GIT_LOCK_NAME);
    try {
      await recordGitPin("fx", join(home, "q", "bundles.json"), COMMIT, home, () => {}, { waitMs: 150 });
      expect(existsSync(gitRefsPath("fx", home))).toBe(false);
    } finally {
      release?.();
    }
  });

  it("sets a refs.json that does not parse aside before recording, with a warning", async () => {
    mkdirSync(join(gitRoot(home), "fx"), { recursive: true });
    writeFileSync(gitRefsPath("fx", home), "{ truncated");
    const warns: string[] = [];
    const file = join(home, "p", "bundles.json");
    await recordGitPin("fx", file, COMMIT, home, (w) => warns.push(w));
    expect(warns.join("")).toContain(`moved it to ${gitRefsPath("fx", home)}.bad`);
    expect(readFileSync(`${gitRefsPath("fx", home)}.bad`, "utf8")).toBe("{ truncated");
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual({ [file]: COMMIT });
  });

  it("refuses to discard a build while a source that may pin it cannot be read", async () => {
    // The same fail-safe as GC and remove: an unreadable source may pin this
    // build, so the build is left with the source named, not deleted.
    mkdirSync(join(gitRoot(home), "fx"), { recursive: true });
    fakeFinishedBuild(gitBuildDir("fx", COMMIT, home), COMMIT, { entry: "dist/index.js" });
    writeFileSync(gitRefsPath("fx", home), "{ truncated");

    const refused = await discardBuild("fx", COMMIT, home);
    expect(refused.ok).toBe(false);
    expect((refused as { message: string }).message).toContain("no build of fx was deleted");
    expect(existsSync(gitBuildDir("fx", COMMIT, home))).toBe(true);
    expect(existsSync(`${gitRefsPath("fx", home)}.bad`)).toBe(true);

    // With every source readable it goes ahead.
    const gone = await discardBuild("fx", COMMIT, home);
    expect(gone.ok).toBe(true);
    expect(existsSync(gitBuildDir("fx", COMMIT, home))).toBe(false);
  });
});
