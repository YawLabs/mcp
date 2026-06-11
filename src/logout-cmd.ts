// `yaw-mcp logout` -- clear the local team-session cookie and best-effort
// notify the server. Always clears local state even if the server call
// fails.

import { getSession, signOut } from "./team-sync.js";

export const LOGOUT_USAGE = `Usage: yaw-mcp logout

  Sign out of your Yaw Team account. Clears the
  local session cookie at ~/.yaw-mcp/team-session.json. Free mode
  resumes on the next yaw-mcp invocation if no YAW_MCP_TOKEN is set.

  --json   Emit machine-readable JSON instead of prose.`;

export interface LogoutCommandOptions {
  json?: boolean;
  /** Test hooks. */
  home?: string;
  baseUrl?: string;
}

export function parseLogoutArgs(
  argv: string[],
): { ok: true; options: LogoutCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: LogoutCommandOptions = {};
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: LOGOUT_USAGE, help: true };
    else return { ok: false, error: `yaw-mcp logout: unknown argument "${a}"\n\n${LOGOUT_USAGE}` };
  }
  return { ok: true, options: opts };
}

export interface LogoutCommandResult {
  exitCode: number;
}

export async function runLogout(
  opts: LogoutCommandOptions = {},
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<LogoutCommandResult> {
  const before = await getSession({ home: opts.home, baseUrl: opts.baseUrl });
  if (!before) {
    if (opts.json) io.out(`${JSON.stringify({ ok: true, wasSignedIn: false })}\n`);
    else io.out("Already signed out.\n");
    return { exitCode: 0 };
  }
  await signOut({ home: opts.home, baseUrl: opts.baseUrl });
  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, wasSignedIn: true, email: before.email })}\n`);
  } else {
    io.out(`Signed out (${before.email}).\n`);
  }
  return { exitCode: 0 };
}
