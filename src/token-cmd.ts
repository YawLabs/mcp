// `yaw-mcp token` -- print the current Yaw Team session token (the raw
// yaw_team cookie) for a TRUSTED LOCAL consumer to present to a Yaw endpoint
// (e.g. Vew Meetings' /api/meeting, which verifies the same HMAC session).
//
// This exposes the session bearer token on stdout BY DESIGN: the caller is a
// local process the user already trusts (it spawned this sidecar and captures
// its stdout). It makes NO network call -- it reads the session persisted by
// `yaw-mcp login` and emits it only when still valid (exp-checked), else
// exits 1 ("Not signed in"). The token is a bearer credential; treat stdout as
// sensitive.

import { getSessionWithCookie } from "./team-sync.js";

export const TOKEN_USAGE = `Usage: yaw-mcp token [--json]

  Print this machine's Yaw Team session token, for a trusted local app to
  present to a Yaw endpoint (e.g. Vew Meetings). Requires a prior
  \`yaw-mcp login\`.

  --json   Emit machine-readable JSON: { ok, token, email, exp }.

  The token is a BEARER credential -- treat stdout as sensitive. Makes no
  network call; exits 1 if not signed in (or the session has expired).`;

export interface TokenCommandOptions {
  json?: boolean;
  /** Test hooks. */
  home?: string;
  filePath?: string;
}

export function parseTokenArgs(
  argv: string[],
): { ok: true; options: TokenCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: TokenCommandOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: TOKEN_USAGE, help: true };
    } else {
      return { ok: false, error: `yaw-mcp token: unknown argument "${a}"\n\n${TOKEN_USAGE}` };
    }
  }
  return { ok: true, options: opts };
}

export interface TokenCommandResult {
  exitCode: number;
}

export async function runTokenCmd(
  opts: TokenCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<TokenCommandResult> {
  const found = await getSessionWithCookie({ home: opts.home, filePath: opts.filePath });
  if (!found) {
    if (opts.json) {
      io.err(`${JSON.stringify({ ok: false, error: "Not signed in." })}\n`);
    } else {
      io.err("yaw-mcp token: not signed in -- run `yaw-mcp login --key <license-key>` first.\n");
    }
    return { exitCode: 1 };
  }
  const { cookie, session } = found;
  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, token: cookie, email: session.email, exp: session.exp }, null, 2)}\n`);
  } else {
    io.out(`${cookie}\n`);
  }
  return { exitCode: 0 };
}
