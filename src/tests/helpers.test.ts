import { describe, expect, it } from "vitest";
import { resolveNamespaces } from "../server.js";

// These helpers are exported from server.ts so the tests exercise the
// REAL implementations. They used to be module-private, and this file kept
// hand-copied re-implementations of each one -- which passed happily while
// the production code drifted, since nothing tied the copy to the original.

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

  it("filters an all-junk servers array then falls through to a valid single server", () => {
    // The `servers` array is present but every element is non-string
    // junk, so it filters to [] and does NOT short-circuit — the resolver
    // falls through to the usable single `server` form.
    expect(resolveNamespaces({ servers: [1, null, ""], server: "gh" })).toEqual(["gh"]);
  });

  it("yields no namespaces for an all-invalid servers array with no server", () => {
    // Present-but-all-invalid `servers` filters to [] and there is no
    // single `server` to fall back on — the resolver returns [].
    expect(resolveNamespaces({ servers: [1, null, ""] })).toEqual([]);
  });
});
