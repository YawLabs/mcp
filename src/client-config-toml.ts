// TOML client-config adapter (Codex CLI's ~/.codex/config.toml).
//
// Codex reads MCP servers from `[mcp_servers.<name>]` tables in a config.toml
// that also holds the user's model, theme and per-project trust settings. So
// the same rule the JSONC helpers in jsonc.ts follow applies here, harder: a
// write must change our own table and nothing else -- not a comment, not a
// number's spelling, not a sibling's key order.
//
// SPLIT, on purpose:
//
//   READ  -- smol-toml (a runtime dependency). Every read path has to answer
//     "is this file valid TOML" and "what entries does it hold, in any
//     spelling" the way Codex does. A subset parser gets that wrong in both
//     directions: it flags valid files (a quoted header, dotted keys, a
//     multi-line string) as malformed, or accepts files Codex refuses. Either
//     one is a user-visible lie, or a write over a file the client cannot
//     load.
//
//   WRITE -- our own table-span splice (below). No npm TOML library
//     round-trips comments. smol-toml 1.8.0 does export a `stringify`, but it
//     re-renders the document from the PARSED value, so formatting and
//     comments are gone: measured on 1.8.0, `stringify(parse('a = 1.0'))` is
//     `'a = 1\n'`, and a `# comment` in the input has no output at all.
//     Delegating to `codex mcp add` is worse: it re-serializes EVERY entry, so
//     installing yaw-mcp would rewrite the user's other servers (`20` comes
//     back `20.0`, env keys get re-sorted, unknown keys are dropped).
//
// The splice replaces, deletes or inserts WHOLE LINES of the table it owns and
// touches no other byte: comments, blank lines, key order, string quoting,
// number spelling, CRLF, a leading BOM and indentation all survive because
// they are outside the spliced range. What it cannot do safely it REFUSES
// (`TomlSpliceRefusal`), naming the spelling it found and what to do about it,
// rather than guessing.
//
// Every write returned by `upsertTomlEntry` / `removeTomlEntry` has already
// been verified (`verifyTomlSplice`), and there is no exported way to get
// spliced text that skipped that check -- so a scanner bug that would move,
// eat or re-nest anything is a refusal (nothing written), not a corrupted
// config.
//
// What the check proves, exactly: the result PARSES; the document with the
// touched entries dropped MEANS what it meant; the other entries keep their
// file order; ours reads back as the value asked for. It compares the
// canonical JSON of the two PARSED documents, so it is blind to everything
// that is not meaning -- measured, it accepts an `after` in which two
// comments were deleted, a `'literal'` became a `"basic"` and `20` was
// respelled `20.0`. Byte preservation is a property of the splice never
// touching those spans (it edits whole lines of the table it owns), not of
// this check; the byte-exact fixtures in the tests are what pin it.
//
// STRING IN, STRING OUT. The caller does the disk IO (atomicWriteFile etc.)
// and, as in jsonc.ts, offsets are computed against the text each call is
// handed -- so apply edits one at a time, each against the result of the last.

import { parse as parseTomlText, TomlDate, TomlError } from "smol-toml";

/** The syntax word for user-facing messages ("is not valid TOML"). */
export const TOML_SYNTAX = "TOML" as const;

/** smol-toml parse options used on EVERY read.
 *
 *  `integersAsBigInt: "asNeeded"` because the default rejects an integer that
 *  cannot be represented losslessly as a JS number, and Codex (Rust i64)
 *  accepts one: `big = 1152921504606846976` in an unrelated section would
 *  otherwise make the whole file read as malformed. Measured against
 *  smol-toml 1.8.0. */
const PARSE_OPTIONS = { integersAsBigInt: "asNeeded" } as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The file does not parse as TOML. `detail` is the ready-made parenthetical
 *  for the repo's refusal wording -- `<file> is not valid TOML (${detail})` --
 *  and reads "line 2, column 15: control characters are not allowed in
 *  strings". `reason` is that message without the position. */
export class TomlConfigError extends Error {
  readonly line: number;
  readonly column: number;
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, line: number, column: number) {
    const detail = `line ${line}, column ${column}: ${reason}`;
    super(`not valid TOML (${detail})`);
    this.name = "TomlConfigError";
    this.reason = reason;
    this.line = line;
    this.column = column;
    this.detail = detail;
  }
}

/** A spelling the span splice will not edit. `shape` names what is in the
 *  file; `remedy` is the action to hand the user. The `message` joins them, so
 *  a caller can print `yaw-mcp install: ${err.message}` and have a true,
 *  actionable line, or compose its own from the two fields. */
export class TomlSpliceRefusal extends Error {
  readonly shape: string;
  readonly remedy: string;
  constructor(subject: string, shape: string, remedy: string) {
    super(`${subject} is ${shape} -- ${remedy}`);
    this.name = "TomlSpliceRefusal";
    this.shape = shape;
    this.remedy = remedy;
  }
}

/** A spliced result failed its own post-write check. Nothing should be written:
 *  the splice would have changed something it was not asked to change. */
export class TomlVerifyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TomlVerifyError";
  }
}

/** Rendering refused: the entry holds a value with no TOML spelling this
 *  renderer is willing to produce. */
export class TomlRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlRenderError";
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** 1 when the text opens with a UTF-8 BOM, else 0 -- the offset the document's
 *  first line really starts at. */
function bomOffset(text: string): number {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/** Strip ONE leading U+FEFF. smol-toml rejects a BOM ("only letter, numbers,
 *  dashes and underscores are allowed in keys", line 1 column 1 -- measured on
 *  1.8.0) while Codex accepts it, and Notepad writes one by default. The strip
 *  is for the PARSER only: the splice keeps the byte, which is why every
 *  offset below is taken against the ORIGINAL text. */
function stripBom(raw: string): string {
  return raw.slice(bomOffset(raw));
}

/** Parse a config.toml text. Throws `TomlConfigError` -- never smol-toml's own
 *  error type -- so callers have the line, the column and the reason as
 *  separate fields. */
export function parseTomlConfig(raw: string): unknown {
  try {
    return parseTomlText(stripBom(raw), PARSE_OPTIONS);
  } catch (e) {
    if (e instanceof TomlError) {
      // smol-toml's `message` is "Invalid TOML document: <reason>" followed by
      // a blank line and an excerpt of the user's source with a caret. The
      // excerpt is for a terminal that can print several lines; the repo's
      // refusals are one line, so take the reason and carry the position in
      // its own fields.
      const reason = e.message.split("\n")[0].replace(/^Invalid TOML document:\s*/, "");
      return raiseParse(reason, e.line, e.column);
    }
    throw e;
  }
}

function raiseParse(reason: string, line: unknown, column: unknown): never {
  throw new TomlConfigError(reason, typeof line === "number" ? line : 0, typeof column === "number" ? column : 0);
}

/** True for a TOML table, i.e. a plain object.
 *
 *  NOT `typeof v === "object" && !Array.isArray(v)`, which the JSON paths can
 *  use safely and this one cannot: smol-toml returns a datetime as `TomlDate`,
 *  a Date subclass, so `mcp_servers = 1979-05-27` would pass as a container
 *  and the splice would append a `[mcp_servers.mcp]` header to a file Codex
 *  already refuses to load. */
export function isTomlTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** How to name a non-table container value in a message. Shape, not contents:
 *  the user needs to know WHICH key is wrong, not to have its value echoed. */
export function describeTomlShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  if (value instanceof TomlDate) return "a date";
  if (typeof value === "bigint") return "a number";
  if (isTomlTable(value)) return "a table";
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** One `[table]` / `[[array of tables]]` header and the lines under it. */
export interface TomlSection {
  /** Decoded header key path: bare, "basic" and 'literal' segments, with
   *  whitespace around the dots allowed (`[ mcp_servers . "mcp" ]`). */
  keyPath: string[];
  /** True for `[[name]]`. */
  arrayTable: boolean;
  /** Offset of the header LINE's start (indentation included). */
  start: number;
  /** Offset just past the header line's line break. */
  headerEnd: number;
  /** Offset just past the line break of the last line in the section that is
   *  neither blank nor a whole-line comment (the header line itself counts).
   *  Trailing blank and comment lines are deliberately left out: they read as
   *  belonging to whatever comes next, so a replace or a delete keeps them. */
  contentEnd: number;
  /** Offset of the next header line's start, or the text length. */
  end: number;
}

/** A `key = value` line, and which table it sits in. */
export interface TomlAssignment {
  /** The header key path this assignment is under; `[]` at the document root. */
  section: string[];
  /** Its own decoded dotted key path (`mcp.command` -> ["mcp", "command"]). */
  keyPath: string[];
  /** True when the value starts with `{` -- an inline table. */
  inlineTable: boolean;
  /** Offset of the assignment line's start. */
  start: number;
}

/** Why a line did not begin in normal state at bracket depth 0: it is inside a
 *  `"""` block, inside a `'''` block, or inside an unclosed `[` / `{` value. */
export type TomlLineCarry = "mlBasic" | "mlLiteral" | "bracket";

export interface TomlScan {
  sections: TomlSection[];
  assignments: TomlAssignment[];
  /** Line-start offsets of the lines that did NOT begin in normal state at
   *  bracket depth 0, and what carried into each.
   *
   *  Such a line is the CONTENT of the key above it, and it can look like
   *  anything: `# closes it"""` is the last line of a multi-line string, not a
   *  comment, and a line holding only spaces inside `"""` is not a blank line.
   *  So anything that walks lines backwards or forwards over the text has to
   *  consult this map instead of trusting the characters -- which is what the
   *  `contentEnd` back-off below does.
   *
   *  Honest about which carry earns its keep: the back-off is fixed by the two
   *  STRING carries. `bracket` cannot change its answer, because the line that
   *  closes a bracket holds the `]` or `}` that closes it and is therefore
   *  never blank-or-comment -- a backwards walk stops on that line whether or
   *  not this map is consulted. It is recorded because the map states a fact
   *  about the document rather than a private of one caller, and the next
   *  line-walker will want it; it is not a guard with a consequence to pin. */
  continuedLines: Map<number, TomlLineCarry>;
  /** The file's own line ending, from its first line break. LF when it has none. */
  eol: string;
}

type ScanState = "normal" | "basic" | "literal" | "mlBasic" | "mlLiteral";

const isHorizontalSpace = (c: string | undefined): boolean => c === " " || c === "\t";
const isBareKeyChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_-]$/.test(c);

/** The file's own line ending, read from its first line break. */
export function detectTomlEol(text: string): string {
  const match = /\r\n|\n|\r/.exec(text);
  return match ? match[0] : "\n";
}

/** Offset just past the line break that ends the line holding `from`, or the
 *  text length for a last line with no line break. */
function lineEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  return i < text.length ? i + 1 : i;
}

/** True when [start, end) holds only spaces, tabs and its line break. */
function isBlankLine(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return false;
  }
  return true;
}

/** True when the line's TEXT is blank or holds nothing but a `#` comment.
 *
 *  Text only: it has no idea whether the line began inside a `"""` block, an
 *  `'''` block or an open bracket, where those same characters are string or
 *  array content. Every caller must first exclude such a line with
 *  `TomlScan.continuedLines` -- the back-off below is the only caller, and
 *  doing exactly that is what keeps an insert anchor out of a sibling's
 *  multi-line string. */
function isBlankOrCommentLine(text: string, start: number, end: number): boolean {
  let i = start;
  while (i < end && isHorizontalSpace(text[i])) i++;
  if (i >= end) return true;
  const c = text[i];
  return c === "#" || c === "\n" || c === "\r";
}

/** Decode a TOML basic-string body (the bytes between the quotes).
 *
 *  Covers every escape TOML 1.0 defines plus the two TOML 1.1 additions
 *  smol-toml accepts (`\e` and `\xXX`, measured on 1.8.0). An unknown escape
 *  keeps its backslash rather than throwing: the text has already been
 *  accepted by the parser, so reaching one means this decoder is behind the
 *  grammar, and mangling a KEY is worse than passing it through unchanged. */
function decodeBasicBody(body: string): string {
  if (!body.includes("\\")) return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case "b":
        out += String.fromCharCode(0x08);
        i++;
        break;
      case "t":
        out += String.fromCharCode(0x09);
        i++;
        break;
      case "n":
        out += String.fromCharCode(0x0a);
        i++;
        break;
      case "f":
        out += String.fromCharCode(0x0c);
        i++;
        break;
      case "r":
        out += String.fromCharCode(0x0d);
        i++;
        break;
      case "e":
        out += String.fromCharCode(0x1b);
        i++;
        break;
      case '"':
        out += '"';
        i++;
        break;
      case "\\":
        out += "\\";
        i++;
        break;
      case "x":
      case "u":
      case "U": {
        const width = next === "x" ? 2 : next === "u" ? 4 : 8;
        const hex = body.slice(i + 2, i + 2 + width);
        if (hex.length === width && /^[0-9A-Fa-f]+$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 1 + width;
        } else {
          out += c;
        }
        break;
      }
      default:
        out += c;
        break;
    }
  }
  return out;
}

interface KeyPathRead {
  path: string[];
  /** Offset of the first character after the key path (its terminator). */
  end: number;
}

/** Read a dotted key path at `i`: bare / "basic" / 'literal' segments,
 *  whitespace allowed around the dots. Stops at the first character that
 *  cannot continue the path. Returns an empty path when there is none. */
function readKeyPath(text: string, i: number): KeyPathRead {
  const path: string[] = [];
  let pos = i;
  for (;;) {
    while (isHorizontalSpace(text[pos])) pos++;
    const c = text[pos];
    if (c === '"') {
      const body = readQuoted(text, pos, '"');
      if (body === null) break;
      path.push(decodeBasicBody(body.body));
      pos = body.end;
    } else if (c === "'") {
      const body = readQuoted(text, pos, "'");
      if (body === null) break;
      path.push(body.body);
      pos = body.end;
    } else if (isBareKeyChar(c)) {
      let j = pos;
      while (isBareKeyChar(text[j])) j++;
      path.push(text.slice(pos, j));
      pos = j;
    } else {
      break;
    }
    let after = pos;
    while (isHorizontalSpace(text[after])) after++;
    if (text[after] === ".") {
      pos = after + 1;
      continue;
    }
    pos = after;
    break;
  }
  return { path, end: pos };
}

/** Read a single-line quoted string starting at the quote `pos`. Returns the
 *  body and the offset past the closing quote, or null when unterminated. */
function readQuoted(text: string, pos: number, quote: '"' | "'"): { body: string; end: number } | null {
  let i = pos + 1;
  let body = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r") return null;
    if (quote === '"' && c === "\\") {
      body += c + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === quote) return { body, end: i + 1 };
    body += c;
    i++;
  }
  return null;
}

/** Read a table header at `pos` (which must be a `[`). Returns null when it
 *  does not parse as one. */
function readHeader(text: string, pos: number): { keyPath: string[]; arrayTable: boolean; end: number } | null {
  const arrayTable = text[pos + 1] === "[";
  const read = readKeyPath(text, pos + (arrayTable ? 2 : 1));
  if (read.path.length === 0) return null;
  let i = read.end;
  while (isHorizontalSpace(text[i])) i++;
  if (text[i] !== "]") return null;
  i++;
  if (arrayTable) {
    if (text[i] !== "]") return null;
    i++;
  }
  return { keyPath: read.path, arrayTable, end: i };
}

/** Scan `text` into table sections and `key = value` assignments.
 *
 *  A single forward pass, line by line, carrying the string state and the
 *  value-bracket depth across line boundaries. The point of the carry is that
 *  a header is only ever recognised on a line that STARTS in normal state at
 *  depth 0 -- so `[mcp_servers.fake]` inside a `"""` block, a `'''` block or a
 *  multi-line array is text, not a table, which is exactly the case a
 *  line-oriented regex scan gets wrong.
 *
 *  The same carry is recorded per line in `continuedLines`, because a line
 *  inside a multi-line string or an open bracket also has to be invisible to
 *  the `contentEnd` back-off below, which walks lines by their text.
 *
 *  Pure and total: it never throws and it never needs the document to be
 *  valid. It is nonetheless only ever run on text the parser has already
 *  accepted, and the splice's post-write verification is what turns a mistake
 *  here into a refusal. */
export function scanTomlSections(text: string): TomlScan {
  const sections: TomlSection[] = [];
  const assignments: TomlAssignment[] = [];
  const continuedLines = new Map<number, TomlLineCarry>();
  let section: string[] = [];
  let state: ScanState = "normal";
  let depth = 0;
  // A leading BOM sits on the first line but is part of no key and belongs to
  // no table, so the first line is treated as starting AFTER it. That is what
  // keeps the BOM outside every span: a `[mcp_servers.mcp]` on line 1 of a
  // Notepad-saved file would otherwise carry the BOM into its own span, and
  // replacing that table would silently strip it.
  let pos = bomOffset(text);
  let lineStart = pos;

  while (pos < text.length || lineStart < text.length) {
    const end = lineEnd(text, pos);
    // Record what carried INTO this line before reading a character of it: the
    // same fact that stops a `[header]` being recognised here is the fact a
    // line-walking back-off needs later.
    if (state === "mlBasic" || state === "mlLiteral") continuedLines.set(lineStart, state);
    else if (depth > 0) continuedLines.set(lineStart, "bracket");
    if (state === "normal" && depth === 0) {
      let i = pos;
      while (isHorizontalSpace(text[i])) i++;
      const c = text[i];
      if (c === "[") {
        const header = readHeader(text, i);
        if (header !== null) {
          sections.push({
            keyPath: header.keyPath,
            arrayTable: header.arrayTable,
            start: lineStart,
            headerEnd: end,
            contentEnd: end,
            end,
          });
          section = header.keyPath;
          pos = header.end;
        }
      } else if (c !== undefined && c !== "#" && c !== "\n" && c !== "\r") {
        const read = readKeyPath(text, i);
        if (read.path.length > 0) {
          let eq = read.end;
          while (isHorizontalSpace(text[eq])) eq++;
          if (text[eq] === "=") {
            let v = eq + 1;
            while (isHorizontalSpace(text[v])) v++;
            assignments.push({
              section,
              keyPath: read.path,
              inlineTable: text[v] === "{",
              start: lineStart,
            });
            pos = eq + 1;
          }
        }
      }
    }
    // Advance the state machine over the rest of the line, then hand the
    // carry (string state and bracket depth -- a key-value expression itself
    // ends with its line) to the next one.
    ({ state, depth } = scanSpan(text, pos, end, state, depth));
    lineStart = end;
    pos = end;
    if (lineStart >= text.length) break;
  }

  // Section boundaries: `end` runs to the next header, `contentEnd` backs off
  // the trailing blank and comment lines.
  for (let s = 0; s < sections.length; s++) {
    const self = sections[s];
    self.end = s + 1 < sections.length ? sections[s + 1].start : text.length;
    let contentEnd = self.end;
    while (contentEnd > self.headerEnd) {
      const prevStart = lineStartBefore(text, contentEnd);
      // A line that began inside a multi-line string or an open bracket is
      // the VALUE of the key above it, whatever it looks like: `# closes
      // it"""` ends a string and a spaces-only line inside `"""` is content.
      // Backing off over one would put a replace or an insert anchor INSIDE
      // that value, which writes our table into the middle of a sibling's
      // string -- valid TOML that loads, with our entry nowhere in it.
      if (continuedLines.has(prevStart)) break;
      if (!isBlankOrCommentLine(text, prevStart, contentEnd)) break;
      contentEnd = prevStart;
    }
    self.contentEnd = Math.max(contentEnd, self.headerEnd);
  }

  return { sections, assignments, continuedLines, eol: detectTomlEol(text) };
}

/** The start offset of the line that ENDS at `end` (`end` is just past a line
 *  break, or the text length). */
function lineStartBefore(text: string, end: number): number {
  let i = end;
  if (i > 0 && text[i - 1] === "\n") i--;
  if (i > 0 && text[i - 1] === "\r") i--;
  while (i > 0 && text[i - 1] !== "\n" && text[i - 1] !== "\r") i--;
  return i;
}

/** Advance the string/bracket state machine over [from, to). */
function scanSpan(
  text: string,
  from: number,
  to: number,
  state: ScanState,
  depth: number,
): { state: ScanState; depth: number } {
  let i = from;
  while (i < to) {
    const c = text[i];
    switch (state) {
      case "normal":
        if (c === "#") {
          i = to;
          continue;
        }
        if (c === '"') {
          if (text[i + 1] === '"' && text[i + 2] === '"') {
            state = "mlBasic";
            i += 3;
            continue;
          }
          state = "basic";
          i++;
          continue;
        }
        if (c === "'") {
          if (text[i + 1] === "'" && text[i + 2] === "'") {
            state = "mlLiteral";
            i += 3;
            continue;
          }
          state = "literal";
          i++;
          continue;
        }
        if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
        i++;
        continue;
      case "basic":
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"') state = "normal";
        i++;
        continue;
      case "literal":
        if (c === "'") state = "normal";
        i++;
        continue;
      case "mlBasic":
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          i += 3;
          // TOML allows up to two extra quotes immediately after the
          // delimiter (`"""he said """"` closes with the last three), so a
          // run of 4 or 5 quotes still ends the string here. The bound is
          // tested BEFORE the character: `to` always lands on a line break
          // today, so the other order read a character it had no business
          // reading and happened to get away with it.
          while (i < to && text[i] === '"') i++;
          state = "normal";
          continue;
        }
        i++;
        continue;
      case "mlLiteral":
        if (c === "'" && text[i + 1] === "'" && text[i + 2] === "'") {
          i += 3;
          // Bound first, as above.
          while (i < to && text[i] === "'") i++;
          state = "normal";
          continue;
        }
        i++;
        continue;
    }
  }
  // A line break ends a single-line string and a key-value expression; only
  // the multi-line states and an open bracket carry to the next line.
  if (state === "basic" || state === "literal") state = "normal";
  return { state, depth };
}

const pathStartsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((seg, i) => path[i] === seg);

const pathEquals = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** A TOML key: bare when it can be, else a quoted basic string.
 *
 *  The bare set is TOML's own (`A-Za-z0-9_-`), so `mcp` stays bare and
 *  `mcp.hosting` is quoted. Unquoted, `[mcp_servers.mcp.hosting]` would name a
 *  SUB-table `hosting` of the entry `mcp` -- a different server, which Codex
 *  then rejects as having no transport. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A TOML basic string.
 *
 *  `JSON.stringify` does almost all of it: every escape it emits (`\" \\ \b
 *  \f \n \r \t \uXXXX`) is a valid TOML basic-string escape, and it escapes
 *  the whole C0 range. TWO deltas, both measured against smol-toml 1.8.0:
 *
 *  - U+007F (DEL) is left RAW by JSON.stringify and forbidden raw in a TOML
 *    string ("control characters are not allowed in strings"), so it is
 *    rewritten to `\u007F`.
 *  - A lone surrogate is emitted by JSON.stringify as a `\udXXX` escape --
 *    well-formed JSON since ES2019 -- and smol-toml rejects that escape
 *    ("invalid unicode escape"), because TOML escapes denote Unicode SCALAR
 *    values. There is no spelling to fall back to, so this throws. */
export function tomlString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TomlRenderError(
          `cannot write a lone surrogate (U+${code.toString(16).toUpperCase()}) into TOML: a TOML string holds Unicode scalar values only -- fix the value, then re-run`,
        );
      }
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TomlRenderError(
        `cannot write a lone surrogate (U+${code.toString(16).toUpperCase()}) into TOML: a TOML string holds Unicode scalar values only -- fix the value, then re-run`,
      );
    }
  }
  // String.fromCharCode, never a typed escape: a `\x7f` in this source could
  // collapse to the raw byte on its way through a shell heredoc.
  return JSON.stringify(value).split(String.fromCharCode(0x7f)).join("\\u007F");
}

/** Codex writes `startup_timeout_sec` and `tool_timeout_sec` from an f64
 *  (`Duration::as_secs_f64`), so `60` renders `60.0`. Matching that spelling
 *  is what makes a Codex re-serialisation of our block a no-op rather than a
 *  one-line diff the next install would report as drift. */
const FLOAT_FIELDS = new Set(["startup_timeout_sec", "tool_timeout_sec"]);

function tomlNumber(value: number | bigint, key: string): string {
  if (typeof value === "bigint") return value.toString();
  if (!Number.isFinite(value)) {
    throw new TomlRenderError(`cannot write ${String(value)} as the "${key}" value: it is not a finite number`);
  }
  if (FLOAT_FIELDS.has(key) && Number.isInteger(value)) return `${value}.0`;
  return String(value);
}

/** A scalar or array value, as it appears to the right of `=`. */
function tomlValue(value: unknown, key: string): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "bigint") return tomlNumber(value, key);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => tomlArrayItem(item, key)).join(", ")}]`;
  throw new TomlRenderError(
    `cannot write the "${key}" field as TOML: ${describeTomlShape(value)} has no spelling this writer produces -- edit it by hand`,
  );
}

/** An array item. Codex's `env_vars` holds either a bare name or a
 *  `{ name = "...", source = "..." }` inline table, so a plain object item is
 *  rendered as an inline table; anything deeper is refused. */
function tomlArrayItem(item: unknown, key: string): string {
  if (isTomlTable(item)) {
    const pairs = Object.entries(item).filter(([, v]) => v !== undefined);
    for (const [k, v] of pairs) {
      if (isTomlTable(v) || Array.isArray(v)) {
        throw new TomlRenderError(
          `cannot write the "${key}" field as TOML: its inline table has a nested "${k}" -- edit it by hand`,
        );
      }
    }
    return `{ ${pairs.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v, k)}`).join(", ")} }`;
  }
  return tomlValue(item, key);
}

// DECISION -- what happens to a field this renderer cannot spell (2026-09-11).
//
// `--repair` re-renders our entry from the fields read back off disk, so
// anything the renderer cannot spell is a field the re-render would DROP. The
// two that matter are Codex's own `oauth` and `tools` tables: a user who hand
// wrote `[mcp_servers.mcp.tools.echo]` on OUR entry has a table we can read and
// cannot write.
//
// CHOSEN: refuse, naming the field. `renderTomlEntry` throws `TomlRenderError`
// for any table-valued field outside `SUBTABLE_FIELDS`, the message names the
// field and says the re-render would drop it, and because every write verifies
// its own output there is no path that drops it quietly. The user keeps the
// table; the write is what fails.
//
// REJECTED: carry both through the re-render. It is the nicer outcome and it
// is a bigger change than it looks -- `tools` is an IMPLICIT parent with
// explicit children (`[mcp_servers.mcp.tools.echo]` with no
// `[mcp_servers.mcp.tools]` header above it), so `renderTomlEntry` would have
// to emit a header shape it emits nowhere else, and `oauth` is a table of
// typed scalars Codex re-serializes with its own unknown-key drop. Neither
// layout is exercised by anything this package writes, so the code would ship
// untested against a real Codex -- which is the state that produced the
// "verified by round-trip, never loaded" fixtures this adapter exists to
// avoid. A loud refusal costs the user one manual edit; a guessed layout costs
// them their config.
//
// So `FIELD_ORDER` below lists `oauth` and `tools` (this writer knows they
// exist and where they sit) while `SUBTABLE_FIELDS` does not (it cannot write
// them). If the codex-cli target package ever needs to carry them, the work is
// in `renderTomlEntry`'s sub-table branch plus fixtures loaded by a real
// codex -- not in `FIELD_ORDER`.

/** Codex's own serializer order (`serialize_mcp_server_table`), so that a
 *  later `codex mcp add <other>` -- which re-serializes every entry -- rewrites
 *  our block to the bytes it already has.
 *
 *  stdio first (command, args, env, env_vars, cwd), then the HTTP transport's
 *  fields, then the shared tail. `env` appears in this list for ordering only:
 *  it is written as a sub-table AFTER every key-value line, which is where
 *  toml_edit puts a non-inline table too.
 *
 *  MEASURED, not read out of the vendor's source, which 0.144.0 ships as a
 *  binary: a config.toml carrying every field below was re-serialized by
 *  `codex mcp add <other>` under a scratch CODEX_HOME, and the order it wrote
 *  back is the order below. That was repeated per VALUE where a field turned
 *  out to have a value-dependent answer (the third bullet). Three results are
 *  worth naming, because each is a claim this comment would make for free:
 *
 *   - `http_headers_helper` and `omit_tools_from` came back DROPPED, so
 *     0.144.0 has no such fields and their place here is NOT vendor-verified.
 *     They stay because a neighbouring version may know them and this list
 *     costs nothing; nothing in this package ever writes either.
 *   - `oauth` and `tools` are TABLES wherever they appear (`SUBTABLE_FIELDS`),
 *     so their position among key-value LINES is not observable and this run
 *     is no evidence about it. The renderer refuses a table outside
 *     `SUBTABLE_FIELDS`, so the only value that can reach either slot is a
 *     hand-written scalar of that name -- which Codex itself rejects.
 *   - `enabled` and `auth` each came back in the position below, but each for
 *     only ONE of its values: `enabled = false` survived where `enabled =
 *     true` was dropped, and `auth = "chatgpt"` survived where `auth =
 *     "oauth"` was dropped. Those two spellings are the whole of `auth`
 *     ("unknown variant `none`, expected `oauth` or `chatgpt`"), and it is
 *     HTTP-only: on a stdio entry 0.144.0 refuses the whole config with "auth
 *     is not supported for stdio". Reading that as a serializer skipping a
 *     field at its default is an inference, not something measured -- what is
 *     measured is the asymmetry, and its consequence for this list: a dropped
 *     VALUE is no evidence against a FIELD, so `auth` is placed here on the
 *     `chatgpt` run and not moved into the sentence above on the `oauth` one.
 *
 *  The Rust names this file cites -- `serialize_mcp_server_table` here,
 *  `table_from_pairs` and `entries.sort_by_key` at the renderer,
 *  `Duration::as_secs_f64` at `FLOAT_FIELDS`, `toml_edit` above -- came from
 *  the design pass's read of the vendor source and are NOT re-verified here;
 *  0.144.0 ships a binary. They are labels for behaviour that was measured,
 *  so treat a mismatch in a name as a stale label and the measured behaviour
 *  as the claim.
 *
 *  A table-valued `oauth` or `tools` is therefore a `TomlRenderError` naming
 *  the field. That refusal is the deliberate choice: our entry never carries
 *  either, and a user who hand-wrote one keeps it (the write fails, loudly)
 *  instead of having it dropped or re-rendered into a guessed layout. */
const FIELD_ORDER = [
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "url",
  "bearer_token_env_var",
  "http_headers",
  "env_http_headers",
  "http_headers_helper",
  "auth",
  "enabled",
  "environment_id",
  "required",
  "supports_parallel_tool_calls",
  "omit_tools_from",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "default_tools_approval_mode",
  "enabled_tools",
  "disabled_tools",
  "scopes",
  "oauth",
  "oauth_resource",
  "tools",
];

/** Field keys rendered as their own `[<container>.<name>.<key>]` sub-table.
 *
 *  The three Codex writes as a flat, explicit table of string pairs, which is
 *  exactly the layout below. It writes FIVE fields as tables in all -- MEASURED
 *  on codex-cli 0.144.0, by handing it an entry carrying each and reading back
 *  what `codex mcp add <other>` re-serialized:
 *
 *      [mcp_servers.hh.http_headers]      explicit, flat, sorted
 *      [mcp_servers.hh.env_http_headers]  explicit, flat, sorted
 *      [mcp_servers.zz.env]               explicit, flat, sorted
 *      [mcp_servers.hh.oauth]             explicit, flat -- but NOT a string
 *                                         map: an unknown key inside it
 *                                         (`issuer`) was dropped
 *      [mcp_servers.zz.tools.echo]        IMPLICIT parent, explicit child --
 *                                         no [.tools] header is written
 *
 *  The last two are deliberately absent here. Neither is a flat string map,
 *  `tools` needs a layout this writer does not produce at all, and our own
 *  entry never carries either. A table-valued `oauth` or `tools` is therefore
 *  a `TomlRenderError` that names the field -- the write fails and the user's
 *  hand-written table survives untouched, which beats dropping it or guessing
 *  a layout. See the decision note above `FIELD_ORDER`. */
const SUBTABLE_FIELDS = new Set(["env", "http_headers", "env_http_headers"]);

/** Order two sub-table keys the way Codex's `entries.sort_by_key` does:
 *  Rust's `Ord for String` is a byte comparison of the UTF-8 encoding, so this
 *  compares the UTF-8 bytes rather than the JS string.
 *
 *  The two orders disagree above the BMP, and a JS `<` would be wrong there:
 *  measured, `U+1F600` sorts BEFORE `U+E000` by UTF-16 code unit (`0xD83D` <
 *  `0xE000`) and AFTER it by UTF-8 byte (`f0 9f 98 80` > `ee 80 80`). Only an
 *  env var NAME with an astral character reaches the difference, and the cost
 *  of getting it wrong is only a one-line drift diff on the next install --
 *  but the claim is cheap to make true, so it is true.
 *
 *  A lone surrogate has no UTF-8 encoding and `Buffer.from` substitutes
 *  U+FFFD, so such a key sorts as the replacement character and then throws in
 *  `tomlString` when it is rendered. The throw is the answer either way. */
const byUtf8Bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function orderedFields(entry: Record<string, unknown>): string[] {
  const present = Object.keys(entry).filter((k) => entry[k] !== undefined);
  const known = FIELD_ORDER.filter((k) => present.includes(k));
  const unknown = present.filter((k) => !FIELD_ORDER.includes(k)).sort(byUtf8Bytes);
  return [...known, ...unknown];
}

/** Render one `[<container>.<name>]` table, plus its sub-tables, ending with a
 *  line break. `eol` defaults to LF.
 *
 *  Sub-table keys are sorted, because Codex's `table_from_pairs` sorts them
 *  (`entries.sort_by_key` over Rust `String`s) -- UTF-8 byte order over the
 *  DECODED key, not the quoted spelling; see `byUtf8Bytes`, which is where the
 *  above-the-BMP disagreement with a JS string compare lives. An unknown
 *  scalar field keeps its place after the known ones, in the same UTF-8 byte
 *  order, so the output is a function of the entry's content and not of its JS
 *  key insertion order. (Codex never writes an unknown field at all -- it
 *  drops what its struct has no room for -- so that order matches no vendor
 *  behaviour; it only has to be stable.)
 *
 *  TWO OMISSIONS, and they are the only ones: a field whose value is
 *  `undefined` (it has no TOML spelling), and a sub-table field whose table is
 *  empty (`env: {}` writes no `[...env]` header, matching Codex's
 *  `!env.is_empty()`). `entryAsWritten` applies the same two rules, so the
 *  post-write check compares like with like.
 *
 *  An EMPTY ARRAY is written, as `args = []`. Codex omits an empty `args` when
 *  IT serializes, so a later `codex mcp add <other>` would drop that one line;
 *  the entry means the same with or without it, and writing it keeps the
 *  round-trip exact. No caller here produces an empty `args`. */
export function renderTomlEntry(
  containerPath: readonly string[],
  name: string,
  entry: Record<string, unknown>,
  eol = "\n",
): string {
  const header = [...containerPath, name].map(tomlKey).join(".");
  const fields = orderedFields(entry);
  const lines: string[] = [`[${header}]`];
  const subTables: string[] = [];
  for (const key of fields) {
    const value = entry[key];
    if (SUBTABLE_FIELDS.has(key)) {
      if (!isTomlTable(value)) {
        throw new TomlRenderError(
          `cannot write the "${key}" field as TOML: it is ${describeTomlShape(value)}, not a table of "NAME" = "value" pairs`,
        );
      }
      const pairs = Object.entries(value).filter(([, v]) => v !== undefined);
      if (pairs.length === 0) continue;
      pairs.sort(([a], [b]) => byUtf8Bytes(a, b));
      subTables.push(
        [`[${header}.${tomlKey(key)}]`, ...pairs.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v, k)}`)].join(eol),
      );
      continue;
    }
    if (isTomlTable(value)) {
      // Name the field AND the loss. This is the refusal the decision note
      // above `FIELD_ORDER` chose over dropping the table silently, so the
      // message has to say what would have been dropped.
      throw new TomlRenderError(
        `cannot write the "${key}" field of the "${name}" entry: only ${[...SUBTABLE_FIELDS].map((k) => `"${k}"`).join(", ")} are written as sub-tables, so rewriting this entry would drop your "${key}" table -- move it to another server or delete it, then re-run`,
      );
    }
    lines.push(`${tomlKey(key)} = ${tomlValue(value, key)}`);
  }
  return [lines.join(eol), ...subTables].join(`${eol}${eol}`) + eol;
}

/** `entry` as it will read back once written: the renderer's two omissions
 *  (see `renderTomlEntry`) applied. The post-write check compares the stored
 *  table against THIS, so an omission is verified rather than assumed. */
export function entryAsWritten(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entry)) {
    const value = entry[key];
    if (value === undefined) continue;
    if (SUBTABLE_FIELDS.has(key) && isTomlTable(value)) {
      const pairs = Object.entries(value).filter(([, v]) => v !== undefined);
      if (pairs.length === 0) continue;
      out[key] = Object.fromEntries(pairs);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read / classify
// ---------------------------------------------------------------------------

export interface TomlEntryView {
  key: string;
  value: unknown;
}

export type TomlConfigRead =
  /** No file, or nothing but whitespace (Codex reads both as an empty table). */
  | { kind: "absent" }
  /** Does not parse. `detail` is "line L, column C: <reason>". */
  | { kind: "malformed"; syntax: typeof TOML_SYNTAX; reason: string; line: number; column: number; detail: string }
  /** The container key exists and is not a table. Never reparable: Codex
   *  refuses to load such a file, and repairing it would mean rewriting a
   *  root key-value line -- a second kind of splice, for a shape no tool
   *  writes. */
  | { kind: "blocked"; path: string[]; shape: string; reparable: false }
  /** Parses, but one of the named entries is in a spelling the splice will not
   *  REWRITE. `removable` is true for the one such shape it can still delete
   *  (an `[[array of tables]]` entry, which is whole lines): uninstall may
   *  proceed on it, install may not. */
  | { kind: "unspliceable"; key: string; shape: string; remedy: string; removable: boolean }
  | { kind: "ok"; containerPresent: boolean; entries: TomlEntryView[] };

/** Parse and classify a config.toml text.
 *
 *  `entryNames` are the entries the caller intends to WRITE (ours plus the
 *  legacy spellings). They are checked for spliceability, so install learns
 *  "your `mcp` entry is an inline table" from the read rather than from a
 *  throw halfway through a write. Pass none for a pure read. */
export function readTomlConfig(
  raw: string,
  containerPath: readonly string[],
  entryNames: readonly string[] = [],
): TomlConfigRead {
  if (raw.trim() === "") return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = parseTomlConfig(raw);
  } catch (e) {
    if (e instanceof TomlConfigError) {
      return {
        kind: "malformed",
        syntax: TOML_SYNTAX,
        reason: e.reason,
        line: e.line,
        column: e.column,
        detail: e.detail,
      };
    }
    throw e;
  }
  if (!isTomlTable(parsed)) {
    // Unreachable with smol-toml, whose parse result is always a table; kept
    // so the walk below cannot be reached with a non-table root.
    return { kind: "blocked", path: [], shape: describeTomlShape(parsed), reparable: false };
  }
  let cursor: Record<string, unknown> = parsed;
  for (let i = 0; i < containerPath.length; i++) {
    const key = containerPath[i];
    if (!(key in cursor)) return { kind: "ok", containerPresent: false, entries: [] };
    const next = cursor[key];
    if (!isTomlTable(next)) {
      return {
        kind: "blocked",
        path: containerPath.slice(0, i + 1) as string[],
        shape: describeTomlShape(next),
        reparable: false,
      };
    }
    cursor = next;
  }
  const scan = scanTomlSections(raw);
  for (const name of entryNames) {
    const problem = entryShapeProblem(scan, parsed, containerPath, name);
    if (problem !== null) {
      return {
        kind: "unspliceable",
        key: name,
        shape: problem.shape,
        remedy: problem.remedy,
        removable: problem.removable,
      };
    }
  }
  // Object key order is the file's own table order (smol-toml inserts as it
  // parses), which is what `--list` and import report.
  const entries = Object.keys(cursor).map((key) => ({ key, value: cursor[key] }));
  return { kind: "ok", containerPresent: true, entries };
}

/** The named entry's decoded fields, or undefined when it is absent or is not
 *  a table (an entry Codex itself refuses to load). */
export function tomlEntryFields(read: TomlConfigRead, name: string): Record<string, unknown> | undefined {
  if (read.kind !== "ok") return undefined;
  const found = read.entries.find((e) => e.key === name);
  if (found === undefined || !isTomlTable(found.value)) return undefined;
  return found.value;
}

/** The server names the container holds, in file order. */
export function tomlEntryNames(read: TomlConfigRead): string[] {
  return read.kind === "ok" ? read.entries.map((e) => e.key) : [];
}

interface ShapeProblem {
  shape: string;
  remedy: string;
  /** True when `removeTomlEntry` can still delete it: the entry occupies whole
   *  lines under a header, so there is a span to take. False when there is no
   *  header at all (an inline table or dotted keys), which is the case nothing
   *  here edits. */
  removable: boolean;
}

/** Why the span splice will not edit `name`, or null when it will.
 *
 *  The question is not "is the entry there" -- it is "is the entry a
 *  `[container.name]` TABLE". A dotted key or an inline table means the same
 *  thing to Codex and cannot be replaced by taking a header's lines: there is
 *  no header to take, and TOML forbids extending an inline table with a later
 *  one (measured: smol-toml and Codex both reject `mcp_servers = {...}`
 *  followed by `[mcp_servers.mcp.env]` as a redefinition). */
function entryShapeProblem(
  scan: TomlScan,
  parsed: Record<string, unknown>,
  containerPath: readonly string[],
  name: string,
): ShapeProblem | null {
  const entryPath = [...containerPath, name];
  const headerLabel = `[${entryPath.map(tomlKey).join(".")}]`;
  const containerLabel = containerPath.map(tomlKey).join(".");
  const own = scan.sections.filter((s) => pathEquals(s.keyPath, entryPath));
  if (own.some((s) => s.arrayTable)) {
    return {
      shape: `an array of tables ([[${entryPath.map(tomlKey).join(".")}]])`,
      remedy: `Codex reads a server as a single table, so make it one ${headerLabel} table (or remove it), then re-run`,
      removable: true,
    };
  }
  if (own.length > 0) return null;
  if (!entryExistsInParsed(parsed, entryPath)) return null;

  const rootDotted = scan.assignments.some(
    (a) => a.section.length === 0 && a.keyPath.length > 1 && pathStartsWith(a.keyPath, entryPath),
  );
  if (rootDotted) {
    return {
      shape: `written as dotted keys at the top level (${entryPath.join(".")}.command = ...)`,
      remedy: `only a ${headerLabel} table can be rewritten in place -- replace those lines with the table below by hand (or delete them and re-run)`,
      removable: false,
    };
  }
  const inContainer = scan.assignments.filter((a) => pathEquals(a.section, containerPath) && a.keyPath[0] === name);
  if (inContainer.some((a) => a.keyPath.length > 1)) {
    return {
      shape: `written as dotted keys under [${containerLabel}] (${name}.command = ...)`,
      remedy: `only a ${headerLabel} table can be rewritten in place -- replace those lines with the table below by hand (or delete them and re-run)`,
      removable: false,
    };
  }
  if (inContainer.some((a) => a.inlineTable)) {
    return {
      shape: `an inline table under [${containerLabel}] (${name} = { ... })`,
      remedy: `only a ${headerLabel} table can be rewritten in place -- replace that line with the table below by hand (or delete it and re-run)`,
      removable: false,
    };
  }
  if (rootContainerIsInline(scan, containerPath)) {
    return {
      shape: `inside the inline table ${containerLabel} = { ... }`,
      remedy: `TOML cannot extend an inline table with a later table, so convert it to ${headerLabel}-style tables by hand, then re-run`,
      removable: false,
    };
  }
  return {
    shape: `not written as a ${headerLabel} table`,
    remedy: `only a ${headerLabel} table can be rewritten in place -- replace it with the table below by hand (or delete it and re-run)`,
    removable: false,
  };
}

function entryExistsInParsed(parsed: Record<string, unknown>, entryPath: readonly string[]): boolean {
  let cursor: unknown = parsed;
  for (const key of entryPath) {
    if (!isTomlTable(cursor) || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  return true;
}

/** True when the container key itself is a root-level inline table
 *  (`mcp_servers = { ... }`). Such a file cannot gain `[mcp_servers.<name>]`
 *  at all -- the header re-defines a value that already exists. */
function rootContainerIsInline(scan: TomlScan, containerPath: readonly string[]): boolean {
  return scan.assignments.some(
    (a) => a.section.length === 0 && pathStartsWith(containerPath, a.keyPath) && a.inlineTable,
  );
}

// ---------------------------------------------------------------------------
// Splice
// ---------------------------------------------------------------------------

interface SpanEdit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: SpanEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      throw new TomlVerifyError(
        `internal error: overlapping TOML edits at offset ${edit.start} -- nothing was written`,
      );
    }
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/** The whole-line spans to delete for a set of sections.
 *
 *  Sections of the same entry that are separated by nothing but blank lines
 *  are merged first -- that separator is ours as well -- and each merged region
 *  then gives up ONE adjacent blank line so the deletion cannot leave a double
 *  blank, a blank line at EOF, or a file that opens on an empty line.
 *
 *  The blank taken is the one BEFORE the region, which is the one the insert
 *  put there: that is what makes `remove(upsert(x))` return `x` byte for byte.
 *  A region at the very start of the file has no blank before it, so there the
 *  blank after it goes instead. */
function deleteSectionEdits(text: string, sections: readonly TomlSection[]): SpanEdit[] {
  const spans = sections.map((s) => ({ start: s.start, end: s.contentEnd })).sort((a, b) => a.start - b.start);
  const regions: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = regions[regions.length - 1];
    if (last !== undefined && (span.start <= last.end || isBlankLine(text, last.end, span.start))) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    regions.push({ ...span });
  }
  return regions.map(({ start, end }) => {
    const bom = bomOffset(text);
    const beforeStart = lineStartBefore(text, start);
    const beforeIsBlank = start > bom && isBlankLine(text, beforeStart, start);
    const afterEnd = lineEnd(text, end);
    const afterIsBlank = end < text.length && isBlankLine(text, end, afterEnd);
    if (beforeIsBlank && (afterIsBlank || end >= text.length)) return { start: beforeStart, end, text: "" };
    if (start === bom && afterIsBlank) return { start, end: afterEnd, text: "" };
    return { start, end, text: "" };
  });
}

export interface UpsertTomlOptions {
  /** Legacy entry names this write also REMOVES. When `name` is absent and a
   *  legacy table is present, the new table takes the place of the FIRST
   *  legacy table in file order and every listed legacy table is deleted, so
   *  a migration is one write with the entry where the user last saw it.
   *  A legacy entry in an unspliceable spelling refuses the whole write. */
  replaceLegacy?: readonly string[];
}

/** Upsert one `[<containerPath>.<name>]` table into `raw`, returning the new
 *  text.
 *
 *  `raw` null (no file), empty or whitespace-only renders the table on its own
 *  -- Codex reads a missing and an empty config.toml the same way.
 *
 *  An existing table is replaced IN PLACE (its lines, and the lines of its
 *  sub-tables wherever they sit in the file). An absent one is APPENDED after
 *  the last table of the container, or at end of file when the container has
 *  none, separated by one blank line on each side that needs one. Every other
 *  byte -- comments, blank lines, key order, `'literal'` quoting, `20` staying
 *  `20`, CRLF, a leading BOM, indentation -- is outside the spliced range and
 *  survives.
 *
 *  Throws `TomlConfigError` when `raw` does not parse, `TomlSpliceRefusal` for
 *  a spelling the splice will not edit (naming it and what to do), and
 *  `TomlVerifyError` when the result would have changed anything else. The
 *  returned text has always passed `verifyTomlSplice`. */
export function upsertTomlEntry(
  raw: string | null,
  containerPath: readonly string[],
  name: string,
  entry: Record<string, unknown>,
  options: UpsertTomlOptions = {},
): string {
  const legacyNames = options.replaceLegacy ?? [];
  if (raw === null || raw.trim() === "") {
    // A missing file and an empty one are the same to Codex (a missing
    // config.toml loads as an empty table), so both get the table on its own.
    // A whitespace-only file's line ending is still worth copying; its
    // whitespace, and a lone BOM, are not carried -- there is nothing in them
    // to preserve.
    const fresh = renderTomlEntry(containerPath, name, entry, raw === null ? "\n" : detectTomlEol(raw));
    verifyTomlSplice("", fresh, containerPath, { upsert: { name, entry } });
    return fresh;
  }
  const parsed = parseTomlConfig(raw);
  if (!isTomlTable(parsed)) {
    throw new TomlSpliceRefusal("the document root", "not a TOML table", "fix the file by hand, then re-run");
  }
  const container = containerValue(parsed, containerPath);
  if (container !== undefined && !isTomlTable(container)) {
    throw new TomlSpliceRefusal(
      `"${containerPath.join(".")}"`,
      `${describeTomlShape(container)}, not a TOML table`,
      "make it a table (or remove the key), then re-run",
    );
  }
  const scan = scanTomlSections(raw);
  refuseUnspliceable(scan, parsed, containerPath, [name, ...legacyNames]);

  const eol = scan.eol;
  const block = renderTomlEntry(containerPath, name, entry, eol);
  const entryPath = [...containerPath, name];
  const edits: SpanEdit[] = [];

  const ownSections = scan.sections.filter((s) => pathStartsWith(s.keyPath, entryPath));
  const legacySections = legacyNames.flatMap((legacy) =>
    scan.sections.filter((s) => pathStartsWith(s.keyPath, [...containerPath, legacy])),
  );
  const anchor = ownSections[0] ?? legacySections[0];

  if (anchor !== undefined) {
    // Replace the first table of the entry (or of the legacy entry it
    // supersedes) and delete every other table belonging to either -- a
    // detached `[mcp_servers.mcp.env]` further down the file included.
    edits.push({ start: anchor.start, end: anchor.contentEnd, text: block });
    edits.push(
      ...deleteSectionEdits(
        raw,
        [...ownSections, ...legacySections].filter((s) => s !== anchor),
      ),
    );
  } else {
    if (rootContainerIsInline(scan, containerPath)) {
      throw new TomlSpliceRefusal(
        `"${containerPath.join(".")}"`,
        "an inline table, which cannot gain an entry without rewriting it",
        `convert it to [${[...containerPath, name].map(tomlKey).join(".")}]-style tables by hand, then re-run`,
      );
    }
    edits.push(insertEdit(raw, scan, containerPath, block, eol));
  }

  const next = applyEdits(raw, edits);
  verifyTomlSplice(raw, next, containerPath, { upsert: { name, entry }, removed: legacyNames });
  return next;
}

/** Remove one `[<containerPath>.<name>]` table, and its sub-tables, from
 *  `raw`.
 *
 *  Returns `raw` ITSELF -- the same string, byte for byte, BOM included --
 *  whenever there is nothing to remove: when the entry is absent, and when the
 *  file is empty or holds nothing but whitespace (never `""`, which would read
 *  as "I rewrote your file to nothing"). That is the contract
 *  `removeJsoncEntry` already has and that try's cleanup and doctor's GC
 *  depend on (`next === raw` means "nothing to do", so they neither write nor
 *  report a removal).
 *
 *  Deleting takes the table's own lines and one blank line above it when the
 *  deletion would otherwise leave a double blank or a trailing blank at EOF.
 *  A comment ABOVE the header stays -- it is attributed to what follows, the
 *  same way the JSONC removal keeps a comment on the previous member's line.
 *
 *  It removes anything that HAS a header, `[[array of tables]]` included: that
 *  is whole lines, and taking them is exactly what was asked. Only a spelling
 *  with no header at all (an inline table, dotted keys) is refused -- there is
 *  no span to delete, and rewriting the line it shares with other keys is not
 *  something this splice does. `upsertTomlEntry` is stricter: it also refuses
 *  the array-of-tables shape, because collapsing an array into one table can
 *  drop a second definition the user wrote. */
export function removeTomlEntry(raw: string, containerPath: readonly string[], name: string): string {
  if (raw.trim() === "") return raw;
  const parsed = parseTomlConfig(raw);
  if (!isTomlTable(parsed)) return raw;
  const scan = scanTomlSections(raw);
  const entryPath = [...containerPath, name];
  const sections = scan.sections.filter((s) => pathStartsWith(s.keyPath, entryPath));
  if (sections.length === 0) {
    // Absent -> the no-op contract. Present but not a table -> refuse, naming
    // the spelling; silently reporting "removed" would be a lie.
    refuseUnspliceable(scan, parsed, containerPath, [name]);
    return raw;
  }
  const next = applyEdits(raw, deleteSectionEdits(raw, sections));
  verifyTomlSplice(raw, next, containerPath, { removed: [name] });
  return next;
}

function containerValue(parsed: Record<string, unknown>, containerPath: readonly string[]): unknown {
  let cursor: unknown = parsed;
  for (const key of containerPath) {
    if (!isTomlTable(cursor)) return undefined;
    if (!(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function refuseUnspliceable(
  scan: TomlScan,
  parsed: Record<string, unknown>,
  containerPath: readonly string[],
  names: readonly string[],
): void {
  for (const name of names) {
    const problem = entryShapeProblem(scan, parsed, containerPath, name);
    if (problem !== null) {
      throw new TomlSpliceRefusal(`the "${name}" entry`, problem.shape, problem.remedy);
    }
  }
}

/** Where a NEW table goes, and the blank lines around it.
 *
 *  After the last table of the container (so a new server joins the others
 *  rather than landing above the user's `[projects.*]` section), else at end
 *  of file. One blank line goes in front when the preceding line is not blank,
 *  and one behind when the following line is not blank -- so the block never
 *  fuses onto a neighbour and never doubles an existing blank. */
function insertEdit(
  text: string,
  scan: TomlScan,
  containerPath: readonly string[],
  block: string,
  eol: string,
): SpanEdit {
  const inContainer = scan.sections.filter((s) => pathStartsWith(s.keyPath, containerPath));
  const at = inContainer.length > 0 ? inContainer[inContainer.length - 1].contentEnd : text.length;
  let prefix = "";
  if (at >= text.length && text.length > 0 && !/\r|\n/.test(text[text.length - 1])) {
    // A last line with no line break: give it one before adding anything.
    prefix += eol;
  }
  const beforeStart = lineStartBefore(text, at);
  if (at > 0 && !isBlankLine(text, beforeStart, at)) prefix += eol;
  let suffix = "";
  if (at < text.length && !isBlankLine(text, at, lineEnd(text, at))) suffix = eol;
  return { start: at, end: at, text: prefix + block + suffix };
}

// ---------------------------------------------------------------------------
// Post-write verification
// ---------------------------------------------------------------------------

/** Canonical JSON for a parsed TOML value: object keys sorted, so that two
 *  documents compare equal exactly when they MEAN the same thing.
 *
 *  bigint and TomlDate have no JSON spelling, so they are tagged. Tagging (not
 *  `String(v)`) keeps `"1979-05-27"` the string distinguishable from
 *  `1979-05-27` the date, which is the difference between a comparison that
 *  proves something and one that passes by coincidence. */
function canonValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof TomlDate) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonValue);
  if (isTomlTable(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonValue(value[key]);
    }
    return out;
  }
  return value;
}

/** A canonical, order-independent picture of `raw` with the named entries
 *  dropped from the container -- the "everything except the entries I am
 *  allowed to change" the post-write check compares.
 *
 *  An emptied container is treated as absent, so removing the only server is
 *  not itself reported as a change to the rest of the file. */
export function canonTomlConfig(raw: string, containerPath: readonly string[], drop: readonly string[] = []): string {
  const parsed = parseTomlConfig(raw);
  const value = canonValue(parsed);
  if (!isTomlTable(value)) return JSON.stringify(value);
  let cursor: Record<string, unknown> = value;
  for (let i = 0; i < containerPath.length; i++) {
    const key = containerPath[i];
    const next = cursor[key];
    if (!isTomlTable(next)) return JSON.stringify(value);
    if (i === containerPath.length - 1) {
      for (const name of drop) delete next[name];
      if (Object.keys(next).length === 0) delete cursor[key];
      break;
    }
    cursor = next;
  }
  return JSON.stringify(value);
}

/** The container's entry names in FILE order (parse order), for the
 *  order-preservation half of the check. */
function containerOrder(raw: string, containerPath: readonly string[]): string[] {
  const parsed = parseTomlConfig(raw);
  const container = isTomlTable(parsed) ? containerValue(parsed, containerPath) : undefined;
  return isTomlTable(container) ? Object.keys(container) : [];
}

export interface TomlSpliceExpectation {
  /** The entry this write adds or replaces, and the value it must read back as. */
  upsert?: { name: string; entry: Record<string, unknown> };
  /** Entries this write removes. */
  removed?: readonly string[];
}

/** Prove that `after` is `before` plus exactly the intended change.
 *
 *  Four claims, each of which a splice bug breaks:
 *
 *   1. `after` still parses. A scanner that took a span one line short or one
 *      line long usually lands here.
 *   2. The document with the touched entries dropped is unchanged -- so a
 *      neighbouring `[projects.'c:\x']` line, a sibling server's unsorted env
 *      table or the user's `model = "gpt-5"` cannot have been eaten.
 *   3. The other entries keep their file ORDER (canonical JSON sorts keys, so
 *      clause 2 alone would not notice a reordering).
 *   4. Our own entry reads back as the value asked for, and a removed entry is
 *      gone.
 *
 *  Throws `TomlVerifyError` on any violation. `upsertTomlEntry` and
 *  `removeTomlEntry` call this on their own output, which is why there is no
 *  exported way to obtain spliced text that skipped it. */
export function verifyTomlSplice(
  before: string,
  after: string,
  containerPath: readonly string[],
  expectation: TomlSpliceExpectation = {},
): void {
  const touched = [
    ...(expectation.upsert === undefined ? [] : [expectation.upsert.name]),
    ...(expectation.removed ?? []),
  ];
  let afterRead: TomlConfigRead;
  try {
    afterRead = readTomlConfig(after, containerPath);
  } catch (e) {
    throw new TomlVerifyError(`the edited text does not parse as TOML (${(e as Error).message})`);
  }
  if (afterRead.kind === "malformed") {
    throw new TomlVerifyError(`the edited text does not parse as TOML (${afterRead.detail})`);
  }
  if (afterRead.kind === "blocked") {
    throw new TomlVerifyError(`the edit left "${afterRead.path.join(".")}" as ${afterRead.shape}, not a table`);
  }
  const beforeRest = canonTomlConfig(before, containerPath, touched);
  const afterRest = canonTomlConfig(after, containerPath, touched);
  if (beforeRest !== afterRest) {
    throw new TomlVerifyError("the edit changed settings outside the entry it was asked to change");
  }
  const beforeOrder = containerOrder(before, containerPath).filter((k) => !touched.includes(k));
  const afterOrder = containerOrder(after, containerPath).filter((k) => !touched.includes(k));
  if (beforeOrder.join("\u0000") !== afterOrder.join("\u0000")) {
    throw new TomlVerifyError("the edit reordered the other entries");
  }
  for (const name of expectation.removed ?? []) {
    if (tomlEntryNames(afterRead).includes(name)) {
      throw new TomlVerifyError(`the edit did not remove the "${name}" entry`);
    }
  }
  if (expectation.upsert !== undefined) {
    const stored = tomlEntryFields(afterRead, expectation.upsert.name);
    if (stored === undefined) {
      throw new TomlVerifyError(`the edit did not leave a "${expectation.upsert.name}" table behind`);
    }
    if (JSON.stringify(canonValue(stored)) !== JSON.stringify(canonValue(entryAsWritten(expectation.upsert.entry)))) {
      throw new TomlVerifyError(`the "${expectation.upsert.name}" entry did not read back as the value written`);
    }
  }
}
