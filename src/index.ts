import { parseAuditArgs, runAudit } from "./audit-cmd.js";
import { parseBundlesArgs, runBundlesCommand } from "./bundles-cmd.js";
import { parseCompletionArgs, runCompletion } from "./completion-cmd.js";
import { runComplianceCommand } from "./compliance-cmd.js";
import { ConfigError } from "./config.js";
import { loadYawMcpConfig, tokenFingerprint } from "./config-loader.js";
import { runDoctor } from "./doctor-cmd.js";
import { FOUNDRY_USAGE, parseFoundryArgs, runFoundryExport } from "./foundry-cmd.js";
import { parseInstallArgs, runInstall } from "./install-cmd.js";
import { parseAddArgs, parseListArgs, parseRemoveArgs, runAdd, runList, runRemove } from "./local-add-cmd.js";
import { log } from "./logger.js";
import { parseLoginArgs, runLogin } from "./login-cmd.js";
import { parseLogoutArgs, runLogout } from "./logout-cmd.js";
import { parseResetLearningArgs, RESET_LEARNING_USAGE, runResetLearning } from "./reset-learning-cmd.js";
import { parseSecretsArgs, runSecrets } from "./secrets-cmd.js";
import { ConnectServer } from "./server.js";
import { parseServersArgs, runServersCommand } from "./servers-cmd.js";
import { parseSetActiveArgs, runSetActive } from "./set-active-cmd.js";
import { parseStatsArgs, runStats } from "./stats-cmd.js";
import { suggestFlag, suggestSubcommand } from "./subcommands.js";
import { parseSyncArgs, runSync } from "./sync-cmd.js";
import { parseTryArgs, parseTryCleanupArgs, runTry, runTryCleanup } from "./try-cmd.js";
import { parseUpgradeArgs, runUpgrade } from "./upgrade-cmd.js";

// The known-subcommand / flag-alias dispatch table and the did-you-mean
// helpers (suggestSubcommand / suggestFlag) live in ./subcommands.js (a
// side-effect-free module) so the completion test can import the
// ground-truth dispatch table, and the suggestion logic can be unit
// tested, without booting this dispatcher.

declare const __VERSION__: string;

// Shared dispatch tail for the subcommand runners. Every `runX(...)`
// returns either a `{ exitCode }` result or a bare number; this funnels
// the promise through a single `.catch()` so a rejection (e.g.
// `runSecrets` on a corrupt vault) prints a clean
// `yaw-mcp <cmd>: <message>` to stderr and exits 1, instead of dumping a
// raw Node stack and bypassing the 2-for-usage / 1-for-error convention.
function dispatch(cmd: string, p: Promise<{ exitCode: number } | number>): void {
  p.then((r) => process.exit(typeof r === "number" ? r : r.exitCode)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yaw-mcp ${cmd}: ${msg}\n`);
    process.exit(1);
  });
}

// Subcommand dispatcher. `yaw-mcp` with no args (or with flags only) runs as
// the MCP server that talks to Yaw MCP. Known subcommands branch off
// before the YAW_MCP_TOKEN check so local-only commands like `compliance`,
// `install`, and `doctor` don't require an account.
const subcommand = process.argv[2];

if (subcommand === "compliance") {
  dispatch("compliance", runComplianceCommand(process.argv.slice(3)));
} else if (subcommand === "audit") {
  const parsed = parseAuditArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("audit", runAudit(parsed.options));
} else if (subcommand === "foundry") {
  const parsed = parseFoundryArgs(process.argv.slice(3));
  if (!parsed.ok) {
    // --help prints the usage to stdout and exits 0; real errors go to stderr.
    const isHelp = parsed.error === FOUNDRY_USAGE;
    (isHelp ? process.stdout : process.stderr).write(`${parsed.error}\n`);
    process.exit(isHelp ? 0 : 2);
  }
  dispatch("foundry", runFoundryExport(parsed.options));
} else if (subcommand === "install") {
  const parsed = parseInstallArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  // Read CLAUDE_CONFIG_DIR here (not inside runInstall) so tests stay
  // hermetic — they call runInstall directly and never inherit env state.
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
      ? process.env.CLAUDE_CONFIG_DIR
      : undefined;
  dispatch("install", runInstall({ ...parsed.options, claudeConfigDir }));
} else if (subcommand === "doctor") {
  const doctorArgs = process.argv.slice(3);
  const doctorJson = doctorArgs.includes("--json");
  const isHelpArg = (a: string): boolean => a === "--help" || a === "-h";
  // Collect ALL stray args (not just the first) so `doctor --bad --worse`
  // reports both. An explicit --help still wins, but only when no unknown
  // PRECEDES it -- `doctor --bad --help` must report --bad, matching the
  // parse-first siblings (which reject unknown flags before honoring help).
  const doctorUnknowns = doctorArgs.filter((a) => a !== "--json" && !isHelpArg(a));
  const firstHelpIdx = doctorArgs.findIndex(isHelpArg);
  const firstUnknownIdx = doctorArgs.findIndex((a) => a !== "--json" && !isHelpArg(a));
  const helpWins = firstHelpIdx !== -1 && (firstUnknownIdx === -1 || firstHelpIdx < firstUnknownIdx);
  if (helpWins) {
    process.stdout.write(
      "Usage: yaw-mcp doctor [--json]\n\n  Print a diagnostic of your yaw-mcp setup.\n\n  --json  Emit machine-readable JSON instead of text.\n",
    );
    process.exit(0);
  }
  if (doctorUnknowns.length > 0) {
    const quoted = doctorUnknowns.map((a) => `"${a}"`).join(", ");
    process.stderr.write(`yaw-mcp doctor: unknown argument${doctorUnknowns.length > 1 ? "s" : ""} ${quoted}\n`);
    process.exit(2);
  }
  dispatch("doctor", runDoctor({ json: doctorJson }));
} else if (subcommand === "reset-learning") {
  const parsed = parseResetLearningArgs(process.argv.slice(3));
  if (parsed.kind === "help") {
    process.stdout.write(`${RESET_LEARNING_USAGE}\n`);
    process.exit(0);
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("reset-learning", runResetLearning());
} else if (subcommand === "servers") {
  const parsed = parseServersArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("servers", runServersCommand(parsed.options));
} else if (subcommand === "bundles") {
  const parsed = parseBundlesArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("bundles", runBundlesCommand(parsed.options));
} else if (subcommand === "completion") {
  const parsed = parseCompletionArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("completion", runCompletion(parsed.options));
} else if (subcommand === "upgrade") {
  const parsed = parseUpgradeArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("upgrade", runUpgrade(parsed.options));
} else if (subcommand === "try") {
  const parsed = parseTryArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("try", runTry(parsed.options));
} else if (subcommand === "try-cleanup") {
  const parsed = parseTryCleanupArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("try-cleanup", runTryCleanup(parsed.options));
} else if (subcommand === "add") {
  const parsed = parseAddArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("add", runAdd(parsed.options));
} else if (subcommand === "remove") {
  const parsed = parseRemoveArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("remove", runRemove(parsed.options));
} else if (subcommand === "list") {
  const parsed = parseListArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("list", runList(parsed.options));
} else if (subcommand === "login") {
  const parsed = parseLoginArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("login", runLogin(parsed.options));
} else if (subcommand === "logout") {
  const parsed = parseLogoutArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("logout", runLogout(parsed.options));
} else if (subcommand === "sync") {
  const parsed = parseSyncArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("sync", runSync(parsed.options));
} else if (subcommand === "stats") {
  const parsed = parseStatsArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("stats", runStats(parsed.options));
} else if (subcommand === "secrets") {
  const parsed = parseSecretsArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("secrets", runSecrets(parsed.options));
} else if (subcommand === "set-active") {
  const parsed = parseSetActiveArgs(process.argv.slice(3));
  if (!parsed.ok) {
    if ((parsed as { help?: boolean }).help) {
      process.stdout.write(`${parsed.error}\n`);
      process.exit(0);
    }
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  dispatch("set-active", runSetActive(parsed.options));
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  process.stdout.write(`
  yaw-mcp — one install, every MCP server, managed from the cloud.

  Quickstart:
    1. Install yaw-mcp     yaw-mcp install claude-code
    2. Verify setup     yaw-mcp doctor
    3. Yaw Team (optional)  yaw-mcp login --key <license-key>
                            https://yaw.sh/mcp/dashboard/settings/tokens

  Setup (connect a client to yaw-mcp):
    install <client>         Connect one MCP client to yaw-mcp. This wires the
                             aggregator into the client; it does NOT add a
                             server (for that, see \`add\` below). <client> is
                             one of: claude-code, claude-desktop, cursor, vscode.
    install --list           List which MCP clients are installed on this
                             machine (read-only; no writes).
    install --all            Configure every installed MCP client in one go.

  Local servers (no account):
    add <slug>               Add an MCP server from the yaw.sh/mcp catalog to
                             your local ~/.yaw-mcp/bundles.json so yaw-mcp loads
                             it. Pass required env with --env KEY=value.
    remove <slug>            Remove a server (by slug or namespace) from
                             bundles.json.
    list                     List the servers yaw-mcp loads locally.
    try <slug>               Wire a one-off trial of a catalog MCP server
                             directly into your AI client (bypassing yaw-mcp).
                             No account needed; expires after --ttl (default
                             1h). Doctor GCs it after.
    try-cleanup <slug>       Remove a wired trial early.

  Inspection:
    doctor                   Diagnose setup: config, token, clients, learning,
                             upgrade, flaky-namespace reliability rollup.
    servers [<filter>]       List servers in your yaw.sh/mcp dashboard; the
                             positional arg substring-filters by namespace.
    bundles [list|match]     Browse curated multi-server bundles. \`list\` shows
                             all; \`match\` partitions against your enabled
                             servers (ready vs. partially installed).

  Maintenance:
    upgrade                  Show (or --run) the command that bumps
                             @yawlabs/mcp to the latest version.
    reset-learning           Clear cross-session learning history
                             (~/.yaw-mcp/state.json).
    completion <shell>       Print a shell completion script for bash, zsh,
                             fish, or powershell. Redirect to your
                             completions directory to install.

  Account / sync (Yaw Team):
    login                    Authenticate this machine with a Yaw MCP account.
                             --key <license> to pass the key inline.
    logout                   Sign this machine out of the account.
    sync <push|pull|status>  Replicate your local bundles.json to/from the
                             account store (env values stripped on push).
    secrets <action>         Manage synced secret VALUES: set, get, list,
                             remove, lock, push, pull.
    stats                    Show your account usage statistics
                             (--limit, --days, --json).

  Other:
    compliance <target>      Run the 88-test compliance suite against an MCP
                             server. --publish posts the report to
                             yaw.sh/mcp and prints the public URL.
    audit <namespace>        Run the compliance suite against a stdio server
                             from your bundles.json and cache its A-F grade in
                             ~/.yaw-mcp/grades.json (shown in \`servers\` + the
                             Yaw Terminal MCP panel).
    help, --help, -h         Show this help.
    --version, -V            Print yaw-mcp version.

  Running \`yaw-mcp\` with no subcommand starts the MCP server (requires a
  resolved token). Most read-only subcommands accept \`--json\` for
  machine-readable output. Run \`yaw-mcp <subcommand> --help\` for per-
  subcommand flag details.

  Environment variables:
    YAW_MCP_TOKEN                 API token (overrides every config file).
    YAW_MCP_URL                   API base URL (default https://yaw.sh/mcp).
    YAW_MCP_POLL_INTERVAL         Dashboard polling interval, seconds (default 60).
    YAW_MCP_SERVER_CAP            Max concurrently active servers (default 6).
    YAW_MCP_MIN_COMPLIANCE        Minimum grade to auto-activate (A|B|C|D|F).
    YAW_MCP_AUTO_LOAD             Auto-activate the namespaces of the highest-
                               ranked recurring pack at startup, subject to
                               SERVER_CAP (default: off).
    YAW_MCP_AUTO_ACTIVATE         Set to \`0\` to disable discover's auto-activate
                               gate (default: a clearly-winning server is
                               activated in the same call).
    YAW_MCP_AUTO_UPGRADE          Set to \`0\` to disable the background
                               self-upgrade check at server startup (default:
                               stale global-npm installs are upgraded in the
                               background).
    YAW_MCP_PRUNE_RESPONSES       Set to \`0\` to disable response pruning.
    YAW_MCP_DISABLE_PERSISTENCE   Disable cross-session learning state.
    YAW_MCP_CATALOG_URL          Override the catalog \`add\`/\`try\` resolve slugs
                               against (default https://yaw.sh/data/mcp-catalog.json).
    YAW_MCP_BASE_URL              Base URL for \`yaw-mcp try\` signup/telemetry
                               links (default https://yaw.sh/mcp).

  Config resolution (highest precedence first):
    1. YAW_MCP_TOKEN / YAW_MCP_URL env vars
    2. <project>/.yaw-mcp/config.local.json   machine-local overrides (gitignore)
    3. <project>/.yaw-mcp/config.json         project-shared (checked in; never
                                           put a token here — apiBase only)
    4. ~/.yaw-mcp/config.json                 user-global default

  Token rotation: yaw-mcp reads config at startup. Restart the MCP client
  (or kill yaw-mcp; the client will respawn it) after editing any config.

  Docs:   https://yaw.sh/mcp
  Source: https://github.com/YawLabs/mcp

`);
  process.exit(0);
} else if (subcommand === "--version" || subcommand === "-V") {
  // __VERSION__ is substituted at build time by tsup (see tsup.config.ts);
  // when running unbundled from source the declare leaves it as undefined,
  // so guard with typeof and fall back to "dev".
  process.stdout.write(`yaw-mcp ${typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"}\n`);
  process.exit(0);
} else if (subcommand && !subcommand.startsWith("-")) {
  // Bare positional first arg that isn't a known subcommand — almost
  // always a typo. Surface a "did you mean?" instead of falling through
  // to runServer, which would then fail opaquely on the missing token.
  const suggestions = suggestSubcommand(subcommand);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Run `yaw-mcp --help` for the list of subcommands.";
  process.stderr.write(`yaw-mcp: unknown subcommand "${subcommand}".${hint}\n`);
  process.exit(2);
} else if (subcommand && suggestFlag(subcommand).length > 0) {
  // Long-form leading-dash near-miss of a known flag alias (e.g.
  // `--versionn`, `--hepl`). Without this it would fall through to
  // runServer and hang as a stdio MCP server with no diagnostic.
  // suggestFlag returns [] for short single-letter flags and for genuine
  // long server flags with no close match, so those still pass through to
  // runServer below — this only catches typos of the dispatcher's own flags.
  const suggestions = suggestFlag(subcommand);
  process.stderr.write(`yaw-mcp: unknown flag "${subcommand}". Did you mean: ${suggestions.join(", ")}?\n`);
  process.exit(2);
} else {
  runServer();
}

async function runServer(): Promise<void> {
  // Resolve token + apiBase via the unified loader: env > local > global
  // for token, env > local > project > global > default for apiBase.
  // Missing token is NOT fatal -- yaw-mcp falls through to local mode
  // where server definitions come from ~/.yaw-mcp/bundles.json instead
  // of the backend. Empty bundles.json + no token also fine; yaw-mcp
  // starts with an empty server list.
  const config = await loadYawMcpConfig();

  // Surface non-fatal config warnings on startup so the user sees them
  // (e.g., loose file perms, schema-version mismatch). Doctor shows the
  // full picture; this is just a heads-up.
  for (const w of config.warnings) {
    log("warn", "Config warning", { warning: w });
  }

  if (config.token) {
    log("info", "yaw-mcp startup (account mode)", {
      apiBase: config.apiBase,
      apiBaseSource: config.apiBaseSource,
      tokenSource: config.tokenSource,
      tokenFingerprint: tokenFingerprint(config.token),
    });
  } else {
    log("info", "yaw-mcp startup (local mode)", {
      hint: "no YAW_MCP_TOKEN set; loading servers from ~/.yaw-mcp/bundles.json (if present)",
    });
  }

  const server = new ConnectServer(config.apiBase, config.token);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    if (forceExit.unref) forceExit.unref();
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Last-resort net for stray async failures. Without this a single
  // unhandled rejection (e.g. an orphaned upstream connect that rejects
  // late) can tear down the stdio transport with no trace. Log and keep
  // running rather than dying silently.
  process.on("unhandledRejection", (e) => log("error", "unhandledRejection", { error: String(e) }));
  process.on("uncaughtException", (e) => log("error", "uncaughtException", { error: String(e) }));

  server.start().catch((err: unknown) => {
    if (err instanceof ConfigError && err.fatal) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n  yaw-mcp: ${msg}\n\n`);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "Fatal startup error", { error: msg });
    process.exit(1);
  });
}
