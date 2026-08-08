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
// ~/.yaw-mcp/config.json is NO LONGER written. It existed to carry the
// account token across clients, and yaw-mcp is local-only now — servers
// come from ~/.yaw-mcp/bundles.json. `--token` and `--no-yaw-mcp-config`
// are still ACCEPTED so scripted installs keep exiting 0, but they are
// inert and print a deprecation warning to stderr.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `mcp` entry                      → prompt (TTY) or refuse
//                                                  with --force/--skip flag.
//   - --dry-run                                  → print the would-be diff
//                                                  and exit 0 without writing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
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
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "./install-targets.js";
import { editJsoncEntry, parseJsonc } from "./jsonc.js";
import {
  MIN_OAM_VERSION,
  type OamProbe,
  oamFailureLabel,
  oamInstallCommand,
  probeOam,
  resolveStableNpmEntry,
} from "./oam-spawn.js";

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
  /** Overwrite an existing yaw-mcp entry without prompting. */
  force?: boolean;
  /** Leave an existing yaw-mcp entry untouched (exit 0). */
  skip?: boolean;
  /** Print the changes that would be made and exit without writing. */
  dryRun?: boolean;
  /** Test seams for the oam launch-entry decision, mirroring runDoctor's
   *  `oamProbe`. Without these the entry written depends on whether the
   *  MACHINE running the tests happens to have oam plus a durable
   *  @yawlabs/mcp install -- so the npx-entry assertions would pass on CI and
   *  fail on a maintainer's box, which is the worst way for a test to fail. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  resolveOamEntry?: (pkg: string) => string | null;
  /** DEPRECATED and ignored. Existed only to suppress the (now removed)
   *  ~/.yaw-mcp/config.json token write; install no longer touches that
   *  file at all. Still accepted, with a stderr warning. */
  skipYawMcpConfig?: boolean;
  /** Read-only: enumerate clients and show which scopes already host a yaw-mcp entry. */
  listOnly?: boolean;
  /** Install into every client available on this OS in one shot. */
  all?: boolean;
  /** Override for tests; defaults to homedir(). */
  home?: string;
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
  };
  /** Override for tests; replaces an interactive prompt with a fixed answer. */
  promptAnswer?: "overwrite" | "skip" | "abort";
  /** Set by the parser when `--help` / `-h` was passed. Dispatcher prints
   *  USAGE to stdout and exits 0 -- treated as a successful run, not an
   *  argv error. Keeps `-h` distinguishable from unknown-flag rejections. */
  helpRequested?: boolean;
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
}

const USAGE =
  "Usage: yaw-mcp install <claude-code|claude-desktop|cursor|vscode> [--scope user|project|local]\n" +
  "                       [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                       [--force | --skip] [--dry-run]\n" +
  "       yaw-mcp install --list  (detect clients; no writes)\n" +
  // "every client available on this OS", NOT "every detected client":
  // runInstallAll plans from `availableOn` (the OSes a client ships on), not
  // from a probe of what is actually installed here, so `--all` creates a
  // config for clients the user may not have. That is deliberate (it
  // pre-provisions), and --list is the detecting one -- the help text just
  // has to stop promising detection.
  "       yaw-mcp install --all   (install into every client available on this OS)\n" +
  "\n" +
  "  Deprecated (accepted, ignored, warns): --token <mcp_pat_…>, --no-yaw-mcp-config.\n" +
  "  yaw-mcp is local-only -- it stores no token and never writes ~/.yaw-mcp/config.json.\n" +
  "  Configure servers in ~/.yaw-mcp/bundles.json (see `yaw-mcp add <slug>`).";

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

  // Both sub-commands write into the SAME `messages` array this call already
  // accumulates (log/err push into it), so the returned InstallResult carries
  // the full printed trail -- including the deprecation notices emitted above
  // the dispatch, which a second, locally-built array silently dropped.
  if (opts.listOnly) return runInstallList(opts, log, messages);
  if (opts.all) return runInstallAll(opts, log, err, messages);

  if (opts.force && opts.skip) {
    err("yaw-mcp install: --force and --skip are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  if (!opts.clientId) {
    err(`yaw-mcp install: client argument required\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const target = INSTALL_TARGETS.find((t) => t.clientId === opts.clientId);
  if (!target) {
    err(`yaw-mcp install: unknown client ${opts.clientId}\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const os = opts.os ?? CURRENT_OS;
  if (!target.availableOn.includes(os)) {
    const fix =
      target.clientId === "claude-desktop" && os === "linux"
        ? "Anthropic ships Claude Desktop on macOS and Windows only. Install Claude Code or Cursor instead."
        : "Pick a different client or pass --os to override.";
    err(`yaw-mcp install: ${target.label} is not available on ${os}.\n  ${fix}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // Pick a default scope sensibly: prefer user-global where supported,
  // else fall back to the first scope the client supports (vscode → project).
  const scope: InstallScope =
    opts.scope ?? (target.scopes.find((s) => s.scope === "user") ? "user" : target.scopes[0].scope);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) {
    err(
      `yaw-mcp install: ${target.label} does not support scope "${scope}". Available: ${target.scopes.map((s) => s.scope).join(", ")}`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // `opts.cwd` is the documented cwd override and runInstallList honors it, so
  // the write path must too: without it a caller that redirects cwd (a test,
  // an embedder) still resolves project scope against the REAL process.cwd()
  // and writes .vscode/mcp.json into whatever directory the runner happens to
  // be in. It also kept `--list` and `install --scope project` reporting two
  // different directories.
  const projectDir = scopeSpec.requiresProjectDir ? resolve(opts.projectDir ?? opts.cwd ?? process.cwd()) : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({
      clientId: opts.clientId,
      scope,
      os,
      home: opts.home,
      projectDir,
      claudeConfigDir: opts.claudeConfigDir,
    });
  } catch (e) {
    err(`yaw-mcp install: ${(e as Error).message}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  // Read + merge existing client config.
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
    log(`Runtime: will run on oam${oamVersion}`);
    // The resolved entry is durable but not necessarily GLOBAL: a project
    // node_modules qualifies, and this config is machine-global, so an
    // `rm -rf node_modules` weeks from now kills the broker in every project
    // with nothing pointing back at the cause.
    if (isProjectLocalEntry(oamEntry, opts.cwd ?? process.cwd())) {
      log(
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
    log(
      `Runtime: node (oam${oamVersion} resolved only to the relative path \`${oamBinPath}\` -- a client config must ` +
        "carry an absolute one, since a GUI-launched client resolves a relative path against its own working " +
        "directory, not yours. Set OAM_BIN to oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamBinPath) {
    // oam is present and usable, but yaw-mcp itself resolves only to the npx
    // cache -- a path a config file must not persist.
    log("Runtime: node (oam found, but yaw-mcp is not durably installed -- `npm i -g @yawlabs/mcp` to host it on oam)");
  } else if (oamProbeResult.bin) {
    // Usable here, not persistable: `oam` runs in this shell but was not found
    // on PATH as a file, so the only value available to write is a bare name
    // the client would resolve against its own PATH.
    log(
      `Runtime: node (oam${oamVersion} runs here, but its absolute path could not be resolved -- a client config ` +
        `must not carry a bare \`${oamProbeResult.bin}\`, which a GUI-launched client cannot find. Set OAM_BIN to ` +
        "oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamProbeResult.belowMin) {
    log(
      `Runtime: node (oam${oamVersion} is below the ${MIN_OAM_VERSION} minimum -- upgrade oam and re-run install ` +
        "to host yaw-mcp on it)",
    );
  } else if (oamProbeResult.failure) {
    // oamFailureLabel, not a phrase table of our own: the probe distinguishes
    // broken from absent precisely so the user is not sent looking for an
    // install they already have, and doctor's OAM RUNTIME section plus
    // default-runtime's per-server reason report the same failure. Two wordings
    // is how one report says "unusable" and the next says "not installed".
    log(
      `Runtime: node (oam is installed but unusable: ${oamFailureLabel(oamProbeResult.failure)}` +
        `${oamProbeResult.failureDetail ? ` -- ${oamProbeResult.failureDetail}` : ""}. Fix or reinstall oam and ` +
        "re-run install to host yaw-mcp on it.)",
    );
  } else {
    // Plain absence -- binPath and bin both null, not below-min, no failure --
    // and the ONE branch of this chain that said nothing at all. "Every fallback
    // gets a reason" above was true of the misconfigurations and false of the
    // common case, so a user on a fresh machine got an npx entry with no line
    // saying an alternative existed. Worded as optional, because it is: node is
    // the supported runtime and nothing here is broken.
    log(
      `Runtime: node (oam is not installed, which is fine -- node runs everything. To host yaw-mcp on oam instead: ` +
        `\`${oamInstallCommand(os)}\`, then re-run install.)`,
    );
  }
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
  let legacyEntry: string | null = null;
  // EVERY legacy entry key still in the container, not just the first one
  // findLegacyEntry reports -- the settings.json patch needs the full set to
  // decide which legacy allow-patterns are still load-bearing.
  let legacyEntriesPresent: string[] = [];
  if (existsSync(resolved.absolute)) {
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      err(`yaw-mcp install: cannot read ${resolved.absolute}: ${(e as Error).message}`);
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          err(
            `yaw-mcp install: ${resolved.absolute} is not a JSON object — refusing to overwrite. Edit by hand or rename the file and re-run.`,
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
      legacyEntry = findLegacyEntry(c);
      legacyEntriesPresent = LEGACY_ENTRY_NAMES.filter((n) => n in c);
    }
  }

  if (existingHasEntry) {
    let decision: "overwrite" | "skip" | "abort";
    if (opts.force || opts.dryRun) decision = "overwrite";
    else if (opts.skip) decision = "skip";
    else if (opts.promptAnswer) decision = opts.promptAnswer;
    else if (opts.io?.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))) {
      decision = await promptCollision(resolved.absolute, opts.io);
    } else {
      err(
        `yaw-mcp install: ${resolved.absolute} already has a "${ENTRY_NAME}" entry and stdin is not a TTY.\n  Re-run with --force to overwrite, --skip to leave it, or --dry-run to preview.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (decision === "skip") {
      log(`Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`);
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    }
    if (decision === "abort") {
      err("Aborted.");
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    // Conditional tense under --dry-run: the decision above maps dryRun onto
    // "overwrite" so this collision path is exercised, but the run returns
    // before any write. Present tense here told a user scanning the transcript
    // that their preview had already mutated the file.
    log(
      opts.dryRun ? `Would overwrite existing "${ENTRY_NAME}" entry.` : `Overwriting existing "${ENTRY_NAME}" entry.`,
    );
  }

  // Carry over an existing entry's `env`. The merge replaces our entry
  // wholesale, and the default entry sets no env at all -- so re-running
  // install silently dropped anything the user had put there. OAM_BIN is the
  // live example: it pins which oam hosts the sidecars, and losing it moves
  // them to a different runtime with no diagnostic. Only fills a gap; an
  // entry that brings its own env (the upstream/try shape) is untouched.
  const previousEntry = readEntryAt(existing, containerPath, ENTRY_NAME);
  const previousEnv = previousEntry?.env;
  const entryToWrite =
    newEntry.env === undefined && previousEnv && Object.keys(previousEnv).length > 0
      ? { ...newEntry, env: previousEnv }
      : newEntry;
  if (entryToWrite !== newEntry) {
    log(`Kept existing env on the ${ENTRY_NAME} entry: ${Object.keys(previousEnv ?? {}).join(", ")}`);
  }

  // Two write paths, mirroring try-cmd:
  //   - file pre-exists with object content -> splice the entry into the
  //     ORIGINAL bytes via jsonc-parser, so comments, key order and the
  //     user's indentation all survive;
  //   - file missing or empty -> nothing to preserve, so build the object and
  //     render it (this path also materializes a missing container chain).
  let clientJson: string;
  if (rawClient !== null) {
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
          `yaw-mcp install: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not a JSON object — refusing to overwrite. Make it an object (or remove the key) and re-run.`,
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
        `Note: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not an object — ` +
          `${opts.dryRun ? "would replace" : "replaced"} it with an empty object so the "${ENTRY_NAME}" entry has somewhere to live.`,
      );
    }
    try {
      const next = editJsoncEntry(spliceSource, containerPath, ENTRY_NAME, entryToWrite);
      // Keep the file's own trailing-newline convention: editJsoncEntry
      // returns the user's bytes verbatim outside the edited span.
      clientJson = next.endsWith("\n") ? next : `${next}\n`;
    } catch (e) {
      err(
        `yaw-mcp install: failed to splice the "${ENTRY_NAME}" entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  } else {
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
          os,
          claudeConfigDir: opts.claudeConfigDir,
          // Legacy allow-patterns are only dead wildcards when the server they
          // grant is gone. install deliberately LEAVES a legacy mcpServers
          // entry in place (it only warns), so stripping that entry's pattern
          // in the same run revokes a still-running server's grant and Claude
          // Code re-prompts on every one of its tool calls.
          retainAllowPatterns: legacyEntriesPresent.map(legacyAllowPatternFor),
        })
      : null;

  // Surface a malformed/non-object settings.json rather than silently
  // skipping the permissions patch (the patch itself is best-effort, so
  // this never fails the install -- but the user needs to know the file
  // was left unpatched, distinct from the "already present" no-op which
  // stays silent).
  if (settingsPatch?.malformed) {
    err(
      `yaw-mcp install: warning — could not patch ${settingsPatch.path} (${settingsPatch.malformedReason}); left unchanged. Add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow by hand, or you may be re-prompted for each yaw-mcp tool call.`,
    );
  }

  if (opts.dryRun) {
    log("\n--- dry run: would write the following ---");
    log(`\n# ${resolved.absolute}\n${clientJson}`);
    if (settingsPatch?.changed) log(`# ${settingsPatch.path}\n${settingsPatch.nextJson}`);
    if (legacyEntry) {
      log(
        `Note: legacy "${legacyEntry}" entry at ${resolved.absolute} would remain — remove it to avoid running yaw-mcp twice.`,
      );
    }
    const wouldWrite: string[] = [resolved.absolute];
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  const written: string[] = [];

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

  // Claude Code: merge permissions.allow into settings.json so tool
  // calls don't prompt. Best-effort: any failure here is logged but does
  // NOT fail the overall install — the launch entry is already written.
  if (settingsPatch?.changed) {
    try {
      await atomicWriteFile(settingsPatch.path, settingsPatch.nextJson);
      log(`Wrote ${settingsPatch.path} (added ${CLAUDE_CODE_ALLOW_PATTERN} to permissions.allow)`);
      written.push(settingsPatch.path);
    } catch (e) {
      err(
        `yaw-mcp install: warning — failed to patch ${settingsPatch.path}: ${(e as Error).message}. You may be re-prompted for each yaw-mcp tool call; add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow to silence.`,
      );
    }
  }

  if (target.notes) log(`Note: ${target.notes}`);
  if (legacyEntry) {
    log(
      `Note: legacy "${legacyEntry}" entry remains at ${resolved.absolute}. Remove it to avoid running yaw-mcp twice.`,
    );
  }
  log(`\nDone: ${target.label} is configured. Restart it to pick up the new MCP server.`);
  return { written, wouldWrite: [], messages, exitCode: 0 };
}

/** Read `settings.json` (or settings.local.json) for the given scope,
 *  compute the next version with the yaw-mcp allow-pattern unioned into
 *  `permissions.allow`, and return both the path and the rendered JSON.
 *  Returns `changed: false` when the pattern is already present — caller
 *  can skip the write entirely. Returns null for scopes that have no
 *  corresponding settings file. Malformed or non-object existing files are
 *  left untouched (changed: false, malformed: true, malformedReason set);
 *  the caller emits a warning so the skip isn't silent. */
async function prepareClaudeCodeSettingsPatch(opts: {
  scope: InstallScope;
  home: string;
  projectDir: string | undefined;
  os: InstallOS;
  claudeConfigDir: string | undefined;
  /** Legacy allow-patterns to leave in place because the entry they grant is
   *  still wired in the client config. */
  retainAllowPatterns?: string[];
}): Promise<{
  path: string;
  nextJson: string;
  changed: boolean;
  malformed?: boolean;
  malformedReason?: string;
} | null> {
  const path = resolveClaudeCodeSettingsPath(opts.scope, {
    home: opts.home,
    projectDir: opts.projectDir,
    os: opts.os,
    claudeConfigDir: opts.claudeConfigDir,
  });
  if (!path) return null;

  let existing: Record<string, unknown> = {};
  // Raw bytes of the pre-existing settings.json, for the same reason install
  // keeps the client config's: settings.json is JSONC and hand-maintained,
  // and a JSON.stringify rewrite drops every comment in it.
  let rawSettings: string | null = null;
  if (existsSync(path)) {
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
          return { path, nextJson: "", changed: false, malformed: true, malformedReason: "not a JSON object" };
        }
      }
    } catch (e) {
      // Malformed settings.json — don't try to rewrite; flag it so the
      // caller can warn (let the user fix it by hand).
      return { path, nextJson: "", changed: false, malformed: true, malformedReason: (e as Error).message };
    }
  }

  const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN], opts.retainAllowPatterns);
  // If nothing changed, signal no-op to the caller.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return { path, nextJson: "", changed: false };
  if (rawSettings !== null) {
    // Only `permissions.allow` changes, so edit exactly that node in the
    // original bytes. Everything else -- hooks, model, comments, formatting --
    // is left untouched rather than re-serialized.
    const nextAllow = (merged.permissions as { allow: string[] }).allow;
    try {
      const next = editJsoncEntry(rawSettings, ["permissions"], "allow", nextAllow);
      return { path, nextJson: next.endsWith("\n") ? next : `${next}\n`, changed: true };
    } catch (e) {
      // jsonc-parser could not locate/splice the node (e.g. `permissions` is
      // an array). Surface it the same way an unparseable file is surfaced
      // rather than silently falling back to a comment-destroying rewrite.
      return { path, nextJson: "", changed: false, malformed: true, malformedReason: (e as Error).message };
    }
  }
  return { path, nextJson: `${JSON.stringify(merged, null, 2)}\n`, changed: true };
}

/** Claude Code derives a server's tool-name prefix from its entry key by
 *  replacing every non-alphanumeric char with `_` (see CLAUDE_CODE_ALLOW_PATTERN
 *  in install-targets.ts), so `yaw-mcp` grants `mcp__yaw_mcp__*` and
 *  `mcp.hosting` grants `mcp__mcp_hosting__*`. Derived rather than tabulated so
 *  a new LEGACY_ENTRY_NAMES member cannot silently miss its pattern. */
function legacyAllowPatternFor(entryName: string): string {
  return `mcp__${entryName.replace(/[^A-Za-z0-9]/g, "_")}__*`;
}

/** Allow-patterns earlier installers wrote into Claude Code's
 *  `permissions.allow` (the dead mcp.hosting brand and the interim yaw-mcp
 *  key). Stripped on upgrade so dead wildcards don't accumulate forever —
 *  no live tool name can match them ONCE THE ENTRY THAT SERVED THEM IS GONE.
 *  A pattern whose legacy mcpServers entry is still wired is NOT dead, so the
 *  caller passes it via `retain` (see legacyAllowPatternFor). */
const LEGACY_CLAUDE_CODE_ALLOW_PATTERNS = ["mcp__mcp_hosting__*", "mcp__yaw_mcp__*"];

/** Union `patterns` into `existing.permissions.allow`, preserving every
 *  other key. Deduplicates by string equality so repeated installs don't
 *  grow the list. Also drops any pre-rename legacy patterns first so
 *  upgraded installs don't keep a dead wildcard around -- except the ones in
 *  `retain`, whose legacy server entry the caller found still present.
 *  Exported for tests. */
export function mergePermissionsAllow(
  existing: Record<string, unknown>,
  patterns: string[],
  retain: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prev = out.permissions;
  const perms: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const prevAllow = perms.allow;
  const allow: string[] = Array.isArray(prevAllow)
    ? (prevAllow as unknown[]).filter(
        (x): x is string =>
          typeof x === "string" && (retain.includes(x) || !LEGACY_CLAUDE_CODE_ALLOW_PATTERNS.includes(x)),
      )
    : [];
  for (const p of patterns) {
    if (!allow.includes(p)) allow.push(p);
  }
  perms.allow = allow;
  out.permissions = perms;
  return out;
}

async function promptCollision(path: string, io: InstallCommandOptions["io"]): Promise<"overwrite" | "skip" | "abort"> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await rl.question(
        `${path} already has an "${ENTRY_NAME}" entry.\n  [o]verwrite, [s]kip, or [a]bort? (default: skip) `,
      )
    )
      .trim()
      .toLowerCase();
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
 * jsonc-parser's `modify` materializes MISSING intermediate keys but throws
 * "Can not add index to parent of type null" on one that exists and holds a
 * non-object -- an internal message naming neither the file nor the key. The
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
    // Absent from here down: jsonc-parser builds the rest of the chain itself.
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

/** Merge `entry` into the container at `existing[...containerPath][entryName]`,
 *  preserving every sibling at every level of the path. Returns a new object;
 *  does not mutate. For Claude Code local scope, containerPath is
 *  ["projects", <absDir>, "mcpServers"] and this preserves every other
 *  project's settings + every other top-level key in ~/.claude.json.
 *  `entryName` defaults to ENTRY_NAME (the canonical yaw-mcp entry);
 *  `yaw-mcp try` overrides it with `yaw-mcp-try-<slug>` so the trial entry sits
 *  next to a real yaw-mcp install without colliding. */
/** Read the existing launch entry at `containerPath`, or null when the path or
 *  the entry is absent. Mirrors mergeClientConfig's walk so the two agree on
 *  where the entry lives. */
export function readEntryAt(
  existing: Record<string, unknown>,
  containerPath: string[],
  entryName: string = ENTRY_NAME,
): { command?: string; args?: string[]; env?: Record<string, string> } | null {
  let node: unknown = existing;
  for (const key of containerPath) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const entry = (node as Record<string, unknown>)[entryName];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  return entry as { command?: string; args?: string[]; env?: Record<string, string> };
}

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

/** Remove `entryName` from the container at `existing[...containerPath]`,
 *  preserving every sibling at every level. Returns a new object; does not
 *  mutate. If the container or entry doesn't exist, returns `existing`
 *  unchanged (caller can detect via reference equality). Used by `yaw-mcp
 *  try-cleanup` and doctor's trial-GC pass to peel a `yaw-mcp-try-<slug>`
 *  entry back out of the client config without touching anything else. */
export function removeFromClientConfig(
  existing: Record<string, unknown>,
  containerPath: string[],
  entryName: string,
): Record<string, unknown> {
  if (containerPath.length === 0) throw new Error("removeFromClientConfig: containerPath cannot be empty");
  // Walk to check the entry exists before allocating a clone.
  let probe: unknown = existing;
  for (const key of containerPath) {
    if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return existing;
    probe = (probe as Record<string, unknown>)[key];
  }
  if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return existing;
  if (!(entryName in (probe as Record<string, unknown>))) return existing;

  const out: Record<string, unknown> = { ...existing };
  let parent: Record<string, unknown> = out;
  for (let i = 0; i < containerPath.length - 1; i++) {
    const key = containerPath[i];
    const child = parent[key];
    const cloned: Record<string, unknown> = { ...(child as Record<string, unknown>) };
    parent[key] = cloned;
    parent = cloned;
  }
  const leafKey = containerPath[containerPath.length - 1];
  const container = { ...(parent[leafKey] as Record<string, unknown>) };
  delete container[entryName];
  parent[leafKey] = container;
  return out;
}

/** CLI argv parser used by index.ts dispatcher. Exported so tests can
 *  exercise flag parsing without spawning a subprocess. */
export function parseInstallArgs(argv: string[]):
  | {
      ok: true;
      options: InstallCommandOptions;
    }
  | { ok: false; error: string; help?: boolean } {
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
        if (!v || v.startsWith("--")) return { ok: false, error: "--token requires a value" };
        opts.token = v;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v || v.startsWith("--")) return { ok: false, error: "--project-dir requires a value" };
        opts.projectDir = v;
        break;
      }
      case "--force":
        opts.force = true;
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
  const cwd = opts.cwd ?? process.cwd();
  const os = opts.os ?? CURRENT_OS;
  const probes = await probeClientsAsync({ home, os, cwd, claudeConfigDir: opts.claudeConfigDir });

  const rows = probes.map((p) => ({
    client: INSTALL_TARGETS.find((t) => t.clientId === p.clientId)?.label ?? p.clientId,
    scope: p.scope,
    path: displayPath(p.path, home),
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
  log("Install into every available client (user scope where supported): `yaw-mcp install --all`");
  return { written: [], wouldWrite: [], messages, exitCode: 0 };
}

function statusFor(p: ClientProbeResult): string {
  if (p.unavailable) return "unavailable";
  if (p.malformed) return "malformed";
  if (p.hasMcpEntry) return "installed";
  if (p.exists) return "other-entries";
  return "not installed";
}

function displayPath(abs: string, home: string): string {
  if (abs === "(n/a)") return abs;
  if (home && abs.startsWith(home)) {
    const tail = abs.slice(home.length).replace(/^[\\/]/, "");
    return `~${process.platform === "win32" ? "\\" : "/"}${tail}`;
  }
  return abs;
}

/** `yaw-mcp install --all` — install into every available client (user
 *  scope where supported). For clients without a user scope, falls back to
 *  the first non-project scope; clients that ONLY have project scopes
 *  (vscode) are included just when --project-dir is passed, otherwise
 *  skipped. Aggregates results; exit code 0 only if every attempted
 *  install succeeded. Mirrors the per-client run behavior: prompts/--force/
 *  --skip flags propagate. */
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
  type Plan = { clientId: InstallClientId; scope: InstallScope };
  const plans: Plan[] = [];
  const skipped: Array<{ clientId: InstallClientId; reason: string }> = [];
  for (const t of targets) {
    const userScope = t.scopes.find((s) => s.scope === "user");
    if (userScope) {
      plans.push({ clientId: t.clientId, scope: "user" });
      continue;
    }
    const firstNoProj = t.scopes.find((s) => !s.requiresProjectDir);
    if (firstNoProj) {
      plans.push({ clientId: t.clientId, scope: firstNoProj.scope });
      continue;
    }
    if (opts.projectDir) {
      plans.push({ clientId: t.clientId, scope: t.scopes[0].scope });
      continue;
    }
    skipped.push({
      clientId: t.clientId,
      reason: `requires --project-dir (scopes: ${t.scopes.map((s) => s.scope).join(", ")})`,
    });
  }

  log(`Installing into ${plans.length} client${plans.length === 1 ? "" : "s"}…`);
  if (skipped.length > 0) {
    for (const s of skipped) log(`  skip ${s.clientId}: ${s.reason}`);
  }
  log("");

  const aggregateWritten: string[] = [];
  const aggregateWouldWrite: string[] = [];
  let failed = 0;
  let succeeded = 0;
  // Collision-without-flag refusals (non-TTY, no --force/--skip) all carry
  // the same fix -- re-run --all with --force or --skip. Under --all they'd
  // otherwise stack up as N identical per-client "already has entry and
  // stdin is not a TTY" stderr lines. Capture each sub-install's stderr,
  // suppress that specific refusal, and emit ONE consolidated hint below.
  const collisionClients: string[] = [];
  const realStderr = opts.io?.stderr ?? process.stderr;
  const isCollisionRefusal = (s: string): boolean =>
    s.includes(`already has a "${ENTRY_NAME}" entry and stdin is not a TTY`);
  for (const plan of plans) {
    log(`── ${plan.clientId} (${plan.scope}) ──`);
    let sawCollision = false;
    // Per-call stderr: replay every line to the real stderr EXCEPT the
    // collision-without-flag refusal, which we consolidate.
    const subStderr = new Writable({
      write(chunk: Buffer | string, _enc, cb): void {
        const text = chunk.toString();
        if (isCollisionRefusal(text)) sawCollision = true;
        else realStderr.write(text);
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
    const baseIo = opts.io ?? {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    };
    const result = await runInstall({
      ...opts,
      listOnly: false,
      all: false,
      // Strip the deprecated flags: runInstall warns about them at the top
      // of every call, and the --all entry point has already warned once.
      // Without this the user gets one notice per client.
      token: undefined,
      skipYawMcpConfig: undefined,
      clientId: plan.clientId,
      scope: plan.scope,
      io: { ...baseIo, stderr: subStderr },
    });
    if (sawCollision) collisionClients.push(plan.clientId);
    aggregateWritten.push(...result.written);
    aggregateWouldWrite.push(...result.wouldWrite);
    // Splice each sub-install's trail in right where it printed, between this
    // client's header and the blank line that closes it.
    messages.push(...result.messages);
    if (result.exitCode === 0) succeeded += 1;
    else failed += 1;
    log("");
  }

  if (collisionClients.length > 0) {
    err(
      `yaw-mcp install --all: ${collisionClients.length} client${collisionClients.length === 1 ? "" : "s"} already have a "${ENTRY_NAME}" entry (${collisionClients.join(", ")}) and stdin is not a TTY.\n  Re-run \`yaw-mcp install --all --force\` to overwrite them, or \`--skip\` to leave them untouched.`,
    );
  }

  const totalPlanned = plans.length;
  if (failed === 0) {
    log(`Done: ${succeeded}/${totalPlanned} clients installed successfully.`);
    return {
      written: aggregateWritten,
      wouldWrite: aggregateWouldWrite,
      messages,
      exitCode: 0,
    };
  }
  err(`${failed}/${totalPlanned} client install${failed === 1 ? "" : "s"} failed. ${succeeded} succeeded.`);
  return {
    written: aggregateWritten,
    wouldWrite: aggregateWouldWrite,
    messages,
    exitCode: 1,
  };
}

export const INSTALL_USAGE = USAGE;
