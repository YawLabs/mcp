// `yaw-mcp servers` — DEPRECATED, always fails.
//
// This used to list the servers configured for a Yaw MCP *account* (what
// `/api/connect/config` returned). Account mode is gone — the hosted backend
// is decommissioned and every endpoint 404s — so there is nothing left to
// list. The command is retained for one release as a signpost rather than
// disappearing into "unknown subcommand".
//
// The non-zero exit is deliberate, not an oversight. Yaw Terminal's MCP panel
// spawns `yaw-mcp servers --json` and derives "signed in" from a CLEAN exit
// with parseable JSON (yaw-mcp-sidecar.ts); on a non-zero exit it silently
// falls back to local-bundles mode. Exiting 0 here would either fake an
// account or trip the panel's "exited 0 but returned no parseable config"
// warning. Failing is what routes it to the only mode that still exists.
//
// The local equivalent is `yaw-mcp list`, which reads bundles.json.
//
// Exit codes:
//   1  always (account mode removed)

export interface ServersCommandOptions {
  /** Accepted for back-compat; only affects whether stdout carries a JSON
   *  error envelope. There is no server list to emit either way. */
  json?: boolean;
  /** Accepted and ignored — kept so an existing script's namespace filter
   *  gets the deprecation notice instead of a usage error. */
  filter?: string;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. */
  err?: (s: string) => void;
}

export interface ServersCommandResult {
  exitCode: number;
  /** Lines printed (stdout + stderr interleaved) — exposed for tests. */
  lines: string[];
}

export interface ParsedServersArgs {
  json: boolean;
  filter?: string;
}

// Still parsed (rather than accepting anything) so `yaw-mcp servers --wat`
// keeps reporting the typo, and `--help` keeps printing usage. index.ts
// validates through this before dispatching.
export function parseServersArgs(
  argv: string[],
): { ok: true; options: ParsedServersArgs } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let filter: string | undefined;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: SERVERS_USAGE, help: true };
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp servers: unknown argument "${a}"\n\n${SERVERS_USAGE}` };
    } else if (filter === undefined) {
      filter = a;
    } else {
      return { ok: false, error: `yaw-mcp servers: unexpected extra argument "${a}"\n\n${SERVERS_USAGE}` };
    }
  }
  return { ok: true, options: { json, ...(filter !== undefined ? { filter } : {}) } };
}

export const SERVERS_USAGE = `Usage: yaw-mcp servers [<namespace-filter>] [--json]

  DEPRECATED -- account mode has been removed, so this command always fails.

  Run \`yaw-mcp list\` instead: it shows the MCP servers yaw-mcp actually
  loads, from your local bundles.json.

  Arguments are still accepted so existing scripts get this notice rather
  than a usage error, but they have no effect.`;

/** Single source for the message, so the stderr line and the `--json` error
 *  envelope can never drift apart. */
export const SERVERS_DEPRECATED_MESSAGE =
  "yaw-mcp servers: account mode has been removed -- the hosted Yaw MCP backend is gone, so there are no account servers to list. Run `yaw-mcp list` to see the servers yaw-mcp loads from your local bundles.json.";

export async function runServersCommand(opts: ServersCommandOptions = {}): Promise<ServersCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];

  // stderr unconditionally: a human running this interactively needs to see
  // WHY, and a script redirecting stdout into a parser still gets the reason.
  lines.push(SERVERS_DEPRECATED_MESSAGE);
  writeErr(`${SERVERS_DEPRECATED_MESSAGE}\n`);

  // Under --json keep stdout parseable — a consumer piping into `jq` gets an
  // object it can branch on instead of a parse error. The non-zero exit below
  // is still the load-bearing signal; this is a courtesy, not a contract.
  if (opts.json) {
    const payload = JSON.stringify({ ok: false, deprecated: true, error: SERVERS_DEPRECATED_MESSAGE });
    lines.push(payload);
    write(`${payload}\n`);
  }

  return { exitCode: 1, lines };
}
