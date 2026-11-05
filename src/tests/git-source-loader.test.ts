// The `git` block of a bundles.json entry, at load and at write: what the
// loader derives from it, which shapes it refuses, how an upsert converts
// between the git, command and url launch shapes, and that the launch
// identity moves with the pinned commit.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLocalBundles,
  previewBundlesContent,
  previewUpsertUserBundle,
  unsafeRelativePathReason,
  upsertUserBundle,
} from "../local-bundles.js";
import { nodeLaunchKind } from "../oam-spawn.js";
import { gitBuildDir } from "../paths.js";
import { launchIdentity, type UpstreamServerConfig } from "../types.js";

const COMMIT_A = "9f3c2a1d7e0b4c5d6e7f8091a2b3c4d5e6f70812";
const COMMIT_B = "4b77e0d1c2b3a4958677e8f9a0b1c2d3e4f50617";
const URL = "git@github.com:acme/acme-tools-mcp.git";

let home: string;
let cwd: string;

beforeEach(() => {
  // A space in the home path: the derived entry path is one argv element, and
  // nothing on the way may split it.
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw git home-")));
  cwd = mkdtempSync(join(home, "cwd-"));
  mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeBundles(servers: unknown[]): void {
  writeFileSync(join(home, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers }));
}

function readBundles(): { servers: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(home, ".yaw-mcp", "bundles.json"), "utf8"));
}

async function load(servers: unknown[]): Promise<{ servers: UpstreamServerConfig[]; warnings: string[] }> {
  writeBundles(servers);
  const res = await loadLocalBundles({ cwd, home, env: {} });
  return { servers: res.config?.servers ?? [], warnings: res.warnings };
}

function gitEntry(git: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { namespace: "acme_tools", name: "acme-tools", type: "local", transport: "stdio", git, ...extra };
}

describe("loader: git entries", () => {
  it("derives node <buildDir>/<subdir>/<entry> with cwd <buildDir>/<subdir>, keeping the server args after it", async () => {
    const { servers, warnings } = await load([
      gitEntry(
        { url: URL, ref: "main", commit: COMMIT_A, subdir: "packages/server", entry: "dist/index.js" },
        { args: ["--verbose"] },
      ),
    ]);
    expect(warnings).toEqual([]);
    const buildDir = gitBuildDir("acme_tools", COMMIT_A, home);
    expect(buildDir).toBe(join(home, ".yaw-mcp", "git", "acme_tools", COMMIT_A.slice(0, 12)));
    const s = servers[0];
    expect(s.type).toBe("local");
    // The node that ran the build, not whatever PATH finds; still a node
    // launch to the oam rewrite.
    expect(s.command).toBe(process.execPath);
    expect(nodeLaunchKind(s.command as string)).toBe("node");
    expect(s.args).toEqual([join(buildDir, "packages", "server", "dist", "index.js"), "--verbose"]);
    expect(s.cwd).toBe(join(buildDir, "packages", "server"));
    expect(s.git).toEqual({
      url: URL,
      ref: "main",
      commit: COMMIT_A,
      subdir: "packages/server",
      entry: "dist/index.js",
    });
  });

  it("runs from the build root when there is no subdir, and accepts backslash-separated relative paths", async () => {
    const { servers } = await load([gitEntry({ url: URL, commit: COMMIT_A, entry: "dist\\index.js" })]);
    const buildDir = gitBuildDir("acme_tools", COMMIT_A, home);
    expect(servers[0].cwd).toBe(buildDir);
    expect(servers[0].args).toEqual([join(buildDir, "dist", "index.js")]);
  });

  it("lowercases an uppercase full commit", async () => {
    const { servers } = await load([gitEntry({ url: URL, commit: COMMIT_A.toUpperCase(), entry: "index.js" })]);
    expect(servers[0].git?.commit).toBe(COMMIT_A);
  });

  it("lets git win over a command (and url) the same entry carries, with a warning", async () => {
    const { servers, warnings } = await load([
      gitEntry(
        { url: URL, commit: COMMIT_A, entry: "index.js" },
        { command: "npx", args: ["-y", "x"], url: "https://example.com/mcp" },
      ),
    ]);
    expect(servers[0].command).toBe(process.execPath);
    expect(servers[0].args?.[0]).toBe(join(gitBuildDir("acme_tools", COMMIT_A, home), "index.js"));
    expect(servers[0].url).toBeUndefined();
    expect(warnings).toEqual([
      expect.stringContaining('"acme_tools" has both git and command/url/remote type; using git'),
    ]);
  });

  it("forces a git entry local even under an explicit remote type", async () => {
    const { servers } = await load([
      gitEntry({ url: URL, commit: COMMIT_A, entry: "index.js" }, { type: "remote", transport: "sse" }),
    ]);
    expect(servers[0].type).toBe("local");
    expect(servers[0].transport).toBeUndefined();
  });

  it("ignores a user-written cwd, on a git entry and on a plain one", async () => {
    const { servers } = await load([
      gitEntry({ url: URL, commit: COMMIT_A, entry: "index.js" }, { cwd: "/etc" }),
      { namespace: "plain", command: "npx", args: ["-y", "x"], cwd: "/etc" },
    ]);
    expect(servers[0].cwd).toBe(gitBuildDir("acme_tools", COMMIT_A, home));
    expect(servers[1].cwd).toBeUndefined();
    expect("cwd" in servers[1]).toBe(false);
  });

  it("leaves an entry without git exactly as before (no git, no cwd keys)", async () => {
    const { servers } = await load([{ namespace: "plain", command: "npx", args: ["-y", "x"] }]);
    expect("git" in servers[0]).toBe(false);
    expect("cwd" in servers[0]).toBe(false);
    expect(servers[0].command).toBe("npx");
  });

  it("loads an entry with no commit but derives nothing, and warns", async () => {
    const { servers, warnings } = await load([gitEntry({ url: URL, ref: "main", entry: "index.js" })]);
    expect(servers).toHaveLength(1);
    expect(servers[0].command).toBeUndefined();
    expect(servers[0].cwd).toBeUndefined();
    expect(servers[0].git).toEqual({ url: URL, ref: "main", entry: "index.js" });
    expect(warnings).toEqual([expect.stringContaining('"acme_tools" has no git commit pinned')]);
  });

  it.each([
    ["a short commit", { url: URL, commit: "9f3c2a1", entry: "index.js" }, "is not a full 40-character SHA"],
    ["a non-hex commit", { url: URL, commit: "z".repeat(40), entry: "index.js" }, "is not a full 40-character SHA"],
    ["a missing url", { commit: COMMIT_A, entry: "index.js" }, "url is missing"],
    ["a leading-dash url", { url: "--upload-pack=x", commit: COMMIT_A, entry: "index.js" }, "not a usable git URL"],
    ["a missing entry", { url: URL, commit: COMMIT_A }, "entry is missing"],
    ["an absolute entry", { url: URL, commit: COMMIT_A, entry: "/etc/passwd" }, "is absolute"],
    ["a backslash-absolute entry", { url: URL, commit: COMMIT_A, entry: "\\evil.js" }, "is absolute"],
    ["a drive-letter entry", { url: URL, commit: COMMIT_A, entry: "C:/evil.js" }, "drive letter"],
    ["a .. entry", { url: URL, commit: COMMIT_A, entry: "../evil.js" }, '".." segment'],
    ["a backslash .. subdir", { url: URL, commit: COMMIT_A, subdir: "a\\..\\..", entry: "x.js" }, '".." segment'],
    ["an absolute subdir", { url: URL, commit: COMMIT_A, subdir: "/srv", entry: "x.js" }, "is absolute"],
    ["a dot-only entry", { url: URL, commit: COMMIT_A, entry: "./" }, "names no file"],
  ])("skips the whole entry for %s", async (_label, git, why) => {
    const { servers, warnings } = await load([
      gitEntry(git as Record<string, unknown>, { command: "npx", args: ["-y", "fallback"] }),
    ]);
    // Never falls back to the command it also carries.
    expect(servers).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining(why)]);
  });

  it("never quotes the url in a warning", async () => {
    const secretUrl = `https://ghp_${"a".repeat(36)}@github.com/acme/x.git`;
    const { warnings } = await load([gitEntry({ url: secretUrl, commit: "short", entry: "index.js" })]);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).not.toContain("ghp_");
  });

  it("previewBundlesContent derives the same launch for the trust screen", () => {
    const raw = Buffer.from(
      JSON.stringify({ version: 1, servers: [gitEntry({ url: URL, commit: COMMIT_A, entry: "index.js" })] }),
    );
    const preview = previewBundlesContent("/p/.yaw-mcp/bundles.json", raw, home);
    expect(preview.servers[0].args).toEqual([join(gitBuildDir("acme_tools", COMMIT_A, home), "index.js")]);
  });
});

describe("unsafeRelativePathReason", () => {
  it.each(["dist/index.js", "packages/server", "a/./b", "x..y/z", "..foo"])("accepts %s", (p) => {
    expect(unsafeRelativePathReason(p)).toBeNull();
  });

  it.each([
    "",
    "  ",
    "/abs",
    "\\abs",
    "\\\\server\\share",
    "C:\\x",
    "c:rel",
    "..",
    "a/../b",
    "a\\..",
    `a${String.fromCharCode(10)}b`,
    `a${String.fromCharCode(0)}`,
  ])("refuses %j", (p) => {
    expect(unsafeRelativePathReason(p)).not.toBeNull();
  });
});

describe("launchIdentity and git", () => {
  it("differs across commits of the same repo", async () => {
    const a = (await load([gitEntry({ url: URL, commit: COMMIT_A, entry: "index.js" })])).servers[0];
    const b = (await load([gitEntry({ url: URL, commit: COMMIT_B, entry: "index.js" })])).servers[0];
    expect(launchIdentity(a)).not.toBe(launchIdentity(b));
  });

  it("covers cwd", () => {
    const base: UpstreamServerConfig = {
      id: "x",
      name: "x",
      namespace: "x",
      type: "local",
      command: "node",
      args: ["i.js"],
      isActive: true,
    };
    expect(launchIdentity({ ...base, cwd: "/a" })).not.toBe(launchIdentity({ ...base, cwd: "/b" }));
  });
});

describe("upsert: converting between git, command and url", () => {
  // Entries as a writer builds them: `slug` rides along although the loaded
  // type does not declare it.
  type Opts = Parameters<typeof upsertUserBundle>[1];
  const upsert = (e: Record<string, unknown>, o: Opts) => upsertUserBundle(e as Partial<UpstreamServerConfig>, o);
  const previewUpsert = (e: Record<string, unknown>, o: Opts) =>
    previewUpsertUserBundle(e as Partial<UpstreamServerConfig>, o);
  const git = { url: URL, ref: "main", commit: COMMIT_A, entry: "dist/index.js" };

  it("git -> command drops the git block and reports the launch change", async () => {
    writeBundles([gitEntry(git, { slug: "acme-tools", args: ["--verbose"] })]);
    const res = await upsert(
      {
        namespace: "acme_tools",
        name: "acme-tools",
        slug: "acme-tools",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "acme"],
      },
      { home, origin: "custom" },
    );
    const stored = readBundles().servers[0];
    expect(stored.git).toBeUndefined();
    expect(stored.command).toBe("npx");
    expect(stored.args).toEqual(["-y", "acme"]);
    expect(res.launchChanged).toEqual({ from: { git: { url: URL } }, to: { command: "npx", args: ["-y", "acme"] } });
  });

  it("command -> git drops command, args, url and headers", async () => {
    writeBundles([
      {
        namespace: "acme_tools",
        name: "acme-tools",
        slug: "acme-tools",
        type: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "acme"],
        url: "https://stale.example/mcp",
        headers: { Authorization: "Bearer stale" },
      },
    ]);
    const res = await upsert(
      { namespace: "acme_tools", name: "acme-tools", slug: "acme-tools", type: "local", transport: "stdio", git },
      { home, origin: "custom" },
    );
    const stored = readBundles().servers[0];
    expect(stored.git).toEqual(git);
    for (const k of ["command", "args", "url", "headers"]) expect(stored[k]).toBeUndefined();
    expect(res.launchChanged?.to).toEqual({ git: { url: URL } });
  });

  it("command -> git keeps the new server args the add brought", async () => {
    writeBundles([{ namespace: "acme_tools", slug: "acme-tools", command: "npx", args: ["-y", "acme"] }]);
    await upsert(
      { namespace: "acme_tools", slug: "acme-tools", type: "local", git, args: ["--port", "1"] },
      { home, origin: "custom" },
    );
    expect(readBundles().servers[0].args).toEqual(["--port", "1"]);
  });

  it("git -> git without server args keeps the stored args and env", async () => {
    writeBundles([gitEntry(git, { slug: "acme-tools", args: ["--verbose"], env: { K: "v" } })]);
    await upsert(
      { namespace: "acme_tools", slug: "acme-tools", type: "local", git: { ...git, ref: "v2" } },
      { home, origin: "custom" },
    );
    const stored = readBundles().servers[0];
    expect(stored.args).toEqual(["--verbose"]);
    expect(stored.env).toEqual({ K: "v" });
    expect((stored.git as { ref: string }).ref).toBe("v2");
  });

  it("git -> git with new server args replaces the stored ones", async () => {
    writeBundles([gitEntry(git, { slug: "acme-tools", args: ["--verbose"] })]);
    await upsert(
      { namespace: "acme_tools", slug: "acme-tools", type: "local", git, args: ["--quiet"] },
      { home, origin: "custom" },
    );
    expect(readBundles().servers[0].args).toEqual(["--quiet"]);
  });

  it("git -> url drops the git block", async () => {
    writeBundles([gitEntry(git, { slug: "acme-tools" })]);
    await upsert(
      { namespace: "acme_tools", slug: "acme-tools", type: "remote", url: "https://acme.example/mcp" },
      { home, origin: "custom" },
    );
    const stored = readBundles().servers[0];
    expect(stored.git).toBeUndefined();
    expect(stored.url).toBe("https://acme.example/mcp");
    expect(stored.type).toBe("remote");
  });

  it("url -> git drops the remote type, url, headers and a non-stdio transport", async () => {
    writeBundles([
      {
        namespace: "acme_tools",
        slug: "acme-tools",
        type: "remote",
        transport: "sse",
        url: "https://acme.example/mcp",
        headers: { Authorization: "Bearer x" },
      },
    ]);
    await upsert({ namespace: "acme_tools", slug: "acme-tools", git }, { home, origin: "custom" });
    const stored = readBundles().servers[0];
    for (const k of ["type", "transport", "url", "headers"]) expect(stored[k]).toBeUndefined();
    expect(stored.git).toEqual(git);
  });

  it("a moved commit is not a launch change; a changed url or subdir is", async () => {
    writeBundles([gitEntry(git, { slug: "acme-tools" })]);
    const sameRepo = await previewUpsert(
      { namespace: "acme_tools", slug: "acme-tools", git: { ...git, commit: COMMIT_B } },
      { home, origin: "custom" },
    );
    expect(sameRepo.launchChanged).toBeUndefined();
    const otherUrl = await previewUpsert(
      { namespace: "acme_tools", slug: "acme-tools", git: { ...git, url: "git@github.com:acme/other.git" } },
      { home, origin: "custom" },
    );
    expect(otherUrl.launchChanged).toEqual({
      from: { git: { url: URL } },
      to: { git: { url: "git@github.com:acme/other.git" } },
    });
    const otherSubdir = await previewUpsert(
      { namespace: "acme_tools", slug: "acme-tools", git: { ...git, subdir: "packages/server" } },
      { home, origin: "custom" },
    );
    expect(otherSubdir.launchChanged?.to).toEqual({ git: { url: URL, subdir: "packages/server" } });
  });
});
