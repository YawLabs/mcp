// `yaw-mcp secrets set` reads bundles.json after the save. What that load
// warns about has to reach the caller's `err` sink in the mode's own shape:
// prose that says where or why the file was unusable, and under --json one
// JSON object per line -- for the loader's own warnings AND for the ones its
// project-dir walk and trust-store read still send through logger.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogSurface } from "../logger.js";
import { runSecrets } from "../secrets-cmd.js";
import { lock } from "../secrets-vault.js";
import { TRUST_BYPASS_ENV, trustStorePath } from "../trust.js";

const PASS = "a-long-enough-passphrase";

describe("runSecrets set -- warnings from the bundles.json load", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;
  let cwd: string;

  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const bundlesPath = (): string => nodePath.join(home, ".yaw-mcp", "bundles.json");

  /** One `set`, with whatever reached the real process.stderr. */
  async function set(name: string, json: boolean): Promise<string> {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const r = await runSecrets(
        { action: "set", name, value: "v-123456", passphrase: PASS, force: true, home, cwd, json },
        io,
      );
      expect(r.exitCode).toBe(0);
    } finally {
      spy.mockRestore();
    }
    return written.join("");
  }

  /** Create the vault first, so a later `set` prints no creation nudge. */
  async function seed(): Promise<void> {
    await set("SEED", false);
    lock();
    io.out.mockReset();
    io.err.mockReset();
  }

  /** A project bundles.json plus a trust store whose version is a string:
   *  readTrustStore warns through logger.ts, off the loader's warning sink. */
  function writeProjectFileAndCorruptTrustStore(): void {
    mkdirSync(nodePath.join(cwd, ".yaw-mcp"), { recursive: true });
    writeFileSync(nodePath.join(cwd, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers: [] }));
    mkdirSync(nodePath.dirname(trustStorePath(home)), { recursive: true });
    writeFileSync(trustStorePath(home), JSON.stringify({ version: "1", trusted: {} }));
  }

  beforeEach(() => {
    vi.stubEnv(TRUST_BYPASS_ENV, "");
    // The plain rendering is the default only without YAW_MCP_LOG_LEVEL.
    vi.stubEnv("YAW_MCP_LOG_LEVEL", "");
    vi.stubEnv("LOG_LEVEL", "");
    io.out.mockReset();
    io.err.mockReset();
    home = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-bundles-warn-"));
    // cwd under the fake home, so the project walk cannot climb out of it.
    cwd = nodePath.join(home, "proj");
    mkdirSync(cwd);
  });

  afterEach(() => {
    setLogSurface("server");
    vi.unstubAllEnvs();
    lock();
    rmSync(home, { recursive: true, force: true });
  });

  it("text: an invalid bundles.json is named with the position the parse failed at", async () => {
    await seed();
    mkdirSync(nodePath.dirname(bundlesPath()), { recursive: true });
    writeFileSync(bundlesPath(), "{ not json");
    await set("OTHER", false);
    expect(errText()).toBe(
      `yaw-mcp secrets: warning -- bundles.json is not valid JSON; ignoring (${bundlesPath()}; at line 1, column 3).\n`,
    );
  });

  it("text: an unreadable bundles.json is named with the cause and the errno", async () => {
    await seed();
    // A directory at the file's path: a read error on every platform.
    mkdirSync(bundlesPath(), { recursive: true });
    await set("OTHER", false);
    const err = errText();
    expect(err.startsWith(`yaw-mcp secrets: warning -- Could not read bundles.json (${bundlesPath()}; error=`)).toBe(
      true,
    );
    expect(err).toMatch(/; code=EISDIR\)\.\n$/);
  });

  it("--json: a logger.ts warn from the trust-store read is a JSON line on err, not prose on stderr (CLI surface)", async () => {
    await seed();
    writeProjectFileAndCorruptTrustStore();
    setLogSurface("cli");
    const stderr = await set("LS", true);
    expect(stderr).toBe("");
    const lines = errText().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const trust = parsed.filter((p) => String(p.message).includes("Trust store has a non-numeric version"));
    expect(trust.length).toBeGreaterThan(0);
    for (const p of trust) {
      expect(p.warning).toBe("bundles-load");
      expect(String(p.message)).toContain(trustStorePath(home));
      expect(String(p.message)).not.toMatch(/^yaw-mcp: /);
    }
  });

  it("--json: the same warn as a structured logger record is re-keyed on `warning`", async () => {
    await seed();
    writeProjectFileAndCorruptTrustStore();
    setLogSurface("server");
    // The server surface also emits info records; only the warn is in scope.
    vi.stubEnv("LOG_LEVEL", "warn");
    const stderr = await set("LS", true);
    expect(stderr).toBe("");
    const parsed = errText()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toContainEqual({
      warning: "bundles-load",
      message: "Trust store has a non-numeric version; nothing is trusted",
      path: trustStorePath(home),
    });
    // Nothing on err is a bare logger record.
    expect(parsed.filter((p) => "level" in p)).toEqual([]);
  });

  it("text: the logger line stays on process.stderr, where it was", async () => {
    await seed();
    writeProjectFileAndCorruptTrustStore();
    setLogSurface("cli");
    const stderr = await set("LS", false);
    expect(stderr).toContain("yaw-mcp: warning: Trust store has a non-numeric version; nothing is trusted");
    expect(errText()).not.toContain("Trust store");
  });
});
