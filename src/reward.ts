import { classifyError, type ErrorCategory } from "./error-category.js";

export interface ToolCallResultShape {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// Graded reward in [0,1] for a proxied tool-call outcome.
//
// This replaces a binary "no isError == success" signal with a sound
// graded reward. The motivating problem: an upstream MCP server can
// return a soft failure INSIDE a 200 (e.g. {isError:false, text:"not
// found"}), which a binary check would score as full success. The
// grades below separate hard failures, soft (error-shaped) failures,
// empty bodies, and genuine successes.
//
// Rule-2 category decision (IMPORTANT):
//   classifyError NEVER returns null and ALWAYS returns a category --
//   its catch-all fallback is "upstream_error" (error-category.ts:119),
//   returned for ANY text that matches none of the recognized error
//   patterns. That includes every normal, successful reply ("OK",
//   "{...json...}", a tool result body). So gating rule 2 on "any
//   category returned" would mis-grade every success as 0.2.
//
//   Therefore rule 2 fires ONLY when the first text block classifies
//   into one of the SPECIFIC error-shaped categories below -- the ones
//   that represent a recognized upstream soft failure. "upstream_error"
//   is deliberately EXCLUDED because it is the benign catch-all, not a
//   positive error signal. classifyError(undefined/null/"") also
//   returns "upstream_error", which is likewise excluded -- empty
//   bodies are handled by rule 3, not rule 2.
const ERROR_SHAPED_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  "validation_error",
  "timeout",
  "unauthorized",
  "unknown_tool",
  "connection_lost",
  "rate_limited",
  "not_found",
]);

// Returns the first NON-EMPTY text-block string, or undefined if no block
// carries usable text. Skipping whitespace-only blocks aligns this scan with
// isEmptyBody's all-block scan, so an error-shaped LATER block can't slip
// between rule 2 (first-block error-shape) and rule 3 (empty body) -- e.g.
// content [{text:""},{text:"not found"}] is graded 0.2, not 1.0.
function firstTextBlock(result: ToolCallResultShape): string | undefined {
  const content = result.content;
  if (!content || content.length === 0) return undefined;
  for (const block of content) {
    if (typeof block.text === "string" && block.text.trim().length > 0) return block.text;
  }
  return undefined;
}

// True when the body carries no usable text: no content, empty content,
// or every text block is empty/whitespace-only.
function isEmptyBody(result: ToolCallResultShape): boolean {
  const content = result.content;
  if (!content || content.length === 0) return true;
  for (const block of content) {
    if (typeof block.text === "string" && block.text.trim().length > 0) {
      return false;
    }
  }
  return true;
}

// HEURISTIC: known false-positive when result text contains the verb (e.g. "not found" matching a "find" verb). Re-evaluate with a proper success-signal schema.
export function computeOutcomeReward(result: ToolCallResultShape): number {
  // Rule 1: explicit hard failure.
  if (result.isError === true) return 0.0;

  // Rule 2 vs 3 ordering: an empty body is not "error-shaped", so only
  // run the error-shape check when there IS non-whitespace text. We pull
  // the first text block and confirm it is non-whitespace before
  // classifying -- this keeps rule 3 (empty/whitespace) from ever being
  // shadowed by classifyError's "upstream_error" fallback on empty input.
  const text = firstTextBlock(result);
  if (text !== undefined) {
    // firstTextBlock already skipped whitespace-only blocks, so `text` is
    // guaranteed non-empty here.
    if (ERROR_SHAPED_CATEGORIES.has(classifyError(text))) {
      // Rule 2: a 200 reply whose first text block still reads like a
      // recognized error -- upstream returned a soft failure.
      return 0.2;
    }
  }

  // Rule 3: empty or whitespace-only body.
  if (isEmptyBody(result)) return 0.3;

  // Rule 4: genuine success.
  return 1.0;
}
