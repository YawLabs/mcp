import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { parseAddArgs, parseListArgs, parseRemoveArgs, runAdd, runList, runRemove } from "../local-add-cmd.js";
import { deriveNamespace, loadLocalBundles, removeUserBundle, upsertUserBundle } from "../local-bundles.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-add-home-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function captureIO(): { out: string[]; err: string[]; text: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, text: () => out.join(""), errText: () => err.join("") };
}

// Realistic catalog shapes: like the live catalog, each slug's word-form
// matches its name (so deriveNamespace(slug) === deriveNamespace(name)).
const CATALOG: CatalogServer[] = [
  {
    slug: "tailscale",
    name: "Tailscale",
    description: "Manage your tailnet",
    install: { command: "npx -y @yawlabs/tailscale-mcp", runtime: "node" },
    requiredEnv: [{ key: "TAILSCALE_API_KEY", label: "Tailscale API key" }],
    repo: "https://github.com/YawLabs/tailscale-mcp",
  },
  {
    slug: "fetch",
    name: "Fetch",
    install: { command: "npx -y @yawlabs/fetch-mcp", runtime: "node" },
    repo: "https://github.com/YawLabs/fetch-mcp",
  },
  {
    slug: "github",
    name: "GitHub",
    install: {
      command: "docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server",
      runtime: "other",
    },
    requiredEnv: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "PAT" }],
  },
  {
    slug: "remote-thing",
    name: "Remote Thing",
    install: { command: "", runtime: "remote", url: "https://example.com/mcp" },
  },
];

const fetchCatalog = async (): Promise<CatalogServer[]> => CATALOG;

describe("deriveNamespace", () => {
  it("passes a simple name through", () => {
    expect(deriveNamespace("github")).toBe("github");
  });
  it("strips ALL non-alphanumerics (no dash->underscore) to match the app", () => {
    expect(deriveNamespace("Brave Search")).toBe("bravesearch");
    expect(deriveNamespace("brave-search")).toBe("bravesearch");
    expect(deriveNamespace("Tailscale")).toBe("tailscale");
  });
  it("prefixes a leading digit with s", () => {
    expect(deriveNamespace("1Password")).toBe("s1password");
  });
  it("caps at 30 chars", () => {
    expect(deriveNamespace("a".repeat(40))).toHaveLength(30);
  });
  it("falls back to 'server' when nothing survives", () => {
    expect(deriveNamespace("---")).toBe("server");
  });
});

describe("parseAddArgs", () => {
  it("rejects empty argv", () => {
    const r = parseAddArgs([]);
    expect(r.ok).toBe(false);
  });
  it("accepts a bare slug", () => {
    const r = parseAddArgs(["github"]);
    expect(r.ok && r.options.slug).toBe("github");
  });
  it("parses --env KEY=value", () => {
    const r = parseAddArgs(["github", "--env", "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_x"]);
    expect(r.ok && r.options.envOverrides?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_x");
  });
  it("rejects malformed --env", () => {
    expect(parseAddArgs(["github", "--env", "nope"]).ok).toBe(false);
  });
  it("rejects unknown flags and extra positionals", () => {
    expect(parseAddArgs(["github", "--bogus"]).ok).toBe(false);
    expect(parseAddArgs(["a", "b"]).ok).toBe(false);
  });
});

describe("runAdd", () => {
  it("adds a no-env server and it loads back", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const ns = loaded.config?.servers.map((s) => s.namespace) ?? [];
    expect(ns).toContain("fetch");
    const entry = loaded.config?.servers.find((s) => s.namespace === "fetch");
    expect(entry?.command).toBe("npx");
    expect(entry?.args).toEqual(["-y", "@yawlabs/fetch-mcp"]);
  });

  it("refuses when a required env var is missing (no write)", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/TAILSCALE_API_KEY/);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config).toBeNull();
  });

  it("writes required env supplied via --env", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { TAILSCALE_API_KEY: "tskey-x" },
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const entry = loaded.config?.servers.find((s) => s.namespace === "tailscale");
    expect(entry?.env?.TAILSCALE_API_KEY).toBe("tskey-x");
  });

  it("tokenizes a docker launch line into command + args", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const entry = loaded.config?.servers.find((s) => s.namespace === "github");
    expect(entry?.command).toBe("docker");
    expect(entry?.args?.[0]).toBe("run");
    expect(entry?.args).toContain("ghcr.io/github/github-mcp-server");
  });

  it("refuses a remote server", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "remote-thing",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/remote/i);
  });

  it("errors on an unknown slug", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "does-not-exist",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/no server with slug/i);
  });

  it("does not write on --dry-run", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "fetch",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config).toBeNull();
  });

  it("--dry-run --json emits the same wrapper shape as a real add --json", async () => {
    const io = captureIO();
    await runAdd({
      slug: "fetch",
      dryRun: true,
      json: true,
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: () => {},
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.namespace).toBe("fetch");
    expect(parsed.entry.command).toBe("npx");
  });

  it("reports replaced on a second add of the same slug", async () => {
    const base = { home: synthHome, cwd: synthCwd, env: {}, fetchCatalog, out: () => {}, err: () => {} };
    await runAdd({ ...base, slug: "fetch" });
    const io = captureIO();
    const r = await runAdd({ ...base, slug: "fetch", out: (s) => io.out.push(s) });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/Updated/);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers.filter((s) => s.namespace === "fetch")).toHaveLength(1);
  });
});

describe("runRemove", () => {
  it("removes an added server by slug", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/Removed/);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers ?? []).toHaveLength(0);
  });

  it("removes by namespace too", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const r = await runRemove({ target: "fetch", home: synthHome, out: () => {}, err: () => {} });
    expect(r.exitCode).toBe(0);
  });

  it("is a no-op (exit 0) when the server is absent", async () => {
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/nothing to do/);
  });

  it("rejects an invalid target", () => {
    expect(parseRemoveArgs([]).ok).toBe(false);
    expect(parseRemoveArgs(["a", "b"]).ok).toBe(false);
  });
});

describe("runList", () => {
  it("shows an empty hint when nothing is configured", async () => {
    const io = captureIO();
    const r = await runList({ home: synthHome, cwd: synthCwd, out: (s) => io.out.push(s), err: (s) => io.err.push(s) });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/No local servers/);
  });

  it("lists added servers", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const io = captureIO();
    const r = await runList({ home: synthHome, cwd: synthCwd, out: (s) => io.out.push(s), err: (s) => io.err.push(s) });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/fetch/);
    expect(io.text()).toMatch(/NAMESPACE/);
  });

  it("emits JSON with --json", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.servers).toHaveLength(1);
    expect(parseListArgs(["--bogus"]).ok).toBe(false);
  });

  // Fix 3: malformed bundles.json -- warnings printed to stderr, not silently dropped
  it("prints load warnings to stderr when bundles.json is malformed (fix 3)", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{ not json");
    const io = captureIO();
    const r = await runList({ home: synthHome, cwd: synthCwd, out: (s) => io.out.push(s), err: (s) => io.err.push(s) });
    expect(r.exitCode).toBe(0);
    // The empty-state hint appears on stdout (same as no-file), but warnings go to stderr.
    expect(io.text()).toMatch(/No local servers/);
    expect(io.errText()).toMatch(/invalid JSON/);
  });

  it("--json includes warnings array when bundles.json is malformed (fix 3)", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{ not json");
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    const parsed = JSON.parse(io.text());
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((w: string) => w.includes("invalid JSON"))).toBe(true);
  });

  it("--json includes empty warnings array on clean load (fix 3)", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    const parsed = JSON.parse(io.text());
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(parsed.warnings).toHaveLength(0);
  });
});

describe("upsertUserBundle round-trip", () => {
  it("refuses to clobber a malformed bundles.json", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{ not json");
    await expect(
      upsertUserBundle({ namespace: "x", name: "X", command: "npx", args: [], isActive: true }, { home: synthHome }),
    ).rejects.toThrow(/malformed/);
  });

  it("dedups a name-matched legacy entry (no second copy) [#1 cross-path]", async () => {
    // A legacy/app entry written under a different namespace but the same name.
    await upsertUserBundle(
      { namespace: "legacy_gh", name: "GitHub", command: "x", args: [], isActive: true },
      { home: synthHome },
    );
    await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    // One GitHub entry total -- matched by name, replaced in place, not duplicated.
    expect(loaded.config?.servers.filter((s) => s.name === "GitHub")).toHaveLength(1);
    expect(loaded.config?.servers).toHaveLength(1);
  });

  it("preserves a newer on-disk schema version on write [#4]", async () => {
    const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 2, servers: [] }));
    await upsertUserBundle(
      { namespace: "github", name: "GitHub", command: "npx", args: [], isActive: true },
      { home: synthHome },
    );
    const written = JSON.parse(readFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "utf8"));
    expect(written.version).toBe(2); // not downgraded to 1
  });
});

describe("runAdd env-at-rest [#3]", () => {
  it("does NOT persist an ambient shell secret; seeds the key empty", async () => {
    // GITHUB_PERSONAL_ACCESS_TOKEN comes from the SHELL (env), not --env.
    await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_shell_secret" },
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const entry = loaded.config?.servers.find((s) => s.namespace === "github");
    // Key is present (seeded) but the ambient secret is NOT written to disk.
    expect(entry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("");
    expect(JSON.stringify(loaded.config)).not.toContain("ghp_shell_secret");
  });

  it("DOES persist a value passed explicitly via --env", async () => {
    await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_explicit" },
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers[0].env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_explicit");
  });
});

describe("runRemove shadowing [#5] + removeUserBundle", () => {
  it("warns when a project-local bundles.json shadows the removal", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    // Add to user-global, then create a shadowing project file under cwd.
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    mkdirSync(join(synthCwd, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthCwd, ".yaw-mcp", "bundles.json"), JSON.stringify({ servers: [] }));
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.errText()).toMatch(/shadows/i);
  });

  it("explains the shadow on a no-op remove when a project file is in effect", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    // A project-local file exists, but the target isn't in user-global.
    mkdirSync(join(synthCwd, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthCwd, ".yaw-mcp", "bundles.json"), JSON.stringify({ servers: [] }));
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/nothing to do/);
    expect(io.errText()).toMatch(/project-local/i);
  });

  it("removeUserBundle is a no-op on a missing namespace", async () => {
    const res = await removeUserBundle("ghost", { home: synthHome });
    expect(res.removed).toBe(false);
  });
});
