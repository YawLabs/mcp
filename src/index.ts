import { parseBundlesArgs, runBundlesCommand } from "./bundles-cmd.js";
import { parseCompletionArgs, runCompletion } from "./completion-cmd.js";
import { runComplianceCommand } from "./compliance-cmd.js";
import { loadMcphConfig, tokenFingerprint } from "./config-loader.js";
import { ConfigError } from "./config.js";
import { runDoctor } from "./doctor-cmd.js";
import { closestNames } from "./fuzzy.js";
import { parseInstallArgs, runInstall } from "./install-cmd.js";
import { log } from "./logger.js";
import { parseLoginArgs, runLogin } from "./login-cmd.js";
import { parseLogoutArgs, runLogout } from "./logout-cmd.js";
import { NAG_ELIGIBLE_SUBCOMMANDS, recordTouchPoint, showNagInterstitial } from "./nag.js";
import { RESET_LEARNING_USAGE, parseResetLearningArgs, runResetLearning } from "./reset-learning-cmd.js";
import { ConnectServer } from "./server.js";
import { parseServersArgs, runServersCommand } from "./servers-cmd.js";
import { parseStatsArgs, runStats } from "./stats-cmd.js";
import { parseSyncArgs, runSync } from "./sync-cmd.js";
import { getSession } from "./team-sync.js";
import { parseTryArgs, parseTryCleanupArgs, runTry, runTryCleanup } from "./try-cmd.js";
import { parseUpgradeArgs, runUpgrade } from "./upgrade-cmd.js";

// Known subcommands for fuzzy-match feedback on typos. Anything not in
// this list and not a flag (leading `-`) falls through to "unknown
// subcommand" before runServer, so `yaw-mcp instal` fails loud instead of
// starting as an MCP server and opaquely erroring on the missing token.
const KNOWN_SUBCOMMANDS = [
  "compliance",
  "install",
  "doctor",
  "reset-learning",
  "servers",
  "bundles",
  "completion",
  "upgrade",
  "try",
  "try-cleanup",
  "login",
  "logout",
  "sync",
  "stats",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

declare const __VERSION__: string;

// Subcommand dispatcher. `yaw-mcp` with no args (or with flags only) runs as
// the MCP server that talks to mcp.hosting. Known subcommands branch off
// before the YAW_MCP_TOKEN check so local-only commands like `compliance`,
// `install`, and `doctor` don't require an account.
const subcommand = process.argv[2];

// Free-tier nag: fires on human-initiated subcommands once every 2-4
// touch points (floor: 1 per 1.5 days). Suppressed in account mode,
// when stdout/stdin is not a TTY, or when YAW_MCP_NO_NAG=1 is set.
// Server-mode (no subcommand) is excluded because it's launched by the
// AI client -- interrupting a tool call with a keypress prompt would
// confuse the agent and the user. See plans-v2.md "Nag mechanic".
if (subcommand && NAG_ELIGIBLE_SUBCOMMANDS.has(subcommand) && process.env.YAW_MCP_NO_NAG !== "1") {
  // Account mode = ANY of: env token, config.json token, or an active
  // team-session cookie (Pro or Yaw Business buyer who ran `yaw-mcp
  // login`). Check the cheapest signal first so the common case skips
  // the heavier loads.
  const envHasToken = typeof process.env.YAW_MCP_TOKEN === "string" && process.env.YAW_MCP_TOKEN.length > 0;
  let inAccountMode = envHasToken;
  if (!inAccountMode) {
    try {
      const cfg = await loadMcphConfig();
      inAccountMode = Boolean(cfg.token);
    } catch {
      inAccountMode = false;
    }
  }
  if (!inAccountMode) {
    try {
      const session = await getSession();
      inAccountMode = session !== null;
    } catch {
      inAccountMode = false;
    }
  }
  if (!inAccountMode) {
    const decision = await recordTouchPoint();
    if (decision.show) {
      await showNagInterstitial();
    }
  }
}

if (subcommand === "compliance") {
  runComplianceCommand(process.argv.slice(3)).then((code) => process.exit(code));
} else if (subcommand === "install") {
  const parsed = parseInstallArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  // Read CLAUDE_CONFIG_DIR here (not inside runInstall) so tests stay
  // hermetic — they call runInstall directly and never inherit env state.
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
      ? process.env.CLAUDE_CONFIG_DIR
      : undefined;
  runInstall({ ...parsed.options, claudeConfigDir }).then((r) => process.exit(r.exitCode));
} else if (subcommand === "doctor") {
  const doctorArgs = process.argv.slice(3);
  const doctorJson = doctorArgs.includes("--json");
  const doctorUnknown = doctorArgs.find((a) => a !== "--json" && a !== "--help" && a !== "-h");
  if (doctorArgs.includes("--help") || doctorArgs.includes("-h")) {
    process.stdout.write(
      "Usage: yaw-mcp doctor [--json]\n\n  Print a diagnostic of your yaw-mcp setup.\n\n  --json  Emit machine-readable JSON instead of text.\n",
    );
    process.exit(0);
  }
  if (doctorUnknown) {
    process.stderr.write(`yaw-mcp doctor: unknown argument "${doctorUnknown}"\n`);
    process.exit(2);
  }
  runDoctor({ json: doctorJson }).then((r) => process.exit(r.exitCode));
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
  runResetLearning().then((r) => process.exit(r.exitCode));
} else if (subcommand === "servers") {
  const parsed = parseServersArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runServersCommand(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "bundles") {
  const parsed = parseBundlesArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runBundlesCommand(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "completion") {
  const parsed = parseCompletionArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runCompletion(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "upgrade") {
  const parsed = parseUpgradeArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runUpgrade(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "try") {
  const parsed = parseTryArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runTry(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "try-cleanup") {
  const parsed = parseTryCleanupArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runTryCleanup(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "login") {
  const parsed = parseLoginArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runLogin(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "logout") {
  const parsed = parseLogoutArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runLogout(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "sync") {
  const parsed = parseSyncArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runSync(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "stats") {
  const parsed = parseStatsArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runStats(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  process.stdout.write(`
  yaw-mcp — one install, every MCP server, managed from the cloud.

  Quickstart:
    1. Get a token      https://yaw.sh/mcp/dashboard/settings/tokens
    2. Install yaw-mcp     yaw-mcp install claude-code --token mcp_pat_...
    3. Verify setup     yaw-mcp doctor

  Setup:
    install <client>         Configure one MCP client to launch yaw-mcp.
                             <client> is one of: claude-code, claude-desktop,
                             cursor, vscode.
    install --list           List which MCP clients are installed on this
                             machine (read-only; no writes).
    install --all            Configure every installed MCP client in one go.
    try <slug>               Wire a one-off trial of an upstream MCP server
                             into your AI client. No account needed; expires
                             after --ttl (default 1h). Doctor GCs it after.
    try-cleanup <slug>       Remove a wired trial early.

  Inspection:
    doctor                   Diagnose setup: config, token, clients, learning,
                             upgrade, flaky-namespace reliability rollup.
    servers [<filter>]       List servers in your mcp.hosting dashboard; the
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

  Other:
    compliance <target>      Run the 88-test compliance suite against an MCP
                             server. --publish posts the report to
                             mcp.hosting and prints the public URL.
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
                               self-upgrade check at \`yaw-mcp serve\` startup
                               (default: stale global-npm installs are
                               upgraded in the background).
    YAW_MCP_PRUNE_RESPONSES       Set to \`0\` to disable response pruning.
    YAW_MCP_DISABLE_PERSISTENCE   Disable cross-session learning state.
    YAW_MCP_BASE_URL              Override the host \`yaw-mcp try\` queries for
                               /api/explore/:slug (default https://yaw.sh/mcp).

  Config resolution (highest precedence first):
    1. YAW_MCP_TOKEN / YAW_MCP_URL env vars
    2. <project>/.yaw-mcp/config.local.json   machine-local overrides (gitignore)
    3. <project>/.yaw-mcp/config.json         project-shared (checked in; never
                                           put a token here — apiBase only)
    4. ~/.yaw-mcp/config.json                 user-global default

  Token rotation: yaw-mcp reads config at startup. Restart the MCP client
  (or kill yaw-mcp; the client will respawn it) after editing any config.

  Docs:   https://yaw.sh/mcp
  Source: https://github.com/YawLabs/yaw-mcp

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
  // Flags (anything with a leading `-`) still fall through so server
  // startup can parse them (or ignore unknown ones) as it did before.
  const visible = KNOWN_SUBCOMMANDS.filter((s) => !s.startsWith("-") && s !== "help");
  const suggestions = closestNames(subcommand, visible, 3);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Run `yaw-mcp --help` for the list of subcommands.";
  process.stderr.write(`yaw-mcp: unknown subcommand "${subcommand}".${hint}\n`);
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
  const config = await loadMcphConfig();

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
