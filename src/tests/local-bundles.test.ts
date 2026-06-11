import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLES_FILENAME,
  loadLocalBundles,
  localBundlesPath,
  removeUserBundle,
  upsertUserBundle,
} from "../local-bundles.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-"));
  // synthCwd lives INSIDE synthHome so findProjectConfigDir's walk-up stops at
  // the synthetic home boundary and never reaches the real ~/.yaw-mcp/ on the
  // developer's machine -- matching the isolation pattern in config-loader.test.ts.
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function writeBundles(dir: string, content: unknown) {
  mkdirSync(join(dir, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(localBundlesPath(join(dir, CONFIG_DIRNAME)), JSON.stringify(content));
}

describe("localBundlesPath", () => {
  it("joins dir with the canonical filename", () => {
    expect(localBundlesPath("/some/dir")).toBe(join("/some/dir", BUNDLES_FILENAME));
  });
});

describe("loadLocalBundles", () => {
  it("returns null config when neither user-global nor project file exists", async () => {
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.path).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("loads from user-global ~/.yaw-mcp/bundles.json", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "github", name: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0]).toMatchObject({
      id: "local-github",
      namespace: "github",
      name: "GitHub",
      type: "local",
      command: "npx",
      isActive: true,
    });
  });

  it("loads from project-local <cwd>/.yaw-mcp/bundles.json", async () => {
    writeBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "slack", name: "Slack", command: "uvx", args: ["mcp-server-slack"] }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0].namespace).toBe("slack");
  });

  it("project-local wins entirely over user-global (no merge)", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub-Global", command: "npx" }],
    });
    writeBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "slack", name: "Slack-Project", command: "uvx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0].namespace).toBe("slack");
    expect(r.config?.servers[0].name).toBe("Slack-Project");
  });

  it("skips entries with missing or invalid namespace", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "github", name: "GitHub", command: "npx" },
        { name: "no-namespace", command: "npx" },
        { namespace: "BAD-CASE", name: "bad case", command: "npx" },
        { namespace: "999starts-with-digit", name: "bad", command: "npx" },
        { namespace: "ok_under_30_chars_allowed", name: "ok", command: "npx" },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["github", "ok_under_30_chars_allowed"]);
    expect(r.warnings.length).toBe(3);
  });

  it("synthesizes id when entry omits it", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "linear", name: "Linear", command: "npx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].id).toBe("local-linear");
  });

  it("preserves explicit id when present", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ id: "my-custom-id", namespace: "linear", name: "Linear", command: "npx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].id).toBe("my-custom-id");
  });

  it("defaults type to 'local' but accepts explicit 'remote'", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "a", name: "A", command: "npx" },
        { namespace: "b", name: "B", type: "remote", url: "https://example.com/mcp" },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].type).toBe("local");
    expect(r.config?.servers[1].type).toBe("remote");
  });

  it("defaults isActive=true; explicit false respected", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "a", name: "A", command: "npx" },
        { namespace: "b", name: "B", command: "npx", isActive: false },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].isActive).toBe(true);
    expect(r.config?.servers[1].isActive).toBe(false);
  });

  it("filters env to string values only", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        {
          namespace: "github",
          name: "GitHub",
          command: "npx",
          env: { GITHUB_TOKEN: "ghp_abc", BAD: 123 as unknown as string, OK: "yes" },
        },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].env).toEqual({ GITHUB_TOKEN: "ghp_abc", OK: "yes" });
  });

  it("warns on schema version newer than supported", async () => {
    writeBundles(synthHome, { version: 999, servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.warnings.some((w) => w.includes("schema version 999"))).toBe(true);
    expect(r.config?.servers).toEqual([]);
  });

  it("returns null when file is not valid JSON", async () => {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), "{not json");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("returns null when root is an array, not an object", async () => {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), JSON.stringify([{ namespace: "x" }]));
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("root must be a JSON object"))).toBe(true);
  });

  it("returns null when servers is not an array", async () => {
    writeBundles(synthHome, { version: 1, servers: "not an array" });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("'servers' must be an array"))).toBe(true);
  });

  it("produces a deterministic configVersion derived from content", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub", command: "npx" }],
    });
    const r1 = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const r2 = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r1.config?.configVersion).toEqual(r2.config?.configVersion);
    expect(r1.config?.configVersion).toMatch(/^local-/);
  });

  it("project file with invalid JSON does NOT fall through to global", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub-Global", command: "npx" }],
    });
    mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthCwd, CONFIG_DIRNAME)), "{not json");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });
});

// Fix 1: readBundlesAt -- ENOENT/EISDIR -> exists:false; other errors -> exists:true
describe("readBundlesAt error discrimination (fix 1)", () => {
  it.skipIf(process.platform === "win32")(
    "EPERM/EACCES on project file does NOT fall through to user-global",
    async () => {
      // Write a valid user-global so a fallthrough would succeed.
      writeBundles(synthHome, {
        version: 1,
        servers: [{ namespace: "global", name: "Global", command: "npx" }],
      });
      // Write a valid project file, then revoke all permissions on it.
      writeBundles(synthCwd, {
        version: 1,
        servers: [{ namespace: "project", name: "Project", command: "npx" }],
      });
      const projectBundlesPath = localBundlesPath(join(synthCwd, CONFIG_DIRNAME));
      chmodSync(projectBundlesPath, 0o000);
      try {
        const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
        // exists:true committed to project path -- config is null (unreadable),
        // but the global file must NOT have been loaded.
        expect(r.config).toBeNull();
        expect(r.config?.servers?.some((s) => s.namespace === "global")).toBeFalsy();
        // A warning must be present for the unreadable file.
        expect(r.warnings.some((w) => w.includes("could not read"))).toBe(true);
      } finally {
        // Restore perms so afterEach rmSync can clean up.
        chmodSync(projectBundlesPath, 0o644);
      }
    },
  );

  it("ENOENT (no file) still returns exists:false and falls through to global", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "global", name: "Global", command: "npx" }],
    });
    // No project bundles.json -- pure fallthrough expected.
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].namespace).toBe("global");
    expect(r.warnings).toHaveLength(0);
  });
});

// Fix 2: bundleWriteChain serializer -- concurrent calls must not lose writes
describe("upsertUserBundle / removeUserBundle serializer (fix 2)", () => {
  it("concurrent upserts do not lose any entry", async () => {
    const namespaces = ["aaa", "bbb", "ccc", "ddd", "eee"];
    // Fan out all writes without awaiting between them.
    await Promise.all(
      namespaces.map((ns) =>
        upsertUserBundle(
          { namespace: ns, name: ns.toUpperCase(), command: "npx", args: [], isActive: true },
          { home: synthHome },
        ),
      ),
    );
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const writtenNs = (r.config?.servers ?? []).map((s) => s.namespace).sort();
    expect(writtenNs).toEqual([...namespaces].sort());
  });

  it("interleaved upsert then remove serializes correctly", async () => {
    // Add three servers concurrently, then remove one concurrently with an add.
    await Promise.all([
      upsertUserBundle(
        { namespace: "alpha", name: "Alpha", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
      upsertUserBundle(
        { namespace: "beta", name: "Beta", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
      upsertUserBundle(
        { namespace: "gamma", name: "Gamma", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ]);
    // Now concurrently remove beta and add delta.
    await Promise.all([
      removeUserBundle("beta", { home: synthHome }),
      upsertUserBundle(
        { namespace: "delta", name: "Delta", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ]);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const writtenNs = (r.config?.servers ?? []).map((s) => s.namespace).sort();
    expect(writtenNs).toContain("alpha");
    expect(writtenNs).toContain("gamma");
    expect(writtenNs).toContain("delta");
    expect(writtenNs).not.toContain("beta");
  });
});
