// `yaw-mcp update`: real git against file:// bare repos (plus the ssh shim),
// a package-manager stand-in that performs the fixture's build, and an
// injected start check, so each case is a few git calls.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGitSource,
  gitRefsPath,
  gitStatePath,
  newerTags,
  parseGitSpec,
  readBuildMarker,
  readGitState,
  recordGitPin,
  recordRepoConsent,
} from "../git-source.js";
import { parseJsonc } from "../jsonc.js";
import { localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME, gitBuildDir, gitBuiltPath, gitRoot, userConfigDir } from "../paths.js";
import { runShare } from "../share-cmd.js";
import type { RunNpmOptions } from "../sidecars-cmd.js";
import { grantTrust, readTrustStore, trustStatusFor } from "../trust.js";
import { parseUpdateArgs, runUpdate, type UpdateCommandOptions } from "../update-cmd.js";
import { ENV, git, makeRepo, NPM_FILES, newTmp, packageJson, type Repo, SERVER_JS } from "./git-fixture.js";

function fakePm(calls: string[][], failBuild = false) {
  return async (args: string[], cwd: string, opts: RunNpmOptions): Promise<number> => {
    calls.push(args);
    if (args.includes("--version")) {
      opts.output?.("10.9.0\n");
      return 0;
    }
    if (args.includes("build")) {
      if (failBuild) {
        opts.output?.("error TS2304: cannot find name\n");
        return 2;
      }
      mkdirSync(join(cwd, "dist"), { recursive: true });
      copyFileSync(join(cwd, "src", "server.js"), join(cwd, "dist", "index.js"));
    }
    return 0;
  };
}

let home: string;
let out: string[];
let err: string[];
let calls: string[][];

beforeEach(() => {
  home = newTmp("yaw git update-");
  out = [];
  err = [];
  calls = [];
});

function bundlesText(url: string, commit: string, ref = "main", ns = "fx"): string {
  return [
    "{",
    "  // hand-written: keep me",
    '  "version": 1,',
    '  "servers": [',
    "    {",
    `      "namespace": "${ns}",`,
    `      "name": "${ns}",`,
    '      "type": "local",',
    '      "transport": "stdio",',
    "      /* the git block */",
    `      "git": { "url": ${JSON.stringify(url)}, "ref": "${ref}", "commit": "${commit}", "entry": "dist/index.js" }`,
    "    },",
    '    { "namespace": "other", "name": "other", "type": "local", "command": "node", "args": ["x.js"] }',
    "  ]",
    "}",
    "",
  ].join("\n");
}

function userFile(): string {
  return localBundlesPath(userConfigDir(home));
}

function writeUser(text: string): void {
  mkdirSync(userConfigDir(home), { recursive: true });
  writeFileSync(userFile(), text);
}

function pinned(path = userFile(), ns = "fx"): { commit: string; ref?: string } {
  const doc = parseJsonc(readFileSync(path, "utf8")) as {
    servers: Array<{ namespace: string; git: { commit: string; ref?: string } }>;
  };
  const hit = doc.servers.find((s) => s.namespace === ns);
  if (!hit) throw new Error(`no ${ns}`);
  return hit.git;
}

async function buildAt(repo: Repo, commit: string, ns = "fx", env = ENV): Promise<void> {
  const spec = parseGitSpec(repo.url);
  if (!spec.ok) throw new Error(spec.error);
  const r = await buildGitSource(
    { spec: spec.spec, ref: "main", commit, namespace: ns, entry: "dist/index.js" },
    { home, env, interactive: false, yes: true, progress: () => {}, warn: () => {}, runPm: fakePm([]) },
  );
  if (!r.ok) throw new Error(r.message);
}

async function update(argv: string[], over: Partial<UpdateCommandOptions> = {}) {
  const parsed = parseUpdateArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return runUpdate({
    ...parsed.options,
    home,
    cwd: home,
    env: ENV,
    isTTY: false,
    runPm: fakePm(calls),
    startCheck: async () => ({ ok: true, tools: 1 }),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over,
  });
}

function builds(ns = "fx"): string[] {
  const dir = join(gitRoot(home), ns);
  return existsSync(dir) ? readdirSync(dir).filter((n) => /^[0-9a-f]{12}$/.test(n)) : [];
}

describe("parseUpdateArgs", () => {
  it("refuses one-server flags without a name, and contradictory flags", () => {
    expect(parseUpdateArgs(["--ref", "main"])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(["fx", "--ref", "a", "--to", "abcd"])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(["fx", "--check", "--to", "abcd"])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(["fx", "--to", "zz"])).toMatchObject({ ok: false });
    const unknown = parseUpdateArgs(["--nope"]);
    expect(!unknown.ok && unknown.error).toMatch(/unknown flag "--nope"/);
    expect(parseUpdateArgs(["fx", "--to", "ABCDEF1", "--yes", "--json"])).toEqual({
      ok: true,
      options: { name: "fx", to: "abcdef1", yes: true, json: true },
    });
  });

  it("names upgrade in its help", () => {
    const h = parseUpdateArgs(["--help"]);
    expect(h).toMatchObject({ ok: false, help: true });
    expect(!h.ok && h.error).toContain("yaw-mcp upgrade");
  });
});

describe("update with nothing to update", () => {
  it("points at upgrade when the file has no git servers", async () => {
    writeUser(JSON.stringify({ version: 1, servers: [{ namespace: "other", name: "other", command: "node" }] }));
    const r = await update([]);
    expect(r.exitCode).toBe(0);
    expect(out.join("")).toContain("No git servers in");
    expect(out.join("")).toContain("To update yaw-mcp itself, run: yaw-mcp upgrade");
  });

  it("refuses a named server that is not a git server, naming upgrade", async () => {
    writeUser(JSON.stringify({ version: 1, servers: [{ namespace: "other", name: "other", command: "node" }] }));
    const r = await update(["other"]);
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain("yaw-mcp upgrade");
  });

  it("leaves an unchanged commit alone: nothing built, file bytes untouched", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, head);
    writeUser(bundlesText(repo.url, head));
    const before = readFileSync(userFile(), "utf8");
    const r = await update(["fx"]);
    expect(r.exitCode, err.join("")).toBe(0);
    expect(out.join("")).toContain("up to date");
    expect(calls).toEqual([]);
    expect(readFileSync(userFile(), "utf8")).toBe(before);
  }, 120_000);
});

describe("update moves a branch forward", () => {
  it("builds the new commit, splices only the pin (comments survive), and keeps the previous build", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    const next = repo.commit({ "README.md": "v2\n" });

    const r = await update([]);
    expect(r.exitCode, err.join("")).toBe(0);
    const text = readFileSync(userFile(), "utf8");
    expect(text).toContain("// hand-written: keep me");
    expect(text).toContain("/* the git block */");
    expect(pinned().commit).toBe(next);
    expect(existsSync(gitBuiltPath("fx", next, home))).toBe(true);
    expect(existsSync(gitBuiltPath("fx", old, home))).toBe(true);
    const shown = out.join("");
    expect(shown).toContain(`Updated "fx" to ${next.slice(0, 7)} (1 commit).`);
    expect(shown).toContain(`Previous build kept: yaw-mcp update fx --to ${old.slice(0, 7)}`);
    expect(shown).toContain("Checking it starts ... ok -- 1 tools");
  }, 120_000);

  it("a failed build keeps the old pin and build, records .failed, and exits 1", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    const before = readFileSync(userFile(), "utf8");
    const next = repo.commit({ "README.md": "broken\n" });

    const r = await update(["fx"], { runPm: fakePm(calls, true) });
    expect(r.exitCode).toBe(1);
    expect(readFileSync(userFile(), "utf8")).toBe(before);
    expect(existsSync(gitBuildDir("fx", next, home))).toBe(false);
    expect(existsSync(`${gitBuildDir("fx", next, home)}.failed`)).toBe(true);
    expect(existsSync(gitBuiltPath("fx", old, home))).toBe(true);
    expect(err.join("")).toContain("Nothing was changed; the previous build still runs.");
  }, 120_000);

  it("--to rolls back to the kept build without building anything", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    const next = repo.commit({ "README.md": "v2\n" });
    expect((await update(["fx"])).exitCode).toBe(0);
    calls.length = 0;
    out = [];

    const r = await update(["fx", "--to", old.slice(0, 7)]);
    expect(r.exitCode, err.join("")).toBe(0);
    expect(pinned().commit).toBe(old);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain(`Rolled back "fx" to ${old.slice(0, 7)}`);
    expect(builds().sort()).toEqual([old.slice(0, 12), next.slice(0, 12)].sort());

    const missing = await update(["fx", "--to", "ffffffff"]);
    expect(missing.exitCode).toBe(1);
    expect(err.join("")).toContain("no kept build of ffffffff");
  }, 180_000);

  it("GC keeps the current and the previous build only", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode).toBe(0);
    const third = repo.commit({ "README.md": "3\n" });
    expect((await update(["fx"])).exitCode).toBe(0);
    expect(builds().sort()).toEqual([second.slice(0, 12), third.slice(0, 12)].sort());
    expect(pinned().commit).toBe(third);
  }, 180_000);

  it("refuses a force-moved branch and keeps the pin; --ref takes it explicitly", async () => {
    const repo = makeRepo(NPM_FILES);
    const base = git(repo.work, ["rev-parse", "HEAD"]);
    const old = repo.commit({ "README.md": "old\n" });
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    git(repo.work, ["reset", "-q", "--hard", base]);
    writeFileSync(join(repo.work, "OTHER.md"), "rewritten\n");
    git(repo.work, ["add", "-A"]);
    git(repo.work, ["commit", "-q", "-m", "rewrite"]);
    git(repo.work, ["push", "-q", "--force", "origin", "HEAD:main"]);
    const rewritten = git(repo.work, ["rev-parse", "HEAD"]);

    const r = await update(["fx"]);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain("force-moved");
    expect(pinned().commit).toBe(old);

    const taken = await update(["fx", "--ref", "main"]);
    expect(taken.exitCode, err.join("")).toBe(0);
    expect(pinned().commit).toBe(rewritten);
  }, 180_000);

  it("refuses a branch force-moved back onto a build it still keeps", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(pinned().commit).toBe(second);
    expect(builds()).toContain(first.slice(0, 12));
    git(repo.work, ["push", "-q", "--force", "origin", `${first}:refs/heads/main`]);
    err = [];

    const r = await update(["fx"]);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain("force-moved");
    expect(pinned().commit).toBe(second);

    const taken = await update(["fx", "--ref", "main"]);
    expect(taken.exitCode, err.join("")).toBe(0);
    expect(pinned().commit).toBe(first);
  }, 180_000);

  it("keeps building the pinned repo root when a later commit's manifest names a subdir", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    const next = repo.commit({
      "yaw-mcp.json": JSON.stringify({ subdir: "packages/server" }),
      "packages/server/package.json": packageJson({ name: "fx-sub" }),
      "packages/server/src/server.js": SERVER_JS,
    });
    const launched: string[][] = [];
    const r = await update(["fx"], {
      startCheck: async (cfg) => {
        launched.push(cfg.args ?? []);
        return { ok: true, tools: 1 };
      },
    });
    expect(r.exitCode, err.join("")).toBe(0);
    const dir = gitBuildDir("fx", next, home);
    expect(readBuildMarker(dir)?.subdir).toBeUndefined();
    expect(launched[0]?.[0]).toBe(join(dir, "dist", "index.js"));
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
  }, 120_000);

  it("--json reports a new build that did not start, with the reason; the start check runs yaw-mcp's node", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, old));
    const next = repo.commit({ "README.md": "v2\n" });
    const commands: string[] = [];
    const r = await update(["fx", "--json"], {
      startCheck: async (cfg) => {
        commands.push(cfg.command ?? "");
        return { ok: false, error: "vault locked: the passphrase does not unlock the vault" };
      },
    });
    expect(r.exitCode, err.join("")).toBe(0);
    expect(commands).toEqual([process.execPath]);
    const doc = JSON.parse(out.join(""));
    expect(doc.entries[0]).toMatchObject({
      status: "updated",
      to: next,
      started: false,
      startError: "vault locked: the passphrase does not unlock the vault",
    });
  }, 120_000);

  it("gives a reused build the same forward-slash entry a fresh one gets", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, head);
    const spec = parseGitSpec(repo.url);
    if (!spec.ok) throw new Error(spec.error);
    const r = await buildGitSource(
      { spec: spec.spec, ref: "main", commit: head, namespace: "fx", entry: "dist\\index.js" },
      { home, env: ENV, interactive: false, yes: true, progress: () => {}, warn: () => {}, runPm: fakePm([]) },
    );
    expect(r).toMatchObject({ ok: true, reused: true, entry: "dist/index.js" });
  }, 120_000);

  it("a deleted ref fails cleanly and keeps the pin", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    git(repo.work, ["push", "-q", "origin", "HEAD:refs/heads/feature"]);
    await buildAt(repo, head);
    writeUser(bundlesText(repo.url, head, "feature"));
    git(repo.work, ["push", "-q", "origin", "--delete", "feature"]);
    const r = await update(["fx", "--json"]);
    expect(r.exitCode).toBe(1);
    const doc = JSON.parse(out.join(""));
    expect(doc.entries[0]).toMatchObject({ namespace: "fx", status: "missing" });
    expect(pinned().commit).toBe(head);
  }, 120_000);

  it("asks the repo consent off a TTY only once: no grant and no --yes builds nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    writeUser(bundlesText(repo.url, old));
    repo.commit({ "README.md": "v2\n" });
    const r = await update(["fx"]);
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain("--yes");
    expect(pinned().commit).toBe(old);
    const granted = await update(["fx", "--yes"]);
    expect(granted.exitCode, err.join("")).toBe(0);
    repo.commit({ "README.md": "v3\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
  }, 180_000);
});

describe("update --check", () => {
  it("reports behind and pinned-with-newer-tags, writes state.json, and builds nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    git(repo.work, ["tag", "-a", "v1.4.0", "-m", "1.4.0"]);
    git(repo.work, ["push", "-q", "origin", "v1.4.0"]);
    const next = repo.commit({ "README.md": "v2\n" });
    for (const t of ["v1.4.1", "v1.10.0", "v2.0.0-rc.1", "nightly"]) git(repo.work, ["tag", t]);
    git(repo.work, ["push", "-q", "origin", "--tags"]);
    const text = bundlesText(repo.url, old).replace(
      '    { "namespace": "other"',
      `    { "namespace": "billing", "name": "billing", "git": { "url": ${JSON.stringify(repo.url)}, "ref": "v1.4.0", "commit": "${old}", "entry": "dist/index.js" } },\n    { "namespace": "other"`,
    );
    writeUser(text);

    const r = await update(["--check"]);
    expect(r.exitCode, err.join("")).toBe(0);
    const shown = out.join("");
    expect(shown).toMatch(new RegExp(`fx\\s+main\\s+${old.slice(0, 7)}\\s+behind \\(${next.slice(0, 7)}\\)`));
    expect(shown).toContain("pinned (tag), nothing to update; newer tags: v1.10.0, v1.4.1");
    expect(calls).toEqual([]);
    expect(builds()).toEqual([]);
    const state = JSON.parse(readFileSync(gitStatePath(home), "utf8"));
    expect(state.entries.fx).toMatchObject({ ref: "main", kind: "branch", pinned: old, remote: next });
    expect(state.entries.billing).toMatchObject({ kind: "tag", newerTags: ["v1.10.0", "v1.4.1"] });

    out = [];
    const json = await update(["--check", "--json"]);
    expect(json.exitCode).toBe(0);
    const doc = JSON.parse(out.join(""));
    expect(doc.check).toBe(true);
    expect(doc.entries.map((e: { status: string }) => e.status)).toEqual(["behind", "pinned"]);

    out = [];
    const tagUpdate = await update(["billing"]);
    expect(tagUpdate.exitCode).toBe(0);
    expect(out.join("")).toContain("pinned (tag), nothing to update");
    expect(calls).toEqual([]);
  }, 120_000);

  it("works over ssh:// and scp-form URLs through the user's own GIT_SSH_COMMAND", async () => {
    const repo = makeRepo(NPM_FILES);
    const srv = join(repo.bare, "..", "..");
    const shim = join(newTmp("git-upd-ssh-"), "ssh-shim.sh");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        "for last; do :; done",
        `root='${srv.replace(/\\/g, "/")}'`,
        `path=\${last#*\\'}`,
        `path=\${path%\\'}`,
        "path=${path#/}",
        'exec git upload-pack "$root/$path"',
        "",
      ].join("\n"),
    );
    const env = { ...ENV, GIT_SSH_COMMAND: `sh '${shim.replace(/\\/g, "/")}'`, GIT_SSH_VARIANT: "simple" };
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    const scp = "git@forge.example:acme/fx.git";
    const text = bundlesText(scp, old).replace(
      '    { "namespace": "other"',
      `    { "namespace": "viassh", "name": "viassh", "git": { "url": "ssh://git@forge.example/acme/fx.git", "ref": "main", "commit": "${old}", "entry": "dist/index.js" } },\n    { "namespace": "other"`,
    );
    writeUser(text);
    const next = repo.commit({ "README.md": "v2\n" });

    const check = await update(["--check", "--json"], { env });
    expect(check.exitCode, err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).entries.map((e: { to: string }) => e.to)).toEqual([next, next]);

    out = [];
    const r = await update(["--yes"], { env });
    expect(r.exitCode, err.join("")).toBe(0);
    expect(pinned(userFile(), "fx").commit).toBe(next);
    expect(pinned(userFile(), "viassh").commit).toBe(next);
  }, 180_000);
});

describe("update --project", () => {
  it("re-grants a file trusted before the edit, keeps its comments, and refuses an untrusted one", async () => {
    const repo = makeRepo(NPM_FILES);
    const old = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, old);
    await recordRepoConsent(repo.url, home);
    const cwd = join(home, "proj");
    const dir = join(cwd, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const path = localBundlesPath(dir);
    writeFileSync(path, bundlesText(repo.url, old));
    repo.commit({ "README.md": "v2\n" });

    const refused = await update(["fx", "--project"], { cwd });
    expect(refused.exitCode).toBe(1);
    expect(err.join("")).toContain(`${path} is not trusted; review it with yaw-mcp trust`);
    expect(calls).toEqual([]);

    await grantTrust(path, readFileSync(path), { home });
    err = [];
    const r = await update(["fx", "--project"], { cwd });
    expect(r.exitCode, err.join("")).toBe(0);
    const after = readFileSync(path);
    expect(after.toString()).toContain("// hand-written: keep me");
    expect(pinned(path).commit).not.toBe(old);
    expect(trustStatusFor(path, after, await readTrustStore(home))).toBe("trusted");
    expect(err.join("")).toContain("was trusted before this edit");
    expect(existsSync(userFile())).toBe(false);
  }, 180_000);
});

describe("newerTags", () => {
  it("sorts semver tags newest first, skipping prereleases and non-versions", () => {
    const refs = new Map(
      ["v1.2.0", "v1.2.0^{}", "v1.10.0", "v1.3.0-rc.1", "release", "1.2.5"].map((t) => [`refs/tags/${t}`, "x"]),
    );
    expect(newerTags("v1.2.0", refs)).toEqual(["v1.10.0", "1.2.5"]);
    expect(newerTags("v1.3.0-rc.0", refs)).toEqual(["v1.10.0", "v1.3.0-rc.1"]);
    expect(newerTags("main", refs)).toEqual([]);
  });
});

// --- fix-g2: references, GC, tokens and trust -------------------------------

const HTTPS = "https://forge.example/acme/fx.git";
const SSH = "ssh://git@forge.example/acme/fx.git";

/** git's own insteadOf sends `alias` to the fixture's file:// repo, so an
 *  https:// or ssh:// entry runs with no network and no server. */
function aliased(repo: Repo, alias: string): NodeJS.ProcessEnv {
  return { ...ENV, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo.url}.insteadOf`, GIT_CONFIG_VALUE_0: alias };
}

async function buildFrom(url: string, repo: Repo, commit: string, ns = "fx"): Promise<void> {
  const spec = parseGitSpec(url);
  if (!spec.ok) throw new Error(spec.error);
  const r = await buildGitSource(
    { spec: spec.spec, ref: "main", commit, namespace: ns, entry: "dist/index.js" },
    {
      home,
      env: aliased(repo, url),
      interactive: false,
      yes: true,
      progress: () => {},
      warn: () => {},
      runPm: fakePm([]),
    },
  );
  if (!r.ok) throw new Error(r.message);
}

function withToken(text: string, name: string): string {
  return text.replace('"entry": "dist/index.js" }', `"entry": "dist/index.js", "tokenSecret": "${name}" }`);
}

function projectFile(name: string): { cwd: string; path: string } {
  const cwd = join(home, name);
  const dir = join(cwd, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return { cwd, path: localBundlesPath(dir) };
}

describe("an untrusted project file is never read for git", () => {
  it("update --check and share refuse it, resolve no vault secret and reach no remote", async () => {
    const { cwd, path } = projectFile("evil");
    writeFileSync(path, withToken(bundlesText("https://127.0.0.1:9/x.git", "a".repeat(40)), "OPENAI_API_KEY"));
    const asked: string[] = [];
    const resolveToken = async (n: string): Promise<string> => {
      asked.push(n);
      return "secret-value";
    };
    for (const argv of [
      ["--check", "--project"],
      ["fx", "--project"],
      ["--project", "--json"],
    ]) {
      err = [];
      const r = await update(argv, { cwd, resolveToken });
      expect(r.exitCode).toBe(1);
      expect(err.join("")).toContain(`${path} is not trusted; review it with yaw-mcp trust`);
    }
    err = [];
    const shared = await runShare({
      name: "fx",
      project: true,
      home,
      cwd,
      env: ENV,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(shared.exitCode).toBe(1);
    expect(err.join("")).toContain(`${path} is not trusted; review it with yaw-mcp trust`);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);

    // Not vacuous: once trusted, the same --check does ask for the secret.
    await grantTrust(path, readFileSync(path), { home });
    await update(["--check", "--project"], { cwd, resolveToken });
    expect(asked).toEqual(["OPENAI_API_KEY"]);
  }, 60_000);
});

describe("update reads git entries the way the loader does", () => {
  it("skips an entry whose subdir leaves the clone, with the loader's warning, and runs nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    writeUser(
      bundlesText(repo.url, "b".repeat(40)).replace(
        '"entry": "dist/index.js" }',
        '"subdir": "../../../victim", "entry": "dist/index.js" }',
      ),
    );
    await recordRepoConsent(repo.url, home);
    const r = await update(["fx", "--yes"]);
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain('its git subdir "../../../victim" is refused: it contains a ".." segment');
    expect(err.join("")).toContain('"fx" has a git block yaw-mcp refuses');
    expect(calls).toEqual([]);

    const spec = parseGitSpec(repo.url);
    if (!spec.ok) throw new Error(spec.error);
    const direct = await buildGitSource(
      { spec: spec.spec, commit: head, namespace: "fx", subdir: "../victim", entry: "dist/index.js" },
      { home, env: ENV, interactive: false, yes: true, progress: () => {}, warn: () => {}, runPm: fakePm(calls) },
    );
    expect(direct.ok).toBe(false);
    expect(calls).toEqual([]);
  }, 60_000);

  it("builds a namespace named lock: the git lock cannot collide with a build directory", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, head, "lock");
    expect(existsSync(gitBuiltPath("lock", head, home))).toBe(true);
  }, 120_000);
});

describe("GC keeps every build a bundles.json still pins", () => {
  it("keeps the build another project pins while the user file moves on", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const b = projectFile("proj-b");
    writeFileSync(b.path, bundlesText(repo.url, first));
    await recordGitPin("fx", b.path, first, home);

    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    const third = repo.commit({ "README.md": "3\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual([first, second, third].map((c) => c.slice(0, 12)).sort());
    const refs = JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"));
    expect(refs).toEqual({ [userFile()]: third, [b.path]: first });

    // Once project B moves off it, the next GC lets it go.
    writeFileSync(b.path, bundlesText(repo.url, third));
    const fourth = repo.commit({ "README.md": "4\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual([third, fourth].map((c) => c.slice(0, 12)).sort());
  }, 240_000);

  it("keeps the build a trusted project pins with no record of it, through two GCs", async () => {
    // The natural path: project B is approved before any build exists, so
    // nothing records it; the user file then builds the same commit.
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    const b = projectFile("proj-b");
    writeFileSync(b.path, bundlesText(repo.url, first));
    await grantTrust(b.path, readFileSync(b.path), { home });
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));

    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    const third = repo.commit({ "README.md": "3\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual([first, second, third].map((c) => c.slice(0, 12)).sort());
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).not.toHaveProperty([b.path]);
  }, 240_000);

  it("an update GC stops at a refs.json that does not parse instead of rebuilding it", async () => {
    // `first` is kept alive ONLY by a refs.json record: it is neither the
    // current nor the previous pin, and the project file behind it is neither
    // trusted nor the cwd's. A corrupt refs.json is an unreadable source, so
    // the GC deletes nothing -- recording this build's pin must not consume
    // the corrupt file first and hand the GC a clean one.
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const b = projectFile("proj-x");
    writeFileSync(b.path, bundlesText(repo.url, first));
    await recordGitPin("fx", b.path, first, home);

    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds()).toContain(first.slice(0, 12));

    const refs = gitRefsPath("fx", home);
    const corrupt = '{"truncated": ';
    writeFileSync(refs, corrupt);
    err = [];
    const third = repo.commit({ "README.md": "3\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual([first, second, third].map((c) => c.slice(0, 12)).sort());
    expect(err.join("")).toContain(`warning: no build of fx was deleted: yaw-mcp could not read ${refs}`);
    expect(err.join("")).toContain(`moved it to ${refs}.bad`);
    // The .bad copy is exactly the bytes that failed to parse: nothing parsed
    // records out of a file nobody can read (as remove's test asserts too).
    expect(readFileSync(`${refs}.bad`, "utf8")).toBe(corrupt);
    expect(existsSync(refs)).toBe(false);
  }, 240_000);

  it("an update GC deletes nothing while a file that may pin a build cannot be read", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    // A trusted project that does not parse: it may pin the oldest build.
    const b = projectFile("proj-b");
    writeFileSync(b.path, "{ not json");
    await grantTrust(b.path, readFileSync(b.path), { home });
    err = [];
    const third = repo.commit({ "README.md": "3\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual([first, second, third].map((c) => c.slice(0, 12)).sort());
    expect(err.join("")).toContain(`warning: no build of fx was deleted: yaw-mcp could not read ${b.path}`);
  }, 240_000);

  it("an update that leaves the commit where it is deletes nothing", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    const both = [first, second].map((c) => c.slice(0, 12)).sort();
    expect(builds().sort()).toEqual(both);

    // doctor's own "Rebuild: update --to <current>" hint.
    expect((await update(["fx", "--to", second.slice(0, 7)])).exitCode, err.join("")).toBe(0);
    expect(builds().sort()).toEqual(both);

    // A new ref that points at the same commit.
    git(repo.work, ["push", "-q", "origin", "HEAD:refs/heads/other"]);
    expect((await update(["fx", "--ref", "other"])).exitCode, err.join("")).toBe(0);
    expect(pinned()).toMatchObject({ commit: second, ref: "other" });
    expect(builds().sort()).toEqual(both);
  }, 240_000);

  it("--to keeps the state row's last remote tip, with the pin moved", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    await buildAt(repo, first);
    await recordRepoConsent(repo.url, home);
    writeUser(bundlesText(repo.url, first));
    const second = repo.commit({ "README.md": "2\n" });
    expect((await update(["fx"])).exitCode, err.join("")).toBe(0);
    expect((await update(["fx", "--to", first.slice(0, 7)])).exitCode, err.join("")).toBe(0);
    const row = readGitState(home).fx;
    expect(row).toMatchObject({ pinned: first, remote: second });
  }, 180_000);
});

describe("update --git-token-secret", () => {
  const throwing = async (): Promise<string> => {
    throw new Error("the vault is locked");
  };

  it("--to back to a kept build needs no vault", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    const second = repo.commit({ "README.md": "2\n" });
    await buildFrom(HTTPS, repo, first);
    await buildFrom(HTTPS, repo, second);
    writeUser(withToken(bundlesText(HTTPS, second), "fx_tok"));
    const r = await update(["fx", "--to", first.slice(0, 7), "--json"], {
      env: aliased(repo, HTTPS),
      resolveToken: throwing,
    });
    expect(r.exitCode, err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).entries[0].status).toBe("rolled-back");
    expect(pinned().commit).toBe(first);
  }, 180_000);

  it("is saved for a tag-pinned entry, under --to, and when the commit is unchanged -- never for ssh", async () => {
    const repo = makeRepo(NPM_FILES);
    const first = git(repo.work, ["rev-parse", "HEAD"]);
    git(repo.work, ["tag", "v1.0.0"]);
    git(repo.work, ["push", "-q", "origin", "v1.0.0"]);
    await buildFrom(HTTPS, repo, first);
    const env = aliased(repo, HTTPS);
    const resolveToken = async (): Promise<string> => "tok";
    const tokenOf = (): string | undefined => (pinned() as { tokenSecret?: string }).tokenSecret;

    writeUser(bundlesText(HTTPS, first, "v1.0.0"));
    expect((await update(["fx", "--git-token-secret", "tag_tok"], { env, resolveToken })).exitCode, err.join("")).toBe(
      0,
    );
    expect(out.join("")).toContain("pinned (tag), nothing to update");
    expect(pinned()).toMatchObject({ commit: first, ref: "v1.0.0" });
    expect(tokenOf()).toBe("tag_tok");

    writeUser(bundlesText(HTTPS, first));
    expect((await update(["fx", "--git-token-secret", "branch_tok"], { env, resolveToken })).exitCode).toBe(0);
    expect(tokenOf()).toBe("branch_tok");
    expect(pinned().commit).toBe(first);
    expect(calls).toEqual([]);

    writeUser(bundlesText(HTTPS, first));
    const to = await update(["fx", "--to", first.slice(0, 7), "--git-token-secret", "to_tok"], { env, resolveToken });
    expect(to.exitCode, err.join("")).toBe(0);
    expect(tokenOf()).toBe("to_tok");

    await buildFrom(SSH, repo, first, "viassh");
    writeUser(bundlesText(SSH, first, "main", "viassh"));
    const ssh = await update(["viassh", "--to", first.slice(0, 7), "--git-token-secret", "ssh_tok"], {
      env: aliased(repo, SSH),
      resolveToken,
    });
    expect(ssh.exitCode, err.join("")).toBe(0);
    expect((pinned(userFile(), "viassh") as { tokenSecret?: string }).tokenSecret).toBeUndefined();
  }, 240_000);
});
