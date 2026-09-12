// The JSON-family config adapter: one implementation serving both flavours
// the JSON-shaped clients need.
//
//   * JSONC-TOLERANT (`format: "jsonc"`) -- comments and trailing commas are
//     legal and survive a write. Claude Code's own `~/.claude.json`, Cursor,
//     VS Code, Windsurf, Gemini CLI, Zed.
//   * STRICT JSON (`format: "json"`) -- the client parses the file with
//     `JSON.parse`, so a comment or a trailing comma anywhere in it means the
//     client loads NO server from that file. Such a file is reported
//     `unloadable` and every WRITE into it is refused, because splicing one
//     more entry in would print Done over a file nothing reads. A removal is
//     still allowed: taking our entry out of a file the client skips is
//     correct, and refusing it would leave the user unable to uninstall.
//
// Strictness is never guessed from the bytes -- it is the format the TARGET
// (or its scope) declared, which is what `effectiveConfigFormat` resolves.
//
// EVERY WRITE IS A SPLICE. upsert / remove / repairContainer delegate to
// jsonc.ts's `editJsoncEntry` / `removeJsoncEntry`, so this adapter inherits
// that module's contract rather than restating it: a neighbouring entry keeps
// its bytes AND its trailing comment, the file's own indent step and line
// ending are copied, its trailing-comma style is mirrored (so a strict file
// gains no trailing comma), a new entry is APPENDED after the last member, and
// a removal that finds nothing returns the input string ITSELF so a caller can
// detect the no-op by identity.
//
// TWO THINGS THIS ADAPTER DOES NOT DO, stated because a reader will assume
// otherwise:
//   * It does not terminate the file with a newline. A splice leaves the bytes
//     outside its own span alone, so a file with no final newline comes back
//     without one; the CALLER adds it when it writes, which is where that
//     decision lives today (install-cmd.ts and try-cmd.ts both do it) and the
//     only place it can live without breaking the no-op identity contract
//     above. `terminateWithNewline` in client-config.ts is that one line.
//   * It does not re-emit a leading UTF-8 BOM on a real edit. That is
//     jsonc.ts's documented asymmetry -- kept byte-for-byte on a no-op,
//     stripped on an edit -- and re-adding it here would change the existing
//     targets' output bytes relative to that module.

import { parseTree } from "jsonc-parser";
import {
  type ConfigAdapter,
  type ConfigPosition,
  type ConfigRead,
  canonicalJson,
  describeValueShape,
  type EntryAddress,
  type EntryTransform,
  type EntryView,
  launchOf,
  normalizeEntry,
  positionAt,
  type StrictViolation,
} from "./client-config.js";
import { editJsoncEntry, parseJsonc, removeJsoncEntry } from "./jsonc.js";

/** U+FEFF, built from its code point rather than written as an escape: a
 *  typed escape sequence in a source file is one backslash level away from
 *  becoming a real control byte, which is a class of bug this repo has
 *  shipped before and which no linter, type-check or test sees. */
const BOM = String.fromCharCode(0xfeff);

function stripBom(raw: string): { text: string; had: boolean } {
  return raw.charCodeAt(0) === 0xfeff ? { text: raw.slice(1), had: true } : { text: raw, had: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object at `segments`, or null when any segment is missing or holds a
 *  non-object. The same walk `readNested` and doctor's container walk do, with
 *  the "and it must be an object" test folded in. */
function containerAt(root: Record<string, unknown>, segments: readonly string[]): Record<string, unknown> | null {
  let cursor: unknown = root;
  for (const key of segments) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

/** The first segment along the path whose existing value is not an object, or
 *  null when the chain is spliceable as-is.
 *
 *  `editJsoncEntry` materialises MISSING intermediate keys, but a key that
 *  EXISTS and holds a non-object is left to jsonc-parser's `modify`, which
 *  throws a message naming neither the file nor the key. Walking the chain
 *  here is what lets the caller either repair the key or refuse while naming
 *  it.
 *
 *  `reparable` splits the two shapes deliberately: null, a scalar and an empty
 *  array hold no server definitions, so replacing them with an empty object
 *  loses nothing, while a NON-EMPTY array can hold real entries in the wrong
 *  shape and silently dropping those is not a repair. */
function blockedSegment(
  root: Record<string, unknown>,
  segments: readonly string[],
): { path: string[]; shape: string; reparable: boolean } | null {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length; i++) {
    const value = node[segments[i]];
    // Absent from here down: the splicer builds the rest of the chain itself.
    if (value === undefined) return null;
    if (isRecord(value)) {
      node = value;
      continue;
    }
    return {
      path: segments.slice(0, i + 1),
      shape: describeValueShape(value),
      reparable: value === null || !Array.isArray(value) || value.length === 0,
    };
  }
  return null;
}

/** The offset a `JSON.parse` failure names, as a position in the ORIGINAL
 *  bytes.
 *
 *  V8 spells it `... in JSON at position N (line L column C)` (measured on
 *  Node 22.22.2). The offset is against the text `JSON.parse` was handed,
 *  which is the de-BOM'd string, so `bomShift` adds the stripped byte back.
 *  Line and column are recomputed here rather than lifted out of the message
 *  for the same reason. A message with no position (V8 has several) yields
 *  null instead of a guess. */
function strictPosition(err: unknown, raw: string, bomShift: number): ConfigPosition | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /at position (\d+)/.exec(message);
  if (match === null) return null;
  return positionAt(raw, Number(match[1]) + bomShift);
}

/** Where a JSONC document first fails to parse, in the ORIGINAL bytes.
 *
 *  `parseJsonc` strips comments and trailing commas BEFORE calling
 *  `JSON.parse`, so the position inside its error message refers to the
 *  stripped text and can be off by every comment above it. jsonc-parser's own
 *  scanner reads the original bytes and reports its first error's offset
 *  against them, which is what this uses. It can legitimately find nothing --
 *  jsonc-parser tolerates a few shapes `JSON.parse` rejects -- and then there
 *  is no position to report. */
function jsoncPosition(raw: string, bomShift: number): ConfigPosition | null {
  const errors: { error: number; offset: number; length: number }[] = [];
  parseTree(raw.slice(bomShift), errors, { allowTrailingComma: true });
  const first = errors[0];
  return first === undefined ? null : positionAt(raw, first.offset + bomShift);
}

function entriesOf(container: Record<string, unknown>, transform?: EntryTransform): EntryView[] {
  return Object.entries(container).map(([key, value]) => {
    // `value` stays the STORED value: drift comparison and carry-forward both
    // read what the file actually holds. `launch` is the normalised view, so a
    // client that wraps our entry in its own transport shape still reads as
    // ours.
    const normalized = normalizeEntry(value, transform);
    return { key, value, launch: launchOf(normalized) };
  });
}

/** The document a fresh file starts as: the entry nested under its container
 *  path.
 *
 *  Byte-for-byte the shape `mergeClientConfig({}, containerPath, entry)`
 *  produces in install-cmd.ts, which is what the missing-file path renders
 *  today. The two are pinned against each other in
 *  src/tests/client-config-json.test.ts, so a divergence fails the suite
 *  rather than showing up as a differently-shaped fresh config. */
export function buildFreshConfig(
  containerPath: readonly string[],
  key: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  if (containerPath.length === 0) throw new Error("buildFreshConfig: containerPath cannot be empty");
  const root: Record<string, unknown> = {};
  let parent = root;
  for (let i = 0; i < containerPath.length - 1; i++) {
    const child: Record<string, unknown> = {};
    parent[containerPath[i]] = child;
    parent = child;
  }
  parent[containerPath[containerPath.length - 1]] = { [key]: entry };
  return root;
}

/** Where the counted entries live, for a message.
 *
 *  The file alone under-describes a NESTED container -- Claude Code's local
 *  scope keys its servers under one project inside a file that also carries a
 *  top-level container this count does not include -- so a nested path is
 *  spelled out. Byte-identical to `describeContainer` in install-cmd.ts, whose
 *  output src/tests/client-config-json.test.ts pins. */
function describeJsonLocation(absolute: string, addr: EntryAddress): string {
  const segments = addr.containerPath;
  if (segments.length <= 1) return absolute;
  const tail = segments
    .slice(2)
    .map((key) => `.${key}`)
    .join("");
  return `${absolute} under ${segments[0]}[${JSON.stringify(segments[1])}]${tail}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Classify one JSON-family file. Pure, and never throws: every failure is a
 *  ConfigRead kind.
 *
 *  `strict` is the client's own parser, not ours. A strict file that
 *  `JSON.parse` rejects is parsed AGAIN leniently, and when that succeeds the
 *  read is `ok` with `unloadable` set: yaw-mcp can see the entries (so doctor
 *  can say which server is not loading, and uninstall can still take ours
 *  out), while the write facade refuses to add anything to it. A strict file
 *  that fails BOTH parsers is plain `malformed`, exactly as a JSONC one would
 *  be. */
function classifyJson(
  raw: string,
  addr: EntryAddress,
  transform: EntryTransform | undefined,
  strict: boolean,
): ConfigRead {
  // Whitespace-only counts as absent: an empty file has nothing to preserve
  // and nothing to report, and every consumer already treats it as "not
  // configured" rather than as a parse failure.
  if (raw.trim().length === 0) return { kind: "absent" };
  const { text, had } = stripBom(raw);
  const shift = had ? 1 : 0;

  let parsed: unknown;
  let unloadable: StrictViolation | null = null;
  if (strict) {
    try {
      // The BOM is stripped before the strict parse, so a Notepad-saved file
      // is not reported unloadable for its first three bytes. Two different
      // reasons, and neither is "every client accepts a BOM":
      //   * Claude Code does accept one -- measured, `claude mcp list` reads a
      //     BOM-prefixed .mcp.json. Reporting that file as unloadable would be
      //     our bug rather than the user's.
      //   * Where a client does NOT (Cline reads with JSON.parse and is
      //     INFERRED to reject one -- inference, untested against Cline), the
      //     refusal would be pointless anyway: the splicer drops the BOM and
      //     does not re-emit it, so the write is what FIXES the file. Refusing
      //     it would leave the user stuck with a config nothing can repair
      //     except an editor.
      parsed = JSON.parse(text);
    } catch (strictErr) {
      let lenient: unknown;
      try {
        lenient = parseJsonc(raw);
      } catch (err) {
        return {
          kind: "malformed",
          syntax: "JSON",
          reason: "syntax",
          detail: messageOf(err),
          position: jsoncPosition(raw, shift),
        };
      }
      parsed = lenient;
      unloadable = {
        syntax: "JSON",
        detail: messageOf(strictErr),
        position: strictPosition(strictErr, raw, shift),
      };
    }
  } else {
    try {
      parsed = parseJsonc(raw);
    } catch (err) {
      // `detail` is the parser's own message, kept as-is because that is the
      // text install and doctor already print. Its embedded position refers to
      // the comment-stripped text, which is why `position` is computed
      // separately, against the original bytes.
      return {
        kind: "malformed",
        syntax: "JSON",
        reason: "syntax",
        detail: messageOf(err),
        position: jsoncPosition(raw, shift),
      };
    }
  }

  if (!isRecord(parsed)) {
    return { kind: "malformed", syntax: "JSON", reason: "root", detail: describeValueShape(parsed), position: null };
  }
  const blocked = blockedSegment(parsed, addr.containerPath);
  // `unloadable` rides along: a strict file can be both unreadable-by-client
  // and blocked, and a repair into one would otherwise be allowed.
  if (blocked !== null) return { kind: "blocked", ...blocked, unloadable };
  const container = containerAt(parsed, addr.containerPath);
  if (container === null) return { kind: "ok", containerPresent: false, entries: [], unloadable };
  return { kind: "ok", containerPresent: true, entries: entriesOf(container, transform), unloadable };
}

function upsertJson(raw: string | null, addr: EntryAddress, key: string, entry: Record<string, unknown>): string {
  // No bytes to preserve -> render the document. Byte-identical to the
  // missing-file path install takes today, trailing newline included.
  if (raw === null || raw.trim().length === 0) {
    return `${JSON.stringify(buildFreshConfig(addr.containerPath, key, entry), null, 2)}\n`;
  }
  // Everything else is a splice into the original bytes. Missing containers
  // along the path are created by the splicer itself.
  return editJsoncEntry(raw, [...addr.containerPath], key, entry);
}

function removeJson(raw: string, addr: EntryAddress, key: string): string {
  // Walk FIRST. `removeJsoncEntry` throws when a container along the path does
  // not exist ("Can not delete in empty document"), while an entry that simply
  // is not there is a NO-OP -- and the no-op has to return this exact string
  // so a caller comparing by identity sees that nothing changed.
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    // Unparseable: there is nothing to remove and nothing safe to write. The
    // write facade refuses a malformed read before it gets here; a direct
    // caller gets the input back rather than an exception.
    return raw;
  }
  if (!isRecord(parsed)) return raw;
  const container = containerAt(parsed, addr.containerPath);
  if (container === null || !Object.hasOwn(container, key)) return raw;
  return removeJsoncEntry(raw, [...addr.containerPath], key);
}

/** `_addr` is deliberately unread: `blockedPath` is already the absolute key
 *  path of the offending key, and it can stop SHORT of the container (a
 *  `projects` key holding a string blocks Claude Code's local scope three
 *  segments up). Repairing at the address instead would rebuild the chain
 *  under a key that is still the wrong shape. */
function repairJson(raw: string, _addr: EntryAddress, blockedPath: readonly string[]): string {
  if (blockedPath.length === 0) throw new Error("repairContainer: an empty key path cannot be repaired");
  // Replaces the offending key with an empty object in the same
  // comment-preserving pass, so the rest of the file keeps its bytes. Every
  // deeper segment is necessarily absent afterwards and the upsert
  // materialises it, so one repair is always enough.
  return editJsoncEntry(raw, blockedPath.slice(0, -1), blockedPath[blockedPath.length - 1], {});
}

/** What `--dry-run` prints: ONLY the entry, rendered at its container path,
 *  never the merged file -- the merged file would put every sibling server's
 *  `env` into a transcript the user pastes into a bug report.
 *
 *  `creating` is unused for JSON: the preview is the same one-sided diff
 *  whether or not the file exists yet, which is what install prints today. It
 *  stays in the signature because a syntax with a file header has to know. */
function previewJson(addr: EntryAddress, key: string, entry: Record<string, unknown>, _creating: boolean): string {
  return JSON.stringify(buildFreshConfig(addr.containerPath, key, entry), null, 2);
}

/** The whole document, canonically rendered, with our entries taken out: the
 *  "everything the edit was not about" fingerprint the post-write check
 *  compares before and after.
 *
 *  Parses LENIENTLY for both flavours on purpose. The comparison is
 *  before-against-after of the same file, and a strict-unloadable file still
 *  has to be fingerprintable -- a removal from one is allowed, and it is
 *  exactly the case where verifying that nothing else moved matters most.
 *
 *  `dropContainer` drops the container itself rather than named entries, for
 *  the two edits that legitimately change it: a repair (which replaces a
 *  non-object with an empty container) and an upsert that creates it. */
function canonJson(
  raw: string,
  addr: EntryAddress,
  opts?: { drop?: readonly string[]; dropContainer?: boolean },
): string {
  const parsed = parseJsonc(raw);
  if (!isRecord(parsed)) throw new Error("client-config-json: canon needs a JSON object");
  // A JSON round trip is a deep clone here: a value that came out of a parser
  // holds no undefined, no function and no cycle, so nothing is lost -- and it
  // keeps this from mutating the caller's parse.
  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  const segments = addr.containerPath;
  const leaf = segments[segments.length - 1];
  const parent = containerAt(clone, segments.slice(0, -1));
  if (parent !== null && leaf !== undefined) {
    if (opts?.dropContainer === true) {
      delete parent[leaf];
      // Then prune every ancestor the deletion just emptied. Creating the
      // container can create the whole chain above it -- Claude Code's
      // per-project object is the live case -- and those keys are part of what
      // the edit was about, so a before/after comparison that kept an
      // emptied-out `{}` on one side and nothing on the other would fail a
      // write the caller asked for. An ancestor that still holds anything else
      // stays, which is what keeps real damage to a sibling visible.
      for (let depth = segments.length - 1; depth > 0; depth--) {
        const holder = containerAt(clone, segments.slice(0, depth - 1));
        const key = segments[depth - 1];
        const value = holder === null ? undefined : holder[key];
        if (holder === null || !isRecord(value) || Object.keys(value).length > 0) break;
        delete holder[key];
      }
    } else {
      const container = parent[leaf];
      if (isRecord(container)) {
        for (const key of opts?.drop ?? []) delete container[key];
      }
    }
  }
  return canonicalJson(clone);
}

/** JSON with comments and trailing commas: what most MCP clients read. */
export const JSONC_ADAPTER: ConfigAdapter = {
  syntax: "JSON",
  classify: (raw, addr, transform) => classifyJson(raw, addr, transform, false),
  upsert: upsertJson,
  remove: removeJson,
  repairContainer: repairJson,
  renderPreview: previewJson,
  describeLocation: describeJsonLocation,
  canon: canonJson,
};

/** Strict JSON: the client parses the file with `JSON.parse`, so a comment or
 *  a trailing comma in it means no server in that file loads at all. Same
 *  splicer, same wording ("JSON"); the difference is the strict gate. */
export const JSON_ADAPTER: ConfigAdapter = {
  syntax: "JSON",
  classify: (raw, addr, transform) => classifyJson(raw, addr, transform, true),
  upsert: upsertJson,
  remove: removeJson,
  repairContainer: repairJson,
  renderPreview: previewJson,
  describeLocation: describeJsonLocation,
  canon: canonJson,
};

/** Exported so a test can assert the BOM constant is one real U+FEFF rather
 *  than the three bytes a mangled escape would leave behind. */
export const UTF8_BOM = BOM;
