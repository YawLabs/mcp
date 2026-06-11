import { describe, expect, it } from "vitest";

import {
  MAX_EXEC_STEPS,
  RefError,
  isRefNode,
  parseRefPath,
  resolveArgs,
  resolveRef,
  stepBindingKey,
  validateExecRequest,
} from "../exec-engine.js";

describe("exec-engine: parseRefPath", () => {
  it("parses a bare step id", () => {
    expect(parseRefPath("stepA")).toEqual(["stepA"]);
  });

  it("parses dot-separated keys", () => {
    expect(parseRefPath("stepA.content.text")).toEqual(["stepA", "content", "text"]);
  });

  it("parses bracket indices", () => {
    expect(parseRefPath("stepA.content[0].text")).toEqual(["stepA", "content", 0, "text"]);
  });

  it("canonicalizes dot-numeric to numeric indices (except step id)", () => {
    expect(parseRefPath("stepA.0.text")).toEqual(["stepA", 0, "text"]);
  });

  it("keeps step id as string even if it looks numeric", () => {
    const parsed = parseRefPath("42.foo");
    expect(parsed).toEqual(["42", "foo"]);
    expect(typeof (parsed ?? [])[0]).toBe("string");
  });

  it("rejects empty path", () => {
    expect(parseRefPath("")).toBeNull();
  });

  it("rejects leading dot", () => {
    expect(parseRefPath(".foo")).toBeNull();
  });

  it("rejects unbalanced brackets", () => {
    expect(parseRefPath("foo[0")).toBeNull();
  });

  it("rejects non-numeric bracket contents", () => {
    expect(parseRefPath("foo[bar]")).toBeNull();
  });

  it("rejects empty brackets", () => {
    expect(parseRefPath("foo[]")).toBeNull();
  });

  it("rejects double dots", () => {
    expect(parseRefPath("foo..bar")).toBeNull();
  });

  it("rejects bare identifier glued to closing bracket (foo[0]bar)", () => {
    // exec-engine.ts:68 -- after ']', the next char must be '.', '[', or EOS.
    // A bare identifier immediately following ']' is malformed.
    expect(parseRefPath("foo[0]bar")).toBeNull();
  });
});

describe("exec-engine: isRefNode", () => {
  it("recognizes a simple $ref node", () => {
    expect(isRefNode({ $ref: "stepA" })).toBe(true);
  });

  it("rejects node with extra keys alongside $ref", () => {
    expect(isRefNode({ $ref: "stepA", default: "x" })).toBe(false);
  });

  it("rejects node where $ref is not a string", () => {
    expect(isRefNode({ $ref: 42 })).toBe(false);
  });

  it("rejects arrays and primitives", () => {
    expect(isRefNode(["$ref"])).toBe(false);
    expect(isRefNode("stepA")).toBe(false);
    expect(isRefNode(null)).toBe(false);
  });
});

describe("exec-engine: resolveRef", () => {
  const bindings: Record<string, unknown> = {
    stepA: {
      content: [{ type: "text", text: "hello" }],
      count: 42,
    },
    stepB: "bare-string",
  };

  it("returns the whole step output for a bare id", () => {
    expect(resolveRef("stepA", bindings)).toEqual(bindings.stepA);
  });

  it("resolves nested object paths", () => {
    expect(resolveRef("stepA.count", bindings)).toBe(42);
  });

  it("resolves array indexing", () => {
    expect(resolveRef("stepA.content[0].text", bindings)).toBe("hello");
  });

  it("throws RefError on unknown step id", () => {
    expect(() => resolveRef("stepZ", bindings)).toThrow(RefError);
  });

  it("throws RefError on missing property", () => {
    expect(() => resolveRef("stepA.nope", bindings)).toThrow(/no property "nope"/);
  });

  it("throws RefError on out-of-range array index", () => {
    expect(() => resolveRef("stepA.content[5]", bindings)).toThrow(/out of range/);
  });

  it("throws RefError when drilling into a primitive", () => {
    expect(() => resolveRef("stepB.foo", bindings)).toThrow(/non-object/);
  });

  it("throws RefError on malformed path", () => {
    expect(() => resolveRef("stepA..foo", bindings)).toThrow(/malformed path/);
  });
});

describe("exec-engine: resolveArgs", () => {
  const bindings: Record<string, unknown> = {
    stepA: {
      issue: { number: 7, title: "login bug" },
      labels: ["bug", "P1"],
    },
  };

  it("passes primitive args through unchanged", () => {
    expect(resolveArgs(42, bindings)).toBe(42);
    expect(resolveArgs("hello", bindings)).toBe("hello");
    expect(resolveArgs(null, bindings)).toBeNull();
    expect(resolveArgs(undefined, bindings)).toBeUndefined();
    expect(resolveArgs(true, bindings)).toBe(true);
  });

  it("replaces a simple top-level $ref", () => {
    expect(resolveArgs({ $ref: "stepA.issue.number" }, bindings)).toBe(7);
  });

  it("resolves refs inside a shallow object", () => {
    const resolved = resolveArgs(
      {
        number: { $ref: "stepA.issue.number" },
        note: "manual",
      },
      bindings,
    );
    expect(resolved).toEqual({ number: 7, note: "manual" });
  });

  it("resolves refs nested deeply in the args tree", () => {
    const resolved = resolveArgs(
      {
        payload: {
          target: {
            issue: { $ref: "stepA.issue.number" },
            meta: { source: "exec" },
          },
        },
      },
      bindings,
    );
    expect(resolved).toEqual({
      payload: {
        target: {
          issue: 7,
          meta: { source: "exec" },
        },
      },
    });
  });

  it("resolves multiple refs in one args object", () => {
    const resolved = resolveArgs(
      {
        number: { $ref: "stepA.issue.number" },
        title: { $ref: "stepA.issue.title" },
        firstLabel: { $ref: "stepA.labels[0]" },
      },
      bindings,
    );
    expect(resolved).toEqual({
      number: 7,
      title: "login bug",
      firstLabel: "bug",
    });
  });

  it("walks arrays and resolves refs inside them", () => {
    const resolved = resolveArgs(
      [{ $ref: "stepA.issue.number" }, "literal", { inner: { $ref: "stepA.labels[1]" } }],
      bindings,
    );
    expect(resolved).toEqual([7, "literal", { inner: "P1" }]);
  });

  it("does not mutate the input args", () => {
    const input = { issue: { $ref: "stepA.issue.number" }, keep: "me" };
    const snapshot = JSON.parse(JSON.stringify(input));
    resolveArgs(input, bindings);
    expect(input).toEqual(snapshot);
  });

  it("propagates RefError with the bad ref string", () => {
    try {
      resolveArgs({ x: { $ref: "stepA.missing" } }, bindings);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RefError);
      expect((err as RefError).detail.ref).toBe("stepA.missing");
    }
  });

  it("does not treat $ref-plus-extras as a ref node", () => {
    // Must behave as a plain object, not a ref — the `default` would
    // silently mask a programmer intent error otherwise.
    const resolved = resolveArgs({ $ref: "stepA.issue.number", default: 0 }, bindings) as Record<string, unknown>;
    expect(resolved.default).toBe(0);
    expect(resolved.$ref).toBe("stepA.issue.number");
  });
});

describe("exec-engine: validateExecRequest", () => {
  it("accepts a minimal valid request", () => {
    const r = validateExecRequest({ steps: [{ tool: "gh_list_prs" }] });
    expect(r.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    const r = validateExecRequest([{ tool: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("must be an object");
  });

  it("rejects missing steps", () => {
    const r = validateExecRequest({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("must be an array");
  });

  it("rejects empty steps array", () => {
    const r = validateExecRequest({ steps: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("at least one");
  });

  it("rejects steps exceeding the hard cap", () => {
    const steps = Array.from({ length: MAX_EXEC_STEPS + 1 }, () => ({ tool: "t" }));
    const r = validateExecRequest({ steps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("too many steps");
  });

  it("rejects duplicate step ids", () => {
    const r = validateExecRequest({
      steps: [
        { id: "a", tool: "x" },
        { id: "a", tool: "y" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("duplicate");
  });

  it("rejects step without tool", () => {
    const r = validateExecRequest({ steps: [{ id: "a" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("`tool`");
  });

  it("rejects return that points at an unknown step", () => {
    const r = validateExecRequest({
      steps: [{ id: "a", tool: "x" }],
      return: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unknown step id");
  });

  it("accepts a valid return pointer", () => {
    const r = validateExecRequest({
      steps: [
        { id: "a", tool: "x" },
        { id: "b", tool: "y" },
      ],
      return: "a",
    });
    expect(r.ok).toBe(true);
  });

  it("fix#1: accepts return pointing at a positional index for an unnamed step", () => {
    // Steps without an explicit id bind under String(index) ("0", "1", ...).
    // validateExecRequest was only tracking explicit ids, so `return: "0"`
    // for an unnamed step always failed with 'unknown step id'.
    const r = validateExecRequest({
      steps: [{ tool: "x" }, { tool: "y" }],
      return: "1",
    });
    expect(r.ok).toBe(true);
  });

  it("fix#1: rejects return pointing at a position that is out of range", () => {
    const r = validateExecRequest({
      steps: [{ tool: "x" }],
      return: "5",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unknown step id");
  });

  it("rejects a step whose args is an array (Array.isArray guard at exec-engine.ts:247)", () => {
    // args must be a plain object when provided; an array must be rejected.
    const r = validateExecRequest({ steps: [{ tool: "t", args: [] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("`args` must be an object");
  });

  it("fix#1: positional keys do not shadow explicit ids -- both are valid targets", () => {
    // Mix: step 0 has no id (binds as "0"); step 1 has id "b".
    // return: "0" should be valid (positional), return: "b" also valid (explicit).
    const r0 = validateExecRequest({
      steps: [{ tool: "x" }, { id: "b", tool: "y" }],
      return: "0",
    });
    expect(r0.ok).toBe(true);
    const rb = validateExecRequest({
      steps: [{ tool: "x" }, { id: "b", tool: "y" }],
      return: "b",
    });
    expect(rb.ok).toBe(true);
  });
});

describe("exec-engine: stepBindingKey", () => {
  it("uses explicit id when present", () => {
    expect(stepBindingKey({ id: "myStep", tool: "t" }, 3)).toBe("myStep");
  });

  it("falls back to string index when id is absent", () => {
    expect(stepBindingKey({ tool: "t" }, 2)).toBe("2");
  });

  it("falls back to string index when id is empty", () => {
    expect(stepBindingKey({ id: "", tool: "t" }, 1)).toBe("1");
  });
});
