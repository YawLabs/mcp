import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  // synthCwd lives INSIDE synthHome so findProjectConfigDir's walk-up stops
  // at the synthetic home boundary (same isolation as local-bundles.test.ts).
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-defrt-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
  resetDefaultRuntimeCache();
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
  // Only the env path is exercised here: the bundles path of defaultRuntime()
  // reads the REAL process.cwd()/homedir() (it runs on the upstream connect
  // path), which would make assertions machine-dependent. The bundles logic
  // itself is covered via describeDefaultRuntime above (same loader).
  it("honors YAW_MCP_DEFAULT_RUNTIME from process.env", async () => {
    process.env.YAW_MCP_DEFAULT_RUNTIME = "oam";
    expect(await defaultRuntime()).toBe("oam");
    process.env.YAW_MCP_DEFAULT_RUNTIME = "node";
    expect(await defaultRuntime()).toBe("node");
  });
});

describe("describeServerRuntime", () => {
  const oamOk: OamProbe = { bin: "/usr/local/bin/oam", version: MIN_OAM_VERSION, belowMin: false };
  const oamMissing: OamProbe = { bin: null, version: null, belowMin: false };
  const oamOld: OamProbe = { bin: null, version: "0.5.0", belowMin: true };
  const local = (over: { command?: string; runtime?: "oam" | "node" } = {}) => ({
    type: "local" as const,
    command: "npx",
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

  it("no opt-in anywhere -> node by default", () => {
    const v = describeServerRuntime(local(), null, oamOk);
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
});
