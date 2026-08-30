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
  });

  it("ignores lowercase names", () => {
    expect(detectMissingCredentials("token is required")).toEqual([]);
  });

  it("requires at least 3 characters to skip short false positives", () => {
    expect(detectMissingCredentials("X is required")).toEqual([]);
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
});
