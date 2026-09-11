import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `Loaded "gh_actions" — 1 tools: gh_actions_run`.
//
// Eight messages interpolated a count straight in front of a hardcoded plural
// noun, so every one of them read wrong whenever the count was 1. It is only
// grammar, but these are the strings an LLM reads back mid-conversation and the
// ones a user sees in `list` and `discover`, and "1 tools" is the kind of thing
// that makes a tool look unfinished.
//
// What makes it worth a guard rather than just a fix is that the codebase
// already KNEW the idiom -- cost-estimate.ts, doctor-cmd.ts, config-loader.ts,
// import-cmd.ts and search-cmd.ts all spell the inline
// `n === 1 ? "thing" : "things"` ternary correctly, and search-cmd.ts had a
// correct one on the line directly below an incorrect one. So the failure mode
// is not ignorance of the rule, it is a new message being written without it,
// which is exactly what a scan catches and a pinned assertion does not.
//
// The predicate is `${...length}` -- a count that can be 1 -- immediately
// followed by a bare plural word. Two kinds of line are skipped, because both
// demonstrably handle the 1 case on the line itself:
//
//   - it carries an inline `=== 1 ?` ternary, the house idiom; or
//   - its ternary selects a hardcoded singular, `? "1 tool" : ...`. That form
//     earns its place where one boolean drives several swaps at once --
//     shadowedToolNote computes `one` once and uses it for the subject, for
//     "That name routes" vs "Those names route", and for "the name" vs "the
//     names". Rewriting those as four inline comparisons would be worse code,
//     so the scan accommodates the shape rather than the code contorting to
//     satisfy the scan.

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** A `${...length}` interpolation followed by a hardcoded lowercase plural. */
const COUNT_THEN_PLURAL = /\$\{[^}]*\.length\}[ ]+[a-z]+s\b/;

/** A line that settles the singular case itself: an inline `=== 1 ?`, or a
 *  ternary picking a hardcoded `"1 <noun>"`. Either way the plural on that
 *  line only renders when the count is not 1. */
const HANDLES_ONE = /=== 1 \?|\?\s*"1 [a-z]/;

/** Sites where the count provably cannot be 1, each named with its reason
 *  rather than listed for convenience. A compile-time constant is the only
 *  case that qualifies -- anything whose length depends on user data or
 *  runtime state does not, however unlikely 1 seems. */
const EXEMPT = new Map([
  ["bundles-cmd.ts", "CURATED_BUNDLES is a literal array in bundles.ts with six entries, fixed at compile time"],
]);

describe("a count is never printed in front of a hardcoded plural", () => {
  it("has no message that can render '1 tools'", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(SRC_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const lines = readFileSync(join(SRC_DIR, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!COUNT_THEN_PLURAL.test(line)) return;
        // The line already pluralizes, either way the header describes, so
        // what matched is the false branch of a correct ternary.
        if (HANDLES_ONE.test(line)) return;
        if (EXEMPT.has(file)) return;
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }

    expect(
      offenders,
      "These print a count straight in front of a plural noun, so they read " +
        '"1 tools" when the count is 1. Use the inline ternary the rest of this ' +
        'codebase uses -- `${n} ${n === 1 ? "tool" : "tools"}` -- or add an ' +
        "exemption to EXEMPT with the reason the count cannot be 1:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still has the pattern", () => {
    // An exemption outliving the line it excuses is how the next real offender
    // in that file gets waved through.
    for (const [file, reason] of EXEMPT) {
      const path = join(SRC_DIR, file);
      const src = readFileSync(path, "utf8");
      expect(
        src.split("\n").some((l) => COUNT_THEN_PLURAL.test(l) && !HANDLES_ONE.test(l)),
        `${file} is exempt (${reason}) but no longer contains the pattern -- drop the exemption`,
      ).toBe(true);
    }
  });
});
