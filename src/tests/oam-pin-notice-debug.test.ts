// The managed-tree half of the pinned-sidecar notice, which logs at DEBUG.
//
// Split into its own file because logger.ts resolves LOG_LEVEL ONCE at module
// load, so the level has to be raised before the import graph is built -- the
// same module-scoped constraint that gives oam-probe-options.test.ts and the
// uv-bootstrap mocks their own files.
//
// The sibling oam-spawn.test.ts asserts that a managed hit says nothing at the
// default level, which is the user-facing behaviour. This is the other half:
// without it, REFRESH_COMMAND.managed is asserted NOWHERE, so the one command
// that actually moves the managed tree forward could be changed to anything
// and the suite would stay green -- and being debug-level, no user would
// report it either.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set BEFORE the dynamic import below. A static import of oam-spawn would pull
// logger.ts in during hoisting, i.e. before this line ever runs.
const priorLogLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "debug";

const { resetPinnedSidecarLog, resolveNpmEntry } = await import("../oam-spawn.js");

// Put it back. vitest's `isolate` gives each FILE a fresh module registry, not
// a fresh process.env, so a worker reused for a later file would otherwise
// inherit debug -- and the sibling oam-spawn.test.ts asserts that the managed
// notice is SILENT, which is exactly what a leak would break. Ordering makes
// that flaky rather than reliably red, which is worse.
afterAll(() => {
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

describe("pinned-sidecar notice at debug level", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pin-debug-"));
    resetPinnedSidecarLog();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names `yaw-mcp sidecars install` for a managed-tree pin", () => {
    const managed = join(root, "managed", "node_modules");
    const dir = join(managed, "@yawlabs", "fetch-mcp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@yawlabs/fetch-mcp", version: "0.3.0", bin: { "fetch-mcp": "./dist/index.js" } }),
    );
    // The bin must EXIST: packageEntry existsSync's the entry it resolves, so a
    // manifest-only fixture resolves to null and the notice never fires at all
    // -- which would make this test pass its "defined" assertion never.
    writeFileSync(join(dir, "dist", "index.js"), "");
    // A broker OUTSIDE any npx cache, so the managed entry is the only hit.
    const brokerUrl = pathToFileURL(join(root, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;

    const entries: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim().length > 0) entries.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    });
    try {
      resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, managed);
    } finally {
      spy.mockRestore();
    }

    const note = entries.find((e) => String(e.msg ?? "").includes("will not self-update"));
    expect(note, "the managed pin never logged at all, even at debug").toBeDefined();
    // Debug, not info: the user chose this pin by running `sidecars install`.
    expect(note?.level).toBe("debug");
    expect(note?.source).toBe("managed");
    expect(note?.refreshWith).toBe("yaw-mcp sidecars install");
    // No Ctrl-C note: `sidecars install` exits on its own; the note is
    // npx-cache-only.
    expect(note !== undefined && "refreshNote" in note).toBe(false);
    expect(note?.version).toBe("0.3.0");
    expect(note?.from).toBe(managed);
  });
});
