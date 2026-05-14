import { describe, expect, it, vi } from "vitest";
import { maybeAutoUpgrade } from "../auto-upgrade.js";

// ═══════════════════════════════════════════════════════════════════════
// maybeAutoUpgrade — fire-and-forget startup self-upgrade check.
//
// The registry fetch and the npm spawn are both injected, so these tests
// are pure: they assert WHEN a background `npm install -g` is spawned and
// when it is correctly skipped (dev build, offline, already-current, or
// an install method we won't touch).
// ═══════════════════════════════════════════════════════════════════════

// argv[1] paths that detectInstallMethod (upgrade-cmd.ts) classifies.
const GLOBAL_NPM_PATH = "/usr/local/lib/node_modules/@yawlabs/mcph/dist/index.js";
const NPX_PATH = "/home/u/.npm/_npx/abc123/node_modules/@yawlabs/mcph/dist/index.js";

describe("maybeAutoUpgrade", () => {
  it("does nothing for an unbuilt dev checkout (never fetches or spawns)", async () => {
    const fetchLatestImpl = vi.fn();
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "dev", argvPath: GLOBAL_NPM_PATH, fetchLatestImpl, spawnImpl });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the registry is unreachable (fetch returns null)", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => null,
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when already on the latest version", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.8",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("background-upgrades a stale global-npm install", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("npm", ["install", "-g", "@yawlabs/mcph@latest"]);
  });

  it("does NOT spawn for a stale npx install (npx self-heals via the @latest config)", async () => {
    // npx installs are upgraded by the `@yawlabs/mcph@latest` entry that
    // `mcph install` writes -- there is nothing safe to spawn from here.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: NPX_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("only whitelists `npm install -g @yawlabs/mcph@latest` -- never arbitrary commands", async () => {
    const calls: [string, string[]][] = [];
    await maybeAutoUpgrade({
      currentVersion: "0.40.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: (cmd, args) => calls.push([cmd, args]),
    });
    expect(calls).toEqual([["npm", ["install", "-g", "@yawlabs/mcph@latest"]]]);
  });
});
