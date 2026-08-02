import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_OAM_VERSION,
  npxCacheNodeModules,
  OAM_PROBE_MAX_OUTPUT,
  OAM_PROBE_TIMEOUT_MS,
  packageName,
  parseOamVersion,
  probeOam,
  resetOamBinCache,
  resolveNpmEntry,
  rewriteForOam,
  winNormalize,
} from "../oam-spawn.js";

describe("winNormalize", () => {
  it("converts forward slashes to backslashes on Windows (cmd-safe)", async () => {
    expect(winNormalize("C:/Users/jeff/oam/target/release/oam.exe", "win32")).toBe(
      "C:\\Users\\jeff\\oam\\target\\release\\oam.exe",
    );
  });
  it("leaves an already-backslash path untouched on Windows", async () => {
    expect(winNormalize("C:\\Users\\jeff\\oam.exe", "win32")).toBe("C:\\Users\\jeff\\oam.exe");
  });
  it("leaves a bare binary name untouched", async () => {
    expect(winNormalize("oam.exe", "win32")).toBe("oam.exe");
  });
  it("is a no-op off Windows", async () => {
    expect(winNormalize("/usr/local/bin/oam", "linux")).toBe("/usr/local/bin/oam");
  });
});

describe("packageName", () => {
  it("strips @latest from a scoped package", async () => {
    expect(packageName("@yawlabs/tailscale-mcp@latest")).toBe("@yawlabs/tailscale-mcp");
  });
  it("strips a semver from an unscoped package", async () => {
    expect(packageName("server-memory@1.2.3")).toBe("server-memory");
  });
  it("leaves a bare scoped name untouched", async () => {
    expect(packageName("@yawlabs/npmjs-mcp")).toBe("@yawlabs/npmjs-mcp");
  });
  it("leaves a bare unscoped name untouched", async () => {
    expect(packageName("cowsay")).toBe("cowsay");
  });
});

describe("parseOamVersion", () => {
  it("extracts x.y.z from the canonical `oam X.Y.Z` output", async () => {
    expect(parseOamVersion("oam 0.6.0\n")).toBe("0.6.0");
  });
  it("extracts a bare x.y.z", async () => {
    expect(parseOamVersion("1.2.3")).toBe("1.2.3");
  });
  it("returns null when no version is present", async () => {
    expect(parseOamVersion("oam dev build")).toBeNull();
  });
});

describe("probeOam min-version gate", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("reports a usable bin + version when at/above MIN_OAM_VERSION", async () => {
    const probe = await probeOam(async () => `oam ${MIN_OAM_VERSION}\n`);
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBe(MIN_OAM_VERSION);
    expect(probe.belowMin).toBe(false);
  });

  it("treats a below-min install as oam-absent (bin null, belowMin set)", async () => {
    const probe = await probeOam(async () => "oam 0.5.9\n");
    expect(probe.bin).toBeNull();
    expect(probe.version).toBe("0.5.9");
    expect(probe.belowMin).toBe(true);
  });

  it("treats a failed probe as not installed", async () => {
    const probe = await probeOam(async () => {
      throw new Error("ENOENT");
    });
    expect(probe).toEqual({ bin: null, version: null, belowMin: false });
  });

  it("treats an unparseable version as usable (a working --version proves oam exists)", async () => {
    const probe = await probeOam(async () => "oam dev build\n");
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
  });

  it("caches the probe result (the runner is only consulted once)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return "oam 9.9.9";
    };
    await probeOam(run);
    await probeOam(run);
    expect(calls).toBe(1);
  });
});

describe("rewriteForOam", () => {
  const oam = { oamBin: "oam", resolveEntry: (p: string) => `/pkgs/${p}/dist/index.js` };

  it("rewrites `npx -y <pkg>@latest` to `oam run <resolved entry>`", async () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp@latest"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/@yawlabs/npmjs-mcp/dist/index.js"],
    });
  });

  it("rewrites `node <entry>` to `oam run <entry>`", async () => {
    expect(rewriteForOam("node", ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
  });

  it("forwards extra args after `--`", async () => {
    expect(rewriteForOam("node", ["/srv/index.js", "--port", "1"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js", "--", "--port", "1"],
    });
  });

  it("stays on node when the first arg is a node flag, not the entry", async () => {
    expect(rewriteForOam("node", ["--enable-source-maps", "/srv/index.js"], oam)).toEqual({
      command: "node",
      args: ["--enable-source-maps", "/srv/index.js"],
    });
  });

  it("leaves docker untouched (not Node-based)", async () => {
    expect(rewriteForOam("docker", ["run", "-i", "img"], oam)).toEqual({
      command: "docker",
      args: ["run", "-i", "img"],
    });
  });

  it("leaves uv untouched (handled by resolveUvSpawn)", async () => {
    expect(rewriteForOam("uv", ["tool", "run", "x"], oam)).toEqual({
      command: "uv",
      args: ["tool", "run", "x"],
    });
  });

  it("falls back to the original command when oam is unavailable", async () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp"], { oamBin: null, resolveEntry: () => "/x" })).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/npmjs-mcp"],
    });
  });

  it("falls back to npx when the package can't be resolved on disk", async () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/not-installed"], { oamBin: "oam", resolveEntry: () => null })).toEqual(
      { command: "npx", args: ["-y", "@yawlabs/not-installed"] },
    );
  });
});

describe("npxCacheNodeModules", () => {
  it("derives sibling npx-cache node_modules from a path under _npx", async () => {
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

  it("returns [] for a path not under an npx cache", async () => {
    expect(npxCacheNodeModules(pathToFileURL(join(tmpdir(), "plain", "index.js")).href)).toEqual([]);
  });

  it("returns [] for a non-file URL", async () => {
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

  it("resolves a sidecar's BIN, not its ESM-only exports library entry", async () => {
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

  it("falls back to the first bin when none is keyed by the unscoped name", async () => {
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

  it("falls back to main when there is no bin", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "libonly", { name: "libonly", main: "lib/main.js" });
    try {
      expect(resolveNpmEntry("libonly", brokerUrl)).toBe(join(dir, "lib", "main.js"));
    } finally {
      cleanup();
    }
  });

  it("returns null when the package is in no cache", async () => {
    const { brokerUrl, cleanup } = fixture();
    try {
      expect(resolveNpmEntry("@yawlabs/nonexistent-mcp", brokerUrl)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// probeOam runs execFileSync, which blocks the event loop, on the upstream
// connect path of a single-threaded broker. Without a timeout an oam binary
// that never returns wedges the whole hub. These pin both halves of the
// contract: the bound exists, and exceeding it degrades to the same
// node fallback that an absent oam already produces.
describe("probeOam timeout", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("declares a probe timeout matching the uv onPath budget", async () => {
    expect(OAM_PROBE_TIMEOUT_MS).toBe(3_000);
  });

  it("falls back to node when the probe times out", async () => {
    // execFileSync throws ETIMEDOUT when the child exceeds `timeout`; the
    // catch must produce the same result as "oam is not installed".
    const probe = await probeOam(async () => {
      const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
    });
    expect(probe.bin).toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
  });

  it("leaves an opted-in server on its original node/npx command after a timeout", async () => {
    const probe = await probeOam(async () => {
      throw new Error("spawnSync oam ETIMEDOUT");
    });
    const original = { command: "npx", args: ["-y", "some-mcp-server"] };
    const rewritten = rewriteForOam(original.command, original.args, {
      oamBin: probe.bin,
      resolveEntry: () => "/somewhere/entry.js",
    });
    expect(rewritten).toEqual(original);
  });
});

// A timeout is not the same event as "oam is not installed", even though both
// land on the same node fallback. oam IS on disk and did not answer in time --
// and because the probe result is cached for the process lifetime, that one
// slow moment downgrades every opted-in server until restart. Without a log
// there is nothing to tell the user why their oam-hosted servers stopped
// using oam.
describe("probeOam timeout diagnostics", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  /** Collect everything the logger writes to stderr while `fn` runs. */
  async function captureStderr(fn: () => unknown): Promise<Array<{ level?: string; msg?: string }>> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { level?: string; msg?: string });
  }

  it("warns when the probe times out, so the silent downgrade is diagnosable", async () => {
    const lines = await captureStderr(() =>
      probeOam(async () => {
        const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        throw err;
      }),
    );
    const warn = lines.find((l) => l.msg?.includes("did not respond to --version"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
  });

  it("stays silent when oam is simply not installed", async () => {
    // ENOENT is the routine node-only setup; logging it would be noise on
    // every machine without oam.
    const lines = await captureStderr(() =>
      probeOam(async () => {
        const err = new Error("spawnSync oam ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }),
    );
    expect(lines).toEqual([]);
  });
});

// Two hardening fixes after #92 shipped.
describe("probeOam hardening", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("declares a bound on retained probe output", () => {
    // execFileSync applied a 1MB maxBuffer for free; the async rewrite
    // dropped it, so a chatty binary could grow the buffer for the whole
    // timeout window. A version string is under 100 bytes.
    expect(OAM_PROBE_MAX_OUTPUT).toBeGreaterThan(0);
    expect(OAM_PROBE_MAX_OUTPUT).toBeLessThanOrEqual(64 * 1024);
  });

  it("does not let a probe that was in flight during a reset publish its result", async () => {
    // Otherwise the reset is silently undone by a probe the caller believes
    // it discarded -- one test's probe populating the next test's cache.
    let release: (v: string) => void = () => {};
    const slow = () =>
      new Promise<string>((r) => {
        release = r;
      });

    const inflight = probeOam(slow);
    resetOamBinCache(); // caller discards that probe
    release("oam 9.9.9"); // ...which only now lands
    await inflight;

    // A fresh probe must actually run rather than reading the discarded result.
    let ran = false;
    const after = await probeOam(async () => {
      ran = true;
      return "oam 1.2.3";
    });
    expect(ran, "stale in-flight probe published over the reset").toBe(true);
    expect(after.version).toBe("1.2.3");
  });
});
