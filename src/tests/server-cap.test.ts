import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CapDecision,
  DEFAULT_SERVER_CAP,
  DEFAULT_TOOL_TOKEN_CAP,
  evaluateServerCap,
  resolveServerCap,
  resolveToolTokenCap,
} from "../server-cap.js";

/** Narrow a decision to its refusal arm and hand back the message.
 *  CapDecision is a discriminated union — `message` rides the refusal arm
 *  only — so a test that reads it has to narrow first. Throwing here (rather
 *  than a `?? ""` fallback) means an unexpected allow fails the test where it
 *  happened, instead of quietly asserting against an empty string. */
function expectRefusal(decision: CapDecision): string {
  if (decision.allow) throw new Error("expected a cap refusal, got allow:true");
  return decision.message;
}

describe("resolveServerCap", () => {
  const originalEnv = process.env.YAW_MCP_SERVER_CAP;

  beforeEach(() => {
    delete process.env.YAW_MCP_SERVER_CAP;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.YAW_MCP_SERVER_CAP;
    } else {
      process.env.YAW_MCP_SERVER_CAP = originalEnv;
    }
  });

  it("returns the default when env is unset", () => {
    expect(resolveServerCap({})).toBe(DEFAULT_SERVER_CAP);
  });

  it("returns the default when env is empty string", () => {
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "" })).toBe(DEFAULT_SERVER_CAP);
  });

  it("honors a valid positive override", () => {
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "12" })).toBe(12);
  });

  it("honors 0 as 'disabled'", () => {
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "0" })).toBe(0);
  });

  it("falls back to the default on invalid input rather than erroring", () => {
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "abc" })).toBe(DEFAULT_SERVER_CAP);
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "-2" })).toBe(DEFAULT_SERVER_CAP);
  });

  it("falls back to the default on values parseInt would prefix-truncate", () => {
    // parseInt("0x10", 10) -> 0, parseInt("0.5", 10) -> 0, parseInt("0abc",
    // 10) -> 0: each malformed value would land on the disable-the-cap
    // sentinel and silently REMOVE the ceiling instead of defaulting.
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "0x10" })).toBe(DEFAULT_SERVER_CAP);
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "0.5" })).toBe(DEFAULT_SERVER_CAP);
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "0abc" })).toBe(DEFAULT_SERVER_CAP);
    // Trailing garbage and scientific notation must not be silently
    // truncated either: "6 servers" -> 6 and "1e2" -> 1 under parseInt.
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "6 servers" })).toBe(DEFAULT_SERVER_CAP);
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: "1e2" })).toBe(DEFAULT_SERVER_CAP);
  });

  it("tolerates surrounding whitespace on an otherwise-valid value", () => {
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: " 8 " })).toBe(8);
    expect(resolveServerCap({ YAW_MCP_SERVER_CAP: " 0 " })).toBe(0);
  });

  // Every case above injects an explicit env object, which exercises the
  // parse but never the default parameter. The no-arg call is the one
  // production actually makes (`private serverCap = resolveServerCap()` in
  // server.ts), and it is what makes the beforeEach/afterEach save-and-restore
  // scaffolding above load-bearing rather than decorative.
  it("reads process.env when called with no argument — the shape server.ts uses", () => {
    process.env.YAW_MCP_SERVER_CAP = "9";
    expect(resolveServerCap()).toBe(9);
  });

  it("defaults from an unset process.env when called with no argument", () => {
    // beforeEach already deleted the var; this is the ambient-shell case.
    expect(process.env.YAW_MCP_SERVER_CAP).toBeUndefined();
    expect(resolveServerCap()).toBe(DEFAULT_SERVER_CAP);
  });
});

describe("evaluateServerCap", () => {
  it("allows when the cap is disabled (0)", () => {
    const loaded = Array.from({ length: 20 }, (_, i) => ({ namespace: `s${i}`, idleCount: 0 }));
    expect(evaluateServerCap("new", loaded, 0)).toEqual({ allow: true });
  });

  it("allows when under the cap", () => {
    expect(evaluateServerCap("new", [{ namespace: "a", idleCount: 0 }], 3)).toEqual({ allow: true });
  });

  it("allows when the namespace is already loaded (re-activation is a no-op)", () => {
    const loaded = [
      { namespace: "a", idleCount: 0 },
      { namespace: "b", idleCount: 0 },
      { namespace: "c", idleCount: 0 },
    ];
    expect(evaluateServerCap("a", loaded, 3)).toEqual({ allow: true });
  });

  it("refuses when at cap for a new namespace", () => {
    const loaded = [
      { namespace: "a", idleCount: 0 },
      { namespace: "b", idleCount: 0 },
    ];
    const message = expectRefusal(evaluateServerCap("c", loaded, 2));
    expect(message).toContain('Cannot load "c"');
    expect(message).toContain("2-server concurrent cap");
  });

  it("surfaces remediation hints — deactivate + read_tool + env override", () => {
    const message = expectRefusal(evaluateServerCap("new", [{ namespace: "a", idleCount: 0 }], 1));
    expect(message).toContain("mcp_connect_deactivate");
    expect(message).toContain("mcp_connect_read_tool");
    expect(message).toContain("YAW_MCP_SERVER_CAP");
  });

  it("lists loaded servers by descending idle count so the cheapest drop shows first", () => {
    const msg = expectRefusal(
      evaluateServerCap(
        "new",
        [
          { namespace: "fresh", idleCount: 0 },
          { namespace: "stale", idleCount: 7 },
          { namespace: "mid", idleCount: 3 },
        ],
        3,
      ),
    );
    const staleIdx = msg.indexOf("stale");
    const midIdx = msg.indexOf("mid");
    const freshIdx = msg.indexOf("fresh");
    expect(staleIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(freshIdx);
    expect(msg).toContain('"stale" (idle 7)');
    // Zero-idle servers render without the parenthetical.
    expect(msg).toContain('"fresh"');
    expect(msg).not.toContain('"fresh" (idle 0)');
  });

  it("breaks idle ties alphabetically for stable output", () => {
    const msg = expectRefusal(
      evaluateServerCap(
        "new",
        [
          { namespace: "zebra", idleCount: 2 },
          { namespace: "apple", idleCount: 2 },
        ],
        2,
      ),
    );
    expect(msg.indexOf("apple")).toBeLessThan(msg.indexOf("zebra"));
  });

  it("counts exactly the slots it is given — the caller decides what an error-state connection is", () => {
    // Contract test: the helper has no notion of connection status, so the
    // filtering server.ts's evaluateCapFor does is what a dead slot costs.
    // Both halves are needed: passing an empty list and expecting `allow`
    // proves nothing, because that is the same input class as "allows when
    // under the cap" and can never refuse.
    const withDeadSlot = [
      { namespace: "a", idleCount: 0 },
      { namespace: "dead", idleCount: 0 },
    ];
    // Handed the dead slot, it counts: the cap is full and a new namespace
    // is refused.
    expect(expectRefusal(evaluateServerCap("new", withDeadSlot, 2))).toContain('Cannot load "new"');
    // Filtered out by the caller, the same cap has room.
    expect(evaluateServerCap("new", [{ namespace: "a", idleCount: 0 }], 2)).toEqual({ allow: true });
    // And the candidate's OWN entry in the list is a slot it already holds —
    // the self-allowance server.ts leans on so an auto-reconnect of an
    // error-state connection is not refused at a full cap.
    expect(evaluateServerCap("dead", withDeadSlot, 2)).toEqual({ allow: true });
  });
});

describe("resolveToolTokenCap", () => {
  const orig = process.env.YAW_MCP_TOOL_TOKEN_CAP;
  afterEach(() => {
    if (orig === undefined) delete process.env.YAW_MCP_TOOL_TOKEN_CAP;
    else process.env.YAW_MCP_TOOL_TOKEN_CAP = orig;
  });

  it("is off unless ops arms it", () => {
    delete process.env.YAW_MCP_TOOL_TOKEN_CAP;
    expect(resolveToolTokenCap({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TOOL_TOKEN_CAP);
    expect(DEFAULT_TOOL_TOKEN_CAP).toBe(0);
  });

  it("reads a plain digit run", () => {
    expect(resolveToolTokenCap({ YAW_MCP_TOOL_TOKEN_CAP: "8000" } as NodeJS.ProcessEnv)).toBe(8000);
  });

  it("falls back to off rather than a silently smaller ceiling on a typo", () => {
    // parseInt would read "0x2000" as 0 -- which is the DISABLE sentinel, so
    // the typo would remove the ceiling while looking like it set one. Both
    // land on the documented default instead.
    expect(resolveToolTokenCap({ YAW_MCP_TOOL_TOKEN_CAP: "0x2000" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveToolTokenCap({ YAW_MCP_TOOL_TOKEN_CAP: "8e3" } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveToolTokenCap({ YAW_MCP_TOOL_TOKEN_CAP: "  " } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("token ceiling", () => {
  const slot = (namespace: string, tokens?: number, idleCount = 0) => ({ namespace, idleCount, tokens });

  it("does nothing when the ceiling is unarmed", () => {
    const loaded = [slot("a", 9_000), slot("b", 9_000)];
    expect(evaluateServerCap("c", loaded, 6, { candidateTokens: 9_000 })).toEqual({ allow: true });
  });

  it("does nothing when the candidate could not be estimated", () => {
    // An unmeasured candidate is an unknown, not a free one. Refusing on a
    // guess would block a load the count cap was happy to admit.
    const loaded = [slot("a", 9_000)];
    expect(evaluateServerCap("c", loaded, 6, { tokenCap: 10_000 })).toEqual({ allow: true });
  });

  it("refuses a load that would cross the ceiling", () => {
    const loaded = [slot("a", 6_000)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 6, { tokenCap: 10_000, candidateTokens: 5_000 }));
    expect(msg).toContain("~11000");
    expect(msg).toContain("~10000-token ceiling");
    expect(msg).toContain("by ~1000");
    expect(msg).toContain("YAW_MCP_TOOL_TOKEN_CAP");
  });

  it("admits a load that lands exactly on the ceiling", () => {
    const loaded = [slot("a", 6_000)];
    expect(evaluateServerCap("c", loaded, 6, { tokenCap: 10_000, candidateTokens: 4_000 })).toEqual({ allow: true });
  });

  it("refuses under the count cap when the surface is too big", () => {
    // The whole reason the second dimension exists: one slot used, five free,
    // and the loaded surface is already what the model cannot reason about.
    const loaded = [slot("huge", 40_000)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 6, { tokenCap: 20_000, candidateTokens: 500 }));
    expect(msg).toContain('Cannot load "c"');
    expect(msg).toContain("huge");
  });

  it("names the most expensive server first, not the most idle", () => {
    // The count-cap message sorts by idleness because a slot is a slot there.
    // Over a TOKEN budget the cheapest way back under it is the biggest
    // server, which here is the LEAST idle one.
    const loaded = [slot("small", 500, 9), slot("big", 30_000, 0)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 6, { tokenCap: 20_000, candidateTokens: 100 }));
    expect(msg.indexOf('"big"')).toBeLessThan(msg.indexOf('"small"'));
  });

  it("omits the token figure for a slot that was never estimated", () => {
    const loaded = [slot("known", 30_000), slot("unmeasured", undefined, 3)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 6, { tokenCap: 20_000, candidateTokens: 100 }));
    expect(msg).toContain('"unmeasured" (idle 3)');
    expect(msg).not.toContain("~0 tokens");
  });

  it("prints a measured zero, because that IS the answer", () => {
    // Distinct from the case above: a connected upstream advertising no tools
    // really does cost nothing, and saying so is what tells the model that
    // dropping it will not free any budget.
    const loaded = [slot("empty", 0, 2), slot("known", 30_000)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 6, { tokenCap: 20_000, candidateTokens: 100 }));
    expect(msg).toContain('"empty" (idle 2, ~0 tokens)');
  });

  it("still self-allows a namespace already holding a slot", () => {
    // Re-admitting something already loaded costs nothing, so it must clear
    // the token ceiling for the same reason it clears the count cap.
    const loaded = [slot("a", 90_000)];
    expect(evaluateServerCap("a", loaded, 6, { tokenCap: 1_000, candidateTokens: 90_000 })).toEqual({ allow: true });
  });

  it("applies with the count cap disabled", () => {
    // cap===0 turns the COUNT gate off; it must not turn an armed token
    // ceiling off with it.
    const loaded = [slot("a", 30_000)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 0, { tokenCap: 20_000, candidateTokens: 100 }));
    expect(msg).toContain("token ceiling");
  });

  it("allows freely when both dimensions are disabled", () => {
    const loaded = [slot("a", 30_000), slot("b", 30_000)];
    expect(evaluateServerCap("c", loaded, 0, { tokenCap: 0, candidateTokens: 30_000 })).toEqual({ allow: true });
  });

  it("counts an un-estimated loaded slot as nothing rather than guessing", () => {
    const loaded = [slot("a", undefined), slot("b", 5_000)];
    expect(evaluateServerCap("c", loaded, 6, { tokenCap: 10_000, candidateTokens: 5_000 })).toEqual({ allow: true });
  });

  it("prefers the token refusal over the count refusal when both would fire", () => {
    const loaded = [slot("a", 9_000), slot("b", 9_000)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 2, { tokenCap: 10_000, candidateTokens: 5_000 }));
    expect(msg).toContain("token ceiling");
    expect(msg).not.toContain("concurrent cap");
  });

  it("still reports the count refusal when only the count is exceeded", () => {
    const loaded = [slot("a", 100), slot("b", 100)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 2, { tokenCap: 10_000, candidateTokens: 100 }));
    expect(msg).toContain("2-server concurrent cap");
  });

  it("shows the token cost in the count-cap refusal so the model can pick a victim", () => {
    const loaded = [slot("a", 4_000, 1), slot("b", 300, 5)];
    const msg = expectRefusal(evaluateServerCap("c", loaded, 2));
    expect(msg).toContain("~4000 tokens");
    expect(msg).toContain("idle 5");
  });
});
