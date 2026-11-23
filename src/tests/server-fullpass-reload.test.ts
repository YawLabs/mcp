// Full-pass regression: a bundles.json reload overlays grades.json BEFORE it
// installs the new server list, so a proxied call racing the grades read never
// gates on un-overlaid entries.

import { describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../grades-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grades-cache.js")>();
  return { ...actual, readGradesCache: vi.fn(actual.readGradesCache) };
});

vi.mock("../local-bundles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-bundles.js")>();
  return { ...actual, loadLocalBundles: vi.fn(actual.loadLocalBundles) };
});

import { readGradesCache } from "../grades-cache.js";
import { loadLocalBundles } from "../local-bundles.js";
import { ConnectServer } from "../server.js";
import type { UpstreamServerConfig } from "../types.js";

const server = (namespace: string, extra: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig => ({
  id: namespace,
  name: namespace,
  namespace,
  type: "local",
  command: "npx",
  args: ["-y", `@example/${namespace}`],
  isActive: true,
  ...extra,
});

describe("applyReloadedBundles overlays grades before adopting", () => {
  it("keeps the old config observable during the grades read, then installs the overlaid list", async () => {
    const priv = new ConnectServer() as any;
    const old = { servers: [server("ssh", { complianceGrade: "F" })], configVersion: "v1" };
    priv.config = old;
    priv.configVersion = "v1";

    vi.mocked(loadLocalBundles).mockResolvedValueOnce({
      // Fresh parse: bundles.json records a passing grade.
      config: { servers: [server("ssh", { complianceGrade: "A" })], configVersion: "v2" },
      path: "/fake/bundles.json",
      warnings: [],
      consultedPaths: [],
    } as unknown as Awaited<ReturnType<typeof loadLocalBundles>>);
    type Grades = Awaited<ReturnType<typeof readGradesCache>>;
    let release: (v: Grades) => void = () => {};
    vi.mocked(readGradesCache).mockReturnValueOnce(
      new Promise<Grades>((resolve) => {
        release = resolve;
      }),
    );

    const pending = priv.applyReloadedBundles();
    // Let loadLocalBundles settle; the grades read is still outstanding.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(vi.mocked(readGradesCache)).toHaveBeenCalled();
    // The un-overlaid "A" must not be observable yet.
    expect(priv.config).toBe(old);
    expect(priv.config.servers[0].complianceGrade).toBe("F");

    release({ ssh: { grade: "F" } } as unknown as Grades);
    expect(await pending).toBe(true);
    expect(priv.configVersion).toBe("v2");
    // The locally measured grade wins over the file's.
    expect(priv.config.servers[0].complianceGrade).toBe("F");
  });
});
