import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURATED_BUNDLES } from "../bundles.js";
import { parseBundlesArgs, runBundlesCommand } from "../bundles-cmd.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { grantTrust } from "../trust.js";
import type { UpstreamServerConfig } from "../types.js";

function makeServer(over: Partial<UpstreamServerConfig>): Partial<UpstreamServerConfig> {
  return {
    id: "srv-1",
    name: "Example",
    namespace: "ex",
    type: "local",
    command: "npx",
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

  it("is fully static -- reads no config file at all", async () => {
    const io = captureIO();
    // Note: no home/cwd seed. `list` never touches bundles.json, so it can't
    // emit a load warning or an empty-state hint here.
    const r = await runBundlesCommand({ action: "list", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.err).toEqual([]);
  });
});

describe("runBundlesCommand — match", () => {
  let home: string;

  /** Write a user-global ~/.yaw-mcp/bundles.json with the given servers. */
  function seedBundles(servers: Array<Partial<UpstreamServerConfig>>): void {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }, null, 2), "utf8");
  }

  /** `cwd: home` keeps findProjectConfigDir from walking into a real project
   *  `.yaw-mcp/` (it only considers dirs strictly UNDER home), so every case
   *  below resolves to the user-global file we just seeded. */
  const run = (opts: Parameters<typeof runBundlesCommand>[0] = {}) =>
    runBundlesCommand({ home, cwd: home, action: "match", ...opts });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("needs no token and no network -- an empty config still exits 0", async () => {
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("No curated bundles match");
  });

  it("reports ready + partial bundles based on local namespaces", async () => {
    // github + linear + slack → pr-review ready, product-release ready,
    // devops-incident partial (missing pagerduty), support-ops partial (missing zendesk, hubspot).
    seedBundles([
      makeServer({ namespace: "github", name: "GitHub" }),
      makeServer({ namespace: "linear", name: "Linear" }),
      makeServer({ namespace: "slack", name: "Slack" }),
    ]);
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
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
    seedBundles([
      makeServer({ namespace: "github", name: "GitHub", isActive: true }),
      makeServer({ namespace: "linear", name: "Linear", isActive: false }),
    ]);
    const io = captureIO();
    await run({ out: io.push, err: io.pushErr });
    const combined = io.out.join("\n");
    expect(combined).not.toContain("Ready to activate");
    // But linear should NOT appear in "enabled servers" either. Singular
    // "server" -- the header pluralizes on the enabled count.
    expect(combined).toContain("1 enabled server: github");
  });

  it("prints the no-match message when nothing overlaps", async () => {
    seedBundles([makeServer({ namespace: "weirdnamespace", name: "Weird" })]);
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("No curated bundles match");
  });

  it("emits JSON with installed + ready + partial when --json is set", async () => {
    seedBundles([makeServer({ namespace: "github" }), makeServer({ namespace: "linear" })]);
    const io = captureIO();
    const r = await run({ json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toContain("github");
    expect(parsed.installed).toContain("linear");
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(Array.isArray(parsed.partial)).toBe(true);
    // pr-review should be in `ready` (both github + linear installed).
    expect(parsed.ready.some((b: { id: string }) => b.id === "pr-review")).toBe(true);
  });

  it("reads an APPROVED project-local bundles.json over the user-global one", async () => {
    seedBundles([makeServer({ namespace: "weirdnamespace", name: "Weird" })]);
    const project = join(home, "proj");
    mkdirSync(join(project, CONFIG_DIRNAME), { recursive: true });
    const projectBundles = join(project, CONFIG_DIRNAME, "bundles.json");
    writeFileSync(
      projectBundles,
      JSON.stringify({
        version: 1,
        servers: [makeServer({ namespace: "github" }), makeServer({ namespace: "linear" })],
      }),
      "utf8",
    );
    // A project bundles.json only wins once the user has approved it via
    // `yaw-mcp trust` -- see the consent gate in src/trust.ts.
    await grantTrust(projectBundles, readFileSync(projectBundles), { home });
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      cwd: project,
      action: "match",
      json: true,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toEqual(expect.arrayContaining(["github", "linear"]));
    expect(parsed.installed).not.toContain("weirdnamespace");
  });

  it("warns on stderr (still exit 0) when bundles.json is malformed", async () => {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.err.join("\n")).toMatch(/invalid JSON/);
    // Diagnostic must not leak into the stdout a --json consumer parses.
    expect(io.out.join("\n")).not.toMatch(/invalid JSON/);
  });

  it("keeps stdout parseable under --json even when the file is malformed", async () => {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
    const io = captureIO();
    await run({ json: true, out: io.push, err: io.pushErr });
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toEqual([]);
  });

  it("sorts partial bundles by fewest-missing first", async () => {
    // github → devops-incident missing 2, pr-review missing 1 (linear).
    seedBundles([makeServer({ namespace: "github" })]);
    const io = captureIO();
    await run({ out: io.push, err: io.pushErr });
    const combined = io.out.join("\n");
    const prAt = combined.indexOf("pr-review");
    const devopsAt = combined.indexOf("devops-incident");
    expect(prAt).toBeGreaterThan(-1);
    expect(devopsAt).toBeGreaterThan(-1);
    expect(prAt).toBeLessThan(devopsAt);
  });
});
