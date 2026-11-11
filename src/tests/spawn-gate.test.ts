import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, loadYawMcpConfig, type Profile, toProfile } from "../config-loader.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { blockedToolsSource } from "../spawn-gate.js";

async function resolveProfile(cwd: string, home: string): Promise<Profile | null> {
  return toProfile(await loadYawMcpConfig({ cwd, home, env: {} }));
}

// blockedToolsSource names the file a user has to edit to lift a `blockedTools`
// deny. It reads Profile.blockedToolsPaths (the files that declare the key),
// and falls back to path / userPath only for a Profile built without it.
describe("blockedToolsSource", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    // realpathSync: the loader resolves paths physically (macOS /var symlink).
    // cwd sits INSIDE home so the project walk-up stops at the synthetic home
    // instead of reaching a real ~/.yaw-mcp on a dev machine.
    home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-spawn-gate-")));
    cwd = realpathSync(mkdtempSync(join(home, "cwd-")));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(dir: string, filename: string, contents: unknown): string {
    const cfgDir = join(dir, CONFIG_DIRNAME);
    mkdirSync(cfgDir, { recursive: true });
    const file = join(cfgDir, filename);
    writeFileSync(file, JSON.stringify(contents));
    return file;
  }

  it("names the project file when a local file is primary and only the project declares the deny", async () => {
    // REGRESSION: `path` is config.local.json here and there is no global
    // file, so the old path / userPath answer named the one loaded file that
    // does NOT carry the deny.
    const localFile = writeConfig(cwd, LOCAL_CONFIG_FILENAME, { servers: ["github"] });
    const projectFile = writeConfig(cwd, CONFIG_FILENAME, { blockedTools: ["github_delete_repo"] });
    const profile = await resolveProfile(cwd, home);
    expect(profile?.path).toBe(localFile);
    expect(blockedToolsSource(profile)).toBe(projectFile);
  });

  it("names every declaring file, highest precedence first, when more than one declares it", async () => {
    const localFile = writeConfig(cwd, LOCAL_CONFIG_FILENAME, { blockedTools: ["a_one"] });
    const projectFile = writeConfig(cwd, CONFIG_FILENAME, { blockedTools: ["b_two"] });
    const globalFile = writeConfig(home, CONFIG_FILENAME, { blockedTools: ["c_three"] });
    const profile = await resolveProfile(cwd, home);
    expect(blockedToolsSource(profile)).toBe(
      `whichever of ${localFile} / ${projectFile} / ${globalFile} declares it (blockedTools merges across scopes)`,
    );
  });

  it("does not name a loaded file that does not declare the key", async () => {
    writeConfig(cwd, CONFIG_FILENAME, { blocked: ["slack"] });
    const globalFile = writeConfig(home, CONFIG_FILENAME, { blockedTools: ["c_three"] });
    const profile = await resolveProfile(cwd, home);
    expect(profile?.userPath).toBe(globalFile);
    expect(blockedToolsSource(profile)).toBe(globalFile);
  });

  it("falls back to path / userPath for a Profile built without blockedToolsPaths", () => {
    expect(blockedToolsSource({ path: "/p/config.json", blockedTools: ["x"] })).toBe("/p/config.json");
    expect(blockedToolsSource({ path: "/p/config.json", userPath: "/h/config.json", blockedTools: ["x"] })).toBe(
      "whichever of /p/config.json / /h/config.json declares it (blockedTools merges across scopes)",
    );
    expect(blockedToolsSource({ path: "/p/config.json", blockedToolsPaths: [] })).toBe("/p/config.json");
  });

  it("has a generic answer when there is no profile", () => {
    expect(blockedToolsSource(null)).toBe("your yaw-mcp config");
  });
});
