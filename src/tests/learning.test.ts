import { describe, expect, it } from "vitest";
import { LEARNING_MAX_BOOST, LEARNING_MIN_BOOST, LEARNING_MIN_OBSERVATIONS, LearningStore } from "../learning.js";

describe("LearningStore", () => {
  it("returns 1.0 boost for unknown namespaces", () => {
    const store = new LearningStore();
    expect(store.boostFactor("never-seen")).toBe(1.0);
  });

  it("returns 1.0 boost below the observation floor", () => {
    const store = new LearningStore();
    for (let i = 0; i < LEARNING_MIN_OBSERVATIONS - 1; i++) {
      store.recordSuccess("gh");
    }
    expect(store.boostFactor("gh")).toBe(1.0);
  });

  it("returns a boost between 1.0 and MAX once the floor is hit", () => {
    const store = new LearningStore();
    for (let i = 0; i < LEARNING_MIN_OBSERVATIONS; i++) {
      store.recordSuccess("gh");
    }
    const factor = store.boostFactor("gh");
    expect(factor).toBeGreaterThan(1.0);
    expect(factor).toBeLessThan(LEARNING_MAX_BOOST);
  });

  it("caps boost at LEARNING_MAX_BOOST even with many successes", () => {
    const store = new LearningStore();
    for (let i = 0; i < 1000; i++) {
      store.recordSuccess("gh");
    }
    expect(store.boostFactor("gh")).toBe(LEARNING_MAX_BOOST);
  });

  it("records dispatches separately from successes", () => {
    const store = new LearningStore();
    store.recordDispatch("gh");
    const u = store.get("gh");
    expect(u?.dispatched).toBe(1);
    expect(u?.succeeded).toBe(0);
  });

  it("increments succeeded and sets lastUsedAt on recordSuccess", () => {
    const store = new LearningStore();
    const before = Date.now();
    store.recordSuccess("gh");
    const u = store.get("gh");
    expect(u?.succeeded).toBe(1);
    expect(u?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it("reset clears all state", () => {
    const store = new LearningStore();
    store.recordSuccess("gh");
    store.reset();
    expect(store.get("gh")).toBeUndefined();
  });

  describe("recordSuccess without prior recordDispatch (fix 11)", () => {
    it("does not understate dispatched when only successes are recorded", () => {
      const store = new LearningStore();
      // Record 5 successes without any recordDispatch call. The coerce in
      // boostFactor must treat dispatched = max(0, 5) = 5, not 0 -- a 0
      // dispatched count would produce a 0/0 rate (NaN) or a 5/0 rate
      // (Infinity), both of which would corrupt the penalty/boost logic.
      for (let i = 0; i < 5; i++) {
        store.recordSuccess("solo");
      }
      const u = store.get("solo");
      // recordSuccess seeds dispatched to 1 on first call (no prior entry),
      // so after 5 pure successes dispatched is 1 and succeeded is 5.
      // The coerce in boostFactor must treat dispatched as at least succeeded
      // (i.e. max(1, 5) = 5) so the rate stays in [0, 1] and no penalty fires.
      expect(u?.dispatched).toBe(1);
      expect(u?.succeeded).toBe(5);
      // boostFactor must be >= 1.0, not NaN or penalty.
      const factor = store.boostFactor("solo");
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThanOrEqual(1.0);
    });

    it("rate stays in [0,1] when dispatched < succeeded", () => {
      const store = new LearningStore();
      store.loadSnapshot({ ns: { dispatched: 2, succeeded: 5, lastUsedAt: 1 } });
      // dispatched=2, succeeded=5: coerce -> dispatched=5, rate=1.0 -> no penalty.
      const factor = store.boostFactor("ns");
      expect(factor).toBeGreaterThanOrEqual(1.0);
    });
  });

  describe("penalty branch", () => {
    it("penalizes flaky history below 80% success rate", () => {
      const store = new LearningStore();
      store.loadSnapshot({ flaky: { dispatched: 10, succeeded: 3, lastUsedAt: 1 } });
      const factor = store.boostFactor("flaky");
      expect(factor).toBeLessThan(1.0);
      expect(factor).toBeGreaterThanOrEqual(LEARNING_MIN_BOOST);
    });

    it("floors the penalty at LEARNING_MIN_BOOST at 0% success", () => {
      const store = new LearningStore();
      store.loadSnapshot({ dead: { dispatched: 5, succeeded: 0, lastUsedAt: 1 } });
      expect(store.boostFactor("dead")).toBe(LEARNING_MIN_BOOST);
    });

    it("does not penalize at or above the 80% success boundary", () => {
      const store = new LearningStore();
      store.loadSnapshot({ borderline: { dispatched: 10, succeeded: 8, lastUsedAt: 1 } });
      expect(store.boostFactor("borderline")).toBeGreaterThanOrEqual(1.0);
    });

    it("does not penalize below the observation floor (noise suppression)", () => {
      const store = new LearningStore();
      store.loadSnapshot({ rare: { dispatched: 2, succeeded: 0, lastUsedAt: 1 } });
      expect(store.boostFactor("rare")).toBe(1.0);
    });

    it("penalty beats positive boost when the overall success rate is poor", () => {
      const store = new LearningStore();
      // 10 successes would normally saturate to LEARNING_MAX_BOOST, but
      // the 50% overall rate triggers the penalty branch instead.
      store.loadSnapshot({ mixed: { dispatched: 20, succeeded: 10, lastUsedAt: 1 } });
      expect(store.boostFactor("mixed")).toBeLessThan(1.0);
    });

    it("penalty scales proportionally with the shortfall from the threshold", () => {
      const store = new LearningStore();
      store.loadSnapshot({
        mild: { dispatched: 10, succeeded: 7, lastUsedAt: 1 }, // 70% rate (10% below threshold)
        severe: { dispatched: 10, succeeded: 2, lastUsedAt: 1 }, // 20% rate (60% below threshold)
      });
      expect(store.boostFactor("mild")).toBeGreaterThan(store.boostFactor("severe"));
    });
  });
});
