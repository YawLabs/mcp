/**
 * Re-point broker entries whose baked launch path no longer exists.
 *
 * THE DEFECT THIS EXISTS FOR. `install` persists an ABSOLUTE path to the
 * broker's own entry file whenever it can host the broker on oam. For the copy
 * bundled inside Yaw Terminal that path used to be realpathed past the
 * updater's junction -- `...\apps\yaw\2.1.2\resources\...` -- and the app's
 * next upgrade deleted that directory. `oam run` cannot refetch a missing
 * entry file the way `npx` can, so the client stopped being able to start the
 * broker at all, silently, until someone happened to open the panel.
 *
 * `stableSpellingOf` (stable-entry.ts) stops NEW entries rotting. It does
 * nothing for the ones already on disk, and nothing in the product rewrites a
 * client config on upgrade or at startup -- doctor says exactly that in its
 * own words. This module is that missing rewrite.
 *
 * THE DISCIPLINE IT BORROWS. The app solved this once already, for Claude
 * Code, and wrote the doctrine down (yaw/src/yaw-mcp-entry.ts): an absolute
 * path is safe to persist ONLY because the writer can recognise its own
 * previous output and refresh it. That recognition is what makes a rewrite a
 * repair rather than a clobber, and it is the whole of the safety argument
 * here. Four gates must ALL pass before a single byte is written:
 *
 *   1. SHAPE IS OURS  -- an `oam run` launch whose entry file sits inside a
 *      `node_modules/@yawlabs/mcp/` tree. A hand-written entry, a pinned
 *      `--package` form, a bare `oam`, or an oam entry for somebody else's
 *      server all fail this and are invisible to the sweep.
 *   2. ACTUALLY BROKEN -- the entry path is not a regular file: missing, or a
 *      directory, or an unreadable or dangling link. A WORKING entry is never
 *      touched, however unusual it looks, so a user who hand-tuned something
 *      that still starts keeps it.
 *   3. NOT READ-ONLY  -- `YAW_MCP_READONLY_DIAGNOSTICS` is honoured, so the
 *      panel's background poll stays a pure read. That flag exists precisely
 *      so a poll nobody asked for writes nothing, and this does not flip it.
 *   4. NOT FOREIGN    -- an entry written for another OS is unverifiable from
 *      here, never broken. A WSL session reading a Windows profile passes every
 *      recogniser above and then fails gate 2 for the wrong reason, because
 *      `statSync` on `C:\...` from Linux throws. See isForeignEntry.
 *
 * Gate 2 is also what makes the pass converge: it is a no-op the instant the
 * entry resolves, so it cannot fight another writer or rewrite in a loop.
 *
 * STDOUT IS OFF LIMITS. The primary trigger runs inside `serve`, where
 * `process.stdout` IS the JSON-RPC transport and one stray byte corrupts the
 * session. Everything here reports through `log` (stderr) or through the
 * returned result.
 */
import { statSync } from "node:fs";
import { atomicWriteFile } from "./atomic-write.js";
import {
  addressOf,
  applyClientConfigEdits,
  type ConfigSite,
  carriedFieldsOf,
  carryableEnvOf,
  composeEntry,
  launchOf,
  readClientConfigFile,
  readClientEnv,
  selectSites,
  terminateWithNewline,
} from "./client-config.js";
import { isReadOnlyDiagnostics } from "./config-loader.js";
import { isForeignAbsoluteLaunch, oamRunEntryPath } from "./doctor-cmd.js";
import { ENTRY_NAME, resolveAppDataDir } from "./install-target-model.js";
import {
  buildLaunchEntry,
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallOS,
  type InstallTarget,
  resolveInstallSites,
} from "./install-targets.js";
import { log } from "./logger.js";
import { type OamProbe, probeOam, resolveStableNpmEntry } from "./oam-spawn.js";
import { isFeatureDisabled } from "./opt-out-env.js";
import { describeWriteFailure } from "./write-failure.js";

/** One entry this pass re-pointed. */
export interface HealedEntry {
  clientId: string;
  scope: string;
  /** The config file that was rewritten. */
  path: string;
  /** The dead entry-file path that was replaced. */
  from: string;
  /** What the entry launches now -- a path, or `"npx"` when no durable entry
   *  could be resolved and the self-refetching form is the honest answer. */
  to: string;
}

/** A config this pass could not even look inside, so it can make no claim
 *  about whether the entry in it is healthy. Reported separately because
 *  "nothing to repair" and "I declined to read it" are different answers and
 *  only one of them means the user is fine. */
export interface UnhealableConfig {
  clientId: string;
  scope: string;
  path: string;
  /** The `ConfigRead` kind that stopped us: `unspliceable`, `blocked`,
   *  `malformed` or `unreadable`. */
  reason: string;
}

/** A stale entry this pass set out to re-point and could not: every gate
 *  passed, so the entry IS ours and IS broken, and then the rewrite did not
 *  land. Its client still names a launch file that is gone.
 *
 *  Reported on its own, never folded into either list above. It is not
 *  `healed` (nothing changed on disk), and it is not `unhealable` either: the
 *  sweep read the file fine and knows exactly which entry is dead. Before this
 *  existed the failure went to a log line and nowhere else, so `yaw-mcp heal`
 *  over a read-only config.toml said "No stale yaw-mcp entries found." and
 *  exited 0 -- straight after its own dry run had said "Would re-point 1
 *  stale entry". */
export interface FailedHeal {
  clientId: string;
  scope: string;
  /** The config file that still holds the dead entry. */
  path: string;
  /** The dead entry-file path the entry still names. */
  from: string;
  /** What the rewrite would have launched -- same meaning as HealedEntry.to. */
  to: string;
  /** Why it did not land, as one clause with no final period, naming `path`:
   *  describeWriteFailure's words for a write the disk refused (the file, why,
   *  and the step past it), or the edit's own refusal for a write that was
   *  never attempted (a file its client cannot load, a splice that would not
   *  verify). */
  error: string;
}

/** What one sweep concluded. */
export interface HealResult {
  healed: HealedEntry[];
  unhealable: UnhealableConfig[];
  failed: FailedHeal[];
}

export interface HealOptions {
  os?: InstallOS;
  home?: string;
  /** Windows `%APPDATA%`. Left unset, it is chosen exactly as doctor chooses
   *  it -- `resolveAppDataDir({ home, env })` -- so an overridden `home` keeps
   *  a hermetic run inside that home and an ambient redirect is honoured. */
  appData?: string;
  cwd?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. Left unset, it is read from `env`
   *  through `readClientEnv`, along with every other client's redirect. */
  claudeConfigDir?: string;
  /** The environment the sweep reads its gates AND its client redirects from:
   *  YAW_MCP_READONLY_DIAGNOSTICS, YAW_MCP_AUTO_HEAL, and -- through the one
   *  reader doctor and install use -- CLAUDE_CONFIG_DIR, CODEX_HOME, the
   *  CLINE_* trio, CONTINUE_GLOBAL_DIR, XDG_CONFIG_HOME and %APPDATA%. */
  env?: NodeJS.ProcessEnv;
  /** Path SEMANTICS of the machine doing the inspecting -- never the `os`
   *  option, which picks which client layout to look at. Same seam and same
   *  distinction as doctor's ProbeOptions.platform, and it exists for the same
   *  case: a WSL session reading a Windows profile. */
  platform?: NodeJS.Platform;
  /** Plan only: compute and return what WOULD change, write nothing. */
  dryRun?: boolean;
  /** Test seams, same pair install-cmd exposes and for the same reason: the
   *  real probe spawns oam, so whether the rebuilt entry is an oam entry or an
   *  npx one would otherwise depend on whether the machine running the test
   *  happens to have oam installed. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  resolveOamEntry?: (pkg: string) => string | null;
  /** Test seam for the one write the sweep makes: atomicWriteFile unless a
   *  test says otherwise. A real read-only file only fails that write on
   *  Windows -- POSIX rename(2) asks the DIRECTORY for write access, never the
   *  file it replaces -- so a test that has to fail the write on every runner
   *  throws from here instead. */
  writeConfig?: (path: string, text: string) => Promise<void>;
}

/**
 * Normalised for comparison: separators folded always, case folded ONLY where
 * the filesystem folds it.
 *
 * Lowercasing unconditionally was wrong off Windows. Linux and a case-sensitive
 * APFS volume treat `/opt/Yaw` and `/opt/yaw` as two different directories, so
 * folding case there can call two distinct files equal -- which would let the
 * dedupe key collapse two real entries into one (healing only the first) and
 * let the convergence guard mistake a different path for the old one (skipping
 * a repair that was needed).
 */
function norm(p: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = p.split("\\").join("/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * An entry written for a DIFFERENT operating system than the one inspecting it.
 *
 * The case this exists for is a WSL session reading a Windows profile. Every
 * recogniser upstream says yes to such an entry -- `oam.exe` is an oam command,
 * and the path really does sit inside an `@yawlabs/mcp` tree -- but `statSync`
 * on `C:\...` from Linux throws, so gate 2 reads BROKEN and the sweep would
 * rewrite a working Windows entry with Linux paths, breaking the Windows client
 * that owns it.
 *
 * Doctor already refuses to judge this shape (isForeignAbsoluteLaunch): it
 * reports the row as unverifiable rather than broken, precisely because the
 * exists check cannot be applied across the boundary. The healer needs the same
 * rule and needs it more, because doctor only prints and this WRITES.
 *
 * Checked in both directions. `isForeignAbsoluteLaunch` covers a drive-letter
 * path seen from POSIX; the POSIX-path-seen-from-win32 half is checked here,
 * because win32's `isAbsolute` accepts `/foo` and `statSync` would then answer
 * about the current drive rather than about the file the entry means.
 */
function isForeignEntry(command: string, entryPath: string, platform: NodeJS.Platform): boolean {
  if (isForeignAbsoluteLaunch(command, platform)) return true;
  if (platform === "win32" && (entryPath.startsWith("/") || command.startsWith("/"))) return true;
  return false;
}

/** Gate 1. Is this entry file one WE would have written -- i.e. does it live
 *  inside an `@yawlabs/mcp` package tree? Anchored on the package directory
 *  rather than on the exact `dist/index.js` tail, which is the package's `bin`
 *  and may legitimately move between versions. */
function isOwnBrokerEntry(entryPath: string): boolean {
  return norm(entryPath).includes("/node_modules/@yawlabs/mcp/");
}

/** Gate 2's real question: can `oam run` actually start this path? Only a
 *  regular file can be, so a directory sitting at the entry path is as broken
 *  as a missing one. Throws (ENOENT, EACCES, a dangling symlink) count as
 *  broken, which is the safe direction: the worst case is rewriting an entry
 *  that was already not going to start. */
function isLaunchableFile(entryPath: string): boolean {
  try {
    return statSync(entryPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Re-point every stale broker entry this machine can see.
 *
 * Never rejects for a per-file problem: a machine with one unreadable config
 * must still heal the others, and every caller is a fire-and-forget startup
 * path.
 *
 * A stale entry it set out to rewrite and could not is returned under
 * `failed` and NOT logged here. Each caller reports it on its own surface --
 * `yaw-mcp heal` (heal-cmd.ts) prints it on stderr and exits 1, and the serve
 * wrapper below logs it -- so a person at a terminal sees it once, in the
 * command's own words, rather than once more as a raw log line.
 */
export async function healStaleBrokerEntries(opts: HealOptions = {}): Promise<HealResult> {
  const env = opts.env ?? process.env;
  // Gate 3, checked once and up front.
  if (isReadOnlyDiagnostics(env)) return { healed: [], unhealable: [], failed: [] };

  const os = opts.os ?? CURRENT_OS;
  const platform = opts.platform ?? process.platform;
  const healed: HealedEntry[] = [];
  const unhealable: UnhealableConfig[] = [];
  const failed: FailedHeal[] = [];
  const writeConfig = opts.writeConfig ?? atomicWriteFile;

  // Resolved ONCE for the whole sweep, and LAZILY: probing oam spawns a
  // process, and this pass runs on every broker start. The steady state is
  // "nothing is stale", so paying a process spawn to discover that would be a
  // permanent tax on startup for a one-off repair. Nothing is spawned until a
  // rewrite is actually about to happen; after that the memo keeps it to one.
  let replacement: { oamBinPath: string | null; oamEntry: string | null } | null = null;
  const replacementFor = async (): Promise<{ oamBinPath: string | null; oamEntry: string | null }> => {
    if (replacement !== null) return replacement;
    let oamBinPath: string | null = null;
    try {
      oamBinPath = (await (opts.oamProbe ?? probeOam)()).binPath;
    } catch {
      oamBinPath = null;
    }
    const resolveEntry = opts.resolveOamEntry ?? resolveStableNpmEntry;
    replacement = { oamBinPath, oamEntry: oamBinPath === null ? null : resolveEntry("@yawlabs/mcp") };
    return replacement;
  };

  // Where every client's config lives, resolved the way DOCTOR resolves it and
  // for the same reason install threads the same values: every client env var
  // goes through the ONE reader (`readClientEnv`), and %APPDATA% through the
  // one helper that reads it (`resolveAppDataDir`). This pass used to build
  // its sites from `opts.claudeConfigDir` / `opts.appData` alone, and neither
  // caller supplied them -- so under CLAUDE_CONFIG_DIR (every Yaw pane),
  // CODEX_HOME, a redirected %APPDATA%, the CLINE_* trio or
  // CONTINUE_GLOBAL_DIR, the sweep inspected the DEFAULT file, reported "no
  // stale entries", and doctor went on flagging the redirected one. An
  // explicit option still wins, so a test can pin a path without an env.
  //
  // `home` is deliberately NOT defaulted here: `resolveInstallSites` falls
  // back to os.homedir() itself, and `resolveAppDataDir` reads the ambient
  // %APPDATA% only when no home was given -- which keeps a test that passes
  // `home` hermetic and a real run on the redirected directory.
  const clientEnv = readClientEnv(env);
  const appData = resolveAppDataDir({ appData: opts.appData, home: opts.home, env });
  const claudeConfigDir = opts.claudeConfigDir ?? clientEnv.claudeConfigDir;

  // One physical entry, healed once. Codex CLI's user and project scopes
  // resolve to the SAME file AND the same container when the process cwd is
  // the home directory -- which is exactly what happens under Yaw Terminal,
  // whose main process chdirs to home. Without this the second pass would read
  // the file the first pass just rewrote and report a phantom second repair.
  const seen = new Set<string>();

  /** The sweep over ONE file: read it, apply the four gates, rewrite if every
   *  one passes. Never throws for a per-file problem. */
  const healSite = async (target: InstallTarget, scope: string, site: ConfigSite) => {
    try {
      // Same transform install reads with, so carried fields and the
      // normalised view match what install would compute for this row.
      const view = await readClientConfigFile(site, { transform: target.entry });
      if (view.read.kind !== "ok") {
        // A file this pass DECLINED to look inside is not the same as a file
        // with nothing wrong, and reporting "no stale entries found" for one
        // is the misleading half of a silent skip. `unspliceable` is the one
        // that bites in practice -- a TOML root-level inline
        // `mcp_servers = { ... }` parses fine and holds our entry, but the
        // splicer will not edit it -- so the user can be sitting on a dead
        // entry this pass will never repair and never mention. Collected and
        // surfaced by the caller; doctor still explains each one in full.
        if (view.read.kind !== "absent") {
          unhealable.push({
            clientId: target.clientId,
            scope,
            path: site.resolved.absolute,
            reason: view.read.kind,
          });
        }
        return;
      }
      const stored = view.read.entries.find((e) => e.key === ENTRY_NAME);
      if (stored === undefined) return;

      const launch = stored.launch ?? launchOf(stored.value);
      if (launch === null) return;

      // Gate 1: an oam launch, pointing into our own package tree.
      const entryPath = oamRunEntryPath(launch.command, launch.args);
      if (entryPath === null || !isOwnBrokerEntry(entryPath)) return;

      // Written for another OS than the one inspecting: unverifiable here,
      // never broken. See isForeignEntry -- this is the WSL case, and it is
      // checked BEFORE gate 2, because gate 2 is exactly what gets it wrong.
      if (isForeignEntry(launch.command, entryPath, platform)) return;

      // Gate 2: only a BROKEN entry is ever rewritten.
      //
      // A FILE, not merely something at that path: `existsSync` is true for a
      // directory, and `oam run <a directory>` cannot start the broker any
      // more than a missing path can -- so testing existence alone declared
      // an unstartable entry healthy and left it that way. statSync follows
      // symlinks, which is what we want: a link to a real file is fine, and a
      // dangling one throws and counts as broken.
      if (isLaunchableFile(entryPath)) return;

      const { oamBinPath, oamEntry } = await replacementFor();
      const base = buildLaunchEntry({
        os,
        oamBinPath,
        oamEntry,
        windowsWrap: target.entry?.windowsLaunch?.broker !== "bare",
      });
      const next = composeEntry({
        base,
        transform: target.entry,
        os,
        purpose: "broker",
        env: carryableEnvOf(stored.value),
        carried: carriedFieldsOf(stored.value, target.entry),
      });

      // Belt and braces: if the rebuild names the same dead path, writing it
      // changes nothing and would make the pass look productive when it is
      // not. It cannot happen today -- the resolver existsSync-checks its own
      // answer -- but the cost of being wrong here is an endless rewrite.
      const nextLaunch = launchOf(next);
      const nextEntry = nextLaunch === null ? null : oamRunEntryPath(nextLaunch.command, nextLaunch.args);
      if (nextEntry !== null && norm(nextEntry, platform) === norm(entryPath, platform)) return;

      // From here the entry is known to be ours and broken, and this pass has
      // decided to rewrite it. A failure past this point is not a file to skip
      // quietly: the client still names a launch file that is gone, so it is
      // reported under `failed`, never left to the catch below.
      const outcome = {
        clientId: target.clientId,
        scope,
        path: site.resolved.absolute,
        from: entryPath,
        to: nextEntry ?? "npx",
      };

      // Rendered BEFORE the dry-run branch, the way install renders its
      // editor copies: applyClientConfigEdits is where a refusal lives (a file
      // its client cannot load, a splice that will not verify), and it only
      // returns TEXT, so a dry run can ask it too. A preview that skipped it
      // promised a repair the live run then refused.
      let text: string;
      try {
        text = applyClientConfigEdits(view, [{ op: "upsert", key: ENTRY_NAME, entry: next }], site);
      } catch (err) {
        // install's wording for the same refusal, without its "Refusing to
        // overwrite." -- the caller says what did not happen. The refusal's
        // own message names the file and, where it has one, the by-hand fix.
        failed.push({
          ...outcome,
          error: `failed to splice the "${ENTRY_NAME}" entry into ${site.resolved.absolute} (${err instanceof Error ? err.message : String(err)})`,
        });
        return;
      }

      if (opts.dryRun !== true) {
        try {
          // Terminated the way install, try and import terminate what they
          // write. A splice leaves the bytes outside its own span alone, so
          // without this a file that did not end in a line break would still
          // not end in one after a heal. terminateWithNewline adds exactly
          // one, in the file's own line ending, and leaves a file that already
          // ends in one as it is. Nothing compares this text by identity
          // afterwards -- gate 2 and the check above have already decided the
          // entry changes -- so it cannot turn a no-op into a phantom write.
          await writeConfig(site.resolved.absolute, terminateWithNewline(text));
        } catch (err) {
          // Worded by describeWriteFailure, as install and uninstall word the
          // same failure: node's errno named the temp sibling atomicWriteFile
          // renames from and said nothing to do. No env hint is passed, and
          // none is needed: that hint names the variable behind a directory
          // mkdir could not make, and this file was just read, so its
          // directory is already there.
          failed.push({ ...outcome, error: describeWriteFailure(site.resolved.absolute, err) });
          return;
        }
      }

      healed.push(outcome);
    } catch (err) {
      // Anything else that throws for this site -- none is expected: the read
      // classifies its own IO errors, and the rewrite reports its own
      // failures under `failed` above. One bad config must not stop the sweep.
      log("warn", "Could not heal a stale yaw-mcp entry", {
        path: site.resolved.absolute,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (const target of INSTALL_TARGETS) {
    for (const scope of target.scopes) {
      let sites: ConfigSite[];
      try {
        // EVERY site the row declares that this machine has, not the first
        // one. One row -- Cline -- fans a single (client, scope) out to a
        // shared file plus one copy per editor its extension has run in, and
        // install writes all of them; a sweep that read only `[0]` left a
        // dead entry in every editor copy it never looked at. `selectSites`
        // is install's own filter: a conditional copy counts only when its
        // editor's storage directory exists, which is also what makes the
        // file exist at all.
        sites = selectSites(
          resolveInstallSites({
            clientId: target.clientId,
            scope: scope.scope,
            os,
            home: opts.home,
            appData,
            projectDir: scope.requiresProjectDir ? (opts.cwd ?? process.cwd()) : undefined,
            claudeConfigDir,
            clientEnv,
          }),
        );
      } catch {
        // A scope that needs a project dir we cannot supply is simply not a
        // slot on this machine.
        continue;
      }

      for (const site of sites) {
        const key = `${norm(site.resolved.absolute, platform)}::${addressOf(site).containerPath.join(".")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await healSite(target, scope.scope, site);
      }
    }
  }

  if (healed.length > 0) {
    log("info", "Re-pointed stale yaw-mcp entries whose launch file no longer existed", {
      count: healed.length,
      clients: healed.map((h) => `${h.clientId} (${h.scope})`),
    });
  }
  return { healed, unhealable, failed };
}

/**
 * The startup wrapper: the same sweep, opt-out-able and incapable of
 * rejecting. `serve` calls this and does not await it.
 *
 * It is also where the serve path reports a rewrite that did not land. The
 * sweep returns those rather than logging them (see healStaleBrokerEntries),
 * and serve has no other surface: one warn line per entry, carrying the same
 * clause `yaw-mcp heal` prints, and the server carries on.
 */
export async function maybeHealStaleBrokerEntries(opts: HealOptions = {}): Promise<HealResult> {
  const env = opts.env ?? process.env;
  // The one opt-out parse every YAW_MCP_* background feature shares
  // (opt-out-env.ts): `0` or `false`, trimmed. This used to be a bare
  // `=== "0"` under a comment claiming it matched its siblings -- so `false`
  // did nothing here, and neither did the "0 " that cmd.exe's
  // `set YAW_MCP_AUTO_HEAL=0 && ...` delivers: a Windows user who opted out
  // the documented way was still healed.
  if (isFeatureDisabled("YAW_MCP_AUTO_HEAL", env)) return { healed: [], unhealable: [], failed: [] };
  let result: HealResult;
  try {
    result = await healStaleBrokerEntries(opts);
  } catch (err) {
    log("warn", "Stale-entry heal pass failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { healed: [], unhealable: [], failed: [] };
  }
  // `log` swallows its own write errors, so reporting cannot reject either.
  for (const f of result.failed) {
    log("warn", "Could not heal a stale yaw-mcp entry", {
      client: `${f.clientId} (${f.scope})`,
      path: f.path,
      error: f.error,
    });
  }
  return result;
}
