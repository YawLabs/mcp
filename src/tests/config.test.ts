import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { NAMESPACE_RE } from "../local-bundles.js";

describe("ConfigError", () => {
  it("has fatal property", () => {
    const err = new ConfigError("bad token", true);
    expect(err.fatal).toBe(true);
    expect(err.message).toBe("bad token");
    expect(err.name).toBe("ConfigError");
  });

  it("non-fatal error", () => {
    const err = new ConfigError("network issue", false);
    expect(err.fatal).toBe(false);
    expect(err instanceof Error).toBe(true);
  });
});

describe("namespace validation regex", () => {
  it("accepts valid namespaces", () => {
    expect(NAMESPACE_RE.test("gh")).toBe(true);
    expect(NAMESPACE_RE.test("slack")).toBe(true);
    expect(NAMESPACE_RE.test("my_server_1")).toBe(true);
    expect(NAMESPACE_RE.test("a")).toBe(true);
  });

  it("rejects namespaces starting with number", () => {
    expect(NAMESPACE_RE.test("1server")).toBe(false);
  });

  it("rejects namespaces starting with underscore", () => {
    expect(NAMESPACE_RE.test("_server")).toBe(false);
  });

  it("rejects namespaces with uppercase", () => {
    expect(NAMESPACE_RE.test("GitHub")).toBe(false);
  });

  it("rejects namespaces with special characters", () => {
    expect(NAMESPACE_RE.test("my-server")).toBe(false);
    expect(NAMESPACE_RE.test("my.server")).toBe(false);
    expect(NAMESPACE_RE.test("my/server")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(NAMESPACE_RE.test("")).toBe(false);
  });

  it("rejects namespaces longer than 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(31))).toBe(false);
  });

  it("accepts exactly 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(30))).toBe(true);
  });
});
