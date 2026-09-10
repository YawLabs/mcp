// Should a bare `yaw-mcp` (no subcommand) actually open the stdio MCP
// transport in THIS process?
//
// WHY this exists: `yaw-mcp` with no arguments is two different commands
// wearing one name. To an MCP client it is the server launch -- the client
// spawns it with stdin on a pipe and speaks JSON-RPC. To a human it is the
// first thing they type after installing, and there it printed four JSON log
// lines and then blocked forever on a stdin nobody was writing to, with
// nothing on screen saying what it was waiting for or that `--help` exists.
//
// The two are told apart by stdin, not by argv: the launch path passes no
// flags at all (the installers write `command: yaw-mcp` with no args, and
// runServer reads no argv), so argv cannot distinguish them and stdin can.
//
// Kept in its own module rather than inline in index.ts because index.ts
// dispatches at import time and cannot be imported by a test. This decision
// is the part worth pinning, so it lives where it can be called directly.

/** Escape hatch for the one case the TTY heuristic gets wrong on purpose: a
 *  human who really does want to hand-feed JSON-RPC to the server from a
 *  terminal (or a supervisor that spawns it under a PTY). Documented in the
 *  --help environment block. */
export const STDIO_OVERRIDE_ENV = "YAW_MCP_STDIO";

/** What a bare `yaw-mcp` should do. `explain` carries the whole body to
 *  print; the caller decides nothing about the wording. */
export type ServeDecision = { kind: "serve" } | { kind: "explain"; text: string };

/** The stdin surface this reads. A structural type, not NodeJS.ReadStream, so
 *  a test can pass `{ isTTY: true }` without fabricating a stream. */
export interface TtyProbe {
  isTTY?: boolean;
}

const EXPLAINER = `yaw-mcp with no subcommand IS the MCP server, and it is waiting for an MCP
client to speak JSON-RPC on stdin. stdin here is a terminal, so no client is
attached and nothing would ever arrive -- so the server was not started.

  yaw-mcp --help                 every subcommand
  yaw-mcp install claude-code    connect an MCP client to yaw-mcp (start here)
  yaw-mcp doctor                 check a setup that already exists
  yaw-mcp list                   the servers yaw-mcp loads

A client launches it with stdin on a pipe, which still starts the server
exactly as before. To run the server here anyway -- piping JSON-RPC in by
hand -- set ${STDIO_OVERRIDE_ENV}=1.
`;

/**
 * Serve, or explain and stop.
 *
 * `isTTY === true` is the whole test, and it is deliberately the STRICT
 * comparison every other TTY check in this repo uses (secrets-cmd.ts,
 * local-add-cmd.ts): Node leaves `isTTY` UNDEFINED for a pipe, a socket, a
 * file and /dev/null, and sets it to true only for a character device
 * attached to a terminal. So no MCP client launch can land in the explain
 * branch -- the SDK's StdioClientTransport spawns with `stdio: pipe`, and
 * every other stdin shape a supervisor might hand us (a file, a closed fd,
 * `< /dev/null`) is undefined too.
 *
 * The heuristic errs in the SAFE direction on Git Bash / MSYS, where a real
 * terminal is emulated with named pipes and Node reports no TTY at all (see
 * promptUnavailableMessage in secrets-cmd.ts for the same platform note): a
 * human there gets the old blocking behaviour rather than a wrong refusal.
 * That is a missed explainer, never a broken client.
 *
 * YAW_MCP_STDIO=1 forces serving regardless, so even a client that
 * did allocate a PTY has a one-variable fix rather than a dead end.
 */
export function decideServeMode(stdin: TtyProbe | undefined, env: NodeJS.ProcessEnv): ServeDecision {
  // Trimmed before the compare, for the cmd.exe reason the auto-load gate
  // documents in server.ts: `set YAW_MCP_STDIO=1 && yaw-mcp` keeps the space
  // before `&&`, so the value arrives as "1 " and an exact match would drop
  // an override the user did set.
  if (env[STDIO_OVERRIDE_ENV]?.trim() === "1") return { kind: "serve" };
  if (stdin?.isTTY !== true) return { kind: "serve" };
  return { kind: "explain", text: EXPLAINER };
}
