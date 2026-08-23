// `yaw-mcp audit <namespace>` -- run the @yawlabs/mcp-compliance suite against
// a locally-configured MCP server and cache the resulting A-F grade.
//
// Where `yaw-mcp compliance <target>` takes a raw spawn string / URL and prints
// a one-shot report, `audit` is namespace-driven: it reads the named server's
// spawn config (command + args + env) straight out of bundles.json, runs the
// suite over stdio, and persists the grade to ~/.yaw-mcp/grades.json. The
// `list` command (and the MCP panel) then merge that cached grade into the
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
//   3  the suite RAN and produced a grade, but grades.json could not be
//      written (read-only $HOME, no space, permissions). The grade is still
//      printed on stdout -- only the cache is missing. Deliberately distinct
//      from 1 and 2, both of which mean nothing was graded at all.

import { homedir } from "node:os";
import { gradesCachePath, writeGrade } from "./grades-cache.js";
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
  }) => Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string }>;
}

export interface AuditCommandResult {
  exitCode: number;
  lines: string[];
}

// Flags whose VALUE (the very next arg) carries a credential / secret.
// We only redact the value, never the flag name -- the operator still needs
// to see WHICH flag was passed, just not what was passed to it. Matches the
// `--flag value` shape; the `--flag=value` shape is handled separately below.
//
// Stored lowercase and matched case-insensitively: flag casing is a style
// choice, not a semantic one, and a case-sensitive Set printed `--Token abc`
// (or `--API-KEY=...`) with the secret fully in the clear.
const SECRET_FLAG_NAMES = new Set<string>([
  "--api-key",
  "--apikey",
  "--token",
  "--auth",
  "--auth-token",
  "--password",
  "--secret",
  "-p",
]);

/**
 * Return a copy of `args` with the VALUE following any secret-bearing flag
 * replaced by "<redacted>". Two shapes are handled:
 *   ["--token", "abc"]    -> ["--token", "<redacted>"]
 *   ["--token=abc"]       -> ["--token=<redacted>"]
 * Bare flags with no following value are left alone (the redaction target
 * is the value, not the presence of the flag).
 * Flag matching is CASE-INSENSITIVE: `--Token` / `--API-KEY` redact exactly
 * like `--token` / `--api-key`. The flag name itself is echoed back with the
 * operator's original casing.
 *
 * Exported for tests -- the redaction is a leak-prevention control, so it is
 * asserted directly as well as through the `audit` preamble.
 */
export function redactSecretArgs(args: readonly string[]): string[] {
  const isSecretFlag = (s: string): boolean => SECRET_FLAG_NAMES.has(s.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (isSecretFlag(a)) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push("<redacted>");
        i += 1;
      }
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && isSecretFlag(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=<redacted>`);
      continue;
    }
    out.push(a);
  }
  return out;
}

export interface ParsedAuditArgs {
  namespace: string;
  json: boolean;
}

export const AUDIT_USAGE = `Usage: yaw-mcp audit <namespace> [--json]

  Run the MCP compliance suite against a server configured in your local
  bundles.json and cache its A-F grade in ~/.yaw-mcp/grades.json. The cached
  grade then shows up in the GRADE column of \`yaw-mcp list\` and the Yaw
  Terminal MCP panel.

  <namespace>   The namespace of a stdio server in bundles.json (see
                \`yaw-mcp list\`).
  --json        Emit machine-readable JSON instead of text.

  To grade an arbitrary target (a URL, or a command not in bundles.json),
  use \`yaw-mcp compliance <target>\` instead.`;

// Split out so index.ts can validate args early and surface a usage error
// instead of falling through to runServer on a typo.
export function parseAuditArgs(
  argv: string[],
): { ok: true; options: ParsedAuditArgs } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let namespace: string | undefined;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      // Flag --help so the dispatcher routes it to stdout + exit 0, matching
      // every sibling subcommand instead of stderr + exit 2.
      return { ok: false, error: AUDIT_USAGE, help: true };
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
}): Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string }> {
  // SPEC_VERSION rides along so the cached grade records WHICH rubric produced
  // the letter -- read here (not at writeGrade) so runner-injecting tests keep
  // never resolving @yawlabs/mcp-compliance.
  const { runComplianceSuite, SPEC_VERSION } = await import("@yawlabs/mcp-compliance");
  const report = await runComplianceSuite({
    type: "stdio",
    command: target.command,
    args: target.args,
    env: target.env,
  });
  return { grade: report.grade, score: report.score, suiteVersion: SPEC_VERSION };
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
    // Unreachable from the CLI: parseAuditArgs requires a <namespace> and
    // index.ts exits 2 on a parse error before runAudit is ever called. Only
    // a direct test/programmatic caller that omits `namespace` lands here.
    // Exit 2 matches the parse-layer usage-error convention (index.ts), not
    // the exit-1 "namespace not found" case below.
    printErr("yaw-mcp audit: missing <namespace>.");
    return { exitCode: 2, lines };
  }

  const home = opts.home ?? homedir();
  const { config, path, warnings } = await loadLocalBundles({ cwd: opts.cwd, home });
  // Surface loader diagnostics the way the sibling commands do (list,
  // sidecars, bundles). Without this, a malformed or unreadable bundles.json
  // loads as zero servers and gets reported below as `no server named "X"` --
  // with exit 1, the code the header reserves for a typo'd namespace -- while
  // the real problem never surfaces. stderr keeps --json stdout pure.
  for (const w of warnings) printErr(`warning: ${w}`);
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

  // In --json mode stdout must be pure JSON (the Yaw MCP panel parses it), so
  // skip the human preamble; print it only for interactive use. (A server arg
  // containing a brace would otherwise corrupt brace-based JSON extraction.)
  if (!opts.json) {
    const printableArgs = redactSecretArgs(target.args);
    print(`Auditing "${namespace}" (${target.command}${printableArgs.length ? ` ${printableArgs.join(" ")}` : ""})...`);
  }

  const runner = opts.runner ?? defaultRunner;
  let report: { grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string };
  try {
    report = await runner(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "audit: compliance suite failed", { namespace, error: msg });
    printErr(`yaw-mcp audit: compliance suite failed for "${namespace}": ${msg}`);
    return { exitCode: 2, lines };
  }

  const gradedAt = new Date().toISOString();
  // writeGrade re-throws its own errors on purpose, and atomicWriteFile throws
  // on EROFS / EACCES / ENOSPC -- a read-only $HOME (containers, locked-down
  // CI images) is the common shape. Unguarded, that threw straight out of
  // runAudit: index.ts's dispatch catch printed a raw errno line, the grade the
  // 80-test suite just spent minutes computing was never printed at all, and
  // the process exited 1 -- the code this file documents as "no server with
  // that namespace", so a caller branching on exit codes misread a cache-write
  // failure as a typo'd namespace. Print the grade regardless and use the
  // dedicated exit 3 (see the header): the audit DID produce a result, so this
  // must not collide with 1 (nothing found) or 2 (nothing graded).
  let cachePath: string | null = null;
  let cacheError: string | null = null;
  try {
    cachePath = await writeGrade(
      namespace,
      report.suiteVersion
        ? { grade: report.grade, score: report.score, gradedAt, suiteVersion: report.suiteVersion }
        : { grade: report.grade, score: report.score, gradedAt },
      home,
    );
  } catch (err) {
    cacheError = err instanceof Error ? err.message : String(err);
    log("error", "audit: grade cache write failed", { namespace, error: cacheError });
  }

  if (opts.json) {
    // `cache` stays present and becomes null on failure (rather than being
    // omitted) so the Yaw MCP panel's parse keeps working; `cacheError` names
    // what went wrong. The grade itself is reported either way.
    const payload: Record<string, unknown> = {
      namespace,
      grade: report.grade,
      score: report.score,
      gradedAt,
      cache: cachePath,
    };
    if (cacheError !== null) payload.cacheError = cacheError;
    print(JSON.stringify(payload, null, 2));
  } else {
    print(`Grade: ${report.grade} (${report.score.toFixed(1)}%)`);
    if (cachePath !== null) print(`Cached to ${cachePath}`);
  }

  if (cacheError !== null) {
    printErr(
      `yaw-mcp audit: computed grade ${report.grade} but could not write ${gradesCachePath(home)}: ${cacheError}`,
    );
    return { exitCode: 3, lines };
  }
  return { exitCode: 0, lines };
}
