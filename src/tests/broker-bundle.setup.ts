// vitest global setup: build and warm the broker bundle ONCE per run and hand
// its path to every test file through provide/inject. The why -- the first run
// of a freshly written bundle can be very slow -- is in broker-bundle.ts.
//
// Not a test file (no `.test.ts`), so the unit project's include does not pick
// it up; vitest.config.ts names it as the root globalSetup.

import { rm } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { buildBrokerBundle, runNeedsBrokerBundle } from "./broker-bundle.js";

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  // Clear an ambient YAW_MCP_LOG_LEVEL before any worker starts, so every
  // worker and every child it spawns starts with it unset. logger.ts lets a
  // recognized YAW_MCP_LOG_LEVEL win over LOG_LEVEL (and switches the CLI
  // surface to JSON lines), so a developer shell that exports it for support
  // would override every test's vi.stubEnv("LOG_LEVEL", ...) pin: =error mutes
  // the warn lines a "warns" test asserts and makes a "does NOT warn" test pass
  // vacuously. A test that wants the variable stubs it itself. Done before the
  // early returns below so every run gets it, bundle or not.
  delete process.env.YAW_MCP_LOG_LEVEL;
  // Both projects inherit this file through `extends: true`. vitest runs the
  // ROOT project's global setup on every run and merges what the root provides
  // into each project's context, so the root builds and the projects return --
  // otherwise one run would build up to three bundles.
  if (!project.isRootProject()) return undefined;
  // The run's test files: vitest's test run records them with
  // state.collectPaths before it runs global setup. Not getFilepaths(), which
  // lists COLLECTED modules and is still empty at this point (measured).
  if (!runNeedsBrokerBundle(project.vitest.state.getPaths(), project.config.root)) return undefined;
  const bundle = await buildBrokerBundle("yaw-mcp-bundle-");
  project.provide("brokerBundlePath", bundle.path);
  return async () => {
    await rm(bundle.dir, { recursive: true, force: true });
  };
}
