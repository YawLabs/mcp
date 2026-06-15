// `yaw-mcp set-active <namespace> <on|off>` -- authoritatively enable or disable
// a server in the shared Yaw Team config (the mcp_bundles team resource). Flips
// isActive on the matching server and PUTs it back, so the change applies to
// EVERY member's config on their next sync/connect. Requires sign-in.
//
// This mutates the SHARED team resource -- it is the authoritative toggle. To
// hide a server only on the local machine, edit the `blocked` list in
// ~/.yaw-mcp/config.json instead (config-loader isAllowed); that is what vew's
// per-server checkbox does for non-team / local-only control.

import { homedir } from "node:os";
import { NAMESPACE_RE } from "./local-bundles.js";
import { writeSyncState } from "./sync-state.js";
import {
  type BaseOpts,
  TeamSyncAuthError,
  TeamSyncForbiddenError,
  TeamSyncStaleVersionError,
  getResource as defaultGetResource,
  putResource as defaultPutResource,
} from "./team-sync.js";
import type { UpstreamServerConfig } from "./types.js";

/** The shared team resource holding the server schema (env values stripped),
 *  same shape `yaw-mcp sync` reads/writes. */
export const SET_ACTIVE_RESOURCE = "mcp_bundles";

export const SET_ACTIVE_USAGE = `Usage: yaw-mcp set-active <namespace> <on|off>

  Enable or disable a server in your shared Yaw Team config. The change is
  authoritative -- it applies to every member's config on their next
  sync/connect.

  <namespace>   The server's namespace (see \`yaw-mcp sync status\` or the dashboard).
  on|off        Whether the server should be active.
  --json        Emit machine-readable JSON instead of prose.

  Sign in first with \`yaw-mcp login --key <license-key>\`. To hide a server only
  on THIS machine, edit the \`blocked\` list in ~/.yaw-mcp/config.json instead.`;

interface TeamBundles {
  version?: number;
  servers: Partial<UpstreamServerConfig>[];
}

export interface SetActiveOptions {
  namespace?: string;
  active?: boolean;
  json?: boolean;
  /** Test hooks (forwarded to team-sync). */
  home?: string;
  baseUrl?: string;
}

function parseState(s: string): boolean | null {
  const v = s.toLowerCase();
  if (v === "on" || v === "true" || v === "enable" || v === "enabled") return true;
  if (v === "off" || v === "false" || v === "disable" || v === "disabled") return false;
  return null;
}

export function parseSetActiveArgs(
  argv: string[],
): { ok: true; options: SetActiveOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SetActiveOptions = {};
  const positionals: string[] = [];
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: SET_ACTIVE_USAGE, help: true };
    else if (a.startsWith("-"))
      return { ok: false, error: `yaw-mcp set-active: unknown flag "${a}"\n\n${SET_ACTIVE_USAGE}` };
    else positionals.push(a);
  }
  if (positionals.length > 2)
    return { ok: false, error: `yaw-mcp set-active: too many arguments\n\n${SET_ACTIVE_USAGE}` };
  const [ns, state] = positionals;
  if (!ns || !state)
    return { ok: false, error: `yaw-mcp set-active: <namespace> and <on|off> are required\n\n${SET_ACTIVE_USAGE}` };
  if (!NAMESPACE_RE.test(ns))
    return { ok: false, error: `yaw-mcp set-active: invalid namespace "${ns}"\n\n${SET_ACTIVE_USAGE}` };
  const active = parseState(state);
  if (active === null)
    return { ok: false, error: `yaw-mcp set-active: state must be on|off (got "${state}")\n\n${SET_ACTIVE_USAGE}` };
  opts.namespace = ns;
  opts.active = active;
  return { ok: true, options: opts };
}

export interface SetActiveResult {
  exitCode: number;
}

type IO = { out: (s: string) => void; err: (s: string) => void };

/** Injectable team-resource I/O so the command unit-tests without a network. */
export interface SetActiveDeps {
  getResource: typeof defaultGetResource;
  putResource: typeof defaultPutResource;
  writeSyncState: typeof writeSyncState;
}

export async function runSetActive(
  opts: SetActiveOptions,
  io: IO = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  deps: SetActiveDeps = { getResource: defaultGetResource, putResource: defaultPutResource, writeSyncState },
): Promise<SetActiveResult> {
  const { namespace, active } = opts;
  if (!namespace || active === undefined) {
    io.err("yaw-mcp set-active: <namespace> and <on|off> are required\n");
    return { exitCode: 2 };
  }
  const base: BaseOpts = { home: opts.home, baseUrl: opts.baseUrl };
  try {
    // Pull, mutate, push -- retry once on a stale-version conflict (someone else
    // wrote the resource between our GET and PUT).
    for (let attempt = 0; ; attempt++) {
      const res = await deps.getResource<TeamBundles>(SET_ACTIVE_RESOURCE, base);
      const data: TeamBundles = res.data ?? { servers: [] };
      const servers = Array.isArray(data.servers) ? data.servers : [];
      const idx = servers.findIndex((s) => s?.namespace === namespace);
      if (idx < 0) {
        return fail(
          io,
          opts.json,
          `No team server with namespace "${namespace}". Run \`yaw-mcp sync status\` to list them.`,
          1,
        );
      }
      // Normalize current state the way the aggregator does (local-bundles:
      // absent isActive means active, only explicit false is inactive), so
      // `set-active <ns> on` on a server with no isActive field is a true no-op
      // rather than a redundant write.
      if ((servers[idx].isActive !== false) === active) {
        return done(io, opts.json, namespace, active, false); // already in the desired state
      }
      const nextServers = servers.map((s, i) => (i === idx ? { ...s, isActive: active } : s));
      try {
        // Stamp the bundles-data schema version (1) so this writer agrees
        // with syncPush, which also PUTs version:1.
        const putRes = await deps.putResource<TeamBundles>(
          SET_ACTIVE_RESOURCE,
          res.version,
          { ...data, version: 1, servers: nextServers },
          base,
        );
        // We just advanced the remote, so this machine is now current at the
        // new version. Record it in the local sync-state so an immediate
        // `yaw-mcp sync push` from here doesn't spuriously 409 (and force a
        // needless pull) against a remote we ourselves just moved. Best-effort:
        // the authoritative toggle already succeeded server-side, so a local
        // sync-state write failure must not fail the command.
        if (typeof putRes.version === "number") {
          await deps
            .writeSyncState(opts.home ?? homedir(), {
              mcp_bundles: { lastPulledVersion: putRes.version },
            })
            .catch(() => {});
        }
        return done(io, opts.json, namespace, active, true);
      } catch (e) {
        if (e instanceof TeamSyncStaleVersionError && attempt < 1) continue;
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof TeamSyncAuthError)
      return fail(io, opts.json, "Not signed in. Run `yaw-mcp login --key <license-key>` first.", 1);
    if (e instanceof TeamSyncForbiddenError)
      return fail(io, opts.json, "You do not have permission to edit the team's servers.", 1);
    return fail(io, opts.json, e instanceof Error ? e.message : String(e), 1);
  }
}

function done(
  io: IO,
  json: boolean | undefined,
  namespace: string,
  active: boolean,
  changed: boolean,
): SetActiveResult {
  if (json) {
    io.out(`${JSON.stringify({ ok: true, namespace, isActive: active, changed })}\n`);
  } else if (changed) {
    io.out(`${namespace} is now ${active ? "active" : "inactive"} for the team.\n`);
  } else {
    io.out(`${namespace} is already ${active ? "active" : "inactive"}.\n`);
  }
  return { exitCode: 0 };
}

function fail(io: IO, json: boolean | undefined, message: string, code: number): SetActiveResult {
  if (json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
  else io.err(`yaw-mcp set-active: ${message}\n`);
  return { exitCode: code };
}
