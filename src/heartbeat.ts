import { request } from "undici";
import { shouldSendBearer } from "./analytics.js";
import { log } from "./logger.js";

// POST /api/connect/heartbeat — fires when an MCP client (Claude Code,
// Cursor, Claude Desktop, VS Code, ...) attaches to yaw-mcp via stdio and
// sends an `initialize` request. Lets Yaw MCP tell apart
// "yaw-mcp polling standalone" (CLI started, no AI client wired) from
// "AI client driving yaw-mcp" (the wiring step is done) — the gap between
// stage 4 and stage 5 in the activation funnel.
//
// Two call sites, distinguished by `isRefresh`:
//   - Attach beacon (isRefresh false): fires once per yaw-mcp process on
//     the FIRST `initialize`. The backend increments initialize_count.
//   - Liveness refresh (isRefresh true): fires on every config-poll
//     cycle (~60s) for as long as a client stays attached. The backend
//     bumps last_seen_at only, leaving initialize_count alone. This is
//     what keeps the dashboard's 3-minute "AI client connected" window
//     satisfied for the life of the session; without it the badge
//     reverts to "no AI client connected" ~3 min in.
// The backend upsert's COALESCE keeps repeated calls safe.
//
// Fail-open everywhere: network errors, 4xx (e.g., 404 on older
// Yaw MCP deploys), or absence of init credentials all silently
// no-op. The CLI never blocks on this — telemetry, not control flow.

const HEARTBEAT_PATH = "/api/connect/heartbeat";

let apiUrl = "";
let token = "";
// Last logged 4xx status (excluding 404) and last network-error
// message. Suppress re-logs while the same failure persists across the
// per-poll refresh cycle (~60s) -- a revoked token or offline
// workstation would otherwise produce a warn line every minute for the
// life of the process. Reset on status/message change (re-logs once)
// and on success.
let lastLoggedFailureStatus: number | null = null;
let lastLoggedErrorMessage: string | null = null;
// One-shot latch for the "skipped bearer over http://" warning so the
// operator sees the misconfiguration once per process rather than every
// 60s on each refresh. Reset by initHeartbeat() when the URL changes.
let warnedInsecureBearerSkip = false;

export function initHeartbeat(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
  lastLoggedFailureStatus = null;
  lastLoggedErrorMessage = null;
  warnedInsecureBearerSkip = false;
}

/**
 * `onInsecure` handler for the shared shouldSendBearer predicate (see
 * analytics.ts -- one implementation of the "is this URL safe to put the
 * account token on" rule for every background poster). This side owns only
 * the heartbeat-specific warn text and its one-shot latch.
 *
 * A malformed URL does not reach here: shouldSendBearer returns false for
 * it without calling back, so garbage still fails at the transport layer
 * with its usual error and never gets a bearer attached.
 */
function warnInsecureBearerSkip(targetUrl: string): void {
  if (warnedInsecureBearerSkip) return;
  log(
    "warn",
    "Heartbeat URL is not https and not loopback; sending without Authorization header to avoid leaking the bearer token",
    { url: targetUrl },
  );
  warnedInsecureBearerSkip = true;
}

export async function reportHeartbeat(
  clientName: string | undefined,
  clientVersion: string | undefined,
  // false = one-shot attach beacon (on `initialize`); true = periodic
  // liveness refresh (on each config poll). See the file header.
  isRefresh = false,
): Promise<void> {
  if (!apiUrl || !token) return;
  try {
    const fullUrl = `${apiUrl.replace(/\/$/, "")}${HEARTBEAT_PATH}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (shouldSendBearer(fullUrl, warnInsecureBearerSkip)) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await request(fullUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Pass through whatever the AI client self-reported. Backend
        // normalizes (fallback to 'unknown', length caps) — keep this
        // side dumb so a backend tightening doesn't need a CLI roll.
        clientName: clientName ?? null,
        clientVersion: clientVersion ?? null,
        isRefresh,
      }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    await res.body.text().catch(() => {});
    if (res.statusCode >= 400 && res.statusCode !== 404) {
      if (lastLoggedFailureStatus !== res.statusCode) {
        log("warn", "Heartbeat failed", { status: res.statusCode, isRefresh });
        lastLoggedFailureStatus = res.statusCode;
      }
    } else {
      // Success or 404 (older deploy). Either way the sticky failure
      // -- if any -- has cleared; re-arm both latches.
      lastLoggedFailureStatus = null;
      lastLoggedErrorMessage = null;
      if (!isRefresh) {
        // Only the once-per-process attach beacon is logged. The refresh
        // ping fires on every config poll (~60s); logging each would spam.
        log("info", "Reported AI client connect to Yaw MCP", {
          clientName: clientName ?? null,
          clientVersion: clientVersion ?? null,
        });
      }
    }
  } catch (err: any) {
    const errMsg = err?.message ?? "unknown error";
    if (lastLoggedErrorMessage !== errMsg) {
      log("warn", "Heartbeat error", { error: errMsg, isRefresh });
      lastLoggedErrorMessage = errMsg;
    }
  }
}
