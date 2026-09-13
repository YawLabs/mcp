// release.sh -- the pre-flight guards.
//
// Until now this file had ZERO coverage: across the whole suite the only
// occurrence of the string "release.sh" was a comment. Every guard in it
// protects an IRREVERSIBLE step (npm forbids re-publishing a version, and the
// step-3 push lands on protected main), so a guard that silently inverts is
// expensive in exactly the way tests are cheap.
//
// Three harness shapes, all hermetic -- no network, no remote but a local bare
// repo, and never the real npm:
//
//   FIXTURE RUN -- copy release.sh into a temp dir beside a synthetic
//   package.json / server.json / node_modules/.bin and run it for real. This
//   exercises the guards through the actual script, wiring included. It works
//   because the first network call is `git fetch`, and everything before it is
//   local; a fixture with no .git dies at `git rev-parse --abbrev-ref HEAD`
//   shortly after, which is well past the two guards this shape covers.
//   release.sh cds to its OWN directory on startup, so the copy is mandatory:
//   running the repo's release.sh with cwd set elsewhere would make it operate
//   on the real repo.
//
//   EXTRACTED BLOCK -- lift one guard's text out of release.sh, source it under
//   stub shell functions, and drive it directly. Used for the guards that sit
//   after the first network call. This tests the block's logic rather than its
//   wiring, so every extraction ASSERTS its anchors are present: if the script
//   is reshaped, these fail loudly instead of quietly testing nothing.
//
//   STUBBED FULL RUN -- one describe (the oam floor re-run) copies release.sh
//   into a temp git repo whose origin is a local bare repo, and runs ALL of it
//   with -y. npm, curl and gh are stub scripts first on PATH, and the harness
//   refuses to start release.sh unless `command -v` resolves each of the three
//   to its stub. npm is also pointed at an empty user config and at a registry
//   URL on 127.0.0.1 port 9 (nothing answered there when measured), so even a
//   stub that failed to shadow it would have no token and no registry. It is the only shape here that reaches the
//   gates, the push and the publish, and all three land on stubs and the bare
//   repo.
//
// Deliberately not covered: the IS_MINGW_ARM64 139/134 tolerance paths. They
// are reachable only when uname reports ARM64, so a test would be the one
// host-conditional file in the suite and would pass vacuously everywhere else.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MIN_OAM_VERSION } from "../oam-spawn.js";

// Every case here spawnSyncs a real bash running a real script, so the file
// takes minutes of wall clock and a single case takes seconds. None of them
// ASSERTS a duration -- they assert on the script's stdout -- so the only clock
// that matters is the harness's patience, and the global 30 s testTimeout was
// it.
//
// That was enough until the suite grew: the default run packs the parallel
// files onto every core at once, and under that contention a single case was
// observed taking 30.3 s and failing the whole run. Twice, non-deterministically,
// on a green tree. The same file, then 55 cases, passed standalone in 142 s.
//
// So this is NOT a TIMING_SENSITIVE file (vitest.config.ts) -- that project is
// for assertions whose SUBJECT is a budget, where isolating the file is what
// makes the number meaningful, and moving a multi-minute file into that
// sequential group would put all of it on the critical path. Here the deadline
// is incidental, so the fix is to stop measuring patience in units set for
// in-process unit tests. testTimeout applies to each case, not to the file, so
// the figure it is set against is the slowest single case: one of the stubbed
// full release runs below, which drives release.sh end to end twice and
// measured 63 s with the CPU pinned at 100% (2026-09-13). 5 minutes is ~5x
// that, so no case can plausibly reach it without being genuinely wedged,
// which is the failure this still catches.
//
// release.sh runs this suite as a release gate, so a flake here blocks a
// release for a reason that has nothing to do with the release.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseShPath = join(repoRoot, "release.sh");
const releaseSh = readFileSync(releaseShPath, "utf8");

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leaked temp dir is not worth failing a suite over.
    }
  }
});

function newTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/**
 * The environment every child here starts from: this process's, minus the
 * caller's GIT_* variables. git exports GIT_DIR and GIT_INDEX_FILE to every
 * hook, so a suite run from a pre-commit hook would otherwise send the
 * fixtures' `git init` / `add` / `commit` -- and release.sh's own git calls --
 * into the operator's repository and index, with every case green. Read at
 * call time, not once at load, so a case can prove it by setting them.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
}

/**
 * Lift a contiguous block out of release.sh, from the line equal to `start`
 * through the first subsequent line equal to `end` (both inclusive).
 *
 * Throws when either anchor is missing. That is the point: these tests assert
 * behavior of code they cannot see being wired in, so a reshaped script must
 * break them loudly rather than leave them asserting against an empty string.
 */
function extractBlock(start: string, end: string): string {
  const lines = releaseSh.split("\n");
  const from = lines.indexOf(start);
  if (from === -1) {
    throw new Error(`release.sh anchor not found: ${JSON.stringify(start)}`);
  }
  const to = lines.indexOf(end, from + 1);
  if (to === -1) {
    throw new Error(`release.sh end anchor ${JSON.stringify(end)} not found after ${JSON.stringify(start)}`);
  }
  return `${lines.slice(from, to + 1).join("\n")}\n`;
}

/** The single-line `if echo "$out" | grep -qE '...'` inside run_npm_check. */
function extractToolchainPattern(): string {
  const line = releaseSh.split("\n").find((l) => l.includes("grep -qE") && l.includes("Cannot find (module|package)"));
  if (!line) {
    throw new Error("release.sh: toolchain-missing grep pattern not found");
  }
  const m = line.match(/grep -qE '([^']+)'/);
  if (!m) {
    throw new Error(`release.sh: could not parse the pattern out of: ${line}`);
  }
  return m[1];
}

type RunResult = { status: number | null; out: string };

/** Run a bash script body in `cwd`, merging stdout and stderr. */
function runBash(body: string, cwd: string, env: Record<string, string> = {}): RunResult {
  const file = join(cwd, `harness-${Math.abs(hash(body))}.sh`);
  writeFileSync(file, body);
  const r = spawnSync("bash", [file], {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv(), NO_COLOR: "1", ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Stable name for the harness file; Math.random is avoided so a rerun reuses
// the same path rather than littering the temp dir.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Stub implementations of release.sh's own output helpers, for extracted blocks. */
const STUB_HELPERS = [
  'info() { echo "INFO $1"; }',
  'warn() { echo "WARN $1"; }',
  'fail() { echo "FAIL $1"; exit 1; }',
].join("\n");

// ---------------------------------------------------------------------------
// FIXTURE RUN
// ---------------------------------------------------------------------------

type Fixture = {
  bins?: string[];
  lockfile?: boolean;
  description?: string;
  name?: string;
  serverJson?: string | null;
  version?: string;
};

const ALL_BINS = ["biome", "tsc", "vitest", "tsup"];

function makeFixture(opts: Fixture = {}): string {
  const dir = newTmp("release-sh-");
  copyFileSync(releaseShPath, join(dir, "release.sh"));

  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const b of opts.bins ?? ALL_BINS) {
    writeFileSync(join(dir, "node_modules", ".bin", b), "");
  }
  if (opts.lockfile !== false) {
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
  }

  const version = opts.version ?? "0.0.1";
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "@yawlabs/mcp",
        version,
        mcpName: "io.github.YawLabs/mcp",
        description: "fixture",
      },
      null,
      2,
    ),
  );

  if (opts.serverJson === null) {
    // caller wants server.json absent
  } else if (typeof opts.serverJson === "string") {
    writeFileSync(join(dir, "server.json"), opts.serverJson);
  } else {
    writeFileSync(
      join(dir, "server.json"),
      JSON.stringify(
        {
          name: opts.name ?? "io.github.YawLabs/mcp",
          description: opts.description ?? "a valid short description",
          version,
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

/**
 * Run the copied release.sh for a target version. Never pass -y or
 * SKIP_CONFIRM: a fixture has no .git, so the run dies at the branch probe
 * shortly after the guards under test -- which is the brake keeping this from
 * ever reaching a gate, a push or a publish.
 */
function runRelease(dir: string, version = "9.9.9", env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bash", ["./release.sh", version], {
    cwd: dir,
    encoding: "utf8",
    env: { ...baseEnv(), NO_COLOR: "1", ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("release.sh dependency guard (fixture run)", () => {
  it("names every missing bin when node_modules/.bin is empty", () => {
    const r = runRelease(makeFixture({ bins: [] }));
    expect(r.out).toContain("Dependencies are not installed");
    for (const b of ALL_BINS) {
      expect(r.out).toContain(b);
    }
    expect(r.status).not.toBe(0);
  });

  it("names only the missing bin on a partially installed tree", () => {
    const r = runRelease(makeFixture({ bins: ["tsc", "vitest", "tsup"] }));
    expect(r.out).toContain("missing node_modules/.bin/{biome}");
    // The ${MISSING_BINS# } trim: no leading space inside the braces.
    expect(r.out).not.toContain("{ biome}");
  });

  it("skips biome entirely under SKIP_LINT=1", () => {
    const r = runRelease(makeFixture({ bins: ["tsc", "vitest", "tsup"] }), "9.9.9", {
      SKIP_LINT: "1",
    });
    expect(r.out).not.toContain("Dependencies are not installed");
    // Proceeded far enough to reach the next local guard.
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("prescribes npm ci with a lockfile and npm install without one", () => {
    const withLock = runRelease(makeFixture({ bins: [], lockfile: true }));
    expect(withLock.out).toContain("Run `npm ci`");

    const noLock = runRelease(makeFixture({ bins: [], lockfile: false }));
    expect(noLock.out).toContain("Run `npm install`");
  });
});

describe("release.sh registry field guard (fixture run)", () => {
  it("rejects an over-cap description with the trim arithmetic", () => {
    const r = runRelease(makeFixture({ description: "L".repeat(121) }));
    expect(r.out).toContain("violates the MCP registry schema");
    expect(r.out).toContain("description is 121 characters");
    expect(r.out).toContain("trim 21");
    expect(r.status).not.toBe(0);
  });

  it("accepts a description of exactly 100 characters", () => {
    const r = runRelease(makeFixture({ description: "x".repeat(100) }));
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("counts CODE POINTS, so 100 astral characters pass", () => {
    // String.length would report 200 here and reject a description the
    // registry accepts. This is the whole reason the guard spreads the string.
    const r = runRelease(makeFixture({ description: "\u{1F600}".repeat(100) }));
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("rejects 101 astral characters", () => {
    const r = runRelease(makeFixture({ description: "\u{1F600}".repeat(101) }));
    expect(r.out).toContain("description is 101 characters");
  });

  it("rejects a name that does not match the registry pattern", () => {
    const r = runRelease(makeFixture({ name: "iogithubYawLabsmcp" }));
    expect(r.out).toContain("does not match the registry pattern");
    expect(r.status).not.toBe(0);
  });

  it("rejects a name shorter than three characters", () => {
    const r = runRelease(makeFixture({ name: "ab" }));
    expect(r.out).toContain("name must be 3-200 characters");
  });

  it("reports an unreadable server.json distinctly from a schema violation", () => {
    const malformed = runRelease(makeFixture({ serverJson: '{"name": "io.github.x/y",' }));
    expect(malformed.out).toContain("Could not read server.json");
    expect(malformed.status).not.toBe(0);

    const absent = runRelease(makeFixture({ serverJson: null }));
    expect(absent.out).toContain("Could not read server.json");
  });
});

// ---------------------------------------------------------------------------
// EXTRACTED BLOCKS
// ---------------------------------------------------------------------------

describe("release.sh toolchain-missing pattern", () => {
  const pattern = extractToolchainPattern();
  const dir = newTmp("release-re-");

  function matches(sample: string): boolean {
    const r = spawnSync("bash", ["-c", 'printf "%s" "$1" | grep -qE "$2"', "_", sample, pattern], {
      cwd: dir,
      encoding: "utf8",
    });
    return r.status === 0;
  }

  it.each([
    ["dash", "sh: 1: biome: not found"],
    ["busybox ash", "sh: biome: not found"],
    ["bash", "bash: biome: command not found"],
    ["absolute sh", "/bin/sh: 1: vitest: not found"],
    ["windows cmd", "'biome' is not recognized as an internal or external command,"],
    ["CJS scoped", "Error: Cannot find module '@biomejs/cli-win32-arm64/biome.exe'"],
    ["CJS unquoted", "Cannot find module @rollup/rollup-win32-arm64-msvc"],
    ["ESM package", "Error: Cannot find package '@rollup/rollup-linux-x64-gnu' imported from x"],
    ["esbuild platform", "You have an incorrect version of esbuild installed win32-x64 for another platform"],
  ])("matches the %s missing-executable shape", (_label, sample) => {
    expect(matches(sample)).toBe(true);
  });

  it.each([
    ["clean lint", "Checked 162 files in 255ms. No fixes applied."],
    ["vitest pass", "Test Files  88 passed (88)"],
    ["real lint findings", "Found 3 errors in 2 files."],
    ["src comment", '// the exit-1 "namespace not found" case below.'],
    ["src comment 2", "plus 18 `command not found: add:...` errors on"],
    ["jsonrpc", 'JSON-RPC -32601: "Method not found", "Unknown tool"'],
  ])("does not match %s", (_label, sample) => {
    expect(matches(sample)).toBe(false);
  });
});

describe("release.sh mcp_registry_gh_token", () => {
  const fn = extractBlock("mcp_registry_gh_token() {", "}");
  const dir = newTmp("release-tok-");

  function resolve(env: Record<string, string>, ghMode: "ok" | "empty" | "absent"): string {
    const gh =
      ghMode === "absent"
        ? "command() { return 1; }"
        : ghMode === "ok"
          ? 'gh() { echo "gh-token"; }'
          : "gh() { return 1; }";
    const body = [gh, fn, "mcp_registry_gh_token"].join("\n");
    return runBash(body, dir, env).out;
  }

  it("prefers GITHUB_TOKEN, then MCP_REGISTRY_TOKEN, then gh", () => {
    expect(resolve({ GITHUB_TOKEN: "G", MCP_REGISTRY_TOKEN: "M" }, "ok")).toBe("G");
    expect(resolve({ MCP_REGISTRY_TOKEN: "M" }, "ok")).toBe("M");
    expect(resolve({}, "ok")).toBe("gh-token");
  });

  it("resolves to nothing when gh errors or is absent", () => {
    expect(resolve({}, "empty")).toBe("");
    expect(resolve({}, "absent")).toBe("");
  });

  it("emits the token and nothing else on stdout", () => {
    // Step 5 captures this in a command substitution and uses it AS the
    // credential, so any stray info()/warn() inside the helper would be
    // concatenated into the token.
    expect(resolve({ GITHUB_TOKEN: "G" }, "ok")).toBe("G");
  });
});

describe("release.sh npm auth guard", () => {
  const block = extractBlock("WHOAMI_RC=0", "fi");
  const dir = newTmp("release-who-");

  function run(opts: { stdout: string; stderr: string; rc: number; alreadyPublished: string }): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      `ALREADY_PUBLISHED="${opts.alreadyPublished}"`,
      `npm() { printf '%s' "$FAKE_OUT"; printf '%s' "$FAKE_ERR" >&2; return ${opts.rc}; }`,
      block,
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir, { FAKE_OUT: opts.stdout, FAKE_ERR: opts.stderr });
  }

  it("reports the identity without npm's stderr notices", () => {
    const r = run({
      stdout: "jeffyaw",
      stderr: "npm notice\nnpm notice New major version of npm available!\nnpm notice",
      rc: 0,
      alreadyPublished: "",
    });
    expect(r.out).toContain("INFO npm auth: jeffyaw");
    expect(r.out).not.toContain("npm notice");
    expect(r.out).toContain("CONTINUED");
  });

  it("hard-fails a definitive auth error when the version is not yet published", () => {
    const r = run({
      stdout: "",
      stderr: "npm error code ENEEDAUTH\nnpm error need auth",
      rc: 1,
      alreadyPublished: "",
    });
    expect(r.out).toContain("FAIL npm is not authenticated");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("warns and continues when the version is already published", () => {
    // The carve-out that keeps a lapsed token from blocking a resume whose
    // step 4 will skip the publish outright.
    const r = run({
      stdout: "",
      stderr: "npm error code E401\nnpm error Incorrect or missing password",
      rc: 1,
      alreadyPublished: "0.81.0",
    });
    expect(r.out).toContain("WARN npm is not authenticated");
    expect(r.out).toContain("already published");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails open, echoing the diagnostic, on a non-auth failure", () => {
    const r = run({
      stdout: "",
      stderr: "npm error network request failed",
      rc: 1,
      alreadyPublished: "",
    });
    expect(r.out).toContain("WARN npm whoami inconclusive (exit 1)");
    expect(r.out).toContain("network request failed");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails open on an exit-139 segfault that still printed a username", () => {
    const r = run({ stdout: "jeffyaw", stderr: "", rc: 139, alreadyPublished: "" });
    expect(r.out).toContain("inconclusive (exit 139)");
    expect(r.out).toContain("CONTINUED");
  });
});

describe("release.sh git fetch gate", () => {
  const block = extractBlock('REMOTE_MAIN_SHA=""', "fi");
  const dir = newTmp("release-fetch-");

  function run(opts: { fetchRc: number; lsRemote: string; tracking: string; allowStale?: boolean }): RunResult {
    const body = [
      STUB_HELPERS,
      // git stub: fetch exits as directed, ls-remote and rev-parse answer from
      // the scenario. Anything else is not reached by this block.
      // A failing `git ls-remote` prints NOTHING -- not an empty first field.
      // Emitting a bare "\trefs/heads/main" would let awk '{print $1}' parse
      // the ref name as the sha, so the empty case must produce no output.
      `git() {
  case "$1 $2" in
    "fetch --tags") echo "fetch output line"; return ${opts.fetchRc} ;;
    "ls-remote origin")
      if [ -n "${opts.lsRemote}" ]; then
        printf '%s\\trefs/heads/main\\n' "${opts.lsRemote}"
      else
        return 128
      fi ;;
    "rev-parse origin/main")
      if [ -n "${opts.tracking}" ]; then printf '%s\\n' "${opts.tracking}"; else return 128; fi ;;
    *) return 0 ;;
  esac
}`,
      block,
      'echo "REMOTE_MAIN_SHA=[$REMOTE_MAIN_SHA]"',
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir, opts.allowStale ? { ALLOW_STALE_REMOTE: "1" } : {});
  }

  it("continues when the fetch fails but origin/main is confirmed current", () => {
    // The divergent-local-tag case: `--tags` makes the whole fetch exit
    // non-zero on a rejected tag while origin/main updates cleanly.
    const r = run({ fetchRc: 1, lsRemote: "abc123def", tracking: "abc123def" });
    expect(r.out).toContain("origin/main is confirmed current");
    expect(r.out).toContain("fetch output line");
    expect(r.out).toContain("CONTINUED");
  });

  it("hard-fails when origin/main cannot be confirmed", () => {
    const r = run({ fetchRc: 128, lsRemote: "", tracking: "abc123def" });
    expect(r.out).toContain("FAIL git fetch origin failed");
    expect(r.out).toContain("fetch output line");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("names the true remote sha under ALLOW_STALE_REMOTE when ls-remote answered", () => {
    const r = run({
      fetchRc: 1,
      lsRemote: "newsha999",
      tracking: "oldsha111",
      allowStale: true,
    });
    expect(r.out).toContain("ls-remote DID answer");
    expect(r.out).toContain("newsha999");
    expect(r.out).toContain("CONTINUED");
  });

  it("admits it is guessing under ALLOW_STALE_REMOTE when ls-remote could not answer", () => {
    const r = run({ fetchRc: 128, lsRemote: "", tracking: "oldsha111", allowStale: true });
    expect(r.out).toContain("could not answer either");
    expect(r.out).toContain("possibly STALE");
    expect(r.out).toContain("CONTINUED");
  });

  it("leaves REMOTE_MAIN_SHA empty on a clean fetch so the fresh tracking ref is used", () => {
    const r = run({ fetchRc: 0, lsRemote: "unused", tracking: "abc123def" });
    expect(r.out).toContain("REMOTE_MAIN_SHA=[]");
  });
});

describe("release.sh version-ordering guard", () => {
  const block = extractBlock('if [ -z "$LATEST_NPM" ]; then', "fi");
  const dir = newTmp("release-ver-");

  function run(env: Record<string, string>): RunResult {
    const body = [STUB_HELPERS, block, 'echo "CONTINUED"'].join("\n");
    return runBash(body, dir, env);
  }

  it("hard-fails a fresh bump when the registry is unreadable", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "false" });
    expect(r.out).toContain("FAIL npm view returned nothing");
    expect(r.out).toContain("cannot verify version ordering");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("warns and continues on a resume", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "true" });
    expect(r.out).toContain("WARN npm view returned nothing");
    expect(r.out).toContain("CONTINUED");
  });

  it("warns and continues under ALLOW_UNVERIFIED_VERSION=1", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "false", ALLOW_UNVERIFIED_VERSION: "1" });
    expect(r.out).toContain("WARN npm view returned nothing");
    expect(r.out).toContain("CONTINUED");
  });

  it("says nothing when the registry reads normally", () => {
    const r = run({ LATEST_NPM: "0.80.0", RESUMING: "false" });
    expect(r.out.trim()).toBe("CONTINUED");
  });
});

describe("release.sh version comparator", () => {
  const dir = newTmp("release-cmp-");
  // The inline node comparator that decides whether VERSION > LATEST_NPM.
  const line = releaseSh.split("\n").find((l) => l.includes("if node -e") && l.includes("process.exit"));

  function greaterThan(version: string, latest: string): boolean {
    if (!line) {
      throw new Error("release.sh: version comparator not found");
    }
    const body = [
      `VERSION="${version}"`,
      `LATEST_NPM="${latest}"`,
      line.replace(/^\s*if /, "if "),
      // Distinct markers, not "GREATER"/"NOT_GREATER": the latter contains the
      // former, so a substring check would report every case as greater.
      '  echo "CMP:yes"',
      "else",
      '  echo "CMP:no"',
      "fi",
    ].join("\n");
    return runBash(body, dir).out.includes("CMP:yes");
  }

  it.each([
    ["0.81.0", "0.80.0", true],
    ["1.0.0", "0.99.99", true],
    ["0.80.1", "0.80.0", true],
    ["0.80.0", "0.80.0", false],
    ["0.79.3", "0.80.0", false],
    ["0.8.0", "0.80.0", false],
  ])("%s > %s === %s", (version, latest, expected) => {
    expect(greaterThan(version as string, latest as string)).toBe(expected);
  });
});

describe("release.sh tag-at-HEAD guard", () => {
  const block = extractBlock('if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then', "fi");
  const dir = newTmp("release-tag-");

  function run(opts: { tagSha: string | null; headSha: string; published: string }): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      `current_head_sha() { echo "${opts.headSha}"; }`,
      `git() {
  case "$1 $2" in
    "tag -l") ${opts.tagSha ? 'echo "v0.81.0"' : "true"} ;;
    "rev-list -n1") echo "${opts.tagSha ?? ""}" ;;
    "tag -a") echo "TAG_CREATED" ;;
    *) return 0 ;;
  esac
}`,
      `npm() { echo "${opts.published}"; }`,
      block,
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir);
  }

  it("accepts a pre-existing tag that points at HEAD", () => {
    const r = run({ tagSha: "aaa111", headSha: "aaa111", published: "" });
    expect(r.out).toContain("already exists at HEAD");
    expect(r.out).toContain("CONTINUED");
  });

  it("refuses to publish a tree the tag does not describe", () => {
    // Tag left behind by an interrupted run, a fix committed on main after it,
    // and the version NOT yet on npm -- step 4 would pack a tree the tag does
    // not contain, permanently, since npm forbids re-publishing.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "" });
    expect(r.out).toContain("FAIL Tag v0.81.0 exists at aaa111");
    expect(r.out).toContain("HEAD is bbb222");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("continues on tag/HEAD drift when the version is already published", () => {
    // The v0.80.0 recovery shape: the tag describes what npm already has, so
    // step 4 packs nothing and the drift is harmless. Failing here would block
    // a resume that works.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "0.81.0" });
    expect(r.out).toContain("WARN Tag v0.81.0 points at aaa111");
    expect(r.out).toContain("already on npm");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails closed when the registry cannot be read", () => {
    // An unreadable registry leaves the probe empty, which must NOT be treated
    // as "already published" in front of an irreversible publish.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "" });
    expect(r.out).toContain("FAIL");
  });

  it("creates an annotated tag when none exists", () => {
    const r = run({ tagSha: null, headSha: "bbb222", published: "" });
    expect(r.out).toContain("TAG_CREATED");
    expect(r.out).toContain("INFO Tag v0.81.0 created");
  });
});

describe("release.sh non-interactive confirm brake", () => {
  const block = extractBlock('if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then', "fi");
  const dir = newTmp("release-tty-");

  it("aborts with exit 0 before any mutation when stdin is not a terminal", () => {
    // Every fixture test in this file relies on this brake: if it ever exits 1
    // or reads anyway, those runs would proceed into the gates, the push and
    // the publish.
    const body = [
      STUB_HELPERS,
      'VERSION="9.9.9"',
      'SKIP_CONFIRM="false"',
      'RESUMING="false"',
      "CYAN=''; YELLOW=''; NC=''",
      block,
      'echo "REACHED_STEP_1"',
    ].join("\n");
    const r = runBash(body, dir);
    expect(r.out).toContain("Aborted: stdin is not a terminal");
    expect(r.out).not.toContain("REACHED_STEP_1");
    expect(r.status).toBe(0);
  });
});

describe("release.sh registry_has_version", () => {
  const fn = extractBlock("registry_has_version() {", "}");
  const dir = newTmp("release-reg-");

  /** Run the helper with `curl` stubbed to return `body`, or to fail like a
   *  `curl -f` against an unreachable/erroring registry when body is null.
   *  The stub APPENDS the argv it saw to curl-args.log in `cwd`. */
  function run(body: string | null, want = "0.81.0", calls = 1): { out: string; args: string[] } {
    const log = `curl-args-${Math.abs(hash(`${body}${want}${calls}`))}.log`;
    const curlStub =
      body === null
        ? `curl() { printf '%s\\n' "$*" >> "${log}"; return 22; }`
        : `curl() { printf '%s\\n' "$*" >> "${log}"; printf '%s' "$FAKE_BODY"; }`;
    const script = [
      curlStub,
      fn,
      `for _ in $(seq 1 ${calls}); do if registry_has_version "${want}"; then echo "HIT"; else echo "MISS"; fi; done`,
    ].join("\n");
    const r = runBash(script, dir, { FAKE_BODY: body ?? "" });
    let args: string[] = [];
    try {
      args = readFileSync(join(dir, log), "utf8").split("\n").filter(Boolean);
    } catch {
      // No log means curl was never called, which the caller asserts on.
    }
    return { out: r.out, args };
  }

  const listing = (version: string) =>
    JSON.stringify({ servers: [{ server: { name: "io.github.YawLabs/mcp", version } }] });

  it("hits when the registry lists that exact version", () => {
    expect(run(listing("0.81.0")).out).toContain("HIT");
  });

  it("misses when the registry lists a different version", () => {
    expect(run(listing("0.80.0")).out).toContain("MISS");
  });

  it("fails OPEN on an unreachable registry or an unparseable body", () => {
    // Both call sites treat a miss as "not published yet": step 5 falls
    // through to publish, the final verification retries. Neither may be
    // wedged by a registry outage.
    expect(run(null).out).toContain("MISS");
    expect(run("<html>502 Bad Gateway</html>").out).toContain("MISS");
    expect(run("").out).toContain("MISS");
  });

  it("busts the CDN cache on every read", () => {
    // The registry serves this endpoint through a cache (X-Registry-Cache:
    // MISS then STALE on the same URL seconds apart). An un-busted read can
    // answer with a pre-publish body, which turns step 5's idempotence probe
    // into the duplicate-publish abort it exists to prevent.
    const { args } = run(listing("0.81.0"), "0.81.0", 3);
    expect(args).toHaveLength(3);
    for (const a of args) {
      expect(a).toContain("Cache-Control: no-cache");
      expect(a).toMatch(/[?&]_=\d+/);
      // Without a total timeout, a stalled registry connection hangs step 5's
      // probe or the final read-back instead of reading as a miss.
      expect(a).toMatch(/--max-time \d+/);
    }
    // Per-call uniqueness is what actually moves the cache key: two reads in
    // the same second must not resolve to the same URL.
    const busters = args.map((a) => /[?&]_=(\d+)/.exec(a)?.[1]);
    expect(new Set(busters).size).toBeGreaterThan(1);
  });

  it("asks for the version it was given, not a hardcoded one", () => {
    const { args } = run(listing("1.2.3"), "1.2.3");
    expect(args[0]).toContain("version=1.2.3");
    expect(args[0]).toContain("search=io.github.YawLabs/mcp");
  });
});

describe("release.sh published-tarball content check", () => {
  const block = extractBlock(
    'PUBLISHED_INTEGRITY=$(npm view "@yawlabs/mcp@${VERSION}" dist.integrity 2>/dev/null | tr -d \'[:space:]\' || echo "")',
    "fi",
  );
  const dir = newTmp("release-tar-");

  function run(opts: { published: string; pack: string; publishedThisRun: boolean }): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      `NPM_PUBLISHED_THIS_RUN=${opts.publishedThisRun}`,
      // `view` answers with the registry's integrity, anything else is the
      // `pack --dry-run --json` call.
      `npm() { if [ "$1" = "view" ]; then printf '%s\\n' "$FAKE_VIEW"; else printf '%s' "$FAKE_PACK"; fi; }`,
      block,
    ].join("\n");
    return runBash(body, dir, { FAKE_VIEW: opts.published, FAKE_PACK: opts.pack });
  }

  const packJson = (integrity: string) => JSON.stringify([{ name: "@yawlabs/mcp", integrity }]);
  const SHA = "sha512-6XXgP7XuMcMERl3hLlBERq7nKu8LvKis2i0FhyBi7m+DDFuBcASncrTJDNSjHU4fxb/a+liqWpRsFY6MPMOOww==";
  const OTHER = "sha512-hgrrVtBEDbnOQI0kBjaYz0uSMc8P9n8EKGJhnmi+n9wobTkbv3X7+S+8Dn5OTLXL8biqzBe8uQgqqGyacWeQkA==";

  it("confirms when the published tarball is the tarball this run packed", () => {
    const r = run({ published: SHA, pack: packJson(SHA), publishedThisRun: true });
    expect(r.out).toContain("INFO npm tarball: content matches this build");
  });

  it("flags a mismatch on a version this run published", () => {
    // The version string would still say 0.81.0 here. Only the content check
    // can see that npm is serving bytes this build did not produce.
    const r = run({ published: OTHER, pack: packJson(SHA), publishedThisRun: true });
    expect(r.out).toContain("WARN npm is serving a DIFFERENT tarball");
    expect(r.out).toContain(OTHER);
    expect(r.out).toContain(SHA);
  });

  it("reads a mismatch on a SKIPPED publish as post-tag drift, not an anomaly", () => {
    // The documented recovery shape: the version was already live and a fix
    // was committed after the tag, so HEAD legitimately differs from what
    // shipped. Same fact, different conclusion -- and it must not read as a
    // corrupted publish.
    const r = run({ published: OTHER, pack: packJson(SHA), publishedThisRun: false });
    expect(r.out).toContain("already on npm and its tarball differs");
    expect(r.out).not.toContain("DIFFERENT tarball");
  });

  it("says the comparison could not run rather than passing it", () => {
    // Fail-open, but never SILENTLY: an unreadable side must not look like a
    // match. Both directions -- registry unreachable, and a pack that emitted
    // no parseable JSON.
    expect(run({ published: "", pack: packJson(SHA), publishedThisRun: true }).out).toContain(
      "WARN Could not compare the published tarball",
    );
    expect(run({ published: SHA, pack: "npm ERR! segfault", publishedThisRun: true }).out).toContain(
      "WARN Could not compare the published tarball",
    );
  });

  it("never fails the release -- the publish has already gone out", () => {
    const r = run({ published: OTHER, pack: packJson(SHA), publishedThisRun: true });
    expect(r.status).toBe(0);
  });
});

describe("release.sh MCP-registry read-back", () => {
  const block = extractBlock("REGISTRY_FINAL=false", "fi");
  const dir = newTmp("release-rb-");

  function run(hitOnTry: number | null): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      "TRIES=0",
      "sleep() { :; }",
      `registry_has_version() { TRIES=$((TRIES + 1)); if [ -n "${hitOnTry ?? ""}" ] && [ "$TRIES" -ge "${hitOnTry ?? 0}" ]; then return 0; fi; return 1; }`,
      block,
      'echo "TRIES=$TRIES"',
    ].join("\n");
    return runBash(body, dir);
  }

  it("confirms the registry channel instead of inferring it from an exit code", () => {
    // The block this replaces did not exist: mcp-publisher's exit code was
    // the only evidence, while the banner claimed the registry listing.
    const r = run(1);
    expect(r.out).toContain("INFO MCP registry: io.github.YawLabs/mcp@0.81.0");
    expect(r.out).toContain("TRIES=1");
  });

  it("polls past the registry's read-path lag", () => {
    const r = run(2);
    expect(r.out).toContain("INFO MCP registry:");
    expect(r.out).toContain("TRIES=2");
  });

  it("warns, with the recovery, when three reads do not list it", () => {
    const r = run(null);
    expect(r.out).toContain("WARN The MCP registry does not list");
    expect(r.out).toContain("TRIES=3");
    expect(r.out).toContain("Re-run ./release.sh 0.81.0");
    // A missing listing is not a release failure -- npm already has the
    // version and cannot take it back.
    expect(r.status).toBe(0);
  });
});

// The behaviour-change gate: a default that changes without an opt-in is the
// one release hazard nothing in the diff can reveal, so the only check is a
// human answering out loud. Both defects below were found by an adversarial
// review AFTER the gate shipped, and both made it answer itself.
describe("release.sh behaviour-change gate (fixture run)", () => {
  const block = extractBlock(
    '  read -p "Behaviour change with no opt-in? (y/N) " -r BEHAVIOUR_REPLY || BEHAVIOUR_REPLY=""',
    "  fi",
  );
  const dir = newTmp("release-behaviour-");

  // A CHANGELOG shaped like the real one: an Unreleased section naming this
  // release's switch, and an older section naming a different one.
  const CHANGELOG = [
    "# Changelog",
    "",
    "## Unreleased -- something",
    "",
    "Set `YAW_MCP_NEW_THING=0` to disable it.",
    "",
    "## 0.79.0 -- older",
    "",
    "Set `YAW_MCP_OLD_THING=0` to disable it.",
    "",
  ].join("\n");

  function run(answers: string[]): RunResult {
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const body = [STUB_HELPERS, 'VERSION="0.81.0"', "CYAN=''", "NC=''", block, 'echo "CONTINUED"'].join("\n");
    const file = join(dir, "behaviour-harness.sh");
    writeFileSync(file, body);
    const r = spawnSync("bash", [file], {
      cwd: dir,
      encoding: "utf8",
      input: `${answers.join("\n")}\n`,
      env: { ...baseEnv(), NO_COLOR: "1" },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("passes straight through when nothing changes for an existing user", () => {
    expect(run(["n"]).out).toContain("CONTINUED");
  });

  it("accepts a documented switch and continues", () => {
    const r = run(["y", "YAW_MCP_NEW_THING"]);
    expect(r.out).toContain("found in the Unreleased section");
    expect(r.out).toContain("CONTINUED");
  });

  it("does not answer itself when the operator types 'yes' rather than 'y'", () => {
    // The original read used -n 1, so "yes" left "es" in the buffer for the
    // NEXT read to swallow as the off-switch name -- and "es" matches almost
    // any CHANGELOG as a substring, so the gate passed itself. A normal answer
    // defeated the check.
    const r = run(["yes", "YAW_MCP_NEW_THING"]);
    expect(r.out).toContain("found in the Unreleased section");
    expect(r.out).not.toContain("'es'");
    expect(r.out).toContain("CONTINUED");
  });

  it("treats a FLAG-shaped switch as a pattern, not as a grep option", () => {
    // Without -e, `grep -qF "--no-cap"` exits 2 with "unknown option" and the
    // 2>/dev/null hid it, so the operator was told the name was absent from a
    // file that contained it. Here it is genuinely absent, so the abort is
    // correct -- what matters is that grep did not error.
    const r = run(["y", "--no-such-flag"]);
    expect(r.out).toContain("does not appear");
    expect(r.out).not.toContain("unknown option");
    expect(r.out).not.toContain("Usage: grep");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("accepts a flag-shaped switch that IS documented", () => {
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG.replace("YAW_MCP_NEW_THING=0", "--no-new-thing"));
    const body = [STUB_HELPERS, 'VERSION="0.81.0"', "CYAN=''", "NC=''", block, 'echo "CONTINUED"'].join("\n");
    const file = join(dir, "behaviour-harness-flag.sh");
    writeFileSync(file, body);
    const r = spawnSync("bash", [file], {
      cwd: dir,
      encoding: "utf8",
      input: "y\n--no-new-thing\n",
      env: { ...baseEnv(), NO_COLOR: "1" },
    });
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("CONTINUED");
  });

  it("refuses a switch documented only in an OLDER release", () => {
    // The gate exists to assert THIS release documents the way back. An
    // unscoped grep was satisfied by a name mentioned three releases ago.
    const r = run(["y", "YAW_MCP_OLD_THING"]);
    expect(r.out).toContain("does not appear");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("refuses a blank switch", () => {
    const r = run(["y", "   "]);
    expect(r.out).toContain("documented way back");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("trims surrounding whitespace off the switch", () => {
    const r = run(["y", "  YAW_MCP_NEW_THING  "]);
    expect(r.out).toContain("found in the Unreleased section");
    expect(r.out).toContain("CONTINUED");
  });
});

// ---------------------------------------------------------------------------
// THE OAM FLOOR
// ---------------------------------------------------------------------------
//
// MIN_OAM_VERSION tracks the latest oam release as policy. release.sh reads
// that release from GitHub in its pre-flight and, unless the version being
// released is already tagged or on npm, moves the constant, its test ratchet
// and a changelog block to it in a commit made before step 1. Every case here
// is hermetic: curl is a shell function or a stub script, and each case that
// runs git does so in its own fresh temp git repo, with the operator's global
// and system git config, XDG git config and GIT_* variables shut out.

const OAM_HELPERS = extractBlock("# >>> oam floor helpers", "# <<< oam floor helpers");

// Git for every oam case that runs real git: an empty global config, no system
// config, and XDG_CONFIG_HOME pointed at the same empty home, because
// GIT_CONFIG_GLOBAL does not replace the default git/ignore and git/attributes
// under it (measured: a user git/ignore matching *.txt makes the move cases'
// `git add unrelated.txt` fail).
// With baseEnv() dropping the caller's GIT_* variables as well, the operator's
// commit signing, hooks, autocrlf, excludes, repository and index cannot reach
// these repos.
const gitHome = newTmp("release-oam-gitcfg-");
writeFileSync(join(gitHome, "config"), "");
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: join(gitHome, "config"),
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: gitHome,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...baseEnv(), ...GIT_ENV } });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

/** Run a bash body with cwd `dir` from a harness file OUTSIDE it, so the harness can never show up as a change there. */
function runOutside(dir: string, body: string, env: Record<string, string> = {}): RunResult {
  const file = join(newTmp("release-oam-harness-"), "harness.sh");
  writeFileSync(file, body);
  const r = spawnSync("bash", [file], {
    cwd: dir,
    encoding: "utf8",
    env: { ...baseEnv(), NO_COLOR: "1", ...GIT_ENV, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Forward slashes, so a Windows temp path can sit inside a bash string. */
function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function oamSrcFixture(floor: string): string {
  return ["// fixture", "/** doc */", `export const MIN_OAM_VERSION = "${floor}";`, "export const OTHER = 1;", ""].join(
    "\n",
  );
}

function oamTestFixture(floor: string): string {
  return ['describe("MIN_OAM_VERSION freshness floor", () => {', `  const FLOOR = "${floor}";`, "});", ""].join("\n");
}

const OAM_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased -- things",
  "",
  "**Fixed -- something**",
  "",
  "A paragraph.",
  "",
  "## 1.0.1 -- older",
  "",
  "Old text.",
  "",
].join("\n");

type OamFixture = { floor?: string; ratchet?: string; src?: string; test?: string; changelog?: string };

function writeOamFixture(dir: string, opts: OamFixture = {}): void {
  const floor = opts.floor ?? "0.13.1";
  mkdirSync(join(dir, "src", "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "oam-spawn.ts"), opts.src ?? oamSrcFixture(floor));
  writeFileSync(join(dir, "src", "tests", "oam-spawn.test.ts"), opts.test ?? oamTestFixture(opts.ratchet ?? floor));
  writeFileSync(join(dir, "CHANGELOG.md"), opts.changelog ?? OAM_CHANGELOG);
}

/** What GitHub's /releases/latest answers, trimmed to the fields release.sh reads. */
function oamRelease(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tag_name: "v0.15.2",
    published_at: "2026-09-13T13:11:42Z",
    draft: false,
    prerelease: false,
    ...over,
  });
}

/**
 * curl as a shell function. Appends its arguments to curl-args.txt, one line a
 * call. With -K it saves its stdin -- the config that carries the token -- to
 * curl-config.txt, and fails with $FAKE_AUTH_RC when that is set. Otherwise it
 * prints $FAKE_BODY and exits $FAKE_CURL_RC, writing a curl-style failure line
 * to stderr first when that is non-zero, the way `curl -fsSL` does.
 */
const CURL_STUB = `curl() {
  local a auth=false
  for a in "$@"; do
    if [ "$a" = "-K" ]; then auth=true; fi
  done
  echo "$*" >> curl-args.txt
  if [ "$auth" = true ]; then
    cat > curl-config.txt
    if [ -n "\${FAKE_AUTH_RC:-}" ]; then
      echo "curl: (\${FAKE_AUTH_RC}) The requested URL returned error: 401" >&2
      return "\${FAKE_AUTH_RC}"
    fi
  fi
  if [ "\${FAKE_CURL_RC:-0}" != 0 ]; then
    echo "curl: (\${FAKE_CURL_RC}) \${FAKE_CURL_ERR:-request failed}" >&2
  fi
  printf '%s' "\${FAKE_BODY:-}"
  return "\${FAKE_CURL_RC:-0}"
}`;

/** release.sh's token resolver lives outside the helpers block; here the token is $FAKE_GH_TOKEN, empty unless a case sets it. */
const TOKEN_STUB = 'mcp_registry_gh_token() { printf %s "${FAKE_GH_TOKEN:-}"; }';

describe("release.sh oam floor helpers", () => {
  const dir = newTmp("release-oam-helpers-");
  const realSrc = shPath(join(repoRoot, "src", "oam-spawn.ts"));

  function sh(lines: string[], env: Record<string, string> = {}): RunResult {
    return shIn(dir, lines, env);
  }

  function shIn(cwd: string, lines: string[], env: Record<string, string> = {}): RunResult {
    const prelude = [STUB_HELPERS, TOKEN_STUB, OAM_HELPERS, CURL_STUB, "rm -f curl-args.txt curl-config.txt"];
    return runBash([...prelude, ...lines].join("\n"), cwd, env);
  }

  /** A fresh dir holding the three floor files, for a case that rewrites them. */
  function floorDir(opts: OamFixture = {}): string {
    const d = newTmp("release-oam-rewrite-");
    writeOamFixture(d, opts);
    return d;
  }

  /** oam_floor_rewrite over floorDir's files, 0.13.1 -> `next` unless told otherwise. */
  function rewrite(d: string, mode: "--check" | "--write", next = "0.15.2", prev = "0.13.1"): RunResult {
    return shIn(d, [
      `oam_floor_rewrite ${mode} src/oam-spawn.ts src/tests/oam-spawn.test.ts CHANGELOG.md ${next} ${prev} 2026-09-13 9.9.9`,
      'echo "RC=$?"',
    ]);
  }

  const unchanged = (d: string, opts: OamFixture) => {
    expect(readFileSync(join(d, "src", "oam-spawn.ts"), "utf8")).toBe(
      opts.src ?? oamSrcFixture(opts.floor ?? "0.13.1"),
    );
    expect(readFileSync(join(d, "src", "tests", "oam-spawn.test.ts"), "utf8")).toBe(
      opts.test ?? oamTestFixture(opts.ratchet ?? opts.floor ?? "0.13.1"),
    );
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toBe(opts.changelog ?? OAM_CHANGELOG);
  };

  it("reads the real MIN_OAM_VERSION out of src/oam-spawn.ts", () => {
    const r = sh([`OAM_FLOOR_SRC="${realSrc}"`, "current_oam_floor"]);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe(MIN_OAM_VERSION);
  });

  it("can move the real constant and the real ratchet literal", () => {
    // Pins the SHAPES the move depends on in the two real source files. If
    // either line is reshaped, this goes red now rather than on the next
    // release that needs a move. It runs on COPIES in this describe's temp
    // dir: oam_floor_rewrite writes, and this file runs in parallel with
    // oam-spawn.test.ts, so this case never points it at the checkout. The
    // changelog is a fixture: whether the real one has an Unreleased section
    // depends on where it is in a release cycle.
    const srcText = readFileSync(join(repoRoot, "src", "oam-spawn.ts"), "utf8");
    const testText = readFileSync(join(repoRoot, "src", "tests", "oam-spawn.test.ts"), "utf8");
    writeFileSync(join(dir, "real-oam-spawn.ts"), srcText);
    writeFileSync(join(dir, "real-oam-spawn.test.ts"), testText);
    writeFileSync(join(dir, "CHANGELOG.md"), OAM_CHANGELOG);
    const args = `real-oam-spawn.ts real-oam-spawn.test.ts CHANGELOG.md 999.0.0 "${MIN_OAM_VERSION}" 2026-01-01 9.9.9`;

    expect(sh([`oam_floor_rewrite --check ${args} >/dev/null`, 'echo "RC=$?"']).out.trim()).toBe("RC=0");
    expect(readFileSync(join(dir, "real-oam-spawn.ts"), "utf8")).toBe(srcText);
    expect(readFileSync(join(dir, "real-oam-spawn.test.ts"), "utf8")).toBe(testText);

    expect(sh([`oam_floor_rewrite --write ${args}`, 'echo "RC=$?"']).out.trim()).toBe("RC=0");
    // Exactly the one line moves in each file, and on it only the version. The
    // old version comes from each file's own line: the ratchet literal may
    // legitimately sit below the constant.
    const movedOnly = (before: string, after: string, re: RegExp) => {
      const b = before.split("\n");
      const a = after.split("\n");
      expect(a.length).toBe(b.length);
      const changed = b.flatMap((line, i) => (line === a[i] ? [] : [i]));
      expect(changed).toHaveLength(1);
      const m = re.exec(b[changed[0]]);
      expect(m).not.toBeNull();
      expect(a[changed[0]]).toBe(b[changed[0]].replace(`"${m?.[1]}"`, '"999.0.0"'));
    };
    movedOnly(
      srcText,
      readFileSync(join(dir, "real-oam-spawn.ts"), "utf8"),
      /^export const MIN_OAM_VERSION = "(\d+\.\d+\.\d+)";\r?$/,
    );
    movedOnly(
      testText,
      readFileSync(join(dir, "real-oam-spawn.test.ts"), "utf8"),
      /^[ \t]*const FLOOR = "(\d+\.\d+\.\d+)";\r?$/,
    );
  });

  it("refuses a source with no MIN_OAM_VERSION line, and one with two", () => {
    writeFileSync(join(dir, "none.ts"), "export const OTHER = 1;\n");
    writeFileSync(join(dir, "two.ts"), `${oamSrcFixture("0.13.1")}${oamSrcFixture("0.13.2")}`);
    const none = sh(['OAM_FLOOR_SRC="none.ts"', 'OUT=$(current_oam_floor); echo "RC=$? OUT=[$OUT]"']);
    expect(none.out).toContain("found 0");
    expect(none.out).toContain("RC=1 OUT=[]");
    const two = sh(['OAM_FLOOR_SRC="two.ts"', 'OUT=$(current_oam_floor); echo "RC=$? OUT=[$OUT]"']);
    expect(two.out).toContain("found 2");
    expect(two.out).toContain("RC=1 OUT=[]");
  });

  it("reads the latest oam release and the day it was published", () => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease(),
      FAKE_CURL_RC: "0",
    });
    expect(r.out.trim()).toBe("RC=0 OUT=[0.15.2 2026-09-13]");
    const args = readFileSync(join(dir, "curl-args.txt"), "utf8");
    expect(args).toContain("https://api.github.com/repos/YawLabs/oam/releases/latest");
    // Without a total timeout, a stalled connection hangs the pre-flight instead of failing closed.
    expect(args).toMatch(/--max-time \d+/);
    // No token resolved: one plain read, with no config on stdin.
    expect(args.trim().split("\n")).toHaveLength(1);
    expect(args).not.toContain("-K");
  });

  it("sends a resolved token as a curl config on stdin, never on the command line", () => {
    // Unauthenticated, GitHub allows 60 reads an hour per IP. The token lifts
    // that, and argv is what the process list shows, so it rides in -K -.
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease(),
      FAKE_CURL_RC: "0",
      FAKE_GH_TOKEN: "ghp_fixtureSECRET",
    });
    expect(r.out.trim()).toBe("RC=0 OUT=[0.15.2 2026-09-13]");
    const args = readFileSync(join(dir, "curl-args.txt"), "utf8");
    expect(args.trim().split("\n")).toHaveLength(1);
    expect(args).toContain("-K -");
    expect(args).not.toContain("ghp_fixtureSECRET");
    expect(readFileSync(join(dir, "curl-config.txt"), "utf8")).toBe(
      'header = "Authorization: Bearer ghp_fixtureSECRET"\n',
    );
  });

  it("retries once without the token when the authenticated read fails, and says so", () => {
    // A bad token gets 401 even on a public repo. That must not turn a read
    // that works unauthenticated into a hard stop.
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease(),
      FAKE_CURL_RC: "0",
      FAKE_GH_TOKEN: "stale",
      FAKE_AUTH_RC: "22",
    });
    expect(r.out).toContain("RC=0 OUT=[0.15.2 2026-09-13]");
    expect(r.out).toContain("curl: (22) The requested URL returned error: 401");
    expect(r.out).toContain("retrying once without the token");
    const calls = readFileSync(join(dir, "curl-args.txt"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("-K -");
    expect(calls[1]).not.toContain("-K");
  });

  it("fails when the unauthenticated retry fails too", () => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease(),
      FAKE_CURL_RC: "6",
      FAKE_CURL_ERR: "Could not resolve host: api.github.com",
      FAKE_GH_TOKEN: "stale",
      FAKE_AUTH_RC: "22",
    });
    expect(r.out).toContain("RC=1 OUT=[]");
    expect(readFileSync(join(dir, "curl-args.txt"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("lets curl's own failure line through, so a rate limit reads differently from offline", () => {
    // The helper runs inside the pre-flight's $(...), which captures stdout
    // only. Discarding stderr here hid the one line naming the cause.
    const limited = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_CURL_RC: "22",
      FAKE_CURL_ERR: "The requested URL returned error: 403",
    });
    expect(limited.out).toContain("RC=1 OUT=[]");
    expect(limited.out).toContain("curl: (22) The requested URL returned error: 403");
    const offline = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_CURL_RC: "6",
      FAKE_CURL_ERR: "Could not resolve host: api.github.com",
    });
    expect(offline.out).toContain("curl: (6) Could not resolve host");
  });

  it("accepts a tag written without the v", () => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease({ tag_name: "0.15.2" }),
      FAKE_CURL_RC: "0",
    });
    expect(r.out.trim()).toBe("RC=0 OUT=[0.15.2 2026-09-13]");
  });

  it.each([
    ["a prerelease", oamRelease({ prerelease: true }), "0", "v0.15.2 is marked as a prerelease"],
    ["a draft", oamRelease({ draft: true }), "0", "v0.15.2 is marked as a draft"],
    ["a tag that is not a version", oamRelease({ tag_name: "nightly" }), "0", 'tag_name "nightly" is not'],
    ["a two-part version", oamRelease({ tag_name: "v0.15" }), "0", 'tag_name "v0.15" is not'],
    // The next two pin the END anchor of the tag pattern, and the one after
    // them the START anchor: without either, each of these reads as a version.
    ["a prerelease-suffixed tag GitHub did not flag", oamRelease({ tag_name: "v0.15.2-rc.1" }), "0", "is not"],
    ["a four-part tag", oamRelease({ tag_name: "v0.15.2.1" }), "0", "is not"],
    ["a tag with text before the version", oamRelease({ tag_name: "release-v0.15.2" }), "0", "is not"],
    ["a release with no publish date", oamRelease({ published_at: null }), "0", "has no published_at date"],
    ["a body that is not JSON", "<html>rate limited</html>", "0", "is not JSON"],
    ["a failed request", oamRelease(), "22", "curl: (22)"],
  ])("answers nothing, fails, and says why on stderr, for %s", (_name, body, rc, why) => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], { FAKE_BODY: body, FAKE_CURL_RC: rc });
    expect(r.out).toContain("RC=1 OUT=[]");
    expect(r.out).toContain(why);
  });

  it("prints on --check exactly the block --write puts in the changelog", () => {
    // The behaviour-change gate is shown --check's output; the move writes
    // with --write. One template renders both, and this pins that they agree.
    const d = floorDir();
    const check = rewrite(d, "--check");
    expect(check.out).toContain("RC=0");
    const printed = check.out.slice(0, check.out.lastIndexOf("RC=0")).replace(/\n+$/, "");
    expect(printed.startsWith("**Changed -- the oam floor moves to 0.15.2**\n\n")).toBe(true);
    unchanged(d, {});

    // --write prints nothing on stdout.
    expect(rewrite(d, "--write").out.trim()).toBe("RC=0");
    const before = OAM_CHANGELOG.split("\n");
    const after = readFileSync(join(d, "CHANGELOG.md"), "utf8").split("\n");
    let p = 0;
    while (p < before.length && before[p] === after[p]) p++;
    let s = 0;
    while (s < before.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
    const inserted = after
      .slice(p, after.length - s)
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    expect(inserted).toBe(printed);
  });

  it("skips ## lines inside code fences when it looks for the end of the section", () => {
    // A fence closes only on the same character, at least as long: the short
    // ``` inside the four-backtick fence and the ~~~ inside the ``` fence do
    // not close them, so neither ## line after them is a section heading.
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased -- things",
      "",
      "**Fixed -- something**",
      "",
      "```md",
      "# Notes",
      "## Servers",
      "- github",
      "```",
      "",
      "````md",
      "```",
      "## Not a heading either",
      "````",
      "",
      "```sh",
      "~~~",
      "## Still not a heading",
      "```",
      "",
      "## 1.0.1 -- older",
      "",
      "Old text.",
      "",
    ].join("\n");
    const d = floorDir({ changelog });
    expect(rewrite(d, "--write").out.trim()).toBe("RC=0");
    const log = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    const heading = "**Changed -- the oam floor moves to 0.15.2**";
    expect(log.indexOf(heading)).toBeGreaterThan(log.lastIndexOf("```\n"));
    expect(log.indexOf(heading)).toBeLessThan(log.indexOf("## 1.0.1 -- older"));
    // Every fence came through byte for byte.
    expect(log.slice(0, log.indexOf(heading))).toBe(changelog.slice(0, changelog.indexOf("## 1.0.1 -- older")));
  });

  it("stops, writing nothing, when a code fence never closes", () => {
    const changelog = OAM_CHANGELOG.replace("A paragraph.", "A paragraph.\n\n```sh\necho never closed");
    const d = floorDir({ changelog });
    const check = rewrite(d, "--check");
    expect(check.out).toContain("a code fence opened with ``` never closes");
    expect(check.out).toContain("RC=1");
    expect(rewrite(d, "--write").out).toContain("RC=1");
    unchanged(d, { changelog });
  });

  it("stops, writing nothing, when the section already holds two floor blocks", () => {
    const twoBlocks = OAM_CHANGELOG.replace(
      "A paragraph.",
      [
        "A paragraph.",
        "",
        "**Changed -- the oam floor moves to 0.14.0**",
        "",
        "Text; the floor was 0.13.1. More.",
        "",
        "**Changed -- the oam floor moves to 0.15.0**",
        "",
        "Text; the floor was 0.14.0. More.",
      ].join("\n"),
    );
    const d = floorDir({ changelog: twoBlocks });
    const check = rewrite(d, "--check");
    expect(check.out).toContain('2 oam floor blocks in "## Unreleased -- things"; merge them by hand');
    expect(check.out).toContain("RC=1");
    expect(rewrite(d, "--write").out).toContain("RC=1");
    unchanged(d, { changelog: twoBlocks });
  });

  it("refuses to update a floor block that is not in the shape it writes, rather than guess the old floor", () => {
    const edited = OAM_CHANGELOG.replace(
      "A paragraph.",
      "A paragraph.\n\n**Changed -- the oam floor moves to 0.15.2**\n\nRewritten by hand, naming no earlier floor.",
    );
    const d = floorDir({ changelog: edited });
    const check = rewrite(d, "--check", "0.15.3", "0.15.2");
    expect(check.out).toContain("cannot be updated in place");
    expect(check.out).toContain("RC=1");
    unchanged(d, { changelog: edited });
  });

  it("leaves a floor block under an older section alone, and adds one to this section", () => {
    const shipped = OAM_CHANGELOG.replace(
      "Old text.",
      "Old text.\n\n**Changed -- the oam floor moves to 0.13.1**\n\nText; the floor was 0.12.0. More.",
    );
    const d = floorDir({ changelog: shipped });
    expect(rewrite(d, "--write").out.trim()).toBe("RC=0");
    const log = readFileSync(join(d, "CHANGELOG.md"), "utf8");
    expect(log).toContain("**Changed -- the oam floor moves to 0.13.1**\n\nText; the floor was 0.12.0. More.");
    expect(log.indexOf("**Changed -- the oam floor moves to 0.15.2**")).toBeLessThan(log.indexOf("## 1.0.1 -- older"));
  });

  it.each([
    ["0.13.1", "0.15.2", "-1"],
    ["0.15.2", "0.15.2", "0"],
    ["0.15.3", "0.15.2", "1"],
    ["0.10.0", "0.9.9", "1"],
    ["0.9.9", "0.10.0", "-1"],
    ["1.0.0", "0.99.99", "1"],
  ])("semver_cmp %s %s is %s, part by part as numbers", (a, b, want) => {
    expect(sh([`semver_cmp ${a} ${b}`]).out.trim()).toBe(want);
  });
});

describe("release.sh oam floor pre-flight", () => {
  const block = extractBlock("# >>> oam floor pre-flight", "# <<< oam floor pre-flight");

  type PreflightRun = RunResult & { dir: string };

  function run(
    opts: OamFixture & {
      body?: string;
      curlRc?: number;
      curlErr?: string;
      resuming?: boolean;
      allowStale?: boolean | string;
      published?: string;
      tagged?: boolean;
    } = {},
  ): PreflightRun {
    const dir = newTmp("release-oam-pre-");
    writeOamFixture(dir, opts);
    // A real repo, so the v9.9.9 tag lookup asks real git, and asks this repo
    // rather than any repo above the temp dir.
    git(dir, ["init", "-q", "-b", "main"]);
    if (opts.tagged) {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "fixture"]);
      git(dir, ["tag", "-a", "v9.9.9", "-m", "v9.9.9"]);
    }
    const body = [
      STUB_HELPERS,
      TOKEN_STUB,
      OAM_HELPERS,
      CURL_STUB,
      `RESUMING=${opts.resuming ? "true" : "false"}`,
      'VERSION="9.9.9"',
      `ALREADY_PUBLISHED="${opts.published ?? ""}"`,
      block,
      'echo "TARGET=[$OAM_FLOOR_TARGET] DATE=[$OAM_FLOOR_DATE] LOCKED=[$OAM_FLOOR_LOCKED]"',
      'echo "BLOCK=[$OAM_FLOOR_BLOCK]"',
      'echo "CONTINUED"',
    ].join("\n");
    const r = runBash(body, dir, {
      ...GIT_ENV,
      FAKE_BODY: opts.body ?? oamRelease(),
      FAKE_CURL_RC: String(opts.curlRc ?? 0),
      FAKE_CURL_ERR: opts.curlErr ?? "",
      // Set either way, so an operator's own environment cannot flip a case.
      ALLOW_STALE_OAM_FLOOR: typeof opts.allowStale === "string" ? opts.allowStale : opts.allowStale ? "1" : "",
      FAKE_GH_TOKEN: "",
    });
    return { ...r, dir };
  }

  it("plans nothing when the floor is the latest release", () => {
    const r = run({ floor: "0.15.2" });
    expect(r.out).toContain("INFO oam floor 0.15.2 is the latest oam release");
    expect(r.out).toContain("TARGET=[] DATE=[]");
    expect(r.out).toContain("BLOCK=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("plans the move on a fresh release whose floor is behind, and writes nothing yet", () => {
    const r = run({ floor: "0.13.1" });
    expect(r.out).toContain("INFO oam floor 0.13.1 is behind oam 0.15.2 (published 2026-09-13)");
    expect(r.out).toContain("TARGET=[0.15.2] DATE=[2026-09-13] LOCKED=[false]");
    // The block the move will write, as --check rendered it, for the behaviour-change gate.
    expect(r.out).toContain("BLOCK=[**Changed -- the oam floor moves to 0.15.2**\n\n`MIN_OAM_VERSION` tracks");
    expect(r.out).toContain("the floor was 0.13.1.");
    expect(r.out).toContain("CONTINUED");
    expect(readFileSync(join(r.dir, "src", "oam-spawn.ts"), "utf8")).toBe(oamSrcFixture("0.13.1"));
    expect(readFileSync(join(r.dir, "src", "tests", "oam-spawn.test.ts"), "utf8")).toBe(oamTestFixture("0.13.1"));
    expect(readFileSync(join(r.dir, "CHANGELOG.md"), "utf8")).toBe(OAM_CHANGELOG);
  });

  it("compares versions as numbers, so 0.9.9 is behind 0.10.0", () => {
    const r = run({ floor: "0.9.9", body: oamRelease({ tag_name: "v0.10.0" }) });
    expect(r.out).toContain("TARGET=[0.10.0]");
  });

  it("does not move the floor once the version is on npm, and says so", () => {
    const r = run({ floor: "0.13.1", resuming: true, published: "9.9.9" });
    expect(r.out).toContain(
      "WARN oam 0.15.2 is out and the oam floor is still 0.13.1 -- v9.9.9 is already tagged or on npm, so this run does not move it",
    );
    expect(r.out).toContain("TARGET=[] DATE=[] LOCKED=[true]");
    expect(r.out).toContain("BLOCK=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("does not move the floor once v<version> is tagged", () => {
    const r = run({ floor: "0.13.1", resuming: true, tagged: true });
    expect(r.out).toContain("v9.9.9 is already tagged or on npm, so this run does not move it");
    expect(r.out).toContain("TARGET=[] DATE=[] LOCKED=[true]");
    expect(r.out).toContain("CONTINUED");
  });

  it("moves the floor on a resume that is neither tagged nor published, with every fresh-release stop", () => {
    // RESUMING only means package.json already reads VERSION: a hand-run
    // `npm version`, a bump committed ahead of the release, or a run that died
    // in step 3 before tagging. Nothing irreversible has happened yet, so the
    // floor still moves -- and the stops that come with moving it still apply.
    const r = run({ floor: "0.13.1", resuming: true });
    expect(r.out).toContain("INFO oam floor 0.13.1 is behind oam 0.15.2");
    expect(r.out).toContain("TARGET=[0.15.2] DATE=[2026-09-13] LOCKED=[false]");
    expect(r.out).toContain("CONTINUED");

    const unreadable = run({ floor: "0.13.1", resuming: true, curlRc: 6 });
    expect(unreadable.out).toContain("FAIL Could not read the latest oam release");
    expect(unreadable.out).toContain("ALLOW_STALE_OAM_FLOOR=1");
    expect(unreadable.out).not.toContain("CONTINUED");

    const ahead = run({ floor: "0.16.0", resuming: true });
    expect(ahead.out).toContain("FAIL The oam floor 0.16.0 is AHEAD of the latest oam release 0.15.2");
    expect(ahead.out).not.toContain("CONTINUED");
  });

  it("fails closed on a fresh release when GitHub cannot be read, pointing at curl's own line", () => {
    const r = run({ curlRc: 22, curlErr: "The requested URL returned error: 403" });
    expect(r.out).toContain("curl: (22) The requested URL returned error: 403");
    expect(r.out).toContain("FAIL Could not read the latest oam release");
    expect(r.out).toContain("(the curl or parser error above says why)");
    expect(r.out).toContain("ALLOW_STALE_OAM_FLOOR=1");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("still fails closed under ALLOW_STALE_OAM_FLOOR=0 -- only 1 opts in", () => {
    const r = run({ curlRc: 6, allowStale: "0" });
    expect(r.out).toContain("FAIL Could not read the latest oam release");
    expect(r.out).not.toContain("UNCHECKED");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("proceeds on the current floor, unchecked, under ALLOW_STALE_OAM_FLOOR=1", () => {
    const r = run({ curlRc: 6, allowStale: true });
    expect(r.out).toContain("WARN Could not read the latest oam release from GitHub");
    expect(r.out).toContain("UNCHECKED");
    expect(r.out).toContain("TARGET=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("proceeds, unchecked, once the version is on npm when GitHub cannot be read", () => {
    const r = run({ curlRc: 6, resuming: true, published: "9.9.9" });
    expect(r.out).toContain("UNCHECKED");
    expect(r.out).toContain("CONTINUED");
  });

  it("refuses a floor AHEAD of the latest release, with both ways out, and only warns once the version is on npm", () => {
    const fresh = run({ floor: "0.16.0" });
    expect(fresh.out).toContain("FAIL The oam floor 0.16.0 is AHEAD of the latest oam release 0.15.2");
    // Lowering only the constant turns the ratchet test red, so the recovery
    // names the literal too.
    expect(fresh.out).toContain(
      "lower MIN_OAM_VERSION in src/oam-spawn.ts AND the const FLOOR literal in src/tests/oam-spawn.test.ts to 0.15.2",
    );
    // A lower release holding GitHub's latest marker is fixed on GitHub, not in the floor.
    expect(fresh.out).toContain("gh release edit v0.16.0 --repo YawLabs/oam --latest");
    expect(fresh.out).not.toContain("CONTINUED");
    const locked = run({ floor: "0.16.0", resuming: true, published: "9.9.9" });
    expect(locked.out).toContain("WARN The oam floor 0.16.0 is AHEAD");
    expect(locked.out).toContain("the const FLOOR literal in src/tests/oam-spawn.test.ts");
    expect(locked.out).toContain("CONTINUED");
  });

  it("stops before the prompt when the changelog has no section for this release", () => {
    // The first section is a release that already shipped. Filing the move
    // there would be a lie about 1.0.2, so the run stops instead of guessing.
    const changelog = OAM_CHANGELOG.replace("## Unreleased -- things", "## 1.0.2 -- shipped");
    const r = run({ floor: "0.13.1", changelog });
    expect(r.out).toContain("no section to record the floor move in");
    expect(r.out).toContain("FAIL oam 0.15.2 is out and the oam floor is 0.13.1, but this script cannot move it");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("accepts a first section already renamed to the version being released", () => {
    const changelog = OAM_CHANGELOG.replace("## Unreleased -- things", "## 9.9.9 -- this release");
    expect(run({ floor: "0.13.1", changelog }).out).toContain("TARGET=[0.15.2]");
  });

  it("does not take a longer version for this one (## 9.9.90 is not ## 9.9.9)", () => {
    const changelog = OAM_CHANGELOG.replace("## Unreleased -- things", "## 9.9.90 -- another");
    expect(run({ floor: "0.13.1", changelog }).out).toContain("no section to record the floor move in");
  });

  it("stops before the prompt when the ratchet literal is missing", () => {
    const r = run({ floor: "0.13.1", test: "describe('no ratchet here', () => {});\n" });
    expect(r.out).toContain("expected exactly one const FLOOR line, found 0");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("stops when the floor cannot be read out of the source at all", () => {
    const r = run({ src: "export const OTHER = 1;\n" });
    expect(r.out).toContain("FAIL Could not read the oam floor out of src/oam-spawn.ts");
    expect(r.out).not.toContain("CONTINUED");
  });
});

const OAM_MOVE = extractBlock("# >>> oam floor move", "# <<< oam floor move");

/** A temp git repo holding the three floor files and one unrelated file, all committed. */
function oamRepo(opts: OamFixture = {}): string {
  const dir = newTmp("release-oam-move-");
  writeOamFixture(dir, opts);
  writeFileSync(join(dir, "unrelated.txt"), "before\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

/** Run release.sh's move block in `dir`, as if the pre-flight had read `now` and planned `target`. */
function runMove(dir: string, now: string, target: string): RunResult {
  const body = [
    STUB_HELPERS,
    OAM_HELPERS,
    "CYAN=''",
    "NC=''",
    'VERSION="9.9.9"',
    `OAM_FLOOR_NOW="${now}"`,
    `OAM_FLOOR_TARGET="${target}"`,
    'OAM_FLOOR_DATE="2026-09-13"',
    OAM_MOVE,
    'echo "CONTINUED"',
  ].join("\n");
  return runOutside(dir, body);
}

describe("release.sh oam floor move", () => {
  const repo = oamRepo;
  const run = runMove;
  const read = (dir: string, ...p: string[]) => readFileSync(join(dir, ...p), "utf8");

  it("moves all three, and commits exactly those three files", () => {
    const dir = repo();
    // A change that is STAGED but is not the release's: `git commit -- <paths>`
    // must leave it out of the floor commit, and still staged.
    writeFileSync(join(dir, "unrelated.txt"), "after\n");
    git(dir, ["add", "unrelated.txt"]);

    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("INFO oam floor 0.13.1 -> 0.15.2, committed");
    expect(r.out).toContain("WARN Not re-run by this script");
    expect(r.out).toContain("CONTINUED");

    expect(read(dir, "src", "oam-spawn.ts")).toBe(oamSrcFixture("0.15.2"));
    expect(read(dir, "src", "tests", "oam-spawn.test.ts")).toBe(oamTestFixture("0.15.2"));
    expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("fix(oam): move the floor to 0.15.2");
    const committed = git(dir, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    expect(committed).toEqual(["CHANGELOG.md", "src/oam-spawn.ts", "src/tests/oam-spawn.test.ts"]);
    expect(git(dir, ["status", "--porcelain"])).toBe("M  unrelated.txt\n");
  });

  it("files the block at the END of the Unreleased section, above the release before it", () => {
    const dir = repo();
    run(dir, "0.13.1", "0.15.2");
    const log = read(dir, "CHANGELOG.md");
    const heading = "**Changed -- the oam floor moves to 0.15.2**";
    expect(log.indexOf(heading)).toBeGreaterThan(log.indexOf("A paragraph."));
    expect(log.indexOf(heading)).toBeLessThan(log.indexOf("## 1.0.1 -- older"));
    expect(log).toContain("v0.15.2 is now current (published 2026-09-13); the floor was 0.13.1.");
    // One blank line on each side of the block, none doubled.
    expect(log).toContain(`A paragraph.\n\n${heading}\n\n`);
    expect(log).not.toContain("\n\n\n");
    expect(log).toContain(
      "did not re-run the oam hosting check that `src/oam-spawn.ts` describes.\n\n## 1.0.1 -- older",
    );
  });

  it("appends at the end of the file when the section is the only one, keeping one trailing newline", () => {
    const dir = repo({ changelog: "# Changelog\n\n## Unreleased -- only\n\nA paragraph.\n" });
    run(dir, "0.13.1", "0.15.2");
    const log = read(dir, "CHANGELOG.md");
    expect(
      log.startsWith(
        "# Changelog\n\n## Unreleased -- only\n\nA paragraph.\n\n**Changed -- the oam floor moves to 0.15.2**\n\n",
      ),
    ).toBe(true);
    expect(log.endsWith("describes.\n")).toBe(true);
  });

  it("keeps a CRLF changelog CRLF", () => {
    const dir = repo({ changelog: OAM_CHANGELOG.replace(/\n/g, "\r\n") });
    run(dir, "0.13.1", "0.15.2");
    const log = read(dir, "CHANGELOG.md");
    expect(log).toContain("**Changed -- the oam floor moves to 0.15.2**\r\n");
    expect(/(^|[^\r])\n/.test(log)).toBe(false);
  });

  it("moves nothing, and commits nothing, when the floor is already at the target", () => {
    // The pre-flight's value is stale by the time this runs; the block re-reads.
    const dir = repo({ floor: "0.15.2" });
    const before = git(dir, ["rev-parse", "HEAD"]);
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("INFO oam floor already at 0.15.2 -- nothing to move");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(read(dir, "CHANGELOG.md")).toBe(OAM_CHANGELOG);
  });

  it("writes none of the three files when one of them does not validate", () => {
    const dir = repo({ test: "describe('no ratchet here', () => {});\n" });
    const before = git(dir, ["rev-parse", "HEAD"]);
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("FAIL Could not move the oam floor to 0.15.2");
    expect(r.out).not.toContain("CONTINUED");
    expect(read(dir, "src", "oam-spawn.ts")).toBe(oamSrcFixture("0.13.1"));
    expect(read(dir, "CHANGELOG.md")).toBe(OAM_CHANGELOG);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
  });

  it.each([
    // A half-written edit would ride inside the floor commit.
    ["a half-written edit", `${oamSrcFixture("0.13.1")}export const HALF_WRITTEN = (\n`],
    // A floor hand-set to the target would take the nothing-to-move branch and
    // stay uncommitted, so the dirt check has to come before the re-read.
    ["the floor hand-set to the target", oamSrcFixture("0.15.2")],
  ])("stops, committing nothing, when src/oam-spawn.ts holds %s since the pre-flight", (_name, src) => {
    const dir = repo();
    const before = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "src", "oam-spawn.ts"), src);
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("FAIL Uncommitted changes appeared in the oam floor files since the pre-flight");
    expect(r.out).toContain(" M src/oam-spawn.ts");
    expect(r.out).not.toContain("nothing to move");
    expect(r.out).not.toContain("CONTINUED");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(read(dir, "CHANGELOG.md")).toBe(OAM_CHANGELOG);
  });

  it("stops, rather than lowering it, when the floor was committed AHEAD of the target since the pre-flight", () => {
    const dir = repo({ floor: "0.16.0" });
    const before = git(dir, ["rev-parse", "HEAD"]);
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("FAIL The oam floor now reads 0.16.0, not below 0.15.2 as the pre-flight planned");
    expect(r.out).not.toContain("CONTINUED");
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(read(dir, "src", "oam-spawn.ts")).toBe(oamSrcFixture("0.16.0"));
  });

  it("rewrites its own block in place on a second move, keeping the floor the last release shipped", () => {
    // The re-run after a failed gate, with oam released again in between.
    const dir = repo();
    expect(run(dir, "0.13.1", "0.15.2").out).toContain("INFO oam floor 0.13.1 -> 0.15.2, committed");
    const r = run(dir, "0.15.2", "0.15.3");
    expect(r.out).toContain("INFO oam floor 0.15.2 -> 0.15.3, committed");
    const log = read(dir, "CHANGELOG.md");
    const section = log.slice(0, log.indexOf("## 1.0.1 -- older"));
    expect(section.match(/oam floor moves to/g)).toHaveLength(1);
    expect(section).toContain("**Changed -- the oam floor moves to 0.15.3**");
    expect(section).toContain("v0.15.3 is now current (published 2026-09-13); the floor was 0.13.1.");
    expect(log).not.toContain("0.15.2 is now current");
    expect(log).not.toContain("\n\n\n");
    expect(read(dir, "src", "oam-spawn.ts")).toBe(oamSrcFixture("0.15.3"));
    expect(git(dir, ["log", "--format=%s"]).trim().split("\n")).toEqual([
      "fix(oam): move the floor to 0.15.3",
      "fix(oam): move the floor to 0.15.2",
      "fixture",
    ]);
  });

  it("files the block under a first section already renamed to the version being released", () => {
    // The only move case whose section is found by VERSION rather than by
    // the Unreleased pattern, so the only one that needs the move to pass it.
    const dir = repo({ changelog: OAM_CHANGELOG.replace("## Unreleased -- things", "## 9.9.9 -- this release") });
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).toContain("INFO oam floor 0.13.1 -> 0.15.2, committed");
    const log = read(dir, "CHANGELOG.md");
    const heading = "**Changed -- the oam floor moves to 0.15.2**";
    expect(log.indexOf(heading)).toBeGreaterThan(log.indexOf("## 9.9.9 -- this release"));
    expect(log.indexOf(heading)).toBeLessThan(log.indexOf("## 1.0.1 -- older"));
  });

  it("commits past a refusing local pre-commit hook", () => {
    const dir = repo();
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "pre-commit"), "#!/bin/sh\necho HOOK_RAN\nexit 1\n");
    chmodSync(join(dir, "hooks", "pre-commit"), 0o755);
    // A LOCAL hooksPath, which is how the real checkout is configured; GIT_ENV
    // blanks only the global and system config.
    git(dir, ["config", "core.hooksPath", "hooks"]);
    const r = run(dir, "0.13.1", "0.15.2");
    expect(r.out).not.toContain("HOOK_RAN");
    expect(r.out).toContain("INFO oam floor 0.13.1 -> 0.15.2, committed");
    expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("fix(oam): move the floor to 0.15.2");
  });

  it("keeps a caller's GIT_DIR, GIT_INDEX_FILE and XDG git config out of the fixture repo", () => {
    // git exports GIT_DIR and GIT_INDEX_FILE to every hook. A suite run from a
    // pre-commit hook must not commit the fixture into the operator's repo or
    // rewrite its index. And a user git/ignore under XDG_CONFIG_HOME, which
    // GIT_CONFIG_GLOBAL does not replace, must not hide the fixture's files.
    const outer = newTmp("release-oam-outer-");
    writeFileSync(join(outer, "keep.txt"), "outer\n");
    git(outer, ["init", "-q", "-b", "main"]);
    git(outer, ["add", "-A"]);
    git(outer, ["commit", "-q", "-m", "outer"]);
    const head = git(outer, ["rev-parse", "HEAD"]);
    const index = readFileSync(join(outer, ".git", "index"));
    const xdg = newTmp("release-oam-xdg-");
    mkdirSync(join(xdg, "git"));
    writeFileSync(join(xdg, "git", "ignore"), "*.txt\n");

    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.GIT_DIR = join(outer, ".git");
    process.env.GIT_INDEX_FILE = join(outer, ".git", "index");
    process.env.XDG_CONFIG_HOME = xdg;
    let dir = "";
    let r: RunResult = { status: null, out: "" };
    try {
      dir = repo();
      r = run(dir, "0.13.1", "0.15.2");
      // What the first move case does: stage a change to a .txt file.
      writeFileSync(join(dir, "unrelated.txt"), "after\n");
      git(dir, ["add", "unrelated.txt"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
    expect(r.out).toContain("INFO oam floor 0.13.1 -> 0.15.2, committed");
    expect(git(outer, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(outer, ".git", "index")).equals(index)).toBe(true);
    expect(git(dir, ["log", "--format=%s"]).trim().split("\n")).toEqual([
      "fix(oam): move the floor to 0.15.2",
      "fixture",
    ]);
  });

  it("does nothing at all when no move was planned", () => {
    const dir = repo();
    const r = run(dir, "0.13.1", "");
    expect(r.out.trim()).toBe("CONTINUED");
  });
});

describe("release.sh oam_floor_commits_only", () => {
  // Whether local main is ahead of a base ONLY by the move block's own
  // commits -- the shape the origin/main sync guard lets a re-run carry on over.
  function ahead(dir: string, base: string): string {
    const body = [OAM_HELPERS, `if oam_floor_commits_only "${base}"; then echo "ONLY_FLOOR"; else echo "OTHER"; fi`];
    return runOutside(dir, body.join("\n")).out.trim();
  }

  function start(): { dir: string; base: string } {
    const dir = oamRepo();
    return { dir, base: git(dir, ["rev-parse", "HEAD"]).trim() };
  }

  it("answers no when nothing is ahead, and yes for one floor commit or two", () => {
    const { dir, base } = start();
    expect(ahead(dir, base)).toBe("OTHER");
    expect(runMove(dir, "0.13.1", "0.15.2").out).toContain("committed");
    expect(ahead(dir, base)).toBe("ONLY_FLOOR");
    expect(runMove(dir, "0.15.2", "0.15.3").out).toContain("committed");
    expect(ahead(dir, base)).toBe("ONLY_FLOOR");
  });

  it("answers no when any other commit is ahead, above the floor commit or below it", () => {
    const above = start();
    runMove(above.dir, "0.13.1", "0.15.2");
    writeFileSync(join(above.dir, "unrelated.txt"), "fix\n");
    git(above.dir, ["commit", "-q", "-am", "fix a test"]);
    expect(ahead(above.dir, above.base)).toBe("OTHER");

    const below = start();
    writeFileSync(join(below.dir, "unrelated.txt"), "fix\n");
    git(below.dir, ["commit", "-q", "-am", "fix a test"]);
    runMove(below.dir, "0.13.1", "0.15.2");
    expect(ahead(below.dir, below.base)).toBe("OTHER");
  });

  it("answers no for the floor subject on other paths, and for the floor paths under another subject", () => {
    const subject = start();
    writeFileSync(join(subject.dir, "unrelated.txt"), "sneaky\n");
    git(subject.dir, ["commit", "-q", "-am", "fix(oam): move the floor to 0.15.2"]);
    expect(ahead(subject.dir, subject.base)).toBe("OTHER");

    const paths = start();
    runMove(paths.dir, "0.13.1", "0.15.2");
    git(paths.dir, ["commit", "-q", "--amend", "-m", "chore: bump the floor"]);
    expect(ahead(paths.dir, paths.base)).toBe("OTHER");
  });

  it("answers no for a merge, even one with the floor subject", () => {
    const { dir, base } = start();
    git(dir, ["checkout", "-q", "-b", "side"]);
    runMove(dir, "0.13.1", "0.15.2");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--no-ff", "-m", "fix(oam): move the floor to 0.15.2", "side"]);
    expect(git(dir, ["rev-list", "--count", `${base}..HEAD`]).trim()).toBe("2");
    expect(ahead(dir, base)).toBe("OTHER");
  });
});

describe("release.sh behaviour-change gate with a planned oam floor move", () => {
  // A floor move is a changed threshold, so the truthful answer to the gate is
  // yes, and its way back is `oam self-update`. The move writes the block that
  // names it AFTER the gate, so the gate reads the block --check rendered.
  const gate = extractBlock(
    '  read -p "Behaviour change with no opt-in? (y/N) " -r BEHAVIOUR_REPLY || BEHAVIOUR_REPLY=""',
    "  fi",
  );

  function run(target: string): RunResult {
    const dir = newTmp("release-oam-gate-");
    writeOamFixture(dir);
    const check = runBash(
      [
        STUB_HELPERS,
        TOKEN_STUB,
        OAM_HELPERS,
        "oam_floor_rewrite --check src/oam-spawn.ts src/tests/oam-spawn.test.ts CHANGELOG.md 0.15.2 0.13.1 2026-09-13 0.81.0",
      ].join("\n"),
      dir,
    );
    expect(check.status).toBe(0);
    // The fixture's own Unreleased section does not name the switch, so only the rendered block can.
    expect(OAM_CHANGELOG).not.toContain("oam self-update");
    expect(check.out).toContain("`oam self-update`");
    const body = [STUB_HELPERS, 'VERSION="0.81.0"', "CYAN=''", "NC=''", gate, 'echo "CONTINUED"'].join("\n");
    const file = join(newTmp("release-oam-gate-harness-"), "gate.sh");
    writeFileSync(file, body);
    const r = spawnSync("bash", [file], {
      cwd: dir,
      encoding: "utf8",
      input: "y\noam self-update\n",
      env: { ...baseEnv(), NO_COLOR: "1", OAM_FLOOR_TARGET: target, OAM_FLOOR_BLOCK: check.out },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("accepts oam self-update, which only the block the move has yet to write names", () => {
    const r = run("0.15.2");
    expect(r.out).toContain("oam self-update found in the Unreleased section");
    expect(r.out).toContain("CONTINUED");
  });

  it("still aborts on the same answers when no floor move is planned", () => {
    const r = run("");
    expect(r.out).toContain("'oam self-update' does not appear in CHANGELOG.md's Unreleased section");
    expect(r.out).not.toContain("CONTINUED");
  });
});

describe("release.sh oam floor block placement", () => {
  // Every oam case above drives a block lifted out of release.sh, which tests
  // its logic but not where it sits. The order is load-bearing: the helpers
  // are defined before the sync guard calls one, the pre-flight runs after the
  // tag guard and before the prompt (which needs its plan), and the move runs
  // after the prompt and before step 1 (whose gates must cover it).
  it("keeps the helpers, sync guard, pre-flight, prompt, move and step 1 in that order", () => {
    const lines = releaseSh.split("\n");
    const at = (l: string) => {
      const i = lines.indexOf(l);
      if (i === -1) {
        throw new Error(`release.sh anchor not found: ${JSON.stringify(l)}`);
      }
      return i;
    };
    const order = [
      at("# <<< oam floor helpers"),
      at('    if oam_floor_commits_only "$REMOTE_HEAD"; then'),
      at('if [ "$RESUMING" != true ] && git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1; then'),
      at("# >>> oam floor pre-flight"),
      at("# <<< oam floor pre-flight"),
      at('if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then'),
      at("# >>> oam floor move"),
      at("# <<< oam floor move"),
      at('step 1 "Lint + typecheck + tests"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("release.sh oam floor re-run after a failed gate (stubbed full run)", () => {
  // The whole script, end to end, over a floor that is behind: see the file
  // header for what is stubbed and what keeps the real npm out of reach. The
  // floor move commits ahead of step 1, so a failing gate leaves that commit
  // on local main, and the re-run meets the origin/main sync guard with main
  // ahead of origin. It must carry on over the script's own commit, and only
  // over that.
  const NPM_STUB = [
    "#!/bin/bash",
    'echo "npm $*" >> "$FAKE_STATE/npm.log"',
    'case "$1" in',
    "  view)",
    '    case "$2" in',
    '      "@yawlabs/mcp") echo "1.0.1" ;;',
    '      "@yawlabs/mcp@"*)',
    '        v="${2#@yawlabs/mcp@}"',
    '        if [ -f "$FAKE_STATE/published-$v" ]; then',
    '          if [ "${3:-}" = "dist.integrity" ]; then echo "sha512-fixture"; else echo "$v"; fi',
    "        fi ;;",
    "    esac ;;",
    "  whoami) echo fixture ;;",
    "  run)",
    '    case "$2" in',
    '      lint) echo "Checked 3 files" ;;',
    "      typecheck) ;;",
    "      test)",
    '        if [ -f "$FAKE_STATE/fail-tests" ]; then echo " Test Files  1 failed (3)"; exit 1; fi',
    '        echo " Test Files  3 passed (3)" ;;',
    '      build) mkdir -p dist; echo "built" > dist/index.js ;;',
    "    esac ;;",
    "  version)",
    `    node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("package.json","utf8"));j.version=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(j,null,2)+String.fromCharCode(10))' "$2" ;;`,
    "  publish)",
    `    v=$(node -p 'require("./package.json").version'); touch "$FAKE_STATE/published-$v"; echo "+ @yawlabs/mcp@$v" ;;`,
    `  pack) echo '[{"integrity":"sha512-fixture"}]' ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const CURL_SCRIPT = [
    "#!/bin/bash",
    'echo "curl $*" >> "$FAKE_STATE/curl.log"',
    'case "$*" in',
    "  *api.github.com/repos/YawLabs/oam/releases/latest*)",
    `    printf '{"tag_name":"v%s","published_at":"2026-09-13T13:11:42Z","draft":false,"prerelease":false}' "$(cat "$FAKE_STATE/oam-latest")" ;;`,
    "  *registry.modelcontextprotocol.io*)",
    '    u="$*"; v="${u#*version=}"; v="${v%%&*}"',
    `    if [ -f "$FAKE_STATE/published-$v" ]; then printf '{"servers":[{"server":{"version":"%s"}}]}' "$v"; else printf '{"servers":[]}'; fi ;;`,
    '  *) echo "curl: (22) the stub does not serve $*" >&2; exit 22 ;;',
    "esac",
    "",
  ].join("\n");

  type FullRun = { root: string; work: string; bare: string; state: string };

  function setup(): FullRun {
    const root = newTmp("release-oam-full-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const stubs: [string, string][] = [
      ["npm", NPM_STUB],
      ["curl", CURL_SCRIPT],
      ["gh", "#!/bin/bash\nexit 1\n"],
    ];
    for (const [name, text] of stubs) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "oam-latest"), "0.15.2");
    writeFileSync(join(root, "npmrc"), "");

    const bare = join(root, "origin.git");
    git(root, ["init", "-q", "--bare", "-b", "main", bare]);
    const work = join(root, "work");
    mkdirSync(work);
    copyFileSync(releaseShPath, join(work, "release.sh"));
    writeOamFixture(work);
    mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
    for (const b of ALL_BINS) {
      writeFileSync(join(work, "node_modules", ".bin", b), "");
    }
    writeFileSync(join(work, ".gitignore"), "node_modules\ndist\n");
    const pkg = { name: "@yawlabs/mcp", version: "1.0.1", mcpName: "io.github.YawLabs/mcp", description: "fixture" };
    writeFileSync(join(work, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(work, "package-lock.json"), "{}\n");
    const server = {
      name: "io.github.YawLabs/mcp",
      description: "a valid short description",
      version: "1.0.1",
      packages: [{ version: "1.0.1" }],
    };
    writeFileSync(join(work, "server.json"), `${JSON.stringify(server, null, 2)}\n`);
    git(work, ["init", "-q", "-b", "main"]);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "fixture"]);
    git(work, ["remote", "add", "origin", shPath(bare)]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["fetch", "-q", "origin"]);
    return { root, work, bare, state };
  }

  function release(f: FullRun): RunResult {
    const harness = [
      `STUBS="$(cd "${shPath(join(f.root, "bin"))}" && pwd)" || exit 97`,
      'export PATH="$STUBS:$PATH"',
      "for t in npm curl gh; do",
      '  if [ "$(command -v "$t")" != "$STUBS/$t" ]; then',
      '    echo "REFUSING TO RUN: $t resolves to $(command -v "$t"), not the stub"',
      "    exit 98",
      "  fi",
      "done",
      "bash ./release.sh -y 1.0.2",
    ].join("\n");
    const file = join(f.root, "run.sh");
    writeFileSync(file, harness);
    // npm's own config variables go too: with the stub shadowing npm they are
    // unused, and without it they must not point anywhere real.
    const env = Object.fromEntries(
      Object.entries(baseEnv()).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")),
    );
    const r = spawnSync("bash", [file], {
      cwd: f.work,
      encoding: "utf8",
      env: {
        ...env,
        ...GIT_ENV,
        NO_COLOR: "1",
        FAKE_STATE: shPath(f.state),
        NPM_CONFIG_USERCONFIG: join(f.root, "npmrc"),
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
        GITHUB_TOKEN: "",
        MCP_REGISTRY_TOKEN: "",
        SKIP_CONFIRM: "",
        SKIP_LINT: "",
        ALLOW_STALE_REMOTE: "",
        ALLOW_UNVERIFIED_VERSION: "",
        ALLOW_STALE_OAM_FLOOR: "",
      },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).not.toContain("REFUSING TO RUN");
    return { status: r.status, out };
  }

  const subjects = (dir: string, range: string) =>
    git(dir, ["log", "--format=%s", range]).trim().split("\n").filter(Boolean);

  it("carries on over the floor commit a failed test gate left on local main, and pushes it with the bump", () => {
    const f = setup();
    writeFileSync(join(f.state, "fail-tests"), "");
    const first = release(f);
    expect(first.out).toContain("oam floor 0.13.1 -> 0.15.2, committed");
    expect(first.out).toContain("Tests failed");
    expect(first.status).toBe(1);
    expect(subjects(f.work, "origin/main..HEAD")).toEqual(["fix(oam): move the floor to 0.15.2"]);

    rmSync(join(f.state, "fail-tests"));
    const second = release(f);
    expect(second.out).toContain("ahead of origin/main only by release.sh's own oam floor commit(s)");
    expect(second.out).toContain("oam floor 0.15.2 is the latest oam release");
    expect(second.out).toContain("v1.0.2 released to npm + MCP registry.");
    expect(second.status).toBe(0);
    expect(subjects(f.bare, "main")).toEqual(["v1.0.2", "fix(oam): move the floor to 0.15.2", "fixture"]);
    expect(git(f.bare, ["tag", "-l"]).trim()).toBe("v1.0.2");
  });

  it("still stops at the sync guard when another commit sits on the floor commit, and names the undo", () => {
    const f = setup();
    writeFileSync(join(f.state, "fail-tests"), "");
    expect(release(f).status).toBe(1);
    writeFileSync(join(f.work, "README.md"), "a fix for the failing test\n");
    git(f.work, ["add", "README.md"]);
    git(f.work, ["commit", "-q", "-m", "fix the failing test"]);
    rmSync(join(f.state, "fail-tests"));

    const second = release(f);
    expect(second.out).toContain("Local main is AHEAD of origin/main (unpushed commits)");
    expect(second.out).toContain("git reset --keep origin/main and re-run");
    expect(second.status).toBe(1);
    expect(subjects(f.bare, "main")).toEqual(["fixture"]);
    expect(git(f.bare, ["tag", "-l"]).trim()).toBe("");
  });
});
