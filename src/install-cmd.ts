// `yaw-mcp install <client> [flags]` — auto-edits the chosen MCP client's
// config file so the user doesn't have to hand-write JSON or hunt for
// per-OS file paths.
//
// The client's config file (e.g., ~/.claude.json for Claude Code user
// scope) is the only file this touches: the "yaw-mcp" launch entry is
// merged in, preserving any other `mcpServers` / `servers` keys the user
// already has, plus every sibling along the container key path (Claude
// Code local scope nests under projects[<absDir>].mcpServers). Claude Code
// additionally gets a `permissions.allow` patch in its settings.json.
//
// ~/.yaw-mcp/config.json is NO LONGER written. It existed to carry the
// account token across clients, and yaw-mcp is local-only now — servers
// come from ~/.yaw-mcp/bundles.json. `--token` and `--no-yaw-mcp-config`
// are still ACCEPTED so scripted installs keep exiting 0, but they are
// inert and print a deprecation warning to stderr.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `yaw-mcp` entry                  → prompt (TTY) or refuse
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
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";

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
  "       yaw-mcp install --all   (install into every detected client)\n" +
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

  if (opts.listOnly) return runInstallList(opts, log);
  if (opts.all) return runInstallAll(opts, log, err);

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

  const projectDir = scopeSpec.requiresProjectDir ? resolve(opts.projectDir ?? process.cwd()) : undefined;
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
  const newEntry = buildLaunchEntry({ os });
  const containerPath = resolved.containerPath;
  let existing: Record<string, unknown> = {};
  let existingHasEntry = false;
  let legacyEntry: string | null = null;
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
    log(`Overwriting existing "${ENTRY_NAME}" entry.`);
  }

  const merged = mergeClientConfig(existing, containerPath, newEntry);
  const clientJson = `${JSON.stringify(merged, null, 2)}\n`;

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
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
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

  const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
  // If nothing changed, signal no-op to the caller.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return { path, nextJson: "", changed: false };
  return { path, nextJson: `${JSON.stringify(merged, null, 2)}\n`, changed: true };
}

/** Allow-patterns earlier installers wrote into Claude Code's
 *  `permissions.allow` (the dead mcp.hosting brand and the interim yaw-mcp
 *  key). Stripped on upgrade so dead wildcards don't accumulate forever —
 *  no live tool name can match them now that ENTRY_NAME is "mcp". */
const LEGACY_CLAUDE_CODE_ALLOW_PATTERNS = ["mcp__mcp_hosting__*", "mcp__yaw_mcp__*"];

/** Union `patterns` into `existing.permissions.allow`, preserving every
 *  other key. Deduplicates by string equality so repeated installs don't
 *  grow the list. Also drops any pre-rename legacy patterns first so
 *  upgraded installs don't keep a dead wildcard around. Exported for tests. */
export function mergePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prev = out.permissions;
  const perms: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const prevAllow = perms.allow;
  const allow: string[] = Array.isArray(prevAllow)
    ? (prevAllow as unknown[]).filter(
        (x): x is string => typeof x === "string" && !LEGACY_CLAUDE_CODE_ALLOW_PATTERNS.includes(x),
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
async function runInstallList(opts: InstallCommandOptions, log: (s: string) => void): Promise<InstallResult> {
  // Capture every log() emission so the returned InstallResult carries
  // the same diagnostic trail tests / programmatic callers see from the
  // main install path. Without this, --list silently drops everything
  // the caller may want to assert against.
  const messages: string[] = [];
  const capture = (s: string): void => {
    messages.push(s);
    log(s);
  };
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
  capture(`${installed}/${available} client scopes have yaw-mcp configured on ${os}.`);
  capture("");

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
  capture(header);
  for (const r of rows) {
    capture(
      `  ${r.client.padEnd(widths.client)}  ` +
        `${r.scope.padEnd(widths.scope)}  ` +
        `${r.path.padEnd(widths.path)}  ` +
        `${r.status.padEnd(widths.status)}`,
    );
  }
  capture("");
  capture("Install into a specific client: `yaw-mcp install <client> [--scope user|project|local]`");
  capture("Install into every available client (user scope where supported): `yaw-mcp install --all`");
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
): Promise<InstallResult> {
  const os = opts.os ?? CURRENT_OS;
  const targets = INSTALL_TARGETS.filter((t) => t.availableOn.includes(os));
  if (targets.length === 0) {
    err(`yaw-mcp install --all: no installable clients on ${os}.`);
    return { written: [], wouldWrite: [], messages: [], exitCode: 1 };
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
  const aggregateMessages: string[] = [];
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
    aggregateMessages.push(...result.messages);
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
      messages: aggregateMessages,
      exitCode: 0,
    };
  }
  err(`${failed}/${totalPlanned} client install${failed === 1 ? "" : "s"} failed. ${succeeded} succeeded.`);
  return {
    written: aggregateWritten,
    wouldWrite: aggregateWouldWrite,
    messages: aggregateMessages,
    exitCode: 1,
  };
}

export const INSTALL_USAGE = USAGE;
