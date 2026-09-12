// The alias table itself. One literal -- the alias IDS -- lives here, for the
// same reason the append-order literal lives in client-config-boundary.test.ts:
// every other list in the codebase derives from `clientChoices`, so without one
// spelled-out expectation an alias could be renamed, re-pointed at another
// client, or dropped with the whole suite green.

import { describe, expect, it } from "vitest";
import { aliasTableProblems, CLIENT_ALIASES, clientChoices, resolveClientArg } from "../client-aliases.js";
import { INSTALL_TARGETS } from "../install-targets.js";

describe("the alias table", () => {
  it("declares exactly these aliases, pointing where they say", () => {
    expect(CLIENT_ALIASES.map((a) => a.id)).toEqual(["mcp"]);
    expect(CLIENT_ALIASES.map((a) => [a.id, a.clientId, a.scope])).toEqual([["mcp", "claude-code", "project"]]);
  });

  it("is well formed: no collision with a real client, no duplicate, no dangling row", () => {
    expect(aliasTableProblems()).toEqual([]);
  });

  it("gives every alias a label a help line can print", () => {
    for (const alias of CLIENT_ALIASES) {
      expect(alias.label.length, alias.id).toBeGreaterThan(10);
    }
  });
});

describe("resolving a <client> argument", () => {
  it("resolves the alias to its client AND its pinned scope", () => {
    // The scope is what makes `mcp` mean the repo's `.mcp.json` rather than
    // ~/.claude.json. A caller applies it as a DEFAULT, so an explicit
    // --scope beside it still wins -- that half is resolveClientArg's
    // contract and is asserted by the install/import parsers.
    expect(resolveClientArg("install", "mcp")).toEqual({ clientId: "claude-code", scope: "project", via: "mcp" });
    expect(resolveClientArg("uninstall", "mcp")?.clientId).toBe("claude-code");
    expect(resolveClientArg("import", "mcp")?.clientId).toBe("claude-code");
  });

  it("does NOT offer an alias to `try`", () => {
    // `try` picks a client by probing slots; a second name for a slot it
    // already probes would let one file be trialled twice.
    expect(resolveClientArg("try", "mcp")).toBeNull();
    expect(clientChoices("try")).toEqual(INSTALL_TARGETS.map((t) => t.clientId));
  });

  it("lists the aliases LAST, after every real client in table order", () => {
    const choices = clientChoices("install");
    expect(choices.slice(0, INSTALL_TARGETS.length)).toEqual(INSTALL_TARGETS.map((t) => t.clientId));
    expect(choices.slice(INSTALL_TARGETS.length)).toEqual(CLIENT_ALIASES.map((a) => a.id));
  });

  it("still resolves a canonical id, and rejects a name that is neither", () => {
    expect(resolveClientArg("install", "claude-code")).toEqual({ clientId: "claude-code", via: null });
    expect(resolveClientArg("install", "not-a-client")).toBeNull();
  });
});
