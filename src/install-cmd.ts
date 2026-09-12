// `yaw-mcp install <client> [flags]` — auto-edits the chosen MCP client's
// config file so the user doesn't have to hand-write JSON or hunt for
// per-OS file paths.
//
// The client's config file (e.g., ~/.claude.json for Claude Code user
// scope) is the only file this touches: the yaw-mcp launch entry (written
// under the key `mcp` -- ENTRY_NAME) is merged in, preserving any other
// `mcpServers` / `servers` keys the user already has, plus every sibling
// along the container key path (Claude Code local scope nests under
// projects[<absDir>].mcpServers). Claude Code additionally gets a
// `permissions.allow` patch in its settings.json.
//
// The key is `mcp`, NOT `yaw-mcp`: that spelling is a LEGACY_ENTRY_NAME now,
// detected only to nudge the user into deleting it. Anything keying off this
// file's behaviour (a migration, an external doctor check) must read `mcp`.
//
// ~/.yaw-mcp/config.json is NO LONGER written by install. It existed to carry
// the account token across clients, and yaw-mcp is local-only now — servers
// come from ~/.yaw-mcp/bundles.json. `--token` and `--no-yaw-mcp-config`
// are still ACCEPTED so scripted installs keep exiting 0, but they are
// inert and print a deprecation warning to stderr.
//
// WRITING is what stopped, not reading: config-loader.ts still READS that file
// (servers / blocked / installNudge), and migrate.ts still hoists a 0.11.x
// legacy dotfile into it on upgrade. A file present there is live config, not
// a leftover -- deleting it changes behaviour.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `mcp` entry that differs         → prompt (TTY) or refuse
//                                                  (exit 2) off one, unless
//                                                  --repair (keeps its env's
//                                                  string values), --force
//                                                  (drops all of it) or
//                                                  --skip answers up front.
//                                                  One that already matches
//                                                  is a no-op.
//   - Client file changed between read + write  → refuse, ask for a re-run
//                                                  (see the fingerprint check
//                                                  ahead of atomicWriteFile).
//   - settings.json changed between read + write → warn and skip the
//                                                  best-effort permissions
//                                                  patch, exit 0 (same
//                                                  fingerprint check; the
//                                                  launch entry is already
//                                                  written, so nothing is
//                                                  refused).
//   - --dry-run                                  → print ONLY what would be
//                                                  added (the entry at its
//                                                  container path, the
//                                                  permissions.allow delta)
//                                                  and exit 0 without writing.
//                                                  Never the merged file: its
//                                                  siblings carry secrets, and
//                                                  the entry's own carried-over
//                                                  env prints keys only.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { type ClientProbeResult, probeClientsAsync } from "./doctor-cmd.js";
import {
  buildLaunchEntry,
  CLAUDE_CODE_ALLOW_PATTERN,
  CURRENT_OS,
  ENTRY_NAME,
  findLegacyEntry,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  isProjectLocalEntry,
  LEGACY_ENTRY_NAMES,
  resolveAppDataDir,
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "./install-targets.js";
import { editJsoncEntry, parseJsonc, removeJsoncEntry } from "./jsonc.js";
import { loadLocalBundles, localBundlesPath } from "./local-bundles.js";
import {
  MIN_OAM_VERSION,
  type OamProbe,
  oamFailureLabel,
  oamInstallCommand,
  oamNoBinaryReason,
  oamPublishesBinaryForThisMachine,
  probeOam,
  resolveStableNpmEntry,
} from "./oam-spawn.js";
import { tildePath, userConfigDir } from "./paths.js";
import { QUESTION_CANCELLED, questionOrEmpty } from "./readline-question.js";

export interface InstallCommandOptions {
  /** Target client. Omitted when --list or --all drives the run. */
  clientId?: InstallClientId;
  scope?: InstallScope;
  os?: InstallOS;
  projectDir?: string;
  /** DEPRECATED and ignored. Used to be written to ~/.yaw-mcp/config.json.
   *  Still accepted (with a stderr warning) so scripted installs that pass
   *  `--token mcp_pat_...` keep working and keep exiting 0. */
  token?: string;
  /** Overwrite an existing yaw-mcp entry without prompting -- ALL of it. The
   *  entry written carries no `env` from the one it replaces (the carry-over in
   *  runInstall is skipped), so this is the flag that purges a wrong
   *  YAW_MCP_VAULT_PASSPHRASE or a stale OAM_BIN; install names each env key it
   *  drops. Mutually exclusive with `repair`, which keeps that env's string
   *  values. */
  force?: boolean;
  /** Replace an existing entry that DIFFERS from the one this run would write,
   *  without prompting, KEEPING the existing entry's string-valued `env`.
   *  That is what separates it from `--force`: `--force` overwrites whatever is
   *  there, env included, which is why a setup script cannot use it casually.
   *  `--repair` says "make the entry match what install would write, and keep
   *  what the user added", and on an entry that ALREADY matches it is a no-op
   *  like every other path now is -- so a post-upgrade fixup can run it
   *  unconditionally. */
  repair?: boolean;
  /** Leave an existing yaw-mcp entry untouched (exit 0). */
  skip?: boolean;
  /** Leave a pre-rename legacy entry (`yaw-mcp` / `mcph` / `mcp.hosting`) in
   *  place instead of trimming it in the same write. Install used to NAME that
   *  entry as a duplicate-broker hazard and then hand it back untouched; the
   *  trim is the default now, and this is the opt-out for a user who is
   *  deliberately running the old key alongside. */
  keepLegacy?: boolean;
  /** Print the changes that would be made and exit without writing. */
  dryRun?: boolean;
  /** Test seams for the oam launch-entry decision, mirroring runDoctor's
   *  `oamProbe`. Without these the entry written depends on whether the
   *  MACHINE running the tests happens to have oam plus a durable
   *  @yawlabs/mcp install -- so the npx-entry assertions would pass on CI and
   *  fail on a maintainer's box, which is the worst way for a test to fail. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  resolveOamEntry?: (pkg: string) => string | null;
  /** Test seam for the third machine fact the oam-absent note reads: whether
   *  oam publishes a binary for THIS platform+arch. Defaults to
   *  oamPublishesBinaryForThisMachine(). Without it the withhold-the-installer
   *  branch of `oamAbsentNote` is reachable only from a linux-arm64 (or
   *  freebsd, or...) runner -- i.e. never on CI and never on a maintainer's
   *  box, so the one wording that has to be right for the users who cannot
   *  install oam at all was the one wording no test could see. */
  oamPublishesBinary?: () => boolean;
  /** DEPRECATED and ignored. Existed only to suppress the (now removed)
   *  ~/.yaw-mcp/config.json token write; install no longer touches that
   *  file at all. Still accepted, with a stderr warning. */
  skipYawMcpConfig?: boolean;
  /** Read-only: enumerate clients and show which scopes already host a yaw-mcp entry. */
  listOnly?: boolean;
  /** Install into every client yaw-mcp supports on this OS in one shot. */
  all?: boolean;
  /** Override for tests; defaults to homedir(). */
  home?: string;
  /** Windows %APPDATA% override for tests. When home is overridden and this
   *  is not, it is derived as <home>/AppData/Roaming so the claude-desktop
   *  path cannot escape a synthetic home (a write test with os=windows used
   *  to resolve through the REAL process.env.APPDATA). */
  appData?: string;
  /** Override for tests; defaults to process.cwd(). */
  cwd?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set, claude-code writes go
   *  to `<DIR>/.claude.json` and `<DIR>/settings.json` instead of the
   *  HOME-based defaults. Wrappers like Yaw Mode set this to point Claude
   *  Code at a per-session config; install must follow the redirect or
   *  the entry lands where Claude Code never reads it. The CLI dispatcher
   *  in index.ts populates this from `process.env.CLAUDE_CONFIG_DIR`;
   *  tests leave it undefined to stay hermetic against an env-set value. */
  claudeConfigDir?: string;
  /** Override for tests; defaults to process.stdin/stdout. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    isTTY: boolean;
    /** Forces readline's keypress mode (what a real TTY gets), so a test can
     *  deliver Ctrl+C the way a terminal does. Defaults to readline's own
     *  verdict (output.isTTY). */
    terminal?: boolean;
  };
  /** Override for tests; replaces an interactive prompt with a fixed answer. */
  promptAnswer?: "overwrite" | "skip" | "abort";
  /** Set by the parser when `--help` / `-h` was passed. Dispatcher prints
   *  USAGE to stdout and exits 0 -- treated as a successful run, not an
   *  argv error. Keeps `-h` distinguishable from unknown-flag rejections. */
  helpRequested?: boolean;
  /** Internal, set by `--all`: suppress the oam-is-absent Runtime note so it
   *  prints once for the run instead of once per client. Same reasoning as the
   *  `token` / `skipYawMcpConfig` stripping at the --all call site -- a
   *  machine-level fact restated per client is noise, not diagnosis. */
  suppressOamAbsentNote?: boolean;
  /** Test seam for the bundles.json read, mirroring `oamProbe`. Without it a
   *  test that overrides `home` but not `cwd` still walks up from the REAL
   *  process.cwd(): findProjectConfigDir only bounds at $HOME when the walk
   *  STARTS under it, so from a repo checkout inside the developer's home --
   *  with `home` pointed at a tmpdir -- the walk runs to the filesystem root
   *  and can accept the developer's own ~/.yaw-mcp as this run's PROJECT
   *  config. Same class as the oamProbe seam's own rationale above. */
  bundlesSummary?: () => BundlesSummary | Promise<BundlesSummary>;
  /** Internal, set by `--all`: suppress the bundles.json summary so it prints
   *  once for the run instead of once per client, exactly like
   *  suppressOamAbsentNote above -- one machine-level file restated per client
   *  is noise. Deliberately does NOT cover the direct-entries Note, which
   *  describes the CLIENT FILE this plan just wrote and differs per client.
   *  Also suppresses the READ, so an --all run loads bundles.json once. */
  suppressBundlesNote?: boolean;
  /** Internal, set by `--all`: on the off-TTY collision refusal, print only
   *  this client's half -- the file and what differs -- and leave the half
   *  every refusing client shares ("stdin is not a TTY" and the flags that
   *  answer it) to the ONE hint runInstallAll prints after its loop. The diff
   *  is never deferred: it differs per client, and it is what the user needs
   *  to pick between --repair, --force and --skip. */
  deferCollisionHint?: boolean;
}

/** The oam-absent Runtime line. Shared so `--all`'s single copy and the
 *  per-client one cannot drift into two wordings of the same fact.
 *
 *  Deliberately NOT "node runs everything": uv/uvx and docker sidecars do not
 *  run on node either (see uv-bootstrap.ts), so the reassurance has to be about
 *  the runtime yaw-mcp is choosing between, not about server coverage. */
function oamAbsentNote(os: InstallOS, publishesBinary: () => boolean = oamPublishesBinaryForThisMachine): string {
  const head = "Runtime: node (oam is not installed, which is fine -- node is the supported default. ";
  // Withhold the installer where it cannot succeed: oam ships no linux-arm64
  // binary and install.sh refuses outright, so naming the one-liner here sends
  // the user to a command that exits non-zero for a runtime they never needed.
  if (os === CURRENT_OS && !publishesBinary()) {
    return `${head}oam is not an option on this machine: ${oamNoBinaryReason()}.)`;
  }
  return `${head}To host yaw-mcp on oam instead: \`${oamInstallCommand(os)}\`, then re-run install.)`;
}

/** True when the probe means oam is simply NOT INSTALLED -- both handles null,
 *  not below-min, no failure. The one Runtime reason that is not a
 *  misconfiguration, and so the one `--all` consolidates. Mirrors the tail of
 *  runInstall's reason-chain, which reaches its `else` under exactly these
 *  conditions. */
function oamIsAbsent(probe: OamProbe): boolean {
  return probe.bin === null && probe.binPath === null && !probe.belowMin && probe.failure === null;
}

/** What install reports about bundles.json. Three states, split exactly the
 *  way `sidecars install` splits them: a null config with a non-null path is a
 *  file that IS there and could not be used, and telling that user to
 *  `yaw-mcp add` would describe a defect as an empty file. */
export type BundlesState = "servers" | "empty" | "unreadable";
export interface BundlesSummary {
  state: BundlesState;
  /** Validated servers the loader would serve. Counts disabled entries too,
   *  matching `yaw-mcp list` so the two surfaces cannot disagree about how
   *  many servers a machine has. */
  count: number;
  /** The file the count came from, or -- when neither file exists -- the file
   *  `yaw-mcp add` would create. The empty-state line has to name where the
   *  server lands. */
  path: string;
  /** The loader's own diagnostics. Printed ONLY in the unreadable state. */
  warnings: string[];
}

export async function summarizeBundles(opts: { home?: string; cwd?: string }): Promise<BundlesSummary> {
  const home = opts.home ?? homedir();
  const loaded = await loadLocalBundles({ home, cwd: opts.cwd ?? process.cwd() });
  // ENABLED entries only. The loader keeps a disabled one in the array, but
  // the broker filters on isActive before it serves anything -- so counting
  // the raw length told a user with every server disabled that yaw-mcp "serves
  // it through this entry", which it does not.
  const count = (loaded.config?.servers ?? []).filter((srv) => srv.isActive !== false).length;
  const state: BundlesState =
    loaded.config === null && loaded.path !== null ? "unreadable" : count > 0 ? "servers" : "empty";
  return { state, count, path: loaded.path ?? localBundlesPath(userConfigDir(home)), warnings: loaded.warnings };
}

/** Entry keys in the container this install writes into that are somebody
 *  else's server: everything except our own entry and the pre-rename keys for
 *  it (both are the BROKER, not an upstream). Non-object values are skipped --
 *  a key holding a string or null is not a server any client can launch, and
 *  counting it inflates the number the user is asked to trust.
 *
 *  Returns the NAMES, not just a count: install prints only `.length` (the
 *  dry-run preview is asserted not to echo a sibling's name), while a later
 *  import prompt needs the names themselves. Exported for tests. */
export function directClientEntries(container: unknown): string[] {
  if (typeof container !== "object" || container === null || Array.isArray(container)) return [];
  const skip = new Set<string>([ENTRY_NAME, ...LEGACY_ENTRY_NAMES]);
  return Object.entries(container as Record<string, unknown>)
    .filter(([k, v]) => !skip.has(k) && typeof v === "object" && v !== null && !Array.isArray(v))
    .map(([k]) => k);
}

/** Where the counted entries live. The file alone under-describes claude-code
 *  LOCAL scope, whose container is projects[<dir>].mcpServers inside a
 *  ~/.claude.json that also carries a top-level mcpServers this count does not
 *  include. */
function describeContainer(file: string, containerPath: string[]): string {
  if (containerPath.length <= 1) return file;
  const tail = containerPath
    .slice(2)
    .map((k) => `.${k}`)
    .join("");
  return `${file} under ${containerPath[0]}[${JSON.stringify(containerPath[1])}]${tail}`;
}

/** The tail both the live path and the --dry-run preview end with. One
 *  function, two call sites: the dry-run branch returns before the live tail,
 *  and a second copy of these strings is how one of them goes stale.
 *
 *  Tense-neutral on purpose, unlike the collision and container-repair lines
 *  elsewhere in this file. Those describe a MUTATION and so need `would`;
 *  these describe state install does not change -- the sibling entries keep
 *  loading directly either way, and bundles.json is not touched by install. */
function logInstallTail(
  log: (s: string) => void,
  err: (s: string) => void,
  direct: { names: string[]; where: string; clientLabel: string },
  bundles: BundlesSummary | null,
): void {
  const n = direct.names.length;
  if (n > 0) {
    // COUNT ONLY, never the keys: the dry-run preview exists to be pasted into
    // a bug report and is asserted not to echo a sibling's name. The names stay
    // in `direct` for the import prompt, which will ask before printing any.
    log(
      n === 1
        ? `Note: 1 other MCP server is already configured in ${direct.where} -- ${direct.clientLabel} keeps launching it directly, not through yaw-mcp. Installing yaw-mcp leaves it as it is.`
        : `Note: ${n} other MCP servers are already configured in ${direct.where} -- ${direct.clientLabel} keeps launching them directly, not through yaw-mcp. Installing yaw-mcp leaves them as they are.`,
    );
  }
  if (!bundles) return;
  // Every state, not just `unreadable`: an untrusted project bundles.json is
  // dropped by the trust gate and yields `empty` PLUS the warning that names
  // `yaw-mcp trust`, which is the only line explaining why the servers the
  // user can see are not being served.
  for (const w of bundles.warnings) err(`warning: ${w}`);
  if (bundles.state === "servers") {
    log(
      `Servers: ${bundles.count} configured in ${bundles.path} -- yaw-mcp serves ${bundles.count === 1 ? "it" : "them"} through this entry.`,
    );
    return;
  }
  if (bundles.state === "unreadable") {
    log(`Servers: could not read ${bundles.path} -- yaw-mcp will start with nothing to serve.`);
    log("  The `warning:` line above says what is wrong; `yaw-mcp list` prints the same detail.");
    return;
  }
  log("Servers: none configured yet -- yaw-mcp will start with nothing to serve.");
  log(
    "  Add one with `yaw-mcp add <slug>` (browse the catalog at https://yaw.sh/mcp/catalog/); it lands in " +
      `${bundles.path}, and a running yaw-mcp picks it up on its next mcp_connect_* call -- no client restart.`,
  );
}

/** %APPDATA% for this run, resolved in ONE place and threaded to
 *  resolveInstallPath (which reads no environment of its own).
 *
 *  Precedence: the explicit override; else a `home` override owns it, so a
 *  synthetic home cannot escape into the real process.env.APPDATA (see
 *  InstallCommandOptions.appData); else the machine's, which means the ambient
 *  %APPDATA% ahead of `<homedir()>/AppData/Roaming`. That last step is the
 *  load-bearing one: Windows lets %APPDATA% be redirected (roaming profiles,
 *  folder redirection) away from `<home>\AppData\Roaming`, and Claude Desktop
 *  reads the redirected location. Deriving it from HOME instead named a file
 *  the app never reads.
 *
 *  Shared by the write path and `--list` deliberately: spelled out separately,
 *  the two surfaces drifted into disagreeing about where claude-desktop's
 *  config lives on Windows -- install wrote the real one while --list reported
 *  the HOME-derived one. */
function resolveAppData(opts: InstallCommandOptions): string | undefined {
  return resolveAppDataDir({ appData: opts.appData, home: opts.home });
}

export interface InstallResult {
  /** Files that were written (empty in --dry-run). */
  written: string[];
  /** Files that would have been written (only populated in --dry-run). */
  wouldWrite: string[];
  /** Diagnostic messages already printed to the chosen stdout. */
  messages: string[];
  /** Process exit code. 0 = success, non-zero = refused/error. */
  exitCode: number;
  /** True when the run stopped at the off-TTY collision refusal (exit 2): a
   *  DIFFERING entry is in place, there was no TTY to ask on, and nothing
   *  answered up front -- no --force/--repair/--skip, and no --dry-run (a
   *  preview takes the overwrite branch, so it never refuses). `install --all`
   *  counts a client as refused rather than failed from this field -- never by
   *  matching the refusal's prose, which is how it once swallowed the diff
   *  with it. */
  collisionRefused?: boolean;
}

const USAGE =
  "Usage: yaw-mcp install <claude-code|claude-desktop|cursor|vscode|windsurf|gemini-cli> [--scope user|project|local]\n" +
  "                       [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                       [--force | --repair | --skip] [--keep-legacy] [--dry-run]\n" +
  "       yaw-mcp install --list  (detect clients; no writes)\n" +
  // "every client yaw-mcp supports on this OS", NOT "every detected client":
  // runInstallAll plans from `availableOn` (the OSes yaw-mcp can configure a
  // client on), not from a probe of what is actually installed here, so
  // `--all` creates a config for clients the user may not have. That is
  // deliberate (it pre-provisions), and --list is the detecting one -- the
  // help text just has to stop promising detection. Nor "every client
  // available": Claude Desktop is available on Linux and `--all` skips it.
  "       yaw-mcp install --all   (install into every client yaw-mcp supports on this OS)\n" +
  "\n" +
  "  Re-running install over an entry that already matches is a no-op (exit 0, no prompt).\n" +
  "  Undo it with `yaw-mcp uninstall <client>`.\n" +
  "\n" +
  // What to do about an entry that is ALREADY there is the decision install
  // asks the user to make, and the three flags that answer it were named in
  // the synopsis and explained nowhere. Off a TTY there is no prompt to fall
  // back on: the run refuses (exit 2) naming these, so a reader who cannot
  // find out what they mean is stuck. The exit codes are spelled out because
  // they are the contract a setup script branches on: 2 is "re-run with one of
  // these flags", 1 is "something is actually wrong" -- and --all keeps that
  // distinction instead of flattening every non-success to 1.
  "  When a different `" +
  ENTRY_NAME +
  "` entry is already in the config, install asks on a TTY\n" +
  "  and refuses without one, showing what differs (exit 2; a real failure, such\n" +
  "  as a malformed config, exits 1). Under --all the run exits 2 when every\n" +
  "  client that did not succeed was refused this way, and 1 if any one failed.\n" +
  "  Answer up front with:\n" +
  "  --force     Overwrite whatever is there, env included: the new entry keeps\n" +
  "              none of the old entry's env, and install names each key it drops.\n" +
  "  --repair    Replace an entry that has DRIFTED from what install writes,\n" +
  "              keeping the old entry's string-valued env; a no-op when it\n" +
  "              already matches, so a fixup script can run it unconditionally.\n" +
  "  --skip      Leave the existing entry untouched and exit 0.\n" +
  "  --dry-run   Print the entry (and any permissions patch) that WOULD be\n" +
  "              written, and exit 0 without touching a file.\n" +
  "\n" +
  "  Deprecated (accepted, ignored, warns): --token <mcp_pat_...>, --no-yaw-mcp-config.\n" +
  "  yaw-mcp is local-only -- it stores no token and never writes ~/.yaw-mcp/config.json.\n" +
  "  Configure servers in ~/.yaw-mcp/bundles.json (see `yaw-mcp add <slug>`).";

/** How every command in this file reports a config file it could not READ.
 *
 *  A DIRECTORY at the path is the one read failure that is not a permissions
 *  problem, and the raw errno for it ("EISDIR: illegal operation on a
 *  directory, read") reads exactly like one -- it sent users to chmod
 *  something that is not a file. `add` and `remove` already name the shape
 *  (readRawUserBundles in local-bundles.ts turns the same EISDIR into "is a
 *  directory, not a file"), so install, uninstall and `try` say the same
 *  sentence rather than being three more spellings of one fault.
 *
 *  Every other errno keeps its message, which is what a real permissions
 *  problem needs. Exported so `try` uses this one instead of a fourth copy. */
export function describeUnreadableConfig(cmd: string, path: string, err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === "EISDIR") {
    return `yaw-mcp ${cmd}: ${path} is a directory, not a file -- move or remove it, then re-run.`;
  }
  return `yaw-mcp ${cmd}: cannot read ${path}: ${(err as Error).message}`;
}

/** The refusal for a client yaw-mcp cannot configure on this OS.
 *
 *  Shared so every verb that resolves a client path says the same thing.
 *  `install`, `uninstall` and `import` reach it through resolveInstallSite;
 *  `try` did NOT have a check at all -- it went straight to
 *  resolveInstallPath, whose bare throw surfaced as a resolver internal with
 *  no way forward. Same fault, four verbs, one sentence.
 *
 *  Two shapes. A client that is simply not available on the OS gets the
 *  caller's `genericFix` -- the flags differ per verb (`try` and `import` have
 *  no --os, so they must not advertise one). A client that DOES ship on the
 *  OS but has no documented path for the config file yaw-mcp writes --
 *  INSTALL_TARGETS' `notConfigurableOn`, today only Claude Desktop on Linux --
 *  says so instead of "not available": the app IS available there, and a
 *  message denying it is a false claim about a third party. No flag fixes
 *  that case, so its remedy is another client or a hand edit. The reason
 *  itself is read from the table, never restated here. */
export function clientUnavailableMessage(
  cmd: string,
  target: (typeof INSTALL_TARGETS)[number],
  os: InstallOS,
  genericFix: string,
): string {
  const reason = target.notConfigurableOn?.[os];
  if (reason === undefined) return `yaw-mcp ${cmd}: ${target.label} is not available on ${os}.\n  ${genericFix}`;
  // Per verb, because "use another client" means something different to each.
  // uninstall has nothing of yaw-mcp's to take back on an OS it never writes
  // to: any entry there is one the user added, so removing it is theirs too.
  let fix: string;
  switch (cmd) {
    case "uninstall":
      fix = "Remove the entry by hand if you added one.";
      break;
    case "import":
      fix =
        'Add those servers to yaw-mcp yourself instead: `yaw-mcp add <slug>` for a catalog server, or `yaw-mcp add <name> --command "<launch line>"` for any other.';
      break;
    case "try":
      fix = "Pick another client, such as --client claude-code or --client cursor, or add the entry by hand.";
      break;
    default:
      fix = "Install into Claude Code or Cursor instead, or add the entry by hand.";
  }
  return `yaw-mcp ${cmd}: ${target.label} on ${os} is not supported yet.\n  ${reason}.\n  ${fix}`;
}

/** Warning printed when the retired `--token` flag is passed. Exported so
 *  tests pin the exact wording -- this is the user's only signal that a
 *  scripted `install --all --token mcp_pat_...` is now a no-op. */
export const TOKEN_FLAG_DEPRECATION =
  "yaw-mcp install: --token is deprecated and ignored -- yaw-mcp is local-only and no longer stores a token. " +
  "Drop the flag, and revoke that PAT at its source -- dropping it here does not deactivate it.";

/** Warning printed when the retired `--no-yaw-mcp-config` flag is passed. */
export const NO_CONFIG_FLAG_DEPRECATION =
  "yaw-mcp install: --no-yaw-mcp-config is deprecated and ignored -- install no longer writes " +
  "~/.yaw-mcp/config.json at all, so there is nothing to suppress.";

/** What `--dry-run` prints in place of each value of the env it carries over
 *  from the existing entry (see the preview in runInstall). Exported so tests
 *  pin that the preview shows the key and this, never the value. */
export const DRY_RUN_ENV_PLACEHOLDER = "<kept from existing entry>";

/** Everything `install` and `uninstall` both have to settle before they can
 *  touch a file: which client, which OS, which scope, which project directory,
 *  and the config path all of that resolves to.
 *
 *  Extracted when `uninstall` arrived rather than copied, because every refusal
 *  in it encodes a decision the copy would have had to re-derive -- why a
 *  cross-OS run is refused at the flag boundary, why `--project-dir` at a scope
 *  that ignores it is an error instead of a silent drop, why `opts.cwd` is the
 *  BASE for a relative `--project-dir` and not merely its fallback. Two
 *  subcommands disagreeing about where a client's config lives is the exact
 *  class of bug the shared `resolveAppDataDir` was introduced to end.
 *
 *  Returns null after printing the refusal; every refusal here is exit 2 (a
 *  usage error), which is what every caller returns on null.
 *
 *  EXPORTED for `yaw-mcp import`, which resolves the very same {client, scope,
 *  OS} -> config-file path and must not hand-roll a second table of config
 *  locations to do it. Every refusal here is one that path needs word for word
 *  -- unknown client, unsupported scope, a client yaw-mcp cannot configure on
 *  this OS, --project-dir on a scope that reads none -- which is why `cmd` is a
 *  parameter rather than a literal. */
export function resolveInstallSite(
  cmd: "install" | "uninstall" | "import",
  opts: {
    clientId?: InstallClientId;
    scope?: InstallScope;
    os?: InstallOS;
    projectDir?: string;
    home?: string;
    appData?: string;
    cwd?: string;
    claudeConfigDir?: string;
  },
  err: (s: string) => void,
): {
  target: (typeof INSTALL_TARGETS)[number];
  os: InstallOS;
  scope: InstallScope;
  projectDir: string | undefined;
  resolved: ReturnType<typeof resolveInstallPath>;
} | null {
  const target = INSTALL_TARGETS.find((t) => t.clientId === opts.clientId);
  if (!target) {
    err(`yaw-mcp ${cmd}: unknown client ${opts.clientId}\n${USAGE}`);
    return null;
  }

  const os = opts.os ?? CURRENT_OS;
  if (!target.availableOn.includes(os)) {
    err(
      clientUnavailableMessage(
        cmd,
        target,
        os,
        // NOT "pass --os to override": install resolves paths against THIS
        // machine, so a cross-OS --os write is refused at the flag boundary
        // (see parseInstallArgs) — only the --dry-run preview is offered.
        // `import` has no --os flag at all, so it must not advertise one.
        cmd === "import"
          ? "Pick a different client."
          : "Pick a different client, or preview another OS's config with --os <os> --dry-run.",
      ),
    );
    return null;
  }

  // Pick a default scope sensibly: prefer user-global where supported, else
  // fall back to the first scope the client supports.
  //
  // An explicit --project-dir with no --scope picks the client's project scope
  // instead, but ONLY when exactly one scope reads a project directory.
  //
  // Why the flag is read at all: giving VS Code a user scope flipped its
  // default from project to user, and the guard below then refused the flag
  // that had been the only way to write a workspace file -- a working command
  // broken by a change meant to add one. Where a client has a single
  // project-reading scope, `--project-dir` names it unambiguously.
  //
  // Why only when unambiguous: claude-code has TWO (project and local), and
  // choosing between them would be a guess about which file the user meant.
  // That client keeps the refusal below, which lists both and asks -- the
  // behaviour its own test records as a deliberate answer to this question.
  const projectDirScopes = target.scopes.filter((s) => s.requiresProjectDir);
  const defaultScope: InstallScope =
    opts.projectDir !== undefined && projectDirScopes.length === 1
      ? projectDirScopes[0].scope
      : target.scopes.find((s) => s.scope === "user")
        ? "user"
        : target.scopes[0].scope;
  const scope: InstallScope = opts.scope ?? defaultScope;
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) {
    err(
      `yaw-mcp ${cmd}: ${target.label} does not support scope "${scope}". Available: ${target.scopes.map((s) => s.scope).join(", ")}`,
    );
    return null;
  }

  // `--project-dir` is read ONLY by a scope that resolves a path out of it
  // (claude-code project/local, vscode project). Accepting it for a user-scope
  // install and dropping it is the same class the parser refuses for `--all
  // --scope` and `--list --force`: a flag that is accepted and dropped reads as
  // honored, and here it reads as "I told install where my project is" while
  // the entry lands in the machine-global file instead. Refused here rather
  // than in the parser because the scope is only known once the client's
  // default has been resolved; `--all` hands the flag only to the plans whose
  // scope reads it, so a mixed `--all --project-dir` run still reaches vscode.
  if (opts.projectDir !== undefined && !scopeSpec.requiresProjectDir) {
    const projectScopes = target.scopes.filter((s) => s.requiresProjectDir).map((s) => s.scope);
    const fix =
      projectScopes.length > 0
        ? `Drop it, or ${cmd} at a scope that reads it: --scope ${projectScopes.join(" | ")}.`
        : `Drop it -- ${target.label} has no project-directory scope.`;
    err(
      `yaw-mcp ${cmd}: ${target.label} (${scope}) resolves no project directory, so it cannot honor --project-dir.\n  ${fix}`,
    );
    return null;
  }

  // `opts.cwd` is the documented cwd override and runInstallList honors it, so
  // the write path must too: without it a caller that redirects cwd (a test,
  // an embedder) still resolves project scope against the REAL process.cwd()
  // and writes .vscode/mcp.json into whatever directory the runner happens to
  // be in. It also kept `--list` and `install --scope project` reporting two
  // different directories.
  // `opts.cwd` is the BASE, not just the fallback: a RELATIVE --project-dir
  // used to be resolved against the real process.cwd() even when the caller
  // had overridden cwd, making this the one place project resolution ignored
  // the override.
  const projectDir = scopeSpec.requiresProjectDir
    ? resolve(opts.cwd ?? process.cwd(), opts.projectDir ?? ".")
    : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({
      clientId: target.clientId,
      scope,
      os,
      home: opts.home,
      appData: resolveAppDataDir({ appData: opts.appData, home: opts.home }),
      projectDir,
      claudeConfigDir: opts.claudeConfigDir,
    });
  } catch (e) {
    // Defensive; unreachable via the checks above. Everything the resolver
    // throws on -- unknown client, unsupported scope, unavailable OS, a project
    // scope with no directory -- was refused above, and projectDir is set
    // whenever requiresProjectDir holds. Kept so a new resolver throw surfaces
    // as a named refusal rather than an unhandled rejection.
    err(`yaw-mcp ${cmd}: ${(e as Error).message}`);
    return null;
  }
  return { target, os, scope, projectDir, resolved };
}

export async function runInstall(opts: InstallCommandOptions): Promise<InstallResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const messages: string[] = [];
  const log = (s: string): void => {
    messages.push(s);
    stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    messages.push(s);
    stderr.write(`${s}\n`);
  };

  // Soft-deprecation notices. Emitted BEFORE the --list / --all dispatch so
  // they fire exactly once per top-level invocation; runInstallAll strips
  // both flags from its per-client recursion so they don't repeat N times.
  // Warn-and-continue by design: rejecting them would break every scripted
  // `yaw-mcp install --all --token mcp_pat_...` in the wild.
  if (opts.token !== undefined) err(TOKEN_FLAG_DEPRECATION);
  if (opts.skipYawMcpConfig) err(NO_CONFIG_FLAG_DEPRECATION);

  if (opts.listOnly && opts.all) {
    err("yaw-mcp install: --list and --all are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // ABOVE the --list/--all dispatch, like the pair check right above it: this
  // is an argv-level usage error, not a per-client one. Below the dispatch it
  // fired inside every sub-install `--all` planned, so the user got
  // "Installing into N clients", one identical refusal per planned client, and
  // exit 1 reported as "N/N client installs failed" -- a runtime-failure code
  // for what is a usage error.
  if (opts.force && opts.skip) {
    err("yaw-mcp install: --force and --skip are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }
  // Same class, same place: --repair replaces a drifted entry and --skip
  // leaves it, so the pair states two contradictory intents.
  if (opts.repair && opts.skip) {
    err("yaw-mcp install: --repair and --skip are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }
  // And --force with --repair, for the same reason. The pair used to be
  // allowed as agreeing ("do not prompt, write the entry"), which held only
  // while the two flags wrote byte-identical entries. They no longer do:
  // --force drops the existing entry's env and --repair keeps its string
  // values, so honoring either one silently discards the other -- and picking
  // the env-dropping one is how a scripted run loses a vault passphrase nobody
  // asked it to remove.
  if (opts.force && opts.repair) {
    err(
      "yaw-mcp install: --force and --repair are mutually exclusive -- --force drops the existing entry's env, " +
        "--repair keeps its string values. Pass one.",
    );
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // Both sub-commands write into the SAME `messages` array this call already
  // accumulates (log/err push into it), so the returned InstallResult carries
  // the full printed trail -- including the deprecation notices emitted above
  // the dispatch, which a second, locally-built array silently dropped.
  if (opts.listOnly) return runInstallList(opts, log, messages);
  if (opts.all) return runInstallAll(opts, log, err, messages);

  if (!opts.clientId) {
    err(`yaw-mcp install: client argument required\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const site = resolveInstallSite("install", opts, err);
  if (!site) return { written: [], wouldWrite: [], messages, exitCode: 2 };
  const { target, os, scope, projectDir, resolved } = site;

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  // Read + merge existing client config.
  const containerPath = resolved.containerPath;
  let existing: Record<string, unknown> = {};
  // RAW bytes of a pre-existing, non-empty, object-shaped client config. Kept
  // so the write below can go through the comment-preserving `editJsoncEntry`
  // instead of JSON.parse + JSON.stringify, which silently deletes every `//`
  // and `/* */` in the user's file. `.vscode/mcp.json` is documented JSONC and
  // its `inputs` array is routinely commented; ~/.claude.json carries user
  // comments too. `yaw-mcp try` already writes these same files this way --
  // install was the one path that still flattened them.
  let rawClient: string | null = null;
  let existingHasEntry = false;
  /** The RAW value stored under ENTRY_NAME, or undefined when there is none.
   *  Compared against the entry this run builds -- see the entryState ladder. */
  let storedEntry: unknown;
  let legacyEntry: string | null = null;
  // Computed HERE, from the container already read -- not with a second read
  // later, and not from the post-merge bytes, which by then include our own
  // entry. A file that is absent, empty, unparsed, or whose container holds a
  // non-object leaves this empty, which is correct in every one of those
  // shapes: there is nothing there to bypass.
  let directEntryNames: string[] = [];
  // Fingerprinted BEFORE the read (never after: a write landing between a
  // read and a later stat would be carried forward under a fresh fingerprint)
  // and compared again right before atomicWriteFile -- see there for why. A
  // null fingerprint is "absent", which also stands in for the existsSync
  // this replaced: an unreadable file still reaches the readFile below and
  // fails there with its real error.
  const fingerprintBefore = await fileFingerprint(resolved.absolute);
  if (fingerprintBefore !== null) {
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      err(describeUnreadableConfig("install", resolved.absolute, e));
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          err(
            `yaw-mcp install: ${resolved.absolute} is not a JSON object -- refusing to overwrite. Edit by hand or rename the file and re-run.`,
          );
          return { written: [], wouldWrite: [], messages, exitCode: 1 };
        }
        existing = parsed as Record<string, unknown>;
        rawClient = raw;
      } catch (e) {
        err(
          `yaw-mcp install: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to overwrite. Fix the file or rename it and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
    }
    const container = readNested(existing, containerPath);
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const c = container as Record<string, unknown>;
      existingHasEntry = ENTRY_NAME in c;
      // The RAW stored value, not readEntryAt's sanitized view: the comparison
      // below asks "would this run CHANGE the file", and readEntryAt drops a
      // non-string env value and any key it does not model. Comparing against
      // the sanitized copy would call a stored entry carrying `"env": {"N": 1}`
      // or a stray `"type": "stdio"` identical to the one install writes, and
      // then decline to fix the very thing a re-run is for.
      storedEntry = c[ENTRY_NAME];
      legacyEntry = findLegacyEntry(c);
      directEntryNames = directClientEntries(c);
    }
  }

  // --skip short-circuits BEFORE the entry is built, so the oam probe below
  // never runs on a path that returns without writing. It also settles the
  // flag's contract ahead of the idempotence check: `--skip` says "leave what
  // is there", which is the answer whether the stored entry matches or not, so
  // it must not fall into the legacy trim (a write) that the identical path
  // otherwise performs.
  if (existingHasEntry && opts.skip) {
    log(
      opts.dryRun
        ? `Would leave existing "${ENTRY_NAME}" entry untouched (--skip). Nothing to do.`
        : `Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 0 };
  }

  // The entry this run WOULD write, built before anything is decided about the
  // one already on disk. That ordering is the whole idempotence fix: the
  // collision branch used to fire on a bare `ENTRY_NAME in container` presence
  // test, so a re-run over a byte-identical, perfectly healthy entry took the
  // same path as a re-run over a stale one -- a prompt on a TTY and an outright
  // exit 1 off one. Nothing that needs fixing can be told from nothing that
  // needs doing without the candidate entry in hand.
  //
  // The oam PROBE therefore moves above the collision decision with the build.
  // What does NOT move is the REPORTING: every Runtime line below is a claim
  // about an entry this run is about to write, and the refusal / no-op paths
  // return without writing one, so the lines are collected into `runtimeLines`
  // here and flushed only once the run has committed to writing. Ordered the
  // other way, a non-TTY re-run over an existing entry printed `Runtime: will
  // run on oam ...` above `already has a "mcp" entry and stdin is not a TTY` --
  // a runtime claim for a write that never happened, in the transcript the user
  // pastes into a bug report. The refusals that precede this point (an
  // unreadable file, malformed JSON, a non-object root) still return before the
  // probe runs at all, and so does `--skip` just above.
  //
  // Host the broker itself on oam when this machine can do it durably: a
  // version-gated oam, resolvable to an ABSOLUTE path, AND a non-npx-cache
  // install to point at. Any one missing keeps the npx entry unchanged -- the
  // normal case, not an error.
  const oamProbeResult = await (opts.oamProbe ?? probeOam)();
  const resolveEntry = opts.resolveOamEntry ?? resolveStableNpmEntry;
  // `binPath`, not `bin`. `bin` is what THIS process spawns, and without
  // OAM_BIN it is a bare "oam" that only resolves because a shell PATH made it
  // work here; the entry below is read by a GUI-launched client that inherits
  // no such PATH. `binPath` is the same binary as an absolute path, or null
  // when it could not be located -- "oam works here but there is no portable
  // path to write", which stays on npx exactly like oam-absent does.
  const oamBinPath = oamProbeResult.binPath;
  const oamEntry = oamBinPath ? resolveEntry("@yawlabs/mcp") : null;
  const newEntry = buildLaunchEntry({ os, oamBinPath, oamEntry });
  // Every fallback gets a reason. The npx entry is the right outcome in all of
  // them, but "I installed oam and it still runs on node" is unexplainable from
  // the outside, and a silent below-min / broken / unresolvable oam is
  // indistinguishable from a machine that has none.
  //
  // "will run on", not "runs on": nothing has been written yet, and the write
  // can still fail below. Reporting a runtime the user does not have would be
  // worse than saying nothing.
  const runtimeLines: string[] = [];
  const oamVersion = oamProbeResult.version ? ` ${oamProbeResult.version}` : "";
  // Read off the entry that was actually BUILT, never re-derived from the same
  // inputs: buildLaunchEntry applies one more gate than the pair below
  // (isAbsolute(oamBinPath) -- a bare/relative name a GUI-launched client could
  // not resolve), so re-testing `oamBinPath && oamEntry` here printed "will run
  // on oam" over an npx entry, with no line saying why.
  // Tested inline rather than hoisted into a boolean: a `const` collapses to
  // `boolean` and narrows nothing, so the oamEntry read below would still be
  // `string | null`. buildLaunchEntry only ever emits the oam command when BOTH
  // halves were present, so this conjunction is the same condition, typed.
  if (oamBinPath && oamEntry && newEntry.command === oamBinPath) {
    runtimeLines.push(`Runtime: will run on oam${oamVersion}`);
    // The resolved entry is durable but not necessarily GLOBAL: a project
    // node_modules qualifies, and this config is machine-global, so an
    // `rm -rf node_modules` weeks from now kills the broker in every project
    // with nothing pointing back at the cause.
    if (isProjectLocalEntry(oamEntry, opts.cwd ?? process.cwd())) {
      runtimeLines.push(
        `Note: that path is a project-local install (${oamEntry}). Removing this checkout's node_modules ` +
          `(\`rm -rf node_modules\`, \`npm prune\`, a rename) breaks the entry in ${resolved.absolute}. ` +
          "`npm i -g @yawlabs/mcp` and re-run install for a machine-durable path.",
      );
    }
  } else if (oamBinPath && oamEntry) {
    // Both halves resolved and buildLaunchEntry still declined, which leaves
    // exactly one cause: the path is not absolute. PATH can legitimately carry a
    // relative dir (`.`, `node_modules/.bin`), and resolveBinAbsolute joins the
    // bin onto whatever it finds there, so the "absolute" probe result is only
    // as absolute as the PATH entry it came from.
    runtimeLines.push(
      `Runtime: node (oam${oamVersion} resolved only to the relative path \`${oamBinPath}\` -- a client config must ` +
        "carry an absolute one, since a GUI-launched client resolves a relative path against its own working " +
        "directory, not yours. Set OAM_BIN to oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamBinPath) {
    // oam is present and usable, but yaw-mcp itself resolves only to the npx
    // cache -- a path a config file must not persist.
    runtimeLines.push(
      "Runtime: node (oam found, but yaw-mcp is not durably installed -- `npm i -g @yawlabs/mcp` to host it on oam)",
    );
  } else if (oamProbeResult.bin) {
    // Usable here, not persistable: `oam` runs in this shell but was not found
    // on PATH as a file, so the only value available to write is a bare name
    // the client would resolve against its own PATH.
    runtimeLines.push(
      `Runtime: node (oam${oamVersion} runs here, but its absolute path could not be resolved -- a client config ` +
        `must not carry a bare \`${oamProbeResult.bin}\`, which a GUI-launched client cannot find. Set OAM_BIN to ` +
        "oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamProbeResult.belowMin) {
    runtimeLines.push(
      `Runtime: node (oam${oamVersion} is below the ${MIN_OAM_VERSION} minimum -- upgrade oam and re-run install ` +
        "to host yaw-mcp on it)",
    );
  } else if (oamProbeResult.failure) {
    // oamFailureLabel, not a phrase table of our own: the probe distinguishes
    // broken from absent precisely so the user is not sent looking for an
    // install they already have, and doctor's OAM RUNTIME section plus
    // default-runtime's per-server reason report the same failure. Two wordings
    // is how one report says "unusable" and the next says "not installed".
    runtimeLines.push(
      `Runtime: node (oam is installed but unusable: ${oamFailureLabel(oamProbeResult.failure)}` +
        `${oamProbeResult.failureDetail ? ` -- ${oamProbeResult.failureDetail}` : ""}. Fix or reinstall oam and ` +
        "re-run install to host yaw-mcp on it.)",
    );
  } else if (!opts.suppressOamAbsentNote) {
    // Plain absence -- binPath and bin both null, not below-min, no failure --
    // and the ONE branch of this chain that said nothing at all. "Every fallback
    // gets a reason" above was true of the misconfigurations and false of the
    // common case, so a user on a fresh machine got an npx entry with no line
    // saying an alternative existed.
    //
    // Suppressed under --all, which prints it once for the run: unlike the
    // branches above -- rare misconfigurations worth restating per client --
    // absence is a MACHINE-level fact and the common case, so repeating it
    // across every client is the same noise the collision refusal consolidates.
    runtimeLines.push(oamAbsentNote(os, opts.oamPublishesBinary));
  }

  // Carry over an existing entry's `env` -- on every path EXCEPT --force. The
  // merge replaces our entry wholesale, and the default entry sets no env at
  // all -- so re-running install silently dropped anything the user had put
  // there. OAM_BIN is the live example: it pins which oam hosts the sidecars,
  // and losing it moves them to a different runtime with no diagnostic. Only
  // fills a gap; an entry that brings its own env (the upstream/try shape) is
  // untouched.
  //
  // Carried on --repair, on a TTY prompt answered [o]verwrite (the diff that
  // prompt shows is computed against this env-carrying entry, so it must be
  // the entry written), and on a bare --dry-run. NOT on --force: that flag is
  // documented as overwriting whatever is there, and a user running it to
  // purge a wrong YAW_MCP_VAULT_PASSPHRASE used to get the same passphrase
  // back, byte-for-byte what --repair wrote.
  const previousEntry = readEntryAt(existing, containerPath, ENTRY_NAME);
  const previousEnv = previousEntry?.env;
  const carryableEnv =
    newEntry.env === undefined && previousEnv && Object.keys(previousEnv).length > 0 ? previousEnv : undefined;
  const entryToWrite = carryableEnv && !opts.force ? { ...newEntry, env: carryableEnv } : newEntry;
  // Buffered with the Runtime lines, and for the same reason: it describes the
  // entry this run is about to WRITE. On the identical path nothing is written
  // and the env was never at risk, so announcing that it was "kept" is a claim
  // about a merge that did not happen.
  //
  // The --force line names what it drops -- KEYS only, never values, the rule
  // describeEntryDiff and DRY_RUN_ENV_PLACEHOLDER follow for this same block --
  // because the drop is otherwise visible only as one `env: drops ...` diff
  // line. It names only the keys --repair would have kept: a non-string value
  // is filtered out by readEntryAt on both paths, so claiming --repair keeps
  // it would be false (the diff line still names it). The same filter is why
  // the parenthetical speaks of THESE keys rather than of "an entry's env":
  // --repair does not keep a non-string value either. Sorted (the "Kept" line
  // too), so a multi-key drop names its keys in the order the `env: drops ...`
  // diff line does rather than the same set twice in two orders. "Dropping",
  // not "Dropped": the line prints before the write, which can still fail.
  //
  // carriedKeys is shared with the TTY prompt and the off-TTY hint below. Both
  // name the kept keys rather than saying "its env", for the same readEntryAt
  // reason, and in the same sorted order.
  const carriedKeys = carryableEnv ? Object.keys(carryableEnv).sort() : [];
  if (carryableEnv) {
    const keys = carriedKeys.join(", ");
    if (opts.force) {
      runtimeLines.push(
        `${opts.dryRun ? "Would drop" : "Dropping"} existing env on the ${ENTRY_NAME} entry (--force): ${keys}. ` +
          `(--repair would keep ${carriedKeys.length === 1 ? "it" : "them"}; --force does not.)`,
      );
    } else {
      runtimeLines.push(`Kept existing env on the ${ENTRY_NAME} entry: ${keys}`);
    }
  }

  // ---- what this run has to do about the entry already on disk ------------
  //
  // Three outcomes, decided by COMPARING the built entry against the stored
  // one rather than by testing the key's presence:
  //   absent    -> a fresh install; nothing to prompt about.
  //   identical -> a re-run over a healthy entry. Exit 0, no prompt, no write
  //                of the entry. This is what makes install safe to put in a
  //                setup script and what makes doctor's "rerun `yaw-mcp
  //                install <client>`" advice (doctor-cmd.ts, the
  //                cannot-launch branches) executable off a TTY.
  //   differs   -> the collision prompt, now showing WHAT differs instead of
  //                a bare "already has an entry", plus --repair to take it
  //                unprompted.
  const entryState: "absent" | "identical" | "differs" = !existingHasEntry
    ? "absent"
    : deepEqualJson(storedEntry, entryToWrite)
      ? "identical"
      : "differs";

  if (entryState === "differs") {
    // Computed once and shared by the prompt and the off-TTY refusal: a
    // scripted run gets to see what it WOULD have replaced before being told
    // which flag to re-run with, the same courtesy `yaw-mcp remove` extends.
    const diff = describeEntryDiff(storedEntry, entryToWrite);
    const diffBlock = indentDiff(diff, "    ");
    let decision: "overwrite" | "abort" | "cancelled";
    if (opts.force || opts.repair || opts.dryRun) decision = "overwrite";
    else if (opts.promptAnswer === "skip") {
      // The test seam's third answer. `--skip` itself short-circuits far
      // above (before the oam probe), so this is the only route left to a
      // prompt answered "skip" -- and it must land on the same message.
      log(
        opts.dryRun
          ? `Would leave existing "${ENTRY_NAME}" entry untouched (--skip). Nothing to do.`
          : `Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    } else if (opts.promptAnswer) decision = opts.promptAnswer;
    else if (opts.io?.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))) {
      const answer = await promptCollision(
        resolved.absolute,
        diff,
        opts.io,
        entryToWrite !== newEntry ? carriedKeys : [],
      );
      if (answer === "skip") {
        log(`Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`);
        return { written: [], wouldWrite: [], messages, exitCode: 0 };
      }
      decision = answer;
    } else {
      // Under --all only this client's half prints here -- the file and the
      // diff, under the client's own header. The half every refusing client
      // shares (no TTY, and the flags that answer it) is printed ONCE by
      // runInstallAll, which learns of the refusal from `collisionRefused`
      // below. It used to learn of it by matching this message's prose on
      // stderr, and swallowed the whole message -- diff included -- with it.
      //
      // When the stored entry has env to carry, the two write flags stop being
      // interchangeable, and this line is where a scripted user picks one: the
      // diff above was computed WITH the env carried, so it has no `env:` line
      // for the carried keys and nothing here would warn that --force removes
      // them. It names those keys rather than saying --repair keeps "its env":
      // a non-string value is filtered out by readEntryAt, goes on either flag,
      // and is named by the `env: drops ...` line of the diff above. Under
      // --all the same distinction rides the one consolidated hint instead, so
      // it is built here only for the hint this run actually prints.
      const differs = `  It differs from the entry install would write:\n${diffBlock}`;
      const flagHint = carryableEnv
        ? `  Re-run with --repair to bring it up to date (keeping env: ${carriedKeys.join(", ")}), ` +
          "--force to overwrite it outright (dropping its env), --skip to leave it, or --dry-run to preview."
        : "  Re-run with --repair to bring it up to date, --force to overwrite, --skip to leave it, or --dry-run to preview.";
      err(
        opts.deferCollisionHint
          ? `yaw-mcp install: ${resolved.absolute} already has a "${ENTRY_NAME}" entry -- left untouched.\n${differs}`
          : `yaw-mcp install: ${resolved.absolute} already has a "${ENTRY_NAME}" entry and stdin is not a TTY.\n` +
              `${differs}\n` +
              flagHint,
      );
      // Exit 2, not 1: this is a confirmation that could not be asked for off
      // a TTY, which is what `remove`, `set`, `uninstall` and `secrets remove`
      // all return 2 for. install was the outlier, so a script could not tell
      // "needs a flag" from "the write failed" without parsing the prose --
      // and 1 stays available for the failures that really are failures (an
      // unreadable config, a malformed one, a refused write).
      return { written: [], wouldWrite: [], messages, exitCode: 2, collisionRefused: true };
    }
    if (decision === "abort") {
      err("Aborted.");
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (decision === "cancelled") {
      // Ctrl+C at the prompt. Exit 130, the convention every other prompt in
      // the product (the vault passphrase, trust's [y/N]) already follows.
      err("Cancelled.");
      return { written: [], wouldWrite: [], messages, exitCode: 130 };
    }
    // Conditional tense under --dry-run: the decision above maps dryRun onto
    // "overwrite" so this collision path is exercised, but the run returns
    // before any write. Present tense here told a user scanning the transcript
    // that their preview had already mutated the file.
    log(
      opts.dryRun ? `Would overwrite existing "${ENTRY_NAME}" entry.` : `Overwriting existing "${ENTRY_NAME}" entry.`,
    );
    for (const d of diff) log(`  ${d}`);
  }

  // The trim of a pre-rename entry. Install used to NAME this hazard ("legacy
  // ... remains ... Remove it to avoid running yaw-mcp twice") and then hand
  // the file back with the second broker still wired -- a duplicate-broker
  // state the tool created, described, and left. It goes in the SAME write as
  // the entry now, so the file is never momentarily missing one and carrying
  // the other. `--keep-legacy` is the opt-out for a user deliberately running
  // the old key alongside.
  const trimLegacy = legacyEntry !== null && !opts.keepLegacy;

  // `identical` is not "nothing to do" on its own: a legacy entry may still
  // need trimming, and Claude Code's permissions.allow may still be missing
  // the pattern (doctor sends users back here for exactly that). So the entry
  // write is what gets skipped, not the run.
  const skipEntryWrite = entryState === "identical";
  if (skipEntryWrite) {
    log(`The "${ENTRY_NAME}" entry in ${resolved.absolute} is already correct.`);
  } else {
    // Flushed only once the run has committed to writing the entry -- see the
    // buffering rationale where `runtimeLines` is declared. Suppressed on the
    // identical path deliberately: the entry is not changing, so "will run on
    // oam" would describe a write that is not happening, and the runtime the
    // user is actually on is the one already in the file.
    for (const line of runtimeLines) log(line);
  }

  // Two write paths, mirroring try-cmd:
  //   - file pre-exists with object content -> splice the entry into the
  //     ORIGINAL bytes via editJsoncEntry (jsonc.ts), so comments, key order,
  //     the neighbouring entries and the user's indentation all survive;
  //   - file missing or empty -> nothing to preserve, so build the object and
  //     render it (this path also materializes a missing container chain).
  //
  // NULL means "this run has no client-config write to make": the stored entry
  // already matches and there is no legacy entry to trim. Everything from the
  // fingerprint re-check to the `Wrote ...` line is then skipped, which is what
  // makes a re-run genuinely a no-op on disk rather than a rewrite that happens
  // to produce the same bytes (a rewrite still moves mtime, still races a live
  // Claude Code session, and still shows up in a backup diff).
  let clientJson: string | null = null;
  if (skipEntryWrite && !trimLegacy) {
    clientJson = null;
  } else if (skipEntryWrite && rawClient !== null) {
    // Identical entry, legacy entry to trim: the only edit is the removal, so
    // the entry's own bytes are left exactly where the user (or a previous
    // install) put them.
    try {
      const next = removeJsoncEntry(rawClient, containerPath, legacyEntry as string);
      clientJson = next.endsWith("\n") ? next : `${next}\n`;
    } catch (e) {
      err(
        `yaw-mcp install: failed to remove the legacy "${legacyEntry}" entry from ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  } else if (rawClient !== null) {
    // The splice cannot create a container over a key that already holds a
    // non-object -- jsonc-parser throws, and its message names neither the file
    // nor the key. Settle that here so the entry write below is left with only
    // genuine surprises to report.
    let spliceSource = rawClient;
    const blocked = findBlockedContainerSegment(existing, containerPath);
    if (blocked) {
      const keyPath = blocked.path.join(".");
      if (!blocked.reparable) {
        err(
          `yaw-mcp install: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not a JSON object -- refusing to overwrite. Make it an object (or remove the key) and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
      // Reparable: replace the key with an empty object in the SAME
      // comment-preserving pass, so the rest of the file keeps its bytes. Every
      // deeper segment is necessarily absent afterwards, which the splice below
      // materializes -- so one repair is always enough.
      try {
        spliceSource = editJsoncEntry(
          spliceSource,
          blocked.path.slice(0, -1),
          blocked.path[blocked.path.length - 1],
          {},
        );
      } catch (e) {
        err(
          `yaw-mcp install: failed to replace the non-object "${keyPath}" key in ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
      // Conditional tense under --dry-run, matching the collision message: this
      // runs before the preview, and nothing has touched the file yet.
      log(
        `Note: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not an object -- ` +
          `${opts.dryRun ? "would replace" : "replaced"} it with an empty object so the "${ENTRY_NAME}" entry has somewhere to live.`,
      );
    }
    try {
      let next = editJsoncEntry(spliceSource, containerPath, ENTRY_NAME, entryToWrite);
      // Trimmed in the SAME pass as the entry, so the file never lands on disk
      // holding one without the other. Both edits are splices (jsonc.ts), so
      // the user's comments and formatting survive the removal exactly as they
      // survive the upsert.
      if (trimLegacy) next = removeJsoncEntry(next, containerPath, legacyEntry as string);
      // editJsoncEntry leaves the user's bytes alone outside what it splices,
      // so a file that already ends in a newline keeps exactly the one it
      // had (never doubled). A file that does NOT is terminated here rather
      // than left unterminated -- POSIX tools and diffs both want the newline,
      // and install is rewriting the file anyway.
      clientJson = next.endsWith("\n") ? next : `${next}\n`;
    } catch (e) {
      err(
        `yaw-mcp install: failed to splice the "${ENTRY_NAME}" entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  } else {
    // No pre-existing bytes, so there is no legacy entry either (legacyEntry is
    // only ever set from a container read out of a file that parsed).
    const merged = mergeClientConfig(existing, containerPath, entryToWrite);
    clientJson = `${JSON.stringify(merged, null, 2)}\n`;
  }

  const home = opts.home ?? homedir();

  // Claude Code: also ensure `permissions.allow` carries our pattern so
  // the user isn't re-prompted for every yaw-mcp tool call. No-op for other
  // clients (Claude Desktop / Cursor / VS Code have their own permission
  // models). Preserves all existing settings — we only union the pattern
  // into `permissions.allow` and write the file back verbatim otherwise.
  const settingsPatch =
    opts.clientId === "claude-code"
      ? await prepareClaudeCodeSettingsPatch({
          scope,
          home,
          projectDir,
          claudeConfigDir: opts.claudeConfigDir,
        })
      : null;

  // Surface a malformed/non-object settings.json rather than silently
  // skipping the permissions patch (the patch itself is best-effort, so
  // this never fails the install -- but the user needs to know the file
  // was left unpatched, distinct from the "already present" no-op which
  // stays silent).
  if (settingsPatch?.malformed) {
    err(
      `yaw-mcp install: warning -- could not patch ${settingsPatch.path} (${settingsPatch.malformedReason}); left unchanged. Add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow by hand, or you may be re-prompted for each yaw-mcp tool call.`,
    );
  }

  // Read AFTER every refusal above, for the same reason the oam probe is: a
  // malformed client config, a non-TTY collision and `--skip` all return before
  // this point, and a "Servers: none configured yet -- add one before you
  // restart" line above `Refusing to overwrite` is advice about a broker this
  // run did not wire. Suppressed wholesale under --all, which reads once after
  // its loop. Best-effort: the launch entry is the product of this command, and
  // no bundles.json diagnostic may fail it.
  const bundles = opts.suppressBundlesNote
    ? null
    : await Promise.resolve((opts.bundlesSummary ?? summarizeBundles)({ home: opts.home, cwd: opts.cwd })).catch(
        () => null,
      );

  if (opts.dryRun) {
    // ONLY what this run adds, never the merged file. `clientJson` is the
    // whole post-merge config, and for ~/.claude.json that is every sibling
    // server's `env` -- a third-party API key, a `yaw-mcp try` entry's inline
    // secret -- printed into the transcript the user pastes into a bug report,
    // the exact leak the Runtime-line ordering above takes care to avoid. The
    // entry rendered at its container path is the one-sided diff a fresh
    // entry amounts to, and it still shows WHERE the entry lands (the
    // projects[<dir>] nesting at local scope). Same for settings.json, which
    // carries `env` and hooks of its own: the permissions.allow delta is the
    // whole change, so it is all that prints.
    //
    // The entry's own `env` is the one part of that diff that is NOT ours: it
    // is the existing entry's, carried over verbatim above (on every path but
    // --force, which previews an entry with no env and a "Would drop" line
    // instead), and README tells users to put YAW_MCP_VAULT_PASSPHRASE in
    // exactly that block. So the preview keeps its KEYS (the "Kept existing
    // env" line already names them, and the user needs to see the block
    // survives the overwrite) and masks every VALUE. A live run writes the
    // real values to the file; the preview is the one output that exists to
    // be pasted somewhere. Gated on the carry-over rather than on `env` being
    // present so the placeholder stays truthful: buildLaunchEntry emits no env
    // of its own here, so an env on the entry can only have come from the
    // user's file.
    //
    // `clientJson === null` is the identical-entry, nothing-to-trim case: the
    // preview must promise exactly what the real run would do, and the real run
    // writes nothing. Printing the entry under "would add" there is how a
    // preview starts lying about a no-op.
    if (clientJson === null && !settingsPatch?.changed) {
      log(`\nNothing to do: ${target.label} (${scope}) is already configured.`);
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    }
    log("\n--- dry run: would add the following (the rest of each file is left as-is) ---");
    if (clientJson !== null && !skipEntryWrite) {
      const previewEntry =
        entryToWrite !== newEntry && entryToWrite.env
          ? {
              ...entryToWrite,
              env: Object.fromEntries(Object.keys(entryToWrite.env).map((k) => [k, DRY_RUN_ENV_PLACEHOLDER])),
            }
          : entryToWrite;
      const preview = mergeClientConfig({}, containerPath, previewEntry);
      log(`\n# ${resolved.absolute}\n${JSON.stringify(preview, null, 2)}`);
    }
    if (settingsPatch?.changed) {
      log(`# ${settingsPatch.path}\npermissions.allow += ${JSON.stringify(settingsPatch.added)}`);
    }
    if (legacyEntry) {
      log(
        trimLegacy
          ? `Would also remove the legacy "${legacyEntry}" entry at ${resolved.absolute} (pass --keep-legacy to leave it).`
          : `Note: legacy "${legacyEntry}" entry at ${resolved.absolute} would remain (--keep-legacy) -- remove it to avoid running yaw-mcp twice.`,
      );
    }
    logInstallTail(
      log,
      err,
      {
        names: directEntryNames,
        where: describeContainer(resolved.absolute, containerPath),
        clientLabel: target.label,
      },
      bundles,
    );
    // Conditional, unlike the live path's unconditional push: an identical
    // entry with only a legacy trim or a permissions patch pending leaves
    // `clientJson` null, and naming the client file as "would write" there
    // promises an edit the real run does not make.
    const wouldWrite: string[] = clientJson !== null ? [resolved.absolute] : [];
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  const written: string[] = [];

  // Re-fingerprint immediately before publishing. The read above and this
  // write bracket an awaited `oam --version` probe (up to 3s) and, on a
  // collision, a prompt that waits on the user -- and ~/.claude.json is a file
  // Claude Code itself writes during a session (MCP approvals, project
  // metadata). atomicWriteFile only guarantees the bytes land whole; it leaves
  // serializing the logical read-modify-write to the caller (atomic-write.ts,
  // header), so a save that landed in that window used to be replaced by the
  // pre-probe snapshot plus our entry with no diagnostic. `yaw-mcp install
  // claude-code --force` run from a shell inside a live Claude Code session
  // is exactly that shape. Refuse rather than merge: the file just changed
  // under us, and re-reading it from the top is what a re-run does. Best
  // effort by nature -- a same-size rewrite inside one mtime tick (coarse on
  // some filesystems) is invisible to this check.
  //
  // Skipped entirely when there is nothing to write: a no-op run must not
  // refuse just because a live Claude Code session happened to save its own
  // file while we were deciding we had nothing to do.
  if (clientJson !== null) {
    if (!sameFingerprint(fingerprintBefore, await fileFingerprint(resolved.absolute))) {
      err(
        `yaw-mcp install: ${resolved.absolute} changed while install was running (another process wrote it) -- nothing was written. Re-run install.`,
      );
      return { written, wouldWrite: [], messages, exitCode: 1 };
    }

    // Write client config atomically. ~/.claude.json carries every
    // project's mcpServers + permissions + history; a non-atomic write
    // killed mid-flight could blow away the lot.
    try {
      await atomicWriteFile(resolved.absolute, clientJson);
    } catch (e) {
      err(`yaw-mcp install: failed to write ${resolved.absolute}: ${(e as Error).message}`);
      return { written, wouldWrite: [], messages, exitCode: 1 };
    }
    log(`Wrote ${resolved.absolute}`);
    written.push(resolved.absolute);
    if (trimLegacy) {
      log(`Removed the legacy "${legacyEntry}" entry -- it would have run yaw-mcp a second time.`);
    }
  }

  // Claude Code: merge permissions.allow into settings.json so tool
  // calls don't prompt. Best-effort: any failure here is logged but does
  // NOT fail the overall install — the launch entry is already written.
  if (settingsPatch?.changed) {
    // The same read-modify-write race the client config is guarded against
    // above, on the file Claude Code rewrites MOST during a session: every
    // permission approval lands in settings.json. The window is narrower --
    // prepareClaudeCodeSettingsPatch reads after the probe and the prompt --
    // but the client-config publish just above is an awaited write+rename
    // inside it, and a patch computed on the pre-publish bytes would replace
    // an approval that landed meanwhile. Skip rather than refuse: the launch
    // entry is already in place, the patch is best-effort, and the by-hand
    // fallback is the one every other unpatched path names. Same coarse-mtime
    // caveat as the client check.
    if (!sameFingerprint(settingsPatch.fingerprint, await fileFingerprint(settingsPatch.path))) {
      err(
        `yaw-mcp install: warning -- ${settingsPatch.path} changed while install was running (another process wrote it); left unchanged. Add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow by hand, or you may be re-prompted for each yaw-mcp tool call.`,
      );
    } else {
      try {
        await atomicWriteFile(settingsPatch.path, settingsPatch.nextJson);
        log(`Wrote ${settingsPatch.path} (added ${CLAUDE_CODE_ALLOW_PATTERN} to permissions.allow)`);
        written.push(settingsPatch.path);
      } catch (e) {
        err(
          `yaw-mcp install: warning -- failed to patch ${settingsPatch.path}: ${(e as Error).message}. You may be re-prompted for each yaw-mcp tool call; add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow to silence.`,
        );
      }
    }
  }

  // Nothing changed on disk: the entry already matched and no legacy trim or
  // permissions patch was pending. "Restart it to pick up the new MCP server"
  // would be advice for a write that did not happen -- and the whole point of
  // this path is that a setup script can re-run install without doing (or
  // being told to do) anything.
  //
  // Returned ABOVE `target.notes`, not below it: every one of those notes ends
  // in "Restart the app after editing", which on a no-op run is an instruction
  // to react to an edit that did not happen -- the same class of untrue claim
  // the buffered Runtime lines avoid.
  if (written.length === 0) {
    log(`\nNothing to do: ${target.label} is already configured.`);
    return { written, wouldWrite: [], messages, exitCode: 0 };
  }
  if (target.notes) log(`Note: ${target.notes}`);
  // Only reachable under --keep-legacy now: the default trims the entry in the
  // write above and says so there. The note stays for the opt-out, because a
  // user who asked to keep the old key still has two brokers wired.
  if (legacyEntry && !trimLegacy) {
    log(
      `Note: legacy "${legacyEntry}" entry remains at ${resolved.absolute} (--keep-legacy). Remove it to avoid running yaw-mcp twice.`,
    );
  }
  logInstallTail(
    log,
    err,
    { names: directEntryNames, where: describeContainer(resolved.absolute, containerPath), clientLabel: target.label },
    bundles,
  );
  // Claude Code gates project-scope (.mcp.json) servers behind a one-time
  // per-project approval prompt (tracked as enabledMcpjsonServers /
  // disabledMcpjsonServers under projects[<dir>] in ~/.claude.json), so
  // "restart it" alone strands the user: the freshly-written entry stays
  // inert until the prompt is answered, and nothing else names that gate.
  log(
    target.clientId === "claude-code" && scope === "project"
      ? `\nDone: ${target.label} is configured. Restart it in this project and approve the .mcp.json server when ` +
          "prompted -- Claude Code keeps project-scope (.mcp.json) servers disabled until you approve them."
      : `\nDone: ${target.label} is configured. Restart it to pick up the new MCP server.`,
  );
  return { written, wouldWrite: [], messages, exitCode: 0 };
}

/** Read `settings.json` (or settings.local.json) for the given scope,
 *  compute the next version with the yaw-mcp allow-pattern unioned into
 *  `permissions.allow` (or dropped from it, under `op: "remove"`), and return
 *  both the path and the rendered JSON.
 *  Returns `changed: false` when the pattern is already present (or already
 *  absent) — caller can skip the write entirely. Returns null for scopes that
 *  have no corresponding settings file. Malformed or non-object existing files
 *  are left untouched (changed: false, malformed: true, malformedReason set);
 *  the caller emits a warning so the skip isn't silent. Every non-null result
 *  carries the file's `fingerprint` from BEFORE the read, for the caller to
 *  compare again ahead of its write (see the settings patch in runInstall).
 *
 *  `op` is a parameter rather than a second function because everything AROUND
 *  the one-line transform -- the fingerprint-before-read discipline, the
 *  malformed/non-object reporting, the `permissions`-is-not-an-object
 *  pre-empt, the comment-preserving splice of exactly the `allow` node -- is
 *  delicate and had to be identical on both sides. `uninstall` copying it
 *  would have been a second place for that reasoning to drift. */
async function prepareClaudeCodeSettingsPatch(opts: {
  scope: InstallScope;
  home: string;
  projectDir: string | undefined;
  claudeConfigDir: string | undefined;
  /** "add" (install) unions the pattern in; "remove" (uninstall) drops it. */
  op?: "add" | "remove";
}): Promise<{
  path: string;
  nextJson: string;
  changed: boolean;
  /** The patterns this patch appends to `permissions.allow` -- the whole
   *  delta, since the merge only ever adds. What `--dry-run` prints instead of
   *  `nextJson`, which is the entire settings.json (hooks, `env`, ...). Empty
   *  when nothing changed, and empty under `op: "remove"` (see `removed`). */
  added: string[];
  /** The mirror of `added` under `op: "remove"` -- the patterns this patch
   *  drops. Empty on the add path. */
  removed: string[];
  /** stat of the file taken ahead of the read; null when it was absent. */
  fingerprint: FileFingerprint;
  malformed?: boolean;
  malformedReason?: string;
} | null> {
  const path = resolveClaudeCodeSettingsPath(opts.scope, {
    home: opts.home,
    projectDir: opts.projectDir,
    claudeConfigDir: opts.claudeConfigDir,
  });
  if (!path) return null;

  let existing: Record<string, unknown> = {};
  // Raw bytes of the pre-existing settings.json, for the same reason install
  // keeps the client config's: settings.json is JSONC and hand-maintained,
  // and a JSON.stringify rewrite drops every comment in it.
  let rawSettings: string | null = null;
  // Fingerprinted BEFORE the read, for the same reason the client config is
  // (runInstall, ahead of its readFile): taken after, a write landing between
  // the read and the stat would be carried forward under a fresh fingerprint.
  // null is "absent", which is the existence test this used to be an
  // existsSync for; an unreadable file still reaches the readFile below and
  // is reported from there.
  const fingerprint = await fileFingerprint(path);
  if (fingerprint !== null) {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
          rawSettings = raw;
        } else {
          // Not an object — leave alone, but flag it so the caller can warn
          // (otherwise the settings.json is silently never patched).
          return {
            path,
            nextJson: "",
            changed: false,
            added: [],
            removed: [],
            malformed: true,
            malformedReason: "not a JSON object",
            fingerprint,
          };
        }
      }
    } catch (e) {
      // Malformed settings.json — don't try to rewrite; flag it so the
      // caller can warn (let the user fix it by hand).
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: (e as Error).message,
        fingerprint,
      };
    }
  }

  const op = opts.op ?? "add";
  const merged =
    op === "remove"
      ? removePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN])
      : mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
  // If nothing changed, signal no-op to the caller.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return { path, nextJson: "", changed: false, added: [], removed: [], fingerprint };
  // The delta is "our patterns that were not already there" (add) or "ours that
  // were" (remove): both helpers preserve every other element, so a membership
  // test against the PREVIOUS list is the whole change either way.
  const prevAllow = (existing.permissions as { allow?: unknown } | undefined)?.allow;
  const prevAllowList: unknown[] = Array.isArray(prevAllow) ? prevAllow : [];
  const added = op === "add" ? [CLAUDE_CODE_ALLOW_PATTERN].filter((p) => !prevAllowList.includes(p)) : [];
  const removed = op === "remove" ? [CLAUDE_CODE_ALLOW_PATTERN].filter((p) => prevAllowList.includes(p)) : [];
  if (rawSettings !== null) {
    // Pre-empt the one shape that makes the splice below throw: a `permissions`
    // key holding a non-object (null, a scalar, an array) has no `allow` node
    // to hang the pattern off, and jsonc-parser's message for it ("Can not add
    // index to parent of type array") names neither the file nor the key --
    // exactly the internal text the client-config path takes care never to
    // print. Named here instead, in the same shape vocabulary that path uses.
    //
    // Reported, NOT repaired -- deliberately asymmetric with the client config.
    // There, replacing an empty container is the difference between installing
    // and not; here the patch is best-effort (the launch entry is already
    // written), settings.json is hand-maintained, and rewriting a key the user
    // put there is a bigger liberty than naming it and letting them fix it.
    const blockedPermissions = findBlockedContainerSegment(existing, ["permissions"]);
    if (blockedPermissions) {
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: `"permissions" is ${describeJsonShape(blockedPermissions.value)}, not a JSON object`,
        fingerprint,
      };
    }
    // Only `permissions.allow` changes, so edit exactly that node in the
    // original bytes. Everything else -- hooks, model, comments, formatting --
    // is left untouched rather than re-serialized.
    const nextAllow = (merged.permissions as { allow: string[] }).allow;
    try {
      const next = editJsoncEntry(rawSettings, ["permissions"], "allow", nextAllow);
      return { path, nextJson: next.endsWith("\n") ? next : `${next}\n`, changed: true, added, removed, fingerprint };
    } catch (e) {
      // Backstop for whatever the shape check above cannot foresee. Named the
      // same way, so even here the user gets the key alongside the parser's
      // text rather than the text alone.
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        removed: [],
        malformed: true,
        malformedReason: `could not splice permissions.allow (${(e as Error).message})`,
        fingerprint,
      };
    }
  }
  return { path, nextJson: `${JSON.stringify(merged, null, 2)}\n`, changed: true, added, removed, fingerprint };
}

/** Union `patterns` into `existing.permissions.allow`, preserving every
 *  other key and every element already there. Deduplicates by string equality
 *  so repeated installs don't grow the list.
 *
 *  Deliberately NOT a place that strips the pre-rename legacy wildcards
 *  (`mcp__yaw_mcp__*`, `mcp__mcph__*`, `mcp__mcp_hosting__*`). An earlier
 *  version dropped them unless the legacy mcpServers entry was still present
 *  in the ONE container install was writing -- but ~/.claude/settings.json is
 *  global, so a user-scope install could not see the legacy `yaw-mcp` entry a
 *  repo's .mcp.json (or another project's local scope) still runs, stripped
 *  its grant, and Claude Code re-prompted on every tool call of that live
 *  server. No cheap read sees every container a global allow-list covers.
 *  Three dead wildcards are harmless; a revoked live grant is not.
 *
 *  That reasoning SURVIVES the legacy-entry trim runInstall now performs, and
 *  the two must not be conflated: the trim removes the legacy key from the one
 *  container this run writes, while the allow-list it would have to strip is
 *  machine-global and may still be serving a legacy entry in a container this
 *  run never reads. Same asymmetry, same conclusion -- the entry goes, the
 *  wildcard stays.
 *  Exported for tests. */
export function mergePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prev = out.permissions;
  const perms: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const prevAllow = perms.allow;
  // Every existing element is carried through VERBATIM, non-strings included.
  // The dedupe below is a string-only concept, so a pass that narrowed to
  // string silently DELETED anything else the user (or a future Claude Code
  // schema) had put in `permissions.allow` -- an object rule, a nested array --
  // on the next install, contradicting this function's own promise to preserve
  // everything it does not manage.
  const allow: unknown[] = Array.isArray(prevAllow) ? [...(prevAllow as unknown[])] : [];
  for (const p of patterns) {
    if (!allow.includes(p)) allow.push(p);
  }
  perms.allow = allow;
  out.permissions = perms;
  return out;
}

/**
 * The subtract side of `mergePermissionsAllow`: drop `patterns` from
 * `existing.permissions.allow`, preserving every other key and every other
 * element (non-strings included, for the same preserve-what-we-do-not-manage
 * reason the merge carries them).
 *
 * Returns the SAME object reference when there is nothing to drop -- no
 * `permissions` key, no `allow` array, or no member matching. The caller's
 * `JSON.stringify(before) === JSON.stringify(after)` no-op test then trivially
 * holds, which is what keeps `uninstall` from rewriting a settings.json it has
 * no change to make to.
 *
 * An emptied `allow` is left as `[]` rather than deleted, and `permissions`
 * with it. Deleting a key the user's file declares is a bigger liberty than
 * this best-effort patch is entitled to -- the same asymmetry the install path
 * draws when it REPORTS a non-object `permissions` instead of repairing it.
 * Exported for tests.
 */
export function removePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const prev = existing.permissions;
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) return existing;
  const prevAllow = (prev as Record<string, unknown>).allow;
  if (!Array.isArray(prevAllow)) return existing;
  const allow = (prevAllow as unknown[]).filter((p) => !(typeof p === "string" && patterns.includes(p)));
  if (allow.length === (prevAllow as unknown[]).length) return existing;
  return { ...existing, permissions: { ...(prev as Record<string, unknown>), allow } };
}

/** The fields a concurrent writer moves; null when the file is absent. Used
 *  to detect a write that lands between install's read of a file and its
 *  publishing rename: the client config (refused, see the check ahead of its
 *  atomicWriteFile) and Claude Code's settings.json (the best-effort patch is
 *  skipped with a warning, see the settings write below it). */
type FileFingerprint = { mtimeMs: number; size: number } | null;

async function fileFingerprint(path: string): Promise<FileFingerprint> {
  try {
    const st = await stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** `keptEnvKeys`: the stored env keys that the entry an [o]verwrite answer
 *  writes carries over (runInstall's carry-over runs on this path), sorted;
 *  empty when it carries none. The question names them because `--force`,
 *  which USAGE also calls an overwrite, DROPS that env, and the diff above the
 *  question lists only what changes -- so a kept env would otherwise go
 *  unmentioned and "overwrite" would mean two things. KEYS, not "its env":
 *  readEntryAt filters out a non-string value, so an overwrite of a mixed env
 *  does not keep all of it, and the diff line above the question names the
 *  key that goes. */
async function promptCollision(
  path: string,
  diff: string[],
  io: InstallCommandOptions["io"],
  keptEnvKeys: string[],
): Promise<"overwrite" | "skip" | "abort" | "cancelled"> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout, terminal: io?.terminal });
  try {
    // questionOrEmpty, not a bare rl.question(): that promise never settles
    // once stdin closes (Ctrl+D, a pipe running dry), so the install hung at
    // this prompt instead of taking its default. EOF comes back as "", which
    // is what a bare Enter produces -- the `(default: skip)` branch below.
    // Ctrl+C is a distinct answer: readline closes the interface on it with
    // no process signal, and treating that as "" answered the prompt with
    // "skip" and printed a success line at exit 0 on a cancel.
    const raw = await questionOrEmpty(
      rl,
      `${path} already has an "${ENTRY_NAME}" entry that differs from the one install would write:\n` +
        `${indentDiff(diff, "    ")}\n` +
        `  [o]verwrite${keptEnvKeys.length > 0 ? ` (keeping env: ${keptEnvKeys.join(", ")})` : ""}, [s]kip, or [a]bort? (default: skip) `,
    );
    if (raw === QUESTION_CANCELLED) return "cancelled";
    const answer = raw.trim().toLowerCase();
    if (answer.startsWith("o")) return "overwrite";
    if (answer.startsWith("a")) return "abort";
    return "skip";
  } finally {
    rl.close();
  }
}

/** Walk `containerPath` to find the existing mcpServers/servers container.
 *  Returns the value at the path, or undefined if any segment is missing
 *  or non-object. Does not mutate. */
export function readNested(root: Record<string, unknown>, containerPath: string[]): unknown {
  let cur: unknown = root;
  for (const key of containerPath) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** A key along the container path whose existing value is not an object, and so
 *  cannot have the launch entry spliced into it. */
export interface BlockedContainerSegment {
  /** Full key path to the offending key, for naming it in a message. */
  path: string[];
  /** What is there instead of an object. */
  value: unknown;
  /** Whether replacing it with `{}` throws nothing away -- see
   *  `findBlockedContainerSegment`. */
  reparable: boolean;
}

/**
 * First key along `containerPath` that holds a non-object, or null when the
 * chain is spliceable as-is.
 *
 * editJsoncEntry materializes MISSING intermediate keys, but a key that exists
 * and holds a non-object is left to jsonc-parser's `modify`, which throws
 * "Can not add index to parent of type null" -- an internal message naming
 * neither the file nor the key. The
 * pre-existing top-level check catches only a non-object ROOT, so `"mcpServers":
 * null` (hand-edited, or written by a tool that emptied it) reached the splice
 * and failed the whole install. Walking the chain here is what lets the caller
 * either repair the key or refuse while naming it.
 *
 * `reparable` splits the two shapes deliberately. null, a scalar, and an empty
 * array hold no server definitions, so replacing them with `{}` loses nothing
 * and restores the behaviour of the pre-splice merge path (which overwrote any
 * non-object container). A NON-EMPTY array can hold real entries in the wrong
 * shape, and silently dropping those to write ours is not a repair -- that case
 * is the caller's refusal.
 */
export function findBlockedContainerSegment(
  root: Record<string, unknown>,
  containerPath: string[],
): BlockedContainerSegment | null {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < containerPath.length; i++) {
    const value = node[containerPath[i]];
    // Absent from here down: editJsoncEntry builds the rest of the chain itself.
    if (value === undefined) return null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      node = value as Record<string, unknown>;
      continue;
    }
    return {
      path: containerPath.slice(0, i + 1),
      value,
      reparable: value === null || !Array.isArray(value) || value.length === 0,
    };
  }
  return null;
}

/** How to name a non-object container value in a message. Shape, not contents:
 *  a `~/.claude.json` value can be arbitrarily large and the user needs to know
 *  WHICH key is wrong, not to have it echoed back. */
function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  return `a ${typeof value}`;
}

/**
 * Structural equality over parsed-JSON values. The question it answers is the
 * one the idempotence check needs: would writing `b` where `a` sits CHANGE
 * anything the client reads.
 *
 * Key ORDER is deliberately not part of that. A hand-edited entry spelling
 * `{"args": [...], "command": "npx"}` means exactly what install's own
 * `{"command": ..., "args": ...}` means, and rewriting the file to reorder two
 * keys is a diff in the user's config with no behaviour behind it -- the churn
 * a "re-running install is safe" promise exists to avoid.
 *
 * A key whose value is `undefined` is skipped on BOTH sides: `undefined` has no
 * JSON spelling, so `{command, args, env: undefined}` and `{command, args}`
 * serialize identically and must compare identically. Object.keys counts such a
 * key, which would otherwise report a difference no writer could ever produce.
 *
 * Exported for tests.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqualJson(ao[k], bo[k]));
}

/** Render diff lines under a common indent. One helper rather than an inline
 *  `.map().join()` at each of the three call sites: those live inside template
 *  literals, and a nested backtick there is how this file's collision messages
 *  got mangled once already. */
function indentDiff(diff: string[], indent: string): string {
  return diff.map((d) => `${indent}${d}`).join("\n");
}

/**
 * What changes if `next` replaces `stored`, as one line per difference.
 *
 * Exists because the collision message used to say only "already has a `mcp`
 * entry" -- true of a healthy entry and a rotted one alike, which is exactly
 * the conflation this whole path was fixed to stop making. A user asked to
 * approve an overwrite needs to see what the overwrite does.
 *
 * VALUES are rendered for `command` and `args` ONLY. Those two are a launcher
 * path and yaw-mcp's own npx/oam argv -- the same strings `--dry-run` already
 * prints. Everything else is named without its value: `env` is where README
 * tells users to put YAW_MCP_VAULT_PASSPHRASE, and an entry hand-extended with
 * some other key can hold anything. This message goes on a terminal the user
 * pastes into bug reports, so it reports env as a KEY SET change and any other
 * key by name only -- the same rule DRY_RUN_ENV_PLACEHOLDER enforces for the
 * preview.
 *
 * Exported for tests.
 */
export function describeEntryDiff(stored: unknown, nextEntry: object): string[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return [`the stored entry is ${describeJsonShape(stored)}, not an object`];
  }
  const prev = stored as Record<string, unknown>;
  const next = nextEntry as Record<string, unknown>;
  const lines: string[] = [];
  const render = (v: unknown): string => (v === undefined ? "(absent)" : JSON.stringify(v));
  for (const key of ["command", "args"]) {
    if (!deepEqualJson(prev[key], next[key])) lines.push(`${key}: ${render(prev[key])} -> ${render(next[key])}`);
  }
  const envKeys = (v: unknown): string[] =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).sort() : [];
  if (!deepEqualJson(prev.env, next.env)) {
    const before = envKeys(prev.env);
    const after = envKeys(next.env);
    const dropped = before.filter((k) => !after.includes(k));
    const added = after.filter((k) => !before.includes(k));
    const parts: string[] = [];
    if (dropped.length > 0) parts.push(`drops ${dropped.join(", ")}`);
    if (added.length > 0) parts.push(`adds ${added.join(", ")}`);
    // Same keys on both sides and still unequal means a VALUE moved (or a
    // non-string value was filtered on the way in). Named, never printed.
    if (parts.length === 0) parts.push("same keys, value(s) differ");
    lines.push(`env: ${parts.join("; ")} (values not shown)`);
  }
  for (const key of Object.keys(prev)) {
    if (key === "command" || key === "args" || key === "env") continue;
    if (!Object.hasOwn(next, key)) lines.push(`${key}: would be removed (value not shown)`);
    else if (!deepEqualJson(prev[key], next[key])) lines.push(`${key}: would change (value not shown)`);
  }
  for (const key of Object.keys(next)) {
    if (key === "command" || key === "args" || key === "env") continue;
    if (!Object.hasOwn(prev, key)) lines.push(`${key}: would be added`);
  }
  // Unreachable from runInstall (the caller only asks when deepEqualJson said
  // they differ) but a diff that renders nothing would read as "no reason to
  // overwrite" above a prompt asking to overwrite. Say so instead.
  return lines.length > 0 ? lines : ["the entries differ in key order only"];
}

/** Read the existing launch entry at `containerPath`, or null when the path or
 *  the entry is absent. Walks with readNested, the same walk mergeClientConfig
 *  and the collision check use, so all three agree on where the entry lives. */
export function readEntryAt(
  existing: Record<string, unknown>,
  containerPath: string[],
  entryName: string = ENTRY_NAME,
): { command?: string; args?: string[]; env?: Record<string, string> } | null {
  const node = readNested(existing, containerPath);
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const entry = (node as Record<string, unknown>)[entryName];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  // Validate `env` before anyone carries it forward: the user chose
  // overwrite (or --repair) precisely to replace a broken entry, and a
  // malformed env (a string -- whose Object.keys are "0","1","2" -- or an
  // array) would otherwise ride into the fresh entry and get the whole
  // file rejected by the client. Filter PER KEY, not all-or-nothing: one
  // hand-added numeric value ("DEBUG": 1) must not silently drop the
  // valid string keys beside it -- OAM_BIN is the load-bearing example
  // (losing it moves the sidecars to a different runtime with no
  // diagnostic, the exact failure the carry-over exists to prevent).
  const result = { ...entry } as { command?: string; args?: string[]; env?: Record<string, string> };
  const env = (entry as Record<string, unknown>).env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    const kept = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >;
    result.env = Object.keys(kept).length > 0 ? kept : undefined;
  } else {
    result.env = undefined;
  }
  return result;
}

/** Merge `entry` into the container at `existing[...containerPath][entryName]`,
 *  preserving every sibling at every level of the path. Returns a new object;
 *  does not mutate. For Claude Code local scope, containerPath is
 *  ["projects", <absDir>, "mcpServers"] and this preserves every other
 *  project's settings + every other top-level key in ~/.claude.json.
 *  `entryName` defaults to ENTRY_NAME (the canonical yaw-mcp entry);
 *  `yaw-mcp try` overrides it with `yaw-mcp-try-<slug>` so the trial entry sits
 *  next to a real yaw-mcp install without colliding. */
export function mergeClientConfig(
  existing: Record<string, unknown>,
  containerPath: string[],
  entry: Record<string, unknown> | { command: string; args: string[]; env?: Record<string, string> },
  entryName: string = ENTRY_NAME,
): Record<string, unknown> {
  if (containerPath.length === 0) throw new Error("mergeClientConfig: containerPath cannot be empty");
  const out: Record<string, unknown> = { ...existing };
  let parent: Record<string, unknown> = out;
  for (let i = 0; i < containerPath.length - 1; i++) {
    const key = containerPath[i];
    const child = parent[key];
    const cloned: Record<string, unknown> =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    parent[key] = cloned;
    parent = cloned;
  }
  const leafKey = containerPath[containerPath.length - 1];
  const prev = parent[leafKey];
  const container: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  container[entryName] = entry;
  parent[leafKey] = container;
  return out;
}

// `removeFromClientConfig` used to live here: an object-level "delete this
// entry, preserve every sibling" mirror of mergeClientConfig, documented as the
// helper behind `try-cleanup` and doctor's trial-GC. It was neither -- both of
// those peel a trial entry out of the RAW bytes via `removeJsoncEntry`
// (jsonc.ts), which is the only way to keep the user's comments, so this export
// had zero callers and zero tests while its doc comment claimed two. Removed
// rather than left as a second, comment-destroying way to do the same job.

/** True when a value-flag's argument reads as the NEXT flag rather than as the
 *  value. `--token --force` was already refused, but the guard tested only for
 *  a DOUBLE dash -- so `install --token -h` swallowed `-h` as the token and
 *  printed a deprecation warning instead of the help the user asked for, and
 *  `--project-dir -h` resolved a directory literally named `-h`. Every flag
 *  this parser accepts is `-h` or `--<name>`, so a leading dash of either
 *  length is the mistake; a path or token that genuinely starts with one can
 *  still be spelled `./-weird`. */
function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

/** CLI argv parser used by index.ts dispatcher. Exported so tests can
 *  exercise flag parsing without spawning a subprocess.
 *
 *  The failure shape carries no `help` field: `--help` / `-h` is a SUCCESSFUL
 *  parse carrying `helpRequested` in the options, so nothing was left to set
 *  the old `ok: false, help: true` spelling -- and the install branch in
 *  index.ts reads `options.helpRequested`, never `.help`. */
export function parseInstallArgs(argv: string[]):
  | {
      ok: true;
      options: InstallCommandOptions;
    }
  | { ok: false; error: string } {
  if (argv.length === 0) return { ok: false, error: USAGE };
  const positional: string[] = [];
  const opts: Partial<InstallCommandOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--scope": {
        const v = next();
        if (!v || !["user", "project", "local"].includes(v))
          return { ok: false, error: "--scope requires user|project|local" };
        opts.scope = v as InstallScope;
        break;
      }
      case "--os": {
        const v = next();
        if (!v || !["macos", "linux", "windows"].includes(v))
          return { ok: false, error: "--os requires macos|linux|windows" };
        opts.os = v as InstallOS;
        break;
      }
      // DEPRECATED, still parsed. The flag is inert (runInstall warns and
      // ignores it), but it must keep CONSUMING its value or a scripted
      // `install --all --token mcp_pat_x` would treat the PAT as a stray
      // positional and fail the argv check below with exit 2.
      case "--token": {
        const v = next();
        // Reject a following flag swallowed as the value (`--token --force`
        // must not set token="--force"), mirroring the enum-flag guards.
        if (!v || looksLikeFlag(v)) return { ok: false, error: "--token requires a value" };
        opts.token = v;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v || looksLikeFlag(v)) return { ok: false, error: "--project-dir requires a value" };
        opts.projectDir = v;
        break;
      }
      case "--force":
        opts.force = true;
        break;
      case "--repair":
        opts.repair = true;
        break;
      case "--keep-legacy":
        opts.keepLegacy = true;
        break;
      case "--skip":
        opts.skip = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      // DEPRECATED, still parsed (see --token above).
      case "--no-yaw-mcp-config":
        opts.skipYawMcpConfig = true;
        break;
      case "--list":
        opts.listOnly = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "-h":
      case "--help":
        return { ok: true, options: { helpRequested: true } as InstallCommandOptions };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${USAGE}` };
        positional.push(a);
    }
  }

  // `--os` is a preview knob, not a cross-OS writer: resolveInstallPath
  // builds `absolute` from THIS machine's home dir / APPDATA / separators
  // and only the `display` string is target-OS-shaped, so a real cross-OS
  // run would mkdir a junk host-shaped tree (e.g. `C:\Users\me\Library\
  // Application Support\Claude\...` for `--os macos` on Windows) and then
  // report Done. Refuse at the flag boundary; `--dry-run` and `--list`
  // stay available for previewing another OS. runInstall itself keeps
  // accepting any os/home combination — that pairing is the hermetic test
  // seam, and index.ts always routes users through this parser.
  if (opts.os && opts.os !== CURRENT_OS && !opts.dryRun && !opts.listOnly) {
    return {
      ok: false,
      error:
        `yaw-mcp install: --os ${opts.os} does not match this machine (${CURRENT_OS}), and install can only ` +
        `resolve config paths for the machine it runs on -- a cross-OS write would create a ${CURRENT_OS}-shaped ` +
        `junk tree. Add --dry-run to preview, or run install on the ${opts.os} machine itself.`,
    };
  }

  // --list and --all skip the positional-client requirement. They apply
  // across every configured client on the current OS. Passing both +
  // a positional client is ambiguous — refuse early.
  if (opts.listOnly || opts.all) {
    if (positional.length > 0) {
      return {
        ok: false,
        error: `yaw-mcp install: ${opts.listOnly ? "--list" : "--all"} does not take a client argument.\n${USAGE}`,
      };
    }
    // --list never writes, so a write-decision flag passed with it is an
    // intent that gets silently dropped -- the same class as --all --scope
    // below. --dry-run is deliberately still ACCEPTED: --list is already
    // read-only, and the cross-OS guard above documents `--os <other>
    // --dry-run` as the preview spelling, so refusing it would break a
    // combination this parser advertises.
    if (opts.listOnly && (opts.force || opts.skip)) {
      const flag = opts.force ? "--force" : "--skip";
      return {
        ok: false,
        error: `yaw-mcp install: --list never writes a file, so it cannot honor ${flag}. Drop ${flag}, or install the client you want.\n${USAGE}`,
      };
    }
    // Same class again: --list enumerates EVERY scope of every client (that is
    // the report), so a --scope narrows nothing and is dropped on the floor.
    // Refuse it rather than print a full table under a flag the user passed to
    // filter it.
    if (opts.listOnly && opts.scope) {
      return {
        ok: false,
        error: `yaw-mcp install: --list reports every scope, so it cannot honor --scope. Drop --scope, or install a client at that scope.\n${USAGE}`,
      };
    }
    // --all plans its own scope per client (user where available), so an
    // explicit --scope would be silently discarded for every client but
    // the project-only ones. Refuse instead of ignoring: a flag that is
    // accepted and dropped reads as honored.
    if (opts.all && opts.scope) {
      return {
        ok: false,
        error: `yaw-mcp install: --all chooses each client's scope itself and cannot honor --scope. Install the client you want at a specific scope individually.\n${USAGE}`,
      };
    }
    // The same class once more, and newly reachable: every client in
    // INSTALL_TARGETS now carries a user scope, so --all plans every one of
    // them at user scope and hands `projectDir: undefined` to each
    // sub-install. The flag would parse, print nothing and change nothing.
    // (Before VS Code gained a user scope it was the one client --all could
    // only reach WITH this flag, which is why it used to be honored.)
    if (opts.all && opts.projectDir) {
      return {
        ok: false,
        error: `yaw-mcp install: --all installs every client at its user scope, so --project-dir would be dropped. Write a workspace file directly: \`yaw-mcp install vscode --scope project --project-dir <path>\`.\n${USAGE}`,
      };
    }
    return { ok: true, options: opts as InstallCommandOptions };
  }

  if (positional.length !== 1)
    return { ok: false, error: `Expected exactly one client argument, got ${positional.length}.\n${USAGE}` };
  const clientId = positional[0] as InstallClientId;
  if (!INSTALL_TARGETS.some((t) => t.clientId === clientId)) {
    return {
      ok: false,
      error: `Unknown client: ${clientId}. Choose: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}`,
    };
  }
  opts.clientId = clientId;
  return { ok: true, options: opts as InstallCommandOptions };
}

/** `yaw-mcp install --list` — print every client/scope combo for the current
 *  OS and whether yaw-mcp is already wired up. Read-only: never
 *  touches a file, never hits the network, works without a token. The
 *  exit code is always 0; this is diagnostic, not gating. */
async function runInstallList(
  opts: InstallCommandOptions,
  log: (s: string) => void,
  messages: string[],
): Promise<InstallResult> {
  // `log` already appends to `messages` (it is runInstall's closure), so the
  // returned trail is exactly what was printed -- deprecation warnings from
  // before the dispatch included. An earlier local array here captured only
  // the rows below and dropped everything else.
  const home = opts.home ?? homedir();
  // Honor --project-dir like the single-client install path does
  // (install-cmd resolves projectDir ?? cwd for the write), so `install
  // --list --project-dir /repo` reports the same files `install vscode
  // --project-dir /repo` would write -- accepting the flag and probing
  // process.cwd() instead made the two surfaces disagree.
  // Resolved exactly like the write path above: a relative --project-dir is
  // taken against the cwd override, not the real process.cwd(), so `--list`
  // and `install <client> --project-dir <rel>` name the same directory.
  const cwd = resolve(opts.cwd ?? process.cwd(), opts.projectDir ?? ".");
  const os = opts.os ?? CURRENT_OS;
  const probes = await probeClientsAsync({
    home,
    os,
    cwd,
    claudeConfigDir: opts.claudeConfigDir,
    appData: resolveAppData(opts),
  });

  const rows = probes.map((p) => ({
    client: INSTALL_TARGETS.find((t) => t.clientId === p.clientId)?.label ?? p.clientId,
    scope: p.scope,
    path: displayPath(p.path, home, os),
    status: statusFor(p),
  }));

  const installed = probes.filter((p) => p.hasMcpEntry).length;
  const available = probes.filter((p) => !p.unavailable).length;
  log(`${installed}/${available} client scopes have yaw-mcp configured on ${os}.`);
  log("");

  const widths = {
    client: Math.max("CLIENT".length, ...rows.map((r) => r.client.length)),
    scope: Math.max("SCOPE".length, ...rows.map((r) => r.scope.length)),
    path: Math.max("PATH".length, ...rows.map((r) => r.path.length)),
    status: Math.max("STATUS".length, ...rows.map((r) => r.status.length)),
  };
  const header =
    `  ${"CLIENT".padEnd(widths.client)}  ` +
    `${"SCOPE".padEnd(widths.scope)}  ` +
    `${"PATH".padEnd(widths.path)}  ` +
    `${"STATUS".padEnd(widths.status)}`;
  log(header);
  for (const r of rows) {
    log(
      `  ${r.client.padEnd(widths.client)}  ` +
        `${r.scope.padEnd(widths.scope)}  ` +
        `${r.path.padEnd(widths.path)}  ` +
        `${r.status.padEnd(widths.status)}`,
    );
  }
  log("");
  log("Install into a specific client: `yaw-mcp install <client> [--scope user|project|local]`");
  log("Install into every supported client (user scope where supported): `yaw-mcp install --all`");
  return { written: [], wouldWrite: [], messages, exitCode: 0 };
}

function statusFor(p: ClientProbeResult): string {
  // A client that ships on this OS but has no documented path for the config
  // file yaw-mcp writes is not "unavailable" -- the user may be running it.
  // `doctor` prints the reason.
  if (p.unavailable) return p.unavailableReason !== undefined ? "not supported yet" : "unavailable";
  if (p.malformed) return "malformed";
  // A READ failure (a directory at the path, EACCES, a win32 EBUSY from an
  // indexer) is not a syntax error: the probe reports it separately so the
  // row does not send the user to fix JSON that may be perfectly fine, and so
  // it does not fall through to "other-entries" as if the file had been read.
  if (p.unreadable) return `unreadable: ${p.unreadable}`;
  if (p.hasMcpEntry) return "installed";
  // A file whose only yaw-mcp wiring is a PRE-RENAME entry is an upgrade
  // pending, not somebody else's config: `install <client>` has something
  // specific to do there (write `mcp`, then tell the user to trim the old key).
  // Folding it into "other-entries" threw away the probe's own
  // hasLegacyEntry/legacyEntryName and left the row indistinguishable from a
  // config that has nothing to do with yaw-mcp.
  if (p.hasLegacyEntry) return `legacy: ${p.legacyEntryName ?? "unknown"}`;
  if (!p.exists) return "not installed";
  // `other-entries` promises OTHER SERVERS in the list this row reads -- the
  // slot's container object (`mcpServers`; `servers` for VS Code;
  // `projects[<dir>].mcpServers` for Claude Code's local scope), not the
  // whole file, and the --list help defines it that way -- and a file merely
  // existing does not deliver that: `uninstall` of the only entry leaves an
  // empty `{"mcpServers": {}}`, a client config can exist for its other
  // settings with no server object at all, and Claude Code's user and local
  // rows read the same .claude.json, so a server in one row's list is not in
  // the other's. Every such row used to read `other-entries`, claiming
  // servers its list does not have.
  return p.containerEntries > 0 ? "other-entries" : "no-entries";
}

// `os` is the os being LISTED, not process.platform: --list is the one install
// surface that reports another machine's layout (the cross-OS refusal in
// parseInstallArgs exempts it), and keying the separator on the host made
// `--list --os linux` on Windows print a backslash-joined `~` path -- a shape
// the listed os never uses.
//
// EVERY separator is rewritten, not just the leading one. resolveInstallPath
// builds `absolute` with node:path on the HOST (only its sibling `display`
// string is target-shaped), so fixing the head alone printed `~/.cursor\mcp.json`
// -- mixed, and still a shape neither OS uses. Presentation only: the row is
// rooted in THIS machine's home dir either way, which is why a cross-OS write
// is refused and only --list / --dry-run ever reach here.
function displayPath(abs: string, home: string, os: InstallOS): string {
  // The match itself -- separator-agnostic, case-folded where the filesystem
  // is, anchored on a separator so a sibling like `C:\Users\jeff-old` never
  // renders as `~\-old\...` -- lives in tildePath (paths.ts), so the next
  // home-relative display reuses it instead of re-deriving it with a raw
  // prefix compare; src/tests/home-prefix-compare.test.ts scans for one. The
  // `(n/a)` sentinel is not absolute, so it comes back exactly as it went in.
  return tildePath(abs, home, os === "windows" ? "\\" : "/");
}

/** `yaw-mcp install --all` — install into every client yaw-mcp supports on
 *  this OS (user scope where supported), naming any it skips -- including a
 *  client that ships here but has no documented path for the config file
 *  yaw-mcp writes (`notConfigurableOn`). For clients without a user scope,
 *  falls back to the first non-project scope; clients that ONLY have project
 *  scopes (vscode) are included just when --project-dir is passed, otherwise
 *  skipped. Mirrors the per-client run behavior: prompts and
 *  --force/--repair/--skip propagate, so `--all --force` drops each entry's
 *  env exactly as a per-client --force does.
 *
 *  Exit code, aggregated from the per-client results:
 *    0  every planned client succeeded -- written, already correct, or left
 *       alone by --skip / a "skip" answer.
 *    2  nothing failed, but at least one client was REFUSED: a differing entry
 *       with no TTY to ask on and no --force/--repair/--skip or --dry-run to
 *       answer it. The code the single-client refusal returns, for the same
 *       reason: a script can tell "re-run with a flag" from "the write failed"
 *       without parsing prose.
 *    1  at least one client failed outright (an unreadable or malformed
 *       config, a refused write, an abort or cancel at the prompt), refused
 *       clients or not -- a flag alone will not make that run succeed. */
async function runInstallAll(
  opts: InstallCommandOptions,
  log: (s: string) => void,
  err: (s: string) => void,
  messages: string[],
): Promise<InstallResult> {
  const os = opts.os ?? CURRENT_OS;
  const targets = INSTALL_TARGETS.filter((t) => t.availableOn.includes(os));
  if (targets.length === 0) {
    err(`yaw-mcp install --all: no installable clients on ${os}.`);
    // `messages`, not [] -- the err() above (and any deprecation warning
    // before the dispatch) belongs in the returned trail.
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }

  // Pick one scope per client: user where supported, else the first
  // non-project-dir scope. Clients that ONLY have project-dir scopes
  // (vscode) are included only when --project-dir was passed.
  // `usesProjectDir` rides along per plan because runInstall now REFUSES a
  // --project-dir the resolved scope would silently drop. Under `--all
  // --project-dir` most plans are user-scoped and only the project-only client
  // reads the flag, so each sub-install is handed just the flags its own scope
  // consults (see the recursion below).
  type Plan = { clientId: InstallClientId; scope: InstallScope; usesProjectDir: boolean };
  const plans: Plan[] = [];
  const skipped: Array<{ clientId: InstallClientId; reason: string }> = [];
  // A client that ships on this OS but that yaw-mcp cannot configure is named
  // rather than silently left out: on a Linux box running the Claude Desktop
  // beta, `--all` otherwise reads as having forgotten it. No availableOn
  // check: a reason is only ever recorded for an OS missing from
  // `availableOn` (install-targets.test.ts pins that), so a client skipped
  // here is never also one of `targets`.
  for (const t of INSTALL_TARGETS) {
    const why = t.notConfigurableOn?.[os];
    if (why !== undefined) skipped.push({ clientId: t.clientId, reason: why });
  }
  for (const t of targets) {
    const userScope = t.scopes.find((s) => s.scope === "user");
    if (userScope) {
      plans.push({ clientId: t.clientId, scope: "user", usesProjectDir: userScope.requiresProjectDir });
      continue;
    }
    const firstNoProj = t.scopes.find((s) => !s.requiresProjectDir);
    if (firstNoProj) {
      plans.push({ clientId: t.clientId, scope: firstNoProj.scope, usesProjectDir: false });
      continue;
    }
    if (opts.projectDir) {
      plans.push({ clientId: t.clientId, scope: t.scopes[0].scope, usesProjectDir: t.scopes[0].requiresProjectDir });
      continue;
    }
    skipped.push({
      clientId: t.clientId,
      reason: `requires --project-dir (scopes: ${t.scopes.map((s) => s.scope).join(", ")})`,
    });
  }

  log(`Installing into ${plans.length} client${plans.length === 1 ? "" : "s"}...`);
  if (skipped.length > 0) {
    for (const s of skipped) log(`  skip ${s.clientId}: ${s.reason}`);
  }
  log("");

  const aggregateWritten: string[] = [];
  const aggregateWouldWrite: string[] = [];
  let failed = 0;
  let succeeded = 0;
  // Clients whose sub-install stopped at the off-TTY collision refusal. Kept
  // apart from `failed` because nothing went wrong for them: the run needs an
  // answer only a flag can give, which is what exit 2 says (see the contract
  // above). Each prints its own file and diff under its header
  // (deferCollisionHint); the part they all share -- no TTY, and the flags
  // that answer it -- prints ONCE below instead of N identical times.
  const refusedClients: string[] = [];
  for (const plan of plans) {
    log(`-- ${plan.clientId} (${plan.scope}) --`);
    const result = await runInstall({
      ...opts,
      listOnly: false,
      all: false,
      // Strip the deprecated flags: runInstall warns about them at the top
      // of every call, and the --all entry point has already warned once.
      // Without this the user gets one notice per client.
      token: undefined,
      skipYawMcpConfig: undefined,
      // Same consolidation, one line down: printed once after the loop.
      suppressOamAbsentNote: true,
      suppressBundlesNote: true,
      // And the collision refusal's shared half, printed once after the loop.
      deferCollisionHint: true,
      clientId: plan.clientId,
      scope: plan.scope,
      // Only the plans whose scope actually resolves a path from --project-dir
      // get it. runInstall refuses the flag for a scope that would drop it, so
      // passing the parent's copy to every client would fail each user-scope
      // one the moment --project-dir was passed to pull the project-only
      // client (vscode) into the run.
      projectDir: plan.usesProjectDir ? opts.projectDir : undefined,
    });
    aggregateWritten.push(...result.written);
    aggregateWouldWrite.push(...result.wouldWrite);
    // Splice each sub-install's trail in right where it printed, between this
    // client's header and the blank line that closes it. It goes in whole:
    // `messages` is documented as exactly what was printed, and nothing a
    // sub-install prints is filtered on the way out any more.
    messages.push(...result.messages);
    if (result.exitCode === 0) succeeded += 1;
    else if (result.collisionRefused) refusedClients.push(plan.clientId);
    else failed += 1;
    log("");
  }

  // The single copy the per-client suppression above defers to. Probed here
  // rather than threaded out of the loop because probeOam is cached for the
  // process lifetime, so this is a cache hit, and the test hook has to be
  // honoured on this path too or a fixture-driven --all run would consult the
  // real machine. Only the ABSENT case: every other Runtime reason still prints
  // per client, where it belongs.
  // Gated on the run leaving at least one entry in place: the note is a
  // runtime tip ABOUT the entries yaw-mcp is wired into, so on an
  // all-refused / all-failed run it printed advice for entries that do not
  // exist -- immediately above the collision hint and the failure summary.
  //
  // `succeeded > 0` is part of the test, not just the written/would-write
  // lists. Under `--all --skip` a client that ALREADY has an entry is a
  // success that writes nothing, so a fully-successful all-skip run has both
  // lists empty -- and gating on those alone made the tip vanish from exactly
  // the run where every entry it describes is present and about to be used.
  const runLeftAnEntry = aggregateWritten.length > 0 || aggregateWouldWrite.length > 0 || succeeded > 0;
  if (runLeftAnEntry) {
    if (oamIsAbsent(await (opts.oamProbe ?? probeOam)())) log(oamAbsentNote(os, opts.oamPublishesBinary));
    // The single copy the per-client suppression defers to. Same gate as the
    // runtime tip above and for the same reason: on an all-refused run there are
    // no entries for it to describe. An all-SKIP run is a success that writes
    // nothing (`succeeded > 0` carries it), and that is exactly the run where
    // every entry the line describes is present and about to be used.
    //
    // The empty `names` is what makes the emitter print only the bundles half:
    // the direct-entries half already printed inside each client's section,
    // where it belongs, because each plan writes a different file.
    const bundles = await Promise.resolve(
      (opts.bundlesSummary ?? summarizeBundles)({ home: opts.home, cwd: opts.cwd }),
    ).catch(() => null);
    logInstallTail(log, err, { names: [], where: "", clientLabel: "" }, bundles);
  }

  const refused = refusedClients.length;
  const them = refused === 1 ? "it" : "them";
  const theirEnv = refused === 1 ? "in its env" : "in each entry's env";
  if (refused > 0) {
    // --repair first, as in the single-client refusal: it is the flag
    // INSTALL_USAGE documents for an entry that has drifted from what install
    // writes, and a differing entry is the only thing that refuses here. It is
    // also the flag that brings every entry up to date WITHOUT the env loss
    // --force now carries; this hint used to name --force alone, the one
    // copy-paste that would strip a vault passphrase out of every client at
    // once. The env clause is unconditional here, unlike the per-client hint,
    // because the refusals are consolidated: runInstallAll sees only
    // `collisionRefused`, not each sub-install's carried keys.
    err(
      `yaw-mcp install --all: ${refused} client${refused === 1 ? " already has" : "s already have"} a differing "${ENTRY_NAME}" entry (${refusedClients.join(", ")}) and stdin is not a TTY.\n` +
        `  Re-run \`yaw-mcp install --all --repair\` to bring ${them} up to date (keeping the string values ${theirEnv}), \`--force\` to overwrite ${them} outright (dropping all of it), \`--skip\` to leave ${them} untouched, or \`--dry-run\` to preview.`,
    );
  }

  const totalPlanned = plans.length;
  const plural = (n: number): string => (n === 1 ? "" : "s");
  if (failed === 0 && refused === 0) {
    // A dry run wrote nothing, so it must not close on "installed
    // successfully" -- the last line of the transcript is the one a user reads
    // as the verdict.
    log(
      opts.dryRun
        ? `Dry run: ${succeeded}/${totalPlanned} client${plural(totalPlanned)} would be installed; nothing written.`
        : `Done: ${succeeded}/${totalPlanned} client${plural(totalPlanned)} installed successfully.`,
    );
    return { written: aggregateWritten, wouldWrite: aggregateWouldWrite, messages, exitCode: 0 };
  }
  // Failures and refusals are counted apart, in the prose as in the exit code.
  // (A dry run takes the overwrite branch of the collision ladder, so it never
  // refuses; the dry-run wording below still covers the pair generically.)
  const noun = opts.dryRun ? "preview" : "install";
  const whatFailed = `${failed}/${totalPlanned} client ${noun}${plural(failed)} failed`;
  const whatRefused = `${refused === 1 ? "was" : "were"} refused (see the flags above)`;
  const notDone =
    failed === 0
      ? `${refused}/${totalPlanned} client ${noun}${plural(refused)} ${whatRefused}.`
      : refused === 0
        ? `${whatFailed}.`
        : `${whatFailed} and ${refused} ${whatRefused}.`;
  const tail = opts.dryRun ? `${succeeded} would be installed; nothing written.` : `${succeeded} succeeded.`;
  err(`${opts.dryRun ? "Dry run: " : ""}${notDone} ${tail}`);
  return {
    written: aggregateWritten,
    wouldWrite: aggregateWouldWrite,
    messages,
    exitCode: failed > 0 ? 1 : 2,
  };
}

export const INSTALL_USAGE = USAGE;

// ---------------------------------------------------------------------------
// `yaw-mcp uninstall <client>` -- the subtract side of install.
//
// Lives in this file rather than its own because it is the same operation run
// backwards: the same client/scope/OS resolution (resolveInstallSite), the same
// container path, the same comment-preserving JSONC edit, the same
// fingerprint-before-publish discipline, and the same best-effort
// permissions.allow patch with `op: "remove"`. Split across two modules, those
// would be two places to keep agreeing about where a client's config lives --
// the drift resolveAppDataDir exists to prevent.
//
// Failure semantics, deliberately NOT install's:
//   - No file / no entry            -> "nothing to do", exit 0. A subtract that
//                                      refuses to no-op cannot be scripted, and
//                                      cleanup scripts are its main caller.
//   - Something to remove, no TTY,
//     no --force                    -> refuse with exit 2 (a required flag is
//                                      missing -- this CLI's usage code), after
//                                      printing what it WOULD have removed.
//   - Prompt declined               -> exit 1. The argv was fine; the user said
//                                      no.
//   - Malformed JSON                -> refuse, point at the file. Same as
//                                      install: never rewrite bytes we could
//                                      not parse.
// ---------------------------------------------------------------------------

const UNINSTALL_USAGE =
  // Every client INSTALL_TARGETS carries, because that array is what the
  // parser validates against -- uninstall has accepted windsurf and gemini-cli
  // since they were added to it, and a usage line naming only the first four
  // reads as a refusal that never happens.
  `Usage: yaw-mcp uninstall <${INSTALL_TARGETS.map((t) => t.clientId).join("|")}> [--scope user|project|local]\n` +
  "                         [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                         [--force | -y] [--keep-legacy] [--dry-run]\n" +
  "\n" +
  `  Removes the "${ENTRY_NAME}" entry from the client's config, and for Claude Code drops\n` +
  `  ${CLAUDE_CODE_ALLOW_PATTERN} from permissions.allow. A pre-rename entry (${LEGACY_ENTRY_NAMES.join(", ")})\n` +
  "  goes with it unless --keep-legacy is passed.\n" +
  "\n" +
  "  Nothing to remove is exit 0, not an error. Comments and every unrelated key in the\n" +
  "  file are preserved. Local servers in ~/.yaw-mcp/bundles.json are untouched --\n" +
  "  this unwires the CLIENT, it does not delete your configuration.";

export interface UninstallCommandOptions {
  clientId?: InstallClientId;
  scope?: InstallScope;
  os?: InstallOS;
  projectDir?: string;
  /** Skip the confirmation prompt. REQUIRED off a TTY when there is something
   *  to remove -- same gate `yaw-mcp remove` and `secrets remove` use. */
  force?: boolean;
  /** Leave a pre-rename legacy entry in place. Mirrors install's flag: the
   *  default on both sides is that the old key goes. */
  keepLegacy?: boolean;
  /** Print what would be removed and exit without writing. Implies no prompt --
   *  a preview mutates nothing, so there is nothing to confirm. */
  dryRun?: boolean;
  /** Override for tests; defaults to homedir(). */
  home?: string;
  /** Override for tests; see InstallCommandOptions.appData. */
  appData?: string;
  /** Override for tests; defaults to process.cwd(). */
  cwd?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`; see InstallCommandOptions. */
  claudeConfigDir?: string;
  io?: InstallCommandOptions["io"];
  /** Override for tests; replaces the interactive prompt with a fixed answer. */
  promptAnswer?: string;
  helpRequested?: boolean;
}

export function parseUninstallArgs(
  argv: string[],
): { ok: true; options: UninstallCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: UNINSTALL_USAGE };
  const positional: string[] = [];
  const opts: Partial<UninstallCommandOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--scope": {
        const v = next();
        if (!v || !["user", "project", "local"].includes(v))
          return { ok: false, error: "--scope requires user|project|local" };
        opts.scope = v as InstallScope;
        break;
      }
      case "--os": {
        const v = next();
        if (!v || !["macos", "linux", "windows"].includes(v))
          return { ok: false, error: "--os requires macos|linux|windows" };
        opts.os = v as InstallOS;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v || looksLikeFlag(v)) return { ok: false, error: "--project-dir requires a value" };
        opts.projectDir = v;
        break;
      }
      // Both spellings, for the reason parseRemoveArgs accepts both: `--force`
      // is what `secrets remove` takes and `-y` is what `trust` takes, and a
      // user should not have to remember which destructive verb took which.
      case "--force":
      case "--yes":
      case "-y":
        opts.force = true;
        break;
      case "--keep-legacy":
        opts.keepLegacy = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        return { ok: false, error: UNINSTALL_USAGE, help: true };
      default:
        // Single dash included: `-y` is a real flag here, so a mistyped short
        // one must be reported rather than become the client argument.
        if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${UNINSTALL_USAGE}` };
        positional.push(a);
    }
  }

  // Same cross-OS gate as install, and for the same reason: resolveInstallPath
  // builds `absolute` from THIS machine's home dir / APPDATA / separators, so a
  // cross-OS run would name a host-shaped junk path. Removing an entry from a
  // file that does not exist is a harmless no-op -- but reporting "nothing to
  // do" for the macOS config while standing on Windows is a WRONG answer, not a
  // harmless one, and that is what the guard prevents.
  if (opts.os && opts.os !== CURRENT_OS && !opts.dryRun) {
    return {
      ok: false,
      error:
        `yaw-mcp uninstall: --os ${opts.os} does not match this machine (${CURRENT_OS}), and uninstall can only ` +
        `resolve config paths for the machine it runs on -- it would report on a ${CURRENT_OS}-shaped junk path. ` +
        `Add --dry-run to preview, or run uninstall on the ${opts.os} machine itself.`,
    };
  }

  if (positional.length !== 1)
    return { ok: false, error: `Expected exactly one client argument, got ${positional.length}.\n${UNINSTALL_USAGE}` };
  const clientId = positional[0] as InstallClientId;
  if (!INSTALL_TARGETS.some((t) => t.clientId === clientId)) {
    return {
      ok: false,
      error: `Unknown client: ${clientId}. Choose: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}`,
    };
  }
  opts.clientId = clientId;
  return { ok: true, options: opts as UninstallCommandOptions };
}

/** Render an entry's launch line for the removal preview. Command + args only,
 *  never `env` VALUES -- README tells users to keep YAW_MCP_VAULT_PASSPHRASE in
 *  that block, and this preview is printed on a terminal. Same rule
 *  describeEntryDiff and DRY_RUN_ENV_PLACEHOLDER follow. */
function renderEntryLaunch(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return `(${describeJsonShape(entry)})`;
  }
  const e = entry as { command?: unknown; args?: unknown };
  const command = typeof e.command === "string" ? e.command : "";
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : [];
  const parts = [command, ...args].filter((p) => p.length > 0);
  return parts.length > 0 ? `$ ${parts.join(" ")}` : "(no command)";
}

/** KEY names of an entry's `env`, or [] when it has none / is not an object. */
function entryEnvKeys(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
  const env = (entry as { env?: unknown }).env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return [];
  return Object.keys(env as Record<string, unknown>).sort();
}

/** Ask the removal confirmation. Defaults to NO -- only an explicit y/yes
 *  proceeds, so a bare Enter, a stray keystroke, or EOF (^D, a pipe running
 *  dry) leaves the config untouched. EOF is questionOrEmpty's job for the same
 *  reason install's collision prompt uses it: a bare rl.question() never
 *  settles once its input closes, and the command would hang instead of taking
 *  its default. Ctrl+C stays a distinct answer, exit 130. */
async function promptUninstall(
  question: string,
  io: UninstallCommandOptions["io"],
): Promise<"yes" | "no" | "cancelled"> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout, terminal: io?.terminal });
  try {
    const raw = await questionOrEmpty(rl, question);
    if (raw === QUESTION_CANCELLED) return "cancelled";
    return raw.trim().toLowerCase().startsWith("y") ? "yes" : "no";
  } finally {
    rl.close();
  }
}

export async function runUninstall(opts: UninstallCommandOptions): Promise<InstallResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const messages: string[] = [];
  const log = (s: string): void => {
    messages.push(s);
    stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    messages.push(s);
    stderr.write(`${s}\n`);
  };

  if (!opts.clientId) {
    err(`yaw-mcp uninstall: client argument required\n${UNINSTALL_USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }
  const site = resolveInstallSite("uninstall", opts, err);
  if (!site) return { written: [], wouldWrite: [], messages, exitCode: 2 };
  const { target, scope, projectDir, resolved } = site;

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  const containerPath = resolved.containerPath;
  let existing: Record<string, unknown> = {};
  let rawClient: string | null = null;
  let storedEntry: unknown;
  let hasEntry = false;
  let legacyEntry: string | null = null;
  // Fingerprinted BEFORE the read and compared again ahead of the write, for
  // exactly install's reason: ~/.claude.json is a file Claude Code itself
  // rewrites during a session, and the prompt below waits on a human.
  const fingerprintBefore = await fileFingerprint(resolved.absolute);
  if (fingerprintBefore !== null) {
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      err(describeUnreadableConfig("uninstall", resolved.absolute, e));
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          err(
            `yaw-mcp uninstall: ${resolved.absolute} is not a JSON object -- refusing to edit. Remove the "${ENTRY_NAME}" entry by hand.`,
          );
          return { written: [], wouldWrite: [], messages, exitCode: 1 };
        }
        existing = parsed as Record<string, unknown>;
        rawClient = raw;
      } catch (e) {
        err(
          `yaw-mcp uninstall: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to edit. Fix the file and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
    }
    const container = readNested(existing, containerPath);
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const c = container as Record<string, unknown>;
      hasEntry = ENTRY_NAME in c;
      storedEntry = c[ENTRY_NAME];
      legacyEntry = findLegacyEntry(c);
    }
  }

  // Leaving a legacy entry behind would keep the client launching yaw-mcp
  // after a command whose whole job is to stop that -- the same
  // duplicate-broker hazard install now trims, seen from the other side.
  const trimLegacy = legacyEntry !== null && !opts.keepLegacy;

  const home = opts.home ?? homedir();
  // Computed even when the client config has nothing to remove: the entry and
  // the grant can fall out of sync (a hand-deleted entry, an interrupted
  // earlier run), and a lingering `mcp__mcp__*` in a global allow-list is
  // precisely the leftover this subcommand exists to clean up.
  const settingsPatch =
    opts.clientId === "claude-code"
      ? await prepareClaudeCodeSettingsPatch({
          scope,
          home,
          projectDir,
          claudeConfigDir: opts.claudeConfigDir,
          op: "remove",
        })
      : null;
  if (settingsPatch?.malformed) {
    err(
      `yaw-mcp uninstall: warning -- could not patch ${settingsPatch.path} (${settingsPatch.malformedReason}); left unchanged. Remove "${CLAUDE_CODE_ALLOW_PATTERN}" from permissions.allow by hand.`,
    );
  }

  if (!hasEntry && !trimLegacy && !settingsPatch?.changed) {
    // Exit 0, not an error: a subtract that cannot no-op cannot be scripted,
    // and re-running uninstall is the shape a cleanup script takes.
    log(`\nNothing to do: ${target.label} (${scope}) has no yaw-mcp entry.`);
    return { written: [], wouldWrite: [], messages, exitCode: 0 };
  }

  // What is about to go, shown to the prompt AND to the off-TTY refusal -- a
  // scripted run gets to read the preview before being told which flag it
  // needed, the courtesy `yaw-mcp remove` already extends.
  const preview: string[] = [];
  if (hasEntry) {
    preview.push(`entry:    "${ENTRY_NAME}"`);
    preview.push(`launch:   ${renderEntryLaunch(storedEntry)}`);
    const envKeys = entryEnvKeys(storedEntry);
    if (envKeys.length > 0) preview.push(`env keys: ${envKeys.join(", ")} (values go with the entry)`);
  }
  if (trimLegacy) preview.push(`legacy:   "${legacyEntry}" (also removed; --keep-legacy leaves it)`);
  if (settingsPatch?.changed) preview.push(`grant:    ${CLAUDE_CODE_ALLOW_PATTERN} from ${settingsPatch.path}`);

  if (opts.dryRun) {
    log(`\n--- dry run: would remove the following (the rest of each file is left as-is) ---`);
    for (const line of preview) log(`    ${line}`);
    const wouldWrite: string[] = [];
    if (hasEntry || trimLegacy) wouldWrite.push(resolved.absolute);
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  if (!opts.force) {
    log(`\n  Remove from ${resolved.absolute}:`);
    log("");
    for (const line of preview) log(`    ${line}`);
    log("");
    const interactive =
      opts.promptAnswer !== undefined ||
      (opts.io?.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)));
    if (!interactive) {
      // Exit 2, matching `yaw-mcp remove` and `secrets remove`: a required flag
      // is missing, which is this CLI's usage-error code. A DECLINED prompt is
      // exit 1 below -- the argv was fine, the user said no.
      err(
        `yaw-mcp uninstall: refusing to unwire ${target.label} (${scope}) without a confirmation -- stdin/stdout is not a TTY.`,
      );
      err("  Re-run with --force (or -y) to remove it.");
      return { written: [], wouldWrite: [], messages, exitCode: 2 };
    }
    const answer =
      opts.promptAnswer !== undefined
        ? opts.promptAnswer.trim().toLowerCase().startsWith("y")
          ? "yes"
          : "no"
        : await promptUninstall(`  Remove it? [y/N] `, opts.io);
    if (answer === "cancelled") {
      err("Cancelled.");
      return { written: [], wouldWrite: [], messages, exitCode: 130 };
    }
    if (answer !== "yes") {
      err("Aborted.");
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  }

  let clientJson: string | null = null;
  if (rawClient !== null && (hasEntry || trimLegacy)) {
    try {
      let next = rawClient;
      // Both removals in ONE pass so the file never lands on disk holding one
      // key without the other, and both as splices (jsonc.ts) so the user's
      // comments and formatting survive.
      if (hasEntry) next = removeJsoncEntry(next, containerPath, ENTRY_NAME);
      if (trimLegacy) next = removeJsoncEntry(next, containerPath, legacyEntry as string);
      clientJson = next.endsWith("\n") ? next : `${next}\n`;
    } catch (e) {
      err(
        `yaw-mcp uninstall: failed to remove the "${ENTRY_NAME}" entry from ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  }

  const written: string[] = [];
  if (clientJson !== null) {
    if (!sameFingerprint(fingerprintBefore, await fileFingerprint(resolved.absolute))) {
      err(
        `yaw-mcp uninstall: ${resolved.absolute} changed while uninstall was running (another process wrote it) -- nothing was written. Re-run uninstall.`,
      );
      return { written, wouldWrite: [], messages, exitCode: 1 };
    }
    try {
      await atomicWriteFile(resolved.absolute, clientJson);
    } catch (e) {
      err(`yaw-mcp uninstall: failed to write ${resolved.absolute}: ${(e as Error).message}`);
      return { written, wouldWrite: [], messages, exitCode: 1 };
    }
    log(`Wrote ${resolved.absolute}`);
    written.push(resolved.absolute);
    if (hasEntry) log(`Removed the "${ENTRY_NAME}" entry.`);
    if (trimLegacy) log(`Removed the legacy "${legacyEntry}" entry.`);
  }

  // Best-effort, exactly like install's patch: the entry is already gone, and a
  // stale allow-pattern costs the user nothing but a dead line in a config.
  if (settingsPatch?.changed) {
    if (!sameFingerprint(settingsPatch.fingerprint, await fileFingerprint(settingsPatch.path))) {
      err(
        `yaw-mcp uninstall: warning -- ${settingsPatch.path} changed while uninstall was running (another process wrote it); left unchanged. Remove "${CLAUDE_CODE_ALLOW_PATTERN}" from permissions.allow by hand.`,
      );
    } else {
      try {
        await atomicWriteFile(settingsPatch.path, settingsPatch.nextJson);
        log(`Wrote ${settingsPatch.path} (removed ${CLAUDE_CODE_ALLOW_PATTERN} from permissions.allow)`);
        written.push(settingsPatch.path);
      } catch (e) {
        err(
          `yaw-mcp uninstall: warning -- failed to patch ${settingsPatch.path}: ${(e as Error).message}. Remove "${CLAUDE_CODE_ALLOW_PATTERN}" from permissions.allow by hand.`,
        );
      }
    }
  }

  // Names what was NOT touched on purpose: `uninstall` unwires a client, it
  // does not delete the user's servers. Without this line the obvious reading
  // of "uninstall" is that bundles.json went with it.
  log(
    `\nDone: ${target.label} no longer launches yaw-mcp. Restart it to drop the server. ` +
      "Your servers in ~/.yaw-mcp/bundles.json are untouched -- `yaw-mcp install " +
      `${target.clientId}` +
      "` wires it back.",
  );
  return { written, wouldWrite: [], messages, exitCode: 0 };
}
