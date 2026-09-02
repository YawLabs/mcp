import { describe, expect, it } from "vitest";
import { closestNames, levenshtein } from "../fuzzy.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("github", "github")).toBe(0);
  });

  it("returns length when comparing against an empty string", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts one-char insertions, deletions, and substitutions", () => {
    expect(levenshtein("githu", "github")).toBe(1); // insertion
    expect(levenshtein("github", "githu")).toBe(1); // deletion
    expect(levenshtein("github", "nithub")).toBe(1); // substitution
  });

  it("handles multi-edit distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
  });

  it("is symmetric", () => {
    expect(levenshtein("hello", "world")).toBe(levenshtein("world", "hello"));
  });
});

describe("closestNames", () => {
  const candidates = ["github", "linear", "slack", "pagerduty", "postgres"] as const;

  it("returns empty when limit is 0 or negative", () => {
    expect(closestNames("github", candidates, 0)).toEqual([]);
    expect(closestNames("github", candidates, -1)).toEqual([]);
  });

  it("returns empty when no candidate is a reasonable match (noise suppression)", () => {
    // "xyz" is not close to anything — we refuse to fabricate a suggestion.
    expect(closestNames("xyz", candidates, 3)).toEqual([]);
  });

  it("surfaces a case-only mismatch at the top (score 0)", () => {
    const r = closestNames("GITHUB", candidates, 3);
    expect(r[0]).toBe("github");
  });

  it("surfaces a prefix match (score 1)", () => {
    // "git" is a prefix of "github" — pure prefix containment.
    const r = closestNames("git", candidates, 3);
    expect(r).toContain("github");
  });

  it("surfaces a substring match (score 2)", () => {
    // "hub" is inside "github" but not a prefix or suffix.
    const r = closestNames("hub", candidates, 3);
    expect(r).toContain("github");
  });

  it("does not substring-match a short query against a long command (no misleading suggestions)", () => {
    // A 2-char query like "ls" must NOT substring-match a 10-char command
    // like "set-active" just because the chars happen to appear inside it.
    // The substring tier is gated on q.length >= 3 plus a half-length rule.
    const cmds = ["set-active", "secrets", "list-tools"] as const;
    expect(closestNames("ls", cmds, 3)).toEqual([]);
    // "ctiv" is a substring of "set-active" but not a prefix/suffix and not a
    // near-typo; at 4 chars it is below half the length of "set-active" (10),
    // so the half-length rule blocks the substring tier. (A genuine prefix
    // like "set" still surfaces via the separate prefix tier -- that is
    // intended and not what this gate suppresses.)
    expect(closestNames("ctiv", cmds, 3)).not.toContain("set-active");
  });

  it("surfaces a near-typo via edit distance (score 3–4)", () => {
    // "githu" → github is distance 1.
    const r = closestNames("githu", candidates, 3);
    expect(r[0]).toBe("github");
  });

  it("respects the limit and sorts tier-first, alphabetically within tier", () => {
    // "sla" prefix-matches slack (tier 1). Nothing else is within threshold.
    const r = closestNames("sla", candidates, 1);
    expect(r).toEqual(["slack"]);
    // Four tier-1 prefix hits with room for two: pins BOTH the alphabetical
    // ordering inside a tier (declaration order would give github, gitlab) and
    // the slice(0, limit) truncation. Without this the "sla" case above stays
    // green with either one deleted, and a namespace typo answers with an
    // unbounded "Did you mean: ..." list in registry order.
    expect(closestNames("git", ["github", "gitlab", "gitea", "gitops"], 2)).toEqual(["gitea", "github"]);
  });

  it("suppresses every inexact tier for 1-2 char queries (prefix included)", () => {
    // A single character is never a "clear typo" of anything: ungated, the
    // prefix tier surfaced every namespace sharing a first letter, so a
    // one-char activate typo suggested "gh, github, gitlab" at once --
    // contradicting the header's conservative promise.
    expect(closestNames("g", ["gh", "github", "gitlab"], 3)).toEqual([]);
    // Two chars is still below the signal floor: 'gt' is within edit
    // distance 1 of 'gh', so the Levenshtein tier must be gated too, not
    // just the prefix tier.
    expect(closestNames("gt", ["gh", "github", "gitlab"], 3)).toEqual([]);
    // A case-only mismatch of a short name IS unambiguous and still works.
    expect(closestNames("GH", ["gh", "github"], 3)).toEqual(["gh"]);
  });

  it("excludes an exact match of the query from results", () => {
    const r = closestNames("github", candidates, 3);
    expect(r).not.toContain("github");
  });
});
