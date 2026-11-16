import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRunningInstallPrefix, maybeAutoUpgrade } from "../auto-upgrade.js";
import { log } from "../logger.js";

// The global-npm + no-prefix refusal in maybeAutoUpgrade, with the REAL
// realpathSync. auto-upgrade.test.ts stubs node:fs file-wide (an identity
// realpath), so it can only reach this branch through the linked-checkout
// shape -- a path that resolves, to somewhere outside node_modules. The other
// way in is a realpath that THROWS, and that one can be a genuine global
// install: the log line must not tell that user their copy is a linked
// checkout. A separate file so the throw is the real thing, not a second mock.

vi.mock("../logger.js", () => ({ log: vi.fn() }));
const mockLog = vi.mocked(log);

// Classifies as global-npm on the literal path (an nvm-managed Node root, a
// marker that is not anchored at the filesystem root), and does not exist on
// any machine the suite runs on, so realpathSync throws ENOENT for it.
const MISSING_GLOBAL_PATH = join(
  sep,
  "yaw-mcp-test-no-such-root",
  ".nvm",
  "versions",
  "node",
  "v0.0.0",
  "lib",
  "node_modules",
  "@yawlabs",
  "mcp",
  "dist",
  "index.js",
);

describe("background upgrade refusal when the running copy's path does not resolve", () => {
  let savedOptOut: string | undefined;

  beforeEach(() => {
    savedOptOut = process.env.YAW_MCP_AUTO_UPGRADE;
    delete process.env.YAW_MCP_AUTO_UPGRADE;
    mockLog.mockClear();
  });

  afterEach(() => {
    if (savedOptOut === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
    else process.env.YAW_MCP_AUTO_UPGRADE = savedOptOut;
  });

  it("does not spawn, and names an unresolvable path as a cause beside the linked checkout", async () => {
    // Precondition: this really is the realpath-throws route to a null prefix,
    // not a path that resolved to somewhere without a node_modules segment.
    expect(detectRunningInstallPrefix(MISSING_GLOBAL_PATH)).toBeNull();

    const spawnImpl = vi.fn();
    const acquireLockImpl = vi.fn(() => () => {});
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: MISSING_GLOBAL_PATH,
      isSeaImpl: async () => false,
      checkedRecentlyImpl: () => null,
      recordCheckImpl: () => {},
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
      acquireLockImpl,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(acquireLockImpl).not.toHaveBeenCalled();
    const said = mockLog.mock.calls.filter(
      (c) => c[0] === "info" && String(c[1]).includes("not upgrading in the background"),
    );
    expect(said).toHaveLength(1);
    const msg = String(said[0][1]);
    expect(msg).toContain("its path could not be resolved");
    // The link is offered as one possibility, never as the diagnosis.
    expect(msg).toContain("Either it is a linked checkout");
    expect(msg).not.toContain("probably a linked checkout");
  });
});
