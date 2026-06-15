// Team-sync client for yaw-mcp -- adapts yaw/src/team-sync.ts (the
// Electron version used by Yaw Terminal) to a Node.js CLI. Same backend
// (yaw.sh /api/team/*), same yaw_team cookie, same HMAC session payload.
// Yaw Team buyers get one license that grants access to both
// surfaces (Terminal + MCP); see plans-v2.md "Yaw Team bundling".
//
// Persistence: ~/.yaw-mcp/team-session.json with mode 0600 on POSIX
// (Windows relies on user-profile ACLs). No safeStorage equivalent in
// Node -- the cookie is HMAC-signed by the server and replay-only
// dangerous if exfiltrated, so file perms is the right defense surface
// (same as ~/.netrc, ~/.ssh/config).
//
// This module only handles auth + raw resource I/O. The sync UX
// (push/pull/status) lives in sync-cmd.ts; login/logout live in their
// own *-cmd.ts files.

import { existsSync } from "node:fs";
import { chmod, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

const BASE_URL_DEFAULT = "https://yaw.sh";
const COOKIE_NAME = "yaw_team";
const REQUEST_TIMEOUT_MS = 15_000;
export const SESSION_STATE_FILENAME = "team-session.json";

export type TeamRole = "admin" | "member";

export interface TeamSession {
  email: string;
  role: TeamRole;
  order_id: string;
  /** Session expiration as ms since epoch. */
  exp: number;
  /** Per-resource write permission map. Includes Yaw Terminal
   *  resources (commands/connections/runbooks) and Yaw MCP resources
   *  (mcp_bundles/mcp_secrets/mcp_audit_log). Admins get all true;
   *  members get true only for resources whose allowlist contains
   *  their email. */
  can_edit?: Record<string, boolean>;
}

export interface TeamResource<T> {
  version: number;
  data: T | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface StoredState {
  cookie: string;
  session: TeamSession;
}

export class TeamSyncAuthError extends Error {
  constructor(message = "Not signed in.") {
    super(message);
    this.name = "TeamSyncAuthError";
  }
}

export class TeamSyncForbiddenError extends Error {
  constructor(message = "You do not have permission to edit this resource.") {
    super(message);
    this.name = "TeamSyncForbiddenError";
  }
}

export class TeamSyncStaleVersionError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super("Your copy is out of date. Pull the latest version and retry.");
    this.name = "TeamSyncStaleVersionError";
    this.currentVersion = currentVersion;
  }
}

// ---------------------------------------------------------------------
// Path resolution + state I/O
// ---------------------------------------------------------------------

export function sessionStatePath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SESSION_STATE_FILENAME);
}

/** Resolve the yaw.sh base URL. YAW_MCP_TEAM_BASE_URL overrides for
 *  local dev / E2E tests against a Netlify preview deployment. */
function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.YAW_MCP_TEAM_BASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/$/, "") : BASE_URL_DEFAULT;
}

function expMs(session: { exp: number }): number {
  // Tolerate seconds-shaped exp (anything below ~Sep 2001 in ms terms)
  // in case a future server bug or JWT-style payload sneaks in.
  const e = session.exp;
  return e > 0 && e < 1e12 ? e * 1000 : e;
}

let cachedState: { filePath: string; state: StoredState | null } | null = null;

function invalidateState(): void {
  cachedState = null;
}

async function loadStoredState(filePath: string): Promise<StoredState | null> {
  // Only honor the cache when it was populated from the SAME filePath --
  // a process operating on two homes must not cross sessions.
  if (cachedState && cachedState.filePath === filePath) {
    const s = cachedState.state;
    if (s && expMs(s.session) < Date.now()) {
      cachedState = { filePath, state: null };
      return null;
    }
    return s;
  }
  let parsed: StoredState | null;
  try {
    const raw = await readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") parsed = null;
    else if (typeof obj.cookie !== "string" || !obj.cookie) parsed = null;
    else if (!obj.session || typeof obj.session !== "object") parsed = null;
    else parsed = obj as StoredState;
  } catch {
    parsed = null;
  }
  if (parsed && expMs(parsed.session) < Date.now()) {
    cachedState = { filePath, state: null };
    return null;
  }
  cachedState = { filePath, state: parsed };
  return parsed;
}

async function saveStoredState(filePath: string, state: StoredState): Promise<void> {
  cachedState = { filePath, state };
  try {
    await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
    if (process.platform !== "win32") {
      try {
        await chmod(filePath, 0o600);
      } catch {
        // chmod not supported on this filesystem; not fatal.
      }
    }
  } catch (err) {
    log("warn", "Failed to persist team session", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function clearStoredState(filePath: string): Promise<void> {
  invalidateState();
  try {
    if (existsSync(filePath)) await unlink(filePath);
  } catch {
    // already gone or unwritable; cache invalidation is what matters
  }
}

// ---------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------

function parseOneSetCookie(line: string): { name: string; value: string } | null {
  const semi = line.indexOf(";");
  const pair = semi >= 0 ? line.slice(0, semi) : line;
  const eq = pair.indexOf("=");
  if (eq < 1) return null;
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
}

function parseSetCookie(headers: Headers): string | null {
  const getAll = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getAll === "function") {
    for (const line of getAll.call(headers)) {
      const parsed = parseOneSetCookie(line);
      if (parsed && parsed.name === COOKIE_NAME) return parsed.value;
    }
    return null;
  }
  const headerValue = headers.get("set-cookie");
  if (!headerValue) return null;
  const parsed = parseOneSetCookie(headerValue);
  return parsed && parsed.name === COOKIE_NAME ? parsed.value : null;
}

interface HttpOpts {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  cookie?: string;
  baseUrl?: string;
}

async function httpJson<T>(opts: HttpOpts): Promise<{ status: number; body: T; cookie: string | null }> {
  const baseUrl = opts.baseUrl ?? resolveBaseUrl();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = `${COOKIE_NAME}=${opts.cookie}`;
  const res = await fetch(`${baseUrl}${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    body = {} as T;
  }
  const cookie = parseSetCookie(res.headers);
  return { status: res.status, body, cookie };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export interface SignInOpts {
  /** Override the on-disk state path. Defaults to sessionStatePath(home). */
  filePath?: string;
  /** Override homedir (tests). Defaults to os.homedir(). */
  home?: string;
  /** Override base URL (tests, dev). Defaults to YAW_MCP_TEAM_BASE_URL or https://yaw.sh. */
  baseUrl?: string;
}

/** Sign in with a Yaw Team license key. POSTs to
 *  /api/team/session, parses the yaw_team cookie, fetches the session
 *  detail (to learn `exp` and `can_edit`), persists locally. Returns
 *  the resolved session. */
export async function signIn(key: string, opts: SignInOpts = {}): Promise<TeamSession> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("License key is required.");
  const baseUrl = opts.baseUrl;
  const post = await httpJson<{ email?: string; role?: TeamRole; order_id?: string; error?: string }>({
    method: "POST",
    path: "/api/team/session",
    body: { key: trimmed },
    baseUrl,
  });
  if (post.status !== 200 || !post.cookie || !post.body.email || !post.body.role || !post.body.order_id) {
    if (post.body.error) log("warn", "team sign-in failed", { status: post.status, error: post.body.error });
    throw new TeamSyncAuthError("Sign in failed. Check your license key and try again.");
  }
  // Fetch session detail to learn exp + can_edit (the POST response
  // doesn't carry exp; server is source of truth for the TTL).
  const get = await httpJson<TeamSession & { error?: string }>({
    method: "GET",
    path: "/api/team/session",
    cookie: post.cookie,
    baseUrl,
  });
  if (
    get.status !== 200 ||
    !get.body.email ||
    !get.body.role ||
    !get.body.order_id ||
    typeof get.body.exp !== "number"
  ) {
    // Server-side cookie is live but unusable from our side. Best-effort
    // logout so the seat is freed before we surface the auth error.
    await httpJson({ method: "POST", path: "/api/team/session/logout", cookie: post.cookie, baseUrl }).catch(
      () => undefined,
    );
    throw new TeamSyncAuthError("Sign in succeeded but session check failed.");
  }
  const session: TeamSession = {
    email: get.body.email,
    role: get.body.role,
    order_id: get.body.order_id,
    exp: get.body.exp,
    can_edit: get.body.can_edit,
  };
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  await saveStoredState(filePath, { cookie: post.cookie, session });
  return session;
}

export interface BaseOpts {
  filePath?: string;
  home?: string;
  baseUrl?: string;
}

/** Clear the local session. Best-effort server logout. Always clears
 *  the local state file even if the server call fails. */
export async function signOut(opts: BaseOpts = {}): Promise<void> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  if (state) {
    try {
      await httpJson({
        method: "POST",
        path: "/api/team/session/logout",
        cookie: state.cookie,
        baseUrl: opts.baseUrl,
      });
    } catch {
      // best-effort -- local clear is what matters
    }
  }
  await clearStoredState(filePath);
}

/** Returns the cached session if still valid, otherwise null. Does
 *  NOT make a network call -- use this for "am I signed in?" checks
 *  and for the offline-OK gate before sync ops. */
export async function getSession(opts: BaseOpts = {}): Promise<TeamSession | null> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  return state?.session ?? null;
}

/** Fetch a shared resource by name. Returns the standard
 *  TeamResource<T> shape with version=0/data=null when the resource
 *  has never been written. */
export async function getResource<T>(name: string, opts: BaseOpts = {}): Promise<TeamResource<T>> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  if (!state) throw new TeamSyncAuthError();
  const res = await httpJson<TeamResource<T> & { error?: string }>({
    method: "GET",
    path: `/api/team/resource/${encodeURIComponent(name)}`,
    cookie: state.cookie,
    baseUrl: opts.baseUrl,
  });
  if (res.status === 401) {
    await clearStoredState(filePath);
    throw new TeamSyncAuthError();
  }
  if (res.status === 403) throw new TeamSyncForbiddenError();
  if (res.status !== 200) {
    if (res.body.error) log("warn", "team fetch failed", { name, status: res.status, error: res.body.error });
    throw new Error(`Team fetch failed (${res.status}).`);
  }
  return {
    version: res.body.version,
    data: res.body.data,
    updated_at: res.body.updated_at,
    updated_by: res.body.updated_by,
  };
}

/** Write a shared resource. Pass the `version` you last saw -- if it
 *  is stale, throws TeamSyncStaleVersionError with the current server
 *  version so the caller can re-pull, merge, and retry. */
export async function putResource<T>(
  name: string,
  version: number,
  data: T,
  opts: BaseOpts = {},
): Promise<TeamResource<T>> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  if (!state) throw new TeamSyncAuthError();
  const res = await httpJson<TeamResource<T> & { error?: string; current_version?: number }>({
    method: "PUT",
    path: `/api/team/resource/${encodeURIComponent(name)}`,
    body: { version, data },
    cookie: state.cookie,
    baseUrl: opts.baseUrl,
  });
  if (res.status === 401) {
    await clearStoredState(filePath);
    throw new TeamSyncAuthError();
  }
  if (res.status === 403) throw new TeamSyncForbiddenError();
  if (res.status === 409) throw new TeamSyncStaleVersionError(res.body.current_version ?? 0);
  if (res.status !== 200) {
    if (res.body.error) log("warn", "team write failed", { name, status: res.status, error: res.body.error });
    throw new Error(`Team write failed (${res.status}).`);
  }
  return {
    version: res.body.version,
    data: res.body.data,
    updated_at: res.body.updated_at,
    updated_by: res.body.updated_by,
  };
}

// ---------------------------------------------------------------------
// Analytics (Yaw Team): mcp_analytics endpoint
// ---------------------------------------------------------------------

export interface AnalyticsEvent {
  /** Server-assigned on POST. Read-only on GET. */
  ts: number;
  /** Server-assigned on POST. */
  seat_email: string;
  tool_namespace: string;
  tool_name: string;
  status: "success" | "error";
  latency_ms?: number;
  error_category?: string;
  client_name?: string;
  client_version?: string;
}

export interface AnalyticsList {
  events: AnalyticsEvent[];
  cap: number;
  order_id: string;
}

/** POST a single analytics event to the team-analytics endpoint.
 *  Server stamps `ts` + `seat_email` from the session -- client-supplied
 *  values are ignored. Returns immediately on auth failure (treats
 *  401 as "Free user, no telemetry" rather than throwing). */
export async function postAnalyticsEvent(
  event: Omit<AnalyticsEvent, "ts" | "seat_email">,
  opts: BaseOpts = {},
): Promise<{ ok: boolean }> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  if (!state) return { ok: false };
  const res = await httpJson<{ ok?: boolean; ts?: number; error?: string }>({
    method: "POST",
    path: "/api/team/analytics/event",
    body: event,
    cookie: state.cookie,
    baseUrl: opts.baseUrl,
  });
  if (res.status === 401) {
    // Analytics is fire-and-forget and is never authoritative for session
    // validity.  A 401 here could be a transient server-side token refresh;
    // clearing the stored state would silently log the user out mid-workflow.
    // Session-expiry detection is the responsibility of the explicit
    // getSession() paths (getResource, putResource, listAnalyticsEvents).
    return { ok: false };
  }
  return { ok: res.status === 200 };
}

/** GET the recent analytics events for the current order. Throws on
 *  auth failure (caller is `yaw-mcp stats` which surfaces a clear
 *  "sign in first" message). */
export async function listAnalyticsEvents(opts: BaseOpts = {}): Promise<AnalyticsList> {
  const filePath = opts.filePath ?? sessionStatePath(opts.home);
  const state = await loadStoredState(filePath);
  if (!state) throw new TeamSyncAuthError();
  const res = await httpJson<AnalyticsList & { error?: string }>({
    method: "GET",
    path: "/api/team/analytics",
    cookie: state.cookie,
    baseUrl: opts.baseUrl,
  });
  if (res.status === 401) {
    await clearStoredState(filePath);
    throw new TeamSyncAuthError();
  }
  if (res.status !== 200) {
    if (res.body.error) log("warn", "team analytics list failed", { status: res.status, error: res.body.error });
    throw new Error(`Team analytics fetch failed (${res.status}).`);
  }
  return { events: res.body.events ?? [], cap: res.body.cap ?? 0, order_id: res.body.order_id ?? "" };
}

/** Return the raw yaw_team cookie value from the in-memory cache.
 *  Callers that have already called getSession() pay nothing extra --
 *  the state is cached at module scope and this is a synchronous read
 *  of that same slot.  Returns null when no valid session exists. */
export function getCachedCookie(home: string = homedir()): string | null {
  // cachedState is populated by any prior loadStoredState() call (which
  // getSession, getResource, putResource, etc. all trigger).  If the
  // session is valid the slot is non-null; if expired or absent it is
  // { state: null }.  Either way no disk I/O.
  void home; // the in-process cache is process-global; home is unused here
  const s = cachedState?.state ?? null;
  return s ? s.cookie : null;
}

/** Test-only: reset module-scoped state caches. */
export function _resetForTests(): void {
  invalidateState();
}
