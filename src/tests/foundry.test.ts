import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFoundryTrace, isFoundryEnabled, redactIntent } from "../foundry.js";

describe("isFoundryEnabled", () => {
  const orig = process.env.YAW_MCP_FOUNDRY;

  afterEach(() => {
    if (orig === undefined) delete process.env.YAW_MCP_FOUNDRY;
    else process.env.YAW_MCP_FOUNDRY = orig;
  });

  it("is disabled by default (unset)", () => {
    delete process.env.YAW_MCP_FOUNDRY;
    expect(isFoundryEnabled()).toBe(false);
  });

  it('is enabled when "1"', () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    expect(isFoundryEnabled()).toBe(true);
  });

  it('is enabled when "true" (case-insensitive, trimmed)', () => {
    process.env.YAW_MCP_FOUNDRY = " TRUE ";
    expect(isFoundryEnabled()).toBe(true);
  });

  it('is disabled for "0" / "false" / garbage', () => {
    for (const v of ["0", "false", "yes", "on", "nope"]) {
      process.env.YAW_MCP_FOUNDRY = v;
      expect(isFoundryEnabled()).toBe(false);
    }
  });
});

describe("redactIntent", () => {
  it("drops a sk_live_...-style secret token but keeps normal words", () => {
    // tokenize splits on non-alphanumerics, so the secret reaches redaction
    // as a single long alphanumeric run beginning with the sk_ prefix...
    // except `_` is a non-alphanumeric, so `sk_live_xxxx` would split. Use a
    // prefix form that survives splitting AND a long high-entropy form.
    const r = redactIntent("please use sk_live4242aaaa9999bbbb8888cccc to authenticate");
    // "sk" alone survives as a short token; the long mixed run is dropped.
    // The token containing the live key material is the long high-entropy one.
    expect(r.tokens).toContain("please");
    expect(r.tokens).toContain("use");
    expect(r.tokens).toContain("authenticate");
    // The long mixed alphanumeric run must be gone.
    expect(r.tokens.some((t) => t.includes("4242aaaa9999bbbb"))).toBe(false);
    expect(r.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("drops a known secret prefix token (xox)", () => {
    // xox has no underscore in the prefix, so the Slack-token run survives
    // tokenize as one piece and is dropped by the prefix rule.
    const r = redactIntent("token xoxbabcdef0123456789 here");
    expect(r.tokens).toContain("token");
    expect(r.tokens).toContain("here");
    expect(r.tokens.some((t) => t.startsWith("xox"))).toBe(false);
    expect(r.redactedCount).toBe(1);
  });

  it("drops a long pure-hex token (>= 16 chars)", () => {
    const r = redactIntent("commit deadbeefcafef00d1234 and move on");
    expect(r.tokens).toContain("commit");
    expect(r.tokens).toContain("and");
    expect(r.tokens).toContain("move");
    expect(r.tokens).not.toContain("deadbeefcafef00d1234");
    expect(r.redactedCount).toBe(1);
  });

  it("keeps ordinary words (sorted, order destroyed) and reports redactedCount 0", () => {
    const r = redactIntent("create a github pull request for the docs");
    // Tokens are SORTED so word order can't reconstruct the sentence.
    expect(r.tokens).toEqual(["create", "docs", "for", "github", "pull", "request", "the"]);
    expect(r.redactedCount).toBe(0);
  });

  it("drops a long pure-alpha passphrase-style secret", () => {
    const r = redactIntent("login with correcthorsebatterystaple please");
    expect(r.tokens).not.toContain("correcthorsebatterystaple");
    expect(r.tokens).toContain("login");
    expect(r.tokens).toContain("with");
    expect(r.tokens).toContain("please");
    expect(r.redactedCount).toBe(1);
  });

  it("drops a 12-19 char mixed letter+digit key (below the old 20 floor)", () => {
    const r = redactIntent("key a1b2c3d4e5f6g7 here");
    expect(r.tokens).not.toContain("a1b2c3d4e5f6g7");
    expect(r.tokens).toContain("key");
    expect(r.tokens).toContain("here");
    expect(r.redactedCount).toBe(1);
  });

  it("counts every dropped token", () => {
    // AKIA-prefixed (AWS key id) + a long pure-hex digest both drop; the
    // ordinary words survive.
    const r = redactIntent("AKIAIOSFODNN7EXAMPLE and deadbeefcafef00d0011 plus normalword");
    expect(r.redactedCount).toBe(2);
    expect(r.tokens).toContain("and");
    expect(r.tokens).toContain("plus");
    expect(r.tokens).toContain("normalword");
  });
});

describe("appendFoundryTrace", () => {
  let home: string;
  const orig = process.env.YAW_MCP_FOUNDRY;

  const trace = {
    tokens: ["create", "issue"],
    candidates: [
      { ns: "gh", score: 0.9 },
      { ns: "gitlab", score: 0.4 },
    ],
    chosen: "gh",
    redactedCount: 1,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-foundry-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (orig === undefined) delete process.env.YAW_MCP_FOUNDRY;
    else process.env.YAW_MCP_FOUNDRY = orig;
  });

  it("is a no-op when disabled (no file written)", async () => {
    delete process.env.YAW_MCP_FOUNDRY;
    await expect(appendFoundryTrace(trace, home)).resolves.toBeUndefined();
    expect(() => readFileSync(join(home, ".yaw-mcp", "foundry.jsonl"), "utf8")).toThrow();
  });

  it("writes one JSON line when enabled, with no raw intent", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    await appendFoundryTrace(trace, home);
    const file = join(home, ".yaw-mcp", "foundry.jsonl");
    const contents = readFileSync(file, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    // Scores are stripped on write to avoid stale-state replay bias on traces.
    expect(parsed).toEqual({
      ...trace,
      candidates: trace.candidates.map((c) => ({ ns: c.ns })),
    });
  });

  it("appends additional lines on repeat calls", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    await appendFoundryTrace(trace, home);
    await appendFoundryTrace(trace, home);
    const file = join(home, ".yaw-mcp", "foundry.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("never throws even when the home path is invalid", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    // A path with a NUL byte cannot be created; the helper must swallow it.
    await expect(appendFoundryTrace(trace, "\0bad")).resolves.toBeUndefined();
  });
});
