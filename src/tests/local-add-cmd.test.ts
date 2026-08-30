import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { parseAddArgs, parseListArgs, parseRemoveArgs, runAdd, runList, runRemove } from "../local-add-cmd.js";
import { deriveNamespace, loadLocalBundles, removeUserBundle, upsertUserBundle } from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";

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

// Realistic catalog shapes: like the live catalog, most slugs' word-form
// matches their name (so deriveNamespace(slug) === deriveNamespace(name)).
// The "ga" row is the live catalog's exception -- its name ("Google
// Analytics") derives to a namespace ("googleanalytics") that shares nothing
// with the slug, which is exactly what the persisted-slug removal path is for.
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
  {
    slug: "ga",
    name: "Google Analytics",
    install: { command: "npx -y @yawlabs/ga-mcp", runtime: "node" },
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
  it("rejects --catalog followed by a flag instead of swallowing --dry-run as the URL", () => {
    const r = parseAddArgs(["github", "--catalog", "--dry-run"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--catalog requires a URL/);
  });
  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseAddArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Usage:");
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseAddArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });
});

describe("parseRemoveArgs (help flag)", () => {
  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseRemoveArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Usage:");
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseRemoveArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });

  // The confirmation-skip flag. --force is `secrets remove`'s spelling, -y /
  // --yes is `trust`'s; remove accepts all three.
  it("accepts --force, --yes and -y as the confirmation-skip flag", () => {
    for (const flag of ["--force", "--yes", "-y"]) {
      const r = parseRemoveArgs(["fetch", flag]);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.options.force).toBe(true);
        expect(r.options.target).toBe("fetch");
      }
    }
  });

  it("leaves force undefined when the flag is absent", () => {
    const r = parseRemoveArgs(["fetch"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.force).toBeUndefined();
  });

  it("rejects a mistyped SHORT flag instead of treating it as the target", () => {
    // Before -y existed only "--" prefixes were checked, so `-f` silently
    // became the removal target. A flag typo must not name a server.
    const r = parseRemoveArgs(["fetch", "-f"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown flag: -f/);
  });

  it("documents the flag in the usage text", () => {
    const r = parseRemoveArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--force/);
  });
});

describe("parseListArgs (help flag)", () => {
  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseListArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Usage:");
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseListArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
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

  it("treats a whitespace-only --env required value as missing (no blank-ish persist)", async () => {
    const io = captureIO();
    const r = await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { TAILSCALE_API_KEY: "   " },
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    // The trimmed required-env gate rejects it the same as a missing value.
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/TAILSCALE_API_KEY/);
    // Nothing whitespace-only was persisted.
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config).toBeNull();
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

  // "Same shape either way" includes the env redaction: the dry-run envelope
  // would otherwise echo the --env value back on stdout while the real add's
  // does not, and the text dry-run above it already prints key names only.
  it("--dry-run --json reduces env to key names too", async () => {
    const io = captureIO();
    await runAdd({
      slug: "tailscale",
      dryRun: true,
      json: true,
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { TAILSCALE_API_KEY: "tskey-typed" },
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: () => {},
    });
    expect(io.text()).not.toContain("tskey-typed");
    const parsed = JSON.parse(io.text());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.entry.env).toBeUndefined();
    expect(parsed.entry.envKeys).toEqual(["TAILSCALE_API_KEY"]);
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

// A re-add rebuilds the entry from the catalog, so it used to overwrite the
// slot wholesale -- silently dropping a persisted --env secret, an explicit
// `"isActive": false`, a per-server runtime override and any hand-added field,
// all under an "Updated ..." success line. upsertUserBundle now folds the new
// entry ONTO the stored one (mergeServerEntry).
describe("runAdd re-add preserves user state", () => {
  const rawFile = async (): Promise<Record<string, unknown>> => {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(join(synthHome, CONFIG_DIRNAME, "bundles.json"), "utf8"));
  };
  const rawServers = async (): Promise<Array<Record<string, unknown>>> =>
    (await rawFile()).servers as Array<Record<string, unknown>>;

  it("keeps a stored --env value when a later add supplies none", async () => {
    const base = { home: synthHome, cwd: synthCwd, fetchCatalog, out: () => {}, err: () => {} };
    await runAdd({ ...base, slug: "tailscale", env: {}, envOverrides: { TAILSCALE_API_KEY: "tskey-stored" } });
    // Second add (e.g. to pick up a catalog command change) with the key only
    // in the SHELL: the required-env gate passes off the ambient value, and the
    // rebuilt entry seeds the key "". That must not blank the stored secret.
    const io = captureIO();
    const r = await runAdd({
      ...base,
      slug: "tailscale",
      env: { TAILSCALE_API_KEY: "tskey-ambient" },
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const entry = loaded.config?.servers.find((s) => s.namespace === "tailscale");
    expect(entry?.env?.TAILSCALE_API_KEY).toBe("tskey-stored");
    // The ambient value is still never copied to disk.
    expect(JSON.stringify(await rawFile())).not.toContain("tskey-ambient");
    // ...and the "read from your shell env and NOT persisted" note must not
    // fire when a value IS persisted -- it would be plainly false.
    expect(io.errText()).not.toMatch(/NOT persisted/);
  });

  it("still lets an explicit --env overwrite the stored value", async () => {
    const base = { home: synthHome, cwd: synthCwd, env: {}, fetchCatalog, out: () => {}, err: () => {} };
    await runAdd({ ...base, slug: "tailscale", envOverrides: { TAILSCALE_API_KEY: "tskey-old" } });
    await runAdd({ ...base, slug: "tailscale", envOverrides: { TAILSCALE_API_KEY: "tskey-new" } });
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers[0].env?.TAILSCALE_API_KEY).toBe("tskey-new");
  });

  it("keeps isActive:false, a runtime override, connectTimeoutMs and unknown fields", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      join(synthHome, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "local-fetch",
            namespace: "fetch",
            name: "Fetch",
            type: "local",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@yawlabs/fetch-mcp@0.1.0"],
            isActive: false,
            runtime: "oam",
            connectTimeoutMs: 60000,
            myOwnNote: "keep me",
          },
        ],
      }),
    );
    const r = await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    expect(r.exitCode).toBe(0);
    const [entry] = await rawServers();
    // What the user set survives...
    expect(entry.isActive).toBe(false);
    expect(entry.runtime).toBe("oam");
    expect(entry.connectTimeoutMs).toBe(60000);
    expect(entry.myOwnNote).toBe("keep me");
    // ...while what the re-add is FOR is refreshed from the catalog.
    expect(entry.args).toEqual(["-y", "@yawlabs/fetch-mcp"]);
  });

  it("says the entry stays disabled instead of telling the user to restart", async () => {
    // Preserving isActive:false (above) makes the usual "Restart your MCP
    // client to pick it up" line actively wrong: a disabled entry never
    // loads, so the user restarts, sees nothing, and has no reason to
    // suspect the file. There is no `enable` verb, so the note must name the
    // edit that turns it on.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(
      join(synthHome, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { id: "local-fetch", namespace: "fetch", name: "Fetch", type: "local", command: "npx", isActive: false },
        ],
      }),
    );
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
    expect(io.text()).toMatch(/stays disabled and will NOT load/);
    expect(io.text()).not.toMatch(/Restart your MCP client/);
  });

  it("still tells the user to restart when the entry is enabled", async () => {
    // Counterweight: the note above must not swallow the normal line, or
    // every ordinary add loses its only next-step instruction.
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
    expect(io.text()).toMatch(/Restart your MCP client/);
    expect(io.text()).not.toMatch(/stays disabled/);
  });

  it("still writes isActive:true on a FRESH add", async () => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    expect((await rawServers())[0].isActive).toBe(true);
  });

  it("--json reports the entry as written, not the pre-merge input", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    // isActive:false and the stale args exist only ON DISK -- the entry runAdd
    // builds carries isActive:true and the catalog's args -- so seeing the
    // former in --json can only come from the post-merge result. Asserted with
    // a NON-env field on purpose: the merged env is redacted (see below), so it
    // can no longer serve as the evidence that the merge was reported.
    writeFileSync(
      join(synthHome, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "local-fetch",
            namespace: "fetch",
            name: "Fetch",
            type: "local",
            transport: "stdio",
            command: "npx",
            args: ["-y", "stale"],
            isActive: false,
          },
        ],
      }),
    );
    const io = captureIO();
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      json: true,
      fetchCatalog,
      out: (s) => io.out.push(s),
      err: () => {},
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.replaced).toBe(true);
    expect(parsed.entry.isActive).toBe(false);
    // ...while what the re-add is FOR is still reported as refreshed.
    expect(parsed.entry.args).toEqual(["-y", "@yawlabs/fetch-mcp"]);
  });

  // The envelope prints the POST-MERGE entry, and the merge folds the stored
  // env back in -- so without redaction a `add --json` run that passes no --env
  // at all republishes a token an earlier run persisted, onto stdout.
  it("--json never puts a stored env VALUE on stdout, only key names", async () => {
    const base = { home: synthHome, cwd: synthCwd, fetchCatalog, out: () => {}, err: () => {} };
    await runAdd({ ...base, slug: "tailscale", env: {}, envOverrides: { TAILSCALE_API_KEY: "tskey-stored" } });
    const io = captureIO();
    await runAdd({
      ...base,
      slug: "tailscale",
      env: { TAILSCALE_API_KEY: "tskey-ambient" },
      json: true,
      out: (s) => io.out.push(s),
    });
    // The stored secret is what the merge folds in; the ambient one reaches the
    // required-env gate. NEITHER may reach stdout.
    expect(io.text()).not.toContain("tskey-stored");
    expect(io.text()).not.toContain("tskey-ambient");
    const parsed = JSON.parse(io.text());
    expect(parsed.replaced).toBe(true);
    // Names only -- and no `env` object that a reader could mistake for the
    // on-disk values (an empty-string value means "not persisted" elsewhere).
    expect(parsed.entry.env).toBeUndefined();
    expect(parsed.entry.envKeys).toEqual(["TAILSCALE_API_KEY"]);
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
      force: true,
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
    const r = await runRemove({ target: "fetch", home: synthHome, force: true, out: () => {}, err: () => {} });
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

// `add` derives the namespace from the catalog display NAME, so a slug whose
// name is an expansion of it ("ga" -> "Google Analytics" -> "googleanalytics")
// produces an entry that neither the literal removal target nor
// deriveNamespace(target) can reach -- `add ga` then `remove ga` used to
// silently no-op at exit 0, leaving the entry (and any stored env value) on
// disk while REMOVE_USAGE promised the slug would work. add now records the
// slug on the entry, and remove maps it back to the namespace.
describe("runRemove maps a recorded catalog slug back to its NAME-derived namespace", () => {
  const addGa = async (): Promise<void> => {
    await runAdd({
      slug: "ga",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
  };
  const rawServers = (): Array<Record<string, unknown>> =>
    (
      JSON.parse(readFileSync(join(synthHome, CONFIG_DIRNAME, "bundles.json"), "utf8")) as {
        servers: Array<Record<string, unknown>>;
      }
    ).servers;

  it("add ga writes namespace googleanalytics and records slug ga on the entry", async () => {
    await addGa();
    const [entry] = rawServers();
    expect(entry.namespace).toBe("googleanalytics");
    expect(entry.slug).toBe("ga");
  });

  it("remove <slug> removes the entry `add <slug>` just wrote", async () => {
    await addGa();
    const io = captureIO();
    const r = await runRemove({
      target: "ga",
      home: synthHome,
      cwd: synthCwd,
      force: true,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/Removed "googleanalytics"/);
    expect(rawServers()).toHaveLength(0);
  });

  it("gates a slug-mapped removal with the same confirmation preview", async () => {
    // The slug-mapped candidate must flow through findRemovalTarget too, or
    // the slug form would delete with no confirmation at all (the same hole
    // the derived-namespace form was tested for).
    await addGa();
    const io = captureIO();
    const r = await runRemove({
      target: "ga",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.text()).toMatch(/namespace: googleanalytics/);
    expect(rawServers()).toHaveLength(1);
  });

  it("removing by the NAMESPACE still works for a slug-recorded entry", async () => {
    await addGa();
    const r = await runRemove({
      target: "googleanalytics",
      home: synthHome,
      cwd: synthCwd,
      force: true,
      out: () => {},
      err: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(rawServers()).toHaveLength(0);
  });
});

// `remove` used to delete the entry with no confirmation, on a TTY or off it --
// the only destructive verb in the CLI without a gate. These lock the gate's
// two halves (confirm on a TTY, refuse off one) AND the no-op behaviour that
// must NOT change, because a cleanup script removing an already-absent server
// still has to exit 0 without a flag.
describe("runRemove confirmation gate", () => {
  const bundlesPath = (): string => join(synthHome, CONFIG_DIRNAME, "bundles.json");
  /** Raw bytes of bundles.json. The declined paths are asserted BYTE-identical,
   *  not merely "still loads" -- a re-serialized file that happens to hold the
   *  same servers would still mean the command wrote when it promised not to. */
  const bytes = (): Buffer => readFileSync(bundlesPath());

  const addFetch = async (): Promise<void> => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
  };

  const namespaces = async (): Promise<string[]> => {
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    return (loaded.config?.servers ?? []).map((s) => s.namespace);
  };

  it("removes on an explicit y / yes", async () => {
    for (const answer of ["y", "Y", "yes", " YES "]) {
      await addFetch();
      const io = captureIO();
      const r = await runRemove({
        target: "fetch",
        home: synthHome,
        cwd: synthCwd,
        promptAnswer: answer,
        out: (s) => io.out.push(s),
        err: (s) => io.err.push(s),
      });
      expect(r.exitCode).toBe(0);
      expect(io.text()).toMatch(/Removed/);
      expect(await namespaces()).not.toContain("fetch");
    }
  });

  it("a declined prompt (and a bare Enter) leaves bundles.json BYTE-identical", async () => {
    await addFetch();
    // "" is the bare Enter -- the default must be NO, not yes.
    for (const answer of ["", "n", "N", "no", "maybe", "Y E S"]) {
      const before = bytes();
      const io = captureIO();
      const r = await runRemove({
        target: "fetch",
        home: synthHome,
        cwd: synthCwd,
        promptAnswer: answer,
        out: (s) => io.out.push(s),
        err: (s) => io.err.push(s),
      });
      expect(r.exitCode).toBe(1);
      expect(io.errText()).toMatch(/Aborted/);
      expect(r.written).toEqual([]);
      expect(bytes().equals(before)).toBe(true);
    }
    expect(await namespaces()).toContain("fetch");
  });

  it("refuses off a TTY without the flag and leaves bundles.json BYTE-identical", async () => {
    await addFetch();
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(2);
    expect(io.errText()).toMatch(/not a TTY/);
    // The refusal must NAME the flag to re-run with, or it is a dead end.
    expect(io.errText()).toMatch(/--force/);
    expect(bytes().equals(before)).toBe(true);
    // It still SHOWED what it would have removed before refusing.
    expect(io.text()).toMatch(/namespace: fetch/);
  });

  it("removes off a TTY WITH --force", async () => {
    await addFetch();
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      force: true,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/Removed/);
    expect(await namespaces()).not.toContain("fetch");
    // --force skips the PROMPT, so it must not print the review block.
    expect(io.text()).not.toMatch(/namespace: fetch/);
  });

  it("the preview names the namespace, the display name and the launch command", async () => {
    await addFetch();
    const io = captureIO();
    await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: () => {},
    });
    const shown = io.text();
    expect(shown).toMatch(/namespace: fetch/);
    expect(shown).toMatch(/name:\s+Fetch/);
    // The user must see WHICH server they are dropping, not just a slug.
    expect(shown).toContain("$ npx -y @yawlabs/fetch-mcp");
    expect(shown).toContain(bundlesPath());
  });

  it("the preview lists env KEY names but never their values", async () => {
    await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { TAILSCALE_API_KEY: "tskey-super-secret" },
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
    const io = captureIO();
    await runRemove({
      target: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: () => {},
    });
    expect(io.text()).toMatch(/env keys:\s+TAILSCALE_API_KEY/);
    expect(io.text()).not.toContain("tskey-super-secret");
  });

  it("renders the url for a remote-shaped entry instead of an empty command", async () => {
    await upsertUserBundle(
      { namespace: "remotey", name: "Remote Thing", type: "remote", url: "https://example.test/mcp", isActive: true },
      { home: synthHome },
    );
    const io = captureIO();
    await runRemove({
      target: "remotey",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: () => {},
    });
    expect(io.text()).toContain("HTTP https://example.test/mcp");
  });

  it("gates a removal reached by the DERIVED namespace (slug form), not just a literal match", async () => {
    // deriveNamespace("brave-search") === "bravesearch": the second candidate.
    // If the gate only checked the literal target, the slug form would delete
    // with no confirmation at all.
    await upsertUserBundle(
      { namespace: "bravesearch", name: "Brave Search", command: "npx", args: ["-y", "pkg"], isActive: true },
      { home: synthHome },
    );
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "brave-search",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.text()).toMatch(/namespace: bravesearch/);
    expect(bytes().equals(before)).toBe(true);
  });

  it("gates an entry validateEntry would DROP but removeUserBundle would still delete", async () => {
    // The lookup runs on the RAW servers for exactly this case: an entry the
    // loader rejects (no command / no url) is invisible to a validated preview,
    // yet removeUserBundle filters by namespace string and would delete it. A
    // validated lookup would let it through the gate unconfirmed.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(bundlesPath(), JSON.stringify({ version: 1, servers: [{ namespace: "broken", name: "Broken" }] }));
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "broken",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(2);
    expect(bytes().equals(before)).toBe(true);
  });

  // The gate parses with parseJsonc -- the SAME parser the write path uses.
  // Under a stricter JSON.parse a single hand-added `//` line made the lookup
  // return "nothing to remove" while removeUserBundle parsed the file fine and
  // deleted the entry (and its stored secret) with no preview, no refusal and
  // no prompt. Comments + trailing commas are expected input here: the module
  // header documents that the READER accepts them.
  const JSONC_BUNDLES = `{
  // prod token lives in 1Password
  "version": 1,
  "servers": [
    {
      "namespace": "tailscale",
      "name": "Tailscale",
      "command": "npx",
      "args": ["-y", "@yawlabs/tailscale-mcp"],
      "env": { "TAILSCALE_API_KEY": "tskey-super-secret" },
    },
  ],
}
`;

  const writeJsoncBundles = async (): Promise<void> => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(bundlesPath(), JSONC_BUNDLES);
  };

  it("gates a JSONC bundles.json off a TTY instead of deleting it unconfirmed", async () => {
    await writeJsoncBundles();
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(2);
    expect(io.errText()).toMatch(/not a TTY/);
    expect(io.text()).toMatch(/namespace: tailscale/);
    // The preview renders from the JSONC file, keys only -- never the value.
    expect(io.text()).toMatch(/env keys:\s+TAILSCALE_API_KEY/);
    expect(io.text()).not.toContain("tskey-super-secret");
    expect(bytes().equals(before)).toBe(true);
  });

  it("prompts on a JSONC bundles.json, and a decline leaves it BYTE-identical", async () => {
    await writeJsoncBundles();
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      promptAnswer: "n",
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/Aborted/);
    expect(bytes().equals(before)).toBe(true);
  });

  // ----- what must NOT change: the no-op path stays ungated ----------------

  it("still no-ops at exit 0 off a TTY when the target is absent (unchanged behaviour)", async () => {
    await addFetch();
    const before = bytes();
    const io = captureIO();
    const r = await runRemove({
      target: "does-not-exist",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/nothing to do/);
    expect(io.errText()).not.toMatch(/not a TTY/);
    expect(bytes().equals(before)).toBe(true);
  });

  it("still no-ops at exit 0 off a TTY when there is no bundles.json at all", async () => {
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.text()).toMatch(/nothing to do/);
  });

  it("still reports a malformed bundles.json as an error rather than a silent no-op", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(bundlesPath(), "{ not json");
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      isTTY: false,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    // An unparseable file is "uncertain", so the gate steps aside and the write
    // path reports it -- the pre-existing exit 1 + message, not a bogus refusal.
    expect(r.exitCode).toBe(1);
    expect(io.errText()).toMatch(/could not be parsed/);
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

  // Same posture as `add --json` (jsonEntry): bundles.json entries can carry
  // `--env` secrets, and `list --json` gets piped into CI logs and bug
  // reports -- a stored value must never reach stdout, only the key names.
  it("--json never prints stored env VALUES, only envKeys names", async () => {
    await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      envOverrides: { TAILSCALE_API_KEY: "tskey-REALSECRET-123" },
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
    expect(io.text()).not.toContain("tskey-REALSECRET-123");
    const parsed = JSON.parse(io.text());
    expect(parsed.servers[0].env).toBeUndefined();
    expect(parsed.servers[0].envKeys).toEqual(["TAILSCALE_API_KEY"]);
  });

  // A required key with no --env value is seeded "" on disk ("required, nothing
  // stored"), and the loader's validateEntry DROPS blank values before spawn.
  // envKeys derived from the validated entry therefore silently lost exactly
  // the required-env documentation `add --json` reports; `list --json` must
  // read the RAW on-disk entry (keys only) so the two machine surfaces agree
  // (LIST_USAGE: "same posture as `add --json`").
  it("--json keeps a required key seeded empty by add in envKeys, matching add --json", async () => {
    const addIo = captureIO();
    await runAdd({
      slug: "tailscale",
      home: synthHome,
      cwd: synthCwd,
      // Required key satisfied from the ambient shell, NOT --env: add seeds
      // the on-disk value as "" and persists nothing.
      env: { TAILSCALE_API_KEY: "tskey-ambient-only" },
      json: true,
      fetchCatalog,
      out: (s) => addIo.out.push(s),
      err: (s) => addIo.err.push(s),
    });
    const added = JSON.parse(addIo.text());
    expect(added.entry.envKeys).toEqual(["TAILSCALE_API_KEY"]);

    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    const parsed = JSON.parse(io.text());
    // The seeded key shows up in list --json exactly as it does in add --json...
    expect(parsed.servers[0].envKeys).toEqual(["TAILSCALE_API_KEY"]);
    // ...and stays keys-only: no env object, no ambient value on stdout.
    expect(parsed.servers[0].env).toBeUndefined();
    expect(io.text()).not.toContain("tskey-ambient-only");
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

  // Compliance-grade overlay. `yaw-mcp audit` writes ~/.yaw-mcp/grades.json and
  // `list` is its only reader in local mode -- without these, grading is
  // write-only and a regression here is invisible.
  const addFetch = async (): Promise<void> => {
    await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: () => {},
    });
  };

  it("overlays a cached compliance grade onto the server row (json)", async () => {
    await addFetch();
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
      gradesReader: async () => ({ fetch: { grade: "A", score: 100, gradedAt: "2026-06-11T00:00:00.000Z" } }),
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.servers[0].namespace).toBe("fetch");
    expect(parsed.servers[0].complianceGrade).toBe("A");
    // The audit timestamp rides along as the staleness signal; this legacy
    // entry has no suiteVersion, so the field stays absent rather than "".
    expect(parsed.servers[0].complianceGradedAt).toBe("2026-06-11T00:00:00.000Z");
    expect(parsed.servers[0].complianceSuiteVersion).toBeUndefined();
  });

  it("emits complianceSuiteVersion when the cache entry carries one (json)", async () => {
    await addFetch();
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
      gradesReader: async () => ({
        fetch: { grade: "A", score: 100, gradedAt: "2026-08-23T00:00:00.000Z", suiteVersion: "0.17.1" },
      }),
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.servers[0].complianceGrade).toBe("A");
    expect(parsed.servers[0].complianceSuiteVersion).toBe("0.17.1");
  });

  it("leaves a never-audited server ungraded in json", async () => {
    await addFetch();
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
      gradesReader: async () => ({ somethingelse: { grade: "A", score: 100, gradedAt: "t" } }),
    });
    const parsed = JSON.parse(io.text());
    expect(parsed.servers[0].complianceGrade).toBeUndefined();
    expect(parsed.servers[0].complianceGradedAt).toBeUndefined();
  });

  it("renders the cached grade in the GRADE column", async () => {
    await addFetch();
    const io = captureIO();
    await runList({
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
      gradesReader: async () => ({ fetch: { grade: "B", score: 80, gradedAt: "t" } }),
    });
    expect(io.text()).toMatch(/GRADE/);
    expect(io.text()).toMatch(/fetch\s+Fetch\s+active\s+B\s/);
  });

  it("shows `-` in the GRADE column for a never-audited server", async () => {
    await addFetch();
    const io = captureIO();
    await runList({
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
      gradesReader: async () => ({}),
    });
    expect(io.text()).toMatch(/fetch\s+Fetch\s+active\s+-\s/);
  });

  it("reads the real grades.json when no reader override is supplied", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    await addFetch();
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(synthHome, ".yaw-mcp", "grades.json"),
      JSON.stringify({ fetch: { grade: "C", score: 71, gradedAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const io = captureIO();
    await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(JSON.parse(io.text()).servers[0].complianceGrade).toBe("C");
  });

  it("degrades to no overlay when grades.json is garbage", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    await addFetch();
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "grades.json"), "{ not json");
    const io = captureIO();
    const r = await runList({
      json: true,
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(io.text()).servers[0].complianceGrade).toBeUndefined();
  });
});

describe("upsertUserBundle round-trip", () => {
  it("refuses to clobber a malformed bundles.json", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(synthHome, ".yaw-mcp", "bundles.json"), "{ not json");
    await expect(
      upsertUserBundle({ namespace: "x", name: "X", command: "npx", args: [], isActive: true }, { home: synthHome }),
    ).rejects.toThrow(/could not be parsed/);
  });

  it("dedups a name-matched legacy entry (no second copy) and KEEPS its namespace [#1 cross-path]", async () => {
    // A legacy/app entry written under a different namespace but the same name.
    await upsertUserBundle(
      { namespace: "legacy_gh", name: "GitHub", command: "x", args: [], isActive: true },
      { home: synthHome },
    );
    const outLines: string[] = [];
    const errLines: string[] = [];
    await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      fetchCatalog,
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
    });
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    // One GitHub entry total -- matched by name, replaced in place, not duplicated.
    expect(loaded.config?.servers.filter((s) => s.name === "GitHub")).toHaveLength(1);
    expect(loaded.config?.servers).toHaveLength(1);
    // The stored namespace SURVIVES the merge ("never rename out from under
    // the user"): config allow/deny lists, grades.json and vault refs are
    // keyed by namespace, and the old single-pass merge silently renamed it
    // to the catalog-derived "github", detaching all three. The success line
    // must say which namespace the file actually holds.
    expect(loaded.config?.servers[0]?.namespace).toBe("legacy_gh");
    expect(outLines.join("")).toContain('kept existing namespace "legacy_gh"');
    // A name-ONLY match is the weaker identity signal, so the launch swap
    // (x -> docker run ...) must be reported here just like on the
    // namespace-match path -- the note was originally computed only there.
    const errText = errLines.join("");
    expect(errText).toContain("launch command changed");
    expect(errText).toContain("from: x");
    expect(errText).toContain("docker run");
  });

  it("namespace match wins over an earlier name match (two-pass lookup) [#1]", async () => {
    // Seed BOTH: an entry that matches the incoming NAME (legacy_gh /
    // "GitHub") sitting EARLIER in the array than the exact namespace
    // match. The single-pass `namespace || name` findIndex let the earlier
    // name match hijack the merge, rename legacy_gh to "github", and leave
    // the file with two entries sharing one namespace.
    await upsertUserBundle(
      { namespace: "legacy_gh", name: "GitHub", command: "x", args: [], isActive: true },
      { home: synthHome },
    );
    await upsertUserBundle(
      { namespace: "github", name: "GitHub Enterprise", command: "y", args: [], isActive: true },
      { home: synthHome },
    );
    await upsertUserBundle(
      { namespace: "github", name: "GitHub", command: "npx", args: ["-y", "@x/gh"], isActive: true },
      { home: synthHome },
    );
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const namespaces = (loaded.config?.servers ?? []).map((s) => s.namespace);
    // Two entries, distinct namespaces -- the exact namespace match was
    // updated; the name-matched legacy entry was left alone.
    expect(namespaces.sort()).toEqual(["github", "legacy_gh"]);
    const gh = loaded.config?.servers.find((s) => s.namespace === "github");
    expect(gh?.command).toBe("npx");
    const legacy = loaded.config?.servers.find((s) => s.namespace === "legacy_gh");
    expect(legacy?.command).toBe("x");
  });

  it("REFUSES a namespace collision between two different catalog slugs [#1]", async () => {
    // The live catalog really carries this pair: slugs "redis" and
    // "redis-yawlabs" both display as "Redis" and both derive namespace
    // "redis". Merging silently swapped the launch command AND overwrote
    // the stored slug -- after which `yaw-mcp remove redis-yawlabs` was an
    // exit-0 no-op. The app refuses; so does the CLI now.
    const { readFileSync } = await import("node:fs");
    await upsertUserBundle(
      {
        namespace: "redis",
        name: "Redis",
        slug: "redis-yawlabs",
        command: "npx",
        args: ["-y", "@yawlabs/redis-mcp@latest"],
        isActive: true,
      } as Parameters<typeof upsertUserBundle>[0],
      { home: synthHome },
    );
    const bundlesPath = join(synthHome, ".yaw-mcp", "bundles.json");
    const before = readFileSync(bundlesPath, "utf8");
    await expect(
      upsertUserBundle(
        {
          namespace: "redis",
          name: "Redis",
          slug: "redis",
          command: "uvx",
          args: ["--from", "redis-mcp-server@latest", "redis-mcp-server"],
          isActive: true,
        } as Parameters<typeof upsertUserBundle>[0],
        { home: synthHome },
      ),
    ).rejects.toThrow(/already used by "Redis" \(added as "redis-yawlabs"\)/);
    // Nothing was written over the existing entry.
    expect(readFileSync(bundlesPath, "utf8")).toBe(before);
  });

  it("a slug-less namespace match merges but reports the launch swap LOUDLY [#1]", async () => {
    // Entries written by the Yaw Terminal app (and by pre-0.76 CLIs) carry
    // no `slug`, so "same server whose catalog row drifted" and "different
    // server with the same display name" are indistinguishable. The merge
    // proceeds (refusing would break re-add-to-refresh, and there is no
    // stored slug for `remove` to orphan) -- but a changed launch command
    // must be reported, never silent.
    await upsertUserBundle(
      // App-shaped: no slug field at all.
      { namespace: "fetch", name: "Fetch", command: "docker", args: ["run", "old/fetch"], isActive: true },
      { home: synthHome },
    );
    const errLines: string[] = [];
    const r = await runAdd({
      slug: "fetch",
      home: synthHome,
      cwd: synthCwd,
      env: {},
      fetchCatalog,
      out: () => {},
      err: (s) => errLines.push(s),
    });
    expect(r.exitCode).toBe(0);
    const errText = errLines.join("");
    expect(errText).toContain("launch command changed");
    expect(errText).toContain("docker run old/fetch");
    expect(errText).toContain("npx -y @yawlabs/fetch-mcp");
    // Merged: refreshed launch + slug stamped, remove-by-namespace intact.
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(loaded.config?.servers[0]?.command).toBe("npx");
  });

  it("a slug-less namespace match with the SAME launch merges quietly and gains the slug [#1]", async () => {
    await upsertUserBundle(
      { namespace: "fetch", name: "Fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp"], isActive: true },
      { home: synthHome },
    );
    const res = await upsertUserBundle(
      {
        namespace: "fetch",
        name: "Fetch",
        slug: "fetch",
        command: "npx",
        args: ["-y", "@yawlabs/fetch-mcp"],
        isActive: true,
      } as Parameters<typeof upsertUserBundle>[0],
      { home: synthHome },
    );
    expect(res.replaced).toBe(true);
    expect(res.launchChanged).toBeUndefined();
    expect((res.entry as { slug?: string }).slug).toBe("fetch");
  });

  it("add --dry-run predicts the collision refusal (exit 1, nothing written) [#1]", async () => {
    // The preview must describe the run it previews: a dry-run that says
    // 'would write' with exit 0 while the real run refuses with exit 1 is
    // the same preview-contradicts-run class install's --skip --dry-run had.
    const { readFileSync } = await import("node:fs");
    await upsertUserBundle(
      {
        namespace: "github",
        name: "GitHub",
        slug: "github-enterprise",
        command: "other",
        args: [],
        isActive: true,
      } as Parameters<typeof upsertUserBundle>[0],
      { home: synthHome },
    );
    const bundlesPath = join(synthHome, ".yaw-mcp", "bundles.json");
    const before = readFileSync(bundlesPath, "utf8");
    const errLines: string[] = [];
    const r = await runAdd({
      slug: "github",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      fetchCatalog,
      out: () => {},
      err: (s) => errLines.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(errLines.join("")).toContain("would refuse");
    expect(errLines.join("")).toContain('added as "github-enterprise"');
    expect(readFileSync(bundlesPath, "utf8")).toBe(before);
  });

  it("add --dry-run --json refuses on the SAME channel and shape as the real --json run [#1]", async () => {
    // Both must exit 1 with text on stderr and NOTHING on stdout: a
    // {ok:false} JSON body on the dry-run's stdout would be the one place
    // the preview's channel differed from the run it previews (every other
    // add error, --json or not, is stderr text).
    await upsertUserBundle(
      {
        namespace: "github",
        name: "GitHub",
        slug: "github-enterprise",
        command: "other",
        args: [],
        isActive: true,
      } as Parameters<typeof upsertUserBundle>[0],
      { home: synthHome },
    );
    const run = async (dryRun: boolean) => {
      const out: string[] = [];
      const err: string[] = [];
      const r = await runAdd({
        slug: "github",
        json: true,
        dryRun,
        home: synthHome,
        cwd: synthCwd,
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
        fetchCatalog,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
      });
      return { exitCode: r.exitCode, out: out.join(""), err: err.join("") };
    };
    const preview = await run(true);
    const real = await run(false);
    expect(preview.exitCode).toBe(1);
    expect(real.exitCode).toBe(1);
    expect(preview.out).toBe("");
    expect(real.out).toBe("");
    expect(preview.err).toContain('added as "github-enterprise"');
    expect(real.err).toContain('added as "github-enterprise"');
  });

  it("add --dry-run predicts the KEPT namespace for a name-matched legacy entry [#1]", async () => {
    await upsertUserBundle(
      { namespace: "legacy_gh", name: "GitHub", command: "x", args: [], isActive: true },
      { home: synthHome },
    );
    const outLines: string[] = [];
    const r = await runAdd({
      slug: "github",
      dryRun: true,
      json: true,
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      fetchCatalog,
      out: (s) => outLines.push(s),
      err: () => {},
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(outLines.join(""));
    // The real run keeps legacy_gh; the preview must say so, not "github".
    expect(parsed.namespace).toBe("legacy_gh");
    expect(parsed.dryRun).toBe(true);
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
  it("does NOT persist an ambient shell secret; seeds the key empty + warns", async () => {
    // GITHUB_PERSONAL_ACCESS_TOKEN comes from the SHELL (env), not --env.
    const errLines: string[] = [];
    await runAdd({
      slug: "github",
      home: synthHome,
      cwd: synthCwd,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_shell_secret" },
      fetchCatalog,
      out: () => {},
      err: (s) => errLines.push(s),
    });
    // The key is seeded EMPTY on disk (documenting the requirement) but the
    // ambient secret is NOT written.
    const raw = JSON.parse(readFileSync(join(synthHome, CONFIG_DIRNAME, "bundles.json"), "utf8")) as {
      servers: Array<Record<string, unknown>>;
    };
    expect((raw.servers[0].env as Record<string, string>).GITHUB_PERSONAL_ACCESS_TOKEN).toBe("");
    expect(JSON.stringify(raw)).not.toContain("ghp_shell_secret");
    // ...and the LOADER drops the empty seed: the spawn env is
    // { ...parentEnv, ...serverEnv } (upstream.ts), so a loaded "" would
    // clobber the ambient shell value the note above says the server relies
    // on -- the server would start with the var blanked.
    const loaded = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const entry = loaded.config?.servers.find((s) => s.namespace === "github");
    expect(entry?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(JSON.stringify(loaded.config)).not.toContain("ghp_shell_secret");
    // A note warns that the ambient var is not persisted and is needed at launch.
    const note = errLines.join("\n");
    expect(note).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(note).toMatch(/NOT persisted/);
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

/** Write a project-local bundles.json and approve it via the consent store,
 *  so it actually shadows the user-global file. An UNAPPROVED project file is
 *  ignored by the loader (src/trust.ts), and findShadowingProjectBundles is
 *  trust-aware for exactly that reason -- warning about a file yaw-mcp is
 *  ignoring would send the user off to edit the wrong thing. */
async function writeTrustedProjectBundles(content: unknown): Promise<void> {
  const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
  const { grantTrust } = await import("../trust.js");
  mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
  const path = join(synthCwd, CONFIG_DIRNAME, "bundles.json");
  writeFileSync(path, JSON.stringify(content));
  await grantTrust(path, readFileSync(path), { home: synthHome });
}

describe("runRemove shadowing [#5] + removeUserBundle", () => {
  it("warns when an approved project-local bundles.json shadows the removal", async () => {
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
    await writeTrustedProjectBundles({ servers: [] });
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      force: true,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.errText()).toMatch(/shadows/i);
  });

  it("explains the shadow on a no-op remove when an approved project file is in effect", async () => {
    // A project-local file exists and is approved, but the target isn't in
    // user-global.
    await writeTrustedProjectBundles({ servers: [] });
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

  it("stays quiet about an UNAPPROVED project file (it shadows nothing)", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(join(synthCwd, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ servers: [] }));
    const io = captureIO();
    const r = await runRemove({
      target: "fetch",
      home: synthHome,
      cwd: synthCwd,
      out: (s) => io.out.push(s),
      err: (s) => io.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(io.errText()).not.toMatch(/project-local/i);
  });

  it("removeUserBundle is a no-op on a missing namespace", async () => {
    const res = await removeUserBundle("ghost", { home: synthHome });
    expect(res.removed).toBe(false);
  });
});
