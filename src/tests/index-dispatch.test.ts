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

  it("suggests the alias for a case-variant of a long flag (--HELP -> --help)", () => {
    // Ship blocker regression: the "never suggest yourself" skip used to be
    // case-INSENSITIVE, so `--HELP` dropped `--help` from the candidate pool.
    // Every remaining alias is >2 edits away, so suggestFlag returned [] and
    // index.ts fell through to runServer -- booting a stdio MCP server that
    // hangs on a dead prompt with no output. The skip must be an exact RAW
    // match; index.ts already dispatches the raw spellings by === earlier.
    expect(suggestFlag("--HELP")).toEqual(["--help"]);
    expect(suggestFlag("--VERSION")).toEqual(["--version"]);
  });

  it("suggests the alias for a mixed-case variant (--Help / --Version)", () => {
    expect(suggestFlag("--Help")).toContain("--help");
    expect(suggestFlag("--VerSion")).toContain("--version");
  });

  it("never suggests itself for a raw-identical alias", () => {
    // Unreachable from index.ts (raw === dispatch happens first) but the
    // helper must not emit `unknown flag "--help". Did you mean: --help?`.
    for (const alias of FLAG_ALIASES) {
      expect(suggestFlag(alias)).not.toContain(alias);
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
// startup rejection landed on the last-resort unhandledRejection handler --
// logged as a JSON line, no server started, process exiting 0. The `.catch()`
// on runServer() is what makes that path print and exit 1 instead.
const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let workDir: string;
let bundlePath: string;

async function runEntry(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number | null; stderr: string }> {
  // Scrub inherited YAW_MCP_* so a developer's own token / URL cannot
  // change which branch the child takes.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("YAW_MCP_")) delete childEnv[k];
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bundlePath, ...args], {
      cwd: workDir,
      // HOME/USERPROFILE point at the throwaway workDir, and that is the
      // difference between a hermetic test and one that runs the developer's
      // MCP stack. Scrubbing YAW_MCP_* was never enough: config, state and
      // bundles.json are found through os.homedir() (USERPROFILE on Windows,
      // HOME elsewhere), not through an env var this loop can see. Without
      // the redirect the child loaded a real ~/.yaw-mcp/bundles.json and
      // PRE-WARMED the servers in it -- on a machine whose bundle contains
      // the docker-hosted `github` server with docker not running, the npipe
      // connect sat for ~9-11s, and together with the startup version check
      // it crossed the 15s guard below perhaps one run in four: SIGKILL,
      // code null, and a truncated stderr that failed the assertions here
      // for a reason nothing in this file mentioned. It reproduced outside
      // vitest, so it was never a runner problem. Isolated, the child does
      // no network-blocked work and exits in about a second.
      //
      // YAW_MCP_AUTO_UPGRADE=0 removes the last network call (the startup
      // "is there a newer version" check against the registry). It sits in
      // this object rather than in childEnv because the scrub above would
      // delete it; spreading `env` last still lets a case override it.
      env: {
        ...childEnv,
        HOME: workDir,
        USERPROFILE: workDir,
        YAW_MCP_AUTO_UPGRADE: "0",
        ...env,
      },
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
    //
    // The ceiling is for CONTENTION, not for the work -- the same reasoning
    // the beforeAll build timeout carries, and it has to be far larger than
    // it looks because the FIRST execution of a freshly-written bundle is
    // roughly an order of magnitude more expensive than the second.
    //
    // Measured from inside vitest on a Windows box with on-access AV, three
    // iterations of "build the bundle, run it cold, run it warm":
    //
    //     build 26.6s | COLD 40.4s | warm 3.8s
    //     build  1.4s | COLD 15.7s | warm 4.4s
    //     build 23.9s | COLD 13.0s | warm 2.3s
    //
    // A 3 MB file that did not exist a moment ago is scanned before it runs,
    // and beforeAll writes a new bundle into a new temp dir on every run, so
    // the first runEntry in this file always pays it. The old 15s guard fired
    // on roughly one run in four; 25s was still inside the observed range.
    // 90s clears the worst measurement with room, and a real hang -- the
    // thing this guard exists for -- is unbounded, so it still gets caught.
    //
    // The two tests that call runEntry carry an explicit per-test timeout
    // ABOVE this value. That ordering is load-bearing: the guard firing is a
    // legible failure (SIGKILL, code null, an assertion naming what was
    // missing), while a vitest timeout reports only that the test was slow.
    // Raise one without the other and you trade the first shape for the
    // second.
    const guard = setTimeout(() => child.kill("SIGKILL"), 90_000);
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
      target: "node20",
      // Prefer each dep's ESM build, and hand bundled CJS a real require:
      // both keep the self-contained bundle runnable outside the repo.
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __yawCreateRequire } from "node:module";\nconst require = __yawCreateRequire(import.meta.url);',
      },
      define: { __VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
    });
    // Timeout is deliberately far above the observed cost. This bundles the
    // whole dependency graph (~500 KB) and it finishes in ~1s standalone, but
    // it runs while the other 74 test files do too: on a loaded box it has
    // been seen to exceed 60s and fail the suite as a hook timeout, taking
    // the three tests below down as "skipped". The ceiling is for contention,
    // not for the work itself.
  }, 180_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // YAW_MCP_URL used to be hard-validated at load and a non-https,
  // non-loopback value aborted startup. yaw-mcp is local-only now: nothing
  // dials that URL, so the var is inert and MUST NOT brick the server. This
  // is the deprecation's regression guard -- a user with a stale
  // YAW_MCP_URL exported in their shell profile still gets a working server.
  it("boots normally with a would-be-unsafe YAW_MCP_URL instead of dying", async () => {
    const { code, stderr } = await runEntry({ YAW_MCP_URL: "http://evil.example.com" });
    // Exactly 0. runEntry spawns with stdin on "ignore", so the stdio
    // transport sees EOF and shuts down cleanly, and with HOME isolated
    // there is no bundles.json to pre-warm and no registry check to wait
    // on -- the child is consistently done in about a second.
    //
    // This used to accept `null` (SIGKILLed at the 15s guard) as a second
    // "healthy" shape, on the theory that a slow box could still be booting.
    // That was the un-isolated HOME leaking the developer's real servers in;
    // see runEntry. Accepting null also swallowed the exact regression the
    // guard exists to catch, since a genuine hang reports null too. 1 is the
    // old fatal-config abort this test guards against, 2 is an argv error.
    expect(code).toBe(0);
    // The old fatal line is gone, and nothing fell through to the
    // last-resort handler either.
    expect(stderr).not.toContain("yaw-mcp: apiBase");
    expect(stderr).not.toContain('"unhandledRejection"');
    // It got past config load and actually started.
    expect(stderr).toContain('"yaw-mcp startup"');
    // Above runEntry's 90s SIGKILL guard, deliberately -- see the note there.
    // This is the first runEntry in the file, so it is the one that pays the
    // cold-bundle cost (13-40s measured).
  }, 120_000);

  it("exits 2 on a mis-cased flag instead of booting a stdio server", async () => {
    // End-to-end proof for the suggestFlag case-variant fix: `yaw-mcp --HELP`
    // used to reach runServer and sit there as a stdio MCP server -- a dead
    // prompt with no output (this harness closes stdin, so it merely exited 0
    // instead of hanging like a real terminal would).
    const { code, stderr } = await runEntry({}, ["--HELP"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown flag "--HELP"');
    expect(stderr).toContain("--help");
    // Warm by now (the bundle has been executed once), but kept above the
    // guard for the same reason -- test order is not a contract.
  }, 120_000);

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
