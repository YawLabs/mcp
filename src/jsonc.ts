// Tiny string-aware JSONC comment stripper. Not a full parser — we just
// strip // line comments and /* block */ comments, then hand the result
// to JSON.parse. String literals are tracked so `//` inside "https://…"
// or a dollar sign inside a comment-like token are preserved verbatim.
//
// READ-ONLY path: stripJsoncComments + parseJsonc below are the
// dependency-light parser used everywhere we only need to LOAD a JSONC
// config (~/.claude.json, settings.json) into a JS value. They are
// comment-destructive by design -- the output goes straight to JSON.parse,
// not back to disk -- and that's been the right shape historically.
//
// COMMENT-PRESERVING path: `editJsoncEntry` / `removeJsoncEntry` below
// route through the `jsonc-parser` package so the user's `// note` and
// `/* block */` text survive a write-back. Use the read-only path when
// you only need to inspect; use the editing path when you have to write
// the file BACK to disk (try-cmd.ts: `yaw-mcp try`, `try-cleanup`, and
// doctor's expiry-gc all rewrite the user's client config).
//
// Trailing commas (e.g. `[1, 2,]` or `{"a": 1,}`) are stripped before
// passing to JSON.parse. Hand-edited configs commonly have them; stripping
// is safe because the pattern only matches commas immediately before a
// `]` or `}` token (after optional whitespace). We track string context
// so a quoted value like `"a trailing comma,"` is never touched.
//
// Escape sequences inside strings are honored (`"a\\"` stays closed),
// so a literal `"abc // def"` keeps its `//`.

import { applyEdits, type FormattingOptions, modify } from "jsonc-parser";

export function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  const len = src.length;
  let inString = false;
  let stringChar = "";
  while (i < len) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < len) {
        // Preserve the escaped character verbatim so `\"` doesn't prematurely
        // close the string and trick the comment scanner on the next char.
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      // Line comment — swallow through (but not including) the next newline,
      // which we preserve so line numbers in JSON.parse errors stay accurate.
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      // Block comment — swallow through the closing `*/`. Preserve any
      // newlines inside the comment so JSON.parse line numbers line up
      // with the user's source file.
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Strip trailing commas before a `]` or `}` token. Operates character-by-
// character tracking string state so quoted values are never modified.
// Replaces each trailing comma with a space so JSON.parse line numbers
// remain accurate.
export function stripTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  const len = src.length;
  let inString = false;
  let stringChar = "";
  while (i < len) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < len) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      // Peek ahead past whitespace — if the next non-whitespace char is
      // `]` or `}`, this is a trailing comma; replace with a space.
      let j = i + 1;
      while (j < len && (src[j] === " " || src[j] === "\t" || src[j] === "\r" || src[j] === "\n")) j++;
      if (j < len && (src[j] === "]" || src[j] === "}")) {
        out += " "; // replace comma with space, preserving column count
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Parse JSONC → unknown. Throws SyntaxError with the original source line
// context when JSON.parse fails (so "bad JSON on line 7" works even after
// we strip comments).
export function parseJsonc(src: string): unknown {
  // Strip a leading UTF-8 BOM (U+FEFF). Notepad on Windows defaults to
  // BOM-prefixed UTF-8, so a user who hand-edits ~/.claude.json there and
  // saves it back produces a file JSON.parse rejects. The strip lives in the
  // wrapper so stripJsoncComments stays focused on comments/strings.
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const stripped = stripTrailingCommas(stripJsoncComments(debommed));
  return JSON.parse(stripped);
}

// Comment-preserving editing helpers. Implemented on top of `jsonc-parser`'s
// `modify` + `applyEdits`, which compute a minimal text-edit diff against the
// ORIGINAL source bytes -- comments, whitespace, and existing key ordering
// survive untouched. The trade-off vs the read-only path above: the file
// must already be syntactically valid JSONC (so jsonc-parser can locate the
// target path) and we pay a real-parser cost. For the read-modify-write
// callsites in try-cmd.ts that's the correct trade.
//
// Both helpers operate on STRING in, STRING out. The caller does the disk IO
// (atomicWriteFile etc.) -- these helpers only transform bytes.

// Standard formatting options used when jsonc-parser has to render a NEW
// region (e.g. the inserted launch entry). The user's existing indentation
// is preserved everywhere except in newly-introduced spans; for those spans
// we emit 2-space indentation + \n line endings, matching JSON.stringify(_, null, 2)
// (the rest of the codebase's house style for generated config blobs).
const FORMATTING_OPTIONS: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

/** Upsert `value` into `src` at the JSON path `[...containerPath, entryName]`,
 *  preserving comments in `src`. Returns the new source text.
 *
 *  Use this from a read-modify-write callsite when you need to write the file
 *  BACK to disk -- the comment-destructive JSON.parse + JSON.stringify pattern
 *  drops every `//` and `/* * /` the user has in their config. `applyEdits`
 *  computes a minimal text diff against `src`, so anything not on the target
 *  path keeps its original bytes (comments, key order, indentation).
 *
 *  Strips a leading UTF-8 BOM if present (Notepad on Windows defaults to
 *  BOM-prefixed UTF-8) so jsonc-parser sees clean bytes; we don't re-emit
 *  the BOM. */
export function editJsoncEntry(src: string, containerPath: string[], entryName: string, value: unknown): string {
  if (containerPath.length === 0 && entryName === "") {
    throw new Error("editJsoncEntry: must specify at least one path segment");
  }
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const targetPath = [...containerPath, entryName];
  const edits = modify(debommed, targetPath, value, { formattingOptions: FORMATTING_OPTIONS });
  return applyEdits(debommed, edits);
}

/** Remove the entry at `[...containerPath, entryName]` from `src`, preserving
 *  comments. Returns the new source text. No-op (returns the input unchanged)
 *  if the path does not exist -- callers can detect this via referential
 *  equality on the input/output strings if they need to.
 *
 *  Same rationale as `editJsoncEntry`: a read-modify-write that goes through
 *  JSON.parse + JSON.stringify drops user comments; `jsonc-parser` emits a
 *  minimal text edit that only touches the target span. */
export function removeJsoncEntry(src: string, containerPath: string[], entryName: string): string {
  if (containerPath.length === 0 && entryName === "") {
    throw new Error("removeJsoncEntry: must specify at least one path segment");
  }
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const targetPath = [...containerPath, entryName];
  // jsonc-parser's contract: pass `undefined` as the value to remove a node.
  const edits = modify(debommed, targetPath, undefined, { formattingOptions: FORMATTING_OPTIONS });
  if (edits.length === 0) return debommed === src ? src : debommed;
  return applyEdits(debommed, edits);
}
