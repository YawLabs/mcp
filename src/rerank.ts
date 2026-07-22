import { request } from "undici";
import { log } from "./logger.js";

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
//                        yaw_team cookie.  Yaw Team buyers
//                        get rerank automatically once signed in.
//                        Document embeddings are precomputed at
//                        catalog-export time and shipped inside the
//                        Netlify Function bundle.
//
//   Path B (legacy):     Yaw MCP `/api/connect/rerank`, authed
//                        via MCPH_TOKEN/YAW_MCP_TOKEN. Retained as a
//                        fallback for the account-mode users that
//                        haven't yet migrated to the new cookie. Will
//                        be removed when Phase 9c (EKS sunset) lands.
//
// Free users skip both paths entirely (no session, no token).

const RERANK_TIMEOUT_MS = 2_000;

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
  // Three-state contract for `candidateIds` -- pass the right shape:
  //   undefined    -> rerank the WHOLE catalog (discover's wide mode).
  //   [] (empty)   -> skip; returns null (NOT "rerank everything").
  //   non-empty    -> rerank only this shortlist.
  // A caller wanting whole-catalog rerank must OMIT candidateIds, never
  // pass []. Treat "empty array provided" as "caller has no BM25
  // shortlist to narrow against" -- same fallback as no-array.
  if (candidateIds !== undefined && candidateIds.length === 0) return null;

  const payload: { intent: string; candidateIds?: string[]; limit?: number } = { intent: intent.trim() };
  if (candidateIds && candidateIds.length > 0) payload.candidateIds = candidateIds;
  if (typeof limit === "number" && limit > 0) payload.limit = limit;

  // The yaw.sh team-rerank path was removed with the Yaw Team surface
  // (2026-07-21). The legacy MCPH_TOKEN-authed endpoint is now the only
  // transport; without it the caller falls back to BM25.
  if (!legacyApiUrl || !legacyToken) return null;
  return callLegacyRerank(payload);
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
    const body = (await res.body.json()) as { results?: RerankResult[] };
    if (!body || !Array.isArray(body.results)) return null;
    if (body.results.length === 0) return null;
    return body.results;
  } catch (err: unknown) {
    log("debug", "Rerank request errored", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
