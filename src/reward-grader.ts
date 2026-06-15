// Optional LLM grader: a SECOND opinion on the dispatch reward.
//
// reward.ts/computeOutcomeReward grades a tool-call outcome with cheap
// keyword heuristics (isError -> 0.0, error-shaped 200 -> 0.2, empty body ->
// 0.3, else 1.0). Those heuristics are sound at the extremes but uncertain in
// the middle: a "no results found" reply (scored 0.2) may actually be the
// CORRECT answer, and an empty body (0.3) from a delete may be a genuine
// success -- or a silent failure. This module asks the client's own LLM, via
// MCP sampling, "did this call accomplish the goal?" and maps the answer back
// to a graded reward.
//
// It is deliberately:
//   - OPT-IN (YAW_MCP_REWARD_GRADER): it spends the client's LLM budget and
//     adds a round-trip, so it is off by default.
//   - BOUNDED: only the uncertain heuristic bands (0.2 / 0.3) are graded; the
//     confident 0.0 (hard error) and 1.0 (clean non-empty) skip the call.
//   - NON-BLOCKING at the call site: the caller records the heuristic reward
//     immediately and applies the grader's correction in the background, so a
//     tool result never waits on the grade (see server.ts handleToolCall).
//   - NEVER-THROWING: any failure (no sampling capability, timeout, declined,
//     unparseable) returns null and the heuristic stands.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./logger.js";
import type { ToolCallResultShape } from "./reward.js";

// Opt-in ONLY. True when YAW_MCP_REWARD_GRADER is exactly "1" or "true"
// (case-insensitive, whitespace-trimmed). Anything else is disabled.
export function isRewardGraderEnabled(): boolean {
  const raw = process.env.YAW_MCP_REWARD_GRADER;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

// Which heuristic rewards are worth a second opinion. 0.0 (hard isError) and
// 1.0 (clean, non-empty, non-error-shaped) are confident; the soft-failure
// (0.2) and empty-body (0.3) bands are where the keyword heuristic is most
// likely wrong in EITHER direction, so those are the only ones we grade.
export function isUncertainReward(heuristic: number): boolean {
  return heuristic >= 0.2 && heuristic <= 0.3;
}

// Keep the grader cheap: one word out, a short slice of the result in.
const GRADER_MAX_TOKENS = 8;
const GRADER_TIMEOUT_MS = 4000;
const RESULT_SNIPPET_LEN = 600;

export interface GraderContext {
  // The dispatch intent the server was routed for, if known. Best-effort:
  // the proxy path doesn't always have it, so the prompt degrades gracefully.
  intent?: string;
  toolName: string;
  resultText: string;
}

// First non-empty text block of a tool result, truncated for the prompt.
// Returns "(empty result)" when there is no usable text.
export function firstResultText(result: ToolCallResultShape): string {
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block.text === "string" && block.text.trim().length > 0) {
        const t = block.text.trim();
        return t.length > RESULT_SNIPPET_LEN ? `${t.slice(0, RESULT_SNIPPET_LEN)}...` : t;
      }
    }
  }
  return "(empty result)";
}

export function buildGraderPrompt(ctx: GraderContext): string {
  const lines = ["You are grading whether an MCP tool call accomplished its goal."];
  if (ctx.intent && ctx.intent.trim().length > 0) {
    lines.push("", `Goal: ${ctx.intent.trim()}`);
  }
  lines.push(
    "",
    `Tool called: ${ctx.toolName}`,
    `Result (truncated): ${ctx.resultText}`,
    "",
    "Did the tool call accomplish the goal / return a useful, on-task result?",
    "Reply with ONLY one word: YES, PARTIAL, or NO.",
  );
  return lines.join("\n");
}

// Map the LLM's one-word reply to a graded reward. YES -> 1.0, PARTIAL -> 0.5,
// NO -> 0.0. Returns null when no recognizable verdict appears so the caller
// keeps the heuristic. Scans the FIRST matching token so a little stray prose
// ("NO, it failed") still resolves.
export function parseGrade(text: string): number | null {
  const m = /\b(yes|partial|no)\b/i.exec(text);
  if (!m) return null;
  switch (m[1].toLowerCase()) {
    case "yes":
      return 1.0;
    case "partial":
      return 0.5;
    default:
      return 0.0;
  }
}

// Ask the client LLM to grade the outcome. Returns the graded reward in
// {0.0, 0.5, 1.0}, or null when sampling is unavailable / declined / timed
// out / unparseable. Never throws.
export async function gradeOutcomeViaSampling(server: Server, ctx: GraderContext): Promise<number | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;

  const prompt = buildGraderPrompt(ctx);
  try {
    const result = await withTimeout(
      server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: GRADER_MAX_TOKENS,
        includeContext: "none",
      }),
      GRADER_TIMEOUT_MS,
    );
    if (!result || typeof result !== "object" || !("content" in result) || !result.content) return null;
    const text = extractText(result.content);
    if (!text) return null;
    return parseGrade(text);
  } catch (err) {
    log("warn", "Reward grader sampling failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Resolve to null after ms rather than hang the (background) grade forever.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

// createMessage content can be a single block or an array; collect text.
function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c ? String(c.text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "type" in content) {
    const block = content as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}
