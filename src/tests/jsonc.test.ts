import { describe, expect, it } from "vitest";
import { editJsoncEntry, parseJsonc, removeJsoncEntry, stripJsoncComments, stripTrailingCommas } from "../jsonc.js";

describe("stripJsoncComments", () => {
  it("leaves plain JSON untouched", () => {
    const src = '{"a":1,"b":"c"}';
    expect(stripJsoncComments(src)).toBe(src);
  });

  it("strips // line comments", () => {
    const src = '{\n  "a": 1 // inline\n}';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("strips /* block */ comments", () => {
    const src = '{ /* leading */ "a": 1 /* trailing */ }';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("strips multi-line block comments", () => {
    const src = '{\n/*\n  multi\n  line\n*/\n"a": 1\n}';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("preserves newlines inside block comments so line numbers in parse errors stay accurate", () => {
    const src = "/*\n\n\n*/\n{not valid json}";
    const stripped = stripJsoncComments(src);
    // Block comment is now whitespace, but the four newlines survive.
    expect((stripped.match(/\n/g) ?? []).length).toBe(4);
  });

  it("preserves // inside strings", () => {
    const src = '{"url": "https://yaw.sh/mcp"}';
    expect(parseJsonc(src)).toEqual({ url: "https://yaw.sh/mcp" });
  });

  it("preserves /* inside strings", () => {
    const src = '{"s": "a /* b */ c"}';
    expect(parseJsonc(src)).toEqual({ s: "a /* b */ c" });
  });

  it("honors escaped quote inside string so //-after-escape is not scanned as a comment", () => {
    // String: `he said "hi //"`. After that closes, // is a real comment.
    const src = '{"msg": "he said \\"hi //\\"" // real comment\n}';
    expect(parseJsonc(src)).toEqual({ msg: 'he said "hi //"' });
  });

  it("honors // and /* inside single-quoted strings too (defensive, even though JSON disallows)", () => {
    // parseJsonc will fail on single-quoted strings at JSON.parse time,
    // but stripJsoncComments must not treat // inside them as comments,
    // else an error-path fallback that re-emits the source would be wrong.
    const src = "{'s': 'a // b'}";
    expect(stripJsoncComments(src)).toBe(src);
  });

  it("handles token on same line as // comment", () => {
    const src = '{"token": "mcp_pat_abc" // my token\n}';
    expect(parseJsonc(src)).toEqual({ token: "mcp_pat_abc" });
  });

  it("is robust to a /* that never closes — swallows to EOF rather than throwing mid-strip", () => {
    const src = '{"a": 1} /* unclosed';
    // Stripping succeeds; JSON.parse sees just `{"a": 1}` and returns ok.
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("parseJsonc still throws SyntaxError on invalid JSON (not silently empty)", () => {
    expect(() => parseJsonc("{ not valid }")).toThrow(SyntaxError);
  });

  it("parseJsonc strips a leading UTF-8 BOM (Notepad-saved configs)", () => {
    const src = `﻿${JSON.stringify({ a: 1 })}`;
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  it("parseJsonc strips BOM before processing comments", () => {
    const src = `﻿// header\n{"a": 1}`;
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });
});

describe("stripTrailingCommas", () => {
  it("strips trailing comma in an object", () => {
    expect(stripTrailingCommas('{"a":1,"b":2,}')).toBe('{"a":1,"b":2 }');
  });

  it("strips trailing comma in an array", () => {
    expect(stripTrailingCommas("[1,2,3,]")).toBe("[1,2,3 ]");
  });

  it("strips trailing comma with whitespace before closing brace", () => {
    expect(stripTrailingCommas('{"a":1,  }')).toBe('{"a":1   }');
  });

  it("does not touch non-trailing commas", () => {
    expect(stripTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it("does not touch commas inside strings", () => {
    expect(stripTrailingCommas('{"a":"foo,}"}')).toBe('{"a":"foo,}"}');
  });

  it("preserves string content unchanged", () => {
    const src = '{"url":"https://example.com/api,"}';
    expect(stripTrailingCommas(src)).toBe(src);
  });
});

describe("editJsoncEntry", () => {
  it("round-trips a JSONC file preserving comments", () => {
    const src = '// top-level comment\n{\n  "a": 1, // inline\n  "b": 2\n}';
    const result = editJsoncEntry(src, [], "b", 99);
    // Comment must survive
    expect(result).toContain("// top-level comment");
    expect(result).toContain("// inline");
    // Value must be updated
    const parsed = parseJsonc(result);
    expect((parsed as Record<string, unknown>).b).toBe(99);
    expect((parsed as Record<string, unknown>).a).toBe(1);
  });

  it("handles BOM-prefixed input without throwing", () => {
    // Notepad on Windows writes a UTF-8 BOM before the first char.
    const bom = "﻿";
    const src = `${bom}{"x": 1}`;
    const result = editJsoncEntry(src, [], "x", 42);
    const parsed = parseJsonc(result);
    expect((parsed as Record<string, unknown>).x).toBe(42);
  });
});

describe("removeJsoncEntry", () => {
  it("removes the specified key while preserving other content", () => {
    const src = '// header\n{\n  "keep": "yes",\n  "remove": "gone"\n}';
    const result = removeJsoncEntry(src, [], "remove");
    // The header comment and the kept key must survive
    expect(result).toContain("// header");
    const parsed = parseJsonc(result);
    expect((parsed as Record<string, unknown>).keep).toBe("yes");
    expect((parsed as Record<string, unknown>).remove).toBeUndefined();
  });
});

describe("parseJsonc trailing comma integration", () => {
  it("parses object with trailing comma", () => {
    expect(parseJsonc('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it("parses array with trailing comma", () => {
    expect(parseJsonc("[1,2,3,]")).toEqual([1, 2, 3]);
  });

  it("parses nested trailing commas", () => {
    expect(parseJsonc('{"a":{"b":1,},"c":[1,2,],}')).toEqual({ a: { b: 1 }, c: [1, 2] });
  });

  it("parses trailing comma combined with line comments", () => {
    expect(parseJsonc('{\n  "a": 1, // comment\n  "b": 2,\n}')).toEqual({ a: 1, b: 2 });
  });
});
