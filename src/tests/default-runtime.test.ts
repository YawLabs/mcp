import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultRuntime,
  describeDefaultRuntime,
  describeServerRuntime,
  resetDefaultRuntimeCache,
} from "../default-runtime.js";
import { localBundlesPath } from "../local-bundles.js";
import { MIN_OAM_VERSION, type OamProbe, rewriteForOam } from "../oam-spawn.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  // synthCwd lives INSIDE synthHome so findProjectConfigDir's walk-up stops
  // at the synthetic home boundary (same isolation as local-bundles.test.ts).
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-defrt-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
  resetDefaultRuntimeCache();
  // Also cleared here, not just in afterEach: YAW_MCP_DEFAULT_RUNTIME is a
  // DOCUMENTED opt-out, so a developer or CI job can have it exported before
  // the suite starts. The defaultRuntime() tests below read the real process
  // env (that is the production path), and the env short-circuits ahead of the
  // cache logic they exist to pin -- so an inherited value does not just fail
  // them, it makes "caches a degraded read that still resolved a value" pass
  // for the wrong reason. afterEach alone only covers the second test onward.
  delete process.env.YAW_MCP_DEFAULT_RUNTIME;
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  resetDefaultRuntimeCache();
  delete process.env.YAW_MCP_DEFAULT_RUNTIME;
});

function writeBundles(dir: string, content: unknown) {
  mkdirSync(join(dir, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(localBundlesPath(join(dir, CONFIG_DIRNAME)), JSON.stringify(content));
}

describe("describeDefaultRuntime", () => {
  it("returns the env value with source 'env' when YAW_MCP_DEFAULT_RUNTIME is set", async () => {
    const r = await describeDefaultRuntime({
      env: { YAW_MCP_DEFAULT_RUNTIME: "oam" },
      cwd: synthCwd,
      home: synthHome,
    });
    expect(r).toEqual({ runtime: "oam", source: "env", path: null });
  });

  it("env wins over bundles.json defaultRuntime", async () => {
    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "oam" });
    const r = await describeDefaultRuntime({
      env: { YAW_MCP_DEFAULT_RUNTIME: "node" },
      cwd: synthCwd,
      home: synthHome,
    });
    expect(r).toEqual({ runtime: "node", source: "env", path: null });
  });

  it("falls through to bundles.json defaultRuntime with source 'bundles' + the file path", async () => {
    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "oam" });
    const r = await describeDefaultRuntime({ env: {}, cwd: synthCwd, home: synthHome });
    expect(r).toEqual({
      runtime: "oam",
      source: "bundles",
      path: localBundlesPath(join(synthHome, CONFIG_DIRNAME)),
    });
  });

  it("ignores an invalid env value and falls through", async () => {
    const r = await describeDefaultRuntime({
      env: { YAW_MCP_DEFAULT_RUNTIME: "wasm" },
      cwd: synthCwd,
      home: synthHome,
    });
    expect(r).toEqual({ runtime: null, source: null, path: null });
  });

  it("returns null/null when nothing is configured", async () => {
    const r = await describeDefaultRuntime({ env: {}, cwd: synthCwd, home: synthHome });
    expect(r).toEqual({ runtime: null, source: null, path: null });
  });
});

describe("defaultRuntime (cached hot-path variant)", () => {
  // Unlike describeDefaultRuntime, this reads process.env directly (it runs on
  // the upstream connect path, which has no opts to inject), so the env tests
  // here mutate the real var -- see the beforeEach/afterEach deletes. The
  // bundles path is driven through the `cwd`/`home` test hook so assertions do
  // not depend on the machine the suite runs on.
  it("honors YAW_MCP_DEFAULT_RUNTIME from process.env", async () => {
    process.env.YAW_MCP_DEFAULT_RUNTIME = "oam";
    expect(await defaultRuntime()).toBe("oam");
    process.env.YAW_MCP_DEFAULT_RUNTIME = "node";
    expect(await defaultRuntime()).toBe("node");
  });

  it("ignores an invalid env value and falls through to the bundles path", async () => {
    // The hot-path twin of the describeDefaultRuntime invalid-value test. Both
    // resolvers share readEnvChoice, and this pins that this branch really
    // routes through it: if someone loosens what counts as valid for doctor
    // only, doctor would report a default the connect path does not honor.
    process.env.YAW_MCP_DEFAULT_RUNTIME = "wasm";
    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "oam" });
    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBe("oam");
  });

  it("does not cache a bundles.json that exists but will not parse", async () => {
    // The cache holds for the process lifetime, and `null` now means
    // oam-when-installed -- so caching a failed read as "nothing configured"
    // would silently INVERT an explicit `defaultRuntime: "node"` until the
    // broker restarts. A degraded read has to stay retryable.
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    const file = localBundlesPath(join(synthHome, CONFIG_DIRNAME));
    writeFileSync(file, "{ not json at all");

    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBeNull();

    // Same process, file now readable: the next call must SEE it rather than
    // serve the null it just returned.
    writeFileSync(file, JSON.stringify({ version: 1, servers: [], defaultRuntime: "node" }));
    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBe("node");
  });

  it("caches a degraded read that still resolved a value", async () => {
    // The other half of the exemption, and the shape the whole fix is about:
    // an approved-but-unparseable PROJECT file leaves config null while the
    // user-global file still supplies the machine-level knob. That IS an
    // answer, so it must cache rather than re-read on every connect -- the
    // exemption is for degraded-AND-empty, not for degraded.
    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "node" });
    mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
    const projectFile = localBundlesPath(join(synthCwd, CONFIG_DIRNAME));
    writeFileSync(projectFile, "{ not json at all");
    const { grantTrust } = await import("../trust.js");
    await grantTrust(projectFile, readFileSync(projectFile), { home: synthHome });

    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBe("node");

    // Cached: a later change to the global file must NOT be picked up.
    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "oam" });
    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBe("node");
  });

  it("still caches the healthy no-bundles.json case", async () => {
    // Only degraded-AND-empty is exempt. "Nothing configured anywhere" is the
    // common shape and sits on the connect path, so it must not re-read per
    // spawn -- pin that the exemption did not swallow the cache whole.
    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBeNull();

    writeBundles(synthHome, { version: 1, servers: [], defaultRuntime: "oam" });
    expect(await defaultRuntime({ cwd: synthCwd, home: synthHome })).toBeNull();
  });
});

describe("describeServerRuntime", () => {
  const oamOk: OamProbe = {
    bin: "/usr/local/bin/oam",
    binPath: "/usr/local/bin/oam",
    version: MIN_OAM_VERSION,
    belowMin: false,
    failure: null,
    failureDetail: null,
  };
  const oamMissing: OamProbe = {
    bin: null,
    binPath: null,
    version: null,
    belowMin: false,
    failure: null,
    failureDetail: null,
  };
  // Mirrors what probeOam actually publishes for a below-min oam: bin AND
  // binPath both null (oam-spawn.ts), with the version still reported.
  const oamOld: OamProbe = {
    bin: null,
    binPath: null,
    version: "0.5.0",
    belowMin: true,
    failure: null,
    failureDetail: null,
  };
  // A launch the oam rewrite ACCEPTS, so a verdict below is about the gate the
  // case names and not about the argv. Bare `npx` with no args used to stand in
  // here, and that is a launch rewriteForOam refuses outright (no package
  // spec) -- the very confusion the launch-shape codes exist to end.
  const local = (over: { command?: string; args?: string[]; runtime?: "oam" | "node" } = {}) => ({
    type: "local" as const,
    command: "npx",
    args: ["-y", "@yawlabs/npmjs-mcp"],
    ...over,
  });

  it("remote servers get no runtime verdict (nothing to spawn locally)", () => {
    const v = describeServerRuntime({ type: "remote" }, "oam", oamOk);
    expect(v.runtime).toBeNull();
    expect(v.code).toBe("remote");
  });

  it('per-server runtime:"node" is the escape hatch under a default of "oam"', () => {
    const v = describeServerRuntime(local({ runtime: "node" }), "oam", oamOk);
    expect(v).toMatchObject({ runtime: "node", code: "per-server-node" });
  });

  it("no opt-in anywhere -> oam, because an available oam is now the default", () => {
    // The flip: "unset" used to mean node. It now means oam-when-available, so
    // a machine with oam installed gets it without configuring anything.
    const v = describeServerRuntime(local(), null, oamOk);
    expect(v).toMatchObject({ runtime: "oam", code: "default-oam" });
  });

  it("no opt-in anywhere and no oam -> node, silently", () => {
    // The other half of the flip, and the common case: nothing configured and
    // no oam installed must still be plain node.
    const v = describeServerRuntime(local(), null, oamMissing);
    expect(v).toMatchObject({ runtime: "node", code: "oam-not-installed" });
  });

  it('config default "node" opts the whole machine out', () => {
    // With unset meaning oam, an explicit "node" is the only way to turn the
    // default off config-wide -- so it has to actually work.
    const v = describeServerRuntime(local(), "node", oamOk);
    expect(v).toMatchObject({ runtime: "node", code: "default-node" });
  });

  it('per-server runtime:"oam" with a usable oam -> oam', () => {
    const v = describeServerRuntime(local({ runtime: "oam" }), null, oamOk);
    expect(v).toMatchObject({ runtime: "oam", code: "per-server-oam" });
  });

  it('config default "oam" with a usable oam -> oam', () => {
    const v = describeServerRuntime(local(), "oam", oamOk);
    expect(v).toMatchObject({ runtime: "oam", code: "default-oam" });
  });

  it("oam wanted but not installed -> node, reason says so", () => {
    const v = describeServerRuntime(local({ runtime: "oam" }), null, oamMissing);
    expect(v).toMatchObject({ runtime: "node", code: "oam-not-installed" });
    expect(v.reason).toContain("not installed");
  });

  it("oam wanted but below min version -> node, reason names both versions", () => {
    const v = describeServerRuntime(local({ runtime: "oam" }), null, oamOld);
    expect(v).toMatchObject({ runtime: "node", code: "oam-below-min" });
    expect(v.reason).toContain("0.5.0");
    expect(v.reason).toContain(MIN_OAM_VERSION);
  });

  it("oam wanted but the command is not node/npx -> node", () => {
    const v = describeServerRuntime(local({ command: "docker", runtime: "oam" }), null, oamOk);
    expect(v).toMatchObject({ runtime: "node", code: "not-node-command" });
    expect(v.reason).toContain("not node/npx");
  });

  // The gates below are the ones doctor used to report as "oam": the launch
  // shape alone decides them, so the server gets node on every machine, oam
  // installed or not. Each case is asserted TWICE -- once against the verdict
  // and once against rewriteForOam itself, with an oam binary present and a
  // resolver that would resolve anything -- so a future gate added to one and
  // not the other fails here rather than in a user's doctor output.
  describe("launch shapes rewriteForOam deterministically refuses", () => {
    const deps = { oamBin: oamOk.bin, resolveEntry: () => "/tmp/entry.js" };

    const refused: Array<{ what: string; command: string; args: string[]; code: string; says: string }> = [
      { what: "node with nothing to run", command: "node", args: [], code: "node-no-entry", says: "no entry file" },
      {
        what: "node whose first arg is a node flag",
        command: "node",
        args: ["--enable-source-maps", "server.js"],
        code: "node-flag-entry",
        says: "--enable-source-maps",
      },
      { what: "npx with only -y", command: "npx", args: ["-y"], code: "npx-no-spec", says: "no package" },
      {
        what: "npx carrying a flag yaw-mcp does not parse",
        command: "npx",
        args: ["-y", "--package=x", "run"],
        code: "npx-flag-spec",
        says: "--package=x",
      },
      {
        what: "npx pointed at a git target",
        command: "npx",
        args: ["-y", "github:owner/repo"],
        code: "npx-non-registry-spec",
        says: "github:owner/repo",
      },
      {
        what: "npx pointed at a local path",
        command: "npx",
        args: ["-y", "./local-server"],
        code: "npx-non-registry-spec",
        says: "./local-server",
      },
      {
        what: "npx pinning a version range",
        command: "npx",
        args: ["-y", "server-memory@^1.2.3"],
        code: "npx-version-range",
        says: "^1.2.3",
      },
    ];

    for (const c of refused) {
      it(`${c.what} -> node (${c.code}), and the rewrite agrees`, () => {
        const v = describeServerRuntime(
          { type: "local", command: c.command, args: c.args, runtime: "oam" },
          "oam",
          oamOk,
        );
        expect(v).toMatchObject({ runtime: "node", code: c.code });
        expect(v.reason).toContain(c.says);
        expect(rewriteForOam(c.command, [...c.args], deps)).toEqual({ command: c.command, args: c.args });
      });
    }

    const accepted: Array<{ what: string; command: string; args: string[] }> = [
      { what: "node with a real entry", command: "node", args: ["server.js", "--port", "0"] },
      { what: "npx with a bare spec", command: "npx", args: ["-y", "@yawlabs/npmjs-mcp"] },
      { what: "npx with a dist-tag", command: "npx", args: ["-y", "@yawlabs/npmjs-mcp@latest"] },
      { what: "npx with an exact pin", command: "npx", args: ["-y", "server-memory@1.2.3"] },
      // The launcher is matched on its BASENAME at spawn time, so doctor must
      // not fall back to node just because the config spells out a path.
      { what: "an absolute npx path", command: "/usr/local/bin/npx", args: ["-y", "server-memory"] },
    ];

    for (const c of accepted) {
      it(`${c.what} still reports oam, and the rewrite takes it`, () => {
        const v = describeServerRuntime(
          { type: "local", command: c.command, args: c.args, runtime: "oam" },
          "oam",
          oamOk,
        );
        expect(v).toMatchObject({ runtime: "oam", code: "per-server-oam" });
        expect(rewriteForOam(c.command, [...c.args], deps).command).toBe(oamOk.bin);
      });
    }

    it("omitted args read as the empty argv, matching connectToUpstream's `config.args ?? []`", () => {
      const v = describeServerRuntime({ type: "local", command: "node", runtime: "oam" }, "oam", oamOk);
      expect(v).toMatchObject({ runtime: "node", code: "node-no-entry" });
    });

    it("a refused shape outranks the oam-not-installed verdict", () => {
      // Both produce node, but only one is actionable: installing oam does
      // nothing for a launch the rewrite refuses on shape.
      const v = describeServerRuntime(
        { type: "local", command: "npx", args: ["-y", "github:owner/repo"], runtime: "oam" },
        null,
        oamMissing,
      );
      expect(v.code).toBe("npx-non-registry-spec");
      expect(v.reason).not.toContain("not installed");
    });

    it("an explicit per-server node opt-out still wins over the shape gates", () => {
      // The shape checks sit AFTER the opt-out branches, so a server the user
      // pinned to node is reported as pinned, not as malformed.
      const v = describeServerRuntime(
        { type: "local", command: "npx", args: ["-y", "github:owner/repo"], runtime: "node" },
        "oam",
        oamOk,
      );
      expect(v.code).toBe("per-server-node");
    });
  });
});
