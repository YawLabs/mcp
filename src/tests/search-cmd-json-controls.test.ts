// `yaw-mcp search --json` at a terminal: the body is fetched catalog text, and
// JSON.stringify escapes only U+0000-U+001F. DEL, the C1 controls and the
// bidi/format characters used to come out raw.

import { describe, expect, it } from "vitest";
import type { CatalogServer } from "../catalog.js";
import { runSearch } from "../search-cmd.js";

// Built from char codes so no raw control byte sits in this file.
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const CSI_C1 = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
// U+E0001 LANGUAGE TAG: a format character outside the BMP (a surrogate pair).
const TAG = String.fromCodePoint(0xe0001);

const HOSTILE = [
  {
    slug: `evil${CSI_C1}2J`,
    name: `Evil${RLO}live`,
    description: `Clears${ESC}[2J the${DEL} screen${ZWSP}${TAG}. Café — kept.`,
    install: { command: `npx -y evil${RLO}`, runtime: `node${CSI_C1}31m` },
    repo: `https://example.test/${RLO}evil`,
  },
] as unknown as CatalogServer[];

function capture() {
  const out: string[] = [];
  return { out: (s: string) => out.push(s), err: () => {}, text: () => out.join("") };
}

/** Every character the text listing replaces (ascii.ts withoutControls),
 *  minus the newlines the pretty-printed JSON is laid out with. */
const unsafe = (s: string): string[] =>
  [...s].filter((ch) => {
    const c = ch.codePointAt(0) as number;
    return (c < 0x20 && ch !== "\n") || (c >= 0x7f && c <= 0x9f) || /\p{Cf}/u.test(ch);
  });

describe("runSearch --json -- no raw control or format character from a hostile catalog", () => {
  it("escapes them in every result field, and the parsed values are unchanged", async () => {
    const cap = capture();
    const r = await runSearch({ query: "", json: true, fetchCatalog: async () => HOSTILE, env: {}, ...cap });
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    expect(unsafe(text)).toEqual([]);
    // Escaped, not replaced: what a script parses out is the catalog's value.
    expect(text).toContain("evil\\u009b2J");
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\udb40\\udc01");
    const row = JSON.parse(text).results[0];
    expect(row).toMatchObject({
      slug: HOSTILE[0].slug,
      name: HOSTILE[0].name,
      description: HOSTILE[0].description,
      runtime: `node${CSI_C1}31m`,
      command: `npx -y evil${RLO}`,
      repo: `https://example.test/${RLO}evil`,
    });
    // Text that is not a control or format character is left as it was.
    expect(text).toContain("Café — kept.");
  });

  it("escapes them in suggestedSlugs too", async () => {
    const cap = capture();
    const near = [
      { slug: `sqlite${RLO}`, name: "x", install: { command: "npx -y x", runtime: "node" } },
    ] as unknown as CatalogServer[];
    const r = await runSearch({ query: "sqlote", json: true, fetchCatalog: async () => near, env: {}, ...cap });
    expect(r.exitCode).toBe(0);
    const text = cap.text();
    // The suggestion has to be there for the scan below to mean anything.
    expect(JSON.parse(text).suggestedSlugs).toEqual([`sqlite${RLO}`]);
    expect(unsafe(text)).toEqual([]);
  });
});
