// Heuristic detection of "missing credential" failures. When a local
// upstream fails to start with a stderr tail like "GITHUB_TOKEN is
// required" or "Missing env var: OPENAI_API_KEY", yaw-mcp can ask the
// user for the value -- typed into a masked field on a one-shot loopback
// page reached through an MCP elicitation, never into the elicitation
// itself -- rather than making them hunt for where to put it. We only ever
// treat ALL_CAPS names as credentials -- anything else is too noisy to infer.

// Case-insensitive so the surrounding English is matched in any casing,
// but the captured name is post-filtered to require ALL_CAPS so ordinary
// English words ("var", "missing") never sneak through.
//
// The env-var name, spelled ONCE: every capture group below and isAllCaps
// read it, so widening or tightening it cannot leave one copy behind (a name
// a pattern captures but isAllCaps refuses is silently never elicited).
const NAME = "[A-Z_][A-Z0-9_]{2,}";
// Whitespace that does NOT cross a line, used for every gap in every pattern
// except the one after a colon (SEP, below). The haystack is multi-line
// (stderr tail + error message joined with "\n"), and a gap that spans a
// break lets a line merely ENDING in "missing" ("sourcemap is missing") claim
// whatever credential-shaped name STARTS the next one ("OPENAI_API_KEY loaded
// from vault") -- a prompt for a key the server never asked for.
const GAP = "[^\\S\\r\\n]+";
// The separator after a word that may end in a colon -- pattern 1's
// "missing", and the env / variable words of LEADING_ENV_WORDS (below): a
// same-line gap, OR a colon followed by any whitespace. The colon is the one
// marker that a break continues the phrase -- "Missing:\n  OPENAI_API_KEY"
// is a list, and it still elicits.
const SEP = "(?:[^\\S\\r\\n]*:\\s+|[^\\S\\r\\n]+)";
// An optional quote or backtick around the name ("`GITHUB_TOKEN` is
// required", "Missing env var 'GITHUB_TOKEN'"). Placed only where the name
// meets a gap -- where it meets a `\b` instead, the boundary already allows a
// quote -- and kept OUTSIDE the capture so it never joins the name.
const QUOTE = "[\"'`]?";
// "environment variable" / "env var" between the name and the verb
// ("GITHUB_TOKEN environment variable is required", the phrasing the Brave
// Search reference server prints), read by patterns 2, 3 and 5. It comes
// AFTER the capture, so unlike LEADING_ENV_WORDS it cannot eat the front of a
// name.
const ENV_WORDS = `(?:(?:env|environment)${GAP})?(?:(?:variable|var)${GAP})?`;
// The same words IN FRONT of the name, read by patterns 1 and 4 ("Missing
// env var: X", "Please set environment variable X") -- one copy, so the two
// patterns cannot drift apart again (pattern 4 once spelled its own narrower
// list and matched no "environment", no plural and no colon). Unlike
// ENV_WORDS, each word may take a colon ("Missing env vars: X"), and the
// var/variable words a plural ("Missing environment variables: X"). The separator after each word is
// load-bearing: both groups are optional and case-insensitive, so without it
// "Missing VARIANT_TOKEN" has its leading "VAR" eaten by the var/variable
// group and reports the name as "IANT_TOKEN" (and "Missing ENV_TOKEN" /
// "Missing VARS_TOKEN" would lose a prefix the same way).
const LEADING_ENV_WORDS = `(?:(?:env|environment)${SEP})?(?:(?:variables?|vars?)${SEP})?`;

// Pattern 1 tolerates these words around the name: an optional "required",
// then LEADING_ENV_WORDS -- an optional "env"/"environment" and an optional
// "var"/"variable" (plural too, "Missing environment variables: X") -- and an
// optional COLON after ANY of "missing", "env"/"environment" or
// "var"/"variable" -- "Missing env var: OPENAI_API_KEY" (this file's own
// header example), "Missing env: X" and "missing: X" all elicit. It captures
// only the FIRST name of a comma-separated list.
//
// Pattern 2 needs "is" before required/missing/empty/undefined, because
// without it those words describe something else ("GITHUB_TOKEN required
// scopes", "OPENAI_API_KEY missing permissions"). Only "not set", "unset" and
// "not provided" read the same with or without it ("env var SLACK_BOT_TOKEN
// not set"). "is not defined" is deliberately absent: it is the JS
// ReferenceError shape, a crash rather than a missing credential.
//
// Pattern 4 is the "Please set X" shape. It reads the same LEADING_ENV_WORDS
// as pattern 1 ("Please set env var: X", "Please set environment variable X",
// "Please set environment variables: X") after an optional "the" ("Please set
// the environment variable X"). Nothing after the name is read, so "Please
// set the X environment variable" matches on "the" alone. "the" takes a
// mandatory gap for the same reason the env words do: "Please set THE_TOKEN"
// keeps its "THE".
//
// Pattern 5 is the "No GITHUB_TOKEN provided" shape; "no" and the verb
// around the name are both required, so "GITHUB_TOKEN provided" is not a hit.
const MISSING_PATTERNS: RegExp[] = [
  new RegExp(`\\bmissing${SEP}(?:required${GAP})?${LEADING_ENV_WORDS}${QUOTE}(${NAME})\\b`, "gi"),
  new RegExp(
    `\\b(${NAME})${QUOTE}${GAP}${ENV_WORDS}(?:is${GAP}(?:required|missing|empty|undefined)|(?:is${GAP})?(?:not${GAP}set|unset|not${GAP}provided))\\b`,
    "gi",
  ),
  new RegExp(`\\b(${NAME})${QUOTE}${GAP}${ENV_WORDS}must${GAP}be${GAP}set\\b`, "gi"),
  new RegExp(`\\bplease${GAP}set${GAP}(?:the${GAP})?${LEADING_ENV_WORDS}${QUOTE}(${NAME})\\b`, "gi"),
  new RegExp(`\\bno${GAP}${QUOTE}(${NAME})${QUOTE}${GAP}${ENV_WORDS}(?:provided|set)\\b`, "gi"),
];

// A failing server's stderr chooses what the user is asked to type into a
// secret prompt, so the ALL_CAPS shape alone is far too loose: "SSH_AUTH_SOCK
// is not set" and "ERROR is undefined" are ordinary infrastructure/English
// noise, and eliciting for them trains the user to paste secrets at prompts
// that had nothing to do with a credential. A name therefore has to LOOK like
// a credential before it can be elicited, on top of the deny-list below.
//
// Matching is by UNDERSCORE SEGMENT, not substring: a substring test for
// "KEY" also fires on MONKEY_CAGE, and one for "AUTH" fires on SSH_AUTH_SOCK
// -- the exact false positive this filter exists to stop. AUTH is
// deliberately absent for that reason; a genuine token is spelled with one of
// the words below somewhere in the name.
//
// A bare "API" segment is absent for the same reason: it makes API_URL,
// API_HOST and API_BASE credential-shaped and pops a secret prompt for a
// URL, while adding nothing for real keys -- API_KEY / STRIPE_API_KEY /
// OPENAI_API_KEY all still match on their KEY (or TOKEN) segment, and the
// underscore-less APIKEY spelling is listed in its own right below.
const CREDENTIAL_SEGMENTS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "KEY",
  "KEYS",
  "APIKEY",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "PAT",
  "DSN",
  "BEARER",
  "PASSWORDS",
  "CLIENTSECRET",
  "BOTTOKEN",
  // -KEY compounds are ENUMERATED, not inferred: KEY is kept off the suffix
  // rule below because MONKEY, TURKEY, HOCKEY and DONKEY all end in it.
  "SECRETKEY",
  "SIGNINGKEY",
  "ACCESSKEY",
  "PRIVATEKEY",
  "SSHKEY",
  "AUTHKEY",
  "MASTERKEY",
  "LICENSEKEY",
]);

// A segment that ENDS in one of these is a credential noun with a qualifier
// glued to its front -- BOTTOKEN, CLIENTSECRET, AUTHTOKEN, DBPASSWORD -- and
// reads as a credential exactly as its split form (BOT_TOKEN) does. Tested
// as a SUFFIX, never a substring, because that is the direction English does
// not build ordinary words in: "tokenizer" and "secretary" start with the
// noun, nothing common ends in "token" or "secret". So S3_SECRETKEY,
// SLACK_BOTTOKEN and OAUTH_CLIENTSECRET elicit while TOKENIZER_PATH and
// SECRETARY_EMAIL stay refused. KEY is deliberately absent (see the -KEY
// note in CREDENTIAL_SEGMENTS); so is PASS (BYPASS, COMPASS).
const CREDENTIAL_NOUN_SUFFIXES = ["TOKEN", "SECRET", "PASSWORD", "PASSPHRASE", "CREDENTIAL"];

// Names with no underscores at all (GITHUBTOKEN, APIKEY) never split into a
// segment the set can match, so a small set of unambiguous substrings backs
// the segment test up -- for THOSE names only (see isCredentialShaped). A name
// that has underscores already had every segment tested, and applying the
// substring test to it as well is what made "TOKENIZER_PATH is required"
// pop a secret prompt for a file path: "TOKEN" is a whole word here, but it
// is also the head of an ordinary one.
const CREDENTIAL_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "PASSPHRASE", "APIKEY", "CREDENTIAL"];

// A name whose LAST segment is one of these names WHERE a thing lives, or a
// property of it, not the thing: SSH_KEY_PATH, TLS_KEY_FILE, REDIS_KEY_PREFIX,
// TOKEN_BUCKET_SIZE. The credential segment in front is only a qualifier, and
// eliciting for one pops a secret prompt for a file path. Refused before the
// segment test, so it also keeps upstream.ts's redactor from treating an
// inherited SSH_KEY_PATH's value as a secret and rewriting that path wherever
// it appears in stderr.
//
// URL and URI are deliberately absent: a connection string carries its
// password inline (postgres://user:pass@host), so REDIS_PASSWORD_URL stays a
// credential. ID is absent too -- AWS_ACCESS_KEY_ID is half of the credential
// pair. Only the LAST segment counts: PATH_TOKEN and HOST_KEY end in a
// credential segment, so they still elicit.
const LOCATOR_SEGMENTS = new Set(["PATH", "FILE", "DIR", "HOST", "PORT", "PREFIX", "SIZE"]);

// Belt-and-braces on top of the credential-shape test above: these are names
// that either ARE infrastructure variables or are English words a server is
// likely to shout in a failure line. Keeping them listed means the filter
// still refuses them if the shape test is ever relaxed.
const IGNORED = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TERM",
  "SHELL",
  "NODE_ENV",
  "DEBUG",
  "LOG_LEVEL",
  "SSH_AUTH_SOCK",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "PWD",
  "PS1",
  "EDITOR",
  "PAGER",
  "HOSTNAME",
  "ERROR",
  "WARNING",
  "NOTE",
  "TODO",
  "NULL",
  "NONE",
  "UNDEFINED",
  "CONFIG",
  "OPTION",
  "OPTIONS",
  "VALUE",
  "VAR",
]);

// JS regex has no (?i:...) scoped case-insensitivity, so the capture-group
// case check has to happen in code: keep only matches whose captured span
// is already uppercase in the original input.
const ALL_CAPS_NAME = new RegExp(`^${NAME}$`);
function isAllCaps(name: string): boolean {
  return ALL_CAPS_NAME.test(name);
}

/** Does this ALL_CAPS name read as a credential rather than as ordinary
 *  infrastructure? See CREDENTIAL_SEGMENTS for why the test is per-segment,
 *  and LOCATOR_SEGMENTS for the trailing segment that overrides it. */
function isCredentialShaped(name: string): boolean {
  const segments = name.split("_");
  if (LOCATOR_SEGMENTS.has(segments[segments.length - 1] ?? "")) return false;
  for (const segment of segments) {
    if (CREDENTIAL_SEGMENTS.has(segment)) return true;
    // Strictly LONGER than the noun: the whole-word case is the set's job,
    // and this rule is only for the compound (BOTTOKEN) the set cannot list
    // exhaustively. Before it, the underscore gate below refused every
    // underscored compound outright -- S3_SECRETKEY, SLACK_BOTTOKEN and
    // OAUTH_CLIENTSECRET, all of which the old substring test had caught,
    // stopped eliciting the day TOKENIZER_PATH was fixed.
    if (CREDENTIAL_NOUN_SUFFIXES.some((noun) => segment.length > noun.length && segment.endsWith(noun))) {
      return true;
    }
  }
  // The substring fallback exists for names the segment split cannot see
  // into (no underscore at all). A name WITH underscores has just had every
  // segment checked, as a whole word and as a noun-suffixed compound, so a
  // substring hit on it can only be a noun buried at the HEAD or middle of a
  // longer segment -- TOKENIZER_PATH, SECRETARY_EMAIL -- which is exactly the
  // false positive the segment rule was written to refuse.
  if (name.includes("_")) return false;
  return CREDENTIAL_SUBSTRINGS.some((s) => name.includes(s));
}

/** Does this ENVIRONMENT VARIABLE NAME read as a credential? The shape test
 *  plus the infrastructure deny-list, composed once so the two consumers
 *  cannot drift: the elicitation path below, which decides what the user is
 *  asked to type into a secret prompt, and upstream.ts's stderr redactor,
 *  which decides which inherited parent-env values are masked out of an
 *  ActivationError before it reaches the log and the model.
 *
 *  Uppercased first, because an env var is not guaranteed ALL_CAPS on Windows
 *  (`Path`, `ProgramFiles`) while the sets above are. That is safe in the
 *  direction that matters: the folded name is tested against the same
 *  segment/suffix rules, which are exactly the ones written to refuse
 *  BYPASS / COMPASS / MONKEY_CAGE / TOKENIZER_PATH -- a naive
 *  /(TOKEN|SECRET|PASS|API_?KEY|CREDENTIAL)/i would match the first three.
 *
 *  Distinct from detectMissingCredentials's use: that one additionally
 *  requires isAllCaps, because its input is a NAME SCRAPED OUT OF PROSE
 *  where casing is the evidence that a name was meant at all. A key read
 *  from process.env needs no such proof. */
export function isCredentialEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return isCredentialShaped(upper) && !IGNORED.has(upper);
}

export function detectMissingCredentials(stderrOrMessage: string | undefined): string[] {
  if (!stderrOrMessage) return [];
  const found = new Set<string>();
  for (const re of MISSING_PATTERNS) {
    for (const match of stderrOrMessage.matchAll(re)) {
      const name = match[1];
      if (name && isAllCaps(name) && isCredentialEnvName(name)) found.add(name);
    }
  }
  return [...found];
}
