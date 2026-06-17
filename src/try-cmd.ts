// `yaw-mcp try <slug>` — one-shot trial: fetches the canonical launch
// shape for an MCP server from the yaw.sh/mcp catalog (catalog.ts), wires
// it into the user's AI client config under a `yaw-mcp-try-<slug>` entry
// (NOT through yaw-mcp -- the trial entry points DIRECTLY at the upstream
// MCP server's command + args), drops a trial marker file under
// ~/.yaw-mcp/trials/<slug>.json so the doctor's GC pass can sweep it
// after expiry, and prints a 3-line "trial wired" nudge.
//
// Design notes:
//   - The trial entry is upstream-shape so the user can evaluate the
//     server end-to-end without onboarding yaw-mcp first. The whole point
//     of `try` is that a 30-second eval should not require account
//     creation; yaw-mcp's value-add (centralized auth, learning, compliance
//     gating) is offered AFTER the user has decided the server is worth
//     keeping (the 3-line nudge at the end is the signup hint).
//   - The Windows `cmd /c` wrap is delegated to `buildLaunchEntry` —
//     same code path the canonical `yaw-mcp install` flow uses, so a
//     future fix to the wrapping logic propagates to trials for free.
//   - Trial marker fields are versioned (`schemaVersion`) so the GC
//     pass can refuse to delete entries it doesn't understand.
//   - The anonId is a SHA-256 hash of os.hostname() + os.userInfo(),
//     truncated to 16 hex chars. NOT a stable cross-machine identifier,
//     just enough to deduplicate "this same machine tried server X"
//     events for the funnel. Persisted on first run; never sent in
//     anything richer than the {slug, action, anonId} triple.
//   - The /api/try/event POST is fire-and-forget: a network blip must
//     never block the trial from working. Errors are swallowed silently
//     after a single best-effort attempt (no retry — analytics already
//     handles the retry concern for the long-tail telemetry surface).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { request } from "undici";
import { atomicWriteFile } from "./atomic-write.js";
import { resolveCatalogSlug } from "./catalog.js";
import { probeClientsAsync } from "./doctor-cmd.js";
import { mergeClientConfig, readNested, removeFromClientConfig } from "./install-cmd.js";
import {
  buildLaunchEntry,
  CURRENT_OS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const TRY_USAGE = `Usage: yaw-mcp try <slug> [flags]

  Wire a one-off trial of an MCP server into your AI client. No account
  needed; the trial points directly at the upstream server and expires
  after --ttl. Run \`yaw-mcp try-cleanup <slug>\` to remove it sooner.

  --client <name>      claude-code | claude-desktop | cursor | vscode
                       (default: auto-detect, prefers the first installed
                       client in the order probed by \`yaw-mcp install --list\`)
  --ttl <duration>     How long the trial lives before doctor GCs it
                       (default: 1h; accepts e.g. 30m, 2h, 7d)
  --env KEY=value      Set an env var on the trial entry. Repeatable.
                       Required env vars not supplied here AND not in your
                       shell's env block the trial with an explainer.
  --dry-run            Print what would happen without writing anything.
  --base <url>         Base URL for the signup/telemetry links (default:
                       $YAW_MCP_BASE_URL or https://yaw.sh/mcp). The catalog
                       itself is set via $YAW_MCP_CATALOG_URL.`;

export const TRY_CLEANUP_USAGE = `Usage: yaw-mcp try-cleanup <slug>

  Remove a previously-wired trial: peels the yaw-mcp-try-<slug> entry out of
  the AI client config and deletes the marker under ~/.yaw-mcp/trials/. Safe
  to run after the trial expires (no-op if nothing is wired).`;

export const TRIAL_SCHEMA_VERSION = 1;
export const TRIALS_DIRNAME = "trials";
export const ANON_FILENAME = ".anon";

export interface ExploreServerResponse {
  slug: string;
  name: string;
  command: string;
  args: string[];
  /** Names of env vars the server needs to function. yaw-mcp try refuses
   *  to wire the trial if any of these are missing from both --env and
   *  process.env, so the user sees the requirement up front instead of
   *  a silent runtime failure in the client. */
  requiredEnvVars?: string[];
  docUrl?: string;
}

export interface TrialMarker {
  schemaVersion: number;
  slug: string;
  name: string;
  /** Epoch ms when doctor's GC pass should evict the entry. */
  expiresAt: number;
  /** Absolute path of the client config file the entry was written to. */
  clientPath: string;
  /** Human-friendly client id (claude-code, cursor, ...). Used by doctor
   *  to surface "trial expires in Nm for <client>" without re-probing. */
  clientName: InstallClientId;
  /** Container path (mcpServers/servers/projects[..]) under which the
   *  trial entry was written. Doctor needs this to GC the entry from
   *  the right scope (especially Claude Code local-scope under projects). */
  containerPath: string[];
  /** Entry name in the container — almost always `yaw-mcp-try-<slug>` but
   *  persisted so a future rename doesn't orphan old markers. */
  entryName: string;
  /** Epoch ms when the trial was created. Diagnostic. */
  createdAt: number;
}

export interface TryCommandOptions {
  slug?: string;
  clientId?: InstallClientId;
  /** Trial TTL as a duration string (e.g. "30m", "1h", "7d"). */
  ttl?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  baseUrl?: string;
  /** Override for tests. */
  home?: string;
  cwd?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the real network fetch. */
  fetchExplore?: (baseUrl: string, slug: string) => Promise<ExploreServerResponse>;
  /** Override for tests; defaults to the real fire-and-forget POST. */
  postEvent?: (baseUrl: string, body: TryEventBody) => Promise<void>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

export interface TryCleanupOptions {
  slug?: string;
  baseUrl?: string;
  home?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  postEvent?: (baseUrl: string, body: TryEventBody) => Promise<void>;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface TryEventBody {
  slug: string;
  action: "try" | "cleanup" | "expiry-gc";
  anonId: string;
}

export interface TryCommandResult {
  exitCode: number;
  /** Files written (empty in --dry-run or on error). */
  written: string[];
  /** Marker that was persisted (or would have been, in --dry-run). */
  marker?: TrialMarker;
}

const DEFAULT_BASE_URL = "https://yaw.sh/mcp";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

/** Parse argv slice for `yaw-mcp try`. Exported for tests. */
export function parseTryArgs(
  argv: string[],
): { ok: true; options: TryCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_USAGE };
  const positional: string[] = [];
  const opts: TryCommandOptions = {};
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--client": {
        const v = next();
        if (!v || !["claude-code", "claude-desktop", "cursor", "vscode"].includes(v)) {
          return { ok: false, error: "--client requires claude-code|claude-desktop|cursor|vscode" };
        }
        opts.clientId = v as InstallClientId;
        break;
      }
      case "--ttl": {
        const v = next();
        if (!v) return { ok: false, error: "--ttl requires a value (e.g. 1h, 30m, 7d)" };
        if (parseDurationMs(v) === null) {
          return { ok: false, error: `--ttl: cannot parse "${v}" (try 30m, 1h, 2d)` };
        }
        opts.ttl = v;
        break;
      }
      case "--env": {
        const v = next();
        if (!v?.includes("=")) return { ok: false, error: "--env requires KEY=value" };
        const eq = v.indexOf("=");
        const key = v.slice(0, eq);
        const val = v.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { ok: false, error: `--env: invalid KEY "${key}"` };
        }
        env[key] = val;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--base": {
        const v = next();
        // Reject a following flag (e.g. `try slug --base --dry-run`, which
        // would otherwise set baseUrl="--dry-run" and silently drop the
        // dry-run flag). A URL never starts with "--".
        if (!v || v.startsWith("--")) return { ok: false, error: "--base requires a URL" };
        opts.baseUrl = v;
        break;
      }
      case "-h":
      case "--help":
        return { ok: false, error: TRY_USAGE, help: true };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_USAGE}` };
        // A bare "-" is not a valid slug; reject it here with a clear
        // arg-parse error rather than letting it slip to the slug regex,
        // which would only reject it later with a generic "invalid slug".
        if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_USAGE}` };
        positional.push(a);
    }
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one server slug, got ${positional.length}.\n${TRY_USAGE}` };
  }
  opts.slug = positional[0];
  if (Object.keys(env).length > 0) opts.envOverrides = env;
  return { ok: true, options: opts };
}

export function parseTryCleanupArgs(
  argv: string[],
): { ok: true; options: TryCleanupOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_CLEANUP_USAGE };
  const opts: TryCleanupOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { ok: false, error: TRY_CLEANUP_USAGE, help: true };
    if (a === "--base") {
      const v = argv[++i];
      if (!v) return { ok: false, error: "--base requires a URL" };
      opts.baseUrl = v;
      continue;
    }
    if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_CLEANUP_USAGE}` };
    // Reject a bare "-" with a clear arg-parse error rather than deferring
    // to the slug regex's generic "invalid slug" message.
    if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_CLEANUP_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug.\n${TRY_CLEANUP_USAGE}` };
  }
  opts.slug = positional[0];
  return { ok: true, options: opts };
}

/** Parse a duration suffix string (10s, 30m, 1h, 7d) into milliseconds.
 *  Returns null on parse failure so callers can surface a clear error. */
export function parseDurationMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * factor;
}

/** Trials root: `~/.yaw-mcp/trials/`. */
export function trialsDir(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, TRIALS_DIRNAME);
}

export function trialMarkerPath(slug: string, home: string = homedir()): string {
  return join(trialsDir(home), `${slug}.json`);
}

export function anonIdPath(home: string = homedir()): string {
  return join(trialsDir(home), ANON_FILENAME);
}

/** Compute a stable per-machine anonymous id (first 16 hex of sha256 over
 *  hostname + username). NOT a cross-machine identity; meant to dedup
 *  "this machine tried slug X twice" in the funnel without sending
 *  anything resembling a fingerprint. */
export function computeAnonId(): string {
  const h = createHash("sha256");
  h.update(hostname());
  try {
    h.update(userInfo().username);
  } catch {
    // userInfo() can throw if /etc/passwd is unavailable (containers,
    // chroots). Fall back to whatever hostname gives us.
  }
  return h.digest("hex").slice(0, 16);
}

/** Read the persisted anonId, creating + persisting it on first run.
 *  Returns the 16-hex string. Best-effort writes — if the disk is RO
 *  we still return a computed id so the trial works. */
export async function loadOrCreateAnonId(home: string = homedir()): Promise<string> {
  const path = anonIdPath(home);
  if (existsSync(path)) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (/^[0-9a-f]{16}$/.test(raw)) return raw;
    } catch {
      // unreadable -- fall through to regenerate
    }
  }
  const id = computeAnonId();
  try {
    await mkdir(trialsDir(home), { recursive: true });
    await atomicWriteFile(path, `${id}\n`);
    if (process.platform !== "win32") {
      try {
        await chmod(path, 0o600);
      } catch {
        // chmod best-effort
      }
    }
  } catch {
    // Disk RO / permission denied — non-fatal, just return the id.
  }
  return id;
}

// Resolve the launch shape from the SAME static catalog the website and the
// Yaw Terminal app read (catalog.ts), so `try <slug>` accepts the exact slug
// set the catalog shows. (The old /api/explore/:slug endpoint was never
// deployed -- this is the path that actually works.) `baseUrl` is retained
// only for the signup/telemetry links; the catalog URL is overridden via
// YAW_MCP_CATALOG_URL.
async function defaultFetchExplore(_baseUrl: string, slug: string): Promise<ExploreServerResponse> {
  const resolved = await resolveCatalogSlug(slug, { catalogUrl: process.env.YAW_MCP_CATALOG_URL });
  const out: ExploreServerResponse = {
    slug: resolved.slug,
    name: resolved.name,
    command: resolved.command,
    args: resolved.args,
    requiredEnvVars: resolved.requiredEnvKeys,
  };
  if (resolved.docUrl) out.docUrl = resolved.docUrl;
  return out;
}

async function defaultPostEvent(baseUrl: string, body: TryEventBody): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/try/event`;
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    // Drain to avoid keeping the socket open.
    await res.body.text().catch(() => {});
  } catch (err) {
    // Fire-and-forget: a network blip must not block the trial.
    log("debug", "try-event post failed", { error: (err as Error).message });
  }
}

/** Auto-detect which AI client to install the trial into. Probes in the
 *  same order as `yaw-mcp install --list` (claude-code -> claude-desktop ->
 *  cursor -> vscode, per INSTALL_TARGETS), picking the first one whose
 *  config file already exists OR whose user-scope directory is writable.
 *  Falls back to claude-code (the most likely target) when nothing
 *  obvious is installed. */
async function autoDetectClient(opts: {
  home: string;
  os: InstallOS;
  cwd: string;
  claudeConfigDir: string | undefined;
}): Promise<InstallClientId> {
  const probes = await probeClientsAsync({
    home: opts.home,
    os: opts.os,
    cwd: opts.cwd,
    claudeConfigDir: opts.claudeConfigDir,
  });
  // First: any client whose config file already exists (the user is
  // actively using it).
  for (const p of probes) {
    if (!p.unavailable && p.exists && !p.malformed) return p.clientId;
  }
  // Second: any client that's available on this OS (config file not
  // yet created -- we'll create it).
  for (const p of probes) {
    if (!p.unavailable) return p.clientId;
  }
  return "claude-code";
}

export async function runTry(opts: TryCommandOptions): Promise<TryCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  // Slug validation: lowercase + digits + dashes only, matches what the
  // hosting backend exposes as catalog ids. Keeps the entry-name and
  // marker-filename free of shell-special chars.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    printErr(`yaw-mcp try: invalid slug "${slug}" (lowercase letters, digits, and dashes only).`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const os = opts.os ?? CURRENT_OS;
  const now = opts.now ? opts.now() : Date.now();
  const baseUrl = opts.baseUrl ?? env.YAW_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  const ttlMs = opts.ttl ? (parseDurationMs(opts.ttl) ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;

  // Step 1: fetch the canonical launch shape.
  const fetchExplore = opts.fetchExplore ?? defaultFetchExplore;
  let server: ExploreServerResponse;
  try {
    server = await fetchExplore(baseUrl, slug);
  } catch (e) {
    printErr((e as Error).message);
    return { exitCode: 1, written: [] };
  }

  // Step 2: pick a client (explicit > auto-detect).
  const clientId = opts.clientId ?? (await autoDetectClient({ home, os, cwd, claudeConfigDir }));

  // Step 3: resolve the config file path (user scope; project scope
  // requires extra flags we don't expose in `try` -- trials are
  // user-scoped by design).
  // VS Code has no user scope -- only workspace. Fall back to project
  // scope when targeting vscode; the user must be inside the workspace.
  const scope: InstallScope = clientId === "vscode" ? "project" : "user";
  const projectDir = scope === "project" ? resolve(cwd) : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({ clientId, scope, os, home, projectDir, claudeConfigDir });
  } catch (e) {
    printErr(`yaw-mcp try: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // Step 4: required-env-var check. Anything in requiredEnvVars not
  // supplied via --env AND not in the current process env blocks the
  // trial — silent runtime failure inside the client is worse than a
  // clear "you need to set FOO" up front.
  const supplied = { ...env, ...(opts.envOverrides ?? {}) } as Record<string, string | undefined>;
  // Trim before the emptiness test so a whitespace-only value (FOO=" ")
  // counts as missing instead of slipping through and writing a blank-ish
  // secret into the trial entry.
  const missing = (server.requiredEnvVars ?? []).filter((k) => (supplied[k] ?? "").trim() === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp try: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    printErr("");
    printErr("Set them via --env KEY=value (repeatable) or your shell, then re-run:");
    const example = missing.map((k) => `--env ${k}=...`).join(" ");
    printErr(`  yaw-mcp try ${slug} ${example}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return { exitCode: 1, written: [] };
  }

  // Step 5: build the trial entry — upstream-shape, NOT through yaw-mcp.
  // Reuse buildLaunchEntry so the Windows `cmd /c` wrap stays in one
  // place. Only carry the env vars the upstream actually wants (from
  // requiredEnvVars + any --env overrides the user supplied); we don't
  // want to leak every var in the user's shell into the entry.
  //
  // INTENTIONAL DIVERGENCE from `yaw-mcp add` (local-add-cmd.ts:174-190):
  // `add` seeds required keys EMPTY and persists a value ONLY for explicit
  // --env, deliberately NOT copying ambient-shell secrets to disk (yaw-mcp
  // inherits the shell env at spawn time). `try` cannot do that -- the trial
  // entry is upstream-shape and launched DIRECTLY by the client, not through
  // yaw-mcp, so there is no env-inheriting launcher in the path; the resolved
  // value (including an ambient-shell secret) MUST be written inline or the
  // server has no way to see it. The ambientOnlyRequired note below warns the
  // user when a value was sourced from the shell rather than --env.
  const trialEnv: Record<string, string> = {};
  for (const k of server.requiredEnvVars ?? []) {
    // Use the trimmed value so a padded entry doesn't carry surrounding
    // whitespace into the secret (the missing-check above already trims).
    const v = (supplied[k] ?? "").trim();
    if (v) trialEnv[k] = v;
  }
  // Honor any --env overrides for keys NOT in requiredEnvVars too --
  // some servers have optional env knobs (LOG_LEVEL, DATABASE_URL).
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    if (!(k in trialEnv)) trialEnv[k] = v;
  }
  // Required keys whose value came from the ambient shell, NOT --env. Unlike
  // `add`, `try` DOES persist these inline (see divergence note above); the
  // note at step 9 tells the user the secret was sourced from their shell so
  // they're aware it now lives in the client config on disk.
  const overrides = opts.envOverrides ?? {};
  const ambientOnlyRequired = (server.requiredEnvVars ?? []).filter(
    (k) => (!overrides[k] || overrides[k] === "") && (supplied[k] ?? "").trim() !== "",
  );
  const entry = buildLaunchEntry({
    os,
    upstream: {
      command: server.command,
      args: server.args,
      env: Object.keys(trialEnv).length > 0 ? trialEnv : undefined,
    },
  });

  const entryName = `yaw-mcp-try-${slug}`;
  const expiresAt = now + ttlMs;
  const marker: TrialMarker = {
    schemaVersion: TRIAL_SCHEMA_VERSION,
    slug,
    name: server.name,
    expiresAt,
    clientPath: resolved.absolute,
    clientName: clientId,
    containerPath: resolved.containerPath,
    entryName,
    createdAt: now,
  };

  // Step 6: read existing client config (if any).
  // Track whether the client file pre-existed: if it did, it is the user's
  // own file and we must NOT tighten its perms (step 7's chmod is scoped to
  // the freshly-created case). If it did not, `try` is creating it and a
  // best-effort 0600 is appropriate when the entry carries secrets inline.
  const clientPreExisted = existsSync(resolved.absolute);
  let existing: Record<string, unknown> = {};
  if (clientPreExisted) {
    try {
      const raw = await readFile(resolved.absolute, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        } else {
          printErr(`yaw-mcp try: ${resolved.absolute} is not a JSON object — refusing to overwrite.`);
          return { exitCode: 1, written: [] };
        }
      }
    } catch (e) {
      printErr(`yaw-mcp try: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to overwrite.`);
      return { exitCode: 1, written: [] };
    }
  }

  // If a previous trial of the same slug is wired, overwrite it (the
  // user is re-running `try`, presumably with a different --ttl or env).
  // We never collide with the canonical "yaw-mcp" entry — trials
  // live under their own `yaw-mcp-try-<slug>` name.
  const merged = mergeClientConfig(existing, resolved.containerPath, entry, entryName);
  const clientJson = `${JSON.stringify(merged, null, 2)}\n`;
  const markerJson = `${JSON.stringify(marker, null, 2)}\n`;

  if (opts.dryRun) {
    print(`yaw-mcp try (dry-run): would write ${resolved.absolute}`);
    print(`  entry name: ${entryName}`);
    print(`  command:    ${entry.command} ${entry.args.join(" ")}`);
    if (entry.env) print(`  env keys:   ${Object.keys(entry.env).join(", ")}`);
    print(`  expires:    ${new Date(expiresAt).toISOString()}`);
    print(`  marker:     ${trialMarkerPath(slug, home)}`);
    return { exitCode: 0, written: [], marker };
  }

  // Step 7: write everything atomically. Order: marker first, then client
  // config. Rationale: if the process CRASHES between the two writes (where
  // the catch-block rollback below cannot run), a sweepable marker is left
  // behind so doctor's GC can reclaim it. On a CAUGHT client-write failure we
  // do NOT rely on that -- the catch explicitly unlinks the marker (see
  // below) so doctor never sees a trial whose launch entry was never written.
  // Anon id seeded as a side-effect.
  const written: string[] = [];
  try {
    await mkdir(trialsDir(home), { recursive: true });
    await atomicWriteFile(trialMarkerPath(slug, home), markerJson);
    written.push(trialMarkerPath(slug, home));
  } catch (e) {
    printErr(`yaw-mcp try: failed to write trial marker: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  try {
    await atomicWriteFile(resolved.absolute, clientJson);
    written.push(resolved.absolute);
    // Best-effort 0600 ONLY when `try` freshly created the client file AND
    // the entry carries inline env (secrets). We deliberately scope this to
    // the freshly-created case: a pre-existing file is the user's own, and
    // tightening its perms could surprise them (and atomicWriteFile's rename
    // replaces the inode, so an unconditional chmod would silently re-perm
    // their file on every trial). No-op on Windows (POSIX perms don't apply).
    if (!clientPreExisted && entry.env && Object.keys(entry.env).length > 0 && process.platform !== "win32") {
      try {
        await chmod(resolved.absolute, 0o600);
      } catch {
        // chmod best-effort -- the trial still works at default perms.
      }
    }
  } catch (e) {
    printErr(`yaw-mcp try: failed to write ${resolved.absolute}: ${(e as Error).message}`);
    // Best-effort marker rollback so doctor doesn't think a trial is
    // active when its launch entry was never written.
    await unlink(trialMarkerPath(slug, home)).catch(() => undefined);
    return { exitCode: 1, written: [] };
  }

  // Step 8: seed anonId + fire the telemetry event.
  const anonId = await loadOrCreateAnonId(home);
  const postEvent = opts.postEvent ?? defaultPostEvent;
  await postEvent(baseUrl, { slug, action: "try", anonId }).catch(() => undefined);

  // Step 9: nudge.
  const ttlPretty = formatTtl(ttlMs);
  print(`Trial wired: ${server.name} via yaw-mcp-try-${slug} -> ${resolved.absolute}`);
  print(`Expires in ${ttlPretty}; remove sooner with: yaw-mcp try-cleanup ${slug}`);
  print(`Liking it? Sign up at ${baseUrl}/signup to keep ${server.name} on every machine.`);

  // If a required key was satisfied by the ambient shell (not --env), its
  // value was copied INTO the trial entry on disk (unlike `add`, which seeds
  // it empty). Warn on stderr so the user knows a shell-resident secret was
  // persisted to the client config.
  if (ambientOnlyRequired.length > 0) {
    printErr(
      `Note: ${ambientOnlyRequired.join(", ")} ${
        ambientOnlyRequired.length === 1 ? "was" : "were"
      } read from your shell env and written into the trial entry at ${resolved.absolute}. Remove the trial with: yaw-mcp try-cleanup ${slug}`,
    );
  }
  return { exitCode: 0, written, marker };
}

export async function runTryCleanup(opts: TryCleanupOptions): Promise<TryCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_CLEANUP_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    printErr(`yaw-mcp try-cleanup: invalid slug "${slug}".`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const baseUrl = opts.baseUrl ?? env.YAW_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  const markerPath = trialMarkerPath(slug, home);

  if (!existsSync(markerPath)) {
    print(`yaw-mcp try-cleanup: no trial marker for "${slug}" (nothing to do).`);
    return { exitCode: 0, written: [] };
  }

  let marker: TrialMarker;
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as TrialMarker;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entryName !== "string") {
      throw new Error("marker is missing required fields");
    }
    marker = parsed;
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: marker at ${markerPath} is unreadable (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  // Peel the entry out of the client config (no-op if already gone).
  const written: string[] = [];
  if (existsSync(marker.clientPath)) {
    try {
      const raw = await readFile(marker.clientPath, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const stripped = removeFromClientConfig(
            parsed as Record<string, unknown>,
            marker.containerPath,
            marker.entryName,
          );
          if (stripped !== parsed) {
            await atomicWriteFile(marker.clientPath, `${JSON.stringify(stripped, null, 2)}\n`);
            written.push(marker.clientPath);
            print(`Removed ${marker.entryName} from ${marker.clientPath}`);
          }
        }
      }
    } catch (e) {
      printErr(
        `yaw-mcp try-cleanup: warning -- couldn't strip ${marker.entryName} from ${marker.clientPath} (${(e as Error).message}).`,
      );
      // Continue -- still drop the marker so doctor stops surfacing it.
    }
  }

  // Drop the marker.
  try {
    await unlink(markerPath);
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: couldn't delete marker ${markerPath} (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  // Fire-and-forget telemetry.
  const anonId = await loadOrCreateAnonId(home);
  const postEvent = opts.postEvent ?? defaultPostEvent;
  await postEvent(baseUrl, { slug, action: "cleanup", anonId }).catch(() => undefined);

  print(`Trial for "${slug}" cleaned up.`);
  return { exitCode: 0, written };
}

/** Pretty-print a TTL in ms as `Nh`, `Nm`, or `Nd` for the nudge. */
export function formatTtl(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.round(clamped / 3_600_000)}h`;
  return `${Math.round(clamped / 86_400_000)}d`;
}

/** Doctor-side: list every trial marker on disk, classify expired vs live,
 *  and (when GC=true) peel expired entries out of their client configs +
 *  delete the markers + fire the expiry-gc event. Returns a structured
 *  summary so doctor can render it inline. */
export interface TrialScanEntry {
  marker: TrialMarker;
  /** ms until expiry; negative when already expired. */
  msUntilExpiry: number;
  expired: boolean;
}

export interface TrialScanResult {
  live: TrialScanEntry[];
  expired: TrialScanEntry[];
  /** Markers that exist on disk but failed to parse — surface so doctor
   *  can tell the user to delete them by hand. */
  malformed: string[];
}

export async function scanTrials(opts: { home?: string; now?: () => number } = {}): Promise<TrialScanResult> {
  const home = opts.home ?? homedir();
  const now = opts.now ? opts.now() : Date.now();
  const dir = trialsDir(home);
  const result: TrialScanResult = { live: [], expired: [], malformed: [] };
  if (!existsSync(dir)) return result;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const path = join(dir, filename);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as TrialMarker;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.slug !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        typeof parsed.clientPath !== "string" ||
        !Array.isArray(parsed.containerPath) ||
        typeof parsed.entryName !== "string"
      ) {
        result.malformed.push(path);
        continue;
      }
      const msUntilExpiry = parsed.expiresAt - now;
      const expired = msUntilExpiry <= 0;
      const entry: TrialScanEntry = { marker: parsed, msUntilExpiry, expired };
      if (expired) result.expired.push(entry);
      else result.live.push(entry);
    } catch {
      result.malformed.push(path);
    }
  }
  return result;
}

/** Sweep expired trials: peel each one out of its client config + delete
 *  the marker + fire an expiry-gc telemetry event. Best-effort — failures
 *  on individual entries don't abort the sweep. Returns the count cleared
 *  so doctor can report it. */
export async function gcExpiredTrials(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  postEvent?: (baseUrl: string, body: TryEventBody) => Promise<void>;
  now?: () => number;
}): Promise<{ cleared: number; failed: number }> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const baseUrl = opts.baseUrl ?? env.YAW_MCP_BASE_URL ?? DEFAULT_BASE_URL;
  const postEvent = opts.postEvent ?? defaultPostEvent;
  const scan = await scanTrials({ home, now: opts.now });
  if (scan.expired.length === 0) return { cleared: 0, failed: 0 };

  const anonId = await loadOrCreateAnonId(home);
  let cleared = 0;
  let failed = 0;
  for (const { marker } of scan.expired) {
    try {
      if (existsSync(marker.clientPath)) {
        const raw = await readFile(marker.clientPath, "utf8");
        if (raw.trim().length > 0) {
          const parsed = parseJsonc(raw);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const stripped = removeFromClientConfig(
              parsed as Record<string, unknown>,
              marker.containerPath,
              marker.entryName,
            );
            if (stripped !== parsed) {
              await atomicWriteFile(marker.clientPath, `${JSON.stringify(stripped, null, 2)}\n`);
            }
          }
        }
      }
      await unlink(trialMarkerPath(marker.slug, home));
      await postEvent(baseUrl, { slug: marker.slug, action: "expiry-gc", anonId }).catch(() => undefined);
      cleared++;
    } catch (e) {
      log("debug", "trial gc failed", { slug: marker.slug, error: (e as Error).message });
      failed++;
    }
  }
  return { cleared, failed };
}

// Re-export `readNested` so tests can use it for inspection.
export { readNested };
