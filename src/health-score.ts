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
// Minimum error rate that earns a human-visible warning line in discover().
// Below this we still let errorRateFactor nudge ranking, but stay silent:
// totalCalls/errorCount never decay, so a single stale error in a large
// sample (1 in 1000) must not emit a permanent "N of last M failed" line at
// a negligible penalty -- that would train the model to skip a fine server.
const WARN_RATE_FLOOR = 0.1;

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
// to skip perfectly-fine servers just because the first call 500'd. Above
// the floor we surface a MEANINGFUL rate (>= WARN_RATE_FLOOR) -- a lower gate
// than the old 30% so a genuinely flaky server isn't silent, but NOT rate>0,
// since the never-decaying counters would then warn forever on one old error.
//
// The upstream error excerpt appended to either line is SCRUBBED, not raw:
// error-category.ts refuses to surface raw text next to a category precisely
// because third-party servers echo secrets in errors, and this surface used
// to contradict that by pasting up to 120 chars of the same text into
// discover(). truncateForWarning now runs scrubForWarning first, so the
// actionable part of the message survives and credential-shaped values do
// not. The excerpt earns its place: "502 bad gateway" tells the model to
// retry elsewhere where a bare category would not.
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
    // Warn once the rate is meaningful (>= WARN_RATE_FLOOR) -- a lower gate
    // than the old >=30% so a genuinely flaky server (which errorRateFactor is
    // already down-ranking) no longer hides, but NOT rate>0: totalCalls /
    // errorCount never decay, so a lone early error would otherwise emit a
    // permanent "N of last M failed" line at a negligible 1/M penalty.
    if (rate >= WARN_RATE_FLOOR) {
      const lastErr = health.lastErrorMessage ? `: ${truncateForWarning(health.lastErrorMessage)}` : "";
      return `warn: ${health.errorCount} of last ${health.totalCalls} calls failed${lastErr}`;
    }
  }
  return null;
}

// Credential-shaped fragments we refuse to echo into discover() output.
// The name/value shape keeps the NAME and blanks only the VALUE --
// "unauthorized: api_key=<redacted>" still tells the model what went wrong,
// which is the whole point of surfacing the excerpt at all.
//
// ORDER IS LOAD-BEARING. The auth-scheme rule runs FIRST: with the
// name/value rule ahead of it, `Authorization: Bearer <blob>` matched
// name=Authorization value=`Bearer`, so the SCHEME WORD was redacted and the
// actual token survived into the output. Scheme-first collapses the whole
// `Bearer <blob>` run to the marker, and because the name/value rule's value
// class excludes `<` it then finds nothing left to consume.
const REDACTED = "<redacted>";

const SECRET_KEY_NAMES =
  "api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|" +
  "private[-_]?key|secret|password|passwd|pwd|token|authorization|auth|credential|signature|sig";

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // 1. An HTTP `Authorization: Bearer <blob>` / `Basic <blob>` header value.
  { re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: REDACTED },
  // 2. A secret-ish key followed by = or : and a value -- a query string, a
  //    JSON body, a header dump, or a Python repr ({'token': 'abc'}).
  { re: new RegExp(`\\b(${SECRET_KEY_NAMES})("?\\s*[=:]\\s*"?)[^\\s,;&"'}\\]<]+`, "gi"), replace: `$1$2${REDACTED}` },
  // 3. A vendor-prefixed key carrying no name for rule 2 to anchor on.
  {
    re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xoxb|xoxp|xoxa|xapp|glpat)[-_][A-Za-z0-9_-]{8,}/g,
    replace: REDACTED,
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
];

/** Blank out credential-shaped substrings before an upstream error excerpt
 *  reaches discover() output.
 *
 *  error-category.ts's header states the never-surface-raw-text policy and
 *  cites "no general scrubber" as the reason. This is not a general scrubber
 *  and does not pretend to be one -- it cannot know a third-party server's
 *  private encoding. It closes the shapes actually observed leaking (URLs
 *  with `?api_key=`, echoed request bodies, `Authorization:` header dumps,
 *  vendor-prefixed keys), so the excerpt that IS load-bearing for the model
 *  ("502 bad gateway", "spawn ENOENT npx") survives while the value next to a
 *  credential-shaped name does not. Anything it misses is still bounded by
 *  the 120-char truncation below. */
export function scrubForWarning(msg: string): string {
  let out = msg;
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

// Keep warning strings short — discover() output goes to the LLM's
// context window and every error message line we append is tokens the
// caller pays. 120 chars is two lines of typical terminal width and
// usually enough for a stack-trace top-level or an HTTP status.
//
// Scrubs BEFORE truncating so the 120-char cut is applied to already-redacted
// text: a secret sitting past char 120 is REMOVED rather than merely hidden by
// the cut, and an expanded redaction cannot push the result past the cap.
// (A redaction does not shorten -- "<redacted>" is 10 chars, so `token=x`
// grows to `token=<redacted>`. Scrubbing first is what keeps that growth
// inside the cap rather than after it.)
function truncateForWarning(msg: string): string {
  const clean = scrubForWarning(msg).replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
