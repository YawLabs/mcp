import { describe, expect, it } from "vitest";
import { envEqual, resolveNamespaces, sanitizeNamespace } from "../server.js";

// These three helpers are exported from server.ts so the tests exercise the
// REAL implementations. They used to be module-private, and this file kept
// hand-copied re-implementations of each one -- which passed happily while
// the production code drifted, since nothing tied the copy to the original.

describe("envEqual", () => {
  it("returns true for both undefined", () => {
    expect(envEqual(undefined, undefined)).toBe(true);
  });

  it("returns false for one undefined", () => {
    expect(envEqual({ A: "1" }, undefined)).toBe(false);
    expect(envEqual(undefined, { A: "1" })).toBe(false);
  });

  it("returns true for identical objects", () => {
    expect(envEqual({ A: "1", B: "2" }, { A: "1", B: "2" })).toBe(true);
  });

  it("returns true for same keys in different order", () => {
    const a = { A: "1", B: "2" };
    const b = { B: "2", A: "1" };
    expect(envEqual(a, b)).toBe(true);
  });

  it("returns false for different values", () => {
    expect(envEqual({ A: "1" }, { A: "2" })).toBe(false);
  });

  it("returns false for different key counts", () => {
    expect(envEqual({ A: "1" }, { A: "1", B: "2" })).toBe(false);
  });

  it("returns false when a has key not in b", () => {
    expect(envEqual({ A: "1", C: "3" }, { A: "1", B: "2" })).toBe(false);
  });

  it("returns true for empty objects", () => {
    expect(envEqual({}, {})).toBe(true);
  });
});

describe("resolveNamespaces", () => {
  it("returns single server as array", () => {
    expect(resolveNamespaces({ server: "gh" })).toEqual(["gh"]);
  });

  it("returns servers array", () => {
    expect(resolveNamespaces({ servers: ["gh", "slack"] })).toEqual(["gh", "slack"]);
  });

  it("prefers servers over server", () => {
    expect(resolveNamespaces({ server: "gh", servers: ["slack", "stripe"] })).toEqual(["slack", "stripe"]);
  });

  it("returns empty for no args", () => {
    expect(resolveNamespaces({})).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(resolveNamespaces({ server: "" })).toEqual([]);
  });

  it("returns empty for empty array", () => {
    expect(resolveNamespaces({ servers: [] })).toEqual([]);
  });

  it("ignores a non-string server value", () => {
    expect(resolveNamespaces({ server: 42 })).toEqual([]);
  });
});

describe("sanitizeNamespace", () => {
  it("lowercases and replaces special chars", () => {
    expect(sanitizeNamespace("My GitHub Server")).toBe("my_github_server");
  });

  it("strips leading/trailing underscores", () => {
    expect(sanitizeNamespace("---MCP---")).toBe("mcp");
  });

  it("truncates to 30 characters", () => {
    const long = "a".repeat(50);
    expect(sanitizeNamespace(long).length).toBe(30);
  });

  it("returns empty for all-special-char names", () => {
    expect(sanitizeNamespace("!!!")).toBe("");
  });

  it("detects collisions", () => {
    expect(sanitizeNamespace("Server A")).toBe(sanitizeNamespace("Server-A"));
  });
});
