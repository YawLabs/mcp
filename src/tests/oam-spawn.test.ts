import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_OAM_VERSION,
  npxCacheNodeModules,
  packageName,
  parseOamVersion,
  probeOam,
  resetOamBinCache,
  resolveNpmEntry,
  rewriteForOam,
  winNormalize,
} from "../oam-spawn.js";

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

describe("parseOamVersion", () => {
  it("extracts x.y.z from the canonical `oam X.Y.Z` output", () => {
    expect(parseOamVersion("oam 0.6.0\n")).toBe("0.6.0");
  });
  it("extracts a bare x.y.z", () => {
    expect(parseOamVersion("1.2.3")).toBe("1.2.3");
  });
  it("returns null when no version is present", () => {
    expect(parseOamVersion("oam dev build")).toBeNull();
  });
});

describe("probeOam min-version gate", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("reports a usable bin + version when at/above MIN_OAM_VERSION", () => {
    const probe = probeOam(() => `oam ${MIN_OAM_VERSION}\n`);
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBe(MIN_OAM_VERSION);
    expect(probe.belowMin).toBe(false);
  });

  it("treats a below-min install as oam-absent (bin null, belowMin set)", () => {
    const probe = probeOam(() => "oam 0.5.9\n");
    expect(probe.bin).toBeNull();
    expect(probe.version).toBe("0.5.9");
    expect(probe.belowMin).toBe(true);
  });

  it("treats a failed probe as not installed", () => {
    const probe = probeOam(() => {
      throw new Error("ENOENT");
    });
    expect(probe).toEqual({ bin: null, version: null, belowMin: false });
  });

  it("treats an unparseable version as usable (a working --version proves oam exists)", () => {
    const probe = probeOam(() => "oam dev build\n");
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
  });

  it("caches the probe result (the runner is only consulted once)", () => {
    let calls = 0;
    const run = () => {
      calls++;
      return "oam 9.9.9";
    };
    probeOam(run);
    probeOam(run);
    expect(calls).toBe(1);
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

describe("resolveNpmEntry", () => {
  // Build a temp npx cache: the broker in cache "aaa", a sidecar in sibling
  // "bbb". `brokerUrl` is a module path under "aaa" so the resolver derives the
  // sibling caches from it.
  function fixture(): { npx: string; brokerUrl: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "resolve-"));
    const npx = join(root, "_npx");
    mkdirSync(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist"), { recursive: true });
    const brokerUrl = pathToFileURL(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    return { npx, brokerUrl, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  function writePkg(npx: string, pkg: string, json: Record<string, unknown>): string {
    const dir = join(npx, "bbb", "node_modules", ...pkg.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
    return dir;
  }

  it("resolves a sidecar's BIN, not its ESM-only exports library entry", () => {
    const { npx, brokerUrl, cleanup } = fixture();
    // Real-world shape: bin is the CLI (dist/index.js); exports is ESM-only
    // (import/types, no require/default) so require.resolve throws -- the bug.
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      type: "module",
      main: "./dist/server.js",
      bin: { "fetch-mcp": "./dist/index.js" },
      exports: { ".": { import: "./dist/server.js", types: "./dist/server.d.ts" } },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("falls back to the first bin when none is keyed by the unscoped name", () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "@modelcontextprotocol/server-memory", {
      name: "@modelcontextprotocol/server-memory",
      bin: { "mcp-server-memory": "dist/index.js" }, // bin key != unscoped name
    });
    try {
      expect(resolveNpmEntry("@modelcontextprotocol/server-memory", brokerUrl)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("falls back to main when there is no bin", () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "libonly", { name: "libonly", main: "lib/main.js" });
    try {
      expect(resolveNpmEntry("libonly", brokerUrl)).toBe(join(dir, "lib", "main.js"));
    } finally {
      cleanup();
    }
  });

  it("returns null when the package is in no cache", () => {
    const { brokerUrl, cleanup } = fixture();
    try {
      expect(resolveNpmEntry("@yawlabs/nonexistent-mcp", brokerUrl)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
