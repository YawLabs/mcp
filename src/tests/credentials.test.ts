import { describe, expect, it } from "vitest";
import { detectMissingCredentials } from "../credentials.js";

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

  it("does not eat a leading VAR out of the name itself", () => {
    // The var/variable group is optional, so it can match the NAME's own
    // first three letters. Without the mandatory whitespace after it, this
    // line elicits for "IANT_TOKEN" -- a name that does not exist.
    expect(detectMissingCredentials("Missing VARIANT_TOKEN")).toEqual(["VARIANT_TOKEN"]);
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
});
