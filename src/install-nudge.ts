// Shadow-driven install nudge — the gate + per-CLI suppression cadence for
// discover's opt-in "Install candidates" block.
//
// What it does: when the gate is ON, discover runs the existing offline
// shell-history shadow scan (doctor-cmd.ts scanShellHistoryForShadows) and,
// for any heavily-used CLI that has a first-party install target but no
// matching MCP server installed, appends a one-line "install <package>"
// nudge. This module owns ONLY the policy: is the feature enabled, does a
// given CLI clear the usage threshold + cooldown, and recording that we
// nudged a CLI so we don't repeat within the cooldown.
//
// Privacy (load-bearing): this module never reads, stores, or emits any raw
// shell-history line. The only state it persists is { cli, nudgedAt } — a
// CLI binary NAME (a fixed identifier from SHADOW_INSTALL_TARGETS, not user
// input) plus a timestamp. No command text, no arguments, nothing about
// what the user ran beyond the aggregate count the caller already computed.
//
// Off by default: the gate (installNudgeEnabled) is the single chokepoint.
// When it returns false the caller must NOT run the scan, so discover output
// is byte-identical to today and nothing about shell history is even read.
//
// Fail-open on IO: a missing / unreadable / corrupt state file is treated as
// "never nudged" (shouldNudge returns true); a write failure is swallowed.
// The worst case is nudging the same CLI twice — never a thrown error and
// never a blocked discover. Synchronous fs is used deliberately: the call
// site (buildDiscoverOutputImpl) is synchronous, and the file is tiny.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

/** Minimum ShadowHit.count (over the tail-500 history window scanned by
 *  scanShellHistoryForShadows) before a CLI is eligible for a nudge. A CLI
 *  run fewer times than this is noise, not a workflow. */
export const INSTALL_NUDGE_MIN_COUNT = 5;

/** Don't re-nudge the same CLI within this window. Mirrors auto-upgrade's
 *  "act once, then stay quiet" cadence — a user who saw the nudge and chose
 *  not to install shouldn't be pestered on every discover for a week. */
export const INSTALL_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const INSTALL_NUDGE_STATE_FILENAME = "install-nudge-state.json";

interface NudgeRecord {
  /** CLI binary name (e.g. "tailscale"). */
  cli: string;
  /** Epoch ms when we last surfaced this CLI's nudge. */
  nudgedAt: number;
}

interface NudgeState {
  nudges: NudgeRecord[];
}

/** Absolute path to the suppression-state file inside `~/.yaw-mcp/`. */
export function installNudgeStatePath(home: string): string {
  return join(home, CONFIG_DIRNAME, INSTALL_NUDGE_STATE_FILENAME);
}

/** The gate. The shadow scan runs ONLY when this returns true; off by
 *  default. Enabled by either the env override (YAW_MCP_INSTALL_NUDGE=1) or
 *  the resolved config flag (installNudge: true). Env and config are
 *  independent — either one flips it on. Only a literal "1" enables via env
 *  so a stray empty/other value can't accidentally turn it on. */
export function installNudgeEnabled(env: NodeJS.ProcessEnv, config: { installNudge?: boolean } | null): boolean {
  if (env.YAW_MCP_INSTALL_NUDGE === "1") return true;
  if (config?.installNudge === true) return true;
  return false;
}

/** Read + parse the suppression state. Fail-open: any absent / unreadable /
 *  malformed file yields an empty state so every CLI reads as "never
 *  nudged". Never throws. */
function readState(home: string): NudgeState {
  const path = installNudgeStatePath(home);
  if (!existsSync(path)) return { nudges: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { nudges: [] };
    const raw = (parsed as { nudges?: unknown }).nudges;
    if (!Array.isArray(raw)) return { nudges: [] };
    const nudges: NudgeRecord[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as NudgeRecord).cli === "string" &&
        typeof (entry as NudgeRecord).nudgedAt === "number"
      ) {
        nudges.push({ cli: (entry as NudgeRecord).cli, nudgedAt: (entry as NudgeRecord).nudgedAt });
      }
    }
    return { nudges };
  } catch {
    return { nudges: [] };
  }
}

/** True iff `cli` may be nudged now: either never nudged, or last nudged
 *  longer ago than the cooldown. Fail-open — a read error reads as "never
 *  nudged", so the user still sees the candidate. `now` is injectable for
 *  tests; defaults to Date.now(). */
export function shouldNudge(cli: string, home: string, now: () => number = Date.now): boolean {
  const state = readState(home);
  const rec = state.nudges.find((n) => n.cli === cli);
  if (!rec) return true;
  return now() - rec.nudgedAt >= INSTALL_NUDGE_COOLDOWN_MS;
}

/** Record that `cli` was just nudged so it's suppressed for the cooldown.
 *  Read-modify-write so concurrent CLIs surfaced in the same discover each
 *  land; the prior timestamp for this CLI (if any) is replaced. Stale
 *  entries past the cooldown are pruned on write to bound file growth.
 *  Fail-open: a write/mkdir failure is logged at debug and swallowed — the
 *  cost is a possible repeat nudge, never a thrown error. `now` is
 *  injectable for tests. */
export function recordNudge(cli: string, home: string, now: () => number = Date.now): void {
  try {
    const at = now();
    const state = readState(home);
    // Drop the existing record for this cli plus any entry whose cooldown
    // has fully lapsed (those would read as "never nudged" anyway, so
    // keeping them just grows the file).
    const kept = state.nudges.filter((n) => n.cli !== cli && at - n.nudgedAt < INSTALL_NUDGE_COOLDOWN_MS);
    kept.push({ cli, nudgedAt: at });
    const path = installNudgeStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ nudges: kept }, null, 2)}\n`, "utf8");
  } catch (err) {
    // Best-effort suppression — losing a write just risks one extra nudge.
    log("debug", "install-nudge: failed to record nudge state", {
      cli,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
