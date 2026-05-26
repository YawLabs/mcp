import { request } from "undici";
import { log } from "./logger.js";
import { getSession } from "./team-sync.js";

// Stage-2 rerank client. BM25 narrows the field locally; this service
// call asks the rerank backend to embed the intent (Voyage voyage-3-
// lite) and cosine-sort the shortlist against precomputed server
// embeddings. Fails silently by returning null -- callers stay with
// the BM25 order when rerank is unavailable. Rerank is an optimization,
// not a requirement.
//
// Two backend paths in this build:
//
//   Path A (preferred):  yaw.sh `/api/team/rerank`, authed via the
//                        yaw_team cookie.  Pro / Yaw Team buyers
//                        get rerank automatically once signed in.
//                        Document embeddings are precomputed at
//                        catalog-export time and shipped inside the
//                        Netlify Function bundle.
//
//   Path B (legacy):     mcp.hosting `/api/connect/rerank`, authed
//                        via MCPH_TOKEN/YAW_MCP_TOKEN. Retained as a
//                        fallback for the account-mode users that
//                        haven't yet migrated to the new cookie. Will
//                        be removed when Phase 9c (EKS sunset) lands.
//
// Free users skip both paths entirely (no session, no token).

const RERANK_TIMEOUT_MS = 2_000;

const DEFAULT_TEAM_BASE_URL = "https://yaw.sh";

// Path-B (legacy mcp.hosting) state. Set by initRerank() during
// ConnectServer.start() when an MCPH_TOKEN is resolved.
let legacyApiUrl = "";
let legacyToken = "";

export function initRerank(url: string, tok: string): void {
  legacyApiUrl = url;
  legacyToken = tok;
}

export interface RerankResult {
  id: string;
  score: number;
}

// Ask the backend to rerank the candidate server ids by semantic
// similarity to the intent. Returns null when rerank is unavailable
// (no auth available, vectors not yet embedded, timeout, any non-2xx)
// so the caller can stick with BM25 without ceremony.
//
// `candidateIds` is optional. When omitted, the backend runs the
// rerank over the entire catalog -- used by discover to surface
// semantically-relevant servers the user hasn't activated yet,
// without BM25 having to shortlist first.
export async function rerank(intent: string, candidateIds?: string[], limit?: number): Promise<RerankResult[] | null> {
  if (!intent?.trim()) return null;
  // Treat "empty array provided" as "caller has no BM25 shortlist to
  // narrow against" -- same fallback as no-array. Only skip the call
  // when the caller explicitly opted into shortlist mode with zero ids.
  if (candidateIds !== undefined && candidateIds.length === 0) return null;

  const payload: { intent: string; candidateIds?: string[]; limit?: number } = { intent: intent.trim() };
  if (candidateIds && candidateIds.length > 0) payload.candidateIds = candidateIds;
  if (typeof limit === "number" && limit > 0) payload.limit = limit;

  // Path A: try the yaw.sh team-rerank endpoint first when a team
  // session exists. getSession() is cheap after the first load
  // (module-scoped cache in team-sync.ts).
  const session = await getSession().catch(() => null);
  if (session) {
    const result = await callTeamRerank(payload);
    if (result !== null) return result;
    // null from Path A means "Voyage unavailable" or transient
    // failure. Don't try Path B in that case -- a Pro user signed
    // in with the team cookie shouldn't be reaching back at the
    // legacy MCPH_TOKEN endpoint.
    return null;
  }

  // Path B: legacy MCPH_TOKEN-authed endpoint. Used only by account-
  // mode users on the legacy mcp.hosting backend.
  if (!legacyApiUrl || !legacyToken) return null;
  return callLegacyRerank(payload);
}

async function callTeamRerank(payload: {
  intent: string;
  candidateIds?: string[];
  limit?: number;
}): Promise<RerankResult[] | null> {
  const base = (process.env.YAW_MCP_TEAM_BASE_URL?.replace(/\/$/, "") || DEFAULT_TEAM_BASE_URL).replace(/\/$/, "");
  // Read the cookie from the team-sync session state. Best-effort: if
  // the file isn't there or the cookie isn't loaded, fall through to
  // null (caller falls back to BM25). We import team-sync's internal
  // path resolver to avoid a separate read-state ceremony.
  const cookie = await readTeamCookie();
  if (!cookie) return null;
  try {
    const res = await request(`${base}/api/team/rerank`, {
      method: "POST",
      headers: {
        Cookie: `yaw_team=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      headersTimeout: RERANK_TIMEOUT_MS,
      bodyTimeout: RERANK_TIMEOUT_MS,
    });
    if (res.statusCode === 503) {
      await res.body.text().catch(() => {});
      return null; // rerank unavailable on backend (no Voyage key)
    }
    if (res.statusCode === 401) {
      await res.body.text().catch(() => {});
      log("debug", "team-rerank 401; session likely expired", {});
      return null;
    }
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => {});
      log("warn", "team-rerank request failed", { status: res.statusCode });
      return null;
    }
    const body = (await res.body.json()) as { results?: RerankResult[] };
    if (!body || !Array.isArray(body.results)) return null;
    if (body.results.length === 0) return null;
    return body.results;
  } catch (err: unknown) {
    log("debug", "team-rerank request errored", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function callLegacyRerank(payload: {
  intent: string;
  candidateIds?: string[];
  limit?: number;
}): Promise<RerankResult[] | null> {
  try {
    const res = await request(`${legacyApiUrl.replace(/\/$/, "")}/api/connect/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${legacyToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      headersTimeout: RERANK_TIMEOUT_MS,
      bodyTimeout: RERANK_TIMEOUT_MS,
    });
    if (res.statusCode === 503) {
      await res.body.text().catch(() => {});
      return null;
    }
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => {});
      log("warn", "Rerank request failed", { status: res.statusCode });
      return null;
    }
    const body = (await res.body.json()) as { results?: RerankResult[]; reason?: string };
    if (!body || !Array.isArray(body.results)) return null;
    if (body.results.length === 0) return null;
    return body.results;
  } catch (err: unknown) {
    log("debug", "Rerank request errored", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Read the yaw_team cookie value from the local team-sync state file.
 *  Returns null when no session exists. Cheap: team-sync.ts has a
 *  module-scoped memo of the parsed state, so this is a no-op after
 *  the first call. */
async function readTeamCookie(): Promise<string | null> {
  // Lazy-import to avoid a hard dep cycle (team-sync imports from
  // atomic-write, logger, paths -- not rerank).
  const teamSync = await import("./team-sync.js");
  // _resetForTests is the only exported test hook; we don't need it.
  // Use getSession() to ensure the cookie state is loaded, then read
  // the cookie field via a tiny re-load.  team-sync caches both.
  const session = await teamSync.getSession();
  if (!session) return null;
  // We can't read the cookie out of getSession() (which returns the
  // TeamSession only, not the cookie). Read the state file directly
  // via the same path team-sync.ts uses.
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(teamSync.sessionStatePath(), "utf8");
    const parsed = JSON.parse(raw) as { cookie?: string };
    return typeof parsed.cookie === "string" && parsed.cookie ? parsed.cookie : null;
  } catch {
    return null;
  }
}
