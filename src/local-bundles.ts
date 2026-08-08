// Local server-definitions file -- the source of truth for which MCP
// servers yaw-mcp loads when running in "no account" Free mode.
//
// File path: ~/.yaw-mcp/bundles.json (user-global) or
//            <project>/.yaw-mcp/bundles.json (project-local override).
//
// Project-local FULLY overrides user-global -- no merge. That keeps the
// mental model simple: if you've committed a .yaw-mcp/bundles.json with
// your repo, the team gets exactly that set, no surprises from a
// teammate's user-global file leaking in.
//
// SECURITY: that override only applies to a project file the user has
// EXPLICITLY approved via `yaw-mcp trust` (see trust.ts). A project
// bundles.json is usually committed to a repo, so without a consent gate
// cloning a hostile repo and starting an MCP client inside it was enough to
// spawn its argv as you -- entries default to isActive:true and the server
// prewarms active servers at startup. An UNTRUSTED project file is ignored
// completely: none of its servers load, AND it does not suppress the
// user-global file (suppressing it would be a denial-of-service variant of
// the same bug -- a hostile repo blanking out your real servers). That
// covers a project file yaw-mcp cannot READ, too: unreadability is
// attacker-controlled from inside a repo (commit `.yaw-mcp` as a regular
// file -> ENOTDIR; commit `bundles.json` as a symlink loop -> ELOOP), so an
// unreadable file counts as authoritative only when its path was approved
// before -- see projectFileIsHonoured. The user-global
// ~/.yaw-mcp/bundles.json is the user's own file and is NEVER gated.
// YAW_MCP_TRUST_PROJECT=1 opts out of the check for CI/automation.
//
// If neither file exists, yaw-mcp starts with an empty server list and
// surfaces the "no servers configured" hint pointing at `yaw-mcp add <slug>`
// (NOT `install`, which connects a CLIENT to yaw-mcp).
//
// Exception to winner-takes-all: the top-level `defaultRuntime` knob
// ("oam" | "node") is a MACHINE-level preference, not a server definition --
// a shared bundles.json committed to a repo has no per-machine concept of
// "oam is installed here", so a project file that does not set it falls back
// to the user-global value instead of silently turning it off. See
// default-runtime.ts for the resolution order
// (YAW_MCP_DEFAULT_RUNTIME env > this file's defaultRuntime > unset).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME, findProjectConfigDir, userConfigDir } from "./paths.js";
import {
  hashTrustContent,
  isTrustBypassEnabled,
  normalizeTrustKey,
  readTrustStore,
  TRUST_BYPASS_ENV,
  type TrustStatus,
  trustStatusFor,
  trustStorePath,
} from "./trust.js";
import type { ConnectConfig, UpstreamServerConfig } from "./types.js";

/** Canonical filename for the local bundles file. */
export const BUNDLES_FILENAME = "bundles.json";

/** Schema version emitted by current yaw-mcp. Older files load fine
 *  (back-compat is permissive); newer files trigger a warning. */
export const CURRENT_BUNDLES_SCHEMA_VERSION = 1;

/** The on-disk shape. Mirrors ConnectConfig but with `version` instead
 *  of `configVersion` (the latter is a server-generated ETag we derive
 *  here from a content hash). */
export interface LocalBundlesFile {
  version?: number;
  servers: Array<Partial<UpstreamServerConfig>>;
  /** Config-level default runtime for servers that don't set a per-server
   *  `runtime`. Per-server `"node"` stays an escape hatch under a default of
   *  `"oam"`. Applied in connectToUpstream (via default-runtime.ts) rather than
   *  at load time because the effective default is a MACHINE fact -- whether
   *  oam is installed on the box that spawns the sidecar -- not a property of
   *  the file. */
  defaultRuntime?: "oam" | "node";
}

/** Build the absolute path to bundles.json inside a given config dir. */
export function localBundlesPath(configDir: string): string {
  return join(configDir, BUNDLES_FILENAME);
}

/** Canonical regex for valid MCP server namespaces. validateEntry below is
 *  the only production consumer left -- the remote-config fetcher (config.ts)
 *  that used to share it was deleted with the hosted backend. Still exported
 *  so the test suite (and any future validator) pins the SAME definition
 *  instead of maintaining an independent copy that drifts from the loader's. */
export const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,29}$/;

/** Coerce a raw entry from bundles.json into a strict UpstreamServerConfig.
 *  Returns null when required fields are missing or malformed so the loader
 *  can skip the entry with a warning instead of crashing the whole load. */
function validateEntry(entry: unknown, warnings: string[]): UpstreamServerConfig | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warnings.push("bundles.json: skipping non-object server entry");
    return null;
  }
  const e = entry as Record<string, unknown>;

  const namespace = typeof e.namespace === "string" ? e.namespace : "";
  if (!namespace || !NAMESPACE_RE.test(namespace)) {
    warnings.push(`bundles.json: skipping server with invalid namespace ${JSON.stringify(namespace)}`);
    return null;
  }
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : namespace;
  // Default type to "local" -- bundles.json is the local-mode file by
  // definition. Existing configs use "local" for stdio/spawned
  // servers and "remote" for HTTP/SSE; users can override via the field.
  const type: "local" | "remote" = e.type === "remote" ? "remote" : "local";
  const transport =
    e.transport === "streamable-http" || e.transport === "sse" || e.transport === "stdio"
      ? (e.transport as "stdio" | "streamable-http" | "sse")
      : undefined;

  // Stdio servers need command; remote servers need url. Don't enforce
  // here -- the upstream connector will surface a clear error if the
  // entry can't be spawned/dialed. The validator's job is shape, not
  // semantics.
  const command = typeof e.command === "string" ? e.command : undefined;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : undefined;
  const env =
    e.env && typeof e.env === "object" && !Array.isArray(e.env)
      ? (Object.fromEntries(
          Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : undefined;
  const url = typeof e.url === "string" ? e.url : undefined;
  const description = typeof e.description === "string" ? e.description : undefined;
  // Per-server runtime override. "oam" hosts the server on the oam runtime
  // (connectToUpstream's resolveOamSpawn rewrites node/npx -> `oam run`).
  // Absent = oam when it is installed and meets MIN_OAM_VERSION, else node (see
  // default-runtime.ts for the full resolution order). An explicit "node" is the
  // escape hatch that keeps a server off oam. Without propagating this here, a
  // bundles.json `"runtime": "oam"` is silently dropped and never reaches the
  // resolver -- and note that absent must stay UNDEFINED rather than being
  // normalized to "node": normalizing would pin every unconfigured server off
  // oam, and per-server wins over YAW_MCP_DEFAULT_RUNTIME (upstream.ts), so
  // nothing could undo it.
  const runtime = e.runtime === "oam" || e.runtime === "node" ? e.runtime : undefined;

  // Per-server connect timeout (types.ts). Carried through for the same reason
  // as `runtime` above: the return below is a fixed whitelist, so a field
  // missing from it is DROPPED, and bundles.json is now the only server source
  // -- without this line nothing in the process can ever set the value
  // connectToUpstream reads, and a user's `"connectTimeoutMs": 60000` silently
  // falls back to the global default. Non-numeric and non-positive values are
  // dropped rather than passed on: upstream ignores anything <= 0 anyway, and
  // dropping keeps a typo from reading as configured.
  //
  // A dropped value gets a WARNING, unlike transport/runtime/env above, because
  // this is the one field whose whole purpose is to change a FAILURE the user is
  // already staring at. `MCP_CONNECT_TIMEOUT`'s help says a server's own
  // connectTimeoutMs wins, so the natural response to a handshake timeout is to
  // set it here -- and `"60000"` with the quotes (or a `0`, or a `null`) then
  // leaves the same timeout firing at the same ceiling with nothing anywhere
  // saying the setting was thrown away. Only a PRESENT key warns; absent is the
  // normal case for nearly every entry and must stay silent.
  const connectTimeoutMs =
    typeof e.connectTimeoutMs === "number" && Number.isFinite(e.connectTimeoutMs) && e.connectTimeoutMs > 0
      ? e.connectTimeoutMs
      : undefined;
  if (connectTimeoutMs === undefined && e.connectTimeoutMs !== undefined) {
    warnings.push(
      `bundles.json: ignoring invalid connectTimeoutMs ${JSON.stringify(e.connectTimeoutMs)} on "${namespace}" (expected a positive number)`,
    );
  }

  // Default isActive=true in local mode -- if the user wrote a server
  // into bundles.json they presumably want it loadable. Toggle off with
  // explicit `"isActive": false`.
  const isActive = e.isActive !== false;

  // Synthesize an id from the namespace when absent. The id is mainly
  // a stable handle; not strictly needed, but the
  // downstream code paths use it as a stable handle.
  const id = typeof e.id === "string" && e.id.length > 0 ? e.id : `local-${namespace}`;

  return {
    id,
    name,
    namespace,
    type,
    transport,
    command,
    args,
    env,
    url,
    isActive,
    connectTimeoutMs,
    description,
    runtime,
  };
}

/** Tri-state read result so the caller can distinguish "file doesn't
 *  exist" (fall through to next location) from "file exists but is
 *  malformed" (commit to this location, don't silently substitute
 *  someone else's config). */
interface ReadResult {
  exists: boolean;
  file: LocalBundlesFile | null;
}

/** Raw read outcome, before any parsing. Split out from readBundlesAt so
 *  the trust gate can hash the EXACT bytes it is about to parse: reading
 *  once for the hash and again for the parse would open a TOCTOU window in
 *  which a hostile repo swaps the file between the two reads and gets
 *  unreviewed argv past an approved hash. */
type RawRead =
  | { kind: "ok"; raw: Buffer }
  | { kind: "absent" }
  | { kind: "error"; message: string; code: string | undefined };

async function readBundlesRawAt(path: string): Promise<RawRead> {
  try {
    // Read BYTES, not utf8 text: the trust hash must cover exactly what is
    // on disk. Decoding to a string and back is lossy for invalid UTF-8,
    // which would let two different files produce the same hash.
    return { kind: "ok", raw: await readFile(path) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return { kind: "absent" };
    // Any other error (EPERM, EACCES, ...) means the file likely exists but
    // we can't read it.
    return { kind: "error", message: err instanceof Error ? err.message : String(err), code };
  }
}

/** Read a bundles.json from `path`. Returns:
 *   - { exists: false, file: null } when the file doesn't exist
 *   - { exists: true,  file: <parsed> } when valid
 *   - { exists: true,  file: null } when present-but-malformed (warnings
 *     populated). Caller must NOT fall through in this case -- see
 *     loadLocalBundles. */
async function readBundlesAt(path: string, warnings: string[]): Promise<ReadResult> {
  const r = await readBundlesRawAt(path);
  if (r.kind === "absent") return { exists: false, file: null };
  if (r.kind === "error") {
    // Return exists:true so the caller stays committed to this path instead
    // of silently falling through to the user-global file.
    warnings.push(`${path}: could not read file (${r.message}) -- skipping`);
    log("warn", "Could not read bundles.json", { path, error: r.message, code: r.code });
    return { exists: true, file: null };
  }
  return { exists: true, file: parseBundlesContent(path, r.raw, warnings) };
}

/** Parse already-read bundles.json bytes. Returns null (with warnings
 *  populated) when the content is unusable. Separate from the read so the
 *  trust gate can decide whether to parse at all -- an untrusted file must
 *  produce ONLY the untrusted warning, not a pile of schema diagnostics
 *  about content we are refusing to look at. */
function parseBundlesContent(path: string, rawBytes: Buffer, warnings: string[]): LocalBundlesFile | null {
  const raw = rawBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) -- file ignored`);
    log("warn", "bundles.json is not valid JSON; ignoring", { path, error: msg });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object -- file ignored`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : undefined;
  if (version !== undefined && version > CURRENT_BUNDLES_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this yaw-mcp (${CURRENT_BUNDLES_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcp@latest\`. Loading best-effort.`,
    );
  }
  const rawServers = obj.servers;
  if (!Array.isArray(rawServers)) {
    warnings.push(`${path}: 'servers' must be an array -- file ignored`);
    return null;
  }
  // Top-level default runtime. Only "oam"/"node" are meaningful; anything
  // else is dropped with a warning (matching the per-server `runtime`
  // validation in validateEntry, which drops silently -- top-level gets a
  // warning because a typo here changes EVERY server's runtime).
  let defaultRuntime: "oam" | "node" | undefined;
  if (obj.defaultRuntime === "oam" || obj.defaultRuntime === "node") {
    defaultRuntime = obj.defaultRuntime;
  } else if (obj.defaultRuntime !== undefined) {
    warnings.push(
      `${path}: ignoring invalid 'defaultRuntime' ${JSON.stringify(obj.defaultRuntime)} (expected "oam" or "node")`,
    );
  }
  return { version, servers: rawServers as Array<Partial<UpstreamServerConfig>>, defaultRuntime };
}

/** What a bundles.json would actually contribute if it loaded. Used by
 *  `yaw-mcp trust` to show the user the exact argv they are approving --
 *  it runs the SAME parse + validateEntry the loader runs, so the preview
 *  cannot drift from what would really spawn. */
export interface BundlePreview {
  /** False when the file is unparseable / structurally wrong. */
  ok: boolean;
  servers: UpstreamServerConfig[];
  warnings: string[];
}

export function previewBundlesContent(path: string, rawBytes: Buffer): BundlePreview {
  const warnings: string[] = [];
  const file = parseBundlesContent(path, rawBytes, warnings);
  if (!file) return { ok: false, servers: [], warnings };
  const servers: UpstreamServerConfig[] = [];
  for (const entry of file.servers) {
    const validated = validateEntry(entry, warnings);
    if (validated) servers.push(validated);
  }
  return { ok: true, servers, warnings };
}

/** Deterministic content-derived configVersion. We use this in lieu of
 *  the backend's ETag so downstream "did the config change since last
 *  poll" checks work the same way in local mode (always equal, since
 *  the file is read once at startup). */
function hashContent(servers: UpstreamServerConfig[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(servers));
  return `local-${h.digest("hex").slice(0, 16)}`;
}

// --- Project-trust gate -----------------------------------------------------

/** Everything a caller needs to know about the project bundles.json in
 *  play, WITHOUT re-reading it. `raw` carries the exact bytes the status
 *  was computed from so `yaw-mcp trust` can render the argv it is about to
 *  approve and grant against the very same content. */
export interface ProjectTrustProbe {
  /** Absolute path of the project bundles.json, or null when no `.yaw-mcp/`
   *  directory was found by walking up from cwd. Set even when the file
   *  itself is absent (status "none"), so the CLI can say where it looked. */
  path: string | null;
  status: "none" | "unreadable" | TrustStatus;
  /** YAW_MCP_TRUST_PROJECT is enabled -- the loader honours the project file
   *  regardless of `status`. Kept separate from `status` so diagnostics keep
   *  reporting the REAL trust state while the escape hatch is on. */
  bypassed: boolean;
  /** Exact bytes; null unless status is trusted/changed/untrusted/store-unreadable. */
  raw: Buffer | null;
  /** SHA-256 of `raw`; null when raw is null. */
  sha256: string | null;
  /** Read-error message when status === "unreadable". */
  error: string | null;
  /** Absolute path of the trust store consulted. */
  storePath: string;
  /** Is this PATH in the trust store at all, ignoring the content hash?
   *
   *  Only consulted for status "unreadable": we cannot hash a file we cannot
   *  read, so the content pin is unavailable and a path record is the only
   *  evidence of prior consent there is. Every other status uses the
   *  hash-checked `status` -- a path-only match must NEVER stand in for it,
   *  or a repo could swap an approved file's contents and keep loading.
   *  False when the store is malformed (fail closed) and when the store was
   *  never consulted (status "none").
   *
   *  Optional so callers that synthesize a probe for display purposes (the
   *  `untrustedProjectWarning` fixtures) don't have to name it; absent is
   *  read as false. probeProjectTrust always sets it. */
  pathTrusted?: boolean;
}

/**
 * Locate the project bundles.json from `cwd` and classify it against the
 * trust store. Reads the file exactly ONCE and hands the bytes back, so no
 * caller has to re-read (and no TOCTOU window opens between the hash and
 * the parse / the display / the grant).
 */
export async function probeProjectTrust(
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProjectTrustProbe> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const bypassed = isTrustBypassEnabled(env);
  const storePath = trustStorePath(home);

  const projectDir = await findProjectConfigDir(cwd, home).catch(() => null);
  const path = projectDir ? localBundlesPath(projectDir) : null;
  if (path === null) {
    return {
      path: null,
      status: "none",
      bypassed,
      raw: null,
      sha256: null,
      error: null,
      storePath,
      pathTrusted: false,
    };
  }
  const read = await readBundlesRawAt(path);
  if (read.kind === "absent") {
    return { path, status: "none", bypassed, raw: null, sha256: null, error: null, storePath, pathTrusted: false };
  }
  // The store is read for the unreadable case too: an unreadable file is
  // honoured only when its PATH was approved before (see
  // projectFileIsHonoured), and that question needs the store.
  const store = await readTrustStore(home);
  const pathTrusted = !store.malformed && normalizeTrustKey(path) in store.entries;
  if (read.kind === "error") {
    return {
      path,
      status: "unreadable",
      bypassed,
      raw: null,
      sha256: null,
      error: read.message,
      storePath,
      pathTrusted,
    };
  }
  return {
    path,
    status: trustStatusFor(path, read.raw, store),
    bypassed,
    raw: read.raw,
    sha256: hashTrustContent(read.raw),
    error: null,
    storePath,
    pathTrusted,
  };
}

/**
 * The warning a blocked project bundles.json produces. Names the ignored
 * path and the exact command to approve it -- a security gate the user
 * cannot see their way out of just reads as "my servers stopped working".
 *
 * SHORT BY DEFAULT. This fires on EVERY yaw-mcp invocation inside an
 * unapproved repo (`list`, `add`, the server's own startup), so the default
 * form is one line: what was ignored, and how to approve it. Pass
 * `{ detail: true }` for the full explanation -- `yaw-mcp doctor` does, and
 * doctor is the surface a confused user is pointed at.
 */
export function untrustedProjectWarning(probe: ProjectTrustProbe, opts: { detail?: boolean } = {}): string {
  const path = probe.path ?? "(unknown)";
  const approve = "`yaw-mcp trust` to approve";
  // Only the detailed form spells out the fallback and the escape hatch; the
  // short form names the env var without the paragraph explaining it.
  const detail = opts.detail === true;
  const fallback = detail
    ? " Falling back to your user-global ~/.yaw-mcp/bundles.json."
    : " Using user-global instead.";
  const escapeHatch = detail
    ? ` Set ${TRUST_BYPASS_ENV}=1 to skip this check (CI/automation only -- it lets any repo you run inside spawn commands as you).`
    : ` (${TRUST_BYPASS_ENV}=1 skips this check; CI only.)`;
  if (probe.status === "changed") {
    const why = detail ? " The new contents could spawn commands you never reviewed." : "";
    return `${path}: project bundles.json CHANGED since you approved it -- IGNORED.${why}${fallback} Re-review, then run ${approve}.${escapeHatch}`;
  }
  if (probe.status === "store-unreadable") {
    const fix = detail ? " Fix or delete that file, then re-approve from inside this project." : "";
    return `${path}: project bundles.json IGNORED -- the trust store at ${probe.storePath} could not be read, so nothing is trusted (fail-closed).${fallback}${fix} Then run ${approve}.${escapeHatch}`;
  }
  if (probe.status === "unreadable") {
    // Not a consent refusal: the bytes could not be read at all, so there is
    // nothing to hash and nothing to approve until the file is fixed. Kept
    // distinct so the user goes and looks at the file instead of at the
    // trust store. See projectFileIsHonoured for why this falls through.
    const why = detail
      ? " An unreadable project file that has never been approved is treated as absent rather than as authoritative -- otherwise a repo could blank out your servers just by committing something yaw-mcp cannot read."
      : "";
    return `${path}: project bundles.json could not be read (${probe.error}) and was never approved -- IGNORED.${why}${fallback} Fix the file, then run ${approve}.`;
  }
  const why = detail
    ? " A project file is usually committed to the repo and can spawn arbitrary commands as you, so it has to be approved first."
    : "";
  return `${path}: untrusted project bundles.json -- IGNORED.${why}${fallback} Review the servers, then run ${approve}.${escapeHatch}`;
}

/** Does the loader honour this project file? True for an approved file and
 *  for the env escape hatch.
 *
 *  UNREADABLE IS THE SUBTLE CASE. Being honoured commits the loader to the
 *  project location, and an unreadable file parses to nothing -- so honouring
 *  one yields zero servers AND suppresses the user-global file. That is
 *  exactly the denial-of-service variant the module header warns about, and
 *  unreadability is attacker-controlled from inside a repo: committing
 *  `.yaw-mcp` as a regular FILE makes the read fail with ENOTDIR, and
 *  committing `bundles.json` as a symlink loop makes it fail with ELOOP.
 *  Both survive `git clone` byte-for-byte on Linux/macOS, so any client
 *  opened in that checkout would silently lose every server.
 *
 *  So an unreadable file is honoured ONLY when its PATH is already in the
 *  trust store -- the user approved that exact file before, and "an approved
 *  bundles.json is authoritative even when it is broken" still applies (a
 *  chmod 000 on a file you trust must not silently swap in a different
 *  config). A path we have never seen falls through to user-global like any
 *  other unapproved state, with a warning. The path-only lookup is confined
 *  to this branch: there are no bytes to hash, so the content pin cannot be
 *  checked, and it must never substitute for the hash anywhere else.
 *
 *  The env escape hatch still honours it -- YAW_MCP_TRUST_PROJECT means
 *  "treat this checkout as approved", which is a strictly larger grant than
 *  the one being made here.
 *
 *  Exported for tests: the unreadable shapes that reach this branch (ENOTDIR,
 *  ELOOP, EACCES) cannot all be produced on every platform -- Windows maps
 *  the ENOTDIR shape to ENOENT and needs a privileged account for symlinks --
 *  so the decision itself is unit-tested over synthesized probes. */
export function projectFileIsHonoured(probe: ProjectTrustProbe): boolean {
  if (probe.status === "none") return false;
  if (probe.status === "unreadable") return probe.bypassed || probe.pathTrusted === true;
  return probe.bypassed || probe.status === "trusted";
}

export interface LoadLocalBundlesResult {
  config: ConnectConfig | null;
  path: string | null;
  warnings: string[];
  /** Top-level `defaultRuntime`. A project file that SETS it wins; a project
   *  file that doesn't falls back to the user-global file's value -- the
   *  knob is a MACHINE-level preference, so a committed team bundles.json
   *  (which will never carry a machine fact) must not silently turn it off.
   *  This is the one deliberate departure from the winner-takes-all
   *  server-list precedence. Undefined when nothing sets it. */
  defaultRuntime?: "oam" | "node";
  /** Absolute path of the bundles.json the defaultRuntime came from (may be
   *  the user-global file even when servers came from a project file -- see
   *  above). Undefined when defaultRuntime is undefined. */
  defaultRuntimePath?: string;
}

/** Load bundles.json from the canonical locations. An APPROVED project-local
 *  file (`<project>/.yaw-mcp/bundles.json`, see probeProjectTrust) wins over
 *  user-global (`~/.yaw-mcp/bundles.json`) -- no merge (defaultRuntime
 *  excepted; see LoadLocalBundlesResult). An unapproved project file is
 *  ignored entirely and the user-global file loads as if it weren't there.
 *  Returns null config when neither file exists, so the caller can render
 *  the empty-state hint. */
export async function loadLocalBundles(
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadLocalBundlesResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const warnings: string[] = [];

  const globalPath = localBundlesPath(join(home, CONFIG_DIRNAME));

  // Consent gate. An unapproved project file is dropped BEFORE it is parsed
  // (so it contributes no servers and no schema diagnostics) and does NOT
  // shadow the user-global file -- otherwise a hostile repo could blank out
  // the user's real server list just by committing a bundles.json (or by
  // committing one yaw-mcp cannot read; see projectFileIsHonoured).
  const probe = await probeProjectTrust({ cwd, home, env: opts.env });
  const honoured = projectFileIsHonoured(probe);
  const projectPath = honoured ? probe.path : null;
  if (probe.path !== null && probe.status !== "none" && !honoured) {
    warnings.push(untrustedProjectWarning(probe));
    // DEBUG, not warn: the same facts are already in the warning above, which
    // every CLI entry point prints as `warning: ...`. Logging at warn too put
    // a raw JSON envelope on stderr in front of the prose version of itself
    // on every single command run inside an unapproved repo.
    log("debug", "Ignoring untrusted project bundles.json", {
      path: probe.path,
      status: probe.status,
      sha256: probe.sha256,
    });
  }

  // The honoured project file wins entirely. If it is present but malformed
  // (or unreadable), we commit to that location (config null, warnings
  // surfaced) instead of silently substituting the user-global config -- an
  // APPROVED bundles.json is authoritative even when it is broken. Note the
  // unreadable branch below is reachable ONLY for a previously-approved path
  // or under the env bypass; an unknown unreadable path never gets here
  // (projectFileIsHonoured drops it), so this cannot be used to suppress the
  // user-global file from a fresh checkout.
  let projectResult: ReadResult = { exists: false, file: null };
  if (projectPath !== null) {
    if (probe.status === "unreadable") {
      warnings.push(`${projectPath}: could not read file (${probe.error}) -- skipping`);
      log("warn", "Could not read bundles.json", { path: projectPath, error: probe.error });
      projectResult = { exists: true, file: null };
    } else {
      // probe.raw is non-null for every non-"none"/non-"unreadable" status.
      projectResult = { exists: true, file: parseBundlesContent(projectPath, probe.raw as Buffer, warnings) };
    }
  }

  let file: LocalBundlesFile | null;
  let sourcePath: string | null;
  if (projectResult.exists) {
    file = projectResult.file;
    sourcePath = projectPath;
  } else {
    const globalResult = await readBundlesAt(globalPath, warnings);
    file = globalResult.file;
    sourcePath = globalResult.exists ? globalPath : null;
  }

  if (!file) {
    // Even when the winning project file is present-but-malformed (config
    // null, warnings surfaced), defaultRuntime is still a MACHINE-level knob
    // -- fall through to the user-global file for it, same rationale as the
    // valid-project case below. The scratch array keeps the global file's own
    // diagnostics out of the result (its servers are shadowed either way).
    if (sourcePath === projectPath && projectPath !== null) {
      const scratch: string[] = [];
      const globalResult = await readBundlesAt(globalPath, scratch);
      if (globalResult.file?.defaultRuntime !== undefined) {
        return {
          config: null,
          path: sourcePath,
          warnings,
          defaultRuntime: globalResult.file.defaultRuntime,
          defaultRuntimePath: globalPath,
        };
      }
    }
    return { config: null, path: sourcePath, warnings };
  }

  const servers: UpstreamServerConfig[] = [];
  for (const raw of file.servers) {
    const validated = validateEntry(raw, warnings);
    if (validated) servers.push(validated);
  }

  // defaultRuntime is machine-level: when a VALID project file won but
  // doesn't set it, fall back to the user-global file's value. The scratch
  // warnings array keeps the global file's diagnostics out of the result --
  // its servers are deliberately shadowed, so "file ignored"-class warnings
  // about it would only confuse.
  let defaultRuntime = file.defaultRuntime;
  let defaultRuntimePath = defaultRuntime !== undefined ? (sourcePath ?? undefined) : undefined;
  if (defaultRuntime === undefined && sourcePath === projectPath && projectPath !== null) {
    const scratch: string[] = [];
    const globalResult = await readBundlesAt(globalPath, scratch);
    if (globalResult.file?.defaultRuntime !== undefined) {
      defaultRuntime = globalResult.file.defaultRuntime;
      defaultRuntimePath = globalPath;
    }
  }

  return {
    config: {
      servers,
      configVersion: hashContent(servers),
    },
    path: sourcePath,
    warnings,
    defaultRuntime,
    defaultRuntimePath,
  };
}

// --- Write path (used by `yaw-mcp add` / `remove`) --------------------------
//
// These mutate the USER-GLOBAL ~/.yaw-mcp/bundles.json. They are the only
// writers of local server definitions in the CLI. A project-local
// <cwd>/.yaw-mcp/bundles.json FULLY overrides user-global on load (see
// loadLocalBundles), so the add/remove commands warn separately when a
// project file would shadow the write -- they don't silently target it.
//
// LOSSY REWRITE: add/remove serialize the file back out via JSON.stringify
// (readRawUserBundles -> {version, servers, defaultRuntime?} -> atomicWriteFile).
// The reader (readBundlesAt) accepts JSONC comments and tolerates unknown
// top-level keys, but this write path preserves NEITHER: any `//` or `/* */`
// comments the user hand-added, and any top-level key beyond version/servers/
// defaultRuntime, are dropped the first time `add`/`remove` touches the file.
// bundles.json is a tool-managed file; hand-edits survive READS but not the
// next tool-driven WRITE. (Per-server unknown fields inside a server object
// ARE preserved -- readRawUserBundles round-trips the raw server entries.)
//
// In-process serializer: concurrent upsert/remove calls on the same file
// would race -- both would read the same on-disk snapshot, both would
// produce a different modified copy, and the loser's write would silently
// overwrite the winner's. Gate both functions through a shared promise chain
// (same pattern as saveState in persistence.ts) so they execute one at a
// time within a single process.
//
// KNOWN LIMITATION: the chain serializes within ONE process only. Two
// concurrent yaw-mcp PROCESSES (two terminals running `yaw-mcp add`, or the
// CLI racing the Yaw Terminal app's own bundles.json writer) still race
// last-write-wins across the read-modify-write window -- the atomic write
// protects against torn/partial files, not lost updates. Cross-process
// locking (lockfile / O_EXCL sidecar with stale-lock recovery) is
// deliberately out of scope for now: the collision window is one small
// read+write and the practical rate is low. If lost writes are ever
// observed, add a lockfile around doUpsertUserBundle / doRemoveUserBundle.
let bundleWriteChain: Promise<void> = Promise.resolve();

/**
 * Derive a namespace from a server's DISPLAY NAME. This MUST stay
 * byte-for-byte identical to the Yaw Terminal app's deriveNamespace
 * (yaw-install-handler.ts) -- both write to the same ~/.yaw-mcp/bundles.json,
 * so a divergent algorithm would make the same catalog server land under two
 * different namespaces (CLI-added vs app/badge-added), duplicating tool
 * prefixes and breaking cross-path dedup + the app's "installed" check.
 *
 * Algorithm (identical to the app): lowercase, strip ALL non-alphanumerics,
 * 's'-prefix a leading non-letter (so "1Password" -> "s1password"), cap at 30,
 * fall back to "server" when nothing survives. Always returns a NAMESPACE_RE-
 * valid string (never null), so callers don't need a failure branch.
 */
export function deriveNamespace(name: string): string {
  let ns = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (ns.length === 0) return "server";
  if (!/^[a-z]/.test(ns)) ns = `s${ns}`;
  if (ns.length > 30) ns = ns.slice(0, 30);
  return ns;
}

/**
 * Read the RAW user-global bundles.json (no validate/coerce) so a save
 * round-trips fields validateEntry would otherwise drop. Returns a fresh
 * skeleton when the file is absent; THROWS when present-but-malformed so a
 * write never clobbers a file the user hand-edited into an invalid state.
 */
async function readRawUserBundles(home: string): Promise<LocalBundlesFile> {
  const path = localBundlesPath(userConfigDir(home));
  if (!existsSync(path)) {
    return { version: CURRENT_BUNDLES_SCHEMA_VERSION, servers: [] };
  }
  const warnings: string[] = [];
  const r = await readBundlesAt(path, warnings);
  if (!r.file) {
    // Branch on the warning content to give the user the most actionable
    // message: a read error (EPERM / EACCES) hints at permissions; a parse
    // failure hints at invalid JSON. readBundlesAt populates warnings with
    // the OS error string for read failures and with "invalid JSON" for
    // parse failures, so we sniff those keywords here.
    const warningText = warnings.join("; ");
    const isReadError = /EPERM|EACCES|could not read/i.test(warningText);
    if (isReadError) {
      throw new Error(`${path} could not be read (${warningText}) -- check file permissions before adding servers.`);
    }
    // Default: parse failure or structural mismatch.
    const detail = warnings.length > 0 ? ` (${warningText})` : "";
    throw new Error(`${path} could not be parsed -- fix the JSON${detail} before adding servers.`);
  }
  // Surface non-fatal read warnings on the write path too: an invalid
  // `defaultRuntime` value (a typo like "omm") is dropped by readBundlesAt,
  // and the rewrite below would silently delete the key from the file --
  // the user should see WHY before it vanishes.
  for (const w of warnings) {
    log("warn", "bundles.json warning (write path)", { warning: w });
  }
  // Round-trip defaultRuntime so an add/remove never drops the user's
  // config-level runtime knob (validateEntry-style coercion already ran in
  // readBundlesAt; an invalid value was warned about and dropped there).
  return {
    version: r.file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION,
    servers: r.file.servers,
    ...(r.file.defaultRuntime !== undefined ? { defaultRuntime: r.file.defaultRuntime } : {}),
  };
}

/** A raw `env` map off disk, narrowed to its string-valued keys (the only
 *  shape validateEntry honours). Undefined when the field is absent or isn't
 *  a plain object, so the merge below leaves a garbage value untouched
 *  instead of laundering it into a well-formed one. */
function envStrings(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

/**
 * Fold an incoming entry onto the one already on disk. An upsert is a PARTIAL
 * update, not a wholesale slot replacement: everything the caller does not
 * speak to keeps the value the user has there.
 *
 * Why this is not `file.servers[idx] = entry`: `yaw-mcp add <slug>` rebuilds
 * its entry from the catalog every time, so a re-add (to pick up a new catalog
 * command, say) used to blow away state only the user could have put there --
 * a persisted `--env` secret, an explicit `"isActive": false`, a per-server
 * `"runtime": "oam"` override, a hand-tuned `connectTimeoutMs`, and any field
 * outside the writer's vocabulary. All of it silently, under an "Updated ..."
 * success line.
 *
 * Three rules, in order:
 *   1. A field the incoming entry leaves UNDEFINED keeps its on-disk value.
 *      (Defined fields win: command/args/description are exactly what a
 *      re-add is FOR.)
 *   2. `env` merges per KEY rather than being swapped wholesale, and an EMPTY
 *      incoming value never blanks a stored one -- `add` seeds every required
 *      key with "" and only fills in what came from an explicit `--env`, so a
 *      wholesale swap is how the stored secret disappeared.
 *   3. An incoming `isActive: true` does NOT re-enable an entry the user
 *      explicitly disabled. `true` is boilerplate every writer stamps;
 *      `"isActive": false` is a deliberate hand-edit, and there is no `enable`
 *      verb for `add` to be the accidental inverse of. An explicit `false`
 *      still disables.
 */
function mergeServerEntry(
  existing: Partial<UpstreamServerConfig>,
  incoming: Partial<UpstreamServerConfig>,
): Partial<UpstreamServerConfig> {
  const base = existing as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (v === undefined) continue;
    merged[k] = v;
  }
  if (base.isActive === false && incoming.isActive !== false) merged.isActive = false;

  const storedEnv = envStrings(base.env);
  const incomingEnv = envStrings((incoming as Record<string, unknown>).env);
  if (storedEnv || incomingEnv) {
    const env: Record<string, string> = { ...storedEnv };
    for (const [k, v] of Object.entries(incomingEnv ?? {})) {
      if (v.trim() === "" && (env[k] ?? "").trim() !== "") continue;
      env[k] = v;
    }
    merged.env = env;
  }
  return merged as Partial<UpstreamServerConfig>;
}

/**
 * Insert or update a server entry in the user-global bundles.json. An
 * existing entry matches by namespace OR display name -- the name fallback
 * mirrors the app's deduper (yaw-install-handler.ts doInstall) so a server
 * added on the other path (e.g. a legacy entry written without a namespace)
 * isn't duplicated. An existing entry is UPDATED, not overwritten: see
 * mergeServerEntry for exactly what survives. Atomic write.
 *
 * Returns the path written, whether an existing entry was updated (vs a fresh
 * add), and the entry AS WRITTEN -- callers that report what landed on disk
 * (`add --json`, the ambient-env note) must describe the merged result, not
 * the pre-merge input they handed in.
 *
 * Serialized via bundleWriteChain so concurrent calls don't lose writes.
 */
export function upsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string } = {},
): Promise<{ path: string; replaced: boolean; entry: Partial<UpstreamServerConfig> }> {
  const result = bundleWriteChain.then(() => doUpsertUserBundle(entry, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function doUpsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string },
): Promise<{ path: string; replaced: boolean; entry: Partial<UpstreamServerConfig> }> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  const file = await readRawUserBundles(home);
  const idx = file.servers.findIndex(
    (s) => s?.namespace === entry.namespace || (entry.name != null && s?.name === entry.name),
  );
  const replaced = idx >= 0;
  const written = replaced ? mergeServerEntry(file.servers[idx] ?? {}, entry) : entry;
  if (replaced) file.servers[idx] = written;
  else file.servers.push(written);
  // Preserve a newer on-disk schema version rather than downgrading it; only
  // stamp CURRENT when the file had none (readRawUserBundles guarantees a
  // numeric version when the file existed, so this only fills the fresh case).
  file.version = file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION;
  // dirMode 0o700 so a freshly-created ~/.yaw-mcp/ is born owner-only
  // (matching secrets-vault): bundles.json can carry per-server `--env`
  // secrets, so its parent dir must not be group/other-listable.
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod not supported on this filesystem; not fatal.
    }
  }
  return { path, replaced, entry: written };
}

/**
 * Remove a server entry (by namespace) from the user-global bundles.json.
 * No-op (removed:false) when the file or the namespace is absent. Atomic
 * write when a removal actually happens.
 *
 * Serialized via bundleWriteChain so concurrent calls don't lose writes.
 */
export function removeUserBundle(
  namespace: string,
  opts: { home?: string } = {},
): Promise<{ path: string; removed: boolean }> {
  const result = bundleWriteChain.then(() => doRemoveUserBundle(namespace, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function doRemoveUserBundle(
  namespace: string,
  opts: { home?: string },
): Promise<{ path: string; removed: boolean }> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  if (!existsSync(path)) return { path, removed: false };
  const file = await readRawUserBundles(home);
  const before = file.servers.length;
  file.servers = file.servers.filter((s) => s?.namespace !== namespace);
  if (file.servers.length === before) return { path, removed: false };
  // Preserve a newer on-disk schema version rather than downgrading it.
  file.version = file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION;
  // dirMode 0o700 so a freshly-created ~/.yaw-mcp/ is born owner-only
  // (matching secrets-vault): bundles.json can carry per-server `--env`
  // secrets, so its parent dir must not be group/other-listable.
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod not supported on this filesystem; not fatal.
    }
  }
  return { path, removed: true };
}

/**
 * Does a project-local bundles.json exist that would shadow a user-global
 * write? `add`/`remove` warn when this returns a path, since a write to
 * user-global won't load while the project file is in effect.
 *
 * Trust-aware: an UNAPPROVED project file no longer shadows anything (see
 * loadLocalBundles), so reporting it as a shadow would send the user off to
 * edit a file that is being ignored. Only a file the loader would actually
 * honour is returned.
 */
export async function findShadowingProjectBundles(
  cwd: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const probe = await probeProjectTrust({ cwd, home, env });
  return projectFileIsHonoured(probe) ? probe.path : null;
}
