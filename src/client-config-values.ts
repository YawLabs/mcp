// Leaf helpers the client-config core AND its adapters share: canonical
// rendering, shape naming, positions, and the launch view of a stored entry.
//
// WHY A SEPARATE FILE. client-config.ts imports the JSON-family adapter
// (client-config-json.ts) to build it in, and that adapter needs these
// helpers. With them defined in client-config.ts the two modules imported each
// other -- a cycle that was safe only because neither used the other's
// bindings at module top level, and that one careless `const X = helper()`
// away from a TDZ ReferenceError whose stack names the wrong file. Putting
// the shared pieces here makes the runtime graph a tree: client-config.ts ->
// client-config-json.ts -> { jsonc.ts, this file }, and client-config.ts ->
// this file. client-config.ts re-exports every public helper below, so a
// consumer keeps importing it from there.
//
// This file imports NOTHING at runtime from the rest of the client-config
// family. The two `import type` lines are erased by the compiler and are not a
// cycle; keep it that way -- a runtime import of client-config.ts from here
// would recreate exactly the loop this file exists to remove.

import type { ConfigPosition, EntryTransform } from "./client-config.js";
import type { LaunchEntry } from "./install-target-model.js";

/** True for a plain object -- neither null nor an array. The test every read
 *  in the core makes before treating a parsed value as an entry or a
 *  container. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string-valued keys of an `env` object, or undefined when there are none
 *  (or when `env` is not an object). */
export function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const kept: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") kept[key] = v;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** `stored` as the transform says every consumer should see it. */
export function normalizeEntry(stored: unknown, transform?: EntryTransform): unknown {
  return transform?.normalize === undefined ? stored : transform.normalize(stored);
}

/** The launch view of a stored entry, or null when there is nothing to launch.
 *
 *  `args` is FILTERED to strings rather than cast: a hand-edited config whose
 *  args carry a number parses fine, and every consumer downstream calls string
 *  methods on each token. `env` keeps only string-valued keys, per key, for
 *  the same reason -- a numeric `DEBUG: 1` must not take the valid keys beside
 *  it down with it. */
export function launchOf(value: unknown): LaunchEntry | null {
  if (!isRecord(value)) return null;
  const record = value;
  if (typeof record.command !== "string") return null;
  const args = Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [];
  const env = stringMap(record.env);
  return env === undefined ? { command: record.command, args } : { command: record.command, args, env };
}

/** `offset` as a 1-based line/column pair against `raw`. Counts LF, so a CRLF
 *  file reports the line numbers an editor shows. */
export function positionAt(raw: string, offset: number): ConfigPosition {
  const clamped = Math.max(0, Math.min(offset, raw.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (raw[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset: clamped, line, column: clamped - lineStart + 1 };
}

/** A JSON value rendered canonically: object keys sorted, `undefined`-valued
 *  keys dropped, no whitespace.
 *
 *  Two canonical strings are equal exactly when the two values are equal AS
 *  JSON -- the question install's idempotence check asks ("would writing this
 *  CHANGE what the client reads") and the question the post-write check asks
 *  of every untouched neighbour. Key order is deliberately not part of it: a
 *  hand-edited entry spelling its args before its command means what install's
 *  own spelling means, and rewriting the file to reorder two keys is churn
 *  with no behaviour behind it.
 *
 *  A BIGINT renders as its digits. `JSON.stringify` THROWS on one, and a
 *  throw here would surface as a raw TypeError out of a post-write check whose
 *  whole job is to refuse cleanly -- which is reachable the moment a syntax
 *  whose parser yields bigints for large integers is registered (the declared
 *  `"toml"` slot: smol-toml's `integersAsBigInt: "asNeeded"` returns one for an
 *  integer outside the double-safe range). Digits are also the right answer
 *  for the comparison this function serves: under `asNeeded` a value is a
 *  bigint only when it does NOT fit a number, so a bigint and a number that
 *  render alike differ in spelling and not in value.
 *
 *  A DATE is tagged, `{"$date":"<ISO>"}`, the way the TOML adapter's own
 *  `canonValue` tags one: smol-toml returns a datetime as `TomlDate`, a Date
 *  subclass with no own enumerable keys, so the object branch below rendered
 *  every date as `{}` -- and two different dates, or a date and an empty
 *  table, compared equal. The tag keeps `"1979-05-27"` the string distinct
 *  from `1979-05-27` the date, and `toISOString` is `TomlDate`'s own, so a
 *  local date renders as the TOML form it was read from. An invalid Date has
 *  no ISO string (`toISOString` throws RangeError) and renders as
 *  `{"$date":"invalid"}` rather than throwing out of a comparison.
 *
 *  A value JSON cannot represent at all (a function, a symbol, `undefined`)
 *  renders as `null`, the way JSON.stringify treats one inside an array. Those
 *  come from a caller, never from a parser; the fallback is there so this can
 *  never return `undefined` and make two unequal values compare equal. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) {
    const iso = Number.isNaN(value.getTime()) ? "invalid" : value.toISOString();
    return `{"$date":${JSON.stringify(iso)}}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** How to name a value's SHAPE in a message -- what is there instead of a
 *  container. Shape, never contents: such a value can be arbitrarily large,
 *  and the user needs to know which key is wrong rather than have it echoed
 *  back. */
export function describeValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  return `a ${typeof value}`;
}
