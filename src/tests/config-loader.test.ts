import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  CURRENT_SCHEMA_VERSION,
  isAllowed,
  LOCAL_CONFIG_FILENAME,
  loadYawMcpConfig,
  type Profile,
  profileAllows,
  toProfile,
} from "../config-loader.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-cfg-home-"));
  // synthCwd lives INSIDE synthHome so walk-up terminates at the
  // synthetic home boundary rather than escaping past tmpdir into the
  // real user dir — where a real ~/.yaw-mcp/ on dev machines would
  // otherwise get claimed as the project config and leak into assertions.
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

// Writes <root>/.yaw-mcp/<filename> with the given JSON object.
function writeConfig(root: string, filename: string, obj: unknown): string {
  const dir = join(root, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function writeConfigRaw(root: string, filename: string, body: string): string {
  const dir = join(root, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body);
  return p;
}

describe("loadYawMcpConfig — defaults", () => {
  it("returns defaults when no files exist", async () => {
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.loadedFiles).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.projectConfigDir).toBeNull();
    expect(r.servers).toBeUndefined();
    expect(r.blocked).toBeUndefined();
  });
});

// `token` / `apiBase` used to drive the hosted backend. They are now inert,
// but the deprecation is SOFT: an existing config carrying either key must
// still load (allow/deny lists and installNudge intact) and must surface a
// warning telling the user to delete the key and revoke the PAT.
describe("loadYawMcpConfig — deprecated token / apiBase keys", () => {
  it("still loads a config carrying a token, and warns instead of failing", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, {
      version: 1,
      token: "mcp_pat_global_aaaa",
      servers: ["github"],
      blocked: ["slack"],
      installNudge: true,
    });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });

    // The file loaded: every non-deprecated field survived.
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
    expect(r.servers).toEqual(["github"]);
    expect(r.blocked).toEqual(["slack"]);
    expect(r.installNudge).toBe(true);

    const w = r.warnings.find((x) => x.includes("'token'"));
    expect(w).toBeDefined();
    // Says what changed, where to fix it, and to revoke the PAT.
    expect(w).toMatch(/no longer used/);
    expect(w).toMatch(/local-only/);
    expect(w).toContain(join(synthHome, CONFIG_DIRNAME, CONFIG_FILENAME));
    expect(w).toMatch(/[Rr]evoke that PAT/);
  });

  it("warns for apiBase, without the PAT-revocation clause", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { apiBase: "https://corp.example" });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    const w = r.warnings.find((x) => x.includes("'apiBase'"));
    expect(w).toBeDefined();
    expect(w).toMatch(/no longer used/);
    expect(w).not.toMatch(/PAT/);
  });

  it("folds both keys into a single warning", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_aaaa", apiBase: "https://corp.example" });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("'token' and 'apiBase'");
    expect(r.warnings[0]).toMatch(/[Rr]evoke that PAT/);
  });

  it("warns per file, so every scope holding a stale key gets named", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_global_aaaa" });
    writeConfig(synthCwd, CONFIG_FILENAME, { apiBase: "https://project.example" });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes(join(synthHome, CONFIG_DIRNAME)))).toBe(true);
    expect(r.warnings.some((w) => w.includes(join(synthCwd, CONFIG_DIRNAME)))).toBe(true);
  });

  it("warns on key PRESENCE, not on a usable value (an empty token still needs deleting)", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "" });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings.some((w) => w.includes("'token'"))).toBe(true);
  });

  it("does not warn for a config with no deprecated keys", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: 1, servers: ["github"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
  });

  // A plaintext, non-loopback apiBase used to be rejected by validateApiBase.
  // It is now just another deprecated key: no URL validation, no throw --
  // nothing dials it. The env override (YAW_MCP_URL) is likewise inert; it
  // must not throw either, since nothing reads it any more.
  it("never throws on an unusable apiBase, from a file or from the env", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { apiBase: "not a url at all" });
    const fromFile = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(fromFile.warnings.some((w) => w.includes("'apiBase'"))).toBe(true);

    await expect(
      loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: { YAW_MCP_URL: "http://example.com" } }),
    ).resolves.toBeDefined();
  });
});

describe("loadYawMcpConfig — JSONC support", () => {
  it("strips line + block comments before parsing", async () => {
    writeConfigRaw(
      synthHome,
      CONFIG_FILENAME,
      `{
  // user-global config with comments
  "version": 1,
  "servers": ["github"], /* end-of-line block */
  "blocked": ["slack"]
}`,
    );
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github"]);
    expect(r.blocked).toEqual(["slack"]);
    expect(r.warnings).toEqual([]);
  });
});

describe("loadYawMcpConfig — schema versioning", () => {
  it("warns when a file declares a newer schema version than this yaw-mcp supports", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: CURRENT_SCHEMA_VERSION + 1, servers: ["github"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github"]);
    expect(r.warnings.some((w) => w.includes("schema version"))).toBe(true);
  });

  it("loads silently when version is current or absent", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: CURRENT_SCHEMA_VERSION, servers: ["x"] });
    const r1 = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r1.warnings).toEqual([]);
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["x"] });
    const r2 = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r2.warnings).toEqual([]);
  });
});

describe("loadYawMcpConfig — fail-open on bad files", () => {
  it("malformed JSON in local file falls back to global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    writeConfigRaw(synthCwd, LOCAL_CONFIG_FILENAME, "{ this is not json");
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github"]);
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("warns when a config file exists but cannot be READ (not just when it won't parse)", async () => {
    // A config.json that is really a DIRECTORY reads as EISDIR on every
    // platform -- the portable stand-in for the field case (a root-owned
    // 0600 ~/.yaw-mcp/config.json left by a sudo-run install or a restored
    // backup, which reads EACCES). Swallowing it made the allow/deny lists
    // silently vanish -- isAllowed then falls through to allow-all -- with
    // `doctor --json` reporting an empty warnings array, while the far
    // milder invalid-JSON case above did warn.
    const cfgPath = join(synthHome, CONFIG_DIRNAME, CONFIG_FILENAME);
    mkdirSync(cfgPath, { recursive: true });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.loadedFiles).toEqual([]);
    expect(r.servers).toBeUndefined();
    const w = r.warnings.find((x) => x.includes("unreadable"));
    expect(w).toBeDefined();
    expect(w).toContain(cfgPath);
  });

  it("stays silent for a merely absent file", async () => {
    // ENOENT is the normal case for every scope a user hasn't configured;
    // warning on it would make `doctor` noisy for everyone.
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
  });

  it("non-object root is ignored with a warning", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify(["not", "an", "object"]));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.loadedFiles).toEqual([]);
    expect(r.warnings.some((w) => w.includes("must be a JSON object"))).toBe(true);
  });
});

describe("loadYawMcpConfig — servers/blocked merging", () => {
  it("project allow-list wins over global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["a", "b"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["c"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["c"]);
  });

  it("local allow-list wins over project and global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["a"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["b"] });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { servers: ["c"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["c"]);
  });

  it("blocked unions across all scopes", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { blocked: ["a", "b"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { blocked: ["b", "c"] });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { blocked: ["d"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect((r.blocked ?? []).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("loadYawMcpConfig — non-string servers/blocked entries (fix F1)", () => {
  it("an all-invalid servers array falls through to the parent scope instead of shadowing it with allow-all", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    // Local scope has ONLY non-string entries. Pre-fix it filtered to []
    // -- which isAllowed treats as allow-all -- and shadowed the global
    // allow-list. It must instead fall through so global's ["github"] wins.
    writeConfigRaw(synthCwd, LOCAL_CONFIG_FILENAME, JSON.stringify({ servers: [123, { namespace: "x" }] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github"]);
    expect(r.warnings.some((w) => w.includes("'servers' dropped"))).toBe(true);
  });

  it("keeps valid string entries and warns about the dropped ones", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ servers: ["github", 123, "slack"] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github", "slack"]);
    expect(r.warnings.some((w) => w.includes("'servers' dropped 1 non-string entry"))).toBe(true);
  });

  it("a genuinely empty servers array is preserved (explicit 'no filter', not all-invalid)", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: [] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual([]);
    // No drop warning for a legitimately empty array.
    expect(r.warnings.some((w) => w.includes("'servers' dropped"))).toBe(false);
  });
});

// Gap 15: filterStringArray runs on the BLOCKED field too (config-loader.ts:160).
// Mirrors the servers tests above, but blocked merges via unionBlocked -- so
// the all-invalid case must leave r.blocked UNDEFINED (not [] / an empty
// deny-list), which is what proves the field fell through rather than
// resolving to an empty union.
describe("loadYawMcpConfig — non-string blocked entries (fix F1, blocked field)", () => {
  it("keeps valid string entries and warns about the dropped ones", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ blocked: ["slack", 42] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toEqual(["slack"]);
    expect(r.warnings.some((w) => w.includes("'blocked' dropped 1 non-string entry"))).toBe(true);
  });

  it("an all-invalid blocked array resolves to undefined, not an empty deny-list", async () => {
    // Only non-string entries. filterStringArray returns undefined (not []),
    // so unionBlocked stays untouched and r.blocked is undefined -- a []
    // here would be a spurious "empty deny-list" resolved from junk input.
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ blocked: [123] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("'blocked' dropped"))).toBe(true);
  });

  it("a genuinely empty blocked array is preserved (explicit, not all-invalid)", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { blocked: [] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toEqual([]);
    // No drop warning for a legitimately empty array.
    expect(r.warnings.some((w) => w.includes("'blocked' dropped"))).toBe(false);
  });
});

describe("loadYawMcpConfig — walk-up project discovery", () => {
  it("finds .yaw-mcp/ in a parent directory", async () => {
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["parent-scoped"] });
    const deep = join(synthCwd, "apps", "web", "src");
    mkdirSync(deep, { recursive: true });
    const r = await loadYawMcpConfig({ cwd: deep, home: synthHome, env: {} });
    expect(r.servers).toEqual(["parent-scoped"]);
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["project"]);
    expect(r.projectConfigDir).toBe(join(synthCwd, CONFIG_DIRNAME));
  });

  it("does not treat ~/.yaw-mcp/ as a project dir when cwd is under $HOME", async () => {
    // A `.yaw-mcp/` at $HOME is the user-global scope. findProjectConfigDir
    // stops exclusive of $HOME, so even cwd deep inside $HOME shouldn't
    // claim it as project.
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    const sub = join(synthHome, "projects", "p1");
    mkdirSync(sub, { recursive: true });
    const r = await loadYawMcpConfig({ cwd: sub, home: synthHome, env: {} });
    expect(r.projectConfigDir).toBeNull();
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
  });
});

describe("loadYawMcpConfig — legacy migration runs once per process", () => {
  it("does not re-walk for a (cwd, home) pair it has already migrated", async () => {
    // First load primes the memo (nothing to migrate yet).
    await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });

    // Drop a pre-0.12 flat config AFTER that first load. Because the
    // migration is memoized per (cwd, home), the second load must not
    // walk again -- the legacy file stays exactly where it is.
    const legacy = join(synthHome, ".yaw-mcp.json");
    writeFileSync(legacy, JSON.stringify({ servers: ["legacy-only"] }));

    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toBeUndefined();
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(synthHome, CONFIG_DIRNAME, CONFIG_FILENAME))).toBe(false);
  });
});

describe("isAllowed / profileAllows", () => {
  it("null rules allows everything", () => {
    expect(isAllowed(null, "github")).toBe(true);
    expect(profileAllows(null, "github")).toBe(true);
  });

  it("empty rules allows everything", () => {
    expect(isAllowed({}, "anything")).toBe(true);
  });

  it("allow-list restricts to listed namespaces", () => {
    expect(isAllowed({ servers: ["github", "postgres"] }, "github")).toBe(true);
    expect(isAllowed({ servers: ["github", "postgres"] }, "slack")).toBe(false);
  });

  it("empty allow-list is treated as 'no restriction' (not 'deny all')", () => {
    // Users who clear servers to [] likely meant "no explicit filter",
    // not "nothing allowed". Blocking everything would make the config
    // feel broken rather than permissive.
    expect(isAllowed({ servers: [] }, "anything")).toBe(true);
  });

  it("deny-list blocks even if allow-list permits", () => {
    expect(isAllowed({ servers: ["github", "postgres"], blocked: ["postgres"] }, "postgres")).toBe(false);
  });

  it("deny-list alone blocks listed namespaces, allows others", () => {
    expect(isAllowed({ blocked: ["bad"] }, "bad")).toBe(false);
    expect(isAllowed({ blocked: ["bad"] }, "good")).toBe(true);
  });
});

// Production derives the Profile with loadYawMcpConfig + toProfile in one
// pass (server.ts), so the tests exercise that same pairing -- the old
// loadEffectiveProfile wrapper had no callers outside this file.
async function resolveProfile(cwd: string, home: string): Promise<Profile | null> {
  return toProfile(await loadYawMcpConfig({ cwd, home, env: {} }));
}

describe("toProfile (loadYawMcpConfig -> Profile)", () => {
  it("returns null when no allow/deny rules are set anywhere", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: 1, installNudge: true });
    const p = await resolveProfile(synthCwd, synthHome);
    expect(p).toBeNull();
  });

  it("returns a profile with servers + blocked when global sets them", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"], blocked: ["slack"] });
    const p = await resolveProfile(synthCwd, synthHome);
    expect(p).not.toBeNull();
    expect(p?.servers).toEqual(["github"]);
    expect(p?.blocked).toEqual(["slack"]);
    // Single-source (global-only) → no userPath needed, path IS the global.
    expect(p?.path).toContain(CONFIG_DIRNAME);
    expect(p?.userPath).toBeUndefined();
  });

  it("exposes both project and user paths when both contribute", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { blocked: ["slack"] });
    const p = await resolveProfile(synthCwd, synthHome);
    expect(p).not.toBeNull();
    // Allow-list from global (project didn't set servers), blocked from project.
    expect(p?.servers).toEqual(["github"]);
    expect(p?.blocked).toEqual(["slack"]);
    expect(p?.path).toContain(join(synthCwd, CONFIG_DIRNAME));
    expect(p?.userPath).toContain(join(synthHome, CONFIG_DIRNAME));
  });

  it("project allow-list takes precedence over global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github", "postgres"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["github"] });
    const p = await resolveProfile(synthCwd, synthHome);
    expect(p?.servers).toEqual(["github"]);
  });
});

describe("loadYawMcpConfig — installNudge flag", () => {
  it("is undefined when no scope sets it (off by default)", async () => {
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBeUndefined();
  });

  it("reads installNudge:true from the global file", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { installNudge: true });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBe(true);
  });

  it("reads installNudge:false explicitly", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { installNudge: false });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBe(false);
  });

  it("most-specific scope wins (local:false overrides global:true)", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { installNudge: true });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { installNudge: false });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBe(false);
  });

  it("project scope wins over global when local is absent", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { installNudge: false });
    writeConfig(synthCwd, CONFIG_FILENAME, { installNudge: true });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBe(true);
  });

  it("ignores a non-boolean installNudge (no coercion of a typo)", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ installNudge: "true" }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBeUndefined();
  });
});
