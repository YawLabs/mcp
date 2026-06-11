// `yaw-mcp install <client> [flags]` — auto-edits the chosen MCP client's
// config file so the user doesn't have to hand-write JSON or hunt for
// per-OS file paths. Also ensures ~/.yaw-mcp/config.json carries the token so
// subsequent `install` invocations on other clients don't re-prompt.
//
// Two files are touched per run:
//   1. The client's config file (e.g., ~/.claude.json for Claude Code
//      user scope) — the "yaw-mcp" launch entry is merged in,
//      preserving any other `mcpServers` / `servers` keys the user
//      already has, plus every sibling along the container key path
//      (Claude Code local scope nests under projects[<absDir>].mcpServers).
//   2. ~/.yaw-mcp/config.json (user-global) — created if missing, the token is
//      written here so the launch entry stays env-free. Single source
//      of truth for token rotation across all clients.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `yaw-mcp` entry                  → prompt (TTY) or refuse
//                                                  with --force/--skip flag.
//   - No token anywhere + non-TTY               → refuse with usage hint.
//   - --dry-run                                  → print the would-be diff
//                                                  and exit 0 without writing.

import { existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { CONFIG_FILENAME, CURRENT_SCHEMA_VERSION, loadYawMcpConfig } from "./config-loader.js";
import { type ClientProbeResult, probeClientsAsync } from "./doctor-cmd.js";
import {
  CLAUDE_CODE_ALLOW_PATTERN,
  CURRENT_OS,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  buildLaunchEntry,
  findLegacyEntry,
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import { CONFIG_DIRNAME } from "./paths.js";

export interface InstallCommandOptions {
  /** Target client. Omitted when --list or --all drives the run. */
  clientId?: InstallClientId;
  scope?: InstallScope;
  os?: InstallOS;
  projectDir?: string;
  /** Token to write to ~/.yaw-mcp/config.json. If absent, uses existing token there. */
  token?: string;
  /** Overwrite an existing yaw-mcp entry without prompting. */
  force?: boolean;
  /** Leave an existing yaw-mcp entry untouched (exit 0). */
  skip?: boolean;
  /** Print the changes that would be made and exit without writing. */
  dryRun?: boolean;
  /** When true, do not write/update ~/.yaw-mcp/config.json — only the client config. */
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
  "                       [--token <mcp_pat_…>] [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                       [--force | --skip] [--dry-run] [--no-yaw-mcp-config]\n" +
  "       yaw-mcp install --list                       (detect clients; no writes)\n" +
  "       yaw-mcp install --all  [--token <mcp_pat_…>] (install into every detected client)";

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

  // Resolve the token. Source precedence (highest first):
  //   --token flag > existing ~/.yaw-mcp/config.json token > null (local mode).
  // Missing token is NOT an error -- yaw-mcp runs in local mode without
  // one, loading servers from ~/.yaw-mcp/bundles.json instead of the
  // backend. The launch entry just omits YAW_MCP_TOKEN; buildLaunchEntry
  // handles this at install-targets.ts:339.
  let token: string | null = opts.token ?? null;
  if (!token) {
    const cfg = await loadYawMcpConfig({ home: opts.home, cwd: process.cwd(), env: {} });
    token = cfg.token;
  }
  if (!token) {
    log(
      "yaw-mcp install: no token resolved -- configuring for local mode (Free).\n" +
        "  Add servers by editing ~/.yaw-mcp/bundles.json, or re-run with --token mcp_pat_... to use a Yaw MCP account.",
    );
  }

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
    if (opts.force) decision = "overwrite";
    else if (opts.skip) decision = "skip";
    else if (opts.promptAnswer) decision = opts.promptAnswer;
    else if (opts.io?.isTTY ?? process.stdout.isTTY) {
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

  // Skip ~/.yaw-mcp/config.json writes in local mode -- there's no token
  // to seed, and the file is only meaningful for cross-client token
  // sharing. Local-mode users edit ~/.yaw-mcp/bundles.json instead.
  const writeYawMcpConfig = !opts.skipYawMcpConfig && token !== null;
  const home = opts.home ?? homedir();
  const yawMcpConfigPath = join(home, CONFIG_DIRNAME, CONFIG_FILENAME);
  const yawMcpConfigComposed = writeYawMcpConfig
    ? await composeYawMcpConfig(yawMcpConfigPath, token as string)
    : { json: "" };
  if ("backupPath" in yawMcpConfigComposed && yawMcpConfigComposed.backupPath) {
    log(
      `yaw-mcp install: existing ${yawMcpConfigPath} was malformed; original bytes backed up to ${yawMcpConfigComposed.backupPath} before overwriting.`,
    );
  }
  const yawMcpConfigJson = yawMcpConfigComposed.json;

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

  if (opts.dryRun) {
    log("\n--- dry run: would write the following ---");
    if (writeYawMcpConfig) log(`# ${yawMcpConfigPath}\n${yawMcpConfigJson}`);
    log(`\n# ${resolved.absolute}\n${clientJson}`);
    if (settingsPatch?.changed) log(`# ${settingsPatch.path}\n${settingsPatch.nextJson}`);
    if (legacyEntry) {
      log(
        `Note: legacy "${legacyEntry}" entry at ${resolved.absolute} would remain — remove it to avoid running yaw-mcp twice.`,
      );
    }
    const wouldWrite: string[] = [];
    if (writeYawMcpConfig) wouldWrite.push(yawMcpConfigPath);
    wouldWrite.push(resolved.absolute);
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  const written: string[] = [];

  // Write ~/.yaw-mcp/config.json FIRST. If the second write (client config)
  // fails, at least the token is captured here for the next install --
  // otherwise the user would have a launch entry pointing at a token
  // we never recorded, and would be re-prompted on every other client.
  if (writeYawMcpConfig) {
    try {
      await atomicWriteFile(yawMcpConfigPath, yawMcpConfigJson);
      // Best-effort POSIX permissions tighten — ignored on Windows.
      if (process.platform !== "win32") {
        try {
          await chmod(yawMcpConfigPath, 0o600);
        } catch {
          // chmod not supported on this filesystem; not fatal.
        }
      }
    } catch (e) {
      err(`yaw-mcp install: failed to write ${yawMcpConfigPath}: ${(e as Error).message}`);
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    log(`Wrote ${yawMcpConfigPath}`);
    written.push(yawMcpConfigPath);
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
 *  corresponding settings file. Malformed existing files are left
 *  untouched (changed: false, with a warning printed by the caller). */
async function prepareClaudeCodeSettingsPatch(opts: {
  scope: InstallScope;
  home: string;
  projectDir: string | undefined;
  os: InstallOS;
  claudeConfigDir: string | undefined;
}): Promise<{ path: string; nextJson: string; changed: boolean } | null> {
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
          // Not an object — leave alone, return no-change.
          return { path, nextJson: "", changed: false };
        }
      }
    } catch {
      // Malformed settings.json — don't try to rewrite; let the user fix it.
      return { path, nextJson: "", changed: false };
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

/** Compose the ~/.yaw-mcp/config.json contents — preserves any existing fields,
 *  upserts the token, ensures `version` is set. When the existing file is
 *  unparseable, the original bytes are saved to `${path}.bak-<ts>` first
 *  so the user can recover their token by hand if anything else of value
 *  was in there. Backup is best-effort; if it fails, we proceed without
 *  it rather than blocking the install. */
async function composeYawMcpConfig(path: string, token: string): Promise<{ json: string; backupPath?: string }> {
  let existing: Record<string, unknown> = {};
  let backupPath: string | undefined;
  if (existsSync(path)) {
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch {
      // Couldn't read -- treat as missing; nothing to back up.
      raw = "";
    }
    if (raw) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed file: copy raw bytes aside before we overwrite, so
        // a user who had a real token (or anything else) in there can
        // recover it. The new config still gets written -- the user
        // explicitly asked to install.
        const candidate = `${path}.bak-${Date.now()}`;
        try {
          await atomicWriteFile(candidate, raw);
          backupPath = candidate;
        } catch {
          // Couldn't write backup; not fatal. Proceed with overwrite.
        }
      }
    }
  }
  const next: Record<string, unknown> = { version: CURRENT_SCHEMA_VERSION, ...existing };
  next.token = token;
  if (typeof next.version !== "number") next.version = CURRENT_SCHEMA_VERSION;
  return { json: `${JSON.stringify(next, null, 2)}\n`, backupPath };
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
      case "--token": {
        const v = next();
        if (!v) return { ok: false, error: "--token requires a value" };
        opts.token = v;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v) return { ok: false, error: "--project-dir requires a value" };
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
        return { ok: false, error: USAGE, help: true };
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
  log("Install into every available user-scope client: `yaw-mcp install --all`");
  return { written: [], wouldWrite: [], messages: [], exitCode: 0 };
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

/** `yaw-mcp install --all` — install into every client/scope combo that
 *  makes sense without ambiguity: user-scope for everyone that supports
 *  it, plus any project/workspace scope when --project-dir is passed.
 *  Aggregates results; exit code 0 only if every attempted install
 *  succeeded. Mirrors the per-client run behavior: prompts/--force/
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
  for (const plan of plans) {
    log(`── ${plan.clientId} (${plan.scope}) ──`);
    const result = await runInstall({
      ...opts,
      listOnly: false,
      all: false,
      clientId: plan.clientId,
      scope: plan.scope,
    });
    aggregateWritten.push(...result.written);
    aggregateWouldWrite.push(...result.wouldWrite);
    aggregateMessages.push(...result.messages);
    if (result.exitCode === 0) succeeded += 1;
    else failed += 1;
    log("");
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
