// `yaw-mcp login --key <license-key>` -- sign in to a Yaw Team or
// Yaw MCP Pro account. Persists a session cookie at
// ~/.yaw-mcp/team-session.json so subsequent `yaw-mcp sync` calls run
// without re-prompting.
//
// Free users don't need to log in -- the bare `yaw-mcp` (local mode)
// runs from ~/.yaw-mcp/bundles.json with no account.

import { TeamSyncAuthError, signIn } from "./team-sync.js";

export const LOGIN_USAGE = `Usage: yaw-mcp login --key <license-key>

  Sign in to your Yaw Team or Yaw MCP Pro account. Your license
  key was emailed after purchase.

  --key <license-key>   Required. The license key from your purchase email.
  --json                Emit machine-readable JSON instead of prose.

  Free Yaw MCP users do not need to log in -- run yaw-mcp without a
  token and it loads servers from ~/.yaw-mcp/bundles.json.`;

export interface LoginCommandOptions {
  key?: string;
  json?: boolean;
  /** Test hooks. */
  home?: string;
  baseUrl?: string;
}

export function parseLoginArgs(
  argv: string[],
): { ok: true; options: LoginCommandOptions } | { ok: false; error: string } {
  const opts: LoginCommandOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") {
      const v = argv[++i];
      if (!v) return { ok: false, error: "yaw-mcp login: --key requires a value\n\n" + LOGIN_USAGE };
      opts.key = v;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: LOGIN_USAGE };
    } else {
      return { ok: false, error: `yaw-mcp login: unknown argument "${a}"\n\n${LOGIN_USAGE}` };
    }
  }
  if (!opts.key) {
    return { ok: false, error: "yaw-mcp login: --key is required\n\n" + LOGIN_USAGE };
  }
  return { ok: true, options: opts };
}

export interface LoginCommandResult {
  exitCode: number;
}

export async function runLogin(
  opts: LoginCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<LoginCommandResult> {
  if (!opts.key) {
    io.err("yaw-mcp login: --key is required\n");
    return { exitCode: 2 };
  }
  try {
    const session = await signIn(opts.key, { home: opts.home, baseUrl: opts.baseUrl });
    if (opts.json) {
      io.out(
        `${JSON.stringify(
          { ok: true, email: session.email, role: session.role, order_id: session.order_id, exp: session.exp },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out(`Signed in as ${session.email} (${session.role}).\n`);
      io.out(`Order: ${session.order_id}\n`);
      const expDate = new Date(session.exp).toISOString().slice(0, 10);
      io.out(`Session expires: ${expDate}\n`);
    }
    return { exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      io.err(`yaw-mcp login: ${message}\n`);
    }
    return { exitCode: err instanceof TeamSyncAuthError ? 1 : 1 };
  }
}
