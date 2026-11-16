// Coverage gaps around secrets: the line-break shape after "Missing required:"
// in credential detection, and the pass-through of non-warn JSON records that
// `secrets set --json` holds off process.stderr during its bundles.json load.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMissingCredentials } from "../credentials.js";
import { setLogSurface } from "../logger.js";
import { runSecrets } from "../secrets-cmd.js";
import { lock } from "../secrets-vault.js";
import { TRUST_BYPASS_ENV, trustStorePath } from "../trust.js";

describe("detectMissingCredentials -- a line break right after 'required'", () => {
  it("'Missing required:' followed by a newline (LF or CRLF) still elicits the listed name", () => {
    expect(detectMissingCredentials("Missing required:\n  OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing required:\r\n  OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
  });

  it("colon-less 'Missing required' followed by a newline elicits nothing", () => {
    expect(detectMissingCredentials("Missing required\nOPENAI_API_KEY")).toEqual([]);
  });
});

const PASS = "a-long-enough-passphrase";

describe("runSecrets set --json -- non-warn records held off stderr pass through", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;
  let cwd: string;

  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

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

  beforeEach(() => {
    vi.stubEnv(TRUST_BYPASS_ENV, "");
    vi.stubEnv("YAW_MCP_LOG_LEVEL", "");
    vi.stubEnv("LOG_LEVEL", "");
    io.out.mockReset();
    io.err.mockReset();
    home = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-secrets-gaps-"));
    cwd = nodePath.join(home, "proj");
    mkdirSync(cwd);
  });

  afterEach(() => {
    setLogSurface("server");
    vi.unstubAllEnvs();
    lock();
    rmSync(home, { recursive: true, force: true });
  });

  it("a debug/info logger record passes through as a logger record, only warn/error are relabelled bundles-load", async () => {
    // Create the vault first, so the measured `set` prints no creation nudge.
    await set("SEED", false);
    lock();
    io.out.mockReset();
    io.err.mockReset();

    mkdirSync(nodePath.join(cwd, ".yaw-mcp"), { recursive: true });
    writeFileSync(nodePath.join(cwd, ".yaw-mcp", "bundles.json"), JSON.stringify({ version: 1, servers: [] }));
    mkdirSync(nodePath.dirname(trustStorePath(home)), { recursive: true });
    writeFileSync(trustStorePath(home), JSON.stringify({ version: "1", trusted: {} }));

    setLogSurface("server");
    vi.stubEnv("LOG_LEVEL", "debug");
    const stderr = await set("LS", true);
    expect(stderr).toBe("");

    const lines = errText().split("\n").filter(Boolean);
    // Every line on err is one JSON object.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // The trust-store warn is relabelled.
    expect(parsed).toContainEqual({
      warning: "bundles-load",
      message: "Trust store has a non-numeric version; nothing is trusted",
      path: trustStorePath(home),
    });

    // At least one non-warn record reached err, as the logger wrote it.
    const passthrough = parsed.filter((p) => "level" in p);
    expect(passthrough.length).toBeGreaterThan(0);
    for (const p of passthrough) {
      expect(p.level === "warn" || p.level === "error").toBe(false);
      expect(p).not.toHaveProperty("warning");
      expect(typeof p.msg).toBe("string");
    }

    // Only warn/error records carry the bundles-load label: every relabelled
    // line carries a message, none carries a level.
    for (const p of parsed.filter((q) => q.warning === "bundles-load")) {
      expect(p).not.toHaveProperty("level");
      expect(typeof p.message).toBe("string");
    }
  });
});
