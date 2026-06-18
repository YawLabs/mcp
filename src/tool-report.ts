import { request } from "undici";
import { log } from "./logger.js";

// Reports the tool list a server exposed on first activation back to
// Yaw MCP so the BM25 ranker can score inactive servers on cold
// starts. Fire-and-forget: failures are logged and swallowed because
// missing cache data only degrades ranking quality, it doesn't break
// any user-visible flow.
//
// Tolerates a 404 from the backend so older Yaw MCP deployments
// that don't ship this endpoint stay usable with the new yaw-mcp client.

let apiUrl = "";
let token = "";

// Per-server latch capturing the most recent rejection from the
// dashboard so `yaw-mcp doctor` can surface lost-write-scope (e.g., a
// rotated token) instead of letting the failure rot silently in the
// logger. Cleared on the next successful (2xx) post for that server --
// a transient 4xx must not pollute doctor output forever. Keyed by
// serverId so concurrent activations for different servers don't race
// on a shared single slot. Diagnostic-only: never POSTed back to the
// dashboard.
export interface ReportFailure {
  statusCode: number;
  url: string;
  at: number;
}
const lastFailureByServer = new Map<string, ReportFailure>();

export function getLastReportFailure(serverId?: string): ReportFailure | null {
  if (serverId !== undefined) return lastFailureByServer.get(serverId) ?? null;
  // Legacy: return any failure when no serverId specified (e.g. doctor).
  const entries = [...lastFailureByServer.values()];
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (a.at >= b.at ? a : b));
}

export function initToolReport(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
}

export async function reportTools(
  serverId: string,
  tools: Array<{ name: string; description?: string }>,
): Promise<void> {
  if (!apiUrl || !token || !serverId) return;
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/servers/${encodeURIComponent(serverId)}/tools`;
  try {
    const res = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tools }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    // Drain body so the connection can be reused
    await res.body.text().catch(() => {});
    // 404 is expected on Yaw MCP deployments predating this endpoint —
    // skip the warn to keep logs clean. Any other non-2xx is genuine.
    if (res.statusCode >= 400 && res.statusCode !== 404) {
      log("warn", "Tool report failed", { serverId, status: res.statusCode });
      lastFailureByServer.set(serverId, { statusCode: res.statusCode, url, at: Date.now() });
    } else {
      // Clear the latch on success or expected 404 so an old failure
      // doesn't linger after the dashboard recovers (e.g., user
      // re-issued the token). 404 = pre-endpoint deployment, not a
      // real auth failure, so it must not keep doctor reporting broken.
      lastFailureByServer.delete(serverId);
    }
  } catch (err: any) {
    log("warn", "Tool report error", { serverId, error: err?.message });
    // Network-level failures (ECONNREFUSED, timeout, DNS) never produce
    // an HTTP status, so statusCode 0 signals a transport error to doctor.
    lastFailureByServer.set(serverId, { statusCode: 0, url, at: Date.now() });
  }
}
