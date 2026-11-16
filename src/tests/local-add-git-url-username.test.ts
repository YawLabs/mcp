// A stored git url's userinfo in machine output and previews: a bare
// username (`ssh://git@host/...`) is part of the address and is reported as
// stored; a password, or a token standing where the username goes, is not
// printed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runList, runRemove } from "../local-add-cmd.js";
import { CONFIG_DIRNAME } from "../paths.js";

let home: string;
let cwd: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-git-url-user-"));
  cwd = mkdtempSync(join(home, "cwd-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const COMMIT = "b".repeat(40);

function seed(url: string): void {
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(
    join(home, CONFIG_DIRNAME, "bundles.json"),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: "local-fx",
          name: "fx",
          namespace: "fx",
          slug: "fx",
          type: "local",
          transport: "stdio",
          git: { url, ref: "main", commit: COMMIT, entry: "dist/index.js" },
          isActive: true,
        },
      ],
    }),
  );
}

function io() {
  return { home, cwd, env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
}

async function listedUrl(): Promise<string | undefined> {
  const r = await runList({ ...io(), json: true, gradesReader: async () => ({}) });
  expect(r.exitCode).toBe(0);
  const doc = JSON.parse(out.join("")) as { servers: Array<{ namespace: string; git?: { url: string } }> };
  return doc.servers.find((s) => s.namespace === "fx")?.git?.url;
}

describe("a stored git url's userinfo in list --json and the removal preview", () => {
  it.each([
    "ssh://git@github.com/acme/x.git",
    "ssh://git@host:2222/@org/x.git",
    "https://alice@git.test/acme/x.git",
  ])("list --json reports a bare username as stored: %s", async (url) => {
    seed(url);
    expect(await listedUrl()).toBe(url);
  });

  it("remove's preview shows a bare username as stored", async () => {
    seed("ssh://git@github.com/acme/x.git");
    const r = await runRemove({ ...io(), target: "fx", isTTY: false });
    expect(r.exitCode).toBe(2);
    expect(out.join("") + err.join("")).toContain("git ssh://git@github.com/acme/x.git");
  });

  it.each([
    ["a password", "ssh://git:hunter2pass@github.com/acme/x.git", "hunter2pass"],
    ["a token as the username", "https://ghp_handEditedToken123@git.test/acme/x.git", "ghp_handEditedToken123"],
    ["a short token-prefixed username", "https://glpat-abc123@git.test/acme/x.git", "glpat-abc123"],
    ["an empty username with a password", "https://:s3cretvalue@git.test/acme/x.git", "s3cretvalue"],
  ])("list --json still scrubs %s", async (_label, url, secret) => {
    seed(url);
    const listed = await listedUrl();
    expect(listed).toContain("://***@");
    expect(out.join("")).not.toContain(secret);
  });
});
