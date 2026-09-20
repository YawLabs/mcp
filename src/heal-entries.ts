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
 * here. Three gates must ALL pass before a single byte is written:
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
  carriedFieldsOf,
  carryableEnvOf,
  composeEntry,
  launchOf,
  readClientConfigFile,
} from "./client-config.js";
import { isReadOnlyDiagnostics } from "./config-loader.js";
import { oamRunEntryPath } from "./doctor-cmd.js";
import { ENTRY_NAME } from "./install-target-model.js";
import {
  buildLaunchEntry,
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallOS,
  resolveInstallSites,
} from "./install-targets.js";
import { log } from "./logger.js";
import { type OamProbe, probeOam, resolveStableNpmEntry } from "./oam-spawn.js";

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

/** What one sweep concluded. */
export interface HealResult {
  healed: HealedEntry[];
  unhealable: UnhealableConfig[];
}

export interface HealOptions {
  os?: InstallOS;
  home?: string;
  appData?: string;
  cwd?: string;
  claudeConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Plan only: compute and return what WOULD change, write nothing. */
  dryRun?: boolean;
  /** Test seams, same pair install-cmd exposes and for the same reason: the
   *  real probe spawns oam, so whether the rebuilt entry is an oam entry or an
   *  npx one would otherwise depend on whether the machine running the test
   *  happens to have oam installed. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  resolveOamEntry?: (pkg: string) => string | null;
}

/** Normalised for comparison: separators folded and case lowered, because a
 *  Windows path is case-insensitive and reaches us spelled either way. */
function norm(p: string): string {
  return p.split("\\").join("/").toLowerCase();
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
 */
export async function healStaleBrokerEntries(opts: HealOptions = {}): Promise<HealResult> {
  const env = opts.env ?? process.env;
  // Gate 3, checked once and up front.
  if (isReadOnlyDiagnostics(env)) return { healed: [], unhealable: [] };

  const os = opts.os ?? CURRENT_OS;
  const healed: HealedEntry[] = [];
  const unhealable: UnhealableConfig[] = [];

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

  // One physical entry, healed once. Codex CLI's user and project scopes
  // resolve to the SAME file AND the same container when the process cwd is
  // the home directory -- which is exactly what happens under Yaw Terminal,
  // whose main process chdirs to home. Without this the second pass would read
  // the file the first pass just rewrote and report a phantom second repair.
  const seen = new Set<string>();

  for (const target of INSTALL_TARGETS) {
    for (const scope of target.scopes) {
      let site: ReturnType<typeof resolveInstallSites>[number] | undefined;
      try {
        site = resolveInstallSites({
          clientId: target.clientId,
          scope: scope.scope,
          os,
          home: opts.home,
          appData: opts.appData,
          projectDir: scope.requiresProjectDir ? (opts.cwd ?? process.cwd()) : undefined,
          claudeConfigDir: opts.claudeConfigDir,
        })[0];
      } catch {
        // A scope that needs a project dir we cannot supply is simply not a
        // slot on this machine.
        continue;
      }
      if (site === undefined) continue;
      const resolvedSite = site;

      const key = `${norm(resolvedSite.resolved.absolute)}::${addressOf(resolvedSite).containerPath.join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        // Same transform install reads with, so carried fields and the
        // normalised view match what install would compute for this row.
        const view = await readClientConfigFile(resolvedSite, { transform: target.entry });
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
              scope: scope.scope,
              path: resolvedSite.resolved.absolute,
              reason: view.read.kind,
            });
          }
          continue;
        }
        const stored = view.read.entries.find((e) => e.key === ENTRY_NAME);
        if (stored === undefined) continue;

        const launch = stored.launch ?? launchOf(stored.value);
        if (launch === null) continue;

        // Gate 1: an oam launch, pointing into our own package tree.
        const entryPath = oamRunEntryPath(launch.command, launch.args);
        if (entryPath === null || !isOwnBrokerEntry(entryPath)) continue;

        // Gate 2: only a BROKEN entry is ever rewritten.
        //
        // A FILE, not merely something at that path: `existsSync` is true for a
        // directory, and `oam run <a directory>` cannot start the broker any
        // more than a missing path can -- so testing existence alone declared
        // an unstartable entry healthy and left it that way. statSync follows
        // symlinks, which is what we want: a link to a real file is fine, and a
        // dangling one throws and counts as broken.
        if (isLaunchableFile(entryPath)) continue;

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
        if (nextEntry !== null && norm(nextEntry) === norm(entryPath)) continue;

        if (opts.dryRun !== true) {
          const text = applyClientConfigEdits(view, [{ op: "upsert", key: ENTRY_NAME, entry: next }], resolvedSite);
          await atomicWriteFile(resolvedSite.resolved.absolute, text);
        }

        healed.push({
          clientId: target.clientId,
          scope: scope.scope,
          path: resolvedSite.resolved.absolute,
          from: entryPath,
          to: nextEntry ?? "npx",
        });
      } catch (err) {
        // One bad config must not stop the sweep.
        log("warn", "Could not heal a stale yaw-mcp entry", {
          path: resolvedSite.resolved.absolute,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (healed.length > 0) {
    log("info", "Re-pointed stale yaw-mcp entries whose launch file no longer existed", {
      count: healed.length,
      clients: healed.map((h) => `${h.clientId} (${h.scope})`),
    });
  }
  return { healed, unhealable };
}

/**
 * The startup wrapper: the same sweep, opt-out-able and incapable of
 * rejecting. `serve` calls this and does not await it.
 */
export async function maybeHealStaleBrokerEntries(opts: HealOptions = {}): Promise<HealResult> {
  const env = opts.env ?? process.env;
  // Same shape as YAW_MCP_AUTO_PREWARM: an explicit "0" turns it off.
  if (env.YAW_MCP_AUTO_HEAL === "0") return { healed: [], unhealable: [] };
  try {
    return await healStaleBrokerEntries(opts);
  } catch (err) {
    log("warn", "Stale-entry heal pass failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { healed: [], unhealable: [] };
  }
}
