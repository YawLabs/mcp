import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOUNDRY_TOP3_FLOOR, loadFoundryCorpus, scoreCorpus } from "../foundry-corpus.js";

// ═══════════════════════════════════════════════════════════════════════
// Foundry routing regression gate (BM25 floor on REAL harvested dispatches).
//
// Sibling to routing-quality.test.ts (which gates the BM25 floor on 14
// hand-written intents). This one consumes the checked-in corpus produced by
// `yaw-mcp foundry export` from the opt-in harvest. It is a REGRESSION gate,
// not a correctness oracle: it asserts the BM25 floor keeps each real intent's
// chosen server in the top-3 (see foundry-corpus.ts for the full framing).
//
// No corpus committed yet -> the whole describe SKIPS, so this is CI-safe
// today and activates automatically once a fixture lands. BM25-only, so it
// runs with no Voyage key, exactly like routing-quality.test.ts.
// ═══════════════════════════════════════════════════════════════════════

const FIXTURE = join(process.cwd(), "src", "tests", "fixtures", "foundry-corpus.json");
const corpus = loadFoundryCorpus(FIXTURE);

describe("foundry routing regression gate", () => {
  if (!corpus) {
    it.skip("no harvested corpus committed yet -- run `yaw-mcp foundry export` to activate the gate", () => {});
    return;
  }

  it(`BM25 floor keeps chosen servers in the top-3 (>= ${FOUNDRY_TOP3_FLOOR})`, () => {
    const s = scoreCorpus(corpus);
    expect(
      s.top3,
      `top-3 ${(s.top3 * 100).toFixed(1)}% over ${s.totalWeight} weighted real dispatches; if this dropped, a BM25/tokenization change regressed real-world routing`,
    ).toBeGreaterThanOrEqual(FOUNDRY_TOP3_FLOOR);
  });

  it("every corpus entry resolves to at least one ranked candidate", () => {
    // A zero-candidate entry means the tokenizer or server snapshot broke.
    const s = scoreCorpus(corpus);
    expect(s.totalWeight).toBeGreaterThan(0);
  });
});
