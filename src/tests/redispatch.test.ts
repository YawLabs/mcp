import { describe, expect, it } from "vitest";
import { RedispatchTracker } from "../redispatch.js";
import { tokenize } from "../relevance.js";

// Never-exclude stub for the common case.
const noExclude = () => false;

// Two intents that share >= 3 tokens (each >= 3 chars, so they survive
// tokenize's MIN_TOKEN_LEN filter) and clear Jaccard >= 0.4.
//   tokens(A): create github issue tracker  -> {create, github, issue, tracker}
//   tokens(B): create gitlab issue tracker  -> {create, gitlab, issue, tracker}
// shared = {create, issue, tracker} = 3; union = 5; jaccard = 0.6.
const INTENT_A = "create github issue tracker";
const INTENT_B = "create gitlab issue tracker";

describe("RedispatchTracker", () => {
  it("flags a similar-intent re-route to a different server as a miss", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true); // clean reply, then abandoned
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toEqual({ loser: "github" });
  });

  it("returns null when the new intent is dissimilar", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    // Shares no tokens with INTENT_A.
    const miss = t.detectMiss("weather", tokenize("forecast rainfall humidity"), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("does not fire when a single common word is the only overlap", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize("list repositories"), 1000);
    t.markReply("github", true);
    // Shares only "list" -> below MIN_SHARED_TOKENS (3).
    const miss = t.detectMiss("calendar", tokenize("list meetings"), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("returns null for a same-server re-dispatch (retry, not miss)", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    const miss = t.detectMiss("github", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("returns null when the re-route is outside the time window", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    // 1000 + 120_000 = 121_000 is the edge; 1 ms past it is out.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 121_001, noExclude);
    expect(miss).toBeNull();
  });

  it("still fires at the exact window boundary", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 121_000, noExclude);
    expect(miss).toEqual({ loser: "github" });
  });

  it("returns null when isExcluded marks the pair a legitimate chain", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    const isExcluded = (a: string, b: string) => a === "github" && b === "gitlab";
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, isExcluded);
    expect(miss).toBeNull();
  });

  it("returns null when the server kept getting used (furtherUse)", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true); // first clean reply -> cleanReply
    t.markReply("github", true); // used again -> furtherUse, not abandoned
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("returns null when the server never replied cleanly", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    // No markReply -> cleanReply stays false -> not a miss candidate.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("treats a non-clean first reply as not-abandoned-cleanly", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", false); // error reply -> cleanReply stays false
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("only fires once per loser (record is consumed)", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    expect(t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude)).toEqual({
      loser: "github",
    });
    // Same shape again -> already consumed -> null.
    expect(t.detectMiss("gitlab", tokenize(INTENT_B), 2500, noExclude)).toBeNull();
  });

  it("returns the most-recent qualifying record as the loser", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    t.push("jira", tokenize(INTENT_A), 1500);
    t.markReply("jira", true);
    // Both github and jira are abandoned + similar; newest (jira) wins.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toEqual({ loser: "jira" });
  });

  it("does not fire a stale same-namespace record after a second dispatch to it", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true); // R1 clean -> looks abandoned-clean
    // A second, later dispatch to github (R2) means github was NOT abandoned;
    // push must flag the earlier un-consumed github record as furtherUse.
    t.push("github", tokenize("create github milestone board"), 1500);
    t.markReply("github", true); // marks R2, not R1
    // Without the push-time furtherUse marking, R1 would fire here as a false
    // miss even though github was used cleanly twice.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("treats an error-then-success sequence as kept-using, not abandoned-clean", () => {
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", false); // first reply errored
    t.markReply("github", true); // second reply clean -> furtherUse (used twice)
    // Pre-fix this left {cleanReply:true, furtherUse:false} and fired a false
    // miss; now the second reply flips furtherUse so it never qualifies.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("evicts the oldest record once the ring exceeds capacity", () => {
    const t = new RedispatchTracker();
    // Push the abandoned candidate first, then 8 more to evict it (cap 8).
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true);
    for (let i = 0; i < 8; i++) {
      t.push(`filler${i}`, tokenize(`unrelated topic number ${i}`), 1100 + i);
    }
    // github has fallen off the ring -> can't be detected as a loser.
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });
});
