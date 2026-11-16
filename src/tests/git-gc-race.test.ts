// gcGitBuilds against a namespace directory a concurrent `remove` deleted
// between its first existence check and the lock. The race is forced through
// node:fs: the first existsSync that sees the directory deletes it on the way
// out, which is what a remove finishing just then looks like from here.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ afterExists: null as null | ((path: string) => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const existsSync = (path: Parameters<typeof real.existsSync>[0]): boolean => {
    const found = real.existsSync(path);
    if (found) race.afterExists?.(String(path));
    return found;
  };
  return { ...real, existsSync, default: { ...real, existsSync } };
});

import { gcGitBuilds, gitCheckoutDir } from "../git-source.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yaw-mcp-gc-race-"));
});

afterEach(() => {
  race.afterExists = null;
  rmSync(home, { recursive: true, force: true });
});

describe("gcGitBuilds", () => {
  it("returns an empty result when the namespace directory is deleted before it takes the lock", async () => {
    const dir = gitCheckoutDir("fx", home);
    mkdirSync(join(dir, "a".repeat(12)), { recursive: true });
    let fired = 0;
    race.afterExists = (path) => {
      if (path !== dir) return;
      fired++;
      race.afterExists = null;
      rmSync(dir, { recursive: true, force: true });
    };
    const res = await gcGitBuilds("fx", [], home);
    expect(fired).toBe(1);
    expect(res).toEqual({ removed: [], errors: [], unreadable: [], notes: [] });
  });
});
