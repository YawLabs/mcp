import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "undici";

interface ComplianceReport {
  grade: string;
  score: number;
  url: string;
  summary: { total: number; passed: number; failed: number; required: number; requiredPassed: number };
  tests: unknown[];
  [extra: string]: unknown;
}

export const COMPLIANCE_USAGE =
  "\n  Usage: yaw-mcp compliance <target> [extraArgs...] [--publish]\n\n" +
  "  Examples:\n" +
  '    yaw-mcp compliance "npx -y @modelcontextprotocol/server-filesystem /tmp"\n' +
  "    yaw-mcp compliance https://example.com/mcp --publish\n\n";

/** Injectable output sinks. Every sibling subcommand (audit, doctor, ...)
 *  takes out/err hooks so tests can capture output without spying on the
 *  real process streams; compliance now matches. Defaults keep the CLI
 *  call site (index.ts) unchanged. */
export interface ComplianceIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export async function runComplianceCommand(argv: string[], io: ComplianceIo = {}): Promise<number> {
  const out =
    io.out ??
    ((s: string) => {
      process.stdout.write(s);
    });
  const err =
    io.err ??
    ((s: string) => {
      process.stderr.write(s);
    });

  // Handle --help BEFORE spawning -- otherwise "--help" falls through to the
  // mcp-compliance subprocess (a stray npx download + the sub-tool's help),
  // never the documented usage. Print to stdout + exit 0 like every sibling.
  if (argv.includes("--help") || argv.includes("-h")) {
    out(COMPLIANCE_USAGE);
    return 0;
  }

  const publish = argv.includes("--publish");
  const args = argv.filter((a) => a !== "--publish");

  if (args.length === 0) {
    // Missing required <target> is an arg error -> exit 2, matching the
    // 2-for-usage-errors convention every other subcommand follows.
    err(COMPLIANCE_USAGE);
    return 2;
  }

  const apiUrl = process.env.YAW_MCP_URL ?? "https://yaw.sh/mcp";

  const report = await runTest(args, err);
  if (!report) return 1;

  printSummary(report, out);

  if (publish) {
    const result = await publishReport(apiUrl, report, err);
    if (!result) return 1;
    // The POST 200 body is cast, not validated -- an unexpected shape would
    // otherwise print "Published: undefined". Require non-empty url strings.
    const reportUrl = typeof result.reportUrl === "string" ? result.reportUrl.trim() : "";
    const badgeUrl = typeof result.badgeUrl === "string" ? result.badgeUrl.trim() : "";
    if (!reportUrl || !badgeUrl) {
      err("\nPublish failed: server returned 200 but no report/badge URL.\n");
      return 1;
    }
    out(`\nPublished: ${reportUrl}\n`);
    out(`Badge:     ${badgeUrl}\n`);
    if (result.deleteToken) {
      out(`\nDelete token (save this): ${result.deleteToken}\n`);
    }
  }

  return 0;
}

// Guard rails on the child: a hung MCP server blocks forever, and a
// runaway/garbage child can stream unbounded stdout into memory. Cap both.
const MAX_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MB
const CHILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes wall-clock

/** How to launch npx: either node + the npx JS entry (preferred), or a
 *  shell-quoted command line (last resort, only when the JS entry can't be
 *  found). `shell` args are already quoted for the target platform. */
export interface NpxLaunch {
  command: string;
  args: string[];
  shell: boolean;
}

/** Candidate locations of npm's `npx-cli.js`, relative to the running node
 *  binary. Windows lays npm out beside node.exe; POSIX installs put it under
 *  `<prefix>/lib/node_modules`. Both shapes are probed on every platform so
 *  unusual layouts (nvm, volta, scoop, a portable unpack) still resolve. */
function npxCliCandidates(execPath: string): string[] {
  const binDir = dirname(execPath);
  return [
    join(binDir, "node_modules", "npm", "bin", "npx-cli.js"),
    join(binDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    join(binDir, "..", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
}

/** Quote one argument for a `shell: true` spawn, or return null when the
 *  argument cannot be quoted safely on this platform. Strict by design: the
 *  shell path is a fallback for a broken node install, not a place to get
 *  clever about escaping operator-supplied target strings. */
function quoteForShell(arg: string, platform: NodeJS.Platform): string | null {
  // A newline / NUL ends the command line no matter how it is quoted.
  if (/[\r\n\0]/.test(arg)) return null;
  if (platform === "win32") {
    // cmd.exe still expands %VAR% inside double quotes, and a literal quote
    // terminates the quoted run. Everything else (& | < > ^) is inert there.
    if (/["%]/.test(arg)) return null;
    return `"${arg}"`;
  }
  // POSIX single quotes are fully literal -- the only unquotable char is `'`.
  if (arg.includes("'")) return null;
  return `'${arg}'`;
}

/** Operator-facing name for the characters quoteForShell refuses on a given
 *  platform. Lives beside quoteForShell so the two cannot drift. */
function unquotableCharsFor(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "double quotes, percent signs, newlines or NUL bytes"
    : "single quotes, newlines or NUL bytes";
}

/**
 * Failure text for "no npx-cli.js on disk AND an argument we refuse to quote".
 * Names the character class that actually applies on THIS platform and echoes
 * the offending argument: the old wording said "quotes / newlines" on every
 * platform, so a target rejected for a `%` (win32-only) or a `'` (POSIX-only)
 * got an explanation naming nothing that was wrong with it. Installing npm is
 * still the primary remedy -- it removes the shell fallback entirely.
 */
export function formatLaunchFailure(npxArgs: string[], platform: NodeJS.Platform = process.platform): string {
  const offender = npxArgs.find((a) => quoteForShell(a, platform) === null);
  const detail =
    offender === undefined
      ? "and the target arguments cannot be safely quoted for a shell fallback.\n"
      : // JSON.stringify so a newline / NUL in the argument is shown escaped
        // instead of mangling the diagnostic it appears in.
        `and this argument cannot be safely quoted for a shell fallback: ${JSON.stringify(offender)}\n`;
  return (
    "\nFailed to launch mcp-compliance: npm's npx-cli.js was not found next to this node binary,\n" +
    detail +
    `Install npm, or pass a target without ${unquotableCharsFor(platform)}.\n`
  );
}

/**
 * Decide how to spawn `npx <args>`.
 *
 * The obvious `spawn("npx.cmd", args)` is BROKEN on Windows: since the
 * CVE-2024-27980 hardening (Node 18.20.2 / 20.12.2 / 21.7.3 and up) spawning
 * a `.cmd` / `.bat` without `shell: true` throws `EINVAL` synchronously, so
 * `yaw-mcp compliance` could never launch the suite there at all. Resolving
 * npm's `npx-cli.js` and running it with the CURRENT node binary sidesteps
 * both that hardening and the PATHEXT problem, and keeps the no-shell
 * guarantee: an operator-supplied target string with a quote / `&&` / `;`
 * never reaches a shell parser.
 *
 * Returns null when neither strategy is usable (no npx-cli.js on disk AND an
 * argument that can't be safely shell-quoted) so the caller can fail loudly
 * instead of guessing.
 */
export function resolveNpxLaunch(
  npxArgs: string[],
  opts: { execPath?: string; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): NpxLaunch | null {
  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const fileExists = opts.exists ?? existsSync;

  for (const candidate of npxCliCandidates(execPath)) {
    if (fileExists(candidate)) {
      return { command: execPath, args: [candidate, ...npxArgs], shell: false };
    }
  }

  // Fallback: no npx-cli.js next to this node. Go through the shell, but only
  // with arguments we can quote safely -- never by concatenating raw input.
  const quoted: string[] = [];
  for (const arg of npxArgs) {
    const q = quoteForShell(arg, platform);
    if (q === null) return null;
    quoted.push(q);
  }
  return { command: "npx", args: quoted, shell: true };
}

/**
 * Is a parsed report safe to render? `score` is checked HERE rather than at
 * print time because printSummary calls `score.toFixed(1)`: a report with a
 * missing / non-numeric / NaN score would otherwise crash the CLI with a raw
 * TypeError instead of the "unexpected JSON" diagnostic + exit 1.
 */
export function isRenderableReport(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const r = parsed as Partial<ComplianceReport>;
  if (!r.grade || !r.summary) return false;
  return typeof r.score === "number" && Number.isFinite(r.score);
}

/**
 * Best-effort kill of the child AND its descendants. `child.kill()` signals
 * only the npx wrapper; the MCP server it spawned is a grandchild and would
 * survive, holding its ports/stdio open after the timeout fired.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    if (process.platform === "win32") {
      // taskkill /T walks the whole descendant tree; /F is required because
      // the wrapper won't forward a graceful signal.
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => {});
        return;
      } catch {
        // fall through to the direct kill below
      }
    } else {
      // The child was spawned `detached`, so it leads its own process group;
      // a negative pid signals the whole group (wrapper + grandchildren).
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // group already gone, or the child never became a group leader
      }
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}

function runTest(args: string[], err: (s: string) => void): Promise<ComplianceReport | null> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      err(message);
      resolve(null);
    };

    const npxArgs = ["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", ...args];
    const launch = resolveNpxLaunch(npxArgs);
    if (!launch) {
      fail(formatLaunchFailure(npxArgs));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ["ignore", "pipe", "inherit"],
        shell: launch.shell,
        // Own process group on POSIX so the timeout can take the whole tree
        // down. NOT on Windows, where `detached` would pop a console window.
        detached: process.platform !== "win32",
      });
    } catch (e: unknown) {
      // spawn can throw SYNCHRONOUSLY (EINVAL on a .cmd, ENOENT on some
      // shells) -- without this catch the throw escapes the Promise executor
      // as a rejection and the CLI prints a raw Node error instead of the
      // normal "Failed to launch" line + exit 1.
      fail(`\nFailed to launch mcp-compliance: ${e instanceof Error ? e.message : String(e)}\n`);
      return;
    }

    // Ctrl-C: on POSIX the child now leads its OWN process group, so the
    // terminal's SIGINT no longer reaches it -- take the tree down by hand
    // rather than orphaning an MCP server. Listeners are removed as soon as
    // the promise settles so nothing leaks into the rest of the CLI.
    const onInterrupt = (): void => {
      killTree(child);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    const releaseSignals = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    };

    let stdout = "";
    let stdoutBytes = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      releaseSignals();
      killTree(child);
      err(`\nmcp-compliance timed out after ${CHILD_TIMEOUT_MS / 1000}s; killed.\n`);
      resolve(null);
    }, CHILD_TIMEOUT_MS);
    // Don't let the timer keep the process alive on its own.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        releaseSignals();
        killTree(child);
        err(`\nmcp-compliance produced more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MB of output; killed.\n`);
        resolve(null);
        return;
      }
      stdout += chunk.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      clearTimeout(timer);
      releaseSignals();
      fail(`\nFailed to launch mcp-compliance: ${e.message}\n`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseSignals();
      // mcp-compliance exits non-zero on --strict failures but still writes
      // a valid JSON report. Try parsing regardless of exit code.
      try {
        const parsed = JSON.parse(stdout) as ComplianceReport;
        if (!isRenderableReport(parsed)) {
          err(`\nmcp-compliance returned unexpected JSON (exit ${code}).\n`);
          resolve(null);
          return;
        }
        resolve(parsed);
      } catch {
        err(`\nmcp-compliance exited ${code} without valid JSON output.\n`);
        resolve(null);
      }
    });
  });
}

function printSummary(report: ComplianceReport, out: (s: string) => void): void {
  const { grade, score, summary, url } = report;
  out(
    `\nCompliance: ${grade} (${score.toFixed(1)}%) -- ${summary.passed}/${summary.total} passed, ` +
      `${summary.requiredPassed}/${summary.required} required\n` +
      `Target: ${url}\n`,
  );
}

// Shape of a single test entry in the published payload. The raw report's
// tests are unknown[] and may carry arbitrary fields the suite echoed back
// (env, argv, stack traces). Project each to a fixed allowlist so nothing
// unexpected is exfiltrated to the publish endpoint.
interface PublishedTest {
  name?: string;
  status?: string;
  required?: boolean;
  message?: string;
}

interface PublishedReport {
  grade: string;
  score: number;
  url: string;
  summary: ComplianceReport["summary"];
  tests: PublishedTest[];
}

// Project the full (opaque, index-signature-bearing) report down to an
// explicit allowlist before publishing. Uploading `report` verbatim would
// ship any extra top-level fields AND any extra per-test fields the suite
// happened to include (e.g. echoed env/args) -- this strips all of that.
export function projectForPublish(report: ComplianceReport): PublishedReport {
  const tests = Array.isArray(report.tests) ? report.tests : [];
  return {
    grade: report.grade,
    score: report.score,
    url: report.url,
    summary: {
      total: report.summary.total,
      passed: report.summary.passed,
      failed: report.summary.failed,
      required: report.summary.required,
      requiredPassed: report.summary.requiredPassed,
    },
    tests: tests.map((t) => {
      const test = (t ?? {}) as Record<string, unknown>;
      const projected: PublishedTest = {};
      if (typeof test.name === "string") projected.name = test.name;
      if (typeof test.status === "string") projected.status = test.status;
      if (typeof test.required === "boolean") projected.required = test.required;
      if (typeof test.message === "string") projected.message = test.message;
      return projected;
    }),
  };
}

async function publishReport(
  apiUrl: string,
  report: ComplianceReport,
  err: (s: string) => void,
): Promise<{ reportUrl: string; badgeUrl: string; deleteToken?: string } | null> {
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/compliance/ext`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(projectForPublish(report)),
    });
    if (res.statusCode !== 200) {
      const body = await res.body.text().catch(() => "");
      err(`\nPublish failed: HTTP ${res.statusCode}${body ? ` -- ${body}` : ""}\n`);
      return null;
    }
    const parsed = (await res.body.json()) as {
      hash: string;
      reportUrl: string;
      badgeUrl: string;
      deleteToken?: string;
    };
    return parsed;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    err(`\nPublish failed: ${message}\n`);
    return null;
  }
}
