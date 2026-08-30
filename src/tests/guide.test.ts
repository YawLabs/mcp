import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadGuides, loadProjectGuide, loadUserGuide, projectGuideNotice, renderGuide } from "../guide.js";
import { CONFIG_DIRNAME, GUIDE_FILENAME } from "../paths.js";
import { grantTrust } from "../trust.js";

function writeGuide(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, GUIDE_FILENAME);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("loadUserGuide", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when ~/.yaw-mcp/YAW-MCP.md doesn't exist", async () => {
    expect(await loadUserGuide(home)).toBeNull();
  });

  it("returns null but WARNS when the guide exists and cannot be read (a directory at its path)", async () => {
    // The header promises "an unreadable one logs and returns null", but
    // readGuide only logged the abort timeout: EACCES / EISDIR / EIO were
    // swallowed and looked identical to "no guide" from the resource and
    // from doctor -- a guide the user wrote, silently not served. A
    // directory at YAW-MCP.md is EISDIR on every platform.
    const dir = join(home, CONFIG_DIRNAME);
    mkdirSync(join(dir, GUIDE_FILENAME), { recursive: true });
    const warned: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      warned.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await loadUserGuide(home)).toBeNull();
    } finally {
      process.stderr.write = orig;
    }
    const joined = warned.join("");
    expect(joined).toContain("Guide exists but could not be read");
    expect(joined).toContain(GUIDE_FILENAME);
  });

  it("loads content when present", async () => {
    const p = writeGuide(join(home, CONFIG_DIRNAME), "# User guide\n\nuse gh for github.\n");
    const g = await loadUserGuide(home);
    expect(g).not.toBeNull();
    expect(g?.scope).toBe("user");
    expect(g?.path).toBe(p);
    expect(g?.content).toContain("use gh for github.");
  });

  it("caps an oversized guide, warns, and serves only the leading portion", async () => {
    // The whole file lands in the model's context via yaw-mcp://guide, so a
    // wrong file at this path (a vendored dataset, a log, a renamed binary)
    // was read whole into memory and forwarded whole. 300 KB against a
    // 256 KB cap: the guide still loads, truncated, with a warn.
    const cap = 256 * 1024;
    writeGuide(join(home, CONFIG_DIRNAME), `# Big guide\n${"x".repeat(300 * 1024)}\n`);
    const warned: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      warned.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let g: Awaited<ReturnType<typeof loadUserGuide>>;
    try {
      g = await loadUserGuide(home);
    } finally {
      process.stderr.write = orig;
    }
    expect(g).not.toBeNull();
    expect(g?.content.startsWith("# Big guide")).toBe(true);
    expect(Buffer.byteLength(g?.content ?? "", "utf8")).toBeLessThanOrEqual(cap);
    expect(warned.join("")).toContain("larger than the size cap");
  });

  it("returns null for an empty file", async () => {
    // Empty guide is treated as "no guidance" — the user created the
    // file but hasn't filled it in. Surfacing an empty resource would
    // push the client to read it for nothing.
    writeGuide(join(home, CONFIG_DIRNAME), "   \n\n");
    expect(await loadUserGuide(home)).toBeNull();
  });
});

describe("loadProjectGuide", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-home-"));
    // Nest project INSIDE home so the walk-up in findProjectConfigDir
    // terminates at the synthetic home boundary — otherwise it keeps
    // walking past tmpdir into the real user dir and finds whatever
    // `~/.yaw-mcp/YAW-MCP.md` the dev machine actually has, which makes
    // "no guide" assertions flap depending on who's running the tests.
    project = mkdtempSync(join(home, "proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("returns null when no .yaw-mcp/ exists in the tree", async () => {
    expect(await loadProjectGuide(project, home)).toBeNull();
  });

  it("loads a project guide from the cwd's .yaw-mcp/ dir", async () => {
    writeGuide(join(project, CONFIG_DIRNAME), "project notes");
    const g = await loadProjectGuide(project, home);
    expect(g?.scope).toBe("project");
    expect(g?.content).toBe("project notes");
  });

  it("walks up from a deep subdirectory", async () => {
    const cfgDir = join(project, CONFIG_DIRNAME);
    writeGuide(cfgDir, "monorepo root guidance");
    const deep = join(project, "apps", "web", "src");
    mkdirSync(deep, { recursive: true });
    const g = await loadProjectGuide(deep, home);
    expect(g?.content).toBe("monorepo root guidance");
    expect(g?.path).toBe(join(cfgDir, GUIDE_FILENAME));
  });

  it("returns null when .yaw-mcp/ exists but YAW-MCP.md doesn't", async () => {
    // A project can have config.json without a guide — perfectly valid.
    mkdirSync(join(project, CONFIG_DIRNAME));
    expect(await loadProjectGuide(project, home)).toBeNull();
  });

  // The outside-$HOME checkout case (second drive, container workspace) now
  // lives in guide-outside-home-trust.test.ts, which exercises the ownership
  // gate (POSIX uid match) and the win32 env opt-in deterministically with
  // geteuid/env stubs the plain temp-dir case here couldn't pin.
});

// A project YAW-MCP.md sits in the SAME `.yaw-mcp/` as the consent-gated
// bundles.json but is not gated itself -- a project guide with no
// bundles.json beside it is a legitimate, documented setup. What it gets
// instead is visibility: repo-authored text reaching the model is flagged so
// `yaw-mcp doctor` can name it.
describe("loadProjectGuide approval flag", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-home-"));
    project = mkdtempSync(join(home, "proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeProjectBundles(content: unknown): string {
    const dir = join(project, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "bundles.json");
    writeFileSync(p, JSON.stringify(content), "utf8");
    return p;
  }

  it("flags a project guide with no bundles.json beside it (still loads)", async () => {
    writeGuide(join(project, CONFIG_DIRNAME), "project notes");
    const g = await loadProjectGuide(project, home, {});
    expect(g?.content).toBe("project notes");
    expect(g?.unapproved).toBe(true);
    expect(projectGuideNotice(g)).toContain(g?.path as string);
  });

  it("flags a project guide whose sibling bundles.json is unapproved", async () => {
    writeGuide(join(project, CONFIG_DIRNAME), "project notes");
    writeProjectBundles({ version: 1, servers: [] });
    const g = await loadProjectGuide(project, home, {});
    expect(g?.unapproved).toBe(true);
  });

  it("does NOT flag a project guide whose sibling bundles.json is approved", async () => {
    writeGuide(join(project, CONFIG_DIRNAME), "project notes");
    const p = writeProjectBundles({ version: 1, servers: [] });
    await grantTrust(p, readFileSync(p), { home });
    const g = await loadProjectGuide(project, home, {});
    expect(g?.unapproved).toBeUndefined();
    expect(projectGuideNotice(g)).toBeNull();
  });

  it("does NOT flag under the YAW_MCP_TRUST_PROJECT escape hatch", async () => {
    writeGuide(join(project, CONFIG_DIRNAME), "project notes");
    writeProjectBundles({ version: 1, servers: [] });
    const g = await loadProjectGuide(project, home, { YAW_MCP_TRUST_PROJECT: "1" });
    expect(g?.unapproved).toBeUndefined();
  });

  it("never flags the user-global guide", async () => {
    writeGuide(join(home, CONFIG_DIRNAME), "user notes");
    const g = await loadUserGuide(home);
    expect(g?.unapproved).toBeUndefined();
    expect(projectGuideNotice(g)).toBeNull();
  });

  it("projectGuideNotice is null when there is no project guide", () => {
    expect(projectGuideNotice(null)).toBeNull();
  });
});

describe("loadGuides", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-home-"));
    // Nest project INSIDE home so the walk-up in findProjectConfigDir
    // terminates at the synthetic home boundary — otherwise it keeps
    // walking past tmpdir into the real user dir and finds whatever
    // `~/.yaw-mcp/YAW-MCP.md` the dev machine actually has, which makes
    // "no guide" assertions flap depending on who's running the tests.
    project = mkdtempSync(join(home, "proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("returns both nulls when neither exists", async () => {
    const g = await loadGuides(project, home);
    expect(g.user).toBeNull();
    expect(g.project).toBeNull();
  });

  it("returns both when both exist", async () => {
    writeGuide(join(home, CONFIG_DIRNAME), "U");
    writeGuide(join(project, CONFIG_DIRNAME), "P");
    const g = await loadGuides(project, home);
    expect(g.user?.content).toBe("U");
    expect(g.project?.content).toBe("P");
  });
});

describe("renderGuide", () => {
  it("returns null when neither guide exists", () => {
    expect(renderGuide({ user: null, project: null })).toBeNull();
  });

  it("returns just the user guide when only user is set", () => {
    const out = renderGuide({
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
      project: null,
    });
    expect(out).toContain("u-body");
    expect(out).toContain("/h/.yaw-mcp/YAW-MCP.md");
    expect(out).not.toContain("---");
  });

  it("concatenates user then project with a separator", () => {
    // Order matters: project goes last so its guidance is what the
    // reader sees most recently. See comment in renderGuide().
    const out = renderGuide({
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
      project: { scope: "project", path: "/p/.yaw-mcp/YAW-MCP.md", content: "p-body" },
    });
    const userIdx = out!.indexOf("u-body");
    const projIdx = out!.indexOf("p-body");
    expect(userIdx).toBeGreaterThan(-1);
    expect(projIdx).toBeGreaterThan(userIdx);
    expect(out).toContain("---");
  });

  it("appends an 'Installed servers' auto-section when installed servers carry shadows", () => {
    const out = renderGuide(
      {
        user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
        project: null,
      },
      [
        { namespace: "npmjs", name: "npm registry" },
        { namespace: "linear", name: "Linear" }, // no shadow → must be filtered
      ],
    );
    expect(out).toContain("## Installed MCP servers");
    expect(out).toContain("`npmjs`");
    expect(out).toContain("npm registry");
    expect(out).not.toContain("Linear"); // no shadow → not in auto section
  });

  it("omits the auto-section when no installed server shadows any CLI", () => {
    const out = renderGuide(
      {
        user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
        project: null,
      },
      [{ namespace: "linear", name: "Linear" }],
    );
    expect(out).not.toContain("Installed MCP servers");
  });

  it("returns the auto-section alone when no human-authored guide exists", () => {
    // User has no YAW-MCP.md but an installed npmjs server — the guide
    // resource still carries signal, so we surface it.
    const out = renderGuide({ user: null, project: null }, [{ namespace: "npmjs", name: "npm registry" }]);
    expect(out).toContain("Installed MCP servers");
    expect(out).toContain("`npmjs`");
  });

  it("still returns null when guides are empty AND no shadows apply", () => {
    expect(renderGuide({ user: null, project: null }, [{ namespace: "linear", name: "Linear" }])).toBeNull();
  });
});
