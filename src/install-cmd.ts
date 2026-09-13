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

// `stat` only: the client config's BYTES are read by the client-config core
// now (readClientConfigFile), and this module's own read is the fingerprint
// that brackets the write.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { CLAUDE_CODE_ALLOW_PATTERN, prepareClaudeCodeSettingsPatch } from "./claude-code-settings.js";
import { clientChoices, resolveClientArg } from "./client-aliases.js";
import {
  applyClientConfigEdits,
  type ClientConfigEdit,
  type ConfigSite,
  classifyClientConfig,
  composeEntry,
  containerKeysAt,
  describeValueShape,
  type EntryTransform,
  readClientConfigFile,
  reloadDoneClause,
  selectSites,
  siteAt,
  terminateWithNewline,
  unloadableConfigProblem,
} from "./client-config.js";
import { type ClientProbeResult, probeClientsAsync } from "./doctor-cmd.js";
import {
  blockedContainerFix,
  buildLaunchEntry,
  type ClientEnvValues,
  CURRENT_OS,
  claudeCodeContainerPathVariants,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  type InstallTarget,
  isProjectLocalEntry,
  type LaunchEntry,
  LEGACY_ENTRY_NAMES,
  resolveAppDataDir,
  type resolveInstallPath,
  resolveInstallSites,
  unloadableConfigFix,
  unparseableConfigFix,
} from "./install-targets.js";
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
  /** Every client env var, as `readClientEnv` reported it, threaded from the
   *  dispatcher. Only a MODULAR row reads it (Zed's $XDG_CONFIG_HOME, Cline's
   *  three knobs, Continue's global dir); the six inline rows take their one
   *  variable from `claudeConfigDir` above. Read by the dispatcher and never
   *  here, so a test that calls this runner directly stays hermetic. */
  clientEnv?: ClientEnvValues;
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
  /** The table `--all` plans from. Defaults to INSTALL_TARGETS, and no CLI
   *  flag sets it: it exists because INSTALL_TARGETS is a READONLY array --
   *  the append-only row order is an invariant `try`'s auto-detect depends on,
   *  so nothing may reorder or narrow it at runtime -- while one closing line
   *  ("1/1 client installed successfully") is reachable only from a plan of
   *  exactly one, and no OS plans one. Passing a narrower table here is how
   *  that line gets exercised without the test mutating the shared array. */
  targets?: readonly InstallTarget[];
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

// `directClientEntries` used to live here: "every key in this container that
// is somebody else's server", skipping our own entry and the pre-rename
// spellings of it, non-object values included. It is `view.otherServerKeys()`
// now -- the same rule, answered by the core off the site's own adapter, with
// one reader of the legacy-name list instead of two.

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
  // DERIVED, never a hand-kept list: `parseInstallArgs` validates against
  // `clientChoices("install")`, so a literal synopsis is a promise the parser
  // stops keeping the moment a client or an alias lands -- it reads as a
  // refusal that never happens.
  `Usage: yaw-mcp install <${clientChoices("install").join("|")}> [--scope user|project|local]\n` +
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
  // The two clients the remedy names are the FIRST TWO in table order that are
  // configurable on this OS and are not the one being refused -- not a
  // hand-kept pair. Table order is claude-code then cursor, so today's bytes
  // ("Claude Code or Cursor", "--client claude-code or --client cursor") are
  // reproduced exactly, and they stay put when a row is APPENDED. A literal
  // pair here would have to be re-judged by every landing client, and
  // "every configurable client" would rewrite the sentence each time.
  const alternatives = INSTALL_TARGETS.filter(
    (t) => t.clientId !== target.clientId && t.availableOn.includes(os) && t.notConfigurableOn?.[os] === undefined,
  ).slice(0, 2);
  const orList = (parts: string[]): string => parts.join(" or ");
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
      fix = `Pick another client, such as ${orList(
        alternatives.map((t) => `--client ${t.clientId}`),
      )}, or add the entry by hand.`;
      break;
    default:
      fix = `Install into ${orList(alternatives.map((t) => t.label))} instead, or add the entry by hand.`;
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
    clientEnv?: ClientEnvValues;
  },
  err: (s: string) => void,
): {
  target: (typeof INSTALL_TARGETS)[number];
  os: InstallOS;
  scope: InstallScope;
  projectDir: string | undefined;
  resolved: ReturnType<typeof resolveInstallPath>;
  /** Every file this (client, scope) reads and writes, in declaration order:
   *  one for every row but Cline, whose `sites` hook fans out to a shared
   *  file plus one copy per editor. `resolved` is the FIRST site's path, so a
   *  caller that speaks about one file still names the one it always did.
   *  `selectSites` is what drops a copy whose editor is not installed. */
  sites: ConfigSite[];
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
  let sites: ConfigSite[];
  try {
    // SITES, not one path: the file's syntax and its strictness come from the
    // row and the scope through this one resolve, so the read and the write
    // below cannot disagree about either. Every row but Cline answers with
    // exactly one site, whose `resolved` is byte-for-byte what
    // `resolveInstallPath` returns (asserted in install-targets.test.ts).
    sites = resolveInstallSites({
      clientId: target.clientId,
      scope,
      os,
      home: opts.home,
      appData: resolveAppDataDir({ appData: opts.appData, home: opts.home }),
      projectDir,
      claudeConfigDir: opts.claudeConfigDir,
      // A MODULAR row resolves its own path from these (Zed's
      // $XDG_CONFIG_HOME, Cline's three knobs, Continue's global dir). Read
      // once by the dispatcher; a row never reads process.env itself.
      clientEnv: opts.clientEnv,
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
  return { target, os, scope, projectDir, resolved: sites[0].resolved, sites };
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

  const plan = resolveInstallSite("install", opts, err);
  if (!plan) return { written: [], wouldWrite: [], messages, exitCode: 2 };
  const { target, os, scope, projectDir, resolved } = plan;

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  // Read + classify the existing client config THROUGH THE CORE. One reader
  // for every syntax, the strictness the site declared, and the entry-level
  // questions (is ours there, what is stored, is there a legacy key, which
  // other servers are wired directly) answered by the view rather than by a
  // container walk here. The user's bytes are preserved by the write facade
  // the same way they were by the direct splice this replaces: comments, key
  // order, indentation and the neighbouring entries all survive -- and now
  // the result is VERIFIED before install has anything to persist.
  const containerPath = resolved.containerPath;
  // The sites this machine actually has: every unconditional one, plus each
  // conditional one whose editor-storage directory exists. Every row but Cline
  // declares exactly one, so `extraSites` is empty for all of them and nothing
  // downstream of it runs.
  //
  // `sites[0]` stays THE site: the file every message names, the one the
  // collision ladder and the drift diff are about, and the one a fresh install
  // creates. The extras are COPIES of the same entry -- see applyToExtraSites.
  const selectedSites = selectSites(plan.sites);
  const site = selectedSites[0];
  const extraSites = selectedSites.slice(1);
  /** `projects[...]` keys that name THIS project with the other drive-letter
   *  case and already carry yaw-mcp wiring. Reported, never written to -- see
   *  claudeCodeContainerPaths for why install adds rather than migrates. */
  const driveCaseSiblings: { key: string; hasEntry: boolean; legacy: string | null }[] = [];
  // Fingerprinted BEFORE the read (never after: a write landing between a
  // read and a later stat would be carried forward under a fresh fingerprint)
  // and compared again right before atomicWriteFile -- see there for why. A
  // null fingerprint is "absent"; the read below reports ENOENT as `absent`
  // too, and a file that appears in between is caught by the re-check ahead
  // of the write.
  const fingerprintBefore = await fileFingerprint(resolved.absolute);
  const view = await readClientConfigFile(site, { transform: target.entry });
  const read = view.read;
  if (read.kind === "unreadable") {
    err(describeUnreadableConfig("install", resolved.absolute, { code: read.code, message: read.message }));
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  if (read.kind === "malformed") {
    // The remedy is shared with doctor's CLIENTS line and import's refusal to
    // remove originals for this same file (see unparseableConfigFix), so
    // those surfaces cannot disagree about what gets a user past this
    // refusal. `syntax` is the adapter's own name for the file's language, so
    // a non-JSON client says what it actually is.
    err(
      read.reason === "root"
        ? `yaw-mcp install: ${resolved.absolute} is not a ${read.syntax} object -- refusing to overwrite it; ${unparseableConfigFix("re-run")}.`
        : `yaw-mcp install: ${resolved.absolute} is not valid ${read.syntax} (${read.detail}) -- refusing to overwrite it; ${unparseableConfigFix("re-run")}.`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  // Parses for US, not for its client: a strict-JSON site (claude-code's
  // project `.mcp.json`) carrying a comment or a trailing comma, which that
  // client reads with JSON.parse and so loads NO server from.
  //
  // ON THE READ, not only on the write. applyClientConfigEdits already
  // refuses the SPLICE, but that gate is `writes`-scoped and never fires on
  // the two paths this run can take without one -- an entry that is already
  // identical (no edit is built at all) and a legacy-key-only removal (a
  // removal list, which the core permits by design). Both printed "Done:
  // Claude Code is configured" at exit 0 over a file the client loads nothing
  // from, which is the one claim install must never make.
  //
  // A REFUSAL, deliberately, and it takes the legacy trim with it: that trim
  // is a cleanup rider on configuring the client, and tidying a key out of a
  // file nothing reads leaves the user exactly as broken while sounding like
  // progress. The remedy is shared with doctor's CLIENTS line and import's
  // refusal over this same file, so no surface can disagree about what gets
  // the user past it -- and unlike `malformed`, yaw-mcp CAN read this file,
  // so the clause says what the client sees rather than what we failed to.
  //
  // A NON-REPARABLE blocked container is left to its own refusal below, which
  // is what doctor's CLIENTS row and import's refusal both lead with on a file
  // that is both: three surfaces naming two different faults for one file is
  // the drift the shared helpers exist to stop.
  const unloadable = view.unloadable();
  if (unloadable !== null && !(read.kind === "blocked" && !read.reparable)) {
    err(
      `yaw-mcp install: ${resolved.absolute} ${unloadableConfigProblem(unloadable)} -- refusing to write into it; ${unloadableConfigFix("re-run")}.`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  // EVERY projects[] read in this file resolves its path here -- see
  // claudeCodeContainerPaths. The canonical key comes back first and is the
  // one this run reads and writes; the rest are drive-letter-case siblings of
  // the same project that an older version, or an install run from a cmd
  // prompt with a lower-case drive, already wrote. They are read so the run
  // can REPORT them, and written to never: the Claude Code session that reads
  // a sibling is exactly the one that cannot read the canonical key.
  //
  // The candidate KEYS come from the file's own container through the core,
  // so this function never parses a client config to find them.
  const variantPaths = claudeCodeContainerPathVariants(containerPath, (prefix) =>
    containerKeysAt(view.raw, site, prefix),
  );
  for (const variantPath of variantPaths.slice(1)) {
    const sibling = classifyClientConfig(view.raw, siteAt(site, variantPath), { transform: target.entry });
    if (sibling.read.kind !== "ok" || !sibling.read.containerPresent) continue;
    const siblingLegacy = sibling.legacyKey();
    const siblingHasEntry = sibling.entry() !== undefined;
    if (!siblingHasEntry && siblingLegacy === null) continue;
    driveCaseSiblings.push({ key: variantPath[1], hasEntry: siblingHasEntry, legacy: siblingLegacy });
  }
  const existingHasEntry = view.entry() !== undefined;
  /** The stored value under ENTRY_NAME as the row's `normalize` hook says
   *  every consumer should see it, or undefined when the key is absent.
   *  Compared against the entry this run builds -- see the entryState ladder.
   *
   *  NORMALISED, not sanitised: the comparison asks "would this run CHANGE
   *  the file", so every key the file holds has to be in it (a stored
   *  `"env": {"N": 1}` or a stray `"type": "stdio"` must read as drift, which
   *  is what a re-run is for). What `normalize` does is fold a client's OWN
   *  alternative spelling of our entry -- Cline's nested `transport` block --
   *  into the flat shape, so the entry Cline itself rewrote reads as ours
   *  instead of showing up as `command: (absent) -> "npx"` in the diff. */
  const storedEntry = view.normalized();
  const legacyEntry = view.legacyKey();
  // Read off the same view, so this cannot drift from the entry state above:
  // the other servers wired DIRECTLY in this container, which the tail reports
  // as still launching outside yaw-mcp. A file that is absent, empty, or whose
  // container holds a non-object has none, which is correct in every one of
  // those shapes -- there is nothing there to bypass.
  const directEntryNames = view.otherServerKeys();

  // A sibling key naming the same project with the other drive-letter case.
  // Reported HERE, before the first early exit, so --skip, the identical
  // no-op, a dry run and the write path all name it. Left on disk on purpose:
  // Claude Code's lookup is byte-exact (see claudeCodeProjectKey), so the
  // session that reads the sibling is precisely the one that cannot read the
  // key this run writes -- deleting it would unwire that session and hand it
  // nothing back. `uninstall` is the command that clears both spellings.
  for (const sibling of driveCaseSiblings) {
    const what = sibling.hasEntry
      ? sibling.legacy !== null
        ? `"${ENTRY_NAME}" and legacy "${sibling.legacy}" entries`
        : `a "${ENTRY_NAME}" entry`
      : `a legacy "${sibling.legacy}" entry`;
    log(
      `Note: ${resolved.absolute} also has ${what} under projects[${JSON.stringify(sibling.key)}] -- the same ` +
        "directory spelled with the other drive-letter case. Left alone: only a Claude Code whose cwd is spelled " +
        "that way reads it, and that session cannot see the entry this command writes. " +
        `\`yaw-mcp uninstall ${target.clientId} --scope ${scope}\` removes both spellings.`,
    );
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
  // The Windows launch policy is the ROW's, read from `entry.windowsLaunch`
  // rather than from a client-id branch here: `bare` is for a client that
  // resolves the `.cmd` shim itself, and the default stays the `cmd /c` wrap
  // every other client needs, so the six existing rows are unchanged.
  const newEntry = buildLaunchEntry({
    os,
    oamBinPath,
    oamEntry,
    windowsWrap: target.entry?.windowsLaunch?.broker !== "bare",
  });
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
  const previousEnv = view.carryableEnv();
  const carryableEnv =
    newEntry.env === undefined && previousEnv && Object.keys(previousEnv).length > 0 ? previousEnv : undefined;
  /** True when the entry this run writes carries something over from the one
   *  on disk. Tested explicitly rather than by comparing `entryToWrite`
   *  against `newEntry` by identity: `composeEntry` always returns a fresh
   *  object, so the identity test this replaces would have read "carried"
   *  on every path including --force. */
  const envCarried = carryableEnv !== undefined && !opts.force;
  /** The CLIENT's own fields on our entry -- Zed's `enabled` / `remote` /
   *  `timeout`, Cline's `disabled` / `autoApprove` / `timeout` / `type` --
   *  carried forward on every path but --force, exactly as `env` is, and
   *  type-checked by the row that owns them.
   *
   *  This is what makes those rows' comments true: without it `--repair` over
   *  a `"enabled": false` entry rewrote it WITHOUT the flag and silently
   *  switched the server back on, and every re-run reported drift for a field
   *  install never writes. `--force` drops them, which is what that flag
   *  says it does. */
  const carriedFields = opts.force ? {} : view.carried();
  // Precedence is composeEntry's, not this call site's: carried client fields
  // first, then the row's extra fields, then the built launch entry -- so
  // neither a stale carried field nor a target's extra field can change the
  // command or the args install is writing. The env fill is the same rule
  // this function applied inline before (only when the composed entry has
  // none of its own).
  const entryToWrite = composeEntry({
    base: newEntry,
    transform: target.entry,
    os,
    purpose: "broker",
    env: opts.force ? undefined : carryableEnv,
    carried: carriedFields,
  });
  // Buffered with the Runtime lines, and for the same reason: it describes the
  // entry this run is about to WRITE. On the identical path nothing is written
  // and the env was never at risk, so announcing that it was "kept" is a claim
  // about a merge that did not happen.
  //
  // The --force line names what it drops -- KEYS only, never values, the rule
  // describeEntryDiff and DRY_RUN_ENV_PLACEHOLDER follow for this same block --
  // because the drop is otherwise visible only as one `env: drops ...` diff
  // line. It names only the keys --repair would have kept: a non-string value
  // is filtered out by the core's carryableEnv on both paths, so claiming --repair keeps
  // it would be false (the diff line still names it). The same filter is why
  // the parenthetical speaks of THESE keys rather than of "an entry's env":
  // --repair does not keep a non-string value either. Sorted (the "Kept" line
  // too), so a multi-key drop names its keys in the order the `env: drops ...`
  // diff line does rather than the same set twice in two orders. "Dropping",
  // not "Dropped": the line prints before the write, which can still fail.
  //
  // carriedKeys is shared with the TTY prompt and the off-TTY hint below. Both
  // name the kept keys rather than saying "its env", for the same
  // string-values-only reason, and in the same sorted order.
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

  /** May this run replace a DIFFERING yaw-mcp entry? A flag says so outright;
   *  otherwise it is what the collision ladder below decided for the primary
   *  site. Read only by `applyToExtraSites`, which must not prompt again per
   *  editor copy but must not clobber one silently either. */
  let overwriteAuthorised = opts.force === true || opts.repair === true;

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
      const answer = await promptCollision(resolved.absolute, diff, opts.io, envCarried ? carriedKeys : []);
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
      // a non-string value is filtered out by the core's carryableEnv, goes on either flag,
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
    // Getting here means the run may replace a differing entry -- a flag, or
    // an answered prompt. The editor copies follow that one answer rather than
    // asking again.
    overwriteAuthorised = true;
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

  // ONE write, through the core, whatever the file's syntax and whatever the
  // run has to do to it: repair a blocked container key, upsert the entry,
  // trim a legacy key -- as a LIST of edits applied in that order against the
  // running text and VERIFIED before this function has anything to persist
  // (no reordered neighbour, no changed setting elsewhere, no strict file
  // turned unloadable, and our own entry reads back as written). A file that
  // does not exist is rendered fresh by the same call, container chain and
  // all.
  //
  // NULL means "this run has no client-config write to make": the stored entry
  // already matches and there is no legacy entry to trim. Everything from the
  // fingerprint re-check to the `Wrote ...` line is then skipped, which is what
  // makes a re-run genuinely a no-op on disk rather than a rewrite that happens
  // to produce the same bytes (a rewrite still moves mtime, still races a live
  // Claude Code session, and still shows up in a backup diff).
  let clientJson: string | null = null;
  // The blocked-container repair, REMEMBERED where it is decided and announced
  // only where the announcement is true: in the preview block under --dry-run,
  // and after the atomic write has actually landed on the live path. Logged at
  // the decision it was past tense before the file had been touched --
  // "replaced ... with an empty object" printed ahead of a write that three
  // separate paths still refuse: an edit list `applyClientConfigEdits` will not
  // render (just below), the concurrent-write fingerprint abort, and a failed
  // `atomicWriteFile`. The strictJson flag on claude-code's project scope turned
  // that from rare into deterministic -- a .mcp.json that is BOTH commented and
  // holds a non-object container printed the repair and was then refused, so the
  // note described a repair no file ever got. Buffering it into `runtimeLines`
  // would not have helped: that buffer is flushed above, also before the write.
  let repairedContainer: { keyPath: string; shape: string } | null = null;
  if (skipEntryWrite && !trimLegacy) {
    clientJson = null;
  } else {
    const edits: ClientConfigEdit[] = [];
    // A container key that already holds a non-object cannot be spliced into.
    // Settled BEFORE the write: a repair has to be the first edit, and one is
    // always enough because every deeper segment is necessarily absent
    // afterwards and the upsert materialises it.
    if (read.kind === "blocked") {
      const keyPath = read.path.join(".");
      if (!read.reparable) {
        err(
          `yaw-mcp install: "${keyPath}" in ${resolved.absolute} is ${read.shape}, not a JSON object -- refusing to overwrite it; ${blockedContainerFix("re-run")}.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
      edits.push({ op: "repair", path: read.path });
      repairedContainer = { keyPath, shape: read.shape };
    }
    // Identical entry with a legacy key to trim: the only edit is the removal,
    // so the entry's own bytes are left exactly where the user (or a previous
    // install) put them.
    if (!skipEntryWrite) edits.push({ op: "upsert", key: ENTRY_NAME, entry: entryToWrite });
    // Trimmed in the SAME write as the entry, so the file never lands on disk
    // holding one without the other.
    if (trimLegacy) edits.push({ op: "remove", key: legacyEntry as string });
    try {
      // The facade leaves the user's bytes alone outside what it splices, so a
      // file that already ends in a newline keeps exactly the one it had
      // (never doubled). A file that does NOT is terminated here rather than
      // left unterminated -- POSIX tools and diffs both want the newline, and
      // install is rewriting the file anyway.
      clientJson = terminateWithNewline(applyClientConfigEdits(view, edits, site));
    } catch (e) {
      // One refusal for every way the write could not be made -- a splicer
      // that threw, a verification that failed, a file the client itself
      // cannot load. The facade's message carries the specifics; the wording
      // around it stays the one install has always printed for the edit it
      // was making. (The old separate "failed to replace the non-object key"
      // wording folds in here: the repair is now part of the same atomic
      // edit list, and it was only ever reachable by a throw from the splicer
      // on a path this function had just validated.)
      err(
        skipEntryWrite
          ? `yaw-mcp install: failed to remove the legacy "${legacyEntry}" entry from ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`
          : `yaw-mcp install: failed to splice the "${ENTRY_NAME}" entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  }

  /** The repair note, in the tense of whichever path is printing it. One
   *  wording, two call sites, so the preview and the live run cannot drift. */
  const containerRepairNote = (what: { keyPath: string; shape: string }, tense: "would replace" | "replaced"): string =>
    `Note: "${what.keyPath}" in ${resolved.absolute} is ${what.shape}, not an object -- ` +
    `${tense} it with an empty object so the "${ENTRY_NAME}" entry has somewhere to live.`;

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
    // The editor copies are previewed FIRST, above the "nothing to do" check,
    // because whether this run has anything to do is a question about every
    // file it would touch and not just the primary. Measured before it moved:
    // with the shared Cline file already correct and a stale copy under a VS
    // Code globalStorage directory, --dry-run returned `wouldWrite: []` and
    // printed "Nothing to do ... already configured" while the live run a
    // second later wrote that copy. A copy that differs WITHOUT authorisation
    // was hidden by the same return, so the preview also swallowed the
    // "re-run with --repair" warning the live run prints.
    //
    // Its lines are buffered rather than printed where the pass runs: this is
    // one pass whose output belongs further down (under the preview header,
    // beside the primary's), and running it twice -- once to decide, once to
    // print -- would double every line and re-read every copy.
    const extraPreview: Array<[(s: string) => void, string]> = [];
    const extraWouldWrite = await applyToExtraSites({
      cmd: "install",
      sites: extraSites,
      transform: target.entry,
      // The BASE entry, not `entryToWrite`: each copy composes its own from
      // its own carry. See applyToExtraSites.
      compose: { base: newEntry, os, force: opts.force === true },
      keepLegacy: opts.keepLegacy === true,
      authorised: overwriteAuthorised,
      dryRun: true,
      log: (s) => extraPreview.push([log, s]),
      err: (s) => extraPreview.push([err, s]),
    });
    const flushExtraPreview = (): void => {
      for (const [sink, line] of extraPreview) sink(line);
    };

    // `clientJson === null` is the identical-entry, nothing-to-trim case: the
    // preview must promise exactly what the real run would do, and the real run
    // writes nothing. Printing the entry under "would add" there is how a
    // preview starts lying about a no-op.
    //
    // `extraWouldWrite.length === 0` is the same test applied to the copies,
    // and it is the live path's own: there, extras are pushed into `written`
    // before the `written.length === 0` check decides the run was a no-op.
    if (clientJson === null && !settingsPatch?.changed && extraWouldWrite.length === 0) {
      // The copies still get their say -- "already correct" for each, and the
      // --repair warning for one that differs without authorisation. Both are
      // exactly what the live run prints over this same state before it too
      // concludes there was nothing to do.
      flushExtraPreview();
      log(`\nNothing to do: ${target.label} (${scope}) is already configured.`);
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    }
    if (repairedContainer) log(containerRepairNote(repairedContainer, "would replace"));
    log("\n--- dry run: would add the following (the rest of each file is left as-is) ---");
    if (clientJson !== null && !skipEntryWrite) {
      const previewEntry =
        envCarried && entryToWrite.env
          ? {
              ...entryToWrite,
              env: Object.fromEntries(Object.keys(entryToWrite.env).map((k) => [k, DRY_RUN_ENV_PLACEHOLDER])),
            }
          : entryToWrite;
      // Rendered by the site's own adapter, so the preview is in the file's
      // own syntax rather than in JSON with another language's name on it.
      // For the JSON family it is byte-for-byte what this printed before.
      log(
        `\n# ${resolved.absolute}\n${view.adapter.renderPreview(view.address, ENTRY_NAME, previewEntry, read.kind === "absent")}`,
      );
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
    // Every editor copy the real run would write, named here for the same
    // reason: a preview that omits a file the run touches is the one thing
    // --dry-run must never do. That sentence is now a description of the code
    // and not only an intent -- the pass whose result this appends ran ABOVE
    // the "nothing to do" return, which used to fire first and hide the copies
    // whenever the primary needed no write. Each copy was READ (so a copy that
    // is already correct, or that differs without authorisation, is reported as
    // such), its entry composed and its write RENDERED -- so a refusal the live
    // run would raise is raised here too -- and none was written. Its lines
    // print HERE, in the place they always have, which is why the pass buffers
    // rather than logging where it runs.
    flushExtraPreview();
    wouldWrite.push(...extraWouldWrite);
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
    // Past tense, AFTER the bytes landed -- the only place it is earned. Every
    // refusal between the decision to repair and this line returns above it: a
    // render the facade would not make (the unloadable-config gate, a splice
    // that will not verify), the concurrent-write fingerprint abort, and a
    // failed atomicWriteFile. None of them now reports a repair.
    if (repairedContainer) log(containerRepairNote(repairedContainer, "replaced"));
    written.push(resolved.absolute);
    if (trimLegacy) {
      log(`Removed the legacy "${legacyEntry}" entry -- it would have run yaw-mcp a second time.`);
    }
  }

  // The editor copies, AFTER the primary write: that write is the product of
  // the command, so a copy that cannot be written is a warning rather than a
  // failure. Runs even when the primary needed no write -- an identical shared
  // file beside a stale editor copy is exactly the state a re-run is for.
  written.push(
    ...(await applyToExtraSites({
      cmd: "install",
      sites: extraSites,
      transform: target.entry,
      // The BASE entry, not `entryToWrite`: each copy composes its own from
      // its own carry. See applyToExtraSites.
      compose: { base: newEntry, os, force: opts.force === true },
      keepLegacy: opts.keepLegacy === true,
      authorised: overwriteAuthorised,
      dryRun: false,
      log,
      err,
    })),
  );

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
      : // How the client picks the change up is the ROW's fact, not this
        // line's: a client that watches its config file must not be told to
        // restart, and one that needs a window reload must not be told the
        // editor. `reload` defaults to "restart", whose clause is what every
        // pre-existing row printed, byte for byte.
        `\nDone: ${target.label} is configured. ${reloadDoneClause(target.reload, target.label)}`,
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
/** The Claude Code `permissions.allow` grant moved to claude-code-settings.ts
 *  when the splice changed from replacing the whole array to editing its one
 *  member (a comment inside the list used to be deleted by every install and
 *  every uninstall). Re-exported here because the tests that pin the merge and
 *  the removal import them from this module.
 *
 *  `prepareClaudeCodeSettingsPatch` is imported, not re-exported: nothing
 *  outside this file calls it. */
export { mergePermissionsAllow, removePermissionsAllow } from "./claude-code-settings.js";

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
 *  the core's carryableEnv filters out a non-string value, so an overwrite of a mixed env
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
    return [`the stored entry is ${describeValueShape(stored)}, not an object`];
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

// `readNested`, `readEntryAt`, `mergeClientConfig` and `removeFromClientConfig`
// used to live here: an object-level walk, an entry accessor over it, and the
// merge / delete pair that wrote through them. All four are gone. Every read
// and write of a client config in this file now goes through the client-config
// core -- `readClientConfigFile` and `classifyClientConfig` for the reads,
// `applyClientConfigEdits` for the writes -- which asks the site's OWN adapter
// for the entries at the address it was handed, so the walk no longer has to
// be written once per syntax and the write is verified before there are bytes
// to persist. `removeFromClientConfig` went first, and for the sharper reason:
// its doc comment named two callers it did not have.
//
// What replaces each, for anyone following an old reference: readNested and
// readEntryAt -> `view.entry()` / `view.normalized()` / `view.carryableEnv()`;
// mergeClientConfig -> an `upsert` edit into an absent file, which the JSON
// adapter renders with `buildFreshConfig` (pinned byte-for-byte against the
// shape this function produced, in client-config-json.test.ts).

/** Apply the edit this run already decided on to a target's EXTRA sites -- the
 *  per-editor copies a `sites` hook fans one (client, scope) out to.
 *
 *  WHY IT EXISTS. Cline keeps one cline_mcp_settings.json per runtime: a
 *  shared `~/.cline/...` file that the CLI and the extension's newer runtime
 *  read, and one under each editor's own globalStorage that the extension's
 *  legacy runtime reads. A shared-file-only install is invisible to a Cline
 *  window on that older runtime, and the row's `notes` -- which install prints
 *  verbatim -- says install writes the shared file "and each editor copy it
 *  finds". This is what makes that sentence true. Measured before it existed:
 *  `install cline` with a seeded VS Code extension-storage directory wrote the
 *  shared file only.
 *
 *  WHAT IT IS NOT. It does not re-run the collision ladder per file. The user
 *  answered for this CLIENT once, on the site every message names, and asking
 *  again per editor copy would be a prompt per window they have ever opened.
 *  So a copy is written when it has no entry of ours, or when the run is
 *  AUTHORISED to overwrite a differing one (`--force`, `--repair`, or an
 *  answered prompt on the primary site). A copy whose entry differs without
 *  that authorisation is REPORTED and left, which is the same answer the
 *  primary site gives off a TTY -- never a silent clobber of a launch entry
 *  somebody edited.
 *
 *  EVERY COPY IS COMPOSED FROM ITS OWN STORED ENTRY. What comes in is the BASE
 *  launch entry -- what `buildLaunchEntry` produced -- never the entry the
 *  primary site is getting, and each copy's entry is built here from THAT
 *  copy's `carried()` and `carryableEnv()`, the same two inputs `runInstall`
 *  composes the primary from. Handing the primary's composed entry down was a
 *  silent two-way data loss, measured on real runs: `install cline --repair`
 *  over an editor copy holding `disabled: true` and an env of its own rewrote
 *  it as bare `{command, args}` -- re-enabling a server the user had turned
 *  off, which is the exact regression target-cline.ts's `carry` hook exists to
 *  prevent -- while an answered overwrite prompt pushed the PRIMARY's env into
 *  that copy, so a per-site secret was both dropped and replaced by another
 *  site's. `--force` drops the carry on a copy exactly as it drops it on the
 *  primary, which is what that flag says it does. The "already correct" test
 *  compares the stored value against THIS copy's composed entry for the same
 *  reason: against the primary's it reported drift a re-run could not settle.
 *
 *  THE WRITE IS RENDERED BEFORE THE DRY-RUN BRANCH. `applyClientConfigEdits`
 *  is where a refusal lives -- the unloadable-config gate, a blocked
 *  container, a splice that will not verify -- so a preview that short-circuits
 *  ahead of it promises writes the live run refuses. Measured: for a Cline copy
 *  carrying a comment (cline_mcp_settings.json is strict JSON) `--dry-run`
 *  printed "would write" and named the file, while the live run warned and left
 *  it alone. The removal path needs no such care and does not get it -- its
 *  edits are all `remove`, which that gate lets through, so uninstall's preview
 *  was already honest.
 *
 *  Best-effort throughout: the primary write is the product of the command and
 *  has already landed by the time this runs, so every failure here is a
 *  warning naming the file, never a non-zero exit. `compose` undefined is the
 *  removal (`uninstall`), which takes our entry and -- unless `keepLegacy` --
 *  any legacy key out of each copy; without it an uninstall would leave a live
 *  broker wired in every editor copy it had written, which is the
 *  duplicate-broker state the legacy trim exists to prevent. */
async function applyToExtraSites(args: {
  cmd: "install" | "uninstall";
  sites: readonly ConfigSite[];
  transform: EntryTransform | undefined;
  /** What each copy's own entry is composed FROM, or undefined to remove ours
   *  (`uninstall`). `base` is the built launch entry, never the primary's
   *  composed one; `os` and `force` are the other two inputs `runInstall`
   *  passes `composeEntry`, so a copy is composed by exactly the rule the
   *  primary is. */
  compose: { base: LaunchEntry; os: InstallOS; force: boolean } | undefined;
  keepLegacy: boolean;
  authorised: boolean;
  dryRun: boolean;
  log: (s: string) => void;
  err: (s: string) => void;
}): Promise<string[]> {
  const { cmd, compose, log, err } = args;
  const touched: string[] = [];
  for (const site of args.sites) {
    const where = site.resolved.absolute;
    const named = `${where} (${site.label})`;
    const view = await readClientConfigFile(site, { transform: args.transform });
    const read = view.read;
    if (read.kind === "unreadable" || read.kind === "malformed" || read.kind === "unspliceable") {
      err(`yaw-mcp ${cmd}: warning -- ${named} could not be edited; left unchanged. Edit it by hand.`);
      continue;
    }
    const legacy = view.legacyKey();
    const trimLegacy = legacy !== null && !args.keepLegacy;
    const hasEntry = view.entry() !== undefined;

    if (compose === undefined) {
      // Removal. Nothing of ours in this copy is the ordinary case for an
      // editor the user installed after wiring yaw-mcp, and it is silent: the
      // primary site's own line already speaks for the run.
      //
      // `trimLegacy`, not `legacy !== null`: --keep-legacy is honoured on the
      // primary site (`trimsLegacy`) and the uninstall help promises it for the
      // run, so ignoring it here both violated the flag and -- on a copy
      // holding ONLY a legacy key -- rewrote that copy empty while printing a
      // line naming the "mcp" entry, a key that file never had.
      if (!hasEntry && !trimLegacy) continue;
      const edits: ClientConfigEdit[] = [];
      if (hasEntry) edits.push({ op: "remove", key: ENTRY_NAME });
      if (trimLegacy) edits.push({ op: "remove", key: legacy as string });
      // One phrase per key actually going, so every line below names what this
      // file held rather than what the command is called. Modelled on the
      // primary's own pair of removal lines.
      const removed: string[] = [];
      if (hasEntry) removed.push(`the "${ENTRY_NAME}" entry`);
      if (trimLegacy) removed.push(`the legacy "${legacy}" entry`);
      if (args.dryRun) {
        for (const what of removed) log(`Would also remove ${what} from ${named}.`);
        touched.push(where);
        continue;
      }
      try {
        await atomicWriteFile(where, terminateWithNewline(applyClientConfigEdits(view, edits, site)));
        for (const what of removed) log(`Removed ${what} from ${named}.`);
        touched.push(where);
      } catch (e) {
        err(
          `yaw-mcp ${cmd}: warning -- failed to remove ${removed.join(" and ")} from ${named} (${(e as Error).message}); left unchanged. Remove ${removed.length > 1 ? "them" : "it"} by hand.`,
        );
      }
      continue;
    }

    // This copy's entry, composed from this copy's stored one. The env rule is
    // runInstall's, spelled the same way: a carried env fills a gap only, and
    // --force passes neither it nor the carried client fields.
    const previousEnv = view.carryableEnv();
    const carryableEnv =
      compose.base.env === undefined && previousEnv && Object.keys(previousEnv).length > 0 ? previousEnv : undefined;
    const entry = composeEntry({
      base: compose.base,
      transform: args.transform,
      os: compose.os,
      purpose: "broker",
      env: compose.force ? undefined : carryableEnv,
      carried: compose.force ? {} : view.carried(),
    });
    const stored = view.normalized();

    if (hasEntry && deepEqualJson(stored, entry) && !trimLegacy) {
      log(`The "${ENTRY_NAME}" entry in ${named} is already correct.`);
      continue;
    }
    if (hasEntry && !deepEqualJson(stored, entry) && !args.authorised) {
      err(
        `yaw-mcp ${cmd}: warning -- ${named} already has a differing "${ENTRY_NAME}" entry; left untouched. ` +
          "Re-run with --repair to bring every copy up to date, or --force to overwrite them.",
      );
      continue;
    }
    const edits: ClientConfigEdit[] = [];
    if (read.kind === "blocked") {
      if (!read.reparable) {
        err(
          `yaw-mcp ${cmd}: warning -- "${read.path.join(".")}" in ${named} is ${read.shape}, not an object; left unchanged. Fix it by hand.`,
        );
        continue;
      }
      edits.push({ op: "repair", path: read.path });
    }
    edits.push({ op: "upsert", key: ENTRY_NAME, entry });
    if (trimLegacy) edits.push({ op: "remove", key: legacy as string });
    // Rendered on BOTH paths, and the text thrown away on the preview one: the
    // only way a dry run can raise every refusal the live write would.
    let next: string;
    try {
      next = terminateWithNewline(applyClientConfigEdits(view, edits, site));
    } catch (e) {
      err(
        `yaw-mcp ${cmd}: warning -- ${args.dryRun ? `${named} cannot be written` : `failed to write ${named}`} (${(e as Error).message}); left unchanged. That copy of the client will not see yaw-mcp.`,
      );
      continue;
    }
    if (args.dryRun) {
      // Not "the same entry": each copy carries its own `env` and its own
      // client-owned fields forward, so the copies and the primary can all
      // legitimately differ.
      log(`Would also write the "${ENTRY_NAME}" entry to ${named}.`);
      touched.push(where);
      continue;
    }
    try {
      await atomicWriteFile(where, next);
      log(`Wrote ${named}`);
      touched.push(where);
    } catch (e) {
      err(
        `yaw-mcp ${cmd}: warning -- failed to write ${named} (${(e as Error).message}); left unchanged. That copy of the client will not see yaw-mcp.`,
      );
    }
  }
  return touched;
}

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
  // One resolver for every client-taking verb, so an alias is accepted
  // wherever the id is and the cast to InstallClientId happens in exactly one
  // place -- here it is the resolver's return type, not an assertion about a
  // string nobody checked.
  const resolved = resolveClientArg("install", positional[0]);
  if (!resolved) {
    return {
      ok: false,
      error: `Unknown client: ${positional[0]}. Choose: ${clientChoices("install").join(", ")}`,
    };
  }
  opts.clientId = resolved.clientId;
  // An alias may pin a scope. It is applied as the DEFAULT, so an explicit
  // --scope the user typed beside it still wins -- an alias that overrode the
  // flag next to it would be a silent surprise.
  if (resolved.scope !== undefined && opts.scope === undefined) opts.scope = resolved.scope;
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
    // `--list` must resolve each row's path the way INSTALL does, or it
    // reports on a file install never writes: an env-redirected client would
    // show "not installed" beside an entry sitting at the redirected path.
    clientEnv: opts.clientEnv,
    appData: resolveAppData(opts),
  });

  const rows = probes.map((p) => ({
    client: INSTALL_TARGETS.find((t) => t.clientId === p.clientId)?.label ?? p.clientId,
    scope: p.scope,
    path: displayPath(p.path, home, os),
    status: statusFor(p),
  }));

  // An entry the client cannot load (strict JSON with a comment) is not
  // "configured": its row reads "not loading", so the headline must agree.
  const installed = probes.filter((p) => p.hasMcpEntry && p.unloadable === null).length;
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
  // An entry found under the OTHER drive-letter spelling of this directory's
  // projects[] key. The STATUS column can only carry a marker, so the key
  // itself is named here -- a row reading "installed" with no key would send
  // the user looking under the canonical one, which holds nothing.
  for (const p of probes) {
    if (!p.entryProjectKey) continue;
    const label = INSTALL_TARGETS.find((t) => t.clientId === p.clientId)?.label ?? p.clientId;
    log(
      `Note: the ${label} (${p.scope}) entry is under projects[${JSON.stringify(p.entryProjectKey)}] in ` +
        `${displayPath(p.path, home, os)} -- the same directory spelled with the other drive-letter case. Only a ` +
        `Claude Code whose cwd is spelled that way reads it. \`yaw-mcp install ${p.clientId} --scope ${p.scope}\` ` +
        `writes the canonical key; \`yaw-mcp uninstall ${p.clientId} --scope ${p.scope}\` removes both spellings.`,
    );
    log("");
  }
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
  // ABOVE every entry state on purpose, `installed` included: the client
  // reads this file with JSON.parse and loads no server from it, so a row
  // saying "installed" would be naming an entry that is present and inert --
  // the precise claim install now refuses to make about this file, and the
  // one doctor's CLIENTS line was also reporting as healthy. The cell stays
  // short because the table is one line per row; doctor carries the full
  // clause and the remedy.
  if (p.unloadable) return "not loading (comments or trailing commas)";
  // The entry is real, but under the other drive-letter spelling of this
  // directory's projects[] key -- a bare "installed" would claim the canonical
  // key holds it. The key itself is named in a note under the table, which is
  // the only place a full path fits.
  const keySuffix = p.entryProjectKey ? " (other drive case)" : "";
  if (p.hasMcpEntry) return `installed${keySuffix}`;
  // A file whose only yaw-mcp wiring is a PRE-RENAME entry is an upgrade
  // pending, not somebody else's config: `install <client>` has something
  // specific to do there (write `mcp` and remove the old key in the same
  // write, unless --keep-legacy).
  // Folding it into "other-entries" threw away the probe's own
  // hasLegacyEntry/legacyEntryName and left the row indistinguishable from a
  // config that has nothing to do with yaw-mcp.
  if (p.hasLegacyEntry) return `legacy: ${p.legacyEntryName ?? "unknown"}${keySuffix}`;
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
  const targets = (opts.targets ?? INSTALL_TARGETS).filter((t) => t.availableOn.includes(os));
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
  // Every name the parser accepts, because `clientChoices` is what it
  // validates against -- uninstall has accepted windsurf and gemini-cli since
  // they were added to the table, and a usage line naming only the first four
  // reads as a refusal that never happens. Aliases ride along for the same
  // reason, at the end, after the real clients.
  `Usage: yaw-mcp uninstall <${clientChoices("uninstall").join("|")}> [--scope user|project|local]\n` +
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
  /** Every client env var, as `readClientEnv` reported it, threaded from the
   *  dispatcher. Only a MODULAR row reads it (Zed's $XDG_CONFIG_HOME, Cline's
   *  three knobs, Continue's global dir); the six inline rows take their one
   *  variable from `claudeConfigDir` above. Read by the dispatcher and never
   *  here, so a test that calls this runner directly stays hermetic. */
  clientEnv?: ClientEnvValues;
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
  // Same resolver as install's, so uninstall takes exactly the names install
  // does -- an alias you can install with but not uninstall with is the worst
  // shape this could have.
  const resolved = resolveClientArg("uninstall", positional[0]);
  if (!resolved) {
    return {
      ok: false,
      error: `Unknown client: ${positional[0]}. Choose: ${clientChoices("uninstall").join(", ")}`,
    };
  }
  opts.clientId = resolved.clientId;
  if (resolved.scope !== undefined && opts.scope === undefined) opts.scope = resolved.scope;
  return { ok: true, options: opts as UninstallCommandOptions };
}

/** Render an entry's launch line for the removal preview. Command + args only,
 *  never `env` VALUES -- README tells users to keep YAW_MCP_VAULT_PASSPHRASE in
 *  that block, and this preview is printed on a terminal. Same rule
 *  describeEntryDiff and DRY_RUN_ENV_PLACEHOLDER follow. */
function renderEntryLaunch(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return `(${describeValueShape(entry)})`;
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

/** One container `uninstall` has to clear, in the order claudeCodeContainerPaths
 *  returns them: the canonical key first, then each drive-letter-case sibling
 *  of the same project that actually carries yaw-mcp wiring.
 *
 *  Siblings exist because Claude Code's projects[] lookup is byte-exact and
 *  older versions wrote the key with whatever drive-letter case the shell
 *  reported (see claudeCodeProjectKey). Clearing only the canonical one is how
 *  uninstall came to print "Done: ... no longer launches yaw-mcp" over a file
 *  that still launched it for a cmd-started session. */
interface RemovalSite {
  containerPath: string[];
  /** The projects[] key, or null when the container is not under projects[]
   *  (every other client, and Claude Code's user and project scopes). */
  projectKey: string | null;
  /** True for everything but the canonical key -- the only sites whose
   *  removals need naming separately in the preview and the log. */
  sibling: boolean;
  hasEntry: boolean;
  storedEntry: unknown;
  legacyEntry: string | null;
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
  const plan = resolveInstallSite("uninstall", opts, err);
  if (!plan) return { written: [], wouldWrite: [], messages, exitCode: 2 };
  const { target, scope, projectDir, resolved } = plan;

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  const containerPath = resolved.containerPath;
  // Same site selection install makes: `sites[0]` is the file every message
  // names, and `extraSites` holds each per-editor copy this machine has. Empty
  // for every row but Cline. An uninstall that cleared only the shared file
  // would leave a live broker entry in every editor copy install had written
  // -- the duplicate-broker state the legacy trim exists to prevent.
  const selectedSites = selectSites(plan.sites);
  const site = selectedSites[0];
  const extraSites = selectedSites.slice(1);
  /** Every container carrying wiring for this project -- see RemovalSite. */
  const sites: RemovalSite[] = [];
  // Fingerprinted BEFORE the read and compared again ahead of the write, for
  // exactly install's reason: ~/.claude.json is a file Claude Code itself
  // rewrites during a session, and the prompt below waits on a human.
  const fingerprintBefore = await fileFingerprint(resolved.absolute);
  // Read through the core, like install: one reader per syntax, and the
  // entry-level questions answered by the view. A removal is the ONE edit the
  // facade still allows into a file the client itself cannot load -- taking
  // our entry out of a file the client skips is correct, and refusing it
  // would leave the user unable to uninstall.
  const view = await readClientConfigFile(site, { transform: target.entry });
  const read = view.read;
  if (read.kind === "unreadable") {
    err(describeUnreadableConfig("uninstall", resolved.absolute, { code: read.code, message: read.message }));
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  if (read.kind === "malformed") {
    err(
      read.reason === "root"
        ? `yaw-mcp uninstall: ${resolved.absolute} is not a ${read.syntax} object -- refusing to edit. Remove the "${ENTRY_NAME}" entry by hand.`
        : `yaw-mcp uninstall: ${resolved.absolute} is not valid ${read.syntax} (${read.detail}). Refusing to edit. Fix the file and re-run.`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  // EVERY projects[] read here resolves its path through the one helper --
  // see claudeCodeContainerPaths. The canonical key comes back first; the
  // rest are drive-letter-case siblings of the SAME project that an older
  // version wrote, and skipping them is what let this command report a
  // client it had stopped nothing for.
  const variantPaths = claudeCodeContainerPathVariants(containerPath, (prefix) =>
    containerKeysAt(view.raw, site, prefix),
  );
  for (let i = 0; i < variantPaths.length; i++) {
    const variantPath = variantPaths[i];
    const sibling = i > 0;
    // The canonical container is the one already classified; a variant is the
    // same bytes read at another container inside the same file.
    const at = sibling ? classifyClientConfig(view.raw, siteAt(site, variantPath), { transform: target.entry }) : view;
    if (at.read.kind !== "ok" || !at.read.containerPresent) continue;
    const entryHere = at.entry() !== undefined;
    const legacyHere = at.legacyKey();
    // An empty sibling container has nothing to remove and nothing to say;
    // the canonical site is kept regardless, because the messages below
    // describe it even when it is bare.
    if (sibling && !entryHere && legacyHere === null) continue;
    sites.push({
      containerPath: variantPath,
      projectKey: containerPath[0] === "projects" ? variantPath[1] : null,
      sibling,
      hasEntry: entryHere,
      storedEntry: at.entry()?.value,
      legacyEntry: legacyHere,
    });
  }

  // Leaving a legacy entry behind would keep the client launching yaw-mcp
  // after a command whose whole job is to stop that -- the same
  // duplicate-broker hazard install now trims, seen from the other side.
  const trimsLegacy = (s: RemovalSite): boolean => s.legacyEntry !== null && !opts.keepLegacy;
  /** " under projects[\"c:/repo\"]" for a sibling, "" for the canonical site,
   *  so every message names a removal the user did not ask for by key and the
   *  ordinary single-key run reads exactly as it always did. */
  const where = (s: RemovalSite): string => (s.sibling ? ` under projects[${JSON.stringify(s.projectKey)}]` : "");
  const removals = sites.filter((s) => s.hasEntry || trimsLegacy(s));

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

  // The editor copies, consulted BEFORE the "Nothing to do" gate below:
  // whether this run has anything to remove is a question about every file it
  // would touch, and `removals` above is built from the shared file alone.
  // Measured before this pass moved up: with the shared Cline file holding
  // nothing of ours -- emptied, holding only other servers, or missing
  // outright -- and a detected editor copy still keyed "mcp", uninstall
  // printed "Nothing to do: Cline (user) has no yaw-mcp entry", exited 0 with
  // `written: []`, and left that copy launching yaw-mcp; --dry-run reported
  // `wouldWrite: []` over the same state. The `settingsPatch?.changed` escape
  // beside it does not cover the case: that patch is claude-code-only, and
  // claude-code has no extra sites.
  //
  // A PREVIEW pass (`dryRun: true`), not the removal itself: the confirmation
  // below has not been answered yet, and nothing may touch a copy before the
  // user has said yes. The live pass runs after the write, where it always ran.
  //
  // Its lines are buffered because they belong further down -- beside the
  // primary's preview, on the --dry-run path and on the confirmation path
  // alike -- and running the pass twice, once to decide and once to print,
  // would re-read every copy and print every line of this twice.
  const extraPreview: Array<{ stream: "log" | "err"; line: string }> = [];
  const extraWouldRemove = await applyToExtraSites({
    cmd: "uninstall",
    sites: extraSites,
    transform: target.entry,
    compose: undefined,
    keepLegacy: opts.keepLegacy === true,
    authorised: true,
    dryRun: true,
    log: (line) => extraPreview.push({ stream: "log", line }),
    err: (line) => extraPreview.push({ stream: "err", line }),
  });
  /** Print what the preview pass had to say. `warnings: false` on the
   *  confirmation path alone: the live pass re-reads each copy after the
   *  answer and raises its own warning there, so flushing those here too would
   *  print one unreadable copy's warning on both sides of the prompt. */
  const flushExtraPreview = (warnings: boolean): void => {
    for (const { stream, line } of extraPreview) {
      if (stream === "err" && !warnings) continue;
      (stream === "log" ? log : err)(line);
    }
  };

  if (removals.length === 0 && extraWouldRemove.length === 0 && !settingsPatch?.changed) {
    // Exit 0, not an error: a subtract that cannot no-op cannot be scripted,
    // and re-running uninstall is the shape a cleanup script takes.
    //
    // Reached only when NO site this run selected holds anything it would take
    // out: not the shared file, not a drive-letter-case sibling container in
    // it, and not an editor copy -- that last one is what `extraWouldRemove`
    // adds, and before it a copy still keyed "mcp" got this same all-clear.
    // The one remaining way to be here with wiring on disk is --keep-legacy
    // over a legacy-only config, and calling that "no yaw-mcp entry" would be
    // the false all-clear the Done line below is gated against, so the kept
    // entry is named instead. `kept` speaks for the containers this scope
    // reads; a legacy key a COPY holds under --keep-legacy goes unnamed here,
    // exactly as the live run leaves it unnamed (applyToExtraSites passes over
    // a copy it is not going to edit in silence).
    //
    // A copy that could not be read at all still gets its warning -- nothing
    // below this return would print it.
    flushExtraPreview(true);
    const kept = sites.filter((s) => s.legacyEntry !== null).map((s) => `"${s.legacyEntry}"${where(s)}`);
    log(
      kept.length > 0
        ? `\nNothing to do: ${target.label} (${scope}) has no "${ENTRY_NAME}" entry, and the legacy ` +
            `${kept.join(" and ")} entr${kept.length === 1 ? "y" : "ies"} you asked to keep (--keep-legacy) ` +
            "still launch yaw-mcp."
        : `\nNothing to do: ${target.label} (${scope}) has no yaw-mcp entry.`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 0 };
  }

  // What is about to go, shown to the prompt AND to the off-TTY refusal -- a
  // scripted run gets to read the preview before being told which flag it
  // needed, the courtesy `yaw-mcp remove` already extends.
  const preview: string[] = [];
  for (const s of sites) {
    if (s.hasEntry) {
      preview.push(`entry:    "${ENTRY_NAME}"${where(s)}`);
      preview.push(`launch:   ${renderEntryLaunch(s.storedEntry)}`);
      const envKeys = entryEnvKeys(s.storedEntry);
      if (envKeys.length > 0) preview.push(`env keys: ${envKeys.join(", ")} (values go with the entry)`);
    }
    if (trimsLegacy(s)) {
      preview.push(`legacy:   "${s.legacyEntry}"${where(s)} (also removed; --keep-legacy leaves it)`);
    }
  }
  if (settingsPatch?.changed) preview.push(`grant:    ${CLAUDE_CODE_ALLOW_PATTERN} from ${settingsPatch.path}`);

  if (opts.dryRun) {
    log(`\n--- dry run: would remove the following (the rest of each file is left as-is) ---`);
    for (const line of preview) log(`    ${line}`);
    // The copies' own lines, printed HERE rather than where the pass ran --
    // and it is that one pass this preview reports, so every copy is named
    // once and `wouldWrite` below cannot disagree with what was just printed.
    flushExtraPreview(true);
    const wouldWrite: string[] = [];
    if (removals.length > 0) wouldWrite.push(resolved.absolute);
    wouldWrite.push(...extraWouldRemove);
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  if (!opts.force) {
    // The header names the SHARED file, so it prints only when something in
    // that file is actually going. With nothing of ours there and a copy still
    // wired -- the state the gate above used to swallow -- "Remove from
    // <shared file>:" over an empty list would name the one file this run
    // leaves untouched.
    if (preview.length > 0) {
      log(`\n  Remove from ${resolved.absolute}:`);
      log("");
      for (const line of preview) log(`    ${line}`);
    } else {
      log("");
    }
    // What the copies lose, shown BEFORE the answer rather than after it: the
    // prompt below is the only consent this run asks for, and a file it does
    // not name is a file the user never agreed to. Warnings are left to the
    // live pass, which re-reads each copy and raises its own.
    flushExtraPreview(false);
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
  if (view.raw !== null && removals.length > 0) {
    try {
      let next = view.raw;
      // Every removal before ANY of it is written, so the file never lands on
      // disk holding one key without the other -- across the
      // drive-letter-case siblings too, which is what lets the closing line
      // below speak for every container THIS scope reads rather than for one
      // key in it. One facade call per CONTAINER (a view is bound to one
      // address), each against the text the last one produced and each
      // verifying its own result, so the user's comments and formatting
      // survive and nothing beside the removed keys can move.
      for (const s of removals) {
        const edits: ClientConfigEdit[] = [];
        if (s.hasEntry) edits.push({ op: "remove", key: ENTRY_NAME });
        if (trimsLegacy(s)) edits.push({ op: "remove", key: s.legacyEntry as string });
        const at = classifyClientConfig(next, siteAt(site, s.containerPath), { transform: target.entry });
        next = applyClientConfigEdits(at, edits, site);
      }
      clientJson = terminateWithNewline(next);
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
    for (const s of removals) {
      if (s.hasEntry) log(`Removed the "${ENTRY_NAME}" entry${where(s)}.`);
      if (trimsLegacy(s)) log(`Removed the legacy "${s.legacyEntry}" entry${where(s)}.`);
    }
  }

  // The editor copies, for real this time -- the pass above the "Nothing to
  // do" gate only read them, and it ran before a human had answered anything.
  // Re-reading rather than replaying that result is deliberate: the prompt
  // waits on a person, and what a copy holds when the write lands is what
  // matters.
  //
  // Outside the `clientJson !== null` block on purpose: the shared file can
  // hold nothing of ours while a copy still does, and that copy is precisely
  // what a user running uninstall wants gone. That state REACHES this line
  // now -- `extraWouldRemove` is what carries it past the gate, which used to
  // return first, because `removals` is built from the shared file alone.
  written.push(
    ...(await applyToExtraSites({
      cmd: "uninstall",
      sites: extraSites,
      transform: target.entry,
      compose: undefined,
      keepLegacy: opts.keepLegacy === true,
      authorised: true,
      dryRun: false,
      log,
      err,
    })),
  );

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

  // Wiring this run deliberately LEFT that still makes the client launch
  // yaw-mcp. Only --keep-legacy can produce one now: every drive-letter-case
  // sibling is cleared in the same write above, so an all-clear over an entry
  // this scope itself left behind -- the exact failure the drive-case sibling
  // produced -- cannot happen.
  //
  // The gate reaches exactly as far as `sites` does, and no further: the
  // containers THIS scope reads, canonical plus drive-case variants of the
  // same project dir. Another scope's wiring in the SAME file is outside it --
  // measured, with a root `mcpServers.mcp` (user scope) and a
  // projects[<dir>] entry both present, `uninstall --scope local` removes the
  // local entry, prints Done, and the root entry still launches yaw-mcp. That
  // per-scope reach predates this branch (uninstall resolves one scope and has
  // always spoken about it); widening the Done line to the file's other scopes
  // would make a scoped uninstall report on wiring it deliberately does not
  // touch, which is a separate decision. Read the line below as "nothing this
  // run left behind in the containers this scope reads".
  const stillLaunching = sites.filter((s) => s.legacyEntry !== null && !trimsLegacy(s));
  if (stillLaunching.length > 0) {
    const kept = stillLaunching.map((s) => `"${s.legacyEntry}"${where(s)}`);
    log(
      `\n${target.label} still launches yaw-mcp through the legacy ${kept.join(" and ")} ` +
        `entr${kept.length === 1 ? "y" : "ies"} you asked to keep (--keep-legacy). Remove ` +
        `${kept.length === 1 ? "it" : "them"} from ${resolved.absolute} to stop it. ` +
        "Your servers in ~/.yaw-mcp/bundles.json are untouched.",
    );
    return { written, wouldWrite: [], messages, exitCode: 0 };
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
