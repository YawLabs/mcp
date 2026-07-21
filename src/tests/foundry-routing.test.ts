import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOUNDRY_TOP3_FLOOR, loadFoundryCorpus, scoreCorpus } from "../foundry-corpus.js";
import { rankServers } from "../relevance.js";

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
    // LOUD skip. This gate has silently reported "skipped" since it landed
    // because src/tests/fixtures/ has never existed, and a quiet skip reads
    // like coverage in a CI summary. Name the exact path and the exact
    // command so the reason is actionable from the log alone.
    //
    // Deliberately NOT satisfied with a synthetic fixture: the gate's whole
    // premise is real harvested (tokens -> chosen) pairs from the full
    // pipeline. Hand-writing entries would score whatever BM25 already does
    // (circular, and already covered by routing-quality.test.ts), and this
    // path is the default --out of `yaw-mcp foundry export`, so a checked-in
    // synthetic corpus would be silently clobbered by the first real export.
    const banner = [
      "[foundry routing gate] SKIPPED -- no corpus fixture at:",
      `  ${FIXTURE}`,
      `  (exists: ${existsSync(FIXTURE)})`,
      "  BM25-floor routing regressions on REAL harvested dispatches are NOT gated.",
      "  To activate: run with YAW_MCP_FOUNDRY=1 to harvest, then `yaw-mcp foundry export`.",
    ].join("\n");

    // The warning rides on a REAL (non-skipped) test and goes out via
    // process.stderr.write rather than console.warn: vitest's default
    // reporter drops console output for a file whose tests are ALL skipped,
    // and routes console.* through a per-test buffer -- both of which made
    // the earlier quiet skip invisible in exactly the CI summary that needs
    // to see it. A raw stderr write from a running test always surfaces.
    it("reports that the foundry corpus gate is INACTIVE (no fixture committed)", () => {
      process.stderr.write(`${banner}\n`);
      expect(loadFoundryCorpus(FIXTURE)).toBeNull();
    });
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
    // A zero-candidate entry means the tokenizer or the server snapshot
    // broke: rankServers drops every server whose score is 0, so an empty
    // result is "this intent matches nothing in the catalog at all".
    // Asserting totalWeight > 0 would NOT catch that -- totalWeight is just
    // the sum of entry weights and is positive for any validated corpus,
    // even one where every single entry ranks nothing.
    const empty: Array<{ tokens: string[]; chosen: string }> = [];
    for (const e of corpus.entries) {
      if (rankServers(e.tokens.join(" "), corpus.servers).length === 0) {
        empty.push({ tokens: e.tokens, chosen: e.chosen });
      }
    }
    expect(
      empty,
      `${empty.length}/${corpus.entries.length} corpus entries ranked zero candidates, e.g. ${JSON.stringify(
        empty.slice(0, 3),
      )}`,
    ).toEqual([]);
    // Deliberately NOT asserted here: that `chosen` itself is ranked. The
    // BM25 floor is not a correctness oracle (see foundry-corpus.ts), and
    // the FOUNDRY_TOP3_FLOOR gate above already tolerates a fraction of
    // real dispatches the lexical floor misses. Requiring every `chosen`
    // to score > 0 would fail on legitimate learning/health-driven routes.
  });
});
