// `yaw-mcp add --git` on two failure paths, with real git against a file://
// bare repo: a start check that throws, and a failure between the checkout
// and the install.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { gitRefsPath } from "../git-source.js";
import { type AddCommandOptions, parseAddArgs, runAdd } from "../local-add-cmd.js";
import { gitBuildDir, gitFailedPath } from "../paths.js";
import { ENV, git, makeRepo, NPM_FILES, newTmp } from "./git-fixture.js";

let home: string;
let cwd: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = newTmp("git-add-fail-home-");
  cwd = newTmp("git-add-fail-cwd-");
  out = [];
  err = [];
});

async function add(argv: string[], over: Partial<AddCommandOptions> = {}) {
  const parsed = parseAddArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  const res = await runAdd({
    ...parsed.options,
    home,
    cwd,
    env: ENV,
    isTTY: false,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over,
  });
  return { ...res, out: out.join(""), err: err.join("") };
}

describe("add --git failure paths", () => {
  it("a start check that throws is a failed check: the entry is written and pins the build", async () => {
    const repo = makeRepo(NPM_FILES);
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    const r = await add(["fx", "--git", repo.url, "--yes"], {
      startCheck: async () => {
        throw new Error("kaboom in the check");
      },
    });
    expect(r.exitCode, r.err).toBe(1);
    expect(r.out).toContain("Checking it starts ... failed");
    expect(r.out).toContain("Added, but it did not start: kaboom in the check.");
    const file = join(home, ".yaw-mcp", "bundles.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { servers: Array<Record<string, unknown>> };
    expect(doc.servers[0]).toMatchObject({ namespace: "fx", git: { commit: head } });
    // The build is on disk and something pins it.
    expect(existsSync(gitBuildDir("fx", head, home))).toBe(true);
    expect(JSON.parse(readFileSync(gitRefsPath("fx", home), "utf8"))).toEqual({ [file]: head });
  }, 180_000);

  it("a repo with no package.json records .failed at step layout, not checkout", async () => {
    const repo = makeRepo({ "README.md": "not a package\n" });
    const head = git(repo.work, ["rev-parse", "HEAD"]);
    const r = await add(["fx", "--git", `${repo.url}#${head}`, "--yes", "--no-start-check"]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("has no package.json");
    const failed = JSON.parse(readFileSync(gitFailedPath("fx", head, home), "utf8"));
    expect(failed).toMatchObject({ commit: head, step: "layout" });
  }, 120_000);
});
