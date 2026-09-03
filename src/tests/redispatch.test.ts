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

  it("markUse after a graded reply protects the record from detectMiss (routing-fault path)", () => {
    // handleToolCall calls markUse instead of markReply when the reply is
    // yaw-mcp's own routing fault: the fault must not GRADE the record,
    // but it is evidence the model kept using the server. Before markUse
    // existed, skipping the tracker on faults left this record frozen as
    // cleanReply-without-furtherUse and detectMiss booked a recordMiss
    // penalty for yaw-mcp's own teardown fault.
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true); // graded clean reply
    t.markUse("github"); // routing fault on the next call -> still usage
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
  });

  it("markUse on an un-replied record leaves it gradable by a later clean retry", () => {
    // A fault as the FIRST reply says nothing about the server, so markUse
    // must not set replied/cleanReply -- the later clean retry grades the
    // record, and a subsequent abandonment can still be detected.
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markUse("github"); // routing fault before any graded reply
    t.markReply("github", true); // clean retry grades the record...
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toEqual({ loser: "github" }); // ...and abandonment still detects
  });

  it("markUse on an unknown namespace is a no-op", () => {
    const t = new RedispatchTracker();
    t.markUse("never-dispatched");
    expect(t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude)).toBeNull();
  });

  it("markReply grades the record for ITS namespace, not the newest dispatch", () => {
    // Pins markReply's namespace filter. Two dispatches are live and the reply
    // belongs to the OLDER one. With the filter deleted, markReply walks to the
    // newest record and grades jira instead -- whose intent shares nothing with
    // INTENT_B -- leaving github un-graded, so the real miss goes undetected.
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.push("jira", tokenize("forecast rainfall humidity"), 1100);
    t.markReply("github", true); // clean reply, then abandoned
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toEqual({ loser: "github" });
  });

  it("markUse protects the record for ITS namespace, not the newest dispatch", () => {
    // Mirror of the above for markUse's namespace filter. The routing fault is
    // github's, on a record github already graded clean, so it must protect
    // github. With the filter deleted, markUse stops at the newest record
    // (jira, which never replied), no-ops, and leaves github looking
    // abandoned-clean -- a false miss booked against a server still in use.
    const t = new RedispatchTracker();
    t.push("github", tokenize(INTENT_A), 1000);
    t.markReply("github", true); // graded clean reply
    t.push("jira", tokenize("forecast rainfall humidity"), 1100);
    t.markUse("github"); // routing fault on github -> still usage
    const miss = t.detectMiss("gitlab", tokenize(INTENT_B), 2000, noExclude);
    expect(miss).toBeNull();
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

  it("does not fire when 3 shared tokens sit in two mostly-different intents (Jaccard floor)", () => {
    // Isolates JACCARD_THRESHOLD from MIN_SHARED_TOKENS. Both intents keep 10
    // tokens through tokenize's 3-char floor and share exactly {create, github,
    // issue}: shared = 3 CLEARS the shared-token floor, but 3/17 = 0.18 is far
    // below the 0.4 Jaccard floor. Deleting the Jaccard guard books this as a
    // miss even though the two tasks have almost nothing in common.
    const t = new RedispatchTracker();
    t.push("github", tokenize("create github issue tracker board column label filter export archive"), 1000);
    t.markReply("github", true);
    const miss = t.detectMiss(
      "gitlab",
      tokenize("create github issue milestone summary digest weekly report team channel"),
      2000,
      noExclude,
    );
    expect(miss).toBeNull();
  });

  it("does not fire when a high Jaccard rests on only 2 shared tokens (shared-token floor)", () => {
    // Isolates MIN_SHARED_TOKENS from JACCARD_THRESHOLD, which the
    // single-common-word case above cannot: {list, issues} vs {list, open,
    // issues} shares 2 of a 3-token union -> 0.67, well clear of the 0.4
    // Jaccard floor, but 2 shared tokens is below the floor of 3. Deleting the
    // shared-token guard books this as a miss.
    const t = new RedispatchTracker();
    t.push("github", tokenize("list issues"), 1000);
    t.markReply("github", true);
    const miss = t.detectMiss("calendar", tokenize("list open issues"), 2000, noExclude);
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
