// insertMember (jsonc.ts) ends in a `return null` that its callers turn into a
// fallback: for an array, a whole-array write that deletes every comment
// inside it. By reading, that null cannot be reached on a cleanly parsed
// document. This file is the evidence for that reading: it sweeps what can
// sit between the last element and the closing bracket, and holds every
// combination to the splice -- a comment INSIDE the array survives the splice
// and does not survive the whole-array fallback, so its survival says which
// path ran.

import { describe, expect, it } from "vitest";
import { addJsoncArrayElement, parseJsonc } from "../jsonc.js";

const KEEP = "/* keep */";

/** What opens the array, up to and including the comment the fallback would
 *  delete. */
const OPENS: Array<[string, string]> = [
  ["on one line", `[${KEEP} `],
  ["with a line break after the bracket", `[\n    ${KEEP}\n    `],
  ["with CRLF line breaks", `[\r\n    ${KEEP}\r\n    `],
];

/** The elements already in the array. */
const ELEMENTS: Array<[string, string, unknown[]]> = [
  ["one element", '"a"', ["a"]],
  ["two elements", '"a", "b"', ["a", "b"]],
  ["a nested last element", '"a", {"k": [1, 2]}', ["a", { k: [1, 2] }]],
];

/** What follows the last element, before the closing bracket. */
const TAILS: Array<[string, string]> = [
  ["nothing", ""],
  ["a space", " "],
  ["a tab", "\t"],
  ["a line break", "\n  "],
  ["a CRLF line break", "\r\n  "],
  ["a lone CR", "\r  "],
  ["a block comment", " /* tail */ "],
  ["a line comment", " // tail\n  "],
  ["a block comment that spans lines", " /* tail\n   more */ "],
  ["a trailing comma", ","],
  ["a trailing comma and a space", ", "],
  ["a trailing comma and a line break", ",\n  "],
  ["a trailing comma on the next line", "\n  ,\n  "],
  ["a comment, then a trailing comma", " /* tail */ ,"],
  ["a trailing comma, then a line comment", ", // tail\n  "],
  ["a trailing comma, then a block comment", ", /* tail */"],
  ["a trailing comma, then a block comment that spans lines", ", /* tail\n more */ "],
];

describe("addJsoncArrayElement -- every shape after the last element takes the splice", () => {
  for (const [openName, open] of OPENS) {
    for (const [elementsName, elements, values] of ELEMENTS) {
      for (const [tailName, tail] of TAILS) {
        it(`${openName}, ${elementsName}, then ${tailName}`, () => {
          const src = `{"list": ${open}${elements}${tail}], "after": 1}`;
          // The fixture has to be a document the splice is reached with.
          expect(parseJsonc(src)).toEqual({ list: values, after: 1 });

          const out = addJsoncArrayElement(src, ["list"], "new");

          expect(parseJsonc(out)).toEqual({ list: [...values, "new"], after: 1 });
          // The comment inside the array is still there: the whole-array
          // fallback re-renders the array from its values and drops it.
          expect(out).toContain(KEEP);
          if (tail.includes("tail")) expect(out).toContain("tail");
          // And a splice only ADDS: with the new element (and the separator it
          // may bring) taken back out, the original text is a subsequence.
          let at = 0;
          for (const ch of out) {
            if (at < src.length && ch === src[at]) at++;
          }
          expect(at).toBe(src.length);
        });
      }
    }
  }
});
