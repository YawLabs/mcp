import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTALL_TARGETS, type InstallOS } from "../install-targets.js";

// The `install --list` legend in src/index.ts enumerates what the STATUS
// column can say, and the CHANGELOG says so in as many words -- "That legend
// reads as a complete enumeration of what the column can say and was not one".
// Nothing enforced it. The statuses live in `statusFor` (install-cmd.ts) and
// the legend lives in a help string two files away, so the next status added
// to statusFor would have falsified a shipped claim silently, exactly the way
// `not supported yet` and `legacy: <key>` did before this sweep.
//
// This scan derives the shapes statusFor can actually return and requires the
// legend to name each one. It reads SOURCE rather than running the CLI, for
// the same reason its sibling scans do: the legend is a string constant, so
// there is nothing to run, and a source read cannot pass because the built
// dist is stale.
//
// What it does NOT see, stated rather than implied: a status returned through
// a variable rather than a literal (the `literalless` assertion below turns
// that into a failure rather than a silent pass), a status printed by some
// other function into the same column, and any claim the legend makes beyond
// naming the statuses. It pins the enumeration, not the prose.

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** `unavailable` -- the one shape statusFor can return that the legend leaves
 *  out on purpose. It is the fallback beside `not supported yet`, reached only
 *  when a target's `availableOn` omits an OS AND `notConfigurableOn` carries
 *  no reason for that OS. No shipped target is in that state (the third test
 *  below pins that, so the exclusion cannot quietly stop being true), so
 *  naming it in the legend would document a status the column cannot print.
 *  Recorded in 0d98947, re-checked here. */
const DELIBERATELY_UNLISTED = new Set(["unavailable"]);

/** The body of a top-level `function <name>(` in `source`, from the signature
 *  to the first line that is exactly `}` -- every source file here declares
 *  its functions at the top level, so that line is the close. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found -- this scan is pinned to a function that moved or was renamed`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no top-level close -- the scan cannot bound it`);
  return source.slice(start, end);
}

/** `//` line comments and the body lines of block / JSDoc comments. A comment
 *  quoting a status string is prose, not a return. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

function stripComments(body: string): string {
  return body
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
}

/** A `return` statement's expression, up to its `;`. */
const RETURN_EXPR = /\breturn\b([^;]*);/g;

/** A double-quoted string, or a template literal. The template alternative is
 *  tried at every position too, so a template holding a quoted string
 *  (`` `legacy: ${x ?? "unknown"}` ``) is consumed whole and its inner string
 *  is never read as a status of its own. */
const LITERAL = /"((?:[^"\\]|\\.)*)"|`([^`]*)`/g;

/** An interpolation that is a bare local identifier -- `${keySuffix}`, not
 *  `${p.unreadable}`. The first kind is a literal this file can resolve; the
 *  second is a runtime value the legend renders as a `<placeholder>`. */
const BARE_INTERPOLATION = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

interface ReturnedShapes {
  /** The leading literal text of every string a `return` can produce --
   *  `installed`, `legacy: `, `not supported yet`. A template contributes the
   *  text before its first `${`, which is what the legend spells with a
   *  `<placeholder>` after it. */
  shapes: string[];
  /** Bare identifiers interpolated into a returned template (`keySuffix`). */
  interpolated: string[];
  /** `return` expressions carrying no string literal at all -- a status this
   *  scan cannot read, and therefore cannot check. */
  literalless: string[];
}

function returnedShapes(body: string): ReturnedShapes {
  const code = stripComments(body);
  const shapes = new Set<string>();
  const interpolated = new Set<string>();
  const literalless: string[] = [];
  for (const stmt of code.matchAll(new RegExp(RETURN_EXPR.source, "g"))) {
    const expr = stmt[1];
    let found = 0;
    for (const lit of expr.matchAll(new RegExp(LITERAL.source, "g"))) {
      found++;
      const text = lit[1] ?? lit[2] ?? "";
      shapes.add(text.split("${")[0]);
      if (lit[2] !== undefined) {
        for (const interp of lit[2].matchAll(new RegExp(BARE_INTERPOLATION.source, "g"))) interpolated.add(interp[1]);
      }
    }
    if (found === 0) literalless.push(`return${expr};`);
  }
  return { shapes: [...shapes], interpolated: [...interpolated], literalless };
}

/** Every non-empty string literal assigned to `const <name> =` in `body` --
 *  used to resolve a suffix interpolated into a returned template
 *  (` (other drive case)`) back to text the legend has to name. */
function constLiterals(body: string, name: string): string[] {
  const decl = new RegExp(`const\\s+${name}\\s*=([^;]*);`).exec(stripComments(body));
  if (decl === null) return [];
  const out: string[] = [];
  for (const lit of decl[1].matchAll(new RegExp(LITERAL.source, "g"))) {
    const text = (lit[1] ?? lit[2] ?? "").trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/** The `install --list` entry of the top-level help text, as one line: the
 *  escaped backticks unescaped, and every run of whitespace collapsed, so a
 *  status the formatter wrapped across two lines (`` `(other\n drive case)` ``)
 *  still reads as one token. */
function listLegend(): string {
  const source = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
  const start = source.indexOf("install --list           Show every MCP client config location");
  const end = source.indexOf("install --all", start);
  if (start < 0 || end < 0)
    throw new Error("the `install --list` help entry moved -- this scan cannot find the legend");
  return source.slice(start, end).replace(/\\`/g, "`").replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the legend names `shape` as a status: backticked, optionally
 *  followed by the `<placeholder>` the legend writes for the runtime half of a
 *  template (`` `legacy: <key>` ``). Backticks are required on both sides, so
 *  `installed` is not satisfied by the `not installed` entry sitting next to
 *  it. */
function legendNames(legend: string, shape: string): boolean {
  return new RegExp(`\`${escapeRegExp(shape)}(?:<[a-z]+>)?\``).test(legend);
}

const INSTALL_CMD = readFileSync(join(SRC_DIR, "install-cmd.ts"), "utf8");
const STATUS_FOR = functionBody(INSTALL_CMD, "statusFor");

describe("the --list legend enumerates every status statusFor can print", () => {
  it("reads a function's returns, its interpolated suffixes, and the ones it cannot read", () => {
    // Pins the extractor itself: a scan that derives nothing proves nothing,
    // and one that misses the template shapes would pass on a legend naming
    // none of them.
    const sample = [
      "function sample(p: X): string {",
      '  // return "quoted in a comment";',
      '  if (p.a) return "flat";',
      "  const suffix = p.b ? \" (a suffix)\" : '';",
      "  if (p.c) return `templated: ${p.c}`;",
      "  if (p.d) return `withSuffix${suffix}`;",
      "  if (p.e) return p.f;",
      '  return p.g > 0 ? "left" : "right";',
      "}",
    ].join("\n");
    const body = functionBody(sample, "sample");
    const got = returnedShapes(body);
    expect(got.shapes.sort()).toEqual(["flat", "left", "right", "templated: ", "withSuffix"]);
    expect(got.interpolated).toEqual(["suffix"]);
    expect(got.literalless).toEqual(["return p.f;"]);
    expect(constLiterals(body, "suffix")).toEqual(["(a suffix)"]);
    // And the legend matcher does not let a longer entry stand in for a
    // shorter one it contains.
    expect(legendNames("`not installed` that the file is absent", "not installed")).toBe(true);
    expect(legendNames("`not installed` that the file is absent", "installed")).toBe(false);
    expect(legendNames("`legacy: <key>` that the only", "legacy: ")).toBe(true);
  });

  it("names every reachable status, and the drive-case suffix", () => {
    const { shapes, interpolated, literalless } = returnedShapes(STATUS_FOR);
    expect(
      literalless,
      "statusFor returns a value this scan cannot read, so the legend cannot be checked against it. " +
        "Return the status as a string or template literal:\n  " +
        literalless.join("\n  "),
    ).toEqual([]);
    expect(
      shapes.filter((s) => s.length === 0),
      "statusFor returns an empty status string",
    ).toEqual([]);
    // Not vacuous: statusFor returns nine shapes today, and the scan has to
    // see all of them before the check below means anything.
    expect(shapes.length).toBeGreaterThanOrEqual(9);

    const legend = listLegend();
    const unlisted = shapes.filter((s) => !DELIBERATELY_UNLISTED.has(s) && !legendNames(legend, s));
    expect(
      unlisted,
      "install --list's STATUS column can print these, and the legend in src/index.ts -- which the " +
        "CHANGELOG calls a complete enumeration of what the column can say -- does not name them. Add " +
        "each to that legend (or, if no shipped target can reach it, to DELIBERATELY_UNLISTED here with " +
        "the reason):\n  " +
        unlisted.map((s) => `"${s}"`).join("\n  "),
    ).toEqual([]);

    // A suffix a status carries is part of what the column can say, so the
    // legend has to name it too. Derived, not hard-coded: renaming the suffix
    // in statusFor fails here rather than quietly leaving the legend wrong.
    const suffixes = interpolated.flatMap((name) => constLiterals(STATUS_FOR, name));
    expect(
      suffixes.length,
      "statusFor interpolates a local into a returned status but declares no literal for it",
    ).toBeGreaterThan(0);
    const unlistedSuffixes = suffixes.filter((s) => !legendNames(legend, s));
    expect(
      unlistedSuffixes,
      "statusFor appends these to a status and the --list legend does not name them:\n  " +
        unlistedSuffixes.join("\n  "),
    ).toEqual([]);
  });

  it("pins the status set, so a REMOVED status leaves the legend over-claiming", () => {
    // The check above is one-directional -- it catches a status with no legend
    // entry. This catches the other direction: dropping a status from
    // statusFor without dropping it from the legend leaves the legend naming
    // something the column can no longer print, which is the same class of
    // false claim.
    expect(returnedShapes(STATUS_FOR).shapes.sort()).toEqual([
      "installed",
      "legacy: ",
      "malformed",
      "no-entries",
      "not installed",
      "not supported yet",
      "other-entries",
      "unavailable",
      "unreadable: ",
    ]);
  });

  it("`unavailable` stays unlisted only while no shipped target can reach it", () => {
    // statusFor returns the bare `unavailable` for a target whose availableOn
    // omits this OS with no notConfigurableOn reason recorded for it. Adding
    // such a target makes the string printable, and the legend would then be
    // incomplete -- so this is the condition DELIBERATELY_UNLISTED rests on,
    // checked rather than assumed.
    const ALL_OSES: InstallOS[] = ["macos", "linux", "windows"];
    const reachable: string[] = [];
    for (const t of INSTALL_TARGETS) {
      for (const os of ALL_OSES) {
        if (t.availableOn.includes(os)) continue;
        if (t.notConfigurableOn?.[os] === undefined) reachable.push(`${t.clientId} on ${os}`);
      }
    }
    expect(
      reachable,
      "These targets make install --list print a bare `unavailable`, which the legend does not name. " +
        "Give each a notConfigurableOn reason (so the row reads `not supported yet`), or add `unavailable` " +
        "to the legend and drop it from DELIBERATELY_UNLISTED:\n  " +
        reachable.join("\n  "),
    ).toEqual([]);
    // Not vacuous: the loop must have examined a target that omits an OS.
    expect(INSTALL_TARGETS.some((t) => t.availableOn.length < ALL_OSES.length)).toBe(true);
    expect(DELIBERATELY_UNLISTED.has("unavailable")).toBe(true);
    expect(legendNames(listLegend(), "unavailable")).toBe(false);
  });
});
