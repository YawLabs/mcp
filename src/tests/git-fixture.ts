// Shared fixtures for the git-source suites: an isolated git env, file://
// bare repos to clone from, and a zero-dependency stdio MCP server package
// that `npm ci` installs and `npm run build` builds with no network.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";

const tmpRoots: string[] = [];

/** A fresh temp dir, deleted when the importing file's tests finish. */
export function newTmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// Isolated git: no user or system config, no caller GIT_* (a hook's GIT_DIR
// would otherwise send these fixtures into the operator's repository).
const gitHome = newTmp("git-src-gitcfg-");
writeFileSync(join(gitHome, "config"), "");
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: join(gitHome, "config"),
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: gitHome,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
export function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
}
export const ENV: NodeJS.ProcessEnv = { ...baseEnv(), ...GIT_ENV };

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A minimal stdio MCP server: answers initialize and tools/list. */
export const SERVER_JS = `const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fx", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] } });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;
export const BUILD_JS = `const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("src/server.js", "dist/index.js");
`;

export function packageJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { name: "fx-server", version: "1.0.0", bin: "dist/index.js", scripts: { build: "node build.js" }, ...extra },
    null,
    2,
  );
}
export const NPM_LOCK = JSON.stringify({
  name: "fx-server",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "fx-server", version: "1.0.0", bin: { "fx-server": "dist/index.js" } } },
});

export interface Repo {
  work: string;
  bare: string;
  url: string;
  commit(files: Record<string, string>, message?: string): string;
}

/** A work tree plus the bare repo it pushes to; `url` is the bare's file:// URL. */
export function makeRepo(files: Record<string, string>, root = newTmp("git-src-repo-")): Repo {
  const work = join(root, "work");
  const bare = join(root, "srv", "acme", "fx.git");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "core.autocrlf", "false"]);
  mkdirSync(bare, { recursive: true });
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  git(work, ["remote", "add", "origin", bare]);
  const repo: Repo = {
    work,
    bare,
    url: pathToFileURL(bare).href,
    commit(next, message = "change") {
      for (const [rel, body] of Object.entries(next)) {
        const file = join(work, ...rel.split("/"));
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, body);
      }
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", message]);
      git(work, ["push", "-q", "origin", "HEAD:main", "--tags"]);
      return git(work, ["rev-parse", "HEAD"]);
    },
  };
  repo.commit(files, "initial");
  return repo;
}

export const NPM_FILES = {
  "package.json": packageJson(),
  "package-lock.json": NPM_LOCK,
  "build.js": BUILD_JS,
  "src/server.js": SERVER_JS,
};

/**
 * Lay down what a finished build looks like on disk without running one: the
 * checkout's `.git/HEAD`, the entry file and, written after both, the
 * `<sha12>.built` marker outside the checkout. Returns the build directory.
 */
export function fakeFinishedBuild(
  dir: string,
  commit: string,
  opts: { subdir?: string; entry?: string; marker?: Record<string, unknown> } = {},
): string {
  const entry = opts.entry ?? "index.js";
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `${commit}\n`);
  const pkg = join(dir, ...(opts.subdir ?? "").split("/").filter(Boolean));
  const entryFile = join(pkg, ...entry.split("/"));
  mkdirSync(join(entryFile, ".."), { recursive: true });
  writeFileSync(entryFile, "");
  const marker = {
    url: "file:///repo",
    commit,
    ...(opts.subdir ? { subdir: opts.subdir } : {}),
    entry,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pm: "npm",
    pmVersion: "10.0.0",
    builtAt: "2026-11-04T00:00:00.000Z",
    ...opts.marker,
  };
  writeFileSync(`${dir}.built`, JSON.stringify(marker));
  return dir;
}
