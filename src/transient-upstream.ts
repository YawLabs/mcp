// Connect to one configured upstream, do one thing with it, tear it down.
//
// WHY IT IS A HELPER AND NOT A LOOP AT EACH CALL SITE. Three surfaces want the
// same shape and each gets it wrong differently if left to itself: the
// signature-on-demand meta-tool (mcp_connect_read_tool, which reads one tool's
// schema without loading its server), `yaw-mcp call` (one tool call from a
// shell), and anything later that wants to ASK a server something without
// joining it to a session -- an inventory export, a spawn probe. The part that
// must not be re-derived is the teardown: leaving the connection open silently
// promotes "read a schema" or "make one call" into "activate", which is
// exactly what these surfaces exist to avoid, and a stdio upstream that is
// never closed is a child process that outlives the thing that spawned it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not register the connection
// anywhere. A transient upstream must not appear in ConnectServer's
// `connections` map or in `toolRoutes`: mcp_connect_health and tools/list stay
// unchanged, so a caller's context does not grow until they commit via
// activate. It also does not apply the SPAWN GATE -- that decision belongs to
// the caller, which knows its own profile and renders its own refusal (see
// spawn-gate.ts). Calling this without gating first is how a deny-listed
// server gets spawned; every caller in the tree gates first, and the gate is
// the reason spawn-gate.ts exists as a shared module.

import { log } from "./logger.js";
import type { UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { connectToUpstream, type DownstreamClientBridge, disconnectFromUpstream } from "./upstream.js";

/**
 * A failure to CONNECT, as distinct from a failure inside the caller's own
 * body. Both come out of withTransientUpstream as exceptions, and a caller
 * that could not tell them apart would report "could not connect to X" for a
 * bug in its own callback -- sending the user to check a server that started
 * perfectly well.
 *
 * `cause` is the original error, unwrapped: connectToUpstream throws
 * ActivationError for a spawn/handshake failure (carrying its stderr tail and
 * category) and VaultPassphraseRequiredError for a locked vault, and a caller
 * that wants to branch on those still can. `message` is the underlying
 * message verbatim, so a caller that only wants to interpolate it does not
 * have to unwrap anything.
 */
export class TransientConnectError extends Error {
  constructor(
    readonly namespace: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransientConnectError";
  }
}

export interface TransientUpstreamOptions {
  /** Forwarded to connectToUpstream so an upstream's elicitation / sampling /
   *  roots requests reach the real downstream client. Omitted by callers with
   *  no downstream to forward to -- every CLI caller, which has no MCP client
   *  on the other end at all. */
  bridge?: DownstreamClientBridge;
}

/**
 * Connect `config`, hand the live connection to `use`, and disconnect before
 * returning -- whatever `use` did, including throwing.
 *
 * Errors from the CONNECT are wrapped in TransientConnectError; errors from
 * `use` propagate unwrapped. The teardown runs either way.
 *
 * The value `use` returns is the value this returns. Do not return the
 * `connection` itself (or anything holding its client): it is closed by the
 * time the caller sees it, so every method on it will fail.
 */
export async function withTransientUpstream<T>(
  config: UpstreamServerConfig,
  use: (connection: UpstreamConnection) => Promise<T>,
  opts: TransientUpstreamOptions = {},
): Promise<T> {
  let connection: UpstreamConnection;
  try {
    // No onDisconnect / onListChanged callbacks: both exist to keep a
    // SESSION's routing table in step with a long-lived upstream, and this
    // connection outlives nothing. A list_changed arriving mid-call would have
    // no table to refresh.
    connection = await connectToUpstream(config, undefined, undefined, opts.bridge);
  } catch (err) {
    throw new TransientConnectError(config.namespace, err);
  }
  try {
    return await use(connection);
  } finally {
    // Belt and braces: disconnectFromUpstream already catches its own close
    // failure and logs a warn (upstream.ts), so this catch fires only if it
    // ever grows a throwing path. It is cheap, and the cost of getting it
    // wrong is an exception from a `finally` REPLACING the caller's real
    // result or error -- the failure would be reported as a teardown problem
    // whatever actually happened.
    await disconnectFromUpstream(connection).catch((e: unknown) =>
      log("warn", "transient upstream disconnect failed", {
        namespace: config.namespace,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
