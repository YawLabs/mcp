// release.sh -- the pre-flight guards.
//
// Until now this file had ZERO coverage: across the whole suite the only
// occurrence of the string "release.sh" was a comment. Every guard in it
// protects an IRREVERSIBLE step (npm forbids re-publishing a version, and the
// step-3 push lands on protected main), so a guard that silently inverts is
// expensive in exactly the way tests are cheap.
//
// Two harness shapes, both hermetic -- no network, no git remote, no npm:
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
// Deliberately not covered: the IS_MINGW_ARM64 139/134 tolerance paths. They
// are reachable only when uname reports ARM64, so a test would be the one
// host-conditional file in the suite and would pass vacuously everywhere else.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MIN_OAM_VERSION } from "../oam-spawn.js";

// Every case here spawnSyncs a real bash running a real script, and there are
// 55 of them: ~142 s of wall clock for the file, so ~2.6 s a case on an idle
// box. None of them ASSERTS a duration -- they assert on the script's stdout
// -- so the only clock that matters is the harness's patience, and the global
// 30 s testTimeout was it.
//
// That was enough until the suite grew: the default run packs the parallel
// files onto every core at once, and under that contention a single case was
// observed taking 30.3 s and failing the whole run. Twice, non-deterministically,
// on a green tree. The same file passes standalone in 142 s.
//
// So this is NOT a TIMING_SENSITIVE file (vitest.config.ts) -- that project is
// for assertions whose SUBJECT is a budget, where isolating the file is what
// makes the number meaningful, and moving a 142 s file into that sequential
// group would put all of it on the critical path. Here the deadline is
// incidental, so the fix is to stop measuring patience in units set for
// in-process unit tests. 5 minutes is ~2x the file's entire standalone
// runtime, so no single case can plausibly reach it without being genuinely
// wedged, which is the failure this still catches.
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
    env: { ...process.env, NO_COLOR: "1", ...env },
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
    env: { ...process.env, NO_COLOR: "1", ...env },
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
      env: { ...process.env, NO_COLOR: "1" },
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
      env: { ...process.env, NO_COLOR: "1" },
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
// that release from GitHub in its pre-flight and, on a fresh release, moves the
// constant, its test ratchet and a changelog block to it in a commit made
// before step 1. Every case here is hermetic: curl is a shell function, and the
// one git repo is a local temp repo with the operator's own config shut out.

const OAM_HELPERS = extractBlock("# >>> oam floor helpers", "# <<< oam floor helpers");

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

/** curl as a shell function: records its arguments, prints $FAKE_BODY, exits $FAKE_CURL_RC. */
const CURL_STUB = 'curl() { echo "$*" > curl-args.txt; printf \'%s\' "${FAKE_BODY:-}"; return "${FAKE_CURL_RC:-0}"; }';

describe("release.sh oam floor helpers", () => {
  const dir = newTmp("release-oam-helpers-");
  const realSrc = shPath(join(repoRoot, "src", "oam-spawn.ts"));
  const realTest = shPath(join(repoRoot, "src", "tests", "oam-spawn.test.ts"));

  function sh(lines: string[], env: Record<string, string> = {}): RunResult {
    return runBash([STUB_HELPERS, OAM_HELPERS, CURL_STUB, ...lines].join("\n"), dir, env);
  }

  it("reads the real MIN_OAM_VERSION out of src/oam-spawn.ts", () => {
    const r = sh([`OAM_FLOOR_SRC="${realSrc}"`, "current_oam_floor"]);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe(MIN_OAM_VERSION);
  });

  it("can move the real constant and the real ratchet literal", () => {
    // Pins the SHAPES the move depends on in the two real source files. If
    // either line is reshaped, this goes red now rather than on the next
    // release that needs a move. The changelog is a fixture: whether the real
    // one has an Unreleased section depends on where it is in a release cycle.
    writeFileSync(join(dir, "CHANGELOG.md"), OAM_CHANGELOG);
    const r = sh([
      `oam_floor_rewrite --check "${realSrc}" "${realTest}" CHANGELOG.md 999.0.0 "${MIN_OAM_VERSION}" 2026-01-01 9.9.9`,
      'echo "RC=$?"',
    ]);
    expect(r.out.trim()).toBe("RC=0");
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
    expect(readFileSync(join(dir, "curl-args.txt"), "utf8")).toContain(
      "https://api.github.com/repos/YawLabs/oam/releases/latest",
    );
  });

  it("accepts a tag written without the v", () => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], {
      FAKE_BODY: oamRelease({ tag_name: "0.15.2" }),
      FAKE_CURL_RC: "0",
    });
    expect(r.out.trim()).toBe("RC=0 OUT=[0.15.2 2026-09-13]");
  });

  it.each([
    ["a prerelease", oamRelease({ prerelease: true }), "0"],
    ["a draft", oamRelease({ draft: true }), "0"],
    ["a tag that is not a version", oamRelease({ tag_name: "nightly" }), "0"],
    ["a two-part version", oamRelease({ tag_name: "v0.15" }), "0"],
    ["a release with no publish date", oamRelease({ published_at: null }), "0"],
    ["a body that is not JSON", "<html>rate limited</html>", "0"],
    ["a failed request", oamRelease(), "22"],
  ])("answers nothing, and fails, for %s", (_name, body, rc) => {
    const r = sh(['OUT=$(latest_oam_release); echo "RC=$? OUT=[$OUT]"'], { FAKE_BODY: body, FAKE_CURL_RC: rc });
    expect(r.out.trim()).toBe("RC=1 OUT=[]");
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
    opts: OamFixture & { body?: string; curlRc?: number; resuming?: boolean; allowStale?: boolean } = {},
  ): PreflightRun {
    const dir = newTmp("release-oam-pre-");
    writeOamFixture(dir, opts);
    const body = [
      STUB_HELPERS,
      OAM_HELPERS,
      CURL_STUB,
      `RESUMING=${opts.resuming ? "true" : "false"}`,
      'VERSION="9.9.9"',
      block,
      'echo "TARGET=[$OAM_FLOOR_TARGET] DATE=[$OAM_FLOOR_DATE]"',
      'echo "CONTINUED"',
    ].join("\n");
    const r = runBash(body, dir, {
      FAKE_BODY: opts.body ?? oamRelease(),
      FAKE_CURL_RC: String(opts.curlRc ?? 0),
      // Set either way, so an operator's own environment cannot flip a case.
      ALLOW_STALE_OAM_FLOOR: opts.allowStale ? "1" : "",
    });
    return { ...r, dir };
  }

  it("plans nothing when the floor is the latest release", () => {
    const r = run({ floor: "0.15.2" });
    expect(r.out).toContain("INFO oam floor 0.15.2 is the latest oam release");
    expect(r.out).toContain("TARGET=[] DATE=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("plans the move on a fresh release whose floor is behind, and writes nothing yet", () => {
    const r = run({ floor: "0.13.1" });
    expect(r.out).toContain("INFO oam floor 0.13.1 is behind oam 0.15.2 (published 2026-09-13)");
    expect(r.out).toContain("TARGET=[0.15.2] DATE=[2026-09-13]");
    expect(r.out).toContain("CONTINUED");
    expect(readFileSync(join(r.dir, "src", "oam-spawn.ts"), "utf8")).toBe(oamSrcFixture("0.13.1"));
    expect(readFileSync(join(r.dir, "src", "tests", "oam-spawn.test.ts"), "utf8")).toBe(oamTestFixture("0.13.1"));
    expect(readFileSync(join(r.dir, "CHANGELOG.md"), "utf8")).toBe(OAM_CHANGELOG);
  });

  it("compares versions as numbers, so 0.9.9 is behind 0.10.0", () => {
    const r = run({ floor: "0.9.9", body: oamRelease({ tag_name: "v0.10.0" }) });
    expect(r.out).toContain("TARGET=[0.10.0]");
  });

  it("never moves the floor on a resume", () => {
    const r = run({ floor: "0.13.1", resuming: true });
    expect(r.out).toContain("WARN oam 0.15.2 is out and the oam floor is still 0.13.1 -- a resume does not move it");
    expect(r.out).toContain("TARGET=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails closed on a fresh release when GitHub cannot be read", () => {
    const r = run({ curlRc: 6 });
    expect(r.out).toContain("FAIL Could not read the latest oam release");
    expect(r.out).toContain("ALLOW_STALE_OAM_FLOOR=1");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("proceeds on the current floor, unchecked, under ALLOW_STALE_OAM_FLOOR=1", () => {
    const r = run({ curlRc: 6, allowStale: true });
    expect(r.out).toContain("WARN Could not read the latest oam release from GitHub");
    expect(r.out).toContain("UNCHECKED");
    expect(r.out).toContain("TARGET=[]");
    expect(r.out).toContain("CONTINUED");
  });

  it("proceeds, unchecked, on a resume when GitHub cannot be read", () => {
    const r = run({ curlRc: 6, resuming: true });
    expect(r.out).toContain("UNCHECKED");
    expect(r.out).toContain("CONTINUED");
  });

  it("refuses a floor AHEAD of the latest release on a fresh release, and only warns on a resume", () => {
    const fresh = run({ floor: "0.16.0" });
    expect(fresh.out).toContain("FAIL The oam floor 0.16.0 is AHEAD of the latest oam release 0.15.2");
    expect(fresh.out).not.toContain("CONTINUED");
    const resume = run({ floor: "0.16.0", resuming: true });
    expect(resume.out).toContain("WARN The oam floor 0.16.0 is AHEAD");
    expect(resume.out).toContain("CONTINUED");
  });

  it("stops before the prompt when the changelog has no section for this release", () => {
    // The first section is a release that already shipped. Filing the move
    // there would be a lie about 1.0.1, so the run stops instead of guessing.
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

describe("release.sh oam floor move", () => {
  const block = extractBlock("# >>> oam floor move", "# <<< oam floor move");

  // An empty global config and no system config, so the operator's own commit
  // signing, hooks or autocrlf cannot reach these commits.
  const gitHome = newTmp("release-oam-gitcfg-");
  writeFileSync(join(gitHome, "config"), "");
  const GIT_ENV = {
    GIT_CONFIG_GLOBAL: join(gitHome, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };

  function git(dir: string, args: string[]): string {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return r.stdout;
  }

  function repo(opts: OamFixture = {}): string {
    const dir = newTmp("release-oam-move-");
    writeOamFixture(dir, opts);
    writeFileSync(join(dir, "unrelated.txt"), "before\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture"]);
    return dir;
  }

  function run(dir: string, now: string, target: string): RunResult {
    const body = [
      STUB_HELPERS,
      OAM_HELPERS,
      "CYAN=''",
      "NC=''",
      'VERSION="9.9.9"',
      `OAM_FLOOR_NOW="${now}"`,
      `OAM_FLOOR_TARGET="${target}"`,
      'OAM_FLOOR_DATE="2026-09-13"',
      block,
      'echo "CONTINUED"',
    ].join("\n");
    // The harness lives OUTSIDE the repo, so it can never show up as a change.
    const file = join(newTmp("release-oam-move-harness-"), "move.sh");
    writeFileSync(file, body);
    const r = spawnSync("bash", [file], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", ...GIT_ENV },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

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

  it("does nothing at all when no move was planned", () => {
    const dir = repo();
    const r = run(dir, "0.13.1", "");
    expect(r.out.trim()).toBe("CONTINUED");
  });
});
