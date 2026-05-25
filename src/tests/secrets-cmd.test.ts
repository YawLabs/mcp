import { describe, expect, it } from "vitest";
import { SECRETS_USAGE, parseSecretsArgs } from "../secrets-cmd.js";

describe("parseSecretsArgs", () => {
  it("rejects missing action", () => {
    const r = parseSecretsArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing action/);
  });

  it("rejects unknown action", () => {
    const r = parseSecretsArgs(["nuke"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown action "nuke"/);
  });

  it("set requires a name", () => {
    const r = parseSecretsArgs(["set"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/<name> is required/);
  });

  it("set <name> parses", () => {
    const r = parseSecretsArgs(["set", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("set");
      expect(r.options.name).toBe("github");
    }
  });

  it("set <name> --value v parses inline", () => {
    const r = parseSecretsArgs(["set", "github", "--value", "ghp_abc"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.value).toBe("ghp_abc");
    }
  });

  it("set <name> --stdin parses", () => {
    const r = parseSecretsArgs(["set", "github", "--stdin"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.fromStdin).toBe(true);
  });

  it("get <name> parses", () => {
    const r = parseSecretsArgs(["get", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("get");
      expect(r.options.name).toBe("github");
    }
  });

  it("list does not need a name", () => {
    const r = parseSecretsArgs(["list"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("list");
  });

  it("remove requires a name", () => {
    const r = parseSecretsArgs(["remove"]);
    expect(r.ok).toBe(false);
  });

  it("lock parses with no name", () => {
    const r = parseSecretsArgs(["lock"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("lock");
  });

  it("--json applies", () => {
    const r = parseSecretsArgs(["list", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("--help returns usage", () => {
    const r = parseSecretsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(SECRETS_USAGE);
  });

  it("rejects --value without arg", () => {
    const r = parseSecretsArgs(["set", "github", "--value"]);
    expect(r.ok).toBe(false);
  });

  it("rejects extra positional", () => {
    const r = parseSecretsArgs(["set", "github", "extra"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unexpected positional/);
  });

  it("rejects unknown flag", () => {
    const r = parseSecretsArgs(["list", "--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag "--bogus"/);
  });

  it("push action parses without a name", () => {
    const r = parseSecretsArgs(["push"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("push");
  });

  it("pull action parses without a name", () => {
    const r = parseSecretsArgs(["pull"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("pull");
  });
});
