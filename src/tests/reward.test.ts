import { describe, expect, it } from "vitest";
import { type ToolCallResultShape, computeOutcomeReward } from "../reward.js";

describe("computeOutcomeReward", () => {
  describe("rule 1: hard failure (isError === true) -> 0.0", () => {
    it("scores 0.0 when isError is true, regardless of body", () => {
      expect(
        computeOutcomeReward({
          isError: true,
          content: [{ type: "text", text: "boom" }],
        }),
      ).toBe(0.0);
    });

    it("scores 0.0 when isError is true even with a healthy-looking body", () => {
      expect(
        computeOutcomeReward({
          isError: true,
          content: [{ type: "text", text: '{"ok":true}' }],
        }),
      ).toBe(0.0);
    });

    it("scores 0.0 when isError is true and body is empty", () => {
      expect(computeOutcomeReward({ isError: true })).toBe(0.0);
    });
  });

  describe("rule 2: error-shaped 200 -> 0.2", () => {
    it("scores 0.2 for a not-found soft failure inside a 200", () => {
      expect(
        computeOutcomeReward({
          isError: false,
          content: [{ type: "text", text: "not found" }],
        }),
      ).toBe(0.2);
    });

    it("scores 0.2 for an unauthorized soft failure", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "text", text: "unauthorized: bad token" }],
        }),
      ).toBe(0.2);
    });

    it("scores 0.2 for a rate-limit soft failure", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "text", text: "rate limit exceeded, retry later" }],
        }),
      ).toBe(0.2);
    });

    it("scores 0.2 for a timeout soft failure", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "text", text: "Request timed out" }],
        }),
      ).toBe(0.2);
    });

    it("classifies on the FIRST text block only", () => {
      // First block is error-shaped -> rule 2 wins even though a later
      // block looks fine.
      expect(
        computeOutcomeReward({
          content: [
            { type: "text", text: "not found" },
            { type: "text", text: "everything is great" },
          ],
        }),
      ).toBe(0.2);
    });

    it("classifies the first NON-EMPTY block when an empty block precedes the error", () => {
      // Regression: an empty/whitespace first block must not let an
      // error-shaped LATER block fall through to full credit (1.0). The
      // first-non-empty scan aligns rule 2 with the empty-body scan.
      expect(
        computeOutcomeReward({
          content: [
            { type: "text", text: "" },
            { type: "text", text: "not found" },
          ],
        }),
      ).toBe(0.2);
      expect(
        computeOutcomeReward({
          content: [
            { type: "text", text: "   " },
            { type: "text", text: "unauthorized" },
          ],
        }),
      ).toBe(0.2);
    });
  });

  describe("rule 3: empty / whitespace body -> 0.3", () => {
    it("scores 0.3 when content is missing entirely", () => {
      expect(computeOutcomeReward({})).toBe(0.3);
    });

    it("scores 0.3 when content array is empty", () => {
      expect(computeOutcomeReward({ content: [] })).toBe(0.3);
    });

    it("scores 0.3 when the only text block is empty string", () => {
      expect(computeOutcomeReward({ content: [{ type: "text", text: "" }] })).toBe(0.3);
    });

    it("scores 0.3 when the only text block is whitespace-only", () => {
      expect(computeOutcomeReward({ content: [{ type: "text", text: "   \n\t " }] })).toBe(0.3);
    });

    it("scores 0.3 when no block carries text (e.g. image-only)", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "image" }],
        }),
      ).toBe(0.3);
    });

    it("scores 0.3 when all text blocks are empty/whitespace", () => {
      expect(
        computeOutcomeReward({
          content: [
            { type: "text", text: "" },
            { type: "text", text: "  " },
          ],
        }),
      ).toBe(0.3);
    });
  });

  describe("rule 4: genuine success -> 1.0", () => {
    it("scores 1.0 for a normal JSON result body", () => {
      expect(
        computeOutcomeReward({
          isError: false,
          content: [{ type: "text", text: '{"result":"ok","rows":3}' }],
        }),
      ).toBe(1.0);
    });

    it("scores 1.0 for a plain success string", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "text", text: "Operation completed successfully." }],
        }),
      ).toBe(1.0);
    });

    it("scores 1.0 for a multi-block reply with a benign first block", () => {
      expect(
        computeOutcomeReward({
          content: [
            { type: "text", text: "Here are your results:" },
            { type: "text", text: "row 1, row 2" },
          ],
        }),
      ).toBe(1.0);
    });

    it("does NOT mis-grade benign text as 0.2 (upstream_error catch-all is excluded)", () => {
      // classifyError returns "upstream_error" for this benign text;
      // rule 2 must NOT fire on the catch-all category.
      expect(
        computeOutcomeReward({
          content: [{ type: "text", text: "the quick brown fox" }],
        }),
      ).toBe(1.0);
    });

    it("scores 1.0 when a non-text block precedes a benign text block", () => {
      expect(
        computeOutcomeReward({
          content: [{ type: "image" }, { type: "text", text: "ok" }],
        }),
      ).toBe(1.0);
    });
  });

  describe("edge: error-shaped text takes priority over a non-empty benign tail", () => {
    it("error-shaped first block beats empty-body fallback", () => {
      const result: ToolCallResultShape = {
        content: [{ type: "text", text: "404 not found" }],
      };
      expect(computeOutcomeReward(result)).toBe(0.2);
    });
  });
});
