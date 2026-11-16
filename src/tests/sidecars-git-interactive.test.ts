// `yaw-mcp sidecars install` -- which streams decide "is this interactive?".
//
// The consent prompt for a git entry's lifecycle scripts is asked on opts.io
// when one is given (askYesNo, under scriptConsentConfirm). The verdict that
// gates the prompt used to read process.stdin / process.stdout instead, so an
// injected terminal was never asked and the entry came back needs-consent.

import { mkdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { localBundlesPath } from "../local-bundles.js";
import { userConfigDir } from "../paths.js";
import { runSidecarsInstall } from "../sidecars-cmd.js";
import { ENV, git, makeRepo, NPM_FILES, newTmp } from "./git-fixture.js";

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = newTmp("yaw git tty-");
  out = [];
  err = [];
});

function writeGitEntry(): void {
  const repo = makeRepo(NPM_FILES);
  const head = git(repo.work, ["rev-parse", "HEAD"]);
  mkdirSync(userConfigDir(home), { recursive: true });
  writeFileSync(
    localBundlesPath(userConfigDir(home)),
    JSON.stringify({
      version: 1,
      servers: [
        {
          namespace: "fx",
          name: "fx",
          type: "local",
          transport: "stdio",
          git: { url: repo.url, ref: "main", commit: head, entry: "dist/index.js" },
        },
      ],
    }),
  );
}

function streams(isTTY: boolean): { stdin: PassThrough; stdout: PassThrough } {
  const stdin = Object.assign(new PassThrough(), { isTTY });
  const stdout = Object.assign(new PassThrough(), { isTTY });
  stdout.resume();
  return { stdin, stdout };
}

describe("sidecars install -- the interactive verdict reads the injected streams", () => {
  it("asks for consent on an injected terminal (no isTTY override)", async () => {
    writeGitEntry();
    const { stdin, stdout } = streams(true);
    // ETX, built from its code so no control byte sits in this source: the
    // prompt being ASKED is what turns it into exit 130.
    stdin.write(String.fromCharCode(3));
    const pm: string[][] = [];
    const res = await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      io: { stdin, stdout, terminal: true },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      runPm: async (args) => {
        pm.push(args);
        return 0;
      },
    });
    expect(res.exitCode, err.join("")).toBe(130);
    expect(out.join("")).toContain("This will run code from the repo on this machine:");
    expect(pm).toEqual([]);
  }, 120_000);

  it("does not ask on injected pipes: the entry is reported as needing consent", async () => {
    writeGitEntry();
    const { stdin, stdout } = streams(false);
    const res = await runSidecarsInstall({
      home,
      cwd: home,
      env: ENV,
      io: { stdin, stdout },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      runPm: async () => 0,
    });
    expect(res.exitCode).toBe(1);
    expect(out.join("")).toMatch(/ {2}fx {2}[0-9a-f]{12} {2}needs-consent/);
  }, 120_000);
});
