import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { npxCacheNodeModules, packageName, rewriteForOam, winNormalize } from "./oam-spawn.js";

describe("winNormalize", () => {
  it("converts forward slashes to backslashes on Windows (cmd-safe)", () => {
    expect(winNormalize("C:/Users/jeff/oam/target/release/oam.exe", "win32")).toBe(
      "C:\\Users\\jeff\\oam\\target\\release\\oam.exe",
    );
  });
  it("leaves an already-backslash path untouched on Windows", () => {
    expect(winNormalize("C:\\Users\\jeff\\oam.exe", "win32")).toBe("C:\\Users\\jeff\\oam.exe");
  });
  it("leaves a bare binary name untouched", () => {
    expect(winNormalize("oam.exe", "win32")).toBe("oam.exe");
  });
  it("is a no-op off Windows", () => {
    expect(winNormalize("/usr/local/bin/oam", "linux")).toBe("/usr/local/bin/oam");
  });
});

describe("packageName", () => {
  it("strips @latest from a scoped package", () => {
    expect(packageName("@yawlabs/tailscale-mcp@latest")).toBe("@yawlabs/tailscale-mcp");
  });
  it("strips a semver from an unscoped package", () => {
    expect(packageName("server-memory@1.2.3")).toBe("server-memory");
  });
  it("leaves a bare scoped name untouched", () => {
    expect(packageName("@yawlabs/npmjs-mcp")).toBe("@yawlabs/npmjs-mcp");
  });
  it("leaves a bare unscoped name untouched", () => {
    expect(packageName("cowsay")).toBe("cowsay");
  });
});

describe("rewriteForOam", () => {
  const oam = { oamBin: "oam", resolveEntry: (p: string) => `/pkgs/${p}/dist/index.js` };

  it("rewrites `npx -y <pkg>@latest` to `oam run <resolved entry>`", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp@latest"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/@yawlabs/npmjs-mcp/dist/index.js"],
    });
  });

  it("rewrites `node <entry>` to `oam run <entry>`", () => {
    expect(rewriteForOam("node", ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
  });

  it("forwards extra args after `--`", () => {
    expect(rewriteForOam("node", ["/srv/index.js", "--port", "1"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js", "--", "--port", "1"],
    });
  });

  it("leaves docker untouched (not Node-based)", () => {
    expect(rewriteForOam("docker", ["run", "-i", "img"], oam)).toEqual({
      command: "docker",
      args: ["run", "-i", "img"],
    });
  });

  it("leaves uv untouched (handled by resolveUvSpawn)", () => {
    expect(rewriteForOam("uv", ["tool", "run", "x"], oam)).toEqual({
      command: "uv",
      args: ["tool", "run", "x"],
    });
  });

  it("falls back to the original command when oam is unavailable", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp"], { oamBin: null, resolveEntry: () => "/x" })).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/npmjs-mcp"],
    });
  });

  it("falls back to npx when the package can't be resolved on disk", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/not-installed"], { oamBin: "oam", resolveEntry: () => null })).toEqual(
      { command: "npx", args: ["-y", "@yawlabs/not-installed"] },
    );
  });
});

describe("npxCacheNodeModules", () => {
  it("derives sibling npx-cache node_modules from a path under _npx", () => {
    const root = mkdtempSync(join(tmpdir(), "npxcache-"));
    const npx = join(root, "_npx");
    // The broker itself is fetched into cache "aaa"; "bbb" is a sibling
    // cache where some other `npx -y <pkg>` server was installed.
    mkdirSync(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist"), { recursive: true });
    mkdirSync(join(npx, "bbb", "node_modules"), { recursive: true });
    const selfUrl = pathToFileURL(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    try {
      expect(npxCacheNodeModules(selfUrl).sort()).toEqual(
        [join(npx, "aaa", "node_modules"), join(npx, "bbb", "node_modules")].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] for a path not under an npx cache", () => {
    expect(npxCacheNodeModules(pathToFileURL(join(tmpdir(), "plain", "index.js")).href)).toEqual([]);
  });

  it("returns [] for a non-file URL", () => {
    expect(npxCacheNodeModules("not-a-url")).toEqual([]);
  });
});
