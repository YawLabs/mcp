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

export async function runComplianceCommand(argv: string[]): Promise<number> {
  const publish = argv.includes("--publish");
  const args = argv.filter((a) => a !== "--publish");

  if (args.length === 0) {
    process.stderr.write(
      "\n  Usage: yaw-mcp compliance <target> [extraArgs...] [--publish]\n\n" +
        "  Examples:\n" +
        '    yaw-mcp compliance "npx -y @modelcontextprotocol/server-filesystem /tmp"\n' +
        "    yaw-mcp compliance https://example.com/mcp --publish\n\n",
    );
    return 1;
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

function runTest(args: string[]): Promise<ComplianceReport | null> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => {
      process.stderr.write(`\nFailed to launch mcp-compliance: ${err.message}\n`);
      resolve(null);
    });
    child.on("close", (code) => {
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

async function publishReport(
  apiUrl: string,
  report: ComplianceReport,
): Promise<{ reportUrl: string; badgeUrl: string; deleteToken?: string } | null> {
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/compliance/ext`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
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
