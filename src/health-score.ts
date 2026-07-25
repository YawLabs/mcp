import type { ConnectionHealth } from "./types.js";

// Health-aware ranking penalty. Takes a raw ranker score and scales it
// by a [0.5, 1.0] factor derived from observed reliability so dispatch
// prefers servers that have been working in this session over servers
// that have been flaking. Pure client-side — no backend dependency.
//
// We only ever *shrink* the score; we never boost above the raw value.
// The idea is "all else equal, prefer the one that works," not "a very
// healthy obscure match beats a marginally healthy exact match."
//
// Thresholds are tuned by intuition — when we have usage data the values
// should be revisited. Current defaults:
//   - Need ≥3 observations before error rate matters (noise floor).
//   - 0% errors  → factor 1.00 (no penalty)
//   - 30% errors → factor 0.70
//   - 50%+ errors → factor 0.50 (floor — never drop below)
//   - Activation failure within ACTIVATION_FAILURE_TTL_MS → factor 0.50
export const ACTIVATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const OBSERVATION_FLOOR = 3;
const MIN_FACTOR = 0.5;

export interface ActivationFailure {
  at: number;
  message: string;
}

export function errorRateFactor(health: ConnectionHealth | undefined): number {
  if (!health) return 1.0;
  if (health.totalCalls < OBSERVATION_FLOOR) return 1.0;
  const rate = health.errorCount / health.totalCalls;
  const factor = 1 - rate;
  return Math.max(MIN_FACTOR, factor);
}

export function activationFailureFactor(failure: ActivationFailure | undefined, now: number = Date.now()): number {
  if (!failure) return 1.0;
  if (now - failure.at > ACTIVATION_FAILURE_TTL_MS) return 1.0;
  return MIN_FACTOR;
}

// Combine signals by taking the strictest penalty — worst observed
// reliability wins, because both signals are evidence of real failure.
export function healthFactor(
  health: ConnectionHealth | undefined,
  activationFailure: ActivationFailure | undefined,
  now: number = Date.now(),
): number {
  return Math.min(errorRateFactor(health), activationFailureFactor(activationFailure, now));
}

// Render a short human-readable warning when a server is looking shaky,
// so discover() can point the LLM at healthier alternatives. Returns
// null when there is nothing to warn about — the caller should not
// print a line at all in that case. Activation failures take precedence
// over per-call error rates because they mean the server is currently
// unusable, not merely unreliable. Both signals are session-local.
//
// We deliberately hide low-sample error rates (<3 calls) — flagging a
// server as unhealthy after a single flaky call would train the model
// to skip perfectly-fine servers just because the first call 500'd. At or
// above the observation floor we surface ANY nonzero rate, so the warning
// covers exactly the population errorRateFactor penalizes (no silently
// down-ranked servers).
export function formatHealthWarning(
  health: ConnectionHealth | undefined,
  activationFailure: ActivationFailure | undefined,
  now: number = Date.now(),
): string | null {
  if (activationFailure && now - activationFailure.at <= ACTIVATION_FAILURE_TTL_MS) {
    const ageMin = Math.max(1, Math.round((now - activationFailure.at) / 60_000));
    const msg = activationFailure.message ? `: ${truncateForWarning(activationFailure.message)}` : "";
    return `warn: last activation failed ${ageMin}m ago${msg}`;
  }
  if (health && health.totalCalls >= OBSERVATION_FLOOR) {
    const rate = health.errorCount / health.totalCalls;
    // Warn on ANY nonzero error rate above the observation floor, not just
    // >=30%. errorRateFactor already down-ranks a server for any rate>0, so a
    // 1-29%-error server was being silently penalized in ranking with no line
    // in the health block to explain it. Tying the warning to the same
    // rate>0 condition keeps the penalty visible instead of silent -- the
    // OBSERVATION_FLOOR still suppresses single-flake noise on tiny samples.
    if (rate > 0) {
      const lastErr = health.lastErrorMessage ? `: ${truncateForWarning(health.lastErrorMessage)}` : "";
      return `warn: ${health.errorCount} of last ${health.totalCalls} calls failed${lastErr}`;
    }
  }
  return null;
}

// Keep warning strings short — discover() output goes to the LLM's
// context window and every error message line we append is tokens the
// caller pays. 120 chars is two lines of typical terminal width and
// usually enough for a stack-trace top-level or an HTTP status.
function truncateForWarning(msg: string): string {
  const clean = msg.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
