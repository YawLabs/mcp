import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFoundryArgs, runFoundryExport } from "../foundry-cmd.js";
import type { RankableServer } from "../relevance.js";

const SERVERS: RankableServer[] = [
  { namespace: "github", name: "GitHub", description: "issues pull requests", tools: [{ name: "create_issue" }] },
  { namespace: "slack", name: "Slack", description: "channels messages", tools: [{ name: "post_message" }] },
];

describe("parseFoundryArgs", () => {
  it("parses `export` with defaults", () => {
    const p = parseFoundryArgs(["export"]);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.options.action).toBe("export");
      expect(p.options.cap).toBeGreaterThan(0);
    }
  });

  it("parses --out / --cap / --json", () => {
    const p = parseFoundryArgs(["export", "--out", "x.json", "--cap", "50", "--json"]);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.options.out).toBe("x.json");
      expect(p.options.cap).toBe(50);
      expect(p.options.json).toBe(true);
    }
  });

  it("rejects an unknown action, a bad cap, and a missing action", () => {
    expect(parseFoundryArgs(["wat"]).ok).toBe(false);
    expect(parseFoundryArgs(["export", "--cap", "-1"]).ok).toBe(false);
    expect(parseFoundryArgs([]).ok).toBe(false);
  });
});

describe("runFoundryExport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-foundry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const silent = { write: () => {}, writeErr: () => {} };

  it("writes a corpus from injected traces + server catalog", async () => {
    const out = join(dir, "corpus.json");
    const blob = [
      JSON.stringify({ tokens: ["issue", "pull"], chosen: "github" }),
      JSON.stringify({ tokens: ["pull", "issue"], chosen: "github" }), // dedups -> weight 2
      JSON.stringify({ tokens: ["message", "channels"], chosen: "slack" }),
    ].join("\n");
    const r = await runFoundryExport({
      out,
      cap: 500,
      json: true,
      readTraces: () => blob,
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(0);
    const corpus = JSON.parse(readFileSync(out, "utf8"));
    expect(corpus.version).toBe(1);
    expect(corpus.servers).toHaveLength(2);
    const gh = corpus.entries.find((e: { chosen: string }) => e.chosen === "github");
    expect(gh.weight).toBe(2);
  });

  it("exits 1 when there is no harvest file", async () => {
    const r = await runFoundryExport({
      out: join(dir, "c.json"),
      cap: 500,
      json: false,
      readTraces: () => null,
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(1);
  });

  it("exits 2 when no chosen server is in the local catalog", async () => {
    const r = await runFoundryExport({
      out: join(dir, "c.json"),
      cap: 500,
      json: false,
      readTraces: () => JSON.stringify({ tokens: ["a", "b", "c"], chosen: "unknown" }),
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(2);
  });
});
