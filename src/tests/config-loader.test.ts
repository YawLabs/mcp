import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  CURRENT_SCHEMA_VERSION,
  DEPRECATED_KEYS,
  isAllowed,
  KNOWN_CONFIG_KEYS,
  LOCAL_CONFIG_FILENAME,
  loadYawMcpConfig,
  type Profile,
  profileAllows,
  toProfile,
} from "../config-loader.js";
import { CONFIG_DIRNAME } from "../paths.js";

// Repo-relative path to the shipped schema: this file lives in src/tests/,
// the schema in schemas/ at the repo root.
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  // realpathSync both roots: the loader resolves paths physically, so on
  // macOS -- where os.tmpdir() sits under the /var -> /private/var symlink --
  // a logical `join(synthCwd, CONFIG_DIRNAME)` in an assertion never
  // byte-matches the /private/var spelling the loader returns.
  synthHome = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-cfg-home-")));
  // synthCwd lives INSIDE synthHome so walk-up terminates at the
  // synthetic home boundary rather than escaping past tmpdir into the
  // real user dir — where a real ~/.yaw-mcp/ on dev machines would
  // otherwise get claimed as the project config and leak into assertions.
  synthCwd = realpathSync(mkdtempSync(join(synthHome, "cwd-")));
});

afterEach(() => {
  // One rm is enough: synthCwd is created INSIDE synthHome, so the recursive
  // removal above already took it (a second rmSync on it was a no-op).
  rmSync(synthHome, { recursive: true, force: true });
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
  it("never throws on an unusable apiBase, and leaves the retired YAW_MCP_URL env var wholly inert", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { apiBase: "not a url at all" });
    const fromFile = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(fromFile.warnings.some((w) => w.includes("'apiBase'"))).toBe(true);

    // `resolves.toBeDefined()` alone could not fail -- the loader has never
    // read opts.env, so it asserted nothing about YAW_MCP_URL. Pin the real
    // contract instead: the env load must be INDISTINGUISHABLE from the
    // no-env one, and must not echo the value into a warning.
    const fromEnv = await loadYawMcpConfig({
      cwd: synthCwd,
      home: synthHome,
      env: { YAW_MCP_URL: "http://example.com" },
    });
    expect(fromEnv.warnings).toEqual(fromFile.warnings);
    expect(fromEnv.servers).toEqual(fromFile.servers);
    expect(fromEnv.blocked).toEqual(fromFile.blocked);
    expect(fromEnv.loadedFiles.map((f) => f.scope)).toEqual(fromFile.loadedFiles.map((f) => f.scope));
    expect(fromEnv.warnings.some((w) => w.includes("example.com"))).toBe(false);
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

  // Regression: a PRESENT but wrong-typed version collapsed to undefined and
  // skipped the newer-schema check entirely, so `"version": "2"` -- the
  // likeliest hand-edit typo in a file whose every other value is a string --
  // produced total silence for the one user who most needed the upgrade hint.
  it("warns when version is present but not a number", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: "2", servers: ["x"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    // Still loads: the rest of the file is usable, same soft-failure stance
    // as every other malformed field here.
    expect(r.servers).toEqual(["x"]);
    const w = r.warnings.find((x) => x.includes("'version' must be a number"));
    expect(w).toBeDefined();
    expect(w).toContain("found string");
    // And it is not ALSO reported as an unknown key.
    expect(r.warnings.some((x) => x.includes("unknown key"))).toBe(false);
  });

  it("does not warn about version when the key is absent", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["x"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings.some((x) => x.includes("'version'"))).toBe(false);
  });
});

// The shipped JSON schema (schemas/yaw-mcp.config.v1.json) is
// additionalProperties:false and is fetched by editors over its raw
// GitHub URL, so it is a second, USER-VISIBLE spelling of the key list this
// loader enforces. Nothing in the repo referenced it and no test touched it,
// so a key added on one side only would have shown up as "invalid config" in
// the user's editor while loading fine -- or the reverse.
describe("shipped config JSON schema", () => {
  interface SchemaProperty {
    type?: string;
    minimum?: number;
    deprecated?: boolean;
    uniqueItems?: boolean;
    items?: { type?: string; minLength?: number };
  }
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "yaw-mcp.config.v1.json"), "utf8")) as {
    additionalProperties?: boolean;
    properties?: Record<string, SchemaProperty>;
  };

  it("declares exactly the keys the loader knows, plus the deprecated ones it still tolerates", () => {
    // Deprecated keys stay in the schema on purpose: with
    // additionalProperties:false, removing them would mark every existing
    // user config invalid. They are warned about, not rejected, here too.
    const expected = [...KNOWN_CONFIG_KEYS, ...DEPRECATED_KEYS].sort();
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(expected);
  });

  it("stays additionalProperties:false, which is what makes the key list a contract", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  // Key NAMES alone were the whole contract, so every declared TYPE and
  // CONSTRAINT could drift from the loader without a failure. Pin the shapes
  // too. Where the loader is deliberately more lenient than the schema, the
  // gap is named here rather than left implicit -- the schema is the
  // editor-facing contract, the loader is soft-failing by design:
  //   - `version`: schema says integer >= 1; the loader accepts any number
  //     and only compares it against CURRENT_SCHEMA_VERSION.
  //   - `token` / `apiBase`: schema says string; the loader triggers its
  //     deprecation warning on key PRESENCE at any type.
  //   - `servers` / `blocked`: schema says uniqueItems; the loader does not
  //     dedupe `servers` (`blocked` unions through a Set, so it does).
  // The `items` assertions are deliberately per-keyword rather than a deep
  // equality, so ADDING a constraint (a namespace `pattern`, say) does not
  // fail here while REMOVING minLength/type still does.
  it("pins the declared type and constraints of every property, not just the key names", () => {
    const props = schema.properties ?? {};
    expect(props.$schema?.type).toBe("string");
    expect(props.version?.type).toBe("integer");
    expect(props.version?.minimum).toBe(1);
    expect(props.installNudge?.type).toBe("boolean");
    for (const key of DEPRECATED_KEYS) {
      expect(props[key]?.type).toBe("string");
      // The `deprecated` annotation is what makes an editor grey the key out;
      // without it the retained property reads as current.
      expect(props[key]?.deprecated).toBe(true);
    }
    for (const field of ["servers", "blocked"]) {
      expect(props[field]?.type).toBe("array");
      expect(props[field]?.uniqueItems).toBe(true);
      expect(props[field]?.items?.type).toBe("string");
      expect(props[field]?.items?.minLength).toBe(1);
    }
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
    expect(r.warnings.some((w) => w.includes("'servers' dropped 1 non-string or empty entry"))).toBe(true);
  });

  it("drops an empty-string namespace with a warning instead of keeping a silent deny-all", async () => {
    // The shipped schema says minLength 1. A kept "" made isAllowed require
    // namespace === "" -- unreachable under NAMESPACE_RE -- so `servers: [""]`
    // silently denied every real server with no diagnostic.
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ servers: ["github", "", "  "] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github"]);
    expect(r.warnings.some((w) => w.includes("'servers' dropped 2 non-string or empty entries"))).toBe(true);
  });

  it("warns on an unknown top-level key instead of ignoring it silently", async () => {
    // A typo like "blocke" was a silent no-op that fails OPEN to allow-all;
    // the shipped schema is additionalProperties:false.
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ blocke: ["slack"], $schema: "x" }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toBeUndefined();
    const w = r.warnings.find((x) => x.includes("unknown key 'blocke'"));
    expect(w).toBeDefined();
    // Exactly ONE unknown key: $schema is the editor pointer the schema
    // itself allows, so it must not appear as an unknown key (the singular
    // "key" and the absence of a quoted '$schema' pin that).
    expect(w).toMatch(/unknown key 'blocke' ignored/);
    expect(w).not.toContain("'$schema'");
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
    expect(r.warnings.some((w) => w.includes("'blocked' dropped 1 non-string or empty entry"))).toBe(true);
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

// A field that is PRESENT but not an array at all. The mirror image of the
// F1 case above and quieter: the field was discarded with no diagnostic on
// any surface, so `"servers": "github"` -- written to lock a session down to
// one server -- left isAllowed returning true for everything while `doctor`
// exited 0 with an empty warnings array.
describe("loadYawMcpConfig — non-array servers/blocked field", () => {
  it("warns and ignores a string 'servers' instead of dropping it in silence", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ servers: "github" }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toBeUndefined();
    const w = r.warnings.find((x) => x.includes("'servers' must be an array"));
    expect(w).toBeDefined();
    expect(w).toContain("found string");
    // The FIELD is dropped, not the file: everything else still loads.
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
  });

  it("warns for a non-array 'blocked' too, and names null as null rather than object", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ blocked: null, installNudge: true }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toBeUndefined();
    expect(r.installNudge).toBe(true);
    const w = r.warnings.find((x) => x.includes("'blocked' must be an array"));
    expect(w).toBeDefined();
    expect(w).toContain("found null");
  });

  it("stays silent for a field that is simply ABSENT (the normal case)", async () => {
    // The trap in this fix: warning on every non-array would warn on the
    // undefined that every unconfigured scope produces, making `doctor` noisy
    // for everyone. Only a PRESENT wrong-typed field is reported.
    writeConfig(synthHome, CONFIG_FILENAME, { blocked: ["slack"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
  });
});

// Entries were validated with `.trim()` but KEPT untrimmed, so `" github"`
// survived as an allow-list no installed namespace can ever match: a silent
// deny-all that also shadows a valid parent scope. Trim on the way in, and
// warn (never drop) on anything NAMESPACE_RE would reject.
describe("loadYawMcpConfig — namespace shape of servers/blocked entries", () => {
  it("keeps the TRIMMED spelling, so a padded entry can still match an installed server", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ servers: [" github", "slack  "] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["github", "slack"]);
    expect(isAllowed(r, "github")).toBe(true);
    // Nothing was dropped and nothing looks malformed after the trim.
    expect(r.warnings).toEqual([]);
  });

  it("trims 'blocked' the same way (a padded deny becomes a real deny)", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ blocked: [" slack"] }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.blocked).toEqual(["slack"]);
    expect(isAllowed(r, "slack")).toBe(false);
  });

  it("warns about an unmatchable namespace but KEEPS it, so the scope is not silently promoted", async () => {
    // Dropping "GitHub" would empty the array, hit the all-invalid
    // fall-through, and resolve this scope to the parent's allow-all -- the
    // exact F1 bug filterStringArray exists to prevent. Warn instead.
    writeConfigRaw(synthCwd, LOCAL_CONFIG_FILENAME, JSON.stringify({ servers: ["GitHub"] }));
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["GitHub"]);
    const w = r.warnings.find((x) => x.includes("is not a valid namespace"));
    expect(w).toBeDefined();
    expect(w).toContain("'GitHub'");
  });

  it("does not warn about well-formed namespaces", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github", "postgres_2"], blocked: ["slack"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
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

// Two separate facts, deliberately in two separate tests: that the loader
// CALLS the migrator at all, and that it calls it only once per (cwd, home).
// Asserting only the second is vacuous -- it passes unchanged if
// `migrateLegacyConfigPathsOnce` is deleted from loadYawMcpConfig outright,
// which proves nothing ran rather than that the memo is what stopped it.
describe("loadYawMcpConfig — legacy migration", () => {
  it("folds a pre-0.12 flat ~/.yaw-mcp.json into .yaw-mcp/config.json on the first load", async () => {
    const legacy = join(synthHome, ".yaw-mcp.json");
    writeFileSync(legacy, JSON.stringify({ servers: ["legacy_only"] }));

    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });

    // The 0.11.x allow-list survived the upgrade, which is only true if the
    // loader calls the migrator BEFORE resolving files. Deleting that call --
    // or moving it after the readConfigAt calls, equally invisible today --
    // turns this red.
    expect(r.servers).toEqual(["legacy_only"]);
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
    // Renamed, not copied: the legacy path is gone and the new one exists.
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(synthHome, CONFIG_DIRNAME, CONFIG_FILENAME))).toBe(true);
  });

  it("does not re-walk for a (cwd, home) pair it has already migrated", async () => {
    // First load primes the memo (nothing to migrate yet).
    await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });

    // Drop a pre-0.12 flat config AFTER that first load, at PROJECT scope.
    // Scope matters: a second GLOBAL legacy file would prove nothing, because
    // the migrator is idempotent and deliberately leaves a legacy file alone
    // once ~/.yaw-mcp/config.json exists -- memo or no memo. This target does
    // NOT exist and the walker reaches synthCwd, so a re-walk would migrate it
    // into a project-scope config that then outranks global.
    const legacy = join(synthCwd, ".yaw-mcp.json");
    writeFileSync(legacy, JSON.stringify({ servers: ["project_legacy"] }));

    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toBeUndefined();
    expect(r.loadedFiles).toEqual([]);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(synthCwd, CONFIG_DIRNAME, CONFIG_FILENAME))).toBe(false);
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

  it("ignores a non-boolean installNudge (no coercion of a typo) and says so", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify({ installNudge: "true" }));
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.installNudge).toBeUndefined();
    // A wrong-typed `version` has warned for a while; installNudge was
    // discarded in silence, so a user who opted in read their own config as
    // enabled while the nudge stayed off on every surface.
    const w = r.warnings.find((x) => x.includes("'installNudge' must be a boolean"));
    expect(w).toBeDefined();
    expect(w).toContain("found string");
  });

  it("does not warn about installNudge when the key is absent", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    const r = await loadYawMcpConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings.some((x) => x.includes("'installNudge'"))).toBe(false);
  });
});
