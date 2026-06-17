import { spawn } from "node:child_process";
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

export async function runComplianceCommand(argv: string[]): Promise<number> {
  // Handle --help BEFORE spawning -- otherwise "--help" falls through to the
  // mcp-compliance subprocess (a stray npx download + the sub-tool's help),
  // never the documented usage. Print to stdout + exit 0 like every sibling.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(COMPLIANCE_USAGE);
    return 0;
  }

  const publish = argv.includes("--publish");
  const args = argv.filter((a) => a !== "--publish");

  if (args.length === 0) {
    // Missing required <target> is an arg error -> exit 2, matching the
    // 2-for-usage-errors convention every other subcommand follows.
    process.stderr.write(COMPLIANCE_USAGE);
    return 2;
  }

  const apiUrl = process.env.YAW_MCP_URL ?? "https://yaw.sh/mcp";

  const report = await runTest(args);
  if (!report) return 1;

  printSummary(report);

  if (publish) {
    const result = await publishReport(apiUrl, report);
    if (!result) return 1;
    // The POST 200 body is cast, not validated -- an unexpected shape would
    // otherwise print "Published: undefined". Require non-empty url strings.
    const reportUrl = typeof result.reportUrl === "string" ? result.reportUrl.trim() : "";
    const badgeUrl = typeof result.badgeUrl === "string" ? result.badgeUrl.trim() : "";
    if (!reportUrl || !badgeUrl) {
      process.stderr.write("\nPublish failed: server returned 200 but no report/badge URL.\n");
      return 1;
    }
    process.stdout.write(`\nPublished: ${reportUrl}\n`);
    process.stdout.write(`Badge:     ${badgeUrl}\n`);
    if (result.deleteToken) {
      process.stdout.write(`\nDelete token (save this): ${result.deleteToken}\n`);
    }
  }

  return 0;
}

// Guard rails on the child: a hung MCP server blocks forever, and a
// runaway/garbage child can stream unbounded stdout into memory. Cap both.
const MAX_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MB
const CHILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes wall-clock

function runTest(args: string[]): Promise<ComplianceReport | null> {
  return new Promise((resolve) => {
    // Structured command + args array; NO `shell: true`. On Windows, Node's
    // CreateProcess does NOT honor PATHEXT for a plain "npx" name, so we
    // resolve to "npx.cmd" explicitly there. Dropping `shell` removes the
    // injection surface from any operator-supplied target string in `args`
    // (a quote / `&&` / `;` in an arg can never reach a shell parser).
    const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npxBin, ["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      process.stderr.write(`\nmcp-compliance timed out after ${CHILD_TIMEOUT_MS / 1000}s; killed.\n`);
      resolve(null);
    }, CHILD_TIMEOUT_MS);
    // Don't let the timer keep the process alive on its own.
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        process.stderr.write(
          `\nmcp-compliance produced more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MB of output; killed.\n`,
        );
        resolve(null);
        return;
      }
      stdout += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stderr.write(`\nFailed to launch mcp-compliance: ${err.message}\n`);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // mcp-compliance exits non-zero on --strict failures but still writes
      // a valid JSON report. Try parsing regardless of exit code.
      try {
        const parsed = JSON.parse(stdout) as ComplianceReport;
        if (!parsed.grade || !parsed.summary) {
          process.stderr.write(`\nmcp-compliance returned unexpected JSON (exit ${code}).\n`);
          resolve(null);
          return;
        }
        resolve(parsed);
      } catch {
        process.stderr.write(`\nmcp-compliance exited ${code} without valid JSON output.\n`);
        resolve(null);
      }
    });
  });
}

function printSummary(report: ComplianceReport): void {
  const { grade, score, summary, url } = report;
  process.stdout.write(
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
): Promise<{ reportUrl: string; badgeUrl: string; deleteToken?: string } | null> {
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/compliance/ext`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(projectForPublish(report)),
    });
    if (res.statusCode !== 200) {
      const body = await res.body.text().catch(() => "");
      process.stderr.write(`\nPublish failed: HTTP ${res.statusCode}${body ? ` -- ${body}` : ""}\n`);
      return null;
    }
    const parsed = (await res.body.json()) as {
      hash: string;
      reportUrl: string;
      badgeUrl: string;
      deleteToken?: string;
    };
    return parsed;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nPublish failed: ${message}\n`);
    return null;
  }
}
