// Doctor and `install --list` classify a client file by its format: json and
// jsonc through doctor's own JSON walk, every other format through the adapter
// its row registers. A row that declares a format with neither -- a new syntax
// added to INSTALL_TARGETS without an adapter -- would throw
// MissingConfigAdapterError on the first probe of a machine that has the file.
// This pins that every format a row can resolve to has a classifier, so that
// shows up here rather than on a user's doctor run.

import { describe, expect, it } from "vitest";
import { effectiveConfigFormat, hasConfigAdapter, syntaxNameFor } from "../client-config.js";
// Importing install-targets.ts is what registers the adapters (target modules
// call registerConfigAdapter at module scope), exactly as doctor gets them.
import { INSTALL_TARGETS } from "../install-targets.js";

describe("probe format coverage", () => {
  it("every format an install row declares has a doctor classifier", () => {
    const seen: string[] = [];
    for (const row of INSTALL_TARGETS) {
      for (const scope of row.scopes) {
        const f = effectiveConfigFormat(row.config, scope);
        seen.push(f);
        expect(
          f === "json" || f === "jsonc" || hasConfigAdapter(f),
          `${row.clientId} (${scope.scope}) declares format "${f}" with no classifier`,
        ).toBe(true);
        // A VALUE assertion: syntaxNameFor's exhaustive switch returns the
        // unknown format itself from its `never` branch rather than throwing,
        // so `not.toThrow()` could never go red here.
        expect(["JSON", "TOML"]).toContain(syntaxNameFor(f));
      }
    }
    // Anchor: the loop ran over real rows, including the non-JSON one.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toContain("toml");
  });
});
