// `yaw-mcp stats` -- print a digest of the AI tool calls the team-
// analytics endpoint has recorded for the current account. Pro-only:
// Free users (no team session) get an upsell pointer instead.
//
// Phase 5a ships read-only; runtime event-emission from the proxy
// layer is Phase 5b. Until that wires up, the events list will be
// empty for new buyers -- the command still works, it just shows
// "no events recorded yet".

import { homedir } from "node:os";
import { type AnalyticsEvent, TeamSyncAuthError, getSession, listAnalyticsEvents } from "./team-sync.js";

export const STATS_USAGE = `Usage: yaw-mcp stats [--json] [--limit N] [--days N]

  Print a digest of recent AI tool calls recorded against your Yaw MCP
  Pro or Yaw Business account.

  --limit N   Show the most recent N events (default 50, max 1000).
  --days N    Restrict to events from the last N days (default 7).
  --json      Emit machine-readable JSON (the full event list + summary).

  Requires sign-in: \`yaw-mcp login --key <license-key>\`. Free users
  get a pointer to Pro instead -- analytics requires an account.`;

export interface StatsCommandOptions {
  limit?: number;
  days?: number;
  json?: boolean;
  /** Test hooks. */
  home?: string;
  baseUrl?: string;
}

export function parseStatsArgs(
  argv: string[],
): { ok: true; options: StatsCommandOptions } | { ok: false; error: string } {
  const opts: StatsCommandOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isFinite(n) || n <= 0 || n > 1000)
        return { ok: false, error: "yaw-mcp stats: --limit must be a positive integer up to 1000\n\n" + STATS_USAGE };
      opts.limit = n;
    } else if (a === "--days") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isFinite(n) || n <= 0 || n > 365)
        return { ok: false, error: "yaw-mcp stats: --days must be a positive integer up to 365\n\n" + STATS_USAGE };
      opts.days = n;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: STATS_USAGE };
    } else {
      return { ok: false, error: `yaw-mcp stats: unknown argument "${a}"\n\n${STATS_USAGE}` };
    }
  }
  return { ok: true, options: opts };
}

export interface StatsCommandResult {
  exitCode: number;
}

interface NamespaceAggregate {
  namespace: string;
  total: number;
  success: number;
  errors: number;
  /** Average latency across events that reported one. */
  avgLatencyMs: number | null;
}

interface ClientAggregate {
  client: string;
  total: number;
}

function aggregate(events: AnalyticsEvent[]): {
  byNamespace: NamespaceAggregate[];
  byClient: ClientAggregate[];
} {
  const ns = new Map<string, { total: number; success: number; errors: number; latSum: number; latCount: number }>();
  const clients = new Map<string, number>();
  for (const e of events) {
    let n = ns.get(e.tool_namespace);
    if (!n) {
      n = { total: 0, success: 0, errors: 0, latSum: 0, latCount: 0 };
      ns.set(e.tool_namespace, n);
    }
    n.total++;
    if (e.status === "success") n.success++;
    else n.errors++;
    if (typeof e.latency_ms === "number") {
      n.latSum += e.latency_ms;
      n.latCount++;
    }
    const clientKey = e.client_name ? `${e.client_name}${e.client_version ? ` ${e.client_version}` : ""}` : "(unknown)";
    clients.set(clientKey, (clients.get(clientKey) ?? 0) + 1);
  }
  const byNamespace = [...ns.entries()]
    .map(([namespace, n]) => ({
      namespace,
      total: n.total,
      success: n.success,
      errors: n.errors,
      avgLatencyMs: n.latCount > 0 ? Math.round(n.latSum / n.latCount) : null,
    }))
    .sort((a, b) => b.total - a.total);
  const byClient = [...clients.entries()]
    .map(([client, total]) => ({ client, total }))
    .sort((a, b) => b.total - a.total);
  return { byNamespace, byClient };
}

function formatPlain(events: AnalyticsEvent[], opts: StatsCommandOptions, orderId: string, total: number): string {
  const lines: string[] = [];
  lines.push(`Signed in to order ${orderId}.`);
  lines.push(
    `Showing ${events.length} of ${total} event${total === 1 ? "" : "s"} from the last ${opts.days ?? 7} day${opts.days === 1 ? "" : "s"}.`,
  );
  if (events.length === 0) {
    lines.push("");
    lines.push("No events recorded yet for this window. Runtime event emission ships in Phase 5b -- until then,");
    lines.push("only events explicitly POSTed via `yaw-mcp` will appear here.");
    return `${lines.join("\n")}\n`;
  }
  const agg = aggregate(events);

  lines.push("");
  lines.push("By server:");
  const nsCol = Math.max(...agg.byNamespace.map((n) => n.namespace.length), 6);
  for (const n of agg.byNamespace) {
    const success = n.success.toString().padStart(5);
    const errors = n.errors.toString().padStart(5);
    const lat = n.avgLatencyMs === null ? "      -" : `${n.avgLatencyMs}ms`.padStart(7);
    lines.push(
      `  ${n.namespace.padEnd(nsCol)}  ${n.total.toString().padStart(5)} calls  ok ${success}  err ${errors}  ${lat} avg`,
    );
  }

  lines.push("");
  lines.push("By AI client:");
  for (const c of agg.byClient) {
    lines.push(`  ${c.client.padEnd(24)}  ${c.total} calls`);
  }

  lines.push("");
  lines.push("Recent events (newest first):");
  const recent = events.slice(-Math.min(events.length, opts.limit ?? 50)).reverse();
  for (const e of recent) {
    const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
    const tag = e.status === "success" ? "ok " : "ERR";
    const lat = typeof e.latency_ms === "number" ? `${e.latency_ms}ms` : "-";
    lines.push(`  ${when}  ${tag}  ${e.tool_namespace}.${e.tool_name}  ${lat}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runStats(
  opts: StatsCommandOptions,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<StatsCommandResult> {
  const home = opts.home ?? homedir();
  const session = await getSession({ home, baseUrl: opts.baseUrl });
  if (!session) {
    const msg =
      "Not signed in. Yaw MCP analytics requires a Pro or Yaw Business account.\n" +
      "  - Pro: $9/mo or $90/yr -- https://yaw.sh/mcp#pricing\n" +
      "  - Yaw Business: $10/seat/mo (includes Yaw Terminal Business)\n" +
      "Sign in with: yaw-mcp login --key <license-key>";
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: "Not signed in.", upsell: msg })}\n`);
    else io.err(`yaw-mcp stats: ${msg}\n`);
    return { exitCode: 1 };
  }

  try {
    const result = await listAnalyticsEvents({ home, baseUrl: opts.baseUrl });
    const days = opts.days ?? 7;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const filtered = result.events.filter((e) => e.ts >= cutoff);

    if (opts.json) {
      io.out(
        `${JSON.stringify(
          {
            order_id: result.order_id,
            seat_email: session.email,
            role: session.role,
            window_days: days,
            event_count: filtered.length,
            total_events_stored: result.events.length,
            cap: result.cap,
            events: filtered.slice(-Math.min(filtered.length, opts.limit ?? 50)),
            aggregates: aggregate(filtered),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out(formatPlain(filtered, opts, result.order_id, filtered.length));
    }
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof TeamSyncAuthError) {
      const msg = "Session expired or revoked. Run `yaw-mcp login --key <license-key>` again.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp stats: ${msg}\n`);
      return { exitCode: 1 };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: message })}\n`);
    else io.err(`yaw-mcp stats: ${message}\n`);
    return { exitCode: 1 };
  }
}
