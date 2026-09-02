import { classifyError, type ErrorCategory } from "./error-category.js";

export interface ToolCallResultShape {
  content?: Array<{ type: string; text?: string }>;
  // Spec-legal structured output: when a tool declares an outputSchema, the
  // result carries `structuredContent` and `content` "may be empty"
  // (CallToolResultSchema). Typed unknown -- we only test for presence.
  structuredContent?: unknown;
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
//   its catch-all fallback is "upstream_error" (the final return of
//   classifyError in error-category.ts, named by FUNCTION rather than by
//   line: the line this used to cite drifted into an unrelated regex
//   comment block), returned for ANY text that matches none of the
//   recognized error patterns. That includes every normal, successful reply ("OK",
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

// The two UNCERTAIN bands, exported rather than left as bare literals.
// reward-grader.ts decides which outcomes are worth a second LLM opinion by
// naming exactly these two (isUncertainReward); it used to hard-code them as a
// numeric 0.2..0.3 range with no import and no coupling test, so moving a band
// here would have silently disabled the grader with a green suite. The
// confident bands (0.0 hard failure, 1.0 success) have no cross-module reader
// and stay literal below.
export const REWARD_ERROR_SHAPED = 0.2;
export const REWARD_EMPTY_BODY = 0.3;

// How much of the first text block rule 2 classifies.
//
// classifyError matches by raw SUBSTRING, and rule 2 used to run it over the
// entire block -- so a large SUCCESSFUL payload that merely contains "not
// found" / "unauthorized" / "forbidden" somewhere in row 37 of a result set was
// graded REWARD_ERROR_SHAPED. Three of those push a healthy search-shaped
// server under PENALTY_RATE_THRESHOLD, and from then on discover() renders it
// as unreliable, doctor/handleHealth list it as flaky, and the counters persist
// to state.json across sessions.
//
// The discriminator is that a genuine soft failure is a MESSAGE -- terse, and
// leading with the failure -- while a result set is DATA that mentions the
// phrase in passing, far from the start. So rule 2 sees only the head.
//
// The window is deliberately GENEROUS rather than a first-line or ~200-char
// cut. The direction that must not break is a genuine soft failure silently
// upgrading to FULL credit, and an error envelope can lead with request context
// (ids, timestamps, echoed args) before it names the failure. 1000 chars clears
// every error body shape observed here while still cutting the multi-KB result
// sets that produced the false positive; a soft failure whose first 1000 chars
// name no error at all is not a shape we have seen.
const RULE2_SCAN_LEN = 1000;

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

// True when the body carries no substance AT ALL: no structuredContent, and
// every content block is a text block with empty/whitespace-only text (or
// content is missing/empty). A NON-text block (image, audio, resource,
// resource_link) is substance -- a screenshot or chart server legitimately
// returns zero text -- and so is spec-legal structured output, where the
// schema says `content` "may be empty". Grading those 0.3 marked perfectly
// healthy servers as flaky (learning down-rank + doctor/discover flaky list).
function isEmptyBody(result: ToolCallResultShape): boolean {
  if (result.structuredContent !== undefined) return false;
  const content = result.content;
  if (!content || content.length === 0) return true;
  for (const block of content) {
    if (block.type !== "text") return false;
    if (typeof block.text === "string" && block.text.trim().length > 0) {
      return false;
    }
  }
  return true;
}

// HEURISTIC. The grade is inferred from the SHAPE of the reply, never from a
// declared success signal: classifyError matches by raw substring, so a reply
// that merely TALKS about a failure ("the not-found handler is registered")
// reads the same as one that IS a failure. RULE2_SCAN_LEN bounds how much of a
// body can trip that, but it cannot settle the genuinely ambiguous case. The
// sound fix is an upstream success-signal schema; until then reward-grader.ts
// can be switched on to ask the client's own LLM for a second opinion on the
// two uncertain bands (REWARD_ERROR_SHAPED / REWARD_EMPTY_BODY).
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
    // guaranteed non-empty here. Only the HEAD is classified -- see
    // RULE2_SCAN_LEN for why a whole-block scan mis-graded large successes.
    const head = text.length > RULE2_SCAN_LEN ? text.slice(0, RULE2_SCAN_LEN) : text;
    if (ERROR_SHAPED_CATEGORIES.has(classifyError(head))) {
      // Rule 2: a 200 reply whose first text block still reads like a
      // recognized error -- upstream returned a soft failure.
      return REWARD_ERROR_SHAPED;
    }
  }

  // Rule 3: empty or whitespace-only body.
  if (isEmptyBody(result)) return REWARD_EMPTY_BODY;

  // Rule 4: genuine success.
  return 1.0;
}
