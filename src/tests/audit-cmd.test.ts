import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_USAGE, parseAuditArgs, runAudit } from "../audit-cmd.js";
import { gradesCachePath, readGradesCache, writeGrade } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

/** Build a throwaway home dir with a ~/.yaw-mcp/bundles.json. */
function makeHome(servers: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), "yaw-audit-"));
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }, null, 2));
  return home;
}

describe("parseAuditArgs", () => {
  it("requires a namespace", () => {
    const r = parseAuditArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing <namespace>");
  });

  it("parses a namespace", () => {
    expect(parseAuditArgs(["ctxlint"])).toEqual({ ok: true, options: { namespace: "ctxlint", json: false } });
  });

  it("accepts --json", () => {
    expect(parseAuditArgs(["ctxlint", "--json"])).toEqual({
      ok: true,
      options: { namespace: "ctxlint", json: true },
    });
  });

  it("rejects unknown flags", () => {
    const r = parseAuditArgs(["ctxlint", "--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("rejects a second positional", () => {
    const r = parseAuditArgs(["a", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unexpected extra argument");
  });

  it("--help returns usage", () => {
    const r = parseAuditArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(AUDIT_USAGE);
  });
});

describe("runAudit", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("audits a stdio server and writes the grade", async () => {
    home = makeHome([
      { namespace: "ctxlint", name: "ctxlint", type: "local", command: "node", args: ["x.js", "--mcp-server"] },
    ]);
    const io = captureIO();
    let seen: { command: string; args: string[] } | null = null;
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async (target) => {
        seen = { command: target.command, args: target.args };
        return { grade: "A", score: 97.5 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual({ command: "node", args: ["x.js", "--mcp-server"] });

    const cache = await readGradesCache(home);
    expect(cache.ctxlint.grade).toBe("A");
    expect(cache.ctxlint.score).toBe(97.5);
    expect(typeof cache.ctxlint.gradedAt).toBe("string");
    expect(io.out.join("\n")).toContain("Grade: A");
  });

  it("emits PURE JSON with --json (no human preamble)", async () => {
    // The Yaw MCP panel parses this stdout directly, so in --json mode the
    // ENTIRE output must be the JSON object -- no "Auditing..." preamble. A
    // preamble whose text could contain a brace (a server arg like
    // --config={...}) would otherwise corrupt brace-based extraction and
    // misreport a passing audit as a failure. Pins that fix.
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: ['--config={"port":1}'] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "B", score: 80 }),
    });
    expect(r.exitCode).toBe(0);
    const stdout = io.out.join("\n");
    expect(stdout).not.toContain("Auditing");
    // The whole stdout parses as JSON directly -- no leading lines to skip.
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ namespace: "ctxlint", grade: "B", score: 80 });
  });

  it("exit 1 when the namespace is not in bundles.json", async () => {
    home = makeHome([{ namespace: "other", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(r.exitCode).toBe(1);
    expect(io.err.join("\n")).toContain('no server named "ctxlint"');
  });

  it("exit 2 for a remote (url-only) server", async () => {
    home = makeHome([{ namespace: "remote", type: "remote", url: "https://example.com/mcp" }]);
    const io = captureIO();
    let ran = false;
    const r = await runAudit({
      namespace: "remote",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        ran = true;
        return { grade: "A", score: 100 };
      },
    });
    expect(r.exitCode).toBe(2);
    expect(ran).toBe(false);
    expect(io.err.join("\n")).toContain("yaw-mcp compliance https://example.com/mcp");
  });

  it("exit 2 when the suite throws", async () => {
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("\n")).toContain("compliance suite failed");
  });
});

describe("grades-cache", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-grades-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a written grade", async () => {
    await writeGrade("ctxlint", { grade: "A", score: 100, gradedAt: "2026-06-11T00:00:00.000Z" }, home);
    const cache = await readGradesCache(home);
    expect(cache.ctxlint).toEqual({ grade: "A", score: 100, gradedAt: "2026-06-11T00:00:00.000Z" });
  });

  it("preserves existing entries on a new write", async () => {
    await writeGrade("a", { grade: "A", score: 100, gradedAt: "t1" }, home);
    await writeGrade("b", { grade: "C", score: 60, gradedAt: "t2" }, home);
    const cache = await readGradesCache(home);
    expect(Object.keys(cache).sort()).toEqual(["a", "b"]);
  });

  it("returns {} for a missing cache", async () => {
    expect(await readGradesCache(home)).toEqual({});
  });

  it("ignores a malformed cache file", async () => {
    writeFileSync(gradesCachePath(home), "{ not json");
    expect(await readGradesCache(home)).toEqual({});
  });

  it("drops malformed entries but keeps valid ones", async () => {
    writeFileSync(
      gradesCachePath(home),
      JSON.stringify({
        good: { grade: "A", score: 100, gradedAt: "t" },
        badGrade: { grade: "Z", score: 100, gradedAt: "t" },
        noScore: { grade: "B", gradedAt: "t" },
      }),
    );
    const cache = await readGradesCache(home);
    expect(Object.keys(cache)).toEqual(["good"]);
  });
});
