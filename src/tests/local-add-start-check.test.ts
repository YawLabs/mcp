import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// defaultStartCheck is `add`'s (and `update`'s) one real handshake. The seam
// is the same pair transient-upstream.test.ts mocks: nothing here spawns a
// child process.
vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn(async (c: { status: string }) => {
      c.status = "disconnected";
    }),
  };
});

import { defaultStartCheck } from "../local-add-cmd.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "../upstream.js";

const CONFIG = {
  id: "local-fx",
  name: "fx",
  namespace: "fx",
  type: "local",
  command: "node",
  isActive: true,
} as UpstreamServerConfig;

let home: string;
let paths: { home: string; cwd: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-start-check-"));
  paths = { home, cwd: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(disconnectFromUpstream).mockClear();
});

describe("defaultStartCheck", () => {
  it("counts the tools and disconnects", async () => {
    const conn = { config: CONFIG, status: "connected", tools: [{}, {}] } as unknown as UpstreamConnection;
    vi.mocked(connectToUpstream).mockResolvedValue(conn);

    expect(await defaultStartCheck(CONFIG, paths)).toEqual({ ok: true, tools: 2 });
    expect(disconnectFromUpstream).toHaveBeenCalledTimes(1);
    expect(disconnectFromUpstream).toHaveBeenCalledWith(conn);
  });

  it("words an activation failure for a shell, not for an MCP client", async () => {
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError(
        'spawn failed -> Fix "fx" in bundles.json, then activate it again on the next mcp_connect_* call.',
        "unknown" as ConstructorParameters<typeof ActivationError>[1],
        undefined,
        undefined,
        { summary: "spawn failed", fix: 'Fix "fx" in bundles.json' },
      ),
    );

    expect(await defaultStartCheck(CONFIG, paths)).toEqual({
      ok: false,
      error: 'spawn failed -> Fix "fx" in bundles.json, then run the command again.',
    });
    expect(disconnectFromUpstream).not.toHaveBeenCalled();
  });

  it.each([
    ["a blocked server", '{ "blocked": ["fx"] }', "not allowed by the project profile"],
    ["a broken policy file", "{", "no MCP server may start"],
  ])("does not start %s", async (_name, config, text) => {
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(home, ".yaw-mcp", "config.json"), config);
    const result = await defaultStartCheck(CONFIG, paths);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(text);
    expect(connectToUpstream).not.toHaveBeenCalled();
  });

  it("judges a git server by its repository too, not only by its build", async () => {
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(join(home, ".yaw-mcp", "config.json"), '{ "blocked": ["url:https://github.com/acme/fx"] }');
    const stored = {
      ...CONFIG,
      git: { url: "https://github.com/acme/fx.git", ref: "main", commit: "abc", entry: "i.js" },
    };
    const result = await defaultStartCheck(CONFIG, { ...paths, policyAs: stored as typeof CONFIG });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("not allowed by the project profile");
    expect(connectToUpstream).not.toHaveBeenCalled();
  });

  it("passes an error with no config pointer through verbatim", async () => {
    // startRemedy matches on the "vault locked:" prefix, so this text must
    // arrive unchanged.
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("vault locked: the passphrase does not unlock the vault"));

    expect(await defaultStartCheck(CONFIG, paths)).toEqual({
      ok: false,
      error: "vault locked: the passphrase does not unlock the vault",
    });
  });
});
