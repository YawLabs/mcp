// Heuristic detection of "missing credential" failures. When a local
// upstream fails to start with a stderr tail like "GITHUB_TOKEN is
// required" or "Missing env var: OPENAI_API_KEY", yaw-mcp can prompt the
// user for the value directly via MCP elicitation rather than making
// them hunt for where to put it. We only ever treat ALL_CAPS names as
// credentials -- anything else is too noisy to infer.

// Case-insensitive so the surrounding English is matched in any casing,
// but the captured name is post-filtered to require ALL_CAPS so ordinary
// English words ("var", "missing") never sneak through.
//
// Pattern 1 tolerates every phrasing servers actually emit around the name:
// an optional "required", an optional "env"/"environment", an optional
// "var"/"variable", and an optional COLON after it -- "Missing env var:
// OPENAI_API_KEY" (this file's own header example) matched none of those
// before. The `\s+` AFTER the optional colon is load-bearing: without it
// "Missing VARIANT_TOKEN" has its leading "VAR" eaten by the var/variable
// group and reports the name as "IANT_TOKEN".
const MISSING_PATTERNS: RegExp[] = [
  /\bmissing\s+(?:required\s+)?(?:env\s+|environment\s+)?(?:(?:variable|var)\s*:?\s+)?([A-Z_][A-Z0-9_]{2,})\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+is\s+(?:required|not\s+set|missing|empty|undefined)\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+must\s+be\s+set\b/gi,
  /\bplease\s+set\s+(?:env\s+(?:var\s+|variable\s+)?)?([A-Z_][A-Z0-9_]{2,})\b/gi,
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
  "SIGNINGKEY",
  "ACCESSKEY",
  "PRIVATEKEY",
]);

// Names with no underscores at all (GITHUBTOKEN, APIKEY) never split into a
// segment the set can match, so a small set of unambiguous substrings backs
// the segment test up. Kept deliberately short: every entry here is a word
// that does not occur inside an ordinary infrastructure variable name.
const CREDENTIAL_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "PASSPHRASE", "APIKEY", "CREDENTIAL"];

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
function isAllCaps(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]{2,}$/.test(name);
}

/** Does this ALL_CAPS name read as a credential rather than as ordinary
 *  infrastructure? See CREDENTIAL_SEGMENTS for why the test is per-segment. */
function isCredentialShaped(name: string): boolean {
  for (const segment of name.split("_")) {
    if (CREDENTIAL_SEGMENTS.has(segment)) return true;
  }
  return CREDENTIAL_SUBSTRINGS.some((s) => name.includes(s));
}

export function detectMissingCredentials(stderrOrMessage: string | undefined): string[] {
  if (!stderrOrMessage) return [];
  const found = new Set<string>();
  for (const re of MISSING_PATTERNS) {
    for (const match of stderrOrMessage.matchAll(re)) {
      const name = match[1];
      if (name && isAllCaps(name) && isCredentialShaped(name) && !IGNORED.has(name)) found.add(name);
    }
  }
  return [...found];
}
