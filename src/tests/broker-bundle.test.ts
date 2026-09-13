import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROKER_BUNDLE_CONSUMERS, runNeedsBrokerBundle } from "./broker-bundle.js";

// The global setup builds the broker bundle only for a run that includes one
// of BROKER_BUNDLE_CONSUMERS. A consumer the list misses still passes -- its
// useBrokerBundle falls back to building its own -- so nothing else would
// notice the build count creeping back up. These pin the list and the match.

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("BROKER_BUNDLE_CONSUMERS", () => {
  it("names exactly the test files that call useBrokerBundle", () => {
    const callers = readdirSync(TESTS_DIR)
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => /\buseBrokerBundle\(/.test(readFileSync(join(TESTS_DIR, f), "utf8")))
      .map((f) => `src/tests/${f}`)
      .sort();
    expect([...BROKER_BUNDLE_CONSUMERS].sort()).toEqual(callers);
  });
});

describe("runNeedsBrokerBundle", () => {
  it("is false for a run with no consumer in it", () => {
    expect(runNeedsBrokerBundle([join(ROOT, "src/tests/jsonc.test.ts")], ROOT)).toBe(false);
    expect(runNeedsBrokerBundle([], ROOT)).toBe(false);
  });

  it("is true when any planned file is a consumer", () => {
    const planned = [join(ROOT, "src/tests/jsonc.test.ts"), join(ROOT, "src/tests/e2e-round-trip.test.ts")];
    expect(runNeedsBrokerBundle(planned, ROOT)).toBe(true);
  });

  it("matches the forward-slash paths vitest reports, whatever the separator in root", () => {
    const planned = [join(ROOT, "src/tests/index-dispatch.test.ts").replace(/\\/g, "/")];
    expect(runNeedsBrokerBundle(planned, ROOT)).toBe(true);
  });

  it("ignores drive-letter case on win32, and only there", () => {
    if (process.platform !== "win32") return;
    const planned = [join(ROOT, "src/tests/shutdown-on-stdin-close.test.ts")];
    const flipped = planned.map((p) => (/^[a-z]:/.test(p) ? p[0].toUpperCase() : p[0].toLowerCase()) + p.slice(1));
    expect(runNeedsBrokerBundle(flipped, ROOT, "win32")).toBe(true);
    expect(runNeedsBrokerBundle(flipped, ROOT, "linux")).toBe(false);
  });

  it("does not take a file that merely ends with a consumer's name", () => {
    const planned = [join(ROOT, "other/src/tests/e2e-round-trip.test.ts")];
    expect(runNeedsBrokerBundle(planned, ROOT)).toBe(false);
  });
});
