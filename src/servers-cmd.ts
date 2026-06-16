// `yaw-mcp servers` — lists the servers configured for this account in the
// Yaw MCP dashboard (i.e., what `/api/connect/config` returns right
// now). Complements `yaw-mcp doctor`, which only reads local state (config
// files, clients, state.json). Together they give the full picture:
//   doctor   → "what does my local machine look like?"
//   servers  → "what does the backend think I have?"
//
// Common uses:
//   - Sanity-check the dashboard after editing: did my add/remove take?
//   - Support tickets: paste `yaw-mcp servers --json` output for diagnosis.
//   - Scripts: pick one up-front so `yaw-mcp compliance <target>` or
//     `yaw-mcp install <client>` can feed a chosen namespace in a pipeline.
//
// Exit codes:
//   0  listed successfully
//   1  no token resolved (same signal as `yaw-mcp` with no token)
//   2  fetch failed (network, auth rejected, non-2xx response)

import { ConfigError, fetchConfig } from "./config.js";
import { loadYawMcpConfig } from "./config-loader.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import type { ConnectConfig } from "./types.js";

export interface ServersCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Emit JSON instead of a human-readable table. */
  json?: boolean;
  /**
   * Case-insensitive substring filter on namespace. When set, only servers
   * whose namespace contains this string are rendered. `yaw-mcp servers git`
   * matches both `github` and `gitlab`. Missing ⇒ no filter (show all).
   */
  filter?: string;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. */
  err?: (s: string) => void;
  /** Test hook: skip the real backend call. */
  fetcher?: (apiBase: string, token: string) => Promise<ConnectConfig | null>;
  /** Test hook: supply a grade cache instead of reading ~/.yaw-mcp/grades.json. */
  gradesReader?: (home?: string) => Promise<GradesCache>;
}

export interface ServersCommandResult {
  exitCode: number;
  /** Lines printed (stdout + stderr interleaved) — exposed for tests. */
  lines: string[];
}

export interface ParsedServersArgs {
  json: boolean;
  filter?: string;
}

// Split out so index.ts can validate `yaw-mcp servers <typo>` early and
// emit a usage error instead of silently ignoring unknown flags.
export function parseServersArgs(
  argv: string[],
): { ok: true; options: ParsedServersArgs } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let filter: string | undefined;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: SERVERS_USAGE, help: true };
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp servers: unknown argument "${a}"\n\n${SERVERS_USAGE}` };
    } else if (filter === undefined) {
      filter = a;
    } else {
      return { ok: false, error: `yaw-mcp servers: unexpected extra argument "${a}"\n\n${SERVERS_USAGE}` };
    }
  }
  return { ok: true, options: { json, ...(filter !== undefined ? { filter } : {}) } };
}

export const SERVERS_USAGE = `Usage: yaw-mcp servers [<namespace-filter>] [--json]

  List the servers configured in your yaw.sh/mcp dashboard.

  <namespace-filter>   Case-insensitive substring filter on namespace (e.g.,
                       \`yaw-mcp servers git\` matches github + gitlab).
  --json               Emit machine-readable JSON instead of a table.`;

export async function runServersCommand(opts: ServersCommandOptions = {}): Promise<ServersCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const config = await loadYawMcpConfig({
    cwd: opts.cwd,
    home: opts.home,
    env: opts.env,
  });

  if (!config.token) {
    printErr(
      "yaw-mcp servers: no token resolved. Run `yaw-mcp install <client> --token mcp_pat_…` or set YAW_MCP_TOKEN.",
    );
    return { exitCode: 1, lines };
  }

  const fetcher = opts.fetcher ?? fetchConfig;

  let backend: ConnectConfig | null;
  try {
    // Always pass undefined for currentVersion so we get a 200 with full
    // body, not a 304. `yaw-mcp servers` is a user-interactive command —
    // caching on an etag would just mean "stale output" with no way to
    // refresh, which is surprising.
    backend = await fetcher(config.apiBase, config.token);
  } catch (err) {
    const msg = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    printErr(`yaw-mcp servers: ${msg}`);
    return { exitCode: 2, lines };
  }

  // fetchConfig returns null on a 304 — we only expect that when a
  // currentVersion was passed, so this branch shouldn't fire. Defensive
  // handling: treat null the same as an empty response and fall through.
  if (!backend) {
    printErr("yaw-mcp servers: backend returned no data (unexpected 304).");
    return { exitCode: 2, lines };
  }

  // Apply the namespace filter (case-insensitive substring match on
  // namespace) to both JSON and table output so the two surfaces agree.
  // Filter applied AFTER the fetch so a filter that matches nothing
  // prints an explanatory "no matches" message instead of looking like
  // the account has no servers.
  const filtered = opts.filter
    ? {
        ...backend,
        servers: backend.servers.filter((s) => s.namespace.toLowerCase().includes(opts.filter!.toLowerCase())),
      }
    : backend;

  // Overlay locally-cached compliance grades from `yaw-mcp audit` onto each
  // row. A freshly-audited grade in ~/.yaw-mcp/grades.json is more current
  // than whatever the backend last computed, so it wins; servers with no
  // cached grade keep the backend's complianceGrade (which may itself be
  // absent). readGradesCache never throws -- a missing/garbled cache just
  // means no overlay. This runs for BOTH json and table output so the two
  // surfaces (and the MCP panel, which consumes `servers --json`) agree.
  const gradesReader = opts.gradesReader ?? readGradesCache;
  const grades = await gradesReader(opts.home).catch(() => ({}) as GradesCache);
  const merged: ConnectConfig = {
    ...filtered,
    servers: filtered.servers.map((s) => {
      const cached = grades[s.namespace];
      return cached ? { ...s, complianceGrade: cached.grade } : s;
    }),
  };

  if (opts.json) {
    // Echo the active filter (if any) and whether it matched, so a script
    // consuming `servers --json` can distinguish "filter matched nothing"
    // (filter set, filterMatched=false) from "account has no servers"
    // (filter null) -- the table branch already explains this in prose.
    const payload = {
      ...merged,
      filter: opts.filter ?? null,
      filterMatched: opts.filter ? merged.servers.length > 0 : null,
    };
    print(JSON.stringify(payload, null, 2));
    return { exitCode: 0, lines };
  }

  if (opts.filter && filtered.servers.length === 0) {
    print(`No servers match "${opts.filter}". Run \`yaw-mcp servers\` to see the full list.`);
    return { exitCode: 0, lines };
  }

  renderTable(merged, print);
  return { exitCode: 0, lines };
}

function renderTable(cfg: ConnectConfig, print: (s?: string) => void): void {
  const servers = cfg.servers;
  if (servers.length === 0) {
    print("No servers configured yet. Visit https://yaw.sh/mcp to add one.");
    return;
  }

  // Short config-version slug in the header — full SHA is noisy and
  // users rarely need it. The doctor STATE section shows the file path
  // for anyone who wants raw details.
  const version = cfg.configVersion ? ` (config ${truncateVersion(cfg.configVersion)})` : "";
  const active = servers.filter((s) => s.isActive).length;
  const disabled = servers.length - active;
  const summary =
    disabled === 0
      ? `${servers.length} server${servers.length === 1 ? "" : "s"}`
      : `${servers.length} servers (${active} enabled, ${disabled} disabled)`;
  print(`${summary}${version}`);
  print("");

  const rows = servers.map((s) => ({
    namespace: s.namespace,
    name: s.name,
    type: s.type,
    status: s.isActive ? "enabled" : "disabled",
    grade: s.complianceGrade ?? "-",
    tools: s.toolCache ? String(s.toolCache.length) : "?",
  }));

  const widths = {
    namespace: Math.max("NAMESPACE".length, ...rows.map((r) => r.namespace.length)),
    name: Math.max("NAME".length, ...rows.map((r) => r.name.length)),
    type: Math.max("TYPE".length, ...rows.map((r) => r.type.length)),
    status: Math.max("STATUS".length, ...rows.map((r) => r.status.length)),
    grade: Math.max("GRADE".length, ...rows.map((r) => r.grade.length)),
    tools: Math.max("TOOLS".length, ...rows.map((r) => r.tools.length)),
  };

  const header =
    `  ${"NAMESPACE".padEnd(widths.namespace)}  ` +
    `${"NAME".padEnd(widths.name)}  ` +
    `${"TYPE".padEnd(widths.type)}  ` +
    `${"STATUS".padEnd(widths.status)}  ` +
    `${"GRADE".padEnd(widths.grade)}  ` +
    `${"TOOLS".padStart(widths.tools)}`;
  print(header);

  // Deterministic ordering: alphabetical by namespace so re-runs stay
  // diffable and the user can eyeball a familiar shape on each call.
  const sorted = [...rows].sort((a, b) => a.namespace.localeCompare(b.namespace));
  for (const r of sorted) {
    const line =
      `  ${r.namespace.padEnd(widths.namespace)}  ` +
      `${r.name.padEnd(widths.name)}  ` +
      `${r.type.padEnd(widths.type)}  ` +
      `${r.status.padEnd(widths.status)}  ` +
      `${r.grade.padEnd(widths.grade)}  ` +
      `${r.tools.padStart(widths.tools)}`;
    print(line);
  }
}

function truncateVersion(v: string): string {
  // Config versions are opaque strings — usually a SHA-ish hash. Trim
  // to the first 8 chars: enough to correlate with dashboard / logs,
  // short enough to keep the header one line on narrow terminals.
  return v.length > 8 ? v.slice(0, 8) : v;
}
