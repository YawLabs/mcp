import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLAG_ALIASES, KNOWN_SUBCOMMANDS, suggestFlag, suggestSubcommand } from "../subcommands.js";

// The dispatcher in index.ts runs at import time (top-level side effects),
// so it cannot be imported directly. The did-you-mean logic it uses lives
// in the side-effect-free ./subcommands.js helpers, which we test here.

describe("suggestSubcommand", () => {
  it("suggests a close subcommand for a bare typo", () => {
    expect(suggestSubcommand("instal")).toContain("install");
  });

  it("keeps `help` in the pool (halp -> help)", () => {
    // Regression: index.ts used to filter `help` out of the suggestion
    // pool, so `yaw-mcp halp` could never suggest `help`.
    expect(suggestSubcommand("halp")).toContain("help");
  });

  it("never suggests a leading-dash flag alias", () => {
    // Bare typos should only suggest real subcommands, not --help/-V etc.
    for (const input of ["versio", "hepl", "instal"]) {
      for (const s of suggestSubcommand(input)) {
        expect(s.startsWith("-")).toBe(false);
      }
    }
  });

  it("returns [] for a wild non-match", () => {
    expect(suggestSubcommand("zzzzzzzzzz")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(suggestSubcommand("set", 1).length).toBeLessThanOrEqual(1);
  });
});

describe("suggestFlag", () => {
  it("suggests --version for a long typo like --versionn", () => {
    expect(suggestFlag("--versionn")).toContain("--version");
  });

  it("suggests --help for --hepl", () => {
    expect(suggestFlag("--hepl")).toContain("--help");
  });

  it("returns only known flag aliases", () => {
    const aliases = [...FLAG_ALIASES];
    for (const s of suggestFlag("--versionn")) {
      expect(aliases).toContain(s);
    }
  });

  it("passes through short single-letter flags (no hijack of -v as -V)", () => {
    // A genuine server flag `-v` must NOT be intercepted by a case-only
    // match against `-V`; length-gating keeps short flags falling through.
    expect(suggestFlag("-v")).toEqual([]);
    expect(suggestFlag("-x")).toEqual([]);
  });

  it("passes through genuine long server flags with no close match", () => {
    expect(suggestFlag("--verbose")).toEqual([]);
    expect(suggestFlag("--config")).toEqual([]);
  });
});

describe("KNOWN_SUBCOMMANDS table", () => {
  it("includes foundry (dispatched in index.ts)", () => {
    expect(KNOWN_SUBCOMMANDS).toContain("foundry");
  });

  it("ends with the flag aliases", () => {
    for (const f of FLAG_ALIASES) {
      expect(KNOWN_SUBCOMMANDS).toContain(f);
    }
  });
});

// --- startup failure path ---------------------------------------------
//
// The dispatcher's top-level side effects mean index.ts cannot be imported,
// so this suite bundles it the way the shipped binary is built (esbuild,
// esm, node target) into a throwaway dir and runs it as a real process.
// Regression guarded: `runServer()` used to be fire-and-forget, so a fatal
// startup rejection (loadYawMcpConfig() throwing on a non-https,
// non-loopback YAW_MCP_URL) landed on the last-resort unhandledRejection
// handler -- logged as a JSON line, no server started, process exiting 0.
const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let workDir: string;
let bundlePath: string;

async function runEntry(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  // Scrub inherited YAW_MCP_* so a developer's own token / URL cannot
  // change which branch the child takes.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("YAW_MCP_")) delete childEnv[k];
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: workDir,
      env: { ...childEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    // If the fix regresses into a hang (server started despite a fatal
    // config), do not wedge the suite -- kill and let the assertion fail.
    const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", (err) => {
      clearTimeout(guard);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(guard);
      resolvePromise({ code, stderr });
    });
  });
}

describe("runServer startup failure", () => {
  beforeAll(async () => {
    const { build } = await import("esbuild");
    workDir = await mkdtemp(join(tmpdir(), "yaw-mcp-entry-"));
    bundlePath = join(workDir, "entry.mjs");
    await build({
      entryPoints: [INDEX_SRC],
      absWorkingDir: PROJECT_ROOT,
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      // Prefer each dep's ESM build, and hand bundled CJS a real require:
      // both keep the self-contained bundle runnable outside the repo.
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __yawCreateRequire } from "node:module";\nconst require = __yawCreateRequire(import.meta.url);',
      },
      define: { __VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
    });
  }, 60_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("exits 1 and prints a plain error line on a fatal startup config error", async () => {
    const { code, stderr } = await runEntry({ YAW_MCP_URL: "http://evil.example.com" });
    expect(code).toBe(1);
    expect(stderr).toContain("yaw-mcp: apiBase (source: env)");
    // Proof the .catch() -- not the last-resort handler -- caught it: the
    // handler would emit a JSON log line and let the process exit 0.
    expect(stderr).not.toContain('"unhandledRejection"');
  });

  it("still registers the last-resort handlers before the first await", async () => {
    // The exit-1 path must not be bought by deleting the net that covers
    // genuine post-startup rejections (e.g. a late-rejecting upstream
    // connect), which must keep logging without killing the server.
    const src = await readFile(INDEX_SRC, "utf8");
    const rejectionIdx = src.indexOf('process.on("unhandledRejection"');
    const exceptionIdx = src.indexOf('process.on("uncaughtException"');
    const firstAwaitIdx = src.indexOf("await loadYawMcpConfig(");
    expect(rejectionIdx).toBeGreaterThan(-1);
    expect(exceptionIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(rejectionIdx).toBeLessThan(firstAwaitIdx);
    expect(exceptionIdx).toBeLessThan(firstAwaitIdx);
  });
});
