import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBundlesArgs, runBundlesCommand } from "../bundles-cmd.js";
import { CURATED_BUNDLES } from "../bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";
import type { ConnectConfig, UpstreamServerConfig } from "../types.js";

function makeServer(over: Partial<UpstreamServerConfig>): UpstreamServerConfig {
  return {
    id: "srv-1",
    name: "Example",
    namespace: "ex",
    type: "remote",
    isActive: true,
    ...over,
  };
}

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseBundlesArgs", () => {
  it("defaults to action=list, json=false", () => {
    expect(parseBundlesArgs([])).toEqual({ ok: true, options: { action: "list", json: false } });
  });

  it("accepts action=list explicitly", () => {
    expect(parseBundlesArgs(["list"])).toEqual({ ok: true, options: { action: "list", json: false } });
  });

  it("accepts action=match", () => {
    expect(parseBundlesArgs(["match"])).toEqual({ ok: true, options: { action: "match", json: false } });
  });

  it("accepts --json combined with an action", () => {
    expect(parseBundlesArgs(["match", "--json"])).toEqual({ ok: true, options: { action: "match", json: true } });
    expect(parseBundlesArgs(["--json", "list"])).toEqual({ ok: true, options: { action: "list", json: true } });
  });

  it("rejects a second action arg", () => {
    const r = parseBundlesArgs(["list", "match"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("action already set");
  });

  it("rejects unknown args", () => {
    const r = parseBundlesArgs(["--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("--help returns the usage string", () => {
    const r = parseBundlesArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: yaw-mcp bundles");
  });
});

describe("runBundlesCommand — list", () => {
  it("prints every curated bundle grouped by category", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({ action: "list", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    expect(combined).toContain(`${CURATED_BUNDLES.length} curated bundles`);
    // Every bundle id should show up in the list output.
    for (const b of CURATED_BUNDLES) {
      expect(combined).toContain(b.id);
      expect(combined).toContain(b.name);
    }
    // Category headers are rendered in bracket form.
    const categories = new Set(CURATED_BUNDLES.map((b) => b.category));
    for (const cat of categories) {
      expect(combined).toContain(`[${cat}]`);
    }
  });

  it("emits JSON when --json is set", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({ action: "list", json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.bundles).toHaveLength(CURATED_BUNDLES.length);
    expect(parsed.bundles[0]).toHaveProperty("id");
  });

  it("does not hit the network or require a token", async () => {
    const io = captureIO();
    // Note: no home/env seed — if `list` tried to call loadYawMcpConfig+fetcher,
    // it would either error or block. This test proves it's fully static.
    const r = await runBundlesCommand({
      action: "list",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => {
        throw new Error("fetcher MUST NOT run during list");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(io.err).toEqual([]);
  });
});

describe("runBundlesCommand — match", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      join(home, CONFIG_DIRNAME, "config.json"),
      JSON.stringify({ version: 1, token: "mcp_pat_test" }),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 1 when no token is resolvable", async () => {
    rmSync(join(home, CONFIG_DIRNAME, "config.json"));
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => {
        throw new Error("fetcher should not run");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(io.err.join("")).toContain("no token resolved");
  });

  it("reports ready + partial bundles based on installed namespaces", async () => {
    // github + linear + slack → pr-review ready, product-release ready,
    // devops-incident partial (missing pagerduty), support-ops partial (missing zendesk, hubspot).
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [
        makeServer({ namespace: "github", name: "GitHub" }),
        makeServer({ namespace: "linear", name: "Linear" }),
        makeServer({ namespace: "slack", name: "Slack" }),
      ],
    };
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    expect(combined).toContain("Ready to activate");
    expect(combined).toContain("pr-review");
    expect(combined).toContain("product-release");
    expect(combined).toContain("Partially installed");
    expect(combined).toContain("devops-incident");
    expect(combined).toContain("missing: pagerduty");
  });

  it("only counts enabled servers when matching", async () => {
    // github enabled; linear disabled → pr-review should NOT be ready.
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [
        makeServer({ namespace: "github", name: "GitHub", isActive: true }),
        makeServer({ namespace: "linear", name: "Linear", isActive: false }),
      ],
    };
    const io = captureIO();
    await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    const combined = io.out.join("\n");
    expect(combined).not.toContain("Ready to activate");
    // But linear should NOT appear in "enabled servers" either.
    expect(combined).toContain("1 enabled servers: github");
  });

  it("prints the no-match message when nothing overlaps", async () => {
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [makeServer({ namespace: "weirdnamespace", name: "Weird" })],
    };
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("No curated bundles match");
  });

  it("emits JSON with installed + ready + partial when --json is set", async () => {
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [makeServer({ namespace: "github" }), makeServer({ namespace: "linear" })],
    };
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      json: true,
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toContain("github");
    expect(parsed.installed).toContain("linear");
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(Array.isArray(parsed.partial)).toBe(true);
    // pr-review should be in `ready` (both github + linear installed).
    expect(parsed.ready.some((b: { id: string }) => b.id === "pr-review")).toBe(true);
  });

  it("exits 2 when the fetcher throws", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => {
        throw new Error("network unreachable");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("")).toContain("network unreachable");
  });

  it("exits 2 on unexpected 304 (null response)", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => null,
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("")).toContain("unexpected 304");
  });

  it("sorts partial bundles by fewest-missing first", async () => {
    // github → devops-incident missing 2, pr-review missing 1 (linear).
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [makeServer({ namespace: "github" })],
    };
    const io = captureIO();
    await runBundlesCommand({
      home,
      env: {},
      action: "match",
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    const combined = io.out.join("\n");
    const prAt = combined.indexOf("pr-review");
    const devopsAt = combined.indexOf("devops-incident");
    expect(prAt).toBeGreaterThan(-1);
    expect(devopsAt).toBeGreaterThan(-1);
    expect(prAt).toBeLessThan(devopsAt);
  });
});
