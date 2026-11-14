// scripts/check-installed-deps.mjs -- release.sh's lockfile drift check.
// The fixture-run cases in release-sh.test.ts cover the wiring; these cover
// which lockfile entries count as drift.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDrift, formatDrift, readInstalledVersion } from "../../scripts/check-installed-deps.mjs";

const installed =
  (versions: Record<string, string>) =>
  (key: string): string | null =>
    versions[key] ?? null;

describe("findDrift", () => {
  it("reports a version mismatch and a missing required package", () => {
    const lock = {
      packages: {
        "": { name: "root" },
        "node_modules/a": { version: "2.4.0" },
        "node_modules/b": { version: "1.0.0" },
        "node_modules/c": { version: "3.0.0" },
      },
    };
    expect(findDrift(lock, installed({ "node_modules/a": "2.3.1", "node_modules/c": "3.0.0" }))).toEqual([
      { name: "node_modules/a", locked: "2.4.0", installed: "2.3.1" },
      { name: "node_modules/b", locked: "1.0.0", installed: null },
    ]);
  });

  it("lets optional and devOptional packages be absent, but not mismatched", () => {
    const lock = {
      packages: {
        "node_modules/@biomejs/cli-linux-x64": { version: "2.0.0", optional: true },
        "node_modules/fsevents": { version: "2.3.3", devOptional: true },
        "node_modules/@esbuild/win32-x64": { version: "0.25.0", optional: true },
      },
    };
    expect(findDrift(lock, installed({ "node_modules/@esbuild/win32-x64": "0.24.0" }))).toEqual([
      { name: "node_modules/@esbuild/win32-x64", locked: "0.25.0", installed: "0.24.0" },
    ]);
  });

  it("checks nested copies under their own path and skips links, bundled deps and workspace roots", () => {
    const lock = {
      packages: {
        "node_modules/x/node_modules/y": { version: "1.0.0" },
        "node_modules/linked": { resolved: "packages/linked", link: true },
        "node_modules/x/node_modules/bundled": { version: "1.0.0", inBundle: true },
        "packages/linked": { version: "0.0.1" },
      },
    };
    expect(findDrift(lock, installed({}))).toEqual([
      { name: "node_modules/x/node_modules/y", locked: "1.0.0", installed: null },
    ]);
  });

  it("passes a lockfile with no packages map", () => {
    expect(findDrift({}, installed({}))).toEqual([]);
    expect(findDrift(null, installed({}))).toEqual([]);
  });
});

describe("formatDrift", () => {
  it("lists up to the cap, then counts the rest", () => {
    const drift = Array.from({ length: 4 }, (_, i) => ({
      name: `node_modules/p${i}`,
      locked: "1.0.0",
      installed: null,
    }));
    expect(formatDrift(drift, 2)).toBe(
      "node_modules/p0: locked 1.0.0, installed nothing\nnode_modules/p1: locked 1.0.0, installed nothing\n... and 2 more",
    );
  });
});

describe("readInstalledVersion", () => {
  it("reads the installed package.json and answers null when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-check-"));
    try {
      mkdirSync(join(root, "node_modules", "a"), { recursive: true });
      writeFileSync(join(root, "node_modules", "a", "package.json"), JSON.stringify({ version: "1.2.3" }));
      expect(readInstalledVersion(root, "node_modules/a")).toBe("1.2.3");
      expect(readInstalledVersion(root, "node_modules/missing")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
