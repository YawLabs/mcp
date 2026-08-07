import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProbeCollector,
  isOamCommand,
  isOamLaunch,
  MIN_OAM_VERSION,
  npxCacheNodeModules,
  OAM_PROBE_TIMEOUT_MS,
  packageName,
  parseOamVersion,
  probeOam,
  resetOamBinCache,
  resolveNpmEntry,
  resolveOamSpawn,
  resolveStableNpmEntry,
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

  it("rejects the version one patch below the floor", async () => {
    // MIN_OAM_VERSION now ends in a non-zero patch (0.8.1), so patch-level
    // comparison decides the boundary for the first time -- a comparator that
    // only weighed major.minor would pass every other test here while hosting
    // on a runtime with the fatal request-stream bug the floor exists to
    // exclude. Derived from the constant so it tracks future bumps.
    const [maj, min, patch] = MIN_OAM_VERSION.split(".").map(Number);
    if (patch === 0) return; // boundary below is a different minor; nothing to assert
    const justBelow = `${maj}.${min}.${patch - 1}`;
    const probe = await probeOam(
      async () => `oam ${justBelow}
`,
    );
    expect(probe.belowMin).toBe(true);
    expect(probe.bin).toBeNull();
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

describe("resolveStableNpmEntry", () => {
  // The whole point: what may be SPAWNED now is not what may be PERSISTED into
  // a client's config. An npx-cache path exists this instant and is gone after
  // `npm cache clean`, which would leave the client pointing at nothing.
  it("refuses an npx-cache install even though resolveNpmEntry accepts it", () => {
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "_npx", "aaa", "node_modules", "@yawlabs", "mcp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@yawlabs/mcp", bin: { "yaw-mcp": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "");
    const fromUrl = pathToFileURL(join(dir, "dist", "index.js")).href;
    try {
      // Same package, same path, opposite answers -- that IS the distinction.
      expect(resolveNpmEntry("@yawlabs/mcp", fromUrl)).toBe(join(dir, "dist", "index.js"));
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the package is absent entirely", () => {
    // Distinct condition from present-but-in-the-npx-cache. Both currently
    // mean "stay on npx", so conflating them is invisible today -- and would
    // stop being invisible the moment either grows its own message.
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "lib", "node_modules", "@yawlabs", "other-pkg");
    mkdirSync(dir, { recursive: true });
    const fromUrl = pathToFileURL(join(dir, "index.js")).href;
    try {
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a durable global/project node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "lib", "node_modules", "@yawlabs", "mcp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@yawlabs/mcp", bin: { "yaw-mcp": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "");
    const fromUrl = pathToFileURL(join(dir, "dist", "index.js")).href;
    try {
      // `npm update -g` rewrites this path in place, so pinning it still picks
      // up new versions -- which is what makes replacing `@latest` acceptable.
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBe(join(dir, "dist", "index.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveNpmEntry", () => {
  // Build a temp npx cache: the broker in cache "aaa", a sidecar in sibling
  // "bbb". `brokerUrl` is a module path under "aaa" so the resolver derives the
  // sibling caches from it.
  //
  // Every call below passes an EXPLICIT npmCache (null, or the fixture's own
  // cache root). Letting it default would resolve the host's real npm cache,
  // where these very package names are present in several versions -- the
  // assertions would then pass or fail based on what the developer happens to
  // have npx'd, which is exactly the machine-dependence the injectable
  // parameter exists to prevent.
  function fixture(): { root: string; npx: string; brokerUrl: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "resolve-"));
    const npx = join(root, "_npx");
    mkdirSync(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist"), { recursive: true });
    const brokerUrl = pathToFileURL(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    return { root, npx, brokerUrl, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null)).toBe(join(dir, "dist", "index.js"));
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
      expect(resolveNpmEntry("@modelcontextprotocol/server-memory", brokerUrl, null)).toBe(
        join(dir, "dist", "index.js"),
      );
    } finally {
      cleanup();
    }
  });

  it("falls back to main when there is no bin", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "libonly", { name: "libonly", main: "lib/main.js" });
    try {
      expect(resolveNpmEntry("libonly", brokerUrl, null)).toBe(join(dir, "lib", "main.js"));
    } finally {
      cleanup();
    }
  });

  it("returns null when the package is in no cache", async () => {
    const { brokerUrl, cleanup } = fixture();
    try {
      expect(resolveNpmEntry("@yawlabs/nonexistent-mcp", brokerUrl, null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("finds an npx-cached sidecar when the broker is NOT itself under _npx", async () => {
    // The globally-installed shape, and the one that was broken: a broker at
    // <globalroot>/@yawlabs/mcp has no "_npx" segment in its path, so the
    // path-derived cache search returned nothing and EVERY `npx -y <pkg>`
    // sidecar silently stayed on npx -- while doctor reported it as "oam".
    // Passing the cache root explicitly is what makes the lookup independent
    // of how the broker itself was launched.
    const { root, npx, cleanup } = fixture();
    const globalUrl = pathToFileURL(join(root, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      bin: { "fetch-mcp": "./dist/index.js" },
    });
    try {
      // Without the cache root it cannot be found at all...
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", globalUrl, null)).toBeNull();
      // ...and with it, the same global broker reaches the same sidecar.
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", globalUrl, root)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("picks the highest version when the npx cache holds several copies", async () => {
    // The cache is keyed by content hash, so a machine that has run a server
    // for months keeps every version it ever fetched (15 copies of one sidecar
    // is real). Iteration order is hash order, so "first hit" silently pinned
    // an arbitrary build -- a config saying `@latest` running months-old code
    // with nothing logged anywhere.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const mk = (hash: string, version: string) => {
      const dir = join(npx, hash, "node_modules", "@yawlabs", "fetch-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@yawlabs/fetch-mcp", version, bin: { "fetch-mcp": "./dist/index.js" } }),
      );
      return dir;
    };
    // The newest copy is deliberately placed so it sorts LAST. Directory order
    // is what the old code followed, so an oldest-first layout is the only one
    // that actually fails when "first hit wins" comes back.
    mk("aaa0", "0.1.0");
    mk("mmm5", "0.3.3");
    const newest = mk("zzz9", "0.3.6");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root)).toBe(join(newest, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("prefers a durable install over any cached copy, even a newer one", async () => {
    // A real `npm i` is a deliberate choice and the single copy; the cache is
    // incidental. Version order must not override that.
    const { root, npx, cleanup } = fixture();
    const home = join(root, "global", "node_modules");
    const durable = join(home, "@yawlabs", "fetch-mcp");
    mkdirSync(durable, { recursive: true });
    writeFileSync(
      join(durable, "package.json"),
      JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.1.0", bin: { "fetch-mcp": "./dist/index.js" } }),
    );
    const brokerUrl = pathToFileURL(join(home, "@yawlabs", "mcp", "dist", "index.js")).href;
    const cachedDir = join(npx, "aaa0", "node_modules", "@yawlabs", "fetch-mcp");
    mkdirSync(cachedDir, { recursive: true });
    writeFileSync(
      join(cachedDir, "package.json"),
      JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "9.9.9", bin: { "fetch-mcp": "./dist/index.js" } }),
    );
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root)).toBe(join(durable, "dist", "index.js"));
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
      const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
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

  it("warns when the probe fails for any reason other than 'not installed'", async () => {
    // A present-but-broken oam -- exits non-zero on --version, is killed by a
    // signal, is not executable -- downgrades every opted-in server to node
    // for the process lifetime exactly like a timeout does. Silence there
    // leaves nothing to explain why oam quietly stopped being used.
    const lines = await captureStderr(() =>
      probeOam(async () => {
        throw new Error("oam exited 1");
      }),
    );
    const warn = lines.find((l) => l.msg?.includes("oam --version failed"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
  });
});

// Two hardening fixes after #92 shipped.
describe("probeOam hardening", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  // These assert the COLLECTOR's behaviour. The previous version of this test
  // only asserted that OAM_PROBE_MAX_OUTPUT sat in a plausible range, which
  // passes with the capping logic deleted outright -- it proved nothing.

  it("caps retained output hard, even against a single oversized chunk", () => {
    // The first implementation checked the length BEFORE appending, so one
    // big chunk landed whole: an 80KB chunk was retained in full.
    const c = createProbeCollector(1024);
    c.push("x".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(1024);

    c.push("y".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(1024);
  });

  it("still finds a version that arrives after the cap", () => {
    // The real damage of a naive prefix cap: the version is discarded, so
    // parseOamVersion returns null, so the `version !== null` guard skips the
    // MIN_OAM_VERSION check -- hosting on an oam that was never version-gated.
    const c = createProbeCollector(64);
    c.push("banner ".repeat(200)); // well past the cap, no version in it
    c.push("oam 0.9.1\n");
    expect(parseOamVersion(c.result())).toBe("0.9.1");
  });

  it("finds a version split across a chunk boundary, past the cap", () => {
    // The cap must be already full, otherwise the head buffer happens to
    // contain both halves and the test passes without the carry doing any
    // work -- which is exactly how the first version of this test passed
    // with the carry deleted.
    const c = createProbeCollector(16);
    c.push("banner ".repeat(50)); // head is now full of text with no version
    c.push("oam 0.");
    c.push("6.0\n");
    expect(parseOamVersion(c.result())).toBe("0.6.0");
  });

  it("stops collecting once the version is known", () => {
    // `found` is monotonic and result() never reaches `head` once it is set,
    // so a further chunk has nothing to do. Without the early return each one
    // still costs a full-chunk concat plus a slice -- paid precisely by the
    // runaway binary the cap exists to bound.
    const c = createProbeCollector(1024);
    c.push("oam 1.2.3\n");
    const retained = c.retainedLength();

    c.push("x".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(retained);
    expect(parseOamVersion(c.result())).toBe("1.2.3");
  });

  it("keeps the first version when several appear", () => {
    const c = createProbeCollector();
    c.push("oam 1.2.3\n");
    c.push("plugin 9.9.9\n");
    expect(parseOamVersion(c.result())).toBe("1.2.3");
  });

  it("returns capped text (which parses to null) when no version appears", () => {
    const c = createProbeCollector(32);
    c.push("no version here at all, and quite a lot of it".repeat(10));
    expect(c.retainedLength()).toBe(32);
    expect(parseOamVersion(c.result())).toBeNull();
  });

  it("a below-min version past the cap still trips the gate end to end", async () => {
    // The consequence chain, exercised through probeOam rather than the
    // collector: a chatty binary must not smuggle an old oam past the gate.
    const probe = await probeOam(async () => {
      const c = createProbeCollector(64);
      c.push("banner ".repeat(200));
      c.push(`oam 0.0.1\n`);
      return c.result();
    });
    expect(probe.belowMin).toBe(true);
    expect(probe.bin).toBeNull();
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

  it("does not let a stale probe release the in-flight slot of the one that replaced it", async () => {
    // The test above releases the stale probe BEFORE the replacement starts,
    // so the ordering the generation guard actually exists for -- stale settles
    // LAST, after a newer probe already owns the slot -- never runs. Unguarded,
    // the stale .finally clears oamProbeInFlight and the next caller starts a
    // second spawn against state the live probe is already resolving.
    let releaseStale: (v: string) => void = () => {};
    const stale = () =>
      new Promise<string>((r) => {
        releaseStale = r;
      });
    // One resolver per invocation, so a spurious second probe is counted rather
    // than silently stealing the first one's resolver and hanging the test.
    const freshCalls: Array<(v: string) => void> = [];
    const fresh = () => new Promise<string>((r) => freshCalls.push(r));

    const staleProbe = probeOam(stale);
    resetOamBinCache();
    const freshProbe = probeOam(fresh); // claims the in-flight slot

    releaseStale("oam 9.9.9"); // ...and only now does the discarded probe land
    await staleProbe;

    // A caller arriving here must JOIN the live probe, not start another.
    const joiner = probeOam(fresh);
    for (const release of freshCalls) release("oam 1.2.3");
    const [a, b] = await Promise.all([freshProbe, joiner]);

    expect(freshCalls, "stale probe's cleanup released the live probe's slot").toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.version).toBe("1.2.3");
  });
});

describe("resolveOamSpawn — missing-oam warning", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => {
    resetOamBinCache();
    vi.restoreAllMocks();
  });

  /** Prime the probe cache as "oam absent" so this does not depend on whether
   *  the machine running the tests has oam. */
  async function primeAbsent(): Promise<void> {
    await probeOam(async () => {
      const e: NodeJS.ErrnoException = new Error("spawn oam ENOENT");
      e.code = "ENOENT";
      throw e;
    });
  }

  it("warns once per process, not once per opted-in server", async () => {
    await primeAbsent();
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    // A broker hosting a dozen opted-in servers must not print this a dozen
    // times on every boot.
    await resolveOamSpawn("node", ["a.js"]);
    await resolveOamSpawn("node", ["b.js"]);
    await resolveOamSpawn("node", ["c.js"]);
    const warnings = lines.filter((l) => l.includes("opted in to oam but oam is not installed"));
    expect(warnings).toHaveLength(1);
    // and it carries the install command -- the whole point of warning
    expect(warnings[0]).toContain("oamjs.org/install.sh");
  });

  it("stays silent when oam is present", async () => {
    await probeOam(async () => "oam 99.0.0");
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("oam is not installed"))).toHaveLength(0);
  });

  it("stays silent for a below-min install, which warns in the probe instead", async () => {
    // Two warnings for one condition would be noise; belowMin already reports
    // both versions, which is strictly more actionable.
    await probeOam(async () => "oam 0.0.1");
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("opted in to oam but oam is not installed"))).toHaveLength(0);
  });
});

describe("isOamCommand / isOamLaunch", () => {
  it("recognises an oam command with either path separator", () => {
    expect(isOamCommand("oam")).toBe(true);
    expect(isOamCommand("oam.exe")).toBe(true);
    expect(isOamCommand("/usr/local/bin/oam")).toBe(true);
    // Windows writes this shape, and a "/"-only split silently missed it.
    expect(isOamCommand(String.raw`C:\Users\jeff\oam.exe`)).toBe(true);
    expect(isOamCommand("npx")).toBe(false);
    expect(isOamCommand("cmd")).toBe(false);
    expect(isOamCommand("/usr/bin/node")).toBe(false);
    // Not a substring match: a different binary that merely contains "oam".
    expect(isOamCommand("/usr/bin/foam")).toBe(false);
  });

  // These assert the shapes a CONFIG FILE actually contains. An earlier
  // version asserted `sh -c` with a single-token payload and `cmd` with a bare
  // `/c` -- neither occurs in practice, so the suite went green while every
  // realistic wrapped entry returned false.
  it("sees through a cmd wrapper, including its everyday switch set", () => {
    expect(isOamLaunch("cmd", ["/c", "oam", "run", "x.js"])).toBe(true);
    expect(isOamLaunch("cmd.exe", ["/C", String.raw`C:\bin\oam.exe`, "run"])).toBe(true);
    // `/d /s /c` is what npm and most wrappers emit -- the common case, and
    // the one the first version missed by matching only an exact "/c".
    expect(isOamLaunch("cmd", ["/d", "/s", "/c", "oam", "run", "x.js"])).toBe(true);
    expect(isOamLaunch("cmd", ["/d", "/s", "/c", "npx", "-y", "@yawlabs/mcp@latest"])).toBe(false);
  });

  it("sees through a POSIX shell wrapper, whose payload is ONE string", () => {
    // `sh -c` does not receive separate argv entries -- this is the shape that
    // silently failed before.
    expect(isOamLaunch("sh", ["-c", "oam run /path/index.js"])).toBe(true);
    expect(isOamLaunch("bash", ["-c", "/usr/local/bin/oam run x.js"])).toBe(true);
    expect(isOamLaunch("sh", ["-c", "npx -y @yawlabs/mcp@latest"])).toBe(false);
    // Quoting is tolerated only when it does not hide a space: tokenising on
    // whitespace cannot recover `'/opt/my oam/oam'`, and a display marker is
    // not worth a shell parser. Under-reporting (says node) is the safe way
    // to be wrong here -- it never claims oam for something that is not.
    expect(isOamLaunch("sh", ["-c", `"oam" run x.js`])).toBe(true);
    expect(isOamLaunch("sh", ["-c", `'/opt/my oam/oam' run x.js`])).toBe(false);
    expect(isOamLaunch("sh", ["-c", "   "])).toBe(false);
    expect(isOamLaunch("sh", ["-c"])).toBe(false);
  });

  it("judges a non-shell command on itself, never on its arguments", () => {
    // Otherwise `node --require oam ...` would read as oam-hosted.
    expect(isOamLaunch("node", ["oam"])).toBe(false);
    expect(isOamLaunch("npx", ["oam"])).toBe(false);
    expect(isOamLaunch("oam", [])).toBe(true);
    expect(isOamLaunch("npx", [])).toBe(false);
    // A POSIX path argument must never be read as a cmd switch.
    expect(isOamLaunch("cmd", ["/c", "/usr/local/bin/oam"])).toBe(true);
  });
});
