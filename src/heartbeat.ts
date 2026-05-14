import { request } from "undici";
import { log } from "./logger.js";

// POST /api/connect/heartbeat — fires when an MCP client (Claude Code,
// Cursor, Claude Desktop, VS Code, ...) attaches to mcph via stdio and
// sends an `initialize` request. Lets mcp.hosting tell apart
// "mcph polling standalone" (CLI started, no AI client wired) from
// "AI client driving mcph" (the wiring step is done) — the gap between
// stage 4 and stage 5 in the activation funnel.
//
// Fires once per mcph process, on the FIRST initialize. Subsequent
// initialize calls only happen if the AI client restarts the stdio
// transport without respawning mcph, which is rare; the backend
// upsert's COALESCE keeps it safe to call multiple times anyway.
//
// Fail-open everywhere: network errors, 4xx (e.g., 404 on older
// mcp.hosting deploys), or absence of init credentials all silently
// no-op. The CLI never blocks on this — telemetry, not control flow.

const HEARTBEAT_PATH = "/api/connect/heartbeat";

let apiUrl = "";
let token = "";

export function initHeartbeat(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
}

export async function reportHeartbeat(
  clientName: string | undefined,
  clientVersion: string | undefined,
): Promise<void> {
  if (!apiUrl || !token) return;
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}${HEARTBEAT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Pass through whatever the AI client self-reported. Backend
        // normalizes (fallback to 'unknown', length caps) — keep this
        // side dumb so a backend tightening doesn't need a CLI roll.
        clientName: clientName ?? null,
        clientVersion: clientVersion ?? null,
      }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    await res.body.text().catch(() => {});
    if (res.statusCode >= 400 && res.statusCode !== 404) {
      log("warn", "Heartbeat failed", { status: res.statusCode });
    } else {
      log("info", "Reported AI client connect to mcp.hosting", {
        clientName: clientName ?? null,
        clientVersion: clientVersion ?? null,
      });
    }
  } catch (err: any) {
    log("warn", "Heartbeat error", { error: err?.message });
  }
}
