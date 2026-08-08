// The CLI dispatcher (src/index.ts) -- the one module nothing else in this
// suite reaches.
//
// index.ts reads process.argv and dispatches at MODULE SCOPE, so it cannot be
// imported and called; the only way to exercise it is to run it the way a user
// does. That gap mattered when the 13 open-coded parse tails were factored
// into run(): the entire point of that change was that a usage body must
// survive a slow pipe, and nothing in the suite could have caught a regression
// that sent help to stderr, or let an argv error exit 0, or stranded the
// process on a pending handle once process.exit() stopped being called.
//
// Runs against dist/, matching `test:ci` (build && test). Builds once when
// dist is absent so a bare `npm test` on a fresh clone still works.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "dist", "index.js");

/** Newest mtime among the BUNDLED sources (tests are not bundled). Building
 *  only when dist/ is absent would let an edited index.ts run against a stale
 *  build -- a green that proves nothing, which is worse here than no test,
 *  since this file is the only coverage the dispatcher has. */
function newestSourceMtime(): number {
  const srcDir = join(repoRoot, "src");
  let newest = 0;
  for (const entry of readdirSync(srcDir, { recursive: true })) {
    const rel = String(entry);
    if (!rel.endsWith(".ts") || rel.includes("tests")) continue;
    const stat = statSync(join(srcDir, rel));
    if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

beforeAll(() => {
  if (existsSync(cli) && statSync(cli).mtimeMs >= newestSourceMtime()) return;
  // npm on Windows is a .cmd shim, and Node refuses to exec one without a
  // shell since the CVE-2024-27980 fix -- same concession sidecars-cmd makes
  // for the same reason. Every argument here is a fixed literal.
  const isWindows = process.platform === "win32";
  execFileSync(isWindows ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: isWindows,
  });
}, 180_000);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. spawnSync gives the child PIPES rather than a tty,
 *  which is the condition the exitCode-instead-of-exit change exists for. */
function runCli(args: string[]): CliRun {
  const res = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("CLI dispatch -- help goes to stdout and exits 0", () => {
  it("prints a subcommand usage on the shared parse tail", () => {
    const r = runCli(["sidecars", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp sidecars install [--json]");
    expect(r.stderr, "usage went to stderr").toBe("");
  });

  it("prints install's usage, which rides a SUCCESSFUL parse instead", () => {
    // install signals --help via helpRequested on the ok branch, so it has its
    // own branch rather than the shared tail -- a second shape to keep right.
    const r = runCli(["install", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp install <claude-code|claude-desktop|cursor|vscode>");
    expect(r.stderr).toBe("");
  });

  it("prints doctor's usage, which is hand-rolled rather than parser-driven", () => {
    const r = runCli(["doctor", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp doctor [--json]");
    expect(r.stderr).toBe("");
  });

  it("delivers the whole multi-KB top-level help through a pipe", () => {
    // THE regression the exitCode change exists to prevent: a synchronous
    // process.exit() force-flushes the event loop and can truncate a buffered
    // body when stdout is a pipe. Asserting the LAST line is what proves the
    // body arrived whole rather than merely started.
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("one install, every MCP server");
    expect(r.stdout, "help body was truncated before its final section").toContain(
      "Source: https://github.com/YawLabs/mcp",
    );
    expect(r.stdout.length).toBeGreaterThan(6000);
  });

  it("prints the version and exits 0", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^yaw-mcp \S+/);
    expect(r.stderr).toBe("");
  });
});

describe("CLI dispatch -- argv errors go to stderr and exit 2", () => {
  it("rejects an unknown subcommand flag", () => {
    const r = runCli(["sidecars", "--wat"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--wat");
    expect(r.stdout, "an argv error leaked onto stdout").toBe("");
  });

  it("rejects an unknown doctor argument", () => {
    const r = runCli(["doctor", "--bad"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument");
    expect(r.stdout).toBe("");
  });

  it("suggests the closest subcommand for a typo", () => {
    const r = runCli(["doctro"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "doctro"');
    expect(r.stderr).toContain("doctor");
  });

  it("suggests the closest flag for a long-flag typo", () => {
    // Without this branch the argv would fall through to runServer() and hang
    // as a stdio MCP server with no diagnostic -- so exiting at all is the
    // behaviour under test, not just the exit code.
    const r = runCli(["--versionn"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown flag "--versionn"');
    expect(r.stderr).toContain("--version");
  });
});
