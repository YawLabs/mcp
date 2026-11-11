// git-source.ts without a network or a package manager: the URL refusal
// matrix, consent normalization, package-manager detection and resolution,
// the yaw-mcp.json manifest, the consent store and the staging sweep. The
// real clone/install/build runs live in git-source-build.test.ts.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGitSource,
  consentLines,
  detectPackageManager,
  GIT_CREDENTIALS_REFUSAL,
  gitAuthMessage,
  gitHostKeyMessage,
  hasRepoConsent,
  lifecycleScripts,
  normalizeRepoUrl,
  PNPM_FILTER_NAME_RE,
  parseGitSpec,
  planBuild,
  prepareGit,
  readBuildMarker,
  readGitManifest,
  recordRepoConsent,
  redactGitOutput,
  removeTree,
  repoConfigFiles,
  resolvePmCommand,
  resolveRefIn,
  scrubRepoUrlUserinfo,
  scrubUrlUserinfo,
  sweepStaging,
  tokenUsername,
  tryRemoveTree,
  writeAskpassHelper,
} from "../git-source.js";
import { parseAddArgs } from "../local-add-cmd.js";
import { resolveBinAbsolute } from "../oam-spawn.js";
import { gitRoot } from "../paths.js";
import { createEmptyVault, lock, saveVault, setSecret, unlock, vaultPath } from "../secrets-vault.js";
import { fakeFinishedBuild } from "./git-fixture.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "yaw git src-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const file = join(dir, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

describe("parseGitSpec", () => {
  it.each([
    ["https://github.com/acme/x.git", "https", "github.com"],
    ["https://git@GitHub.com/acme/x", "https", "github.com"],
    ["ssh://git@github.com/acme/x.git", "ssh", "github.com"],
    ["ssh://git@host.example:2222/acme/x.git", "ssh", "host.example"],
    ["git@github.com:acme/x.git", "ssh", "github.com"],
    ["host.example:acme/x", "ssh", "host.example"],
    ["file:///C:/repos/x.git", "file", ""],
    ["file:///srv/repos/x", "file", ""],
  ])("accepts %s", (url, protocol, host) => {
    const r = parseGitSpec(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.protocol).toBe(protocol);
      expect(r.spec.host).toBe(host);
      expect(r.spec.url).toBe(url);
      expect(r.spec.ref).toBeUndefined();
    }
  });

  it("splits the #ref off and keeps the URL as typed", () => {
    const r = parseGitSpec("git@github.com:acme/x.git#v1.4.0");
    expect(r).toMatchObject({ ok: true, spec: { url: "git@github.com:acme/x.git", ref: "v1.4.0" } });
    expect(parseGitSpec("https://h.example/a/b#feature/x")).toMatchObject({ ok: true, spec: { ref: "feature/x" } });
  });

  const cred = [
    "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/x.git",
    "https://user:pw@github.com/acme/x.git",
    "https://:pw@github.com/acme/x.git",
    "https://x-access-token:tok@github.com/acme/x.git",
    "https://glpat-abc@gitlab.com/acme/x.git",
    "ssh://git:pw@github.com/acme/x.git",
    "https://averyveryverylongusername@github.com/acme/x.git",
    "user:pw@host.example:acme/x",
  ];
  it.each(cred)("refuses credentials in %s without echoing them", (url) => {
    const r = parseGitSpec(url);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(GIT_CREDENTIALS_REFUSAL);
      expect(r.error).not.toContain("pw");
      expect(r.error).not.toContain("ghp_");
    }
  });

  it.each([
    ["ext::sh -c touch% /tmp/pwned", "transport"],
    ["fd::17", "transport"],
    ["git+ssh://git@github.com/acme/x", "not supported"],
    ["http://github.com/acme/x", "not supported"],
    ["git://github.com/acme/x", "not supported"],
    ["-uhelp", 'cannot start with "-"'],
    ["--upload-pack=touch x", 'cannot start with "-"'],
    ["C:\\repos\\x", "file://"],
    ["https://github.com/", "no repository path"],
    ["https://h.example/a/b#", "empty"],
    ["https://h.example/a/b#-x", 'cannot start with "-"'],
    ["https://h.example/a/b#a..b", "not a usable"],
    ["just-a-name", "not a git URL"],
    ["file://otherhost/x", "local path"],
    ["file://user@localhost/x", "username"],
  ])("refuses %s", (url, fragment) => {
    const r = parseGitSpec(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });

  it("refuses control bytes anywhere, ref included", () => {
    for (const code of [0, 9, 10, 13, 27, 127]) {
      const c = String.fromCharCode(code);
      expect(parseGitSpec(`https://h.example/a${c}b`).ok).toBe(false);
      expect(parseGitSpec(`https://h.example/a/b#main${c}`).ok).toBe(false);
    }
  });
});

describe("normalizeRepoUrl: one repo, any protocol", () => {
  it("treats scp, ssh:// and https:// spellings of one repo as the same", () => {
    const forms = [
      "git@github.com:acme/crm-mcp.git",
      "git@GitHub.com:acme/crm-mcp",
      "ssh://git@github.com/acme/crm-mcp.git",
      "ssh://git@github.com:22/acme/crm-mcp/",
      "https://github.com/acme/crm-mcp.git",
      "https://git@github.com/acme/crm-mcp/",
      "https://github.com/acme/crm-mcp.git/",
    ];
    const keys = new Set(forms.map(normalizeRepoUrl));
    expect([...keys]).toEqual(["github.com/acme/crm-mcp"]);
  });

  it("keeps different repos and hosts apart", () => {
    expect(normalizeRepoUrl("git@github.com:acme/a.git")).not.toBe(normalizeRepoUrl("git@github.com:acme/b.git"));
    expect(normalizeRepoUrl("git@github.com:acme/a.git")).not.toBe(normalizeRepoUrl("git@gitlab.com:acme/a.git"));
  });

  it("normalizes file:// URLs by path", () => {
    expect(normalizeRepoUrl("file:///C:/Repos/x.git")).toBe(normalizeRepoUrl("file:///c:/Repos/x/"));
  });

  it("does not throw on a file:// URL whose path holds a stray percent sign", () => {
    // parseGitSpec accepts it (new URL parses it), and decodeURIComponent of
    // its pathname throws URIError: the consent lookup must not.
    expect(parseGitSpec("file:///tmp/a%zz/repo").ok).toBe(true);
    expect(normalizeRepoUrl("file:///tmp/a%zz/repo.git")).toBe("file:/tmp/a%zz/repo");
    expect(hasRepoConsent("file:///tmp/a%zz/repo", dir)).toBe(false);
    // A path that does decode still does.
    expect(normalizeRepoUrl("file:///tmp/a%20b/repo")).toBe("file:/tmp/a b/repo");
  });
});

describe("redaction", () => {
  it("scrubs bare URL userinfo and named secret values", () => {
    const text = "fatal: unable to access 'https://ghp_secretvalue123@github.com/a/b': 403\nusing tok-abcdefghij";
    const out = redactGitOutput(text, { GH_TOKEN: "tok-abcdefghij" });
    expect(out).not.toContain("ghp_secretvalue123");
    expect(out).not.toContain("tok-abcdefghij");
    expect(out).toContain("https://***@github.com");
    expect(scrubUrlUserinfo("ssh://git@host/x")).toBe("ssh://***@host/x");
  });

  it("scrubs an unencoded password holding a slash, whitespace or an @", () => {
    // A matcher that stopped at the first `/` or space left these untouched,
    // and one that stopped at the first `@` left the password's tail.
    expect(scrubUrlUserinfo("https://user:abc/def==@host/mcp")).toBe("https://***@host/mcp");
    expect(scrubUrlUserinfo("fatal: unable to access 'https://user:abc/def==@github.com/a/b/': 403")).toBe(
      "fatal: unable to access 'https://***@github.com/a/b/': 403",
    );
    expect(scrubUrlUserinfo("https://user:abc def@host/x")).toBe("https://***@host/x");
    expect(scrubUrlUserinfo("https://user:abc\tdef@host/x")).toBe("https://***@host/x");
    expect(scrubUrlUserinfo("https://user:p@ss@host/x")).toBe("https://***@host/x");
    expect(scrubUrlUserinfo("https://user:a?b#c@host/x")).toBe("https://***@host/x");
  });

  it("keeps the stricter userinfo rule inside one url on one line", () => {
    // A path `@` with no colon ahead of it is not a userinfo.
    expect(scrubUrlUserinfo("https://host/@org/mcp")).toBe("https://host/@org/mcp");
    // An `@` on the NEXT line does not pull the url in.
    expect(scrubUrlUserinfo("https://host:8443/x\nmail a@b.example")).toBe("https://host:8443/x\nmail a@b.example");
    // Two credentialed urls on one line are scrubbed one by one, so the first
    // host stays visible.
    expect(scrubUrlUserinfo("https://u:p/q@h1/x and https://c:d@h2/y")).toBe("https://***@h1/x and https://***@h2/y");
    // Accepted over-match: a port with an `@` later on the line.
    expect(scrubUrlUserinfo("https://host:8443/mcp?user=a@b.example")).toBe("https://***@b.example");
    // The password stops at the quote git puts round the url, so a later `@`
    // on the line is not pulled in ...
    expect(scrubUrlUserinfo("fatal: 'https://u:p@h/x' failed; mail a@b.example")).toBe(
      "fatal: 'https://***@h/x' failed; mail a@b.example",
    );
    // ... and at a bare CR, which git's progress output uses as a line break.
    expect(scrubUrlUserinfo("https://host:8443/x\rmail a@b.example")).toBe("https://host:8443/x\rmail a@b.example");
  });

  it("scrubRepoUrlUserinfo: one repo url keeps its host when an @ follows a port", () => {
    // The free-text rule runs a `host:port` to a later `@`; a single url is
    // cut where the URL parser ends its userinfo, so the host survives.
    for (const url of [
      "https://git.corp:8443/@team/mcp.git",
      "ssh://git.corp:2222/@org/x.git",
      "https://host/@org/mcp",
    ]) {
      expect(scrubRepoUrlUserinfo(url)).toBe(url);
    }
    expect(scrubRepoUrlUserinfo("ssh://git@host:2222/@org/x.git")).toBe("ssh://***@host:2222/@org/x.git");
    expect(scrubRepoUrlUserinfo("https://u:p@ss@git.corp:8443/@team/mcp.git")).toBe(
      "https://***@git.corp:8443/@team/mcp.git",
    );
    expect(normalizeRepoUrl(scrubRepoUrlUserinfo("ssh://git@host:2222/@org/x.git"))).toBe(
      normalizeRepoUrl("ssh://git@host:2222/@org/x.git"),
    );
    // A url the parser rejects (an unencoded `/` in the password) takes the
    // free-text rule, which scrubs it; scp-style has no `://` to scrub.
    expect(scrubRepoUrlUserinfo("https://user:abc/def==@host/mcp")).toBe("https://***@host/mcp");
    expect(scrubRepoUrlUserinfo("git@github.com:acme/x.git")).toBe("git@github.com:acme/x.git");
  });

  it("stays linear on a long build-log line with no userinfo", () => {
    // A `scheme://` stop re-scanned per password character was quadratic: a
    // 20k tail after `http://host:port` took seconds, 200k never finished.
    // 50k keeps a regression red in seconds rather than minutes.
    const portTail = `see http://localhost:3000/${"a".repeat(50_000)}`;
    // `\b` holds after every `.`, so an unbounded scheme scan from each start
    // was quadratic too (40k chars took about 5 s).
    const dotted = "a.".repeat(50_000);
    const start = Date.now();
    expect(scrubUrlUserinfo(portTail)).toBe(portTail);
    expect(scrubUrlUserinfo(dotted)).toBe(dotted);
    // About 5 ms when linear; the regressions took 24-36 s. The wide bound
    // keeps a loaded machine from flaking it.
    expect(Date.now() - start).toBeLessThan(5000);
    // The cap still lets a scheme glued to a dotted run match.
    expect(scrubUrlUserinfo(`${"x.".repeat(100)}https://u:p/q@h/r`)).toBe(`${"x.".repeat(100)}https://***@h/r`);
  });
});

describe("tokenUsername", () => {
  it("names the forge's token user, else the URL's, else git", () => {
    const spec = (url: string) => {
      const r = parseGitSpec(url);
      if (!r.ok) throw new Error(r.error);
      return r.spec;
    };
    expect(tokenUsername(spec("https://github.com/a/b"))).toBe("x-access-token");
    expect(tokenUsername(spec("https://gitlab.example.com/a/b"))).toBe("oauth2");
    expect(tokenUsername(spec("https://git.example/a/b"))).toBe("git");
    expect(tokenUsername(spec("https://gitlab.com/a/b"))).toBe("oauth2");
    expect(tokenUsername(spec("https://bob@git.example/a/b"))).toBe("bob");
  });
});

describe("detectPackageManager", () => {
  const pkg = (extra: Record<string, unknown> = {}) => write("package.json", JSON.stringify({ name: "x", ...extra }));

  it.each([
    [{}, [], "npm", false, null, ["install", "--include=dev", "--no-audit", "--no-fund"]],
    [{}, ["package-lock.json"], "npm", false, "package-lock.json", ["ci", "--include=dev", "--no-audit", "--no-fund"]],
    [
      {},
      ["npm-shrinkwrap.json"],
      "npm",
      false,
      "npm-shrinkwrap.json",
      ["ci", "--include=dev", "--no-audit", "--no-fund"],
    ],
    [{}, ["pnpm-lock.yaml"], "pnpm", false, "pnpm-lock.yaml", ["install", "--frozen-lockfile"]],
    [{}, ["yarn.lock"], "yarn", false, "yarn.lock", ["install", "--frozen-lockfile", "--production=false"]],
    [{}, ["yarn.lock", ".yarnrc.yml"], "yarn", true, "yarn.lock", ["install", "--immutable"]],
    [{ packageManager: "yarn@4.5.0" }, ["yarn.lock"], "yarn", true, "yarn.lock", ["install", "--immutable"]],
    [
      { packageManager: "yarn@1.22.22" },
      ["yarn.lock"],
      "yarn",
      false,
      "yarn.lock",
      ["install", "--frozen-lockfile", "--production=false"],
    ],
    // The field beats the lockfile.
    [
      { packageManager: "pnpm@9.12.0+sha512.abc" },
      ["package-lock.json", "pnpm-lock.yaml"],
      "pnpm",
      false,
      "pnpm-lock.yaml",
      ["install", "--frozen-lockfile"],
    ],
    [
      { packageManager: "npm@10.9.0" },
      ["yarn.lock"],
      "npm",
      false,
      null,
      ["install", "--include=dev", "--no-audit", "--no-fund"],
    ],
  ])("%j + %j -> %s", (fields, files, pm, berry, lockfile, installArgs) => {
    pkg(fields);
    for (const f of files) write(f, "");
    const plan = detectPackageManager(dir);
    expect("error" in plan).toBe(false);
    if ("error" in plan) return;
    expect(plan.pm).toBe(pm);
    expect(plan.berry).toBe(berry);
    expect(plan.lockfile).toBe(lockfile);
    expect(plan.installArgs).toEqual(installArgs);
    expect(plan.warnings.length > 0).toBe(lockfile === null);
  });

  it("removes NODE_ENV for pnpm and forces a node_modules linker for berry", () => {
    pkg();
    write("pnpm-lock.yaml", "");
    const pnpm = detectPackageManager(dir);
    expect("error" in pnpm ? null : Object.hasOwn(pnpm.env, "NODE_ENV") && pnpm.env.NODE_ENV).toBeUndefined();
    rmSync(join(dir, "pnpm-lock.yaml"));
    write("yarn.lock", "");
    write(".yarnrc.yml", "");
    const berry = detectPackageManager(dir);
    expect("error" in berry ? null : berry.env.YARN_NODE_LINKER).toBe("node-modules");
  });

  it("stops cmd.exe searching the clone before PATH, for every package manager", () => {
    for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      pkg();
      write(lock, "");
      const plan = detectPackageManager(dir);
      expect("error" in plan ? null : plan.env.NoDefaultCurrentDirectoryInExePath, lock).toBe("1");
      rmSync(join(dir, lock));
    }
  });

  it("refuses bun, by field or by lockfile", () => {
    pkg({ packageManager: "bun@1.1.0" });
    expect(detectPackageManager(dir)).toMatchObject({ error: expect.stringContaining("bun") });
    pkg();
    write("bun.lockb", "");
    expect(detectPackageManager(dir)).toEqual({
      error: "this repo uses bun (bun.lockb); yaw-mcp builds npm, pnpm and yarn repos only.",
    });
    rmSync(join(dir, "bun.lockb"));
    write("bun.lock", "");
    expect(detectPackageManager(dir)).toEqual({
      error: "this repo uses bun (bun.lock); yaw-mcp builds npm, pnpm and yarn repos only.",
    });
  });

  it("refuses a packageManager value it cannot read", () => {
    pkg({ packageManager: "pnpm" });
    expect(detectPackageManager(dir)).toMatchObject({ error: expect.stringContaining("packageManager") });
  });
});

describe("resolvePmCommand", () => {
  const ext = process.platform === "win32" ? ".cmd" : "";
  function binDir(names: string[], at = join(dir, "bin")): string {
    mkdirSync(at, { recursive: true });
    for (const n of names) writeFileSync(join(at, `${n}${ext}`), "", { mode: 0o755 });
    return at;
  }
  const env = (...dirs: string[]) => ({ PATH: dirs.join(delimiter), PATHEXT: ".CMD;.EXE" });
  const nodeDir = () => join(dir, "nonode");
  const abs = (d: string, n: string): string =>
    process.platform === "win32" ? `"${resolveBinAbsolute(n, env(d))}"` : join(d, n);

  it("runs npm as the npm beside node when nothing pins a version", () => {
    const nd = binDir(["npm"], join(dir, "node"));
    expect(resolvePmCommand({ pm: "npm" }, { env: env(binDir(["corepack"])), nodeDir: nd })).toEqual({
      prefix: [],
      label: "npm",
    });
  });

  it("runs a pinned npm through corepack, like pnpm and yarn", () => {
    const d = binDir(["npm", "corepack"]);
    expect(resolvePmCommand({ pm: "npm", version: "11.2.0" }, { env: env(d), nodeDir: nodeDir() })).toEqual({
      bin: abs(d, "corepack"),
      prefix: ["npm"],
      label: "corepack npm",
    });
  });

  it("gives an npm with no sibling of node its absolute PATH location, never the bare name", () => {
    const d = binDir(["npm"]);
    expect(resolvePmCommand({ pm: "npm" }, { env: env(d), nodeDir: nodeDir() })).toEqual({
      bin: abs(d, "npm"),
      prefix: [],
      label: "npm",
    });
  });

  it("prefers corepack when the version is pinned", () => {
    const d = binDir(["pnpm", "corepack"]);
    expect(resolvePmCommand({ pm: "pnpm", version: "9.12.0" }, { env: env(d), nodeDir: nodeDir() })).toEqual({
      bin: abs(d, "corepack"),
      prefix: ["pnpm"],
      label: "corepack pnpm",
    });
  });

  it("uses the binary on PATH when nothing is pinned, corepack as the fallback", () => {
    const d = binDir(["yarn", "corepack"]);
    expect(resolvePmCommand({ pm: "yarn" }, { env: env(d), nodeDir: nodeDir() })).toEqual({
      bin: abs(d, "yarn"),
      prefix: [],
      label: "yarn",
    });
    rmSync(join(dir, "bin"), { recursive: true });
    const c = binDir(["corepack"]);
    expect(resolvePmCommand({ pm: "yarn" }, { env: env(c), nodeDir: nodeDir() })).toMatchObject({
      bin: abs(c, "corepack"),
      prefix: ["yarn"],
    });
  });

  it("never picks a package manager the clone planted, even with the clone on PATH", () => {
    const clone = join(dir, "clone");
    binDir(["pnpm", "corepack"], clone);
    binDir(["pnpm"], join(clone, "node_modules", ".bin"));
    const real = binDir(["pnpm"]);
    const e = env(clone, join(clone, "node_modules", ".bin"), real);
    expect(resolvePmCommand({ pm: "pnpm" }, { env: e, nodeDir: nodeDir(), exclude: clone })).toEqual({
      bin: abs(real, "pnpm"),
      prefix: [],
      label: "pnpm",
    });
    const onlyPlanted = env(clone);
    expect(
      resolvePmCommand(
        { pm: "pnpm" },
        { env: onlyPlanted, nodeDir: nodeDir(), exclude: clone, nodeVersion: "v22.0.0" },
      ),
    ).toEqual({ error: "this repo builds with pnpm, which is not installed. Run: corepack enable" });
  });

  it("finds a corepack beside node, quoted on Windows", () => {
    const nd = join(dir, "node dir");
    mkdirSync(nd);
    writeFileSync(join(nd, "corepack.cmd"), "");
    const r = resolvePmCommand({ pm: "pnpm" }, { env: { PATH: join(dir, "empty") }, platform: "win32", nodeDir: nd });
    expect(r).toMatchObject({ bin: `"${join(nd, "corepack.cmd")}"`, prefix: ["pnpm"] });
  });

  it("names the install step when neither exists, with the Node >= 25 hint", () => {
    const opts = { env: { PATH: join(dir, "empty") }, nodeDir: nodeDir() };
    expect(resolvePmCommand({ pm: "pnpm" }, { ...opts, nodeVersion: "v22.11.0" })).toEqual({
      error: "this repo builds with pnpm, which is not installed. Run: corepack enable",
    });
    expect(resolvePmCommand({ pm: "pnpm" }, { ...opts, nodeVersion: "v25.0.0" })).toEqual({
      error: "this repo builds with pnpm, which is not installed. Run: npm i -g corepack && corepack enable",
    });
  });
});

describe("planBuild and lifecycleScripts", () => {
  it("builds only when the target declares a build, through pnpm --filter in a pnpm workspace subdir", () => {
    write("package.json", JSON.stringify({ name: "root", scripts: { prepare: "husky" } }));
    write("pnpm-workspace.yaml", "packages: ['packages/*']\n");
    write("packages/server/package.json", JSON.stringify({ name: "@acme/server", scripts: { build: "tsc -p ." } }));
    const plan = detectPackageManager(dir);
    if ("error" in plan) throw new Error(plan.error);
    const target = join(dir, "packages", "server");
    expect(planBuild({ ...plan, pm: "pnpm" }, dir, target)).toEqual({
      args: ["--filter", "@acme/server...", "run", "build"],
      cwd: dir,
    });
    expect(planBuild({ ...plan, pm: "npm" }, dir, target)).toEqual({ args: ["run", "build"], cwd: target });
    expect(planBuild(plan, dir, dir)).toBeNull();
    expect(lifecycleScripts(dir, target)).toEqual([
      { label: "prepare", text: "husky" },
      { label: "packages/server build", text: "tsc -p ." },
    ]);
  });

  it("refuses a workspace package name that is not a registry name", () => {
    for (const bad of ["a&b", "x|y", "%PATH%", "a b", "(x)", "a^b", "a!b", '"a"', "A"]) {
      expect(PNPM_FILTER_NAME_RE.test(bad), bad).toBe(false);
    }
    expect(PNPM_FILTER_NAME_RE.test("@scope/pkg.name-1_x~")).toBe(true);
  });

  it("refuses a pnpm workspace subdir whose package name fails PNPM_FILTER_NAME_RE", () => {
    write("package.json", JSON.stringify({ name: "root", scripts: { prepare: "husky" } }));
    write("pnpm-workspace.yaml", "packages: ['packages/*']\n");
    write("packages/bad/package.json", JSON.stringify({ name: "a&b", scripts: { build: "tsc -p ." } }));
    const plan = detectPackageManager(dir);
    if ("error" in plan) throw new Error(plan.error);
    const target = join(dir, "packages", "bad");
    // The {error} half of planBuild: a build turns this into fail(2, ...) at
    // git-source.ts's `if (build && "error" in build)` check, before anything
    // runs -- the happy path above only ever exercises the {args} half.
    expect(planBuild({ ...plan, pm: "pnpm" }, dir, target)).toEqual({
      error: 'the package in the subdir has no usable name ("a&b") for pnpm --filter.',
    });
    // npm passes no --filter, so the same repo-chosen name is harmless there.
    expect(planBuild({ ...plan, pm: "npm" }, dir, target)).toEqual({ args: ["run", "build"], cwd: target });
  });
});

describe("reuse of a finished build on disk", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-reuse-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const spec = () => {
    const p = parseGitSpec("https://x.example/acme/y.git");
    if (!p.ok) throw new Error(p.error);
    return p.spec;
  };
  const ctx = { env: {}, interactive: false, yes: true, progress: () => {}, warn: () => {} } as const;
  const buildDir = (): string => join(home, ".yaw-mcp", "git", "acme", COMMIT.slice(0, 12));

  // reuse() in buildLocked runs before any git child, so these need no repo:
  // a fake URL can never be contacted on the path under test.
  it("refuses a request whose subdir differs from the one the marker records", async () => {
    fakeFinishedBuild(buildDir(), COMMIT);
    const r = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme", subdir: "packages/srv" },
      { home, ...ctx },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.exitCode).toBe(1);
    expect(r.message).toBe(
      `${COMMIT.slice(0, 7)} is already built for subdir "." under "acme"; add it under another name to build subdir "packages/srv".`,
    );
  });

  it("refuses when the entry this request names is not in the finished build", async () => {
    // The marker stays VALID (its own entry, index.js, is on disk) -- only the
    // entry the request brings is missing, which is the one refusal that
    // reaches the entry check: deleting the marker's entry would invalidate
    // the marker and fall through to a fresh clone instead.
    fakeFinishedBuild(buildDir(), COMMIT);
    const r = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme", entry: "dist/index.js" },
      { home, ...ctx },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.exitCode).toBe(1);
    expect(r.message).toBe(
      `Built ${COMMIT.slice(0, 7)} but its entry dist/index.js does not exist. Pass --entry <file>.`,
    );
  });

  it("reuses a build the request does fit, without contacting the remote", async () => {
    fakeFinishedBuild(buildDir(), COMMIT);
    const said: string[] = [];
    const r = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme" },
      { home, ...ctx, progress: (l) => said.push(l) },
    );
    expect(r).toMatchObject({ ok: true, reused: true, namespace: "acme", entry: "index.js", dir: buildDir() });
    expect(said).toEqual([`Using the existing build of ${COMMIT.slice(0, 12)}`]);
  });

  it('does not announce "Using the existing build" for a build it then refuses', async () => {
    fakeFinishedBuild(buildDir(), COMMIT);
    const said: string[] = [];
    const quiet = { home, ...ctx, progress: (l: string) => said.push(l) };
    const wrongSubdir = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme", subdir: "packages/srv" },
      quiet,
    );
    const noEntry = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme", entry: "dist/index.js" },
      quiet,
    );
    expect(wrongSubdir.ok).toBe(false);
    expect(noEntry.ok).toBe(false);
    expect(said).toEqual([]);
  });

  it("refuses to reuse a build for an --entry that is a directory, and says it is not a file", async () => {
    fakeFinishedBuild(buildDir(), COMMIT, { entry: "dist/index.js" });
    const r = await buildGitSource(
      { spec: spec(), commit: COMMIT, namespace: "acme", entry: "dist" },
      { home, ...ctx },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(`Built ${COMMIT.slice(0, 7)} but its entry dist is not a file. Pass --entry <file>.`);
  });

  it("treats one subdir spelled differently as the same directory", async () => {
    // A marker an earlier build wrote as typed ("./packages/srv"), asked for
    // again under every other spelling; the result always carries the tidy one.
    fakeFinishedBuild(buildDir(), COMMIT, { subdir: "./packages/srv" });
    for (const subdir of ["packages/srv", "./packages/srv", "packages/srv/", "packages\\srv"]) {
      const r = await buildGitSource({ spec: spec(), commit: COMMIT, namespace: "acme", subdir }, { home, ...ctx });
      expect(r, subdir).toMatchObject({ ok: true, reused: true, subdir: "packages/srv" });
    }
  });

  it('treats subdir "." as the repo root', async () => {
    fakeFinishedBuild(buildDir(), COMMIT);
    const r = await buildGitSource({ spec: spec(), commit: COMMIT, namespace: "acme", subdir: "." }, { home, ...ctx });
    expect(r).toMatchObject({ ok: true, reused: true });
    if (r.ok) expect(r.subdir).toBeUndefined();
  });
});

describe("readGitManifest (yaw-mcp.json)", () => {
  it("reads the allowed fields and refuses anything that changes what runs", () => {
    write(
      "yaw-mcp.json",
      `// comments are fine
      { "$schema": "x", "version": 1, "namespace": "acme_crm", "description": "Acme CRM",
        "entry": "dist/index.js", "command": "rm", "args": ["-rf"], "scripts": {"build": "x"}, "frob": 1,
        "env": { "CRM_TOKEN": { "secret": "crm_token", "required": true, "help": "https://wiki" },
                 "CRM_REGION": { "default": "us" }, "bad key": {} } }`,
    );
    const { manifest, warnings } = readGitManifest(dir);
    expect(manifest).toEqual({
      namespace: "acme_crm",
      description: "Acme CRM",
      entry: "dist/index.js",
      env: {
        CRM_TOKEN: { secret: "crm_token", required: true, help: "https://wiki" },
        CRM_REGION: { default: "us" },
      },
    });
    expect(warnings.join("\n")).toMatch(/"command" is refused/);
    expect(warnings.join("\n")).toMatch(/"args" is refused/);
    expect(warnings.join("\n")).toMatch(/"scripts" is refused/);
    expect(warnings.join("\n")).toMatch(/unknown key "frob"/);
    expect(warnings.join("\n")).toMatch(/env "bad key" ignored/);
  });

  it("layers the subdir manifest over the root key by key", () => {
    write("yaw-mcp.json", JSON.stringify({ subdir: "packages/server", namespace: "root_ns", description: "root" }));
    write("packages/server/yaw-mcp.json", JSON.stringify({ description: "sub", entry: "out/main.js", subdir: "x" }));
    const { manifest, warnings } = readGitManifest(dir);
    expect(manifest).toEqual({
      subdir: "packages/server",
      namespace: "root_ns",
      description: "sub",
      entry: "out/main.js",
    });
    expect(warnings.join("\n")).toMatch(/"subdir" ignored in a subdir manifest/);
    expect(readGitManifest(dir, "other").manifest.description).toBe("root");
  });

  it('calls only a version above 1 "newer"; anything else is an unsupported version', () => {
    const warned = (version: unknown): string => {
      write("yaw-mcp.json", JSON.stringify({ version, description: "d" }));
      const { manifest, warnings } = readGitManifest(dir);
      expect(manifest.description).toBe("d");
      return warnings.join("\n");
    };
    expect(warned(1)).toBe("");
    expect(warned(2)).toBe("yaw-mcp.json: version 2 is newer than this yaw-mcp; reading the fields it knows.");
    for (const v of [0, "1", "2", null]) {
      expect(warned(v)).toBe(
        `yaw-mcp.json: version ${JSON.stringify(v)} is not a supported version (this yaw-mcp reads version 1); reading the fields it knows.`,
      );
    }
  });

  it("is silent when there is no manifest, and refuses unsafe paths", () => {
    expect(readGitManifest(dir)).toEqual({ manifest: {}, warnings: [] });
    write("yaw-mcp.json", JSON.stringify({ entry: "../../etc/passwd", subdir: "C:/x", namespace: "Bad-NS" }));
    const { manifest, warnings } = readGitManifest(dir);
    expect(manifest).toEqual({});
    expect(warnings).toHaveLength(3);
  });

  it("puts the description and the needed secrets on the consent screen, ASCII only", () => {
    const lines = consentLines(
      [{ label: "build", text: "tsc \u2014 -p ." }],
      { description: "CRM", env: { CRM_TOKEN: { secret: "crm_token", help: "https://wiki" } } },
      "acme_crm",
    );
    expect(lines).toEqual([
      'acme_crm -- "CRM" (from the repo\'s yaw-mcp.json)',
      "This will run code from the repo on this machine:",
      "  build:  tsc ? -p .",
      "Needs secrets: crm_token (CRM_TOKEN) -- https://wiki",
    ]);
  });
});

describe("repo consent store", () => {
  it("is granted once per normalized repo URL", async () => {
    expect(hasRepoConsent("git@github.com:acme/x.git", dir)).toBe(false);
    await recordRepoConsent("git@github.com:acme/x.git", dir);
    expect(hasRepoConsent("https://github.com/acme/x", dir)).toBe(true);
    expect(hasRepoConsent("ssh://git@github.com/acme/x.git", dir)).toBe(true);
    expect(hasRepoConsent("git@github.com:acme/y.git", dir)).toBe(false);
    const stored = JSON.parse(readFileSync(join(gitRoot(dir), "consent.json"), "utf8"));
    expect(Object.keys(stored.repos)).toEqual(["github.com/acme/x"]);
  });
});

describe("staging sweep and tree removal", () => {
  it("removes leftover .tmp-* dirs at the root and under each namespace, nothing else", () => {
    const root = gitRoot(dir);
    for (const p of [".tmp-aaa/x", "acme/.tmp-bbb/y", "acme/0123456789ab/keep"]) {
      mkdirSync(join(root, ...p.split("/")), { recursive: true });
    }
    sweepStaging(dir);
    expect(existsSync(join(root, ".tmp-aaa"))).toBe(false);
    expect(existsSync(join(root, "acme", ".tmp-bbb"))).toBe(false);
    expect(existsSync(join(root, "acme", "0123456789ab", "keep"))).toBe(true);
  });

  it("deletes a tree holding a junction without touching the junction's target", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious"), "x");
    const tree = join(dir, "build", "node_modules");
    mkdirSync(tree, { recursive: true });
    symlinkSync(outside, join(tree, "linked"), process.platform === "win32" ? "junction" : "dir");
    removeTree(join(dir, "build"));
    expect(existsSync(join(dir, "build"))).toBe(false);
    expect(existsSync(join(outside, "precious"))).toBe(true);
  });
});

describe("parseAddArgs --git", () => {
  it("parses the git flags, the optional name and the server args after --", () => {
    const r = parseAddArgs([
      "--git",
      "git@github.com:acme/x.git#main",
      "--subdir",
      "packages/server",
      "--entry",
      "dist/index.js",
      "--yes",
      "--project",
      "--no-start-check",
      "--git-token-secret",
      "gh_token",
      "--env",
      "A=1",
      "--",
      "--verbose",
      "--port",
      "3",
    ]);
    expect(r).toMatchObject({
      ok: true,
      options: {
        git: { url: "git@github.com:acme/x.git", ref: "main" },
        subdir: "packages/server",
        entry: "dist/index.js",
        yes: true,
        project: true,
        noStartCheck: true,
        gitTokenSecret: "gh_token",
        envOverrides: { A: "1" },
        serverArgs: ["--verbose", "--port", "3"],
      },
    });
    if (r.ok) expect(r.options.slug).toBeUndefined();
    expect(parseAddArgs(["acme-tools", "--git", "file:///x"])).toMatchObject({
      ok: true,
      options: { slug: "acme-tools" },
    });
  });

  it.each([
    ["--command", "npx x"],
    ["--url", "https://h/mcp"],
    ["--header", "A: b"],
    ["--transport", "sse"],
    ["--catalog", "https://c"],
  ])("refuses --git with %s", (flag, value) => {
    expect(parseAddArgs(["n", "--git", "file:///x", flag, value])).toEqual({
      ok: false,
      error: "--git cannot be combined with --command, --url, --header, --transport or --catalog.",
    });
  });

  it("refuses the git-only flags without --git, and unsafe paths", () => {
    for (const argv of [
      ["n", "--command", "x", "--yes"],
      ["n", "--subdir", "a"],
      ["n", "--project"],
      ["n", "--", "x"],
    ]) {
      const r = parseAddArgs(argv);
      expect(r.ok, argv.join(" ")).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/applies to a git server/);
    }
    expect(parseAddArgs(["--git", "file:///x", "--subdir", "../up"])).toMatchObject({ ok: false });
    expect(parseAddArgs(["--git", "file:///x", "--entry", "/abs.js"])).toMatchObject({ ok: false });
    expect(parseAddArgs(["--git", "https://ghp_abc123def456@github.com/a/b"])).toEqual({
      ok: false,
      error: GIT_CREDENTIALS_REFUSAL,
    });
    expect(parseAddArgs(["a", "b", "--git", "file:///x"])).toMatchObject({ ok: false });
  });
});

describe("resolveRefIn: an entry tracking HEAD", () => {
  it("resolves the stored HEAD again when the remote advertises no symref", () => {
    const spec = (ref?: string) => {
      const p = parseGitSpec(`https://x.example/acme/y.git${ref ? `#${ref}` : ""}`);
      if (!p.ok) throw new Error(p.error);
      return p.spec;
    };
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const added = resolveRefIn(spec(), {
      refs: new Map([
        ["HEAD", a],
        ["refs/heads/main", a],
      ]),
    });
    expect(added).toEqual({ ok: true, ref: "HEAD", kind: "head", commit: a });
    const updated = resolveRefIn(spec("HEAD"), {
      refs: new Map([
        ["HEAD", b],
        ["refs/heads/main", b],
      ]),
    });
    expect(updated).toEqual({ ok: true, ref: "HEAD", kind: "head", commit: b });
  });
});

describe("auth and host-key messages", () => {
  const spec = (u: string) => {
    const p = parseGitSpec(u);
    if (!p.ok) throw new Error(p.error);
    return p.spec;
  };

  it("gives an SSH URL only the ssh checks, plus git's rewrite to HTTPS", () => {
    const m = gitAuthMessage(spec("git@github.com:acme/x.git"));
    expect(m).toContain("over SSH. Check: ssh -T git@github.com");
    expect(m).toContain("Windows ssh-agent");
    expect(m).toContain('git config --global url."https://github.com/".insteadOf "git@github.com:"');
    expect(m).toContain("acme/x -- ask its owner.");
    for (const other of ["ls-remote", "credential helper", "--git-token-secret", "The token in secret"]) {
      expect(m).not.toContain(other);
    }
    const port = gitAuthMessage(spec("ssh://git@forge.example:2222/acme/x.git"));
    expect(port).toContain("ssh -T -p 2222 git@forge.example");
    expect(port).toContain('url."https://forge.example/".insteadOf "ssh://git@forge.example:2222/"');
  });

  it("gives an HTTPS URL only the credential checks, the token line, plus git's rewrite to SSH", () => {
    const m = gitAuthMessage(spec("https://git@gitlab.example/acme/x.git"), "gl_tok");
    expect(m).toContain("over HTTPS. Check: git ls-remote https://git@gitlab.example/acme/x.git");
    expect(m).toContain("--git-token-secret");
    expect(m).toContain('The token in secret "gl_tok" was rejected, or lacks read access.');
    expect(m).toContain('git config --global url."git@gitlab.example:".insteadOf "https://git@gitlab.example/"');
    expect(m).toContain("acme/x -- ask its owner.");
    for (const other of ["ssh -T", "ssh-agent", "***"]) expect(m).not.toContain(other);
  });

  it("tells a teammate on a shared entry to rewrite rather than edit the file", () => {
    expect(gitAuthMessage(spec("git@github.com:acme/x.git"), undefined, true)).toContain(
      'To use HTTPS on this machine without editing the shared file: git config --global url."https://github.com/".insteadOf "git@github.com:"',
    );
    expect(gitAuthMessage(spec("https://github.com/acme/x.git"), undefined, true)).toContain(
      'To use SSH on this machine without editing the shared file: git config --global url."git@github.com:".insteadOf "https://github.com/"',
    );
    expect(gitAuthMessage(spec("git@github.com:acme/x.git"))).not.toContain("shared file");
  });

  it("names an unknown host key, warns on a changed one, and never blames the credentials", () => {
    const s = spec("git@github.com:acme/x.git");
    const unknown = "Host key verification failed.\r\nfatal: Could not read from remote repository.";
    expect(gitHostKeyMessage(s, unknown)).toBe(
      "ssh does not trust github.com's host key yet. Connect once to accept it: ssh -T git@github.com",
    );
    expect(
      gitHostKeyMessage(s, "No ED25519 host key is known for github.com and you have requested strict checking."),
    ).toContain("does not trust github.com's host key yet");
    const changed = gitHostKeyMessage(
      s,
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
    );
    expect(changed).toContain("man-in-the-middle");
    expect(changed).toContain("never accepts a host key for you");
    expect(changed).not.toContain("Connect once");
    expect(gitHostKeyMessage(s, "Permission denied (publickey).")).toBeNull();
  });
});

describe("consent: everything that runs", () => {
  it("lists the pre/post hooks around prepare and build, and every workspace package's scripts", () => {
    write(
      "package.json",
      JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: { preprepare: "a", postprepare: "b" } }),
    );
    write(
      "packages/server/package.json",
      JSON.stringify({ name: "srv", scripts: { prebuild: "node fetch.js", build: "tsc", postbuild: "node copy.js" } }),
    );
    write("packages/lib/package.json", JSON.stringify({ name: "lib", scripts: { postinstall: "node evil.js" } }));
    write("node_modules/dep/package.json", JSON.stringify({ name: "dep", scripts: { postinstall: "x" } }));
    expect(lifecycleScripts(dir, join(dir, "packages", "server"))).toEqual([
      { label: "preprepare", text: "a" },
      { label: "postprepare", text: "b" },
      { label: "packages/server prebuild", text: "node fetch.js" },
      { label: "packages/server build", text: "tsc" },
      { label: "packages/server postbuild", text: "node copy.js" },
      { label: "packages/lib postinstall", text: "node evil.js" },
    ]);
  });

  it("reads a pnpm workspace's block list, globstar included", () => {
    write("package.json", JSON.stringify({ name: "root" }));
    write(
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*'\n  - \"tools/**\" # all tools\nonlyBuiltDependencies: []\n",
    );
    write("tools/a/b/package.json", JSON.stringify({ name: "b", scripts: { install: "node x.js" } }));
    expect(lifecycleScripts(dir, dir)).toEqual([{ label: "tools/a/b install", text: "node x.js" }]);
  });

  it("lists the repo config that runs code, with the yarnPath and the plugins", () => {
    write(
      ".yarnrc.yml",
      'nodeLinker: node-modules\nyarnPath: .yarn/releases/evil.cjs\nplugins:\n  - path: .yarn/plugins/p.cjs\n    spec: "p"\n  - .yarn/plugins/q.cjs\n',
    );
    write(".npmrc", "registry=https://r.example\nnode-options=--require ./x.js\n");
    write(".pnpmfile.cjs", "");
    write(".yarnrc", 'yarn-path ".yarn/releases/old.js"\n');
    write("pnpm-workspace.yaml", "packages: ['a']\npnpmfile: hooks/pnpmfile.cjs\n");
    const configs = repoConfigFiles(dir, dir);
    expect(configs).toEqual([
      { label: ".npmrc", text: "node-options=--require ./x.js" },
      { label: ".yarnrc yarn-path", text: ".yarn/releases/old.js (this file runs as yarn)" },
      { label: ".yarnrc.yml yarnPath", text: ".yarn/releases/evil.cjs (this file runs as yarn)" },
      { label: ".yarnrc.yml plugin", text: ".yarn/plugins/p.cjs" },
      { label: ".yarnrc.yml plugin", text: ".yarn/plugins/q.cjs" },
      { label: ".pnpmfile.cjs", text: "loaded into pnpm at install" },
      { label: "pnpm-workspace.yaml pnpmfile", text: "hooks/pnpmfile.cjs" },
    ]);
    const lines = consentLines([], {}, "x", configs);
    expect(lines[0]).toBe(
      "This will install the repo's dependencies on this machine (it declares no lifecycle scripts).",
    );
    expect(lines[1]).toBe("The package manager also reads the repo's own config, which can run code:");
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}\.yarnrc\.yml yarnPath: +\.yarn\/releases\/evil\.cjs/));
  });

  it("lists nothing for a repo with no package-manager config", () => {
    write("package.json", JSON.stringify({ name: "x" }));
    expect(repoConfigFiles(dir, dir)).toEqual([]);
    expect(consentLines([], {}, "x")).toHaveLength(1);
  });
});

describe("repo text on the terminal", () => {
  it("never puts a manifest's escape bytes into a warning", () => {
    write(
      "yaw-mcp.json",
      JSON.stringify({ "\u001b]52;c;aGk=\u0007": 1, env: { "\u001b[2J": {} }, namespace: "\u009b2J" }),
    );
    const { warnings } = readGitManifest(dir);
    expect(warnings).toHaveLength(3);
    for (const w of warnings) expect(w).toMatch(/^[\x20-\x7e]*$/);
  });

  it('reads only the root manifest for an explicit "" subdir', () => {
    write("yaw-mcp.json", JSON.stringify({ subdir: "packages/server", description: "root" }));
    write("packages/server/yaw-mcp.json", JSON.stringify({ description: "sub" }));
    expect(readGitManifest(dir, "").manifest.description).toBe("root");
    expect(readGitManifest(dir).manifest.description).toBe("sub");
  });
});

describe("the GIT_ASKPASS helper", () => {
  it("hands git the username and the token from a home path cmd.exe would split", () => {
    const home = join(dir, "R&D (x) %PATH% ^y");
    const askpass = writeAskpassHelper(home);
    const token = "t0k!en%PATH%^&x";
    const empty = join(dir, "gitconfig");
    writeFileSync(empty, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
    const r = spawnSync("git", ["-c", "credential.helper=", "credential", "fill"], {
      input: "protocol=https\nhost=example.com\n\n",
      encoding: "utf8",
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: empty,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askpass,
        YAW_MCP_GIT_USERNAME: "x-access-token",
        YAW_MCP_GIT_TOKEN: token,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("username=x-access-token\n");
    expect(r.stdout).toContain(`password=${token}\n`);
    expect(readFileSync(askpass, "utf8")).not.toContain("t0k");
  });

  it.skipIf(process.platform === "win32")("restores the exec bit on a helper left without it (POSIX modes)", () => {
    const askpass = writeAskpassHelper(dir);
    chmodSync(askpass, 0o600);
    writeAskpassHelper(dir);
    expect(statSync(askpass).mode & 0o700).toBe(0o700);
  });
});

describe("prepareGit", () => {
  it("names why a token is ignored, by protocol, without reading it", async () => {
    for (const [url, why] of [
      [
        "file:///C:/x/y.git",
        "--git-token-secret is ignored for file URLs; a local repository needs no authentication.",
      ],
      ["git@h.example:a/b.git", "--git-token-secret is ignored for ssh URLs; git uses your SSH setup."],
    ] as const) {
      const p = parseGitSpec(url);
      if (!p.ok) throw new Error(p.error);
      const warns: string[] = [];
      const r = await prepareGit(p.spec, "tok", {
        home: dir,
        env: {},
        interactive: false,
        warn: (w) => warns.push(w),
        resolveToken: async () => {
          throw new Error("read");
        },
      });
      if (!r.ok) throw new Error(r.message);
      expect(warns).toEqual([why]);
      expect(r.secrets).toEqual({});
      expect(r.run.token).toBeUndefined();
    }
  });

  describe("the real vault read (no resolveToken)", () => {
    const HTTPS = "https://git.example/acme/x.git";
    const PASS = "fixture-vault-pass";
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.YAW_MCP_VAULT_PASSPHRASE;
      delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    });
    afterEach(() => {
      lock();
      if (saved === undefined) delete process.env.YAW_MCP_VAULT_PASSPHRASE;
      else process.env.YAW_MCP_VAULT_PASSPHRASE = saved;
    });
    async function seedVault(entries: Record<string, string>): Promise<void> {
      let vault = await createEmptyVault(PASS);
      const key = await unlock(vault, PASS);
      for (const [n, v] of Object.entries(entries)) vault = setSecret(vault, key, n, v);
      lock();
      await saveVault(vaultPath(dir), vault);
    }
    async function prepare() {
      const p = parseGitSpec(HTTPS);
      if (!p.ok) throw new Error(p.error);
      return prepareGit(p.spec, "GH_READ", { home: dir, env: {}, interactive: false, warn: () => {} });
    }

    it("fails naming the secret when there is no vault file", async () => {
      const r = await prepare();
      expect(r).toMatchObject({ ok: false, exitCode: 1 });
      if (r.ok) return;
      expect(r.message).toBe('secret "GH_READ" is not in your vault. Store it: yaw-mcp secrets set GH_READ');
    });

    it("fails naming the secret when the vault does not hold it", async () => {
      await seedVault({ OTHER: "x" });
      const r = await prepare();
      expect(r).toMatchObject({ ok: false, exitCode: 1 });
      if (r.ok) return;
      expect(r.message).toContain('secret "GH_READ" is not in your vault');
    });

    it("fails naming the secret when the vault is locked", async () => {
      await seedVault({ GH_READ: "ghp_vaultvalue" });
      const r = await prepare();
      expect(r).toMatchObject({ ok: false, exitCode: 1 });
      if (r.ok) return;
      expect(r.message).toContain('the vault is locked, so the git token in secret "GH_READ" cannot be read');
      expect(r.message).toContain("YAW_MCP_VAULT_PASSPHRASE");
      expect(r.message).not.toContain("ghp_vaultvalue");
    });

    it("reads the token from an unlocked vault and marks it for redaction", async () => {
      await seedVault({ GH_READ: "ghp_vaultvalue" });
      process.env.YAW_MCP_VAULT_PASSPHRASE = PASS;
      const r = await prepare();
      if (!r.ok) throw new Error(r.message);
      expect(r.run.token?.value).toBe("ghp_vaultvalue");
      expect(r.secrets).toEqual({ GH_READ: "ghp_vaultvalue" });
    });
  });
});

describe("cleanup that cannot delete", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)(
    "skips a held staging dir with a warning instead of throwing (root ignores dir modes)",
    async () => {
      const root = gitRoot(dir);
      const held = join(root, ".tmp-held");
      mkdirSync(join(held, "x"), { recursive: true });
      let release: () => Promise<void>;
      if (process.platform === "win32") {
        // An orphaned npm with its cwd inside the tree: rmdir fails EBUSY.
        // The child opens its cwd while it starts up, after "spawn": wait until it runs.
        const child = spawn(process.execPath, ["-e", 'process.stdout.write("up"); setTimeout(() => {}, 60000)'], {
          cwd: held,
          stdio: ["ignore", "pipe", "ignore"],
        });
        await new Promise<void>((r) => child.stdout?.once("data", () => r()));
        release = async () => {
          const exited = new Promise<void>((r) => child.once("exit", () => r()));
          child.kill();
          await exited;
        };
      } else {
        chmodSync(root, 0o500);
        release = async () => chmodSync(root, 0o700);
      }
      const warns: string[] = [];
      try {
        expect(() => sweepStaging(dir, (w) => warns.push(w))).not.toThrow();
        expect(tryRemoveTree(held, (w) => warns.push(w))).toBe(false);
      } finally {
        await release();
      }
      expect(warns).toHaveLength(2);
      expect(warns[0]).toContain("it is swept on the next build.");
      expect(tryRemoveTree(held)).toBe(true);
    },
  );
});

describe("the build-ready marker sits outside the checkout and is checked", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "yaw-built-")));
    dir = join(root, COMMIT.slice(0, 12));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts a marker yaw-mcp writes next to the directory", () => {
    fakeFinishedBuild(dir, COMMIT, { subdir: "packages/srv", entry: "dist/index.js" });
    expect(readBuildMarker(dir, COMMIT)?.entry).toBe("dist/index.js");
    expect(readBuildMarker(dir)?.commit).toBe(COMMIT);
  });

  it("ignores a .yaw-build.json inside the checkout", () => {
    fakeFinishedBuild(dir, COMMIT);
    const marker = readFileSync(`${dir}.built`, "utf8");
    rmSync(`${dir}.built`);
    writeFileSync(join(dir, ".yaw-build.json"), marker);
    expect(readBuildMarker(dir, COMMIT)).toBeNull();
  });

  it("refuses a marker for another commit, a short one, or one naming another directory", () => {
    fakeFinishedBuild(dir, COMMIT);
    expect(readBuildMarker(dir, `${COMMIT.slice(0, 39)}8`)).toBeNull();
    for (const commit of ["x", COMMIT.slice(0, 12), "ffffffffffffffffffffffffffffffffffffffff"]) {
      writeFileSync(`${dir}.built`, JSON.stringify({ commit, entry: "index.js" }));
      expect(readBuildMarker(dir)).toBeNull();
    }
  });

  it("refuses an entry that is missing, a directory, or outside the build", () => {
    fakeFinishedBuild(dir, COMMIT);
    writeFileSync(join(root, "outside.js"), "");
    for (const entry of ["nope.js", ".git", "../outside.js"]) {
      writeFileSync(`${dir}.built`, JSON.stringify({ commit: COMMIT, entry }));
      expect(readBuildMarker(dir, COMMIT)).toBeNull();
    }
    writeFileSync(`${dir}.built`, JSON.stringify({ commit: COMMIT, subdir: "..", entry: "outside.js" }));
    expect(readBuildMarker(dir, COMMIT)).toBeNull();
  });

  it("refuses a marker older than the checkout it would vouch for", () => {
    fakeFinishedBuild(dir, COMMIT);
    const head = statSync(join(dir, ".git", "HEAD")).mtime;
    const older = new Date(head.getTime() - 60_000);
    utimesSync(`${dir}.built`, older, older);
    expect(readBuildMarker(dir, COMMIT)).toBeNull();
    rmSync(join(dir, ".git"), { recursive: true });
    utimesSync(`${dir}.built`, head, head);
    expect(readBuildMarker(dir, COMMIT)).toBeNull();
  });
});
