import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_NUDGE_COOLDOWN_MS,
  INSTALL_NUDGE_MIN_COUNT,
  INSTALL_NUDGE_STATE_FILENAME,
  installNudgeEnabled,
  installNudgeStatePath,
  recordNudge,
  shouldNudge,
} from "../install-nudge.js";
import { CONFIG_DIRNAME } from "../paths.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-nudge-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("installNudgeEnabled (the gate)", () => {
  it("is OFF by default (env unset, config null/empty)", () => {
    expect(installNudgeEnabled({}, null)).toBe(false);
    expect(installNudgeEnabled({}, {})).toBe(false);
    expect(installNudgeEnabled({}, { installNudge: false })).toBe(false);
  });

  it("env YAW_MCP_INSTALL_NUDGE=1 enables it", () => {
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "1" }, null)).toBe(true);
  });

  it("config installNudge:true enables it", () => {
    expect(installNudgeEnabled({}, { installNudge: true })).toBe(true);
  });

  it("only a literal '1' enables via env (no truthy coercion)", () => {
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "true" }, null)).toBe(false);
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "yes" }, null)).toBe(false);
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "0" }, null)).toBe(false);
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "" }, null)).toBe(false);
  });

  it("env OR config — either independently flips it on", () => {
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "1" }, { installNudge: false })).toBe(true);
    expect(installNudgeEnabled({ YAW_MCP_INSTALL_NUDGE: "0" }, { installNudge: true })).toBe(true);
  });
});

describe("install-nudge constants", () => {
  it("threshold is 5", () => {
    expect(INSTALL_NUDGE_MIN_COUNT).toBe(5);
  });

  it("state path lives under ~/.yaw-mcp/", () => {
    expect(installNudgeStatePath(home)).toBe(join(home, CONFIG_DIRNAME, INSTALL_NUDGE_STATE_FILENAME));
  });
});

describe("shouldNudge / recordNudge cadence", () => {
  it("a CLI never nudged should be nudged", () => {
    expect(shouldNudge("tailscale", home)).toBe(true);
  });

  it("after recordNudge, the same CLI is suppressed within the cooldown", () => {
    const t0 = 1_000_000_000;
    recordNudge("tailscale", home, () => t0);
    // 1 day later — still inside the 7-day cooldown.
    expect(shouldNudge("tailscale", home, () => t0 + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("re-nudges once the cooldown has fully elapsed", () => {
    const t0 = 1_000_000_000;
    recordNudge("tailscale", home, () => t0);
    expect(shouldNudge("tailscale", home, () => t0 + INSTALL_NUDGE_COOLDOWN_MS)).toBe(true);
    expect(shouldNudge("tailscale", home, () => t0 + INSTALL_NUDGE_COOLDOWN_MS + 1)).toBe(true);
  });

  it("suppression is per-CLI — recording one does not suppress another", () => {
    const t0 = 1_000_000_000;
    recordNudge("tailscale", home, () => t0);
    expect(shouldNudge("tailscale", home, () => t0)).toBe(false);
    expect(shouldNudge("psql", home, () => t0)).toBe(true);
  });

  it("persists multiple CLIs in one state file (read-modify-write)", () => {
    const t0 = 1_000_000_000;
    recordNudge("tailscale", home, () => t0);
    recordNudge("psql", home, () => t0 + 10);
    const state = JSON.parse(readFileSync(installNudgeStatePath(home), "utf8"));
    const clis = state.nudges.map((n: { cli: string }) => n.cli).sort();
    expect(clis).toEqual(["psql", "tailscale"]);
  });

  it("re-recording the same CLI replaces (not duplicates) its entry, refreshing the timestamp", () => {
    const t0 = 1_000_000_000;
    recordNudge("tailscale", home, () => t0);
    recordNudge("tailscale", home, () => t0 + 60_000);
    const state = JSON.parse(readFileSync(installNudgeStatePath(home), "utf8"));
    expect(state.nudges).toHaveLength(1);
    expect(state.nudges[0].nudgedAt).toBe(t0 + 60_000);
  });

  it("prunes entries whose cooldown has fully lapsed on the next write", () => {
    const t0 = 1_000_000_000;
    recordNudge("psql", home, () => t0);
    // Record a different CLI well past psql's cooldown — psql should be pruned.
    recordNudge("tailscale", home, () => t0 + INSTALL_NUDGE_COOLDOWN_MS + 1);
    const state = JSON.parse(readFileSync(installNudgeStatePath(home), "utf8"));
    const clis = state.nudges.map((n: { cli: string }) => n.cli);
    expect(clis).toEqual(["tailscale"]);
  });
});

describe("fail-open behavior", () => {
  it("shouldNudge returns true when the state file is corrupt JSON", () => {
    const dir = join(home, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(installNudgeStatePath(home), "{not json", "utf8");
    expect(shouldNudge("tailscale", home)).toBe(true);
  });

  it("shouldNudge returns true when the state file has a wrong shape", () => {
    const dir = join(home, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    // nudges is not an array — treat as empty.
    writeFileSync(installNudgeStatePath(home), JSON.stringify({ nudges: "nope" }), "utf8");
    expect(shouldNudge("tailscale", home)).toBe(true);
  });

  it("ignores malformed individual records but honors well-formed ones", () => {
    const t0 = 1_000_000_000;
    const dir = join(home, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      installNudgeStatePath(home),
      JSON.stringify({
        nudges: [
          { cli: 123, nudgedAt: t0 }, // bad cli type — dropped
          { cli: "tailscale" }, // missing nudgedAt — dropped
          { cli: "psql", nudgedAt: t0 }, // good
        ],
      }),
      "utf8",
    );
    expect(shouldNudge("psql", home, () => t0 + 1000)).toBe(false); // honored
    expect(shouldNudge("tailscale", home, () => t0 + 1000)).toBe(true); // dropped -> never nudged
  });

  it("recordNudge does not throw and creates the ~/.yaw-mcp dir if missing", () => {
    expect(existsSync(join(home, CONFIG_DIRNAME))).toBe(false);
    expect(() => recordNudge("tailscale", home, () => 1)).not.toThrow();
    expect(existsSync(installNudgeStatePath(home))).toBe(true);
  });
});
