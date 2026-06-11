// `yaw-mcp audit <namespace>` -- run the @yawlabs/mcp-compliance suite against
// a locally-configured MCP server and cache the resulting A-F grade.
//
// Where `yaw-mcp compliance <target>` takes a raw spawn string / URL and prints
// a one-shot report, `audit` is namespace-driven: it reads the named server's
// spawn config (command + args + env) straight out of bundles.json, runs the
// suite over stdio, and persists the grade to ~/.yaw-mcp/grades.json. The
// `servers` command (and the MCP panel) then merge that cached grade into the
// server's row, so a user can grade a server once and see the letter on every
// subsequent list without re-running 80-odd tests.
//
// Only stdio (local) servers are auditable here -- the spawn config in
// bundles.json describes a command to launch. Remote (HTTP/SSE) servers carry a
// url instead; point `yaw-mcp compliance <url>` at those directly.
//
// Exit codes:
//   0  audited successfully, grade written
//   1  no server with that namespace in bundles.json
//   2  the server isn't a stdio/command server (nothing to spawn), or the
//      suite failed to run

import { homedir } from "node:os";
import { writeGrade } from "./grades-cache.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import type { UpstreamServerConfig } from "./types.js";

export interface AuditCommandOptions {
  /** Positional: the namespace to audit. Required. */
  namespace?: string;
  home?: string;
  cwd?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /**
   * Test hook: skip the real compliance suite. Receives the resolved
   * stdio target and returns the report fields we persist. Defaults to the
   * real @yawlabs/mcp-compliance runner (loaded lazily so unit tests that
   * inject a runner never spin up a child process).
   */
  runner?: (target: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number }>;
}

export interface AuditCommandResult {
  exitCode: number;
  lines: string[];
}

export interface ParsedAuditArgs {
  namespace: string;
  json: boolean;
}

export const AUDIT_USAGE = `Usage: yaw-mcp audit <namespace> [--json]

  Run the MCP compliance suite against a server configured in your local
  bundles.json and cache its A-F grade in ~/.yaw-mcp/grades.json. The cached
  grade then shows up in \`yaw-mcp servers\` and the Yaw Terminal MCP panel.

  <namespace>   The namespace of a stdio server in bundles.json (see
                \`yaw-mcp list\`).
  --json        Emit machine-readable JSON instead of text.

  To grade an arbitrary target (a URL, or a command not in bundles.json),
  use \`yaw-mcp compliance <target>\` instead.`;

// Split out so index.ts can validate args early and surface a usage error
// instead of falling through to runServer on a typo.
export function parseAuditArgs(argv: string[]): { ok: true; options: ParsedAuditArgs } | { ok: false; error: string } {
  let json = false;
  let namespace: string | undefined;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: AUDIT_USAGE };
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp audit: unknown argument "${a}"\n\n${AUDIT_USAGE}` };
    } else if (namespace === undefined) {
      namespace = a;
    } else {
      return { ok: false, error: `yaw-mcp audit: unexpected extra argument "${a}"\n\n${AUDIT_USAGE}` };
    }
  }
  if (namespace === undefined) {
    return { ok: false, error: `yaw-mcp audit: missing <namespace>.\n\n${AUDIT_USAGE}` };
  }
  return { ok: true, options: { namespace, json } };
}

/** Look up a server by namespace in the loaded local bundles. */
function findServer(servers: UpstreamServerConfig[], namespace: string): UpstreamServerConfig | undefined {
  return servers.find((s) => s.namespace === namespace);
}

/** Lazily load the real compliance runner. Kept behind a dynamic import so a
 *  test that injects `opts.runner` never resolves @yawlabs/mcp-compliance and
 *  never spawns a child. */
async function defaultRunner(target: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number }> {
  const { runComplianceSuite } = await import("@yawlabs/mcp-compliance");
  const report = await runComplianceSuite({
    type: "stdio",
    command: target.command,
    args: target.args,
    env: target.env,
  });
  return { grade: report.grade, score: report.score };
}

export async function runAudit(opts: AuditCommandOptions = {}): Promise<AuditCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const namespace = opts.namespace;
  if (!namespace) {
    printErr("yaw-mcp audit: missing <namespace>.");
    return { exitCode: 1, lines };
  }

  const home = opts.home ?? homedir();
  const { config, path } = await loadLocalBundles({ cwd: opts.cwd, home });
  const servers = config?.servers ?? [];
  const server = findServer(servers, namespace);

  if (!server) {
    const where = path ? ` (${path})` : "";
    printErr(
      `yaw-mcp audit: no server named "${namespace}" in bundles.json${where}. Run \`yaw-mcp list\` to see configured servers.`,
    );
    return { exitCode: 1, lines };
  }

  // Only stdio/command servers are auditable here. A remote server carries a
  // url, not a command -- there's nothing to spawn, so point the user at
  // `yaw-mcp compliance <url>` instead.
  if (!server.command) {
    if (server.url) {
      printErr(
        `yaw-mcp audit: "${namespace}" is a remote server (${server.url}). Audit grades stdio servers; run \`yaw-mcp compliance ${server.url}\` to grade a remote target.`,
      );
    } else {
      printErr(`yaw-mcp audit: "${namespace}" has no command to spawn -- it can't be audited as a stdio server.`);
    }
    return { exitCode: 2, lines };
  }

  const target = {
    command: server.command,
    args: server.args ?? [],
    env: server.env,
  };

  print(`Auditing "${namespace}" (${target.command}${target.args.length ? ` ${target.args.join(" ")}` : ""})...`);

  const runner = opts.runner ?? defaultRunner;
  let report: { grade: "A" | "B" | "C" | "D" | "F"; score: number };
  try {
    report = await runner(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "audit: compliance suite failed", { namespace, error: msg });
    printErr(`yaw-mcp audit: compliance suite failed for "${namespace}": ${msg}`);
    return { exitCode: 2, lines };
  }

  const gradedAt = new Date().toISOString();
  const cachePath = await writeGrade(namespace, { grade: report.grade, score: report.score, gradedAt }, home);

  if (opts.json) {
    print(JSON.stringify({ namespace, grade: report.grade, score: report.score, gradedAt, cache: cachePath }, null, 2));
    return { exitCode: 0, lines };
  }

  print(`Grade: ${report.grade} (${report.score.toFixed(1)}%)`);
  print(`Cached to ${cachePath}`);
  return { exitCode: 0, lines };
}
