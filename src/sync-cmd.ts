// `yaw-mcp sync push|pull|status` -- replicate ~/.yaw-mcp/bundles.json
// across machines via the mcp_bundles team-resource on yaw.sh.
//
// Push: strips env VALUES (preserves keys), PUTs to mcp_bundles. The
// server only ever sees the schema of which env vars each server
// expects, never the secret values themselves. Phase 6b will add an
// encrypted mcp_secrets vault for syncing the values too.
//
// Pull: GETs mcp_bundles, merges env values from the LOCAL bundles.json
// where namespaces overlap (so a machine's local API keys aren't wiped
// out by a pull from a machine that didn't have them). Writes the
// merged result to ~/.yaw-mcp/bundles.json.
//
// Status: prints sign-in state + last-pulled version + a coarse local-vs-
// remote diff hint (servers added/removed locally, doesn't diff env).

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { CONFIG_DIRNAME } from "./paths.js";
import {
  TeamSyncAuthError,
  TeamSyncForbiddenError,
  TeamSyncStaleVersionError,
  getResource,
  getSession,
  putResource,
} from "./team-sync.js";
import { readSyncState, writeSyncState } from "./sync-state.js";
import type { UpstreamServerConfig } from "./types.js";

export const SYNC_USAGE = `Usage: yaw-mcp sync <push|pull|status> [--json]

  Replicate ~/.yaw-mcp/bundles.json across machines via your Yaw
  Team account.

  push    Strip env values from the local bundles and upload the
          schema to mcp_bundles. Env values stay machine-local.
  pull    Fetch mcp_bundles, merge env values from the local file
          where namespaces overlap, write the result locally.
  status  Show sign-in state, last-pulled version, and a coarse
          local-vs-remote diff.

  --json  Emit machine-readable JSON.

  Sign in first with \`yaw-mcp login --key <license-key>\`.`;

export const BUNDLES_FILENAME = "bundles.json";
export const MCP_BUNDLES_RESOURCE = "mcp_bundles";

export interface SyncCommandOptions {
  action?: "push" | "pull" | "status";
  json?: boolean;
  /** Test hooks. */
  home?: string;
  baseUrl?: string;
}

export function parseSyncArgs(
  argv: string[],
): { ok: true; options: SyncCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SyncCommandOptions = {};
  for (const a of argv) {
    if (a === "push" || a === "pull" || a === "status") {
      if (opts.action)
        return { ok: false, error: `yaw-mcp sync: multiple actions ("${opts.action}" and "${a}")\n\n${SYNC_USAGE}` };
      opts.action = a;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: SYNC_USAGE, help: true };
    } else {
      return { ok: false, error: `yaw-mcp sync: unknown argument "${a}"\n\n${SYNC_USAGE}` };
    }
  }
  if (!opts.action) return { ok: false, error: `yaw-mcp sync: missing action (push|pull|status)\n\n${SYNC_USAGE}` };
  return { ok: true, options: opts };
}

export interface SyncCommandResult {
  exitCode: number;
}

interface LocalBundlesFile {
  version?: number;
  servers: Partial<UpstreamServerConfig>[];
}

function bundlesPath(home: string): string {
  return join(home, CONFIG_DIRNAME, BUNDLES_FILENAME);
}

async function readLocalBundles(home: string): Promise<LocalBundlesFile> {
  const path = bundlesPath(home);
  if (!existsSync(path)) return { version: 1, servers: [] };
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: invalid JSON -- ${msg}. Fix the file before running sync.`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { servers?: unknown }).servers)) {
    throw new Error(`${path}: malformed -- expected { servers: [...] }`);
  }
  return parsed as LocalBundlesFile;
}

async function writeLocalBundles(home: string, file: LocalBundlesFile): Promise<string> {
  const path = bundlesPath(home);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

/** Strip env VALUES (preserve keys). Object.fromEntries(...) keeps the
 *  shape so the remote schema knows "this server needs GITHUB_TOKEN"
 *  without ever seeing the value. */
function stripEnvValues(server: Partial<UpstreamServerConfig>): Partial<UpstreamServerConfig> {
  if (!server.env || typeof server.env !== "object") return server;
  const stripped = Object.fromEntries(Object.keys(server.env).map((k) => [k, ""]));
  return { ...server, env: stripped };
}

/** Merge env values from `local` into `incoming` by namespace match.
 *  For each incoming server, if a local server with the same namespace
 *  exists AND has env values for the same keys, preserve those values.
 *  Keys present in incoming but missing locally stay empty -- the user
 *  will need to fill them in. */
function mergeLocalEnv(
  incoming: Partial<UpstreamServerConfig>[],
  local: Partial<UpstreamServerConfig>[],
): Partial<UpstreamServerConfig>[] {
  const localByNs = new Map(local.filter((s) => s.namespace).map((s) => [s.namespace as string, s]));
  return incoming.map((srv) => {
    const matched = srv.namespace ? localByNs.get(srv.namespace) : undefined;
    if (!matched || !srv.env || !matched.env) return srv;
    const merged: Record<string, string> = { ...srv.env };
    for (const [k, v] of Object.entries(matched.env)) {
      // Only preserve local value when incoming has the same key with
      // an empty value (the stripped-on-push marker). Don't overwrite a
      // non-empty incoming value -- that case shouldn't happen with the
      // push convention but is defensive.
      if (k in merged && merged[k] === "" && typeof v === "string" && v.length > 0) {
        merged[k] = v;
      }
    }
    return { ...srv, env: merged };
  });
}

/** isActive is remote-authoritative: `set-active` is the sole intended
 *  writer of each server's isActive on the remote. For each local server,
 *  if a remote server with the SAME namespace exists AND carries an
 *  isActive field, take the REMOTE value (overriding whatever stale local
 *  value a push would otherwise clobber it with). Servers with no remote
 *  match keep their local isActive -- those are genuinely new servers this
 *  push is seeding onto the remote for the first time. */
function mergeRemoteActive(
  localStripped: Partial<UpstreamServerConfig>[],
  remoteServers: Partial<UpstreamServerConfig>[],
): Partial<UpstreamServerConfig>[] {
  const remoteByNs = new Map(remoteServers.filter((s) => s.namespace).map((s) => [s.namespace as string, s]));
  return localStripped.map((srv) => {
    const matched = srv.namespace ? remoteByNs.get(srv.namespace) : undefined;
    if (!matched || matched.isActive === undefined) return srv;
    return { ...srv, isActive: matched.isActive };
  });
}

export async function runSync(
  opts: SyncCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<SyncCommandResult> {
  const home = opts.home ?? homedir();
  const session = await getSession({ home, baseUrl: opts.baseUrl });
  if (!session) {
    const msg = "Not signed in. Run `yaw-mcp login --key <license-key>` first.";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp sync: ${msg}\n`);
    return { exitCode: 1 };
  }
  try {
    if (opts.action === "status") return await syncStatus(session, opts, io, home);
    if (opts.action === "pull") return await syncPull(opts, io, home);
    if (opts.action === "push") return await syncPush(opts, io, home);
    io.err(`yaw-mcp sync: unknown action ${opts.action}\n`);
    return { exitCode: 2 };
  } catch (err) {
    return handleSyncError(err, opts, io);
  }
}

interface SyncSession {
  email: string;
  role: string;
  order_id: string;
}

async function syncStatus(
  session: SyncSession,
  opts: SyncCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
  home: string,
): Promise<SyncCommandResult> {
  const remote = await getResource<LocalBundlesFile>(MCP_BUNDLES_RESOURCE, {
    home: opts.home,
    baseUrl: opts.baseUrl,
  });
  // Let a corrupt local bundles.json propagate (as syncPull/syncPush do)
  // rather than silently reporting everything as remote-only.
  const local = await readLocalBundles(home);
  const syncState = await readSyncState(home);
  const lastPulledVersion = syncState.mcp_bundles?.lastPulledVersion ?? null;
  const localNs = new Set(local.servers.map((s) => s.namespace).filter((n): n is string => typeof n === "string"));
  const remoteNs = new Set(
    (remote.data?.servers ?? []).map((s) => s.namespace).filter((n): n is string => typeof n === "string"),
  );
  const localOnly = [...localNs].filter((n) => !remoteNs.has(n));
  const remoteOnly = [...remoteNs].filter((n) => !localNs.has(n));

  if (opts.json) {
    io.out(
      `${JSON.stringify(
        {
          ok: true,
          signedInAs: session.email,
          role: session.role,
          remoteVersion: remote.version,
          lastPulledVersion,
          localOnly,
          remoteOnly,
          updatedAt: remote.updated_at,
          updatedBy: remote.updated_by,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out(`Signed in as ${session.email} (${session.role}).\n`);
    io.out(`Remote mcp_bundles: version ${remote.version}`);
    if (remote.updated_at) io.out(`, updated ${remote.updated_at} by ${remote.updated_by ?? "unknown"}`);
    io.out("\n");
    io.out(lastPulledVersion === null ? "Last pulled: never pulled.\n" : `Last pulled: v${lastPulledVersion}.\n`);
    if (localOnly.length > 0) io.out(`Local-only servers: ${localOnly.join(", ")}\n`);
    if (remoteOnly.length > 0) io.out(`Remote-only servers: ${remoteOnly.join(", ")}\n`);
    if (localOnly.length === 0 && remoteOnly.length === 0) io.out("Server lists match (env values not compared).\n");
  }
  return { exitCode: 0 };
}

async function syncPull(
  opts: SyncCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
  home: string,
): Promise<SyncCommandResult> {
  const remote = await getResource<LocalBundlesFile>(MCP_BUNDLES_RESOURCE, {
    home: opts.home,
    baseUrl: opts.baseUrl,
  });
  const remoteServers = remote.data?.servers ?? [];
  const local = await readLocalBundles(home);
  const merged = mergeLocalEnv(remoteServers, local.servers);
  const written = await writeLocalBundles(home, { version: 1, servers: merged });
  // Persist the version we just pulled so a later push submits IT (not a
  // freshly-GET'd version) and optimistic concurrency can actually fire.
  await writeSyncState(home, { mcp_bundles: { lastPulledVersion: remote.version } });
  if (opts.json) {
    io.out(
      `${JSON.stringify({ ok: true, written, serverCount: merged.length, remoteVersion: remote.version }, null, 2)}\n`,
    );
  } else {
    io.out(`Pulled ${merged.length} server${merged.length === 1 ? "" : "s"} -> ${written}\n`);
    if (remote.version === 0) io.out("Remote mcp_bundles is empty (version 0). Push from this machine to seed it.\n");
  }
  return { exitCode: 0 };
}

async function syncPush(
  opts: SyncCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
  home: string,
): Promise<SyncCommandResult> {
  const local = await readLocalBundles(home);
  // GET the remote so we can merge its authoritative isActive into our
  // payload (FIX A). We do NOT push against this freshly-GET'd version --
  // see below.
  const remote = await getResource<LocalBundlesFile>(MCP_BUNDLES_RESOURCE, {
    home: opts.home,
    baseUrl: opts.baseUrl,
  });
  const remoteServers = remote.data?.servers ?? [];
  // isActive is remote-authoritative; set-active is the sole intended
  // writer; push preserves remote toggles (only seeds isActive for servers
  // not yet on the remote).
  const stripped = mergeRemoteActive(local.servers.map(stripEnvValues), remoteServers);
  const payload: LocalBundlesFile = { version: 1, servers: stripped };
  // Push against the LAST-PULLED version, not the just-GET'd one: if the
  // remote moved ahead since our last pull, the server 409s and the
  // stale-version handler tells the user to pull + reconcile + push. If we
  // never pulled (first push to seed), fall back to the GET'd version so
  // seeding still works.
  const syncState = await readSyncState(home);
  const lastPulled = syncState.mcp_bundles?.lastPulledVersion;
  const pushVersion = lastPulled ?? remote.version;
  const res = await putResource<LocalBundlesFile>(MCP_BUNDLES_RESOURCE, pushVersion, payload, {
    home: opts.home,
    baseUrl: opts.baseUrl,
  });
  // After a successful push, this machine is current at res.version.
  await writeSyncState(home, { mcp_bundles: { lastPulledVersion: res.version } });
  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, serverCount: stripped.length, newVersion: res.version }, null, 2)}\n`);
  } else {
    io.out(`Pushed ${stripped.length} server${stripped.length === 1 ? "" : "s"} -> mcp_bundles v${res.version}.\n`);
    io.out("Env values stripped before upload; use `yaw-mcp secrets push` to sync secrets across machines.\n");
  }
  return { exitCode: 0 };
}

function handleSyncError(
  err: unknown,
  opts: SyncCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void },
): SyncCommandResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TeamSyncStaleVersionError) {
    const hint = `Remote was updated since your last pull (now at v${err.currentVersion}). Run \`yaw-mcp sync pull\`, reconcile any local edits, then \`yaw-mcp sync push\`.`;
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: hint, currentVersion: err.currentVersion })}\n`);
    else io.err(`yaw-mcp sync: ${hint}\n`);
    return { exitCode: 1 };
  }
  if (err instanceof TeamSyncAuthError) {
    if (opts.json)
      io.err(`${JSON.stringify({ ok: false, error: "Session expired or revoked. Run `yaw-mcp login` again." })}\n`);
    else io.err("yaw-mcp sync: session expired or revoked. Run `yaw-mcp login --key <license-key>` again.\n");
    return { exitCode: 1 };
  }
  if (err instanceof TeamSyncForbiddenError) {
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    else io.err(`yaw-mcp sync: ${message}\n`);
    return { exitCode: 1 };
  }
  if (opts.json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
  else io.err(`yaw-mcp sync: ${message}\n`);
  return { exitCode: 1 };
}
