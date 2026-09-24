import { describe, expect, it } from "vitest";
import { detectMissingCredentials, isCredentialEnvName } from "../credentials.js";

// The classifier the elicitation path and upstream.ts's stderr redactor now
// share. Pinned directly (not just through detectMissingCredentials) because
// the redactor REPLACES the values it selects, so a false positive there
// mangles ordinary diagnostic output rather than merely popping a prompt.
describe("isCredentialEnvName", () => {
  it("accepts the credential names a shell actually exports", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "SLACK_BOTTOKEN",
      "YAW_MCP_VAULT_PASSPHRASE",
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });

  it("refuses the names a naive TOKEN|SECRET|PASS|KEY regex would mangle", () => {
    for (const name of [
      "BYPASS_CACHE",
      "COMPASS_HOME",
      "MONKEY_CAGE",
      "TOKENIZER_PATH",
      "SECRETARY_EMAIL",
      "API_URL",
      "PATH",
      "HOME",
      "SSH_AUTH_SOCK",
    ]) {
      expect(isCredentialEnvName(name), name).toBe(false);
    }
  });

  it("folds case, because an env var is not ALL_CAPS on Windows", () => {
    expect(isCredentialEnvName("github_token")).toBe(true);
    expect(isCredentialEnvName("Path")).toBe(false);
    // Folding must not turn a refused name into an accepted one.
    expect(isCredentialEnvName("Compass")).toBe(false);
    expect(isCredentialEnvName("ssh_key_path")).toBe(false);
  });

  it("refuses a name whose LAST segment is a locator, however credential-shaped its front", () => {
    // KEY / TOKEN / CREDENTIALS are whole segments in all of these, so the
    // segment test alone accepted them: a masked prompt for a file path, and
    // the redactor rewriting an inherited path wherever stderr printed it.
    for (const name of [
      "SSH_KEY_PATH",
      "API_KEY_PATH",
      "TLS_KEY_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "SECRETS_DIR",
      "TOKEN_BUCKET_SIZE",
      "REDIS_KEY_PREFIX",
      "VAULT_TOKEN_HOST",
      "VAULT_TOKEN_PORT",
    ]) {
      expect(isCredentialEnvName(name), name).toBe(false);
    }
  });

  it("keeps the credential names the locator rule must not reach", () => {
    for (const name of [
      // A connection string carries its password inline, so _URL / _URI are
      // not locators here.
      "REDIS_PASSWORD_URL",
      "MONGO_CREDENTIALS_URI",
      // ID is the other half of the key pair, not where the key lives.
      "AWS_ACCESS_KEY_ID",
      // Only the LAST segment counts.
      "PATH_TOKEN",
      "HOST_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });
});

describe("detectMissingCredentials", () => {
  it("returns empty for undefined or empty input", () => {
    expect(detectMissingCredentials(undefined)).toEqual([]);
    expect(detectMissingCredentials("")).toEqual([]);
  });

  it("matches 'X is required'", () => {
    expect(detectMissingCredentials("Error: GITHUB_TOKEN is required")).toEqual(["GITHUB_TOKEN"]);
  });

  it("matches 'missing env var X'", () => {
    expect(detectMissingCredentials("Missing env var OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
  });

  it("matches the colon / 'required' / 'environment' phrasings of that same line", () => {
    // These are the phrasings servers actually emit -- the first is this
    // module's own header example, and none of the three matched before the
    // colon, "required" and "environment" were tolerated.
    expect(detectMissingCredentials("Missing env var: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing environment variable: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing required env var OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
  });

  it("matches a colon directly after 'missing' or after 'env'", () => {
    // Only the var/variable group tolerated a colon; "Missing env: X" and
    // "missing: X" -- both common server phrasings -- matched nothing, because
    // the `\s+` after "missing" and after "env" had no room for one.
    expect(detectMissingCredentials("Missing env: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("missing: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing environment: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
  });

  it("matches the plural 'variables' / 'vars' of that same line", () => {
    // The trailing "s" defeated the var/variable group, so the name capture
    // took the word "variables" itself and isAllCaps dropped it.
    expect(detectMissingCredentials("Missing environment variables: OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing env vars: GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Missing required environment variables: OPENAI_API_KEY")).toEqual([
      "OPENAI_API_KEY",
    ]);
    // Only the first name of a list is captured; GITHUB_ORG would not be
    // credential-shaped anyway.
    expect(detectMissingCredentials("Missing environment variables: GITHUB_TOKEN, GITHUB_ORG")).toEqual([
      "GITHUB_TOKEN",
    ]);
    // The same line naming a non-credential still elicits nothing.
    expect(detectMissingCredentials("Missing environment variables: LOG_LEVEL")).toEqual([]);
  });

  it("does not eat a leading VAR out of the name itself", () => {
    // The var/variable group is optional, so it can match the NAME's own
    // first three letters. Without the mandatory whitespace after it, this
    // line elicits for "IANT_TOKEN" -- a name that does not exist.
    expect(detectMissingCredentials("Missing VARIANT_TOKEN")).toEqual(["VARIANT_TOKEN"]);
    // Same trap for the env/environment group now that a colon may follow it:
    // the group must not swallow the "ENV" of a name that starts with it.
    expect(detectMissingCredentials("Missing ENV_TOKEN")).toEqual(["ENV_TOKEN"]);
    // ...and for the plural: "vars" must not swallow the "VARS" of a name.
    expect(detectMissingCredentials("Missing VARS_TOKEN")).toEqual(["VARS_TOKEN"]);
  });

  it("matches 'X environment variable is required' and its env-var spellings", () => {
    // The words between the name and "is" made every pattern miss this, and
    // it is the exact line the Brave Search reference server prints.
    expect(detectMissingCredentials("Error: BRAVE_API_KEY environment variable is required")).toEqual([
      "BRAVE_API_KEY",
    ]);
    expect(detectMissingCredentials("GITHUB_TOKEN environment variable is required")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Error: GITHUB_TOKEN environment variable is not set")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("The GITHUB_TOKEN env var is not set")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("GITHUB_TOKEN environment variable must be set")).toEqual(["GITHUB_TOKEN"]);
    // The words are not a trigger on their own: the verb still has to say
    // the value is absent, and the name still has to read as a credential.
    expect(detectMissingCredentials("GITHUB_TOKEN environment variable is deprecated")).toEqual([]);
    expect(detectMissingCredentials("HOME environment variable is required")).toEqual([]);
  });

  it("matches 'Please set' with 'the' and the env / variable words in front of the name", () => {
    // Pattern 4 spelled its own env words -- "env", "env var", "env
    // variable", no "environment", no plural, no colon, no "the" -- so in
    // each of these the capture took the lowercase word itself ("environment",
    // "the", "var") and isAllCaps dropped it: no prompt at all.
    expect(detectMissingCredentials("Please set environment variable GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set the environment variable GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set the GITHUB_TOKEN environment variable")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set env var: GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    // The plural and the colon forms pattern 1 accepts, read from the same
    // shared words.
    expect(detectMissingCredentials("Please set environment variables: GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set the env vars GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set env: GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set the 'GITHUB_TOKEN' environment variable")).toEqual(["GITHUB_TOKEN"]);
    // The phrasings that already matched still do.
    expect(detectMissingCredentials("Please set GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set env var GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set env variable GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
  });

  it("does not let a leading 'the' or env word eat the front of a 'Please set' name", () => {
    // Every leading word is optional and case-insensitive, so each can match
    // the first letters of the NAME. The mandatory gap after each word is what
    // keeps these whole instead of reporting "IANT_TOKEN" or "_TOKEN".
    expect(detectMissingCredentials("Please set VARIANT_TOKEN")).toEqual(["VARIANT_TOKEN"]);
    expect(detectMissingCredentials("Please set THE_TOKEN")).toEqual(["THE_TOKEN"]);
    expect(detectMissingCredentials("Please set ENV_TOKEN")).toEqual(["ENV_TOKEN"]);
    expect(detectMissingCredentials("Please set ENVIRONMENT_TOKEN")).toEqual(["ENVIRONMENT_TOKEN"]);
    expect(detectMissingCredentials("Please set VARS_TOKEN")).toEqual(["VARS_TOKEN"]);
    expect(detectMissingCredentials("Please set the THE_TOKEN")).toEqual(["THE_TOKEN"]);
    expect(detectMissingCredentials("Please set env var VARIANT_TOKEN")).toEqual(["VARIANT_TOKEN"]);
  });

  it("asks for nothing when 'Please set' names a non-credential, and crosses a line only after a colon", () => {
    // The new words widen WHERE a name is found, not WHICH names elicit.
    expect(detectMissingCredentials("Please set LOG_LEVEL")).toEqual([]);
    expect(detectMissingCredentials("Please set the LOG_LEVEL environment variable")).toEqual([]);
    expect(detectMissingCredentials("Please set environment variable LOG_LEVEL")).toEqual([]);
    expect(detectMissingCredentials("Please set the SSH_KEY_PATH environment variable")).toEqual([]);
    // "the" is followed by a same-line gap, never a line break...
    expect(detectMissingCredentials("Please set the\nGITHUB_TOKEN")).toEqual([]);
    // ...while a colon after an env word introduces a list, as in pattern 1.
    expect(detectMissingCredentials("Please set env var:\n  GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN"]);
  });

  it("stays linear on long pathological input around the 'Please set' words", () => {
    // Each probe is a 100 KB run pattern 4's optional words and gaps must
    // backtrack across before it settles on no credential: a lowercase word
    // or a non-credential name the ALL_CAPS / credential filter then drops,
    // or no match at all. A pattern that put two
    // quantifiers able to match the same whitespace next to each other would
    // try every split of the run, which is quadratic in its length. The
    // trailing phrase must still be found: that proves the scan got to the
    // end of the input instead of giving up early, so the timing is not
    // vacuous.
    const n = 100_000;
    const tail = "\nPlease set the environment variable GITHUB_TOKEN";
    const probes: [string, string][] = [
      ["spaces after set", `Please set${" ".repeat(n)}!`],
      ["tabs and spaces after the", `Please set the${" \t".repeat(n / 2)}!`],
      ["line breaks after env:", `Please set env:${" \n".repeat(n / 2)}!`],
      ["spaces before a colon after var", `Please set env var${" ".repeat(n)}:!`],
      ["repeated leading words", `Please set ${"the env var: ".repeat(n / 13)}!`],
      ["repeated phrase", `${"Please set the environment variables: ".repeat(n / 38)}!`],
      ["long name-shaped run", `Please set the environment variable ${"A".repeat(n)}!`],
    ];
    // Warm-up, so the first timed run does not also pay for compiling the
    // patterns.
    detectMissingCredentials(tail);
    for (const [label, body] of probes) {
      const t0 = performance.now();
      const found = detectMissingCredentials(body + tail);
      const elapsed = performance.now() - t0;
      // Measured standalone on a Windows ARM64 box: 0.5-3.5 ms per probe for
      // all five patterns. This file runs in the parallel "unit" project (see
      // vitest.config.ts), where a run can be ~4x oversubscribed, so the
      // budget leaves ~300x headroom over the linear cost. A second optional
      // gap placed straight after pattern 4's gap after "set" took ~18 s on
      // the first probe alone.
      expect(elapsed, label).toBeLessThan(1000);
      expect(found, label).toEqual(["GITHUB_TOKEN"]);
    }
  });

  it("matches a name wrapped in quotes or backticks, without the quote joining the name", () => {
    expect(detectMissingCredentials("`GITHUB_TOKEN` is required")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("'GITHUB_TOKEN' is not set")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials('"GITHUB_TOKEN" must be set')).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Missing env var 'GITHUB_TOKEN'")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("Please set `GITHUB_TOKEN`")).toEqual(["GITHUB_TOKEN"]);
    // A quote is not a trigger: the rest of the phrase still has to match.
    expect(detectMissingCredentials("'GITHUB_TOKEN' is valid")).toEqual([]);
    expect(detectMissingCredentials("Missing env var 'VALUE'")).toEqual([]);
    expect(detectMissingCredentials("`NODE_ENV` is not set")).toEqual([]);
  });

  it("matches 'not set' / 'unset' / 'not provided' without 'is', and 'No X provided'", () => {
    expect(detectMissingCredentials("env var SLACK_BOT_TOKEN not set")).toEqual(["SLACK_BOT_TOKEN"]);
    expect(detectMissingCredentials("GITHUB_TOKEN not set")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("GITHUB_TOKEN unset")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("GITHUB_TOKEN is not provided")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("No GITHUB_TOKEN provided")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("No GITHUB_TOKEN environment variable set")).toEqual(["GITHUB_TOKEN"]);
    // These phrasings widen WHERE a name is found, not WHICH names elicit: a
    // non-credential name in the same line still asks for nothing.
    expect(detectMissingCredentials("env var LOG_LEVEL not set")).toEqual([]);
    expect(detectMissingCredentials("NODE_ENV unset")).toEqual([]);
    expect(detectMissingCredentials("DATABASE_HOST not provided")).toEqual([]);
    expect(detectMissingCredentials("No CONFIG provided")).toEqual([]);
    expect(detectMissingCredentials("No SSH_KEY_PATH provided")).toEqual([]);
    // The verb has to end where the word does, and "No" needs a verb at all.
    expect(detectMissingCredentials("GITHUB_TOKEN unsettled")).toEqual([]);
    expect(detectMissingCredentials("GITHUB_TOKEN not settable")).toEqual([]);
    expect(detectMissingCredentials("No GITHUB_TOKEN rotation needed")).toEqual([]);
  });

  it("still requires 'is' before required / missing, and never treats 'is not defined' as missing", () => {
    // Without "is", these words describe something other than an absent
    // value, and prompting would ask for a key the server already has.
    expect(detectMissingCredentials("GITHUB_TOKEN required scopes: repo, read:org")).toEqual([]);
    expect(detectMissingCredentials("OPENAI_API_KEY missing permissions for this model")).toEqual([]);
    // "No" is what makes "provided" a complaint.
    expect(detectMissingCredentials("GITHUB_TOKEN provided")).toEqual([]);
    // The JS ReferenceError shape is a crash, not a missing credential.
    expect(detectMissingCredentials("ReferenceError: GITHUB_TOKEN is not defined")).toEqual([]);
  });

  it("does not carry a phrase across a line break, except after a colon", () => {
    // A line that merely ENDS in "missing" used to claim the credential-shaped
    // name at the start of the NEXT line, whatever that line said about it.
    expect(detectMissingCredentials("sourcemap is missing\nOPENAI_API_KEY loaded from vault")).toEqual([]);
    expect(detectMissingCredentials("Missing\nGITHUB_TOKEN")).toEqual([]);
    expect(detectMissingCredentials("Missing\r\nGITHUB_TOKEN")).toEqual([]);
    // The is-less "unset" would otherwise pair a name ending one line with a
    // shell trace starting the next.
    expect(detectMissingCredentials("export OPENAI_API_KEY\nunset DEBUG")).toEqual([]);
    // A colon introduces a list, and the list form keeps eliciting.
    expect(detectMissingCredentials("Missing:\n  OPENAI_API_KEY")).toEqual(["OPENAI_API_KEY"]);
    expect(detectMissingCredentials("Missing required environment variables:\r\n  OPENAI_API_KEY")).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("matches 'X is not set'", () => {
    expect(detectMissingCredentials("ANTHROPIC_API_KEY is not set")).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("dedupes across multiple matches", () => {
    expect(detectMissingCredentials("GITHUB_TOKEN is required. Please set GITHUB_TOKEN env variable.")).toEqual([
      "GITHUB_TOKEN",
    ]);
  });

  it("finds multiple distinct credentials", () => {
    const out = detectMissingCredentials("GITHUB_TOKEN is required. NPM_TOKEN must be set.");
    expect(out.sort()).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
  });

  it("ignores system env vars", () => {
    expect(detectMissingCredentials("PATH is not set")).toEqual([]);
    expect(detectMissingCredentials("HOME is required")).toEqual([]);
    // Which LAYER refuses these matters, because on its own the pair above
    // cannot tell: PATH and HOME fail isCredentialShaped before IGNORED is
    // consulted, and every current IGNORED entry is also non-credential-
    // shaped, so no input isolates the deny-list (it is the belt to that
    // braces -- it keeps refusing them if the shape test is ever relaxed).
    // So pin the layer that IS load-bearing here: the same PATH prefix
    // elicits the moment the name carries a credential segment, proving the
    // refusal above is about the SHAPE of "PATH", not a substring ban.
    expect(detectMissingCredentials("PATH_TOKEN is not set")).toEqual(["PATH_TOKEN"]);
  });

  it("ignores lowercase names", () => {
    expect(detectMissingCredentials("token is required")).toEqual([]);
  });

  it("requires at least 3 characters to skip short false positives", () => {
    expect(detectMissingCredentials("X is required")).toEqual([]);
    // Pin the floor from the ACCEPTING side too, which is the only side this
    // rule can be isolated on: "PAT" is the shortest credential-shaped name
    // there is and it is exactly 3 characters, so tightening the {2,}
    // quantifier would silently drop a real credential. (Loosening it cannot
    // be caught here -- anything short enough to fail the quantifier also
    // fails isCredentialShaped.)
    expect(detectMissingCredentials("PAT is required")).toEqual(["PAT"]);
  });
});

// A failing server's stderr decides which names the user is elicited for, so
// a name has to READ as a credential -- not merely be ALL_CAPS. Before this,
// any capitalised word in a failure line produced a secret prompt.
describe("detectMissingCredentials -- only credential-shaped names elicit", () => {
  it("ignores infrastructure variables that merely contain AUTH", () => {
    expect(detectMissingCredentials("SSH_AUTH_SOCK is not set")).toEqual([]);
  });

  it("ignores English words shouted in a failure line", () => {
    expect(detectMissingCredentials("ERROR is undefined")).toEqual([]);
    expect(detectMissingCredentials("CONFIG is required")).toEqual([]);
    expect(detectMissingCredentials("Missing env var VALUE")).toEqual([]);
  });

  it("still elicits for the real credential shapes", () => {
    expect(detectMissingCredentials("GITHUB_TOKEN is required")).toEqual(["GITHUB_TOKEN"]);
    expect(detectMissingCredentials("AWS_SECRET_ACCESS_KEY must be set")).toEqual(["AWS_SECRET_ACCESS_KEY"]);
    expect(detectMissingCredentials("Missing env var GITHUBTOKEN")).toEqual(["GITHUBTOKEN"]);
    expect(detectMissingCredentials("STRIPE_API_KEY is empty")).toEqual(["STRIPE_API_KEY"]);
  });

  it("does not match a credential word buried inside a longer segment", () => {
    // MONKEY_CAGE contains "KEY" as a substring but not as a segment.
    expect(detectMissingCredentials("MONKEY_CAGE is not set")).toEqual([]);
  });

  it("does not apply the substring fallback to a name that has underscores", () => {
    // The fallback exists for names the segment split cannot see into
    // (GITHUBTOKEN). Applied to every name, it made "TOKENIZER_PATH is
    // required" pop a secret prompt for a file path: "TOKEN" is a whole word
    // in the list, but it is also the head of an ordinary one.
    expect(detectMissingCredentials("TOKENIZER_PATH is required")).toEqual([]);
    expect(detectMissingCredentials("SECRETARY_EMAIL is not set")).toEqual([]);
    // ...while the underscore-free shapes the fallback exists for still elicit.
    expect(detectMissingCredentials("Missing env var GITHUBTOKEN")).toEqual(["GITHUBTOKEN"]);
    expect(detectMissingCredentials("MYPASSWORD is required")).toEqual(["MYPASSWORD"]);
  });

  it("elicits for an underscored compound segment that ENDS in a credential noun", () => {
    // The underscore gate above refused every underscored name whose
    // credential word was glued into a longer segment, so these three -- all
    // of which the substring test had caught before the gate -- stopped
    // eliciting the day TOKENIZER_PATH was fixed.
    expect(detectMissingCredentials("S3_SECRETKEY is required")).toEqual(["S3_SECRETKEY"]);
    expect(detectMissingCredentials("SLACK_BOTTOKEN is not set")).toEqual(["SLACK_BOTTOKEN"]);
    expect(detectMissingCredentials("Missing env var OAUTH_CLIENTSECRET")).toEqual(["OAUTH_CLIENTSECRET"]);
    expect(detectMissingCredentials("DB_PASSWORDS must be set")).toEqual(["DB_PASSWORDS"]);
    // A compound the set does not list still elicits on its suffix; AUTH on
    // its own is deliberately not a credential segment (SSH_AUTH_SOCK), but
    // AUTHTOKEN ends in TOKEN.
    expect(detectMissingCredentials("MY_AUTHTOKEN is required")).toEqual(["MY_AUTHTOKEN"]);
    // Suffix, not substring: the noun at the HEAD of a segment is an
    // ordinary word, and these must keep refusing.
    expect(detectMissingCredentials("TOKENIZER_PATH is required")).toEqual([]);
    expect(detectMissingCredentials("SECRETARY_EMAIL is not set")).toEqual([]);
    // KEY is kept off the suffix rule: English words end in it. -KEY
    // compounds are enumerated instead (SECRETKEY above).
    expect(detectMissingCredentials("MONKEY_CAGE is not set")).toEqual([]);
    expect(detectMissingCredentials("TURKEY_MODE is required")).toEqual([]);
  });

  it("does not elicit for API_* configuration that is not a key", () => {
    // A bare "API" segment made every API_* name credential-shaped, so an
    // endpoint URL popped a secret prompt -- exactly the false-positive class
    // the segment filter exists to stop.
    expect(detectMissingCredentials("API_URL is not set")).toEqual([]);
    expect(detectMissingCredentials("API_HOST is required")).toEqual([]);
    expect(detectMissingCredentials("Missing env var API_BASE")).toEqual([]);
    // ...and dropping it costs nothing: a real key still elicits on its KEY
    // segment, with or without the API_ prefix.
    expect(detectMissingCredentials("API_KEY is required")).toEqual(["API_KEY"]);
    expect(detectMissingCredentials("OPENAI_API_KEY is not set")).toEqual(["OPENAI_API_KEY"]);
  });

  it("does not elicit for a locator that merely names a credential (SSH_KEY_PATH)", () => {
    // Same false-positive class as TOKENIZER_PATH, reached through a whole
    // KEY / TOKEN segment instead of the substring fallback.
    expect(detectMissingCredentials("SSH_KEY_PATH is required")).toEqual([]);
    expect(detectMissingCredentials("TLS_KEY_FILE is not set")).toEqual([]);
    expect(detectMissingCredentials("TOKEN_BUCKET_SIZE is required")).toEqual([]);
    expect(detectMissingCredentials("Missing environment variable: AWS_SHARED_CREDENTIALS_FILE")).toEqual([]);
    // ...while the credential itself, and its _ID half, still elicit.
    expect(detectMissingCredentials("SSH_KEY is required")).toEqual(["SSH_KEY"]);
    expect(detectMissingCredentials("AWS_ACCESS_KEY_ID is required")).toEqual(["AWS_ACCESS_KEY_ID"]);
  });
});
