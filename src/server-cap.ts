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

export interface LoadedSlot {
  namespace: string;
  idleCount: number;
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
export function evaluateServerCap(namespace: string, loaded: LoadedSlot[], cap: number): CapDecision {
  if (cap === 0) return { allow: true }; // disabled
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
  if (loaded.length < cap) return { allow: true };

  const sorted = [...loaded].sort((a, b) => {
    if (b.idleCount !== a.idleCount) return b.idleCount - a.idleCount;
    return a.namespace.localeCompare(b.namespace);
  });
  const list = sorted
    .map((s) => (s.idleCount > 0 ? `"${s.namespace}" (idle ${s.idleCount})` : `"${s.namespace}"`))
    .join(", ");

  return {
    allow: false,
    message: `Cannot load "${namespace}" — already at the ${cap}-server concurrent cap. Loaded: ${list}. Free a slot with mcp_connect_deactivate, or use mcp_connect_read_tool to inspect one tool without loading its server. Ops can change the limit via YAW_MCP_SERVER_CAP.`,
  };
}
