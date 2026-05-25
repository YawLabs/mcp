// Nag interstitial for Free-mode users. Fires every 2-4 human-initiated
// `yaw-mcp` subcommand invocations, capped at one per 1.5 days. The CLI
// analogue of Yaw Terminal's click-to-close toast -- same product family
// nudges users toward Pro / Yaw Business when they're getting real value
// out of the Free tier.
//
// Two key non-features:
//   - No grace period. Counting starts at touch #1; the first nag can
//     fire on touch #2 (the minimum threshold).
//   - No escalation. The cadence stays constant whether the user has
//     dismissed 1 nag or 100. Escalation reads as hostile.
//
// Suppressed entirely when:
//   - Token is set (account mode -- Pro/Business already paying)
//   - stdout/stdin is not a TTY (CI, piped output, MCP-client subprocess)
//   - YAW_MCP_NO_NAG=1 (escape hatch; not advertised in help)
//   - The invoking subcommand is the server itself (no subcommand, no -h,
//     no --version) -- those are AI-invoked or quick env checks
//
// Persistence: ~/.yaw-mcp/nag-state.json. Separate from the main
// state.json so YAW_MCP_DISABLE_PERSISTENCE doesn't dodge the nag, and
// so the schema is simple (3 numeric fields, no migration path needed).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const NAG_STATE_FILENAME = "nag-state.json";

/** Minimum and maximum touch points between consecutive nags. After
 *  each nag we pick a new threshold uniformly in [MIN, MAX]. With
 *  MIN=2/MAX=4 the long-run average is one nag per 3 touch points;
 *  matches the "every 2-4 touch points" line in plans-v2.md. */
const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 4;

/** Minimum gap between two nags in real time. Even a burst of 20
 *  touch points in 10 minutes shouldn't fire two nags. 1.5 days
 *  matches Yaw Terminal's toast cadence. */
const FLOOR_MS = 36 * 60 * 60 * 1000; // 1.5 days

/** Subcommands that count as human-initiated touch points. The bare
 *  server invocation (no subcommand) is excluded because it's the AI
 *  client launching yaw-mcp -- nagging during a tool call would confuse
 *  the agent and the user. Help/version/completion-emit also excluded
 *  (quick checks, often scripted). */
export const NAG_ELIGIBLE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install",
  "doctor",
  "servers",
  "bundles",
  "compliance",
  "upgrade",
  "try",
  "try-cleanup",
  "reset-learning",
  "login",
  "logout",
  "sync",
  "stats",
  "secrets",
]);

export interface NagState {
  /** Touch points seen since the last nag fired (or since first run). */
  touchPoints: number;
  /** When `touchPoints` hits this value, fire the nag. Reset to a new
   *  random in [MIN_THRESHOLD, MAX_THRESHOLD] after each fire. Defaults
   *  to MIN_THRESHOLD on first run so the first nag lands quickly. */
  nextThreshold: number;
  /** Wall-clock ms when the last nag fired. 0 = never. The floor check
   *  uses this to enforce the 1.5-day minimum gap. */
  lastShownAt: number;
}

export function emptyNagState(): NagState {
  return { touchPoints: 0, nextThreshold: MIN_THRESHOLD, lastShownAt: 0 };
}

export function nagStatePath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, NAG_STATE_FILENAME);
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/** Load the nag state. Silent failure -- a missing or corrupt file
 *  starts fresh from emptyNagState(). Never throws. */
export async function loadNagState(filePath: string = nagStatePath()): Promise<NagState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyNagState();
    const p = parsed as Record<string, unknown>;
    const touchPoints =
      typeof p.touchPoints === "number" && Number.isFinite(p.touchPoints) && p.touchPoints >= 0 ? p.touchPoints : 0;
    const nextThreshold =
      typeof p.nextThreshold === "number" && Number.isFinite(p.nextThreshold) && p.nextThreshold >= MIN_THRESHOLD
        ? Math.min(p.nextThreshold, MAX_THRESHOLD)
        : MIN_THRESHOLD;
    const lastShownAt =
      typeof p.lastShownAt === "number" && Number.isFinite(p.lastShownAt) && p.lastShownAt >= 0 ? p.lastShownAt : 0;
    return { touchPoints, nextThreshold, lastShownAt };
  } catch (err) {
    if (isFileNotFound(err)) return emptyNagState();
    log("warn", "Failed to load nag state, starting fresh", {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyNagState();
  }
}

/** Save the nag state atomically. Best-effort -- save failures log but
 *  never throw, because losing one increment is harmless. */
export async function saveNagState(state: NagState, filePath: string = nagStatePath()): Promise<void> {
  try {
    await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    log("warn", "Failed to save nag state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface NagDecision {
  show: boolean;
  /** When `show=true`, the updated state to persist BEFORE showing the
   *  interstitial. (Persisting after the keypress would let a
   *  ctrl-c-during-prompt user dodge the cadence reset indefinitely.) */
  next: NagState;
}

/** Decide whether the current touch point fires a nag, given the
 *  current state, the wall clock, and a random function injected for
 *  determinism in tests. Pure -- no I/O.
 *
 *  Algorithm:
 *    1. Bump touchPoints.
 *    2. If touchPoints < nextThreshold, no nag.
 *    3. If now - lastShownAt < FLOOR_MS, no nag (but DO bump the
 *       counter so the floor doesn't accumulate hidden debt -- we'll
 *       fire on the next eligible touch after the floor lifts, not
 *       immediately blast 5 nags in a row).
 *    4. Otherwise fire: reset touchPoints to 0, pick a new threshold,
 *       record lastShownAt = now. */
export function evaluateNag(
  state: NagState,
  now: number = Date.now(),
  random: () => number = Math.random,
): NagDecision {
  const bumped: NagState = { ...state, touchPoints: state.touchPoints + 1 };
  if (bumped.touchPoints < bumped.nextThreshold) {
    return { show: false, next: bumped };
  }
  if (now - bumped.lastShownAt < FLOOR_MS) {
    // Threshold hit but the floor still applies. Hold the counter at
    // the threshold (don't blow past it) so the next eligible touch
    // re-fires this branch and we re-check the floor cleanly.
    return { show: false, next: { ...bumped, touchPoints: bumped.nextThreshold } };
  }
  return {
    show: true,
    next: {
      touchPoints: 0,
      nextThreshold: pickThreshold(random),
      lastShownAt: now,
    },
  };
}

/** Uniform integer in [MIN_THRESHOLD, MAX_THRESHOLD]. Inclusive both
 *  ends. With MIN=2 MAX=4 -> values 2, 3, or 4. */
export function pickThreshold(random: () => number = Math.random): number {
  const range = MAX_THRESHOLD - MIN_THRESHOLD + 1;
  return MIN_THRESHOLD + Math.floor(random() * range);
}

export interface RecordTouchPointOpts {
  /** Override file path (tests). Defaults to nagStatePath(home). */
  filePath?: string;
  /** Override homedir (tests). Defaults to os.homedir(). */
  home?: string;
  /** Override clock (tests). Defaults to Date.now. */
  now?: number;
  /** Override random source (tests). Defaults to Math.random. */
  random?: () => number;
}

/** Bump the touch-point counter, decide whether to fire a nag,
 *  persist the new state, and return the decision. Callers must
 *  await this BEFORE calling showNagInterstitial -- the state save
 *  guards against ctrl-c-during-prompt dodging the cadence. */
export async function recordTouchPoint(opts: RecordTouchPointOpts = {}): Promise<NagDecision> {
  const filePath = opts.filePath ?? nagStatePath(opts.home);
  const state = await loadNagState(filePath);
  const decision = evaluateNag(state, opts.now, opts.random);
  await saveNagState(decision.next, filePath);
  return decision;
}

// ---------------------------------------------------------------------
// Interstitial UI -- ASCII only (per terminal-output rule), keypress
// gate, TTY-only.
// ---------------------------------------------------------------------

export interface ShowNagOpts {
  /** Override stdout (tests). Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Override stdin (tests). Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Override TTY detection (tests). Defaults to stdout.isTTY && stdin.isTTY. */
  isTTY?: boolean;
}

/** Render the interstitial and wait for the user to press Enter (or
 *  Ctrl-C, which terminates the process). When stdout or stdin is not a
 *  TTY, this is a silent no-op -- piped output and CI scripts must not
 *  block on an interactive prompt.
 *
 *  Always resolves; stdin errors after the prompt fires are swallowed
 *  because at that point we've already shown the message and the user
 *  has effectively been nagged. */
export async function showNagInterstitial(opts: ShowNagOpts = {}): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const tty =
    opts.isTTY ?? ((stdout as { isTTY?: boolean }).isTTY === true && (stdin as { isTTY?: boolean }).isTTY === true);
  if (!tty) return;

  const lines = [
    "",
    "+----------------------------------------------------------+",
    "|                    Yaw MCP -- support the project        |",
    "+----------------------------------------------------------+",
    "|                                                          |",
    "|  You're using Yaw MCP free.                              |",
    "|                                                          |",
    "|  Pro ($9/mo or $90/yr) adds:                             |",
    "|    * sync bundles + secrets across machines              |",
    "|    * encrypted secret vault (never logged)               |",
    "|    * 90-day analytics on AI tool usage                   |",
    "|    * `yaw-mcp stats` command                             |",
    "|                                                          |",
    "|  Yaw Business ($10/seat/mo or $99/seat/yr) adds:         |",
    "|    * everything in Pro, per seat                         |",
    "|    * shared team bundles                                 |",
    "|    * shared org secrets                                  |",
    "|    * per-seat audit log                                  |",
    "|    * SSO                                                 |",
    "|                                                          |",
    "|  Learn more:  https://yaw.sh/mcp                         |",
    "|                                                          |",
    "|  Press Enter to continue (Ctrl-C to quit).               |",
    "+----------------------------------------------------------+",
    "",
  ];
  stdout.write(`${lines.join("\n")}\n`);

  await new Promise<void>((resolve) => {
    const onData = (): void => {
      try {
        (stdin as { off?: (e: string, fn: (...args: unknown[]) => void) => void }).off?.("data", onData);
      } catch {
        // best-effort; some streams don't support off()
      }
      resolve();
    };
    try {
      stdin.on("data", onData);
      // If the stream is paused (default for non-Readable.unshift mode),
      // poke it; otherwise the 'data' handler never fires.
      (stdin as { resume?: () => void }).resume?.();
    } catch {
      // If we can't even attach the listener, don't block the user.
      resolve();
    }
  });
}
