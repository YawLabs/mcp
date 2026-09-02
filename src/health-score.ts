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
// sample (1 in 1000) must not emit a permanent "N of M failed" line at
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

// True while an activation failure is still inside its TTL window.
//
// The lower bound is not decoration: `at` is a wall-clock stamp taken when the
// activation failed, and a BACKWARDS clock step (NTP correction, VM resume,
// manual set) makes `now - at` NEGATIVE. An upper-bound-only check reads that
// as "younger than the TTL", so the namespace stays pinned at the MIN_FACTOR
// penalty -- and formatHealthWarning keeps rendering "last activation failed
// 1m ago", because Math.max(1, round(negative/60_000)) floors to 1 -- until the
// clock catches back up to the stamp, which can be hours. A future-dated stamp
// is skew, not evidence, so it expires immediately instead.
function isWithinActivationTtl(failure: ActivationFailure, now: number): boolean {
  const age = now - failure.at;
  return age >= 0 && age <= ACTIVATION_FAILURE_TTL_MS;
}

export function activationFailureFactor(failure: ActivationFailure | undefined, now: number = Date.now()): number {
  if (!failure) return 1.0;
  if (!isWithinActivationTtl(failure, now)) return 1.0;
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
  if (activationFailure && isWithinActivationTtl(activationFailure, now)) {
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
    // permanent "N of M failed" line at a negligible 1/M penalty.
    //
    // The line says "N of M", NOT "N of the last M": there is no window. Both
    // counters run from the first call of the session and never decay, so M is
    // the all-time total for this process and the failures it counts can all be
    // hours old. "last" claimed a recency the numbers do not carry, and it is
    // the LLM reading this line and deciding whether to route elsewhere.
    if (rate >= WARN_RATE_FLOOR) {
      const lastErr = health.lastErrorMessage ? `: ${truncateForWarning(health.lastErrorMessage)}` : "";
      return `warn: ${health.errorCount} of ${health.totalCalls} calls failed${lastErr}`;
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

// A VALUE that is PROSE is a DIAGNOSTIC, not a credential, and redacting it
// inverts what upstream said. The value class at rule 2 stops at the first
// whitespace, so a redaction consumes only the first word and the rest of the
// sentence survives: "GITHUB_TOKEN: not set" became "GITHUB_TOKEN: <redacted>
// set", flipping the reading from "credential absent" to "credential present
// but rejected". The same inversion hit every other diagnostic phrasing --
// "SLACK_BOT_TOKEN: must be provided", "API_KEY: environment variable not
// found", "api_key: value is empty", and zod's "GITHUB_TOKEN: Invalid input:
// expected string, received undefined". These are exactly the lines a
// spawn/config failure produces, and they reach the user through
// activationFailures -> the discover() warn line. Over-scrubbing is an
// equal-and-opposite regression to leaking (see the header above), and an
// INVERTED diagnostic is worse than a hidden one.
//
// So the invariant is "this value is prose, not a credential" -- NOT "this
// value is one of N enumerated words", which only ever covered the first word
// of the first phrasing anyone happened to list.
//
// The discriminator is the SEPARATOR, not the surrounding text. That is the
// third attempt at this gate and the reason for it is worth recording, because
// the two obvious approaches are both wrong:
//
//   * An enumerated absence-word list only matches the first whitespace-
//     delimited token, so every phrasing nobody thought of ("must be
//     provided", zod's "Invalid input: ...") still inverted.
//   * Testing whether TEXT FOLLOWS on the line exempts a value whenever
//     anything word-shaped appears later -- a second name=value pair, a JSON
//     sibling key, a query parameter, even the <redacted> marker rule 1 just
//     inserted. That un-redacted real secrets ("password=hunter host=db",
//     "?api_key=deadbeef&user=bob"), worst on remoteFailureDetail, which
//     collapses an error to ONE line so every pair but the last has a tail.
//     It also cost a line-length rescan per match: 796 ms on 260 KB vs 11 ms.
//
// A separator carries the intent directly, in constant time. Machines write
// NAME=value and "name": "value" -- compact, or quoted. Humans writing a
// sentence put a space after the colon: "GITHUB_TOKEN: not set". So:
//
//   PROSE_SEPARATOR -- whitespace AFTER the = or :, and NO quote anywhere in
//                   the separator. A quote means the value was machine-quoted;
//                   no trailing space means a compact dump. Either way, redact.
//   PROSE_VALUE  -- the value is purely alphabetic and short, so it cannot be
//                   a strong credential. Any digit, any punctuation, or more
//                   than 12 chars fails it, which keeps GITHUB_TOKEN=
//                   notasecret123 and api_key=noneofyourbusiness42 blanked.
//
// ABSENCE_VALUE stays as a separator-independent fast path, so the bare-absence
// case survives even in a compact dump ("GITHUB_TOKEN=unset"). Anchored on
// purpose -- it gates only a value that is nothing BUT the absence word.
//
// A value that fails the gates is redacted WHOLE: the gates never CREATE a
// partial redaction, which is the inversion itself. (The value class below
// stops at a quote or a delimiter, so `token=abc'def` has always redacted to
// `token=<redacted>'def`. That is a value-class question, older than these
// gates, and deliberately not folded in here.)
//
// Residual risk, stated plainly: a SHORT ALL-ALPHABETIC secret written with a
// space after the colon ("token: hunter") stays visible. That is bounded -- a
// value with no digit and no punctuation in 12 chars is not a strong
// credential -- and the 120-char cap below still applies.
const ABSENCE_VALUE = /^(?:not|no|missing|unset|undefined|null|none|empty|required|absent|blank|nil|n\/a)$/i;
const PROSE_VALUE = /^[A-Za-z]{1,12}$/;
const PROSE_SEPARATOR = /^[^"]*[=:]\s+$/;

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // 1. An HTTP `Authorization: Bearer <blob>` / `Basic <blob>` header value.
  { re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: () => REDACTED },
  // 2. A secret-ish key followed by = or : and a value -- a query string, a
  //    JSON body, a header dump, or a Python repr ({'token': 'abc'}).
  //
  //    The name may carry an underscore/hyphen-joined PREFIX (NOTION_API_KEY,
  //    auth_token, MY_SECRET), and that prefix is part of the match rather than
  //    something \b can skip over: `_` is a word character, so a bare \b in
  //    front of the name token never matches inside SOMETHING_TOKEN. Env-var
  //    spellings are the dominant shape in MCP spawn/config errors, so that gap
  //    left the raw value in the excerpt whenever the key carried a prefix and
  //    the value itself had no vendor prefix for rule 3 to catch. The prefix
  //    group sits INSIDE $1 so the full name still survives into the output.
  //
  //    Prefixed NON-secrets stay readable, because the name has to both END the
  //    prefixed run and be followed by = or : -- "SSH_AUTH_SOCK=/tmp/..." has
  //    `_SOCK` sitting after `AUTH`, so no alternative matches. The VALUE and
  //    the SEPARATOR are gated too: prose there is a diagnostic, not a
  //    credential, so the whole match is handed back untouched (see
  //    ABSENCE_VALUE / PROSE_VALUE / PROSE_SEPARATOR above).
  //
  //    Everything the callback needs is inside the match, so this stays a
  //    single linear pass. An earlier revision looked ahead at the rest of the
  //    line to decide; that was both wrong (any later word exempted the value)
  //    and quadratic on a long collapsed line.
  {
    re: new RegExp(`\\b((?:[A-Za-z0-9]+[-_])*(?:${SECRET_KEY_NAMES}))("?\\s*[=:]\\s*"?)([^\\s,;&"'}\\]<]+)`, "gi"),
    replace: (match, name, sep, value) => {
      if (ABSENCE_VALUE.test(value)) return match;
      if (PROSE_SEPARATOR.test(sep) && PROSE_VALUE.test(value)) return match;
      return `${name}${sep}${REDACTED}`;
    },
  },
  // 3. A vendor-prefixed key carrying no name for rule 2 to anchor on.
  {
    re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xoxb|xoxp|xoxa|xapp|glpat)[-_][A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
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
// (A redaction changes length in EITHER direction: `token=x` grows to
// `token=<redacted>`, while a long API key collapses to those same 10 chars.
// The ordering does not depend on which way it goes -- what matters is that
// the cut is applied to the FINAL text, so whatever the substitution did to
// the length is already accounted for by the time we measure.)
function truncateForWarning(msg: string): string {
  const clean = scrubForWarning(msg).replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
