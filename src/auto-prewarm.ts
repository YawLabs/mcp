// Fire-and-forget startup pre-warm of `npx -y <pkg>@latest` servers, so the
// first MCP `initialize` from the client does not pay the cold-cache tax.
//
// WHY THIS EXISTS
// ---------------
// A server entry of the shape `{ command: "npx", args: ["-y",
// "@yawlabs/tailscale-mcp@latest"] }` resolves @latest on every spawn. On a
// fresh machine -- or a fresh `_npx` cache, which npm keeps per-tarball-url
// hash and so flushes when the package publishes a new version -- the first
// spawn does a registry round-trip + a tar download + the child's own
// initialize. Together that is reliably >30s, and the downstream MCP client
// (Claude Code, typed, Cursor) gives up at 30s. yaw-mcp's own handshake budget
// is 15s (MCP_CONNECT_TIMEOUT, upstream.ts:458), so the user gets a "MCP
// request initialize to server mcp timed out after 30000ms" line and a
// broken tool surface for the first activation of the session.
//
// `prewarmDormantServers` (server.ts) does spawn each server at startup, but
// (a) it fires from `oninitialized` so the FIRST activation still pays the
// cold-cache cost -- the user only sees the win on the second server and
// onwards, and on the second session onwards; and (b) it is gated on
// YAW_MCP_PREWARM, which a user with no pre-warm tolerance can turn off and
// would not want re-lit by a different knob.
//
// This module primes `~/.npm/_npx/<hash>/node_modules/<pkg>` by running
// `npx -y <pkg>@latest --version` once per unique configured npx package, in
// parallel, fire-and-forget from `start()`. The next time the real spawn
// happens, npx finds a warm cache and connects in well under the client
// deadline. The prime is the same npx cache the broker's StdioClientTransport
// would have used; this is a *cache warm*, not a separate install tree.
//
// WHAT IT DOES NOT TOUCH
// ---------------------
// - The managed `sidecars install` tree. `sidecars install` is opt-in and
//   trades npx re-resolution for one known copy on disk; this module
//   complements it, does not replace it. They serialize against the SAME
//   `acquireSidecarsLock`, so a manual `sidecars install` running at startup
//   defers this pass and vice versa.
// - uvx / docker / custom commands. uv-bootstrap already pre-fetches the uv
//   binary (server.ts:1662-1678). Docker pulls are outside the npx cache.
//   Custom commands are the operator's responsibility.
// - yaw-mcp itself. `maybeAutoUpgrade` is the sibling for that.
//
// RATIONALE PER DECISION
// ----------------------
// - Fire-and-forget, never awaited on the serve hot path. Mirrors
//   `maybeAutoUpgrade` (auto-upgrade.ts:776) and `maybeRefreshSidecars`
//   (sidecar-refresh.ts:673). A 30s pre-warm that the user's `initialize`
//   waits on is not a pre-warm; it is the same timeout, just renamed.
// - Parallel, not batched. The 30s per-package timeout is the upper bound on
//   the WHOLE pass in the worst case (every package needs the full prime),
//   because all packages run concurrently. Batching would only matter if the
//   per-package prime could starve disk or network, and a Yaw bundle of 20
//   npx packages does neither.
// - `npx -y <pkg>@latest --version`, not `npm pack` and not `npm cache add`.
//   `npm pack` writes a tarball, not the npx cache layout. `npm cache add`
//   populates `~/.npm/_cacache` which npx does not consult for the npx-cache
//   shape (oam-spawn.ts:1760 documents this). `npx ... --version` runs the
//   real npx flow and leaves a copy in the right place. `--version` is the
//   universal fast-exit probe: every npm-published package exposes it.
// - `stripInternalSecretsFromEnv(process.env)`. The vault passphrase and any
//   retired token must not reach an npx child, which runs transitive
//   pre/postinstall scripts with the spawn env. The pattern is in
//   `auto-upgrade.ts:736`, with the full reasoning; copied here with the same
//   rationale because the threat model is identical.
// - `shell: process.platform === "win32"`. Same as auto-upgrade. POSIX npx
//   does not need a shell; Windows npx is a `.cmd` and does.
// - `stdio: "ignore"`. The user does not see this pass; its output is
//   irrelevant. "ignore" also makes a slow child unable to wedge the parent
//   on a full pipe.
// - Per-package timeout via a kill timer, not by waiting for `close`. npx
//   ignores SIGTERM cleanly enough that a 30s silence is the timeout, not a
//   runaway child.

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { log } from "./logger.js";
import { sidecarsRoot } from "./paths.js";
import { acquireSidecarsLock } from "./sidecars-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

/** Default cap on the number of npx packages the prewarm will touch. Realistic
 *  curated bundles (bundles.ts) use 6-10; a 20-package cap absorbs the largest
 *  Yaw catalog bundle with room to spare and bounds the worst-case download
 *  volume on a metered connection. Overridable via YAW_MCP_MAX_AUTO_PREWARM. */
export const DEFAULT_MAX_AUTO_PREWARM = 20;

/** Per-package timeout. 30s is the client's `initialize` budget; a prime that
 *  takes longer than the budget it is trying to buy back is not earning its
 *  keep, and 30s is enough to cover a slow registry on warm cache. The whole
 *  pass is parallel, so the global wall-clock upper bound is also 30s. */
export const DEFAULT_AUTO_PREWARM_TIMEOUT_MS = 30_000;

/** Opt-out env var. `=0` and `=false` (any case, surrounding whitespace
 *  stripped) disable the prewarm. Trimming matters: `cmd.exe`'s
 *  `set VAR=0 && yaw-mcp serve` delivers "0 " with a trailing space, and an
 *  opt-out that did not trim would ignore itself on Windows. Three
 *  hand-copies of this parse now exist -- this one, `isSidecarRefreshDisabled`
 *  (sidecar-refresh.ts:663) and `maybeAutoUpgrade` (auto-upgrade.ts:779-780);
 *  the sidecar-refresh header documents why a future refactor should
 *  promote the parse to a shared helper. */
export const AUTO_PREWARM_DISABLE_ENV = "YAW_MCP_AUTO_PREWARM";

/** Max-packages env var. Positive integer or absent. */
export const AUTO_PREWARM_MAX_ENV = "YAW_MCP_MAX_AUTO_PREWARM";

/** Per-package timeout env var, milliseconds. Positive integer or absent. */
export const AUTO_PREWARM_TIMEOUT_ENV = "YAW_MCP_AUTO_PREWARM_TIMEOUT";

/** Matches an `args` slot of the form `<scope>/<name>@<version>` -- the
 *  shape `npx` parses on its own. Conservative: rejects things that look
 *  like flags (`--foo`), env (`FOO=bar`), or local paths (`./foo`).
 *  Exported for tests; pure. */
const NPX_PACKAGE_PATTERN = /^@?[\w.-]+\/[\w.-]+@[\w.*+-]+$|^[\w.-]+@[\w.*+-]+$/;

/** Why a `SpawnedPrime.done` settled. Exported so tests can assert a
 *  specific outcome without re-deriving the union. */
export type SpawnReason = "exit" | "spawn-error" | "timeout" | "aborted";

export interface SpawnedPrime {
  /** The package spec passed to npx, e.g. `@yawlabs/tailscale-mcp@latest`. */
  package: string;
  /** The child process, retained so the test can assert and the kill-timer
   *  has something to fire against. */
  child: ChildProcess;
  /** Resolves when the child closes OR the kill timer fires. */
  done: Promise<{ ok: boolean; reason: SpawnReason }>;
}

/** Pure: extract the unique `npx -y <pkg>@<ver>` packages from a server list.
 *  Returns the deduped set in the order they first appear, so the log line
 *  is stable across runs with the same config. Exported for tests. */
export function extractNpxPackages(servers: UpstreamServerConfig[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const server of servers) {
    if (server.type !== "local") continue;
    if (server.command !== "npx") continue;
    const args = server.args ?? [];
    if (args[0] !== "-y") continue;
    // `npx -y` accepts the package anywhere in args after `-y`. The
    // common shape is `["-y", "<pkg>@<ver>"]`, but `["-y", "-p",
    // "<pkg>@<ver>"]` is also legal -- and a long-tail of
    // user-curated args means we should not refuse the second shape.
    for (const arg of args.slice(1)) {
      if (typeof arg !== "string") continue;
      if (!NPX_PACKAGE_PATTERN.test(arg)) continue;
      if (seen.has(arg)) continue;
      seen.add(arg);
      out.push(arg);
      break; // one package per server
    }
  }
  return out;
}

/** Parse the opt-out env. `=0` and `=false` (case-insensitive, with
 *  surrounding whitespace stripped) disable. Other values (including absent,
 *  the empty string, and any other truthy-looking string) leave the feature
 *  on. Pure, exported for tests and for doctor.
 *
 *  The trim is load-bearing: `cmd.exe`'s `set VAR=0 && yaw-mcp serve` delivers
 *  "0 " with a trailing space, and an opt-out that did not trim would ignore
 *  itself on Windows -- silently, because the variable reads as set everywhere
 *  the user can see it. Same pattern as `isPrewarmEnabled`
 *  (server-prewarm-optout.test.ts:100-128). Near-misses like "00" or "0abc"
 *  stay ON, by the same logic: an opt-out that engaged on anything vaguely
 *  zero-ish would turn a typo into an invisible loss of the feature. */
export function isAutoPrewarmDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTO_PREWARM_DISABLE_ENV];
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  return trimmed === "0" || trimmed.toLowerCase() === "false";
}

/** Parse the max-packages env. Positive integer, else the default. Pure. */
export function parseAutoPrewarmMax(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_MAX_AUTO_PREWARM): number {
  const raw = env[AUTO_PREWARM_MAX_ENV];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse the per-package timeout env, milliseconds. Positive integer, else
 *  the default. Pure. */
export function parseAutoPrewarmTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_AUTO_PREWARM_TIMEOUT_MS,
): number {
  const raw = env[AUTO_PREWARM_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface AutoPrewarmDeps {
  /** Test hook: which servers to consider. Defaults to the real
   *  getProfiledActiveServers -- the function is injected so a test does not
   *  have to stand up a ConnectServer. */
  listActiveServers?: () => UpstreamServerConfig[];
  /** Test hook: replace the npx child spawn. Receives (package, onDone);
   *  onDone MUST be called once the child has settled. Default wires it to
   *  the child's close + error handlers and applies the per-package timeout. */
  spawnImpl?: (pkg: string) => SpawnedPrime;
  /** Test hook: replace the lock that serializes against a manual
   *  `sidecars install` running at the same time. The default is
   *  `acquireSidecarsLock(sidecarsRoot(home))` -- the same lock the
   *  sidecar-refresh module takes. Null release is a busy holder; the caller
   *  skips the prewarm. */
  acquireLockImpl?: () => (() => void) | null;
  /** Test hook: override the opt-out read. */
  isDisabled?: () => boolean;
  /** Test hook: override the max-packages read. */
  maxPackages?: () => number;
  /** Test hook: override the per-package timeout read. */
  perPackageTimeoutMs?: () => number;
}

/** Mirrors `defaultAcquireLock` in sidecar-refresh.ts: under VITEST the lock
 *  is a no-op so a test that does not inject `acquireLockImpl` runs through
 *  the spawn path instead of falling into the busy-holder skip branch. The
 *  sidecar-refresh header documents why this lives here rather than in
 *  `acquireSidecarsLock` itself. */
function defaultAcquireLockImpl(): (() => void) | null {
  if (process.env.VITEST) return () => {};
  return acquireSidecarsLock(sidecarsRoot());
}

function defaultSpawn(pkg: string, timeoutMs: number): SpawnedPrime {
  // Track which handler fired first so the close handler stays silent after
  // an error -- both fire on ENOENT, and the error handler has the message
  // and fires first.
  let errorFired = false;
  let done!: (v: { ok: boolean; reason: SpawnReason }) => void;
  const donePromise = new Promise<{ ok: boolean; reason: SpawnReason }>((resolve) => {
    done = resolve;
  });

  const opts: SpawnOptions = {
    stdio: "ignore",
    // Mirror auto-upgrade.ts:736. npm runs every transitive pre/postinstall
    // with this env; YAW_MCP_VAULT_PASSPHRASE in particular is in process.env
    // only by operator choice and must not be forwarded to a download.
    env: stripInternalSecretsFromEnv(process.env),
    detached: false,
    shell: process.platform === "win32",
  };
  const child: ChildProcess = spawn("npx", ["-y", pkg, "--version"], opts);

  const finish = (reason: SpawnReason, ok: boolean): void => {
    done({ reason, ok });
  };
  child.on("close", (code) => {
    if (errorFired) return;
    finish("exit", code === 0);
  });
  child.on("error", (err: Error) => {
    errorFired = true;
    log("warn", "auto-prewarm: npx spawn failed", { package: pkg, error: err?.message });
    finish("spawn-error", false);
  });

  // Per-package kill timer. npx ignores SIGTERM cleanly; on Windows, npx is
  // a .cmd shim, and child.kill() routes the same way. A 30s silence from
  // a registry is the timeout, not a runaway -- the kill is a safety net,
  // not the expected path.
  const timer = setTimeout(() => {
    log("warn", "auto-prewarm: npx prime exceeded timeout; aborting", { package: pkg, timeoutMs });
    try {
      child.kill("SIGTERM");
    } catch {
      // Already dead; nothing to kill. The close or error handler will
      // resolve `done` with its own reason; we still own `donePromise`
      // and must not double-resolve.
    }
    // Resolve with timeout even if no close/error arrives (e.g. the child
    // detached on POSIX and the kill bounced). Otherwise a stuck child
    // would hold the Promise.all forever and the function would never
    // reach its summary log.
    finish("timeout", false);
  }, timeoutMs);
  // .unref() so a hung prime never holds the serve process open past
  // shutdown. The user said "fire and forget" and meant it.
  timer.unref();
  donePromise.finally(() => clearTimeout(timer));

  return { package: pkg, child, done: donePromise };
}

/** Fire-and-forget startup pre-warm of npx-cache for every active `npx -y
 *  <pkg>@<ver>` server. Resolves once the whole pass settles; callers must
 *  NOT await it on the serve hot path, and it never rejects -- every failure
 *  inside is absorbed to a no-op. */
export async function maybeAutoPrewarmNpxCache(deps: AutoPrewarmDeps = {}): Promise<void> {
  try {
    if ((deps.isDisabled ?? (() => isAutoPrewarmDisabled()))()) return;

    const listServers = deps.listActiveServers ?? (() => []);
    const max = deps.maxPackages ?? (() => parseAutoPrewarmMax());
    const timeoutMs = deps.perPackageTimeoutMs ?? (() => parseAutoPrewarmTimeoutMs());
    const spawnOne = deps.spawnImpl ?? ((pkg: string) => defaultSpawn(pkg, timeoutMs()));
    const acquire = deps.acquireLockImpl ?? defaultAcquireLockImpl;

    const packages = extractNpxPackages(listServers());
    if (packages.length === 0) return;

    // Cap before the lock. The cap is per-process budget, not contention.
    const capped = packages.length > max() ? packages.slice(0, max()) : packages;
    if (packages.length > capped.length) {
      log(
        "info",
        `auto-prewarm: capping at ${capped.length} of ${packages.length} npx packages (YAW_MCP_MAX_AUTO_PREWARM)`,
        { capped: capped.length, total: packages.length },
      );
    }

    // Serialize against `sidecars install`. A manual install running at
    // the same time holds this lock; skipping is the right answer because
    // a) the manual install will leave a warm npx cache itself if it
    // refreshes the same packages, and b) two writers on `~/.npm/`
    // contend on file locks npm does not handle gracefully.
    const release = acquire();
    if (release === null) {
      log("info", "auto-prewarm: another process holds the sidecars lock; skipping this pass");
      return;
    }

    const start = Date.now();
    const results = await Promise.all(capped.map((pkg) => spawnOne(pkg).done));
    release();

    const okCount = results.filter((r) => r.ok).length;
    const failed = capped.length - okCount;
    const elapsedMs = Date.now() - start;
    const level = failed === 0 ? "info" : "warn";
    log(level, `auto-prewarmed ${okCount} of ${capped.length} npx packages in ${elapsedMs}ms (failed: ${failed})`, {
      ok: okCount,
      failed,
      total: capped.length,
      elapsedMs,
    });
  } catch (err) {
    // Mirrors maybeRefreshSidecars's all-failures-absorbed posture: the
    // prewarm is opportunistic and must never surface an unhandled
    // rejection to the caller.
    log("warn", "auto-prewarm: unexpected failure", { error: (err as Error)?.message });
  }
}
