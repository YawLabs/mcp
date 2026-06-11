// Tiny string-aware JSONC comment stripper. Not a full parser — we just
// strip // line comments and /* block */ comments, then hand the result
// to JSON.parse. String literals are tracked so `//` inside "https://…"
// or a dollar sign inside a comment-like token are preserved verbatim.
//
// Why hand-roll instead of depending on `jsonc-parser`: we want yaw-mcp's
// dependency surface to stay small (currently 4 production deps) and the
// stripping logic is <50 LOC. A full comment-preserving parser isn't
// needed — we only read config, never rewrite it as JSONC.
//
// Trailing commas (e.g. `[1, 2,]` or `{"a": 1,}`) are stripped before
// passing to JSON.parse. Hand-edited configs commonly have them; stripping
// is safe because the pattern only matches commas immediately before a
// `]` or `}` token (after optional whitespace). We track string context
// so a quoted value like `"a trailing comma,"` is never touched.
//
// Escape sequences inside strings are honored (`"a\\"` stays closed),
// so a literal `"abc // def"` keeps its `//`.

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
