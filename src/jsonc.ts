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
// COMMENT-PRESERVING path: `editJsoncEntry` / `removeJsoncEntry` /
// `editJsoncPath` below splice into the original bytes (locating nodes with
// the `jsonc-parser` package) so the user's `// note` and `/* block */` text,
// and every member the edit is not about, survive a write-back. Use the
// read-only path when you only need to inspect; use the editing path when you
// have to write the file BACK to disk (install-cmd.ts, import-cmd.ts,
// try-cmd.ts and local-set-cmd.ts all rewrite a config the user may have
// commented by hand).
//
// Trailing commas (e.g. `[1, 2,]` or `{"a": 1,}`) are stripped before
// passing to JSON.parse. Hand-edited configs commonly have them; stripping
// is safe because the pattern only matches commas immediately before a
// `]` or `}` token (after optional whitespace). We track string context
// so a quoted value like `"a trailing comma,"` is never touched.
//
// Escape sequences inside strings are honored (`"a\\"` stays closed),
// so a literal `"abc // def"` keeps its `//`.

import {
  applyEdits,
  createScanner,
  type Edit,
  type FormattingOptions,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser";

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

// Parse JSONC -> unknown. On malformed input it rethrows JSON.parse's own
// SyntaxError, raised against the comment-STRIPPED text -- there is no
// re-mapping step and no excerpt of the user's original source in the
// message beyond whatever JSON.parse itself includes. What the strippers
// DO preserve is newlines (a swallowed comment keeps its line breaks, a
// trailing comma becomes a space), so a reported LINE number still matches
// the user's file; a character offset can be short by the width of any
// block comment earlier on that same line.
export function parseJsonc(src: string): unknown {
  // Strip a leading UTF-8 BOM (U+FEFF). Notepad on Windows defaults to
  // BOM-prefixed UTF-8, so a user who hand-edits ~/.claude.json there and
  // saves it back produces a file JSON.parse rejects. The strip lives in the
  // wrapper so stripJsoncComments stays focused on comments/strings.
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const stripped = stripTrailingCommas(stripJsoncComments(debommed));
  return JSON.parse(stripped);
}

// Comment-preserving editing helpers. They SPLICE into the original source
// bytes instead of re-serializing the document: jsonc-parser's `parseTree`
// locates the target node, its scanner finds the commas and comments around
// that node, and the helpers below compute the exact spans to insert or
// delete. What an edit changes is limited to:
//
//   - INSERT: the new member, on its own line(s) directly below the
//     container's last member -- after that member's trailing comment, never
//     in front of it -- plus the one separator comma JSON needs straight after
//     that member's value when it did not already have one;
//   - REMOVE: the member's own line(s), taking its comma and any comment on
//     those lines with it. A member that shares a line with other text (a
//     one-line container, comma-first style) instead loses the member through
//     its comma plus the blank run on one side of it, and an only member whose
//     braces would then hold nothing but blank space takes that space too
//     (`{ "mcp": 1 }` becomes `{}`). Either way, plus -- only when it was the
//     LAST member -- the separator comma after the previous member's value
//     (that member's comment stays);
//   - REPLACE: the old value's own span.
//
// New text copies the file's own style: the indent step (a tab, or N spaces)
// from the container's existing members, the line ending from the file's
// first line break (a CRLF file stays CRLF), and a trailing comma after the
// new member when the member before it had one. A member added where the
// container's `}` follows its last member on the same line -- a one-line
// container, or a multi-line one closed straight after its last member -- goes
// on that line, compact; an empty `{}` in a multi-line file is opened onto
// lines of its own. A replaced value is written compact when its container
// sits on one line and pretty-printed otherwise, so a one-line array inside a
// multi-line object comes back expanded. Where the file has nothing to
// copy, the defaults are two spaces and \n -- JSON.stringify(_, null, 2), the
// house style for generated config blobs.
//
// This replaced a delegation to jsonc-parser's `modify` + `applyEdits` with
// formatting on. That call starts an insert or a removal at the END of the
// PREVIOUS member's value and then re-formats the whole range, so an install
// re-rendered the neighbouring entry (expanded onto new lines, re-indented in
// a 2-space step whatever the file used) and moved that entry's `// comment`
// onto the new one, and a removal deleted a comment trailing the previous
// entry.
//
// Shapes the splicer does not take on still go to `modify`, so they keep
// jsonc-parser's behaviour and error messages exactly: an empty or
// unparseable document, a delete under a container that does not exist
// ("Can not delete in empty document"), a parent that is not an object where a
// key is needed ("Can not add index to parent of type ..."), and array
// insert/remove. No caller matches on that text: findBlockedContainerSegment
// in install-cmd.ts and peelEntryFromConfig in try-cmd.ts check for those
// shapes BEFORE calling rather than catching the throw.
//
// All helpers are STRING in, STRING out; the caller does the disk IO
// (atomicWriteFile etc.). Offsets are computed against the text each call is
// handed, so apply edits one at a time, each against the result of the last.

// Formatting for the shapes still delegated to jsonc-parser's `modify`.
const FORMATTING_OPTIONS: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

// jsonc-parser declares its token kinds (`SyntaxKind`) as an ambient const
// enum, which this repo's `isolatedModules` setting does not let us read at
// runtime, so the kinds the splicer needs are spelled as their values here.
// A wrong value fails the splice tests in src/tests/jsonc-splice.test.ts.
const TOKEN_CLOSE_BRACE = 2;
const TOKEN_CLOSE_BRACKET = 4;
const TOKEN_COMMA = 5;
const TOKEN_LINE_COMMENT = 12;
const TOKEN_BLOCK_COMMENT = 13;
const TOKEN_LINE_BREAK = 14;
const TOKEN_WHITESPACE = 15;

const isHorizontalSpace = (c: string | undefined): boolean => c === " " || c === "\t";
const isLineBreak = (c: string | undefined): boolean => c === "\n" || c === "\r";

function lineStartOf(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && !isLineBreak(text[i - 1])) i--;
  return i;
}

/** The leading spaces/tabs of the line holding `pos`. */
function indentOfLine(text: string, pos: number): string {
  const start = lineStartOf(text, pos);
  let end = start;
  while (isHorizontalSpace(text[end])) end++;
  return text.slice(start, end);
}

/** True when nothing but spaces/tabs precedes `pos` on its line. */
function startsLine(text: string, pos: number): boolean {
  for (let i = lineStartOf(text, pos); i < pos; i++) {
    if (!isHorizontalSpace(text[i])) return false;
  }
  return true;
}

function isOneLine(text: string, node: Node): boolean {
  for (let i = node.offset; i < node.offset + node.length; i++) {
    if (isLineBreak(text[i])) return false;
  }
  return true;
}

/** The file's own line ending, read from its first line break. */
function detectEol(text: string): string {
  const match = /\r\n|\n|\r/.exec(text);
  return match ? match[0] : "\n";
}

/** The indent step to render new members of `container` with: what its
 *  members already sit at relative to the container's own line, else the
 *  file's shallowest indented line (a tab wins), else two spaces. */
function detectIndentStep(text: string, container: Node): string {
  const base = indentOfLine(text, container.offset);
  for (const child of container.children ?? []) {
    if (!startsLine(text, child.offset)) continue;
    const indent = indentOfLine(text, child.offset);
    const step = indent.slice(base.length);
    if (indent.startsWith(base) && /^(?: +|\t+)$/.test(step)) return step;
  }
  let spaces = 0;
  for (const match of text.matchAll(/^([ \t]+)["\]}]/gm)) {
    const indent = match[1];
    if (indent.startsWith("\t")) return "\t";
    if (!indent.includes("\t") && (spaces === 0 || indent.length < spaces)) spaces = indent.length;
  }
  return spaces > 0 ? " ".repeat(spaces) : "  ";
}

/** `value` as JSON text: compact, or pretty-printed with `step` and every
 *  line after the first prefixed by `eol` + `indent`. Refuses a value JSON
 *  cannot represent (a function, a symbol, undefined) rather than writing the
 *  word `undefined` into the user's config. */
function render(value: unknown, step: string, eol: string, indent: string, compact: boolean): string {
  const json: string | undefined = compact ? JSON.stringify(value) : JSON.stringify(value, null, step);
  if (json === undefined) throw new Error(`cannot write a ${typeof value} value as JSON`);
  // JSON.stringify escapes a newline inside a string, so every "\n" in its
  // output is one of its own line breaks.
  return compact ? json : json.split("\n").join(eol + indent);
}

interface RestOfLine {
  /** Offset of a comma met on the way, if any. */
  comma: number | undefined;
  /** Where the scan stopped: the line break that ends the line, or the first
   *  token on it that is not whitespace, a comment or that comma. */
  stop: number;
  stopLength: number;
  stopKind: number;
}

/** Scan forward from `from` to the end of its line, stepping over
 *  whitespace, comments and one comma. A block comment spanning lines is
 *  stepped over whole, so the line that ends is the one its close is on. */
function scanRestOfLine(text: string, from: number): RestOfLine {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  let comma: number | undefined;
  for (;;) {
    const kind: number = scanner.scan();
    if (kind === TOKEN_WHITESPACE || kind === TOKEN_LINE_COMMENT || kind === TOKEN_BLOCK_COMMENT) continue;
    if (kind === TOKEN_COMMA && comma === undefined) {
      comma = scanner.getTokenOffset();
      continue;
    }
    return { comma, stop: scanner.getTokenOffset(), stopLength: scanner.getTokenLength(), stopKind: kind };
  }
}

/** Offset of the comma that follows `from` across any whitespace, line
 *  breaks and comments -- the separator after a member -- or undefined. */
function commaAfter(text: string, from: number): number | undefined {
  // ignoreTrivia: the scanner itself skips whitespace, line breaks and comments.
  const scanner = createScanner(text, true);
  scanner.setPosition(from);
  const kind: number = scanner.scan();
  return kind === TOKEN_COMMA ? scanner.getTokenOffset() : undefined;
}

/** Splice `value` into `container` as a new last member, preserving every
 *  byte and comment already in it.
 *
 *  `key` null means an ARRAY element: the label and its colon are simply not
 *  written, and the close token to look for is `]` rather than `}`. Everything
 *  else -- where the separator comma goes, whether the file's list ends with a
 *  trailing comma, the indent to line the new member up with, the one-line
 *  case -- is the same question for both containers, which is why this is one
 *  function rather than two that could drift. */
function insertMember(text: string, container: Node, key: string | null, value: unknown): Edit[] | null {
  const eol = detectEol(text);
  const step = detectIndentStep(text, container);
  // An ARRAY element is the value alone: no label, no colon. `pretty` is the
  // label a pretty-printed member carries, `compact` the one a member on a
  // single line carries, each empty for an array.
  const keyJson = key === null ? null : JSON.stringify(key);
  const pretty = keyJson === null ? "" : `${keyJson}: `;
  const compact = (sep: string): string => (keyJson === null ? "" : `${keyJson}:${sep}`);
  const closeKind = key === null ? TOKEN_CLOSE_BRACKET : TOKEN_CLOSE_BRACE;
  const members = container.children ?? [];
  const close = container.offset + container.length - 1;

  if (members.length === 0) {
    const rest = scanRestOfLine(text, container.offset + 1);
    if (rest.stopKind === TOKEN_LINE_BREAK) {
      // `{` ends its line (a comment may follow it): the member goes on a
      // new line directly below.
      const indent = indentOfLine(text, container.offset) + step;
      return [
        {
          offset: rest.stop,
          length: 0,
          content: `${eol}${indent}${pretty}${render(value, step, eol, indent, false)}`,
        },
      ];
    }
    let root = container;
    while (root.parent !== undefined) root = root.parent;
    if (isOneLine(text, root)) {
      // A one-line document (minified, or just short): stay on the line.
      const colonOffset = container.parent?.colonOffset;
      const gap = colonOffset !== undefined && text[colonOffset + 1] === " " ? " " : "";
      return [{ offset: close, length: 0, content: `${compact(gap)}${render(value, step, eol, "", true)}` }];
    }
    // `{}` in a multi-line file: open it onto lines of its own. Blank space
    // between the braces is replaced; a comment there is left in place.
    const outer = indentOfLine(text, container.offset);
    const indent = outer + step;
    const inside = text.slice(container.offset + 1, close);
    const blank = /^[ \t]*$/.test(inside);
    return [
      {
        offset: blank ? container.offset + 1 : close,
        length: blank ? inside.length : 0,
        content: `${eol}${indent}${pretty}${render(value, step, eol, indent, false)}${eol}${outer}`,
      },
    ];
  }

  const last = members[members.length - 1];
  const lastEnd = last.offset + last.length;
  const trailingComma = commaAfter(text, lastEnd);
  const rest = scanRestOfLine(text, trailingComma === undefined ? lastEnd : trailingComma + 1);
  const edits: Edit[] = [];
  // The separator goes straight after the value -- on the same line, ahead of
  // any comment -- which is the one byte the previous member's line gains.
  if (trailingComma === undefined) edits.push({ offset: lastEnd, length: 0, content: "," });
  // Mirror the previous member: a file that ended the list with a comma gets
  // one after the new member too (so a later removal restores it exactly).
  const ownComma = trailingComma === undefined ? "" : ",";

  if (rest.stopKind === TOKEN_LINE_BREAK) {
    // Multi-line container: a new line below the last member's line, at the
    // indent of the last member that starts a line of its own.
    const anchor = [...members].reverse().find((m) => startsLine(text, m.offset));
    const indent = anchor ? indentOfLine(text, anchor.offset) : indentOfLine(text, container.offset) + step;
    edits.push({
      offset: rest.stop,
      length: 0,
      content: `${eol}${indent}${pretty}${render(value, step, eol, indent, false)}${ownComma}`,
    });
    return edits;
  }
  if (rest.stopKind === closeKind) {
    // One-line container: the member goes in front of its closing token,
    // compact, with the spacing the container already uses.
    const colon = last.colonOffset !== undefined && text[last.colonOffset + 1] === " " ? " " : "";
    const gap = isHorizontalSpace(text[rest.stop - 1]) ? " " : "";
    edits.push({
      offset: rest.stop,
      length: 0,
      content: `${compact(colon)}${render(value, step, eol, "", true)}${ownComma}${gap}`,
    });
    return edits;
  }
  return null;
}

function removeMember(text: string, container: Node, member: Node): Edit[] {
  const members = container.children ?? [];
  const index = members.indexOf(member);
  const isLast = index === members.length - 1;
  const end = member.offset + member.length;
  const ownComma = commaAfter(text, end);
  const rest = scanRestOfLine(text, end);
  const edits: Edit[] = [];

  // Its own line(s): nothing but indentation before it, and its line ends
  // after its comma and comments. (A member whose separator sits on a LATER
  // line is not "own line": deleting its lines would strand that comma.)
  const ownLines =
    startsLine(text, member.offset) &&
    rest.stopKind === TOKEN_LINE_BREAK &&
    (rest.comma !== undefined || ownComma === undefined);
  if (ownLines) {
    const start = lineStartOf(text, member.offset);
    edits.push({ offset: start, length: rest.stop + rest.stopLength - start, content: "" });
  } else {
    // Shares a line with something else: take the member, its comma, and the
    // blank run on one side of it, leaving its neighbours' text alone.
    let from = member.offset;
    let to = ownComma === undefined ? end : ownComma + 1;
    let after = to;
    while (isHorizontalSpace(text[after])) after++;
    to = after;
    if (after >= text.length || isLineBreak(text[after])) {
      while (from > 0 && isHorizontalSpace(text[from - 1])) from--;
    }
    if (members.length === 1) {
      // The only member: when nothing but blank space would be left between
      // the braces, close them up.
      const open = container.offset + 1;
      const close = container.offset + container.length - 1;
      if (/^\s*$/.test(text.slice(open, from) + text.slice(to, close))) {
        from = open;
        to = close;
      }
    }
    edits.push({ offset: from, length: to - from, content: "" });
  }

  // Removing the LAST member leaves the one before it as the last, so its
  // separator comma goes -- unless the removed member had a trailing comma of
  // its own, in which case the file uses them and the one before stays.
  if (isLast && index > 0 && ownComma === undefined) {
    const previous = members[index - 1];
    const separator = commaAfter(text, previous.offset + previous.length);
    if (separator !== undefined) edits.push({ offset: separator, length: 1, content: "" });
  }
  return edits;
}

function replaceValue(text: string, container: Node, node: Node, value: unknown): Edit {
  const content = render(
    value,
    detectIndentStep(text, container),
    detectEol(text),
    indentOfLine(text, node.offset),
    isOneLine(text, container),
  );
  return { offset: node.offset, length: node.length, content };
}

/** The splice for `value` at `path`, or null when the shape is one this file
 *  leaves to jsonc-parser's `modify` (see the header comment). `value`
 *  undefined means delete. */
function spliceEdits(text: string, path: JSONPath, value: unknown): Edit[] | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (root === undefined || errors.length > 0) return null;
  // Same walk as jsonc-parser's setProperty: climb to the deepest container
  // that exists, wrapping the value in the missing levels on the way.
  const remaining = path.slice();
  let toWrite = value;
  let parent: Node | undefined;
  let key: string | number | undefined;
  while (remaining.length > 0) {
    key = remaining.pop();
    parent = findNodeAtLocation(root, remaining);
    if (parent !== undefined || toWrite === undefined) break;
    toWrite = typeof key === "string" ? { [key]: toWrite } : [toWrite];
  }
  if (parent === undefined || key === undefined) return null;

  if (parent.type === "object" && typeof key === "string") {
    const existing = findNodeAtLocation(parent, [key]);
    if (existing?.parent !== undefined) {
      if (toWrite === undefined) return removeMember(text, parent, existing.parent);
      return [replaceValue(text, parent, existing, toWrite)];
    }
    if (toWrite === undefined) return [];
    return insertMember(text, parent, key, toWrite);
  }
  if (parent.type === "array" && typeof key === "number" && toWrite !== undefined && key >= 0) {
    const element = parent.children?.[key];
    if (element !== undefined) return [replaceValue(text, parent, element, toWrite)];
  }
  return null;
}

function computeEdits(text: string, path: JSONPath, value: unknown): Edit[] {
  return spliceEdits(text, path, value) ?? modify(text, path, value, { formattingOptions: FORMATTING_OPTIONS });
}

/** Upsert `value` into `src` at the JSON path `[...containerPath, entryName]`,
 *  preserving comments in `src`. Returns the new source text.
 *
 *  Use this from a read-modify-write callsite when you need to write the file
 *  BACK to disk -- the comment-destructive JSON.parse + JSON.stringify pattern
 *  drops every `//` and `/* * /` the user has in their config. The edit is a
 *  splice into `src` (see the header comment above for exactly which bytes it
 *  adds), so every other member keeps its bytes, its comments and its place.
 *  Missing containers along `containerPath` are created.
 *
 *  Strips a leading UTF-8 BOM if present (Notepad on Windows defaults to
 *  BOM-prefixed UTF-8) so jsonc-parser sees clean bytes; we don't re-emit
 *  the BOM.
 *
 *  Throws on an empty `entryName`. A path segment is a JSON key, and `""` is
 *  not one the caller can ever have meant: it would write a literal
 *  `"": value` entry into the user's config. The old guard only rejected it
 *  when `containerPath` was ALSO empty, so `(['a'], '')` slipped through and
 *  wrote that key one level down. */
export function editJsoncEntry(src: string, containerPath: string[], entryName: string, value: unknown): string {
  if (entryName === "") {
    throw new Error("editJsoncEntry: entryName must be a non-empty key");
  }
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  return applyEdits(debommed, computeEdits(debommed, [...containerPath, entryName], value));
}

/** Remove the entry at `[...containerPath, entryName]` from `src`, preserving
 *  comments. Returns the new source text. No-op (returns the input unchanged,
 *  BYTE for byte, BOM included) if the entry does not exist in a container
 *  that does -- callers can detect this via referential equality on the
 *  input/output strings if they need to. A container along `containerPath`
 *  that is itself missing throws instead (jsonc-parser's "Can not delete in
 *  empty document"); peelEntryFromConfig in try-cmd.ts walks the path first
 *  for that reason.
 *
 *  Same rationale as `editJsoncEntry`: a read-modify-write that goes through
 *  JSON.parse + JSON.stringify drops user comments; this deletes the entry's
 *  own line(s) -- or, on a line it shares, the entry through its comma plus
 *  the blank run beside it, closing up braces left holding only blank space --
 *  and, when it was the last entry, the comma before it. No other member's
 *  text or comment is touched.
 *
 *  ASYMMETRY, on purpose: the byte-for-byte guarantee covers the NO-OP path
 *  only. On a real removal the leading UTF-8 BOM is stripped and NOT re-emitted
 *  -- the edit offsets are computed against the de-BOM'd text, so the returned
 *  string starts at `{`. That is the same BOM loss the no-op path was fixed to
 *  avoid, but here it rides along with a change the caller asked for and is
 *  going to write back anyway, rather than manufacturing a phantom one.
 *  Callers that must preserve a Notepad-saved BOM have to re-prepend it.
 *
 *  Throws on an empty `entryName`, for the same reason as `editJsoncEntry`. */
export function removeJsoncEntry(src: string, containerPath: string[], entryName: string): string {
  if (entryName === "") {
    throw new Error("removeJsoncEntry: entryName must be a non-empty key");
  }
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const edits = computeEdits(debommed, [...containerPath, entryName], undefined);
  // Nothing to remove -> return the ORIGINAL bytes, not the de-BOM'd copy.
  // Returning `debommed` for a BOM-prefixed file made the no-op look like a
  // change to every caller that compares `next !== raw` (try-cmd's cleanup and
  // doctor's GC both do): they would write the file back and report "Removed
  // <entry>" having removed nothing, silently stripping the BOM off a
  // Notepad-saved ~/.claude.json.
  if (edits.length === 0) return src;
  return applyEdits(debommed, edits);
}

/** Set (or, with `undefined`, delete) the value at an arbitrary JSON path,
 *  preserving comments. Unlike editJsoncEntry / removeJsoncEntry above,
 *  `path` may contain NUMERIC segments, so it can address an array element --
 *  which is what a bundles.json server is (`["servers", 3, "isActive"]`).
 *  Those two are typed `containerPath: string[]` and cannot: a numeric index
 *  passed as a string segment names a key, and an array has none -- jsonc-parser
 *  throws `Can not add index to parent of type array`.
 *
 *  Same splice as editJsoncEntry / removeJsoncEntry for a key in an object and
 *  for replacing an existing array element. Inserting into or deleting from an
 *  ARRAY is left to jsonc-parser's `modify` (no caller does either).
 *
 *  Returns the input unchanged, byte for byte and BOM included, when the edit
 *  is a no-op -- same contract, and same reason, as removeJsoncEntry.
 *
 *  TWO THINGS TO KNOW BEFORE USING IT.
 *
 *  Edits CANNOT be batched against one source text. Each call re-parses the
 *  text it is handed and returns that whole text with its one edit applied,
 *  so two calls against the same input each drop the other's edit. Apply them
 *  one at a time, each against the result of the last.
 *
 *  Deleting under a MISSING intermediate object throws rather than no-opping:
 *  with an undefined value there is nothing to wrap and no container to delete
 *  from, and jsonc-parser throws `Can not delete in empty document`. Check the
 *  container exists first. */
export function editJsoncPath(src: string, path: Array<string | number>, value: unknown): string {
  if (path.length === 0) {
    throw new Error("editJsoncPath: path must not be empty");
  }
  if (path.some((seg) => seg === "")) {
    throw new Error("editJsoncPath: path segments must be non-empty");
  }
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const edits = computeEdits(debommed, path, value);
  if (edits.length === 0) return src;
  return applyEdits(debommed, edits);
}

/** One element of an array node, as a JS value.
 *
 *  `Node.value` is populated ONLY for a scalar: an `object` or an `array`
 *  child reports `value: undefined` (measured against the jsonc-parser this
 *  repo pins), so comparing or testing children through `child.value` treats
 *  every non-scalar element as one and the same `undefined` -- a dedupe that
 *  can never match an object, and a predicate that is handed nothing to
 *  decide on. `getNodeValue` materialises the subtree, which is what both
 *  helpers below need. */
function elementValue(child: Node): unknown {
  return getNodeValue(child);
}

/** The ARRAY at `path`, or null when `src` does not parse or nothing of that
 *  type is there. Shared by the two array helpers below so they agree about
 *  what counts as an array to splice into. */
function arrayNodeAt(text: string, path: Array<string | number>): Node | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (root === undefined || errors.length > 0) return null;
  const node = findNodeAtLocation(root, path);
  return node !== undefined && node.type === "array" ? node : null;
}

/** Append `value` to the array at `path`, preserving comments.
 *
 *  The three editing helpers above address a KEY; this one addresses a list,
 *  which is a different splice: a list has no member to replace, so setting
 *  the whole array is the only thing they can do to one -- and that deletes
 *  every comment INSIDE it. Claude Code's `permissions.allow` is exactly such
 *  a list, routinely annotated per pattern, so adding one pattern used to
 *  delete the user's notes about the others.
 *
 *  The new element copies the list's own style through the same code path a
 *  new object member does (indent, line ending, trailing-comma mirroring, the
 *  one-line case, a comment after the last element left where it is).
 *
 *  The array is CREATED, with `value` its only element, when `path` names
 *  nothing -- and so are any missing objects above it, which is `editJsoncPath`'s
 *  behaviour and needs no comment-preserving care: a list that does not exist
 *  yet holds no comment to lose.
 *
 *  Returns the input unchanged, byte for byte and BOM included, when the value
 *  is already an element of that array -- the same no-op contract, and the
 *  same reason, as `removeJsoncEntry`. Equality is `JSON.stringify` over the
 *  element's fully materialised value (`getNodeValue`, not `Node.value`, which
 *  is undefined for an object or an array child), so it covers a string, a
 *  number, an object and a nested array alike. Key ORDER counts, as it does in
 *  any stringify comparison: `{"a":1,"b":2}` and `{"b":2,"a":1}` are two
 *  elements, and this appends the second.
 *
 *  Throws when `path` names something that is NOT an array (a string, an
 *  object): silently replacing it would throw away whatever the user put
 *  there, and the caller is better placed to name the key in its message. */
export function addJsoncArrayElement(src: string, path: Array<string | number>, value: unknown): string {
  if (path.length === 0) throw new Error("addJsoncArrayElement: path must not be empty");
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const array = arrayNodeAt(debommed, path);
  if (array === null) {
    const errors: ParseError[] = [];
    const root = parseTree(debommed, errors, { allowTrailingComma: true });
    const existing = root === undefined ? undefined : findNodeAtLocation(root, path);
    if (existing !== undefined) {
      throw new Error(`addJsoncArrayElement: ${path.join(".")} is a ${existing.type}, not an array`);
    }
    return editJsoncPath(debommed, path, [value]);
  }
  const wanted = JSON.stringify(value);
  for (const child of array.children ?? []) {
    if (JSON.stringify(elementValue(child)) === wanted) return src;
  }
  const edits = insertMember(debommed, array, null, value);
  // `insertMember` returns null only for a container shape its scanner cannot
  // place a member in. Falling back to the whole-array write keeps the edit
  // working (it is what this function replaces) at the cost of the comments
  // inside -- strictly better than refusing, and the caller cannot do more.
  if (edits === null) {
    const next = [...(array.children ?? []).map(elementValue), value];
    return editJsoncPath(debommed, path, next);
  }
  return applyEdits(debommed, edits);
}

/** Remove from the array at `path` every element whose parsed value satisfies
 *  `matches`, preserving the comments on the elements that stay.
 *
 *  `matches` is handed the element's fully materialised value, so an object or
 *  a nested-array element is a value the predicate can actually test rather
 *  than the `undefined` `Node.value` reports for those types.
 *
 *  The mirror of `addJsoncArrayElement`, and the same reason for existing: the
 *  whole-array write that would otherwise do this deletes every comment in the
 *  list. An element's own line goes with it -- including a comment on that
 *  line, which annotates the element being removed -- exactly as a removed
 *  object member's does.
 *
 *  Returns the input unchanged, byte for byte and BOM included, when nothing
 *  matches or `path` names no array. An emptied list is left as `[]` rather
 *  than deleted: dropping a key the user's file declares is a bigger liberty
 *  than a removal is entitled to. */
export function removeJsoncArrayElements(
  src: string,
  path: Array<string | number>,
  matches: (value: unknown) => boolean,
): string {
  if (path.length === 0) throw new Error("removeJsoncArrayElements: path must not be empty");
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const array = arrayNodeAt(debommed, path);
  if (array === null) return src;
  const doomed = (array.children ?? []).filter((child) => matches(elementValue(child)));
  if (doomed.length === 0) return src;
  // One at a time, each against the text the last one produced: `removeMember`
  // computes offsets against the tree it was given, so two sets of edits taken
  // from the same parse would each be applied at stale positions.
  let text = debommed;
  for (let i = 0; i < doomed.length; i++) {
    const current = arrayNodeAt(text, path);
    if (current === null) break;
    const member = (current.children ?? []).find((child) => matches(elementValue(child)));
    if (member === undefined) break;
    text = applyEdits(text, removeMember(text, current, member));
  }
  // A list emptied by those removals closes up to `[]`, which is what a
  // whole-array write leaves and therefore what every existing expectation
  // about an emptied list pins. Only BLANK space is closed up: a comment
  // between the brackets is content the user wrote and stays, the same rule
  // `removeMember` applies to an emptied one-line container.
  const emptied = arrayNodeAt(text, path);
  if (emptied !== null && (emptied.children ?? []).length === 0) {
    const open = emptied.offset + 1;
    const close = emptied.offset + emptied.length - 1;
    if (close > open && /^\s*$/.test(text.slice(open, close))) {
      text = text.slice(0, open) + text.slice(close);
    }
  }
  return text;
}
