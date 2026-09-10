// Concurrent server cap. Puts a hard ceiling on how many MCP servers
// can be simultaneously loaded in a session so a chatty LLM doesn't
// balloon its own context by activating twelve servers "just in case."
// The idle auto-unload (see idle-ttl.ts) already trims unused servers
// after N non-matching tool calls, but that's reactive — a burst of
// activations in a short window can still inflate context past what
// the LLM can reason about before any auto-unload fires. This cap
// refuses the activation at the door instead.
//
// Default is 6 — large enough for the common "2-3 task areas, each
// with 1-2 servers" shape, small enough to keep tool-list tokens
// bounded. Ops can raise or lower via YAW_MCP_SERVER_CAP.

export const DEFAULT_SERVER_CAP = 6;

// 0 disables the cap entirely (for ops/tests); any positive integer
// overrides the default. Invalid values fall back to the default
// rather than erroring — a typo in env shouldn't brick activations.
export function resolveServerCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.YAW_MCP_SERVER_CAP;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_CAP;
  // Strict digit-run parse. parseInt's prefix parsing would turn "0x10",
  // "0.5", and "0abc" into 0 -- the disable-the-cap sentinel -- and "1e2"
  // into 1, so a malformed value could silently REMOVE or shrink the
  // ceiling instead of falling back to the default as promised above.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_SERVER_CAP;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return DEFAULT_SERVER_CAP;
  return n;
}

// Token ceiling across every loaded server's advertised tool surface.
// 0 (the default) leaves it off, and the server-count cap above is the only
// gate -- which is the honest default, because the estimate is an estimate.
//
// It exists because the count cap alone measures the wrong thing. Its own
// header says the point is to "keep tool-list tokens bounded", but a slot is
// a slot: six 3-tool servers and six 60-tool servers both sit exactly at a
// cap of 6, and only one of those fits in a context the model can still
// reason about. cost-estimate.ts has computed the real number all along and
// nothing read it outside a discover label.
export const DEFAULT_TOOL_TOKEN_CAP = 0;

export function resolveToolTokenCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.YAW_MCP_TOOL_TOKEN_CAP;
  if (raw === undefined || raw === "") return DEFAULT_TOOL_TOKEN_CAP;
  // Same strict digit-run parse as resolveServerCap, for the same reason:
  // parseInt's prefix parsing turns "0x2000" and "0abc" into 0, which is the
  // DISABLE sentinel here too, so a typo would silently remove the ceiling.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_TOOL_TOKEN_CAP;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return DEFAULT_TOOL_TOKEN_CAP;
  return n;
}

export interface LoadedSlot {
  namespace: string;
  idleCount: number;
  /** Estimated tool-surface tokens (cost-estimate.ts). Absent when the
   *  caller could not estimate -- such a slot contributes 0 to the token
   *  total and renders without a token figure, so an unknown never
   *  manufactures a refusal. */
  tokens?: number;
}

/** What a candidate would ADD, for the token ceiling. Optional throughout:
 *  with no estimate, only the count cap can refuse. */
export interface CapContext {
  tokenCap?: number;
  candidateTokens?: number;
}

// A discriminated union, not `{ allow: boolean; message?: string }`: the
// refusal text is present exactly when `allow` is false, and encoding that in
// the type is what makes the callers' `capDecision.message ?? "<fallback>"`
// unnecessary. With the optional-property shape every caller had to carry a
// fallback string that could never run -- and would quietly stand in for the
// real message if a future edit dropped it, turning a regression into a
// vaguer error instead of a red typecheck.
export type CapDecision = { allow: true } | { allow: false; message: string };

// Decide whether to permit activating `namespace` given the set of
// currently-loaded slots and the cap. Returns a helpful error message
// when refused so the LLM can course-correct without a follow-up
// discover roundtrip.
//
// Ordering: the error lists loaded servers by descending idleCount
// (most-idle first) so the LLM's attention lands on the cheapest
// thing to drop, followed by read_tool as a zero-activation fallback.
export function evaluateServerCap(
  namespace: string,
  loaded: LoadedSlot[],
  cap: number,
  context: CapContext = {},
): CapDecision {
  const tokenCap = context.tokenCap ?? 0;
  if (cap === 0 && tokenCap === 0) return { allow: true }; // both disabled
  // Self-allowance: the candidate already occupies one of the slots the
  // CALLER passed in, so admitting it costs nothing. It covers exactly what
  // is in `loaded` and nothing else -- server.ts's evaluateCapFor puts the
  // candidate's own error-state connection in the list (an auto-reconnect
  // rides the slot it already holds) but deliberately filters the
  // candidate's own pending reservation OUT before calling. So a re-entrant
  // activation of a namespace that is only mid-flight gets no exemption
  // here; the post-elicitation retry stays unblocked because it passes
  // skipCap, not because of this line.
  if (loaded.some((s) => s.namespace === namespace)) return { allow: true };

  // Token ceiling first when both are armed. It is the more informative
  // refusal: "you are at 6 servers" says nothing about which to drop, while
  // the token message names the figure that is actually over budget. A
  // caller under the count cap can still be over the token cap, which is
  // the whole point of having the second dimension.
  if (tokenCap > 0 && context.candidateTokens !== undefined) {
    const loadedTokens = loaded.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
    const projected = loadedTokens + context.candidateTokens;
    if (projected > tokenCap) {
      return {
        allow: false,
        message: tokenRefusal(namespace, loaded, context.candidateTokens, loadedTokens, tokenCap),
      };
    }
  }

  if (cap === 0 || loaded.length < cap) return { allow: true };

  const sorted = [...loaded].sort((a, b) => {
    if (b.idleCount !== a.idleCount) return b.idleCount - a.idleCount;
    return a.namespace.localeCompare(b.namespace);
  });
  const list = sorted.map(describeSlot).join(", ");

  return {
    allow: false,
    message: `Cannot load "${namespace}" — already at the ${cap}-server concurrent cap. Loaded: ${list}. Free a slot with mcp_connect_deactivate, or use mcp_connect_read_tool to inspect one tool without loading its server. Ops can change the limit via YAW_MCP_SERVER_CAP.`,
  };
}

// One loaded server, as the refusal renders it: how stale it is, and how much
// it costs -- the two facts the model needs to choose a victim.
//
// The two fields are omitted for different reasons, and only one of them is
// about zero. `idleCount` is a plain number, and "idle 0" says nothing worth
// the width, so a zero is dropped. `tokens` is optional, and an ABSENT one is
// an unknown -- rendering it as "~0 tokens" would assert the server is free.
// A tokens of exactly 0 is a real measurement (a connected upstream that
// advertises no tools) and prints, because knowing a slot costs nothing is
// exactly what tells the model that dropping it will not help.
function describeSlot(s: LoadedSlot): string {
  const facts: string[] = [];
  if (s.idleCount > 0) facts.push(`idle ${s.idleCount}`);
  if (s.tokens !== undefined) facts.push(`~${s.tokens} tokens`);
  return facts.length > 0 ? `"${s.namespace}" (${facts.join(", ")})` : `"${s.namespace}"`;
}

// Ordered by token cost, descending -- the count-cap message sorts by
// idleness because a slot is a slot there, but here the model is over a
// TOKEN budget and the cheapest way back under it is to drop the most
// expensive server, which is not usually the most idle one.
function tokenRefusal(
  namespace: string,
  loaded: LoadedSlot[],
  candidateTokens: number,
  loadedTokens: number,
  tokenCap: number,
): string {
  const sorted = [...loaded].sort((a, b) => {
    const at = a.tokens ?? 0;
    const bt = b.tokens ?? 0;
    if (bt !== at) return bt - at;
    return a.namespace.localeCompare(b.namespace);
  });
  const list = sorted.map(describeSlot).join(", ");
  const over = loadedTokens + candidateTokens - tokenCap;
  return `Cannot load "${namespace}" — its ~${candidateTokens} tokens of tools would put the loaded surface at ~${loadedTokens + candidateTokens}, over the ~${tokenCap}-token ceiling by ~${over}. Loaded, most expensive first: ${list}. Free the budget with mcp_connect_deactivate, or use mcp_connect_read_tool to inspect one tool without loading its server. Ops can change the limit via YAW_MCP_TOOL_TOKEN_CAP.`;
}
