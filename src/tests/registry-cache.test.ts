import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedRegistryLatest,
  REGISTRY_CACHE_FILENAME,
  REGISTRY_CACHE_TTL_MS,
  registryCachePath,
} from "../registry-cache.js";

const NOW = 1_000_000_000_000;
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-registry-cache-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seed(contents: string): void {
  mkdirSync(dirname(registryCachePath(home)), { recursive: true });
  writeFileSync(registryCachePath(home), contents);
}

function onDisk(): { version: number; packages: Record<string, { latest: string; at: number }> } {
  return JSON.parse(readFileSync(registryCachePath(home), "utf8"));
}

function counting(answer: string | null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async () => {
      calls++;
      return answer;
    },
  };
}

const opts = (over: Partial<{ now: () => number; write: boolean }> = {}) => ({
  home,
  now: () => NOW,
  write: true,
  ...over,
});

describe("registryCachePath", () => {
  it("is one file under ~/.yaw-mcp", () => {
    expect(registryCachePath(home)).toBe(join(home, ".yaw-mcp", REGISTRY_CACHE_FILENAME));
  });
});

describe("cachedRegistryLatest", () => {
  it("a fresh entry answers without calling the fetcher", async () => {
    seed(JSON.stringify({ version: 1, packages: { a: { latest: "1.0.0", at: NOW - 1000 } } }));
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("1.0.0");
    expect(f.calls).toBe(0);
  });

  it("an entry exactly TTL old is expired, and is refetched and replaced", async () => {
    seed(JSON.stringify({ version: 1, packages: { a: { latest: "1.0.0", at: NOW - REGISTRY_CACHE_TTL_MS } } }));
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("2.0.0");
    expect(f.calls).toBe(1);
    expect(onDisk().packages.a).toEqual({ latest: "2.0.0", at: NOW });
  });

  it("one millisecond inside the TTL is still a hit", async () => {
    seed(JSON.stringify({ version: 1, packages: { a: { latest: "1.0.0", at: NOW - REGISTRY_CACHE_TTL_MS + 1 } } }));
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("1.0.0");
    expect(f.calls).toBe(0);
  });

  it("an entry stamped well in the future (clock moved back) is a miss", async () => {
    seed(JSON.stringify({ version: 1, packages: { a: { latest: "1.0.0", at: NOW + 60 * 60 * 1000 } } }));
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("2.0.0");
    expect(f.calls).toBe(1);
  });

  it.each([
    ["not JSON", "{oops"],
    ["empty file", ""],
    ["an array", "[]"],
    ["another schema version", JSON.stringify({ version: 2, packages: { a: { latest: "1.0.0", at: NOW } } })],
    ["packages not an object", JSON.stringify({ version: 1, packages: "a" })],
    ["a non-string latest", JSON.stringify({ version: 1, packages: { a: { latest: 1, at: NOW } } })],
    ["an empty latest", JSON.stringify({ version: 1, packages: { a: { latest: "", at: NOW } } })],
    ["a non-numeric at", JSON.stringify({ version: 1, packages: { a: { latest: "1.0.0", at: "now" } } })],
  ])("%s reads as a miss and the fetch runs", async (_label, contents) => {
    seed(contents);
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("2.0.0");
    expect(f.calls).toBe(1);
    expect(onDisk()).toEqual({ version: 1, packages: { a: { latest: "2.0.0", at: NOW } } });
  });

  it("a bad entry is dropped alone: a good sibling still answers", async () => {
    seed(
      JSON.stringify({
        version: 1,
        packages: { bad: { latest: 7, at: NOW }, good: { latest: "1.0.0", at: NOW - 1000 } },
      }),
    );
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("good", f.fetch, opts())).toBe("1.0.0");
    expect(f.calls).toBe(0);
  });

  it("a missing file is a miss, and the answer creates ~/.yaw-mcp and the file", async () => {
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBe("2.0.0");
    expect(onDisk()).toEqual({ version: 1, packages: { a: { latest: "2.0.0", at: NOW } } });
  });

  // Asserted as the dirMode REQUESTED, the same way local-bundles.test.ts
  // pins its owner-only birth: POSIX mode bits are not meaningful on Windows.
  it("asks atomicWriteFile for dirMode 0o700 and file mode 0o600, so it can birth ~/.yaw-mcp owner-only", async () => {
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");
    try {
      expect(existsSync(join(home, ".yaw-mcp"))).toBe(false);
      await cachedRegistryLatest("a", async () => "2.0.0", opts());
      const call = spy.mock.calls.find((c) => c[0] === registryCachePath(home));
      expect(call, "the registry cache was never written").toBeDefined();
      expect(call?.[3]).toBe(0o600);
      expect(call?.[4]).toBe(0o700);
    } finally {
      spy.mockRestore();
    }
  });

  it("null is returned and never stored", async () => {
    const f = counting(null);
    expect(await cachedRegistryLatest("a", f.fetch, opts())).toBeNull();
    expect(existsSync(registryCachePath(home))).toBe(false);
  });

  it("a rejecting fetcher reads as null and stores nothing", async () => {
    const reject = async (): Promise<string | null> => {
      throw new Error("ENOTFOUND");
    };
    expect(await cachedRegistryLatest("a", reject, opts())).toBeNull();
    expect(existsSync(registryCachePath(home))).toBe(false);
  });

  it("write: false reads a fresh entry and fetches a miss, but writes nothing", async () => {
    const f = counting("2.0.0");
    expect(await cachedRegistryLatest("a", f.fetch, opts({ write: false }))).toBe("2.0.0");
    expect(existsSync(join(home, ".yaw-mcp"))).toBe(false);

    seed(JSON.stringify({ version: 1, packages: { b: { latest: "1.0.0", at: NOW - 1000 } } }));
    const before = readFileSync(registryCachePath(home), "utf8");
    expect(await cachedRegistryLatest("b", f.fetch, opts({ write: false }))).toBe("1.0.0");
    expect(await cachedRegistryLatest("c", f.fetch, opts({ write: false }))).toBe("2.0.0");
    expect(readFileSync(registryCachePath(home), "utf8")).toBe(before);
    expect(f.calls).toBe(2);
  });

  it("parallel misses for different packages all land in the file", async () => {
    const pkgs = ["a", "b", "c", "d", "e"];
    await Promise.all(pkgs.map((p) => cachedRegistryLatest(p, async () => `${p}-1.0.0`, opts())));
    expect(Object.keys(onDisk().packages).sort()).toEqual(pkgs);
  });

  it("a write keeps fresh entries for other packages and prunes expired ones", async () => {
    seed(
      JSON.stringify({
        version: 1,
        packages: {
          keep: { latest: "1.0.0", at: NOW - 1000 },
          old: { latest: "1.0.0", at: NOW - REGISTRY_CACHE_TTL_MS - 1 },
        },
      }),
    );
    await cachedRegistryLatest("new", async () => "3.0.0", opts());
    expect(onDisk().packages).toEqual({
      keep: { latest: "1.0.0", at: NOW - 1000 },
      new: { latest: "3.0.0", at: NOW },
    });
  });
});
