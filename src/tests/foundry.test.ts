import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // Two layers can catch this now: the raw-string prefix scrub eats
    // `sk_...` whole before tokenize sees it, and even if it did not, the
    // long mixed letter+digit run left behind trips the entropy rule. Either
    // way no fragment of the key material reaches the bag.
    const r = redactIntent("please use sk_live4242aaaa9999bbbb8888cccc to authenticate");
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

  it("strips punctuated secret prefixes on the RAW intent, before tokenize splits them", () => {
    // REGRESSION: every SECRET_PREFIXES entry containing '_' or '-' was dead
    // code. looksSensitive only ever sees tokenize() output, which is always a
    // bare [a-z0-9]+ run, so `token.startsWith("ghp_")` could never be true.
    // These now match on the raw string, where the punctuation still exists.
    for (const secret of [
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "gho_16C7e42F292c6912E7710c838347Ae178B4a",
      "sk-proj-AbCd1234EfGh5678",
      "sk_test_51H8xTestKeyMaterial",
      "tok_1JKlmNOpQrStUvWx",
      "pk_live_ZZTopKeyMaterial",
    ]) {
      const r = redactIntent(`deploy with ${secret} now`);
      expect(r.tokens).toEqual(["deploy", "now", "with"]);
      expect(r.redactedCount).toBe(1);
    }
  });

  it("does not scrub an ordinary hyphenated word that merely contains a prefix", () => {
    // The `(?<![A-Za-z0-9])` boundary keeps the raw pattern off the "sk-" in
    // "task-list"; only a prefix at a real token boundary counts.
    const r = redactIntent("update the task-list and risk-report");
    expect(r.redactedCount).toBe(0);
    expect(r.tokens).toEqual(expect.arrayContaining(["task", "list", "risk", "report"]));
  });

  it("strips an email address before tokenize and increments redactedCount", () => {
    // The RAW_PII_PATTERNS email regex fires on the raw string before tokenize()
    // shreds it. The whole address is replaced with a space, so "user",
    // "example", and "com" never reach the token bag.
    const r = redactIntent("send email to user@example.com");
    expect(r.redactedCount).toBe(1);
    expect(r.tokens).not.toContain("user");
    expect(r.tokens).not.toContain("example");
    expect(r.tokens).not.toContain("com");
    // Ordinary words from the rest of the intent survive.
    expect(r.tokens).toContain("send");
    expect(r.tokens).toContain("email");
  });

  it("keeps short identifiers (pg, gh, s3) -- harvest tokenizes at the ranker's 1-char floor", () => {
    // Harvesting with the 3-char prose tokenizer deleted every short
    // identifier from the corpus, so rankServers (which tokenizes queries at
    // the 1-char floor) could never be scored on the very tokens that matter.
    const r = redactIntent("use pg and gh to check the s3 bucket");
    expect(r.tokens).toEqual(expect.arrayContaining(["pg", "gh", "s3"]));
    // Closed-class sub-floor words still stay out of the bag.
    expect(r.tokens).not.toContain("to");
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

  it("does not append when foundry.jsonl is already at the 5 MiB cap", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    const dir = join(home, ".yaw-mcp");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "foundry.jsonl");
    // Write exactly MAX_FOUNDRY_BYTES (5 MiB) of content so stat().size >= cap.
    const MAX_FOUNDRY_BYTES = 5 * 1024 * 1024;
    writeFileSync(file, Buffer.alloc(MAX_FOUNDRY_BYTES, "x"));
    const sizeBefore = MAX_FOUNDRY_BYTES;
    await appendFoundryTrace(trace, home);
    const sizeAfter = readFileSync(file).length;
    expect(sizeAfter).toBe(sizeBefore);
  });
});
