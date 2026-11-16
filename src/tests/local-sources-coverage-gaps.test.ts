// Coverage gaps in the local sources: the git-build GC's marker parse
// (collectLocked) and the bundles.json loader's warning sink on the
// project-file branches (loadLocalBundles).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gcGitBuilds, gitRefsPath } from "../git-source.js";
import { type LoadWarningSink, loadLocalBundles, localBundlesPath } from "../local-bundles.js";
import { CONFIG_DIRNAME, gitBuildDir, gitBuiltPath, gitFailedPath, gitRoot, userConfigDir } from "../paths.js";
import { grantTrust, TRUST_BYPASS_ENV } from "../trust.js";
import { fakeFinishedBuild, newTmp } from "./git-fixture.js";

describe("gcGitBuilds -- the .built / .failed siblings of a build", () => {
  const sha = (c: string): string => c.repeat(40);
  const CUR = sha("a");
  const PREV = sha("b");
  const OLD = sha("c");
  const FAILED_ONLY = sha("d");

  it("deletes the unkept marker and .failed record, keeps the kept markers and non-build files, reports only dirs", async () => {
    const home = newTmp("yaw-gc-markers-");
    const ns = "fx";
    for (const c of [CUR, PREV, OLD]) fakeFinishedBuild(gitBuildDir(ns, c, home), c);
    writeFileSync(gitFailedPath(ns, OLD, home), "{}");
    writeFileSync(gitFailedPath(ns, FAILED_ONLY, home), "{}");
    writeFileSync(gitRefsPath(ns, home), "{}");
    const bad = join(gitRoot(home), ns, "refs.json.bad");
    writeFileSync(bad, "not json, set aside earlier");

    const r = await gcGitBuilds(ns, [CUR, PREV], home);
    if ("locked" in r) throw new Error(r.message);
    expect(r.errors).toEqual([]);
    expect(r.unreadable).toEqual([]);
    // Only the directory's sha12: never a marker or record name.
    expect(r.removed).toEqual([OLD.slice(0, 12)]);

    expect(existsSync(gitBuildDir(ns, OLD, home))).toBe(false);
    expect(existsSync(gitBuiltPath(ns, OLD, home))).toBe(false);
    expect(existsSync(gitFailedPath(ns, OLD, home))).toBe(false);
    expect(existsSync(gitFailedPath(ns, FAILED_ONLY, home))).toBe(false);
    for (const c of [CUR, PREV]) {
      expect(existsSync(gitBuildDir(ns, c, home))).toBe(true);
      expect(existsSync(gitBuiltPath(ns, c, home))).toBe(true);
    }
    expect(readFileSync(gitRefsPath(ns, home), "utf8")).toBe("{}");
    expect(readFileSync(bad, "utf8")).toBe("not json, set aside earlier");
    expect(readdirSync(join(gitRoot(home), ns)).sort()).toEqual(
      [
        CUR.slice(0, 12),
        `${CUR.slice(0, 12)}.built`,
        PREV.slice(0, 12),
        `${PREV.slice(0, 12)}.built`,
        "refs.json",
        "refs.json.bad",
      ].sort(),
    );
  });
});

describe("loadLocalBundles onWarning -- the project-file branches", () => {
  let home: string;
  let cwd: string;
  let stderr: string[];

  beforeEach(() => {
    vi.stubEnv(TRUST_BYPASS_ENV, "");
    vi.stubEnv("YAW_MCP_LOG_LEVEL", "");
    vi.stubEnv("LOG_LEVEL", "");
    home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-sink-")));
    // cwd under the fake home, so the project walk cannot climb out of it.
    cwd = join(home, "proj");
    mkdirSync(cwd);
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const globalPath = (): string => localBundlesPath(userConfigDir(home));
  const projectPath = (): string => localBundlesPath(join(cwd, CONFIG_DIRNAME));

  function writeGlobal(text: string): void {
    mkdirSync(userConfigDir(home), { recursive: true });
    writeFileSync(globalPath(), text);
  }

  async function writeTrustedProject(text: string): Promise<void> {
    mkdirSync(join(cwd, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(projectPath(), text);
    await grantTrust(projectPath(), readFileSync(projectPath()), { home });
  }

  function collect(): { sink: LoadWarningSink; seen: Array<{ message: string; data?: Record<string, unknown> }> } {
    const seen: Array<{ message: string; data?: Record<string, unknown> }> = [];
    // Setup is done: drop what grantTrust logged, so only the load is measured.
    stderr.length = 0;
    return { sink: (w) => seen.push(w), seen };
  }

  const PROJECT = JSON.stringify({
    version: 1,
    servers: [{ namespace: "proj", name: "Proj", command: "npx", args: ["-y", "proj-mcp"] }],
  });

  it("valid project file, invalid global file: the global re-read warns to the sink only", async () => {
    await writeTrustedProject(PROJECT);
    writeGlobal("{ not json");
    const { sink, seen } = collect();
    const r = await loadLocalBundles({ cwd, home, onWarning: sink });
    expect(r.path).toBe(projectPath());
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["proj"]);
    expect(seen).toEqual([
      { message: "bundles.json is not valid JSON; ignoring", data: expect.objectContaining({ path: globalPath() }) },
    ]);
    expect(r.warnings.some((w) => w.includes(globalPath()))).toBe(false);
    expect(stderr.join("")).toBe("");
  });

  it("valid project file, a directory at the global path: the global re-read warns to the sink only", async () => {
    await writeTrustedProject(PROJECT);
    mkdirSync(globalPath(), { recursive: true });
    const { sink, seen } = collect();
    const r = await loadLocalBundles({ cwd, home, onWarning: sink });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["proj"]);
    expect(seen).toEqual([
      { message: "Could not read bundles.json", data: expect.objectContaining({ path: globalPath() }) },
    ]);
    expect(r.warnings.some((w) => w.includes(globalPath()))).toBe(false);
    expect(stderr.join("")).toBe("");
  });

  it("malformed project file, invalid global file: both warn to the sink, only the project's is in warnings", async () => {
    await writeTrustedProject("{ not json");
    writeGlobal("{ also not json");
    const { sink, seen } = collect();
    const r = await loadLocalBundles({ cwd, home, onWarning: sink });
    expect(r.config).toBeNull();
    expect(r.path).toBe(projectPath());
    expect(seen.map((w) => [w.message, w.data?.path])).toEqual([
      ["bundles.json is not valid JSON; ignoring", projectPath()],
      ["bundles.json is not valid JSON; ignoring", globalPath()],
    ]);
    expect(r.warnings.some((w) => w.includes(projectPath()))).toBe(true);
    expect(r.warnings.some((w) => w.includes(globalPath()))).toBe(false);
    expect(stderr.join("")).toBe("");
  });

  it("an approved project file that is now unreadable warns to the sink and into warnings, not to stderr", async () => {
    await writeTrustedProject(PROJECT);
    // Replace the approved file with a directory: a read error on every platform.
    rmSync(projectPath());
    mkdirSync(projectPath());
    const { sink, seen } = collect();
    const r = await loadLocalBundles({ cwd, home, onWarning: sink });
    expect(r.config).toBeNull();
    expect(r.path).toBe(projectPath());
    expect(seen).toEqual([
      { message: "Could not read bundles.json", data: expect.objectContaining({ path: projectPath() }) },
    ]);
    expect(r.warnings.some((w) => w.startsWith(`${projectPath()}: could not read file (`))).toBe(true);
    expect(stderr.join("")).toBe("");
  });
});
