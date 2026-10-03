import { defaultExclude, defineConfig } from "vitest/config";

// Test files whose assertions are WALL-CLOCK budgets rather than values: a
// ReDoS tripwire timing four regexes over 98 KB, and two suites whose subject
// is a real subprocess settling on a deadline. Nothing about them is slow --
// they are contention-sensitive, and the default run packs ~400 s of test time
// into ~87 s of wall clock (roughly 4x CPU oversubscription), which is how a
// 500 ms budget measured at 26-250 ms standalone came back at 822 ms and
// failed a release run.
//
// They get their own project with fileParallelism disabled. What that does,
// read from the installed vitest 4.1.10 (checked 2026-10-03; it is not in the
// documentation): resolveConfig sets the project's maxWorkers to 1 whenever
// fileParallelism is false ("parallelism cannot be implemented without
// limiting workers", dist/chunks/coverage.*.js), and groupSpecs
// (dist/chunks/cli-api.*.js) puts every file whose project has isolate true
// (the default), sequence.groupOrder 0 (the default) and maxWorkers 1 into a
// `sequential` group that is appended after every other group and run with
// one worker -- so these files run after the parallel groups, one at a time,
// and the budgets are measured on an idle box instead of a contended one.
// Two things would undo it: setting isolate false or a groupOrder on this
// project, and VITEST_MAX_WORKERS in the environment, which resolveConfig
// applies after the maxWorkers=1 line and so overrides it. The alternative --
// widening each budget until it cannot flake -- widens it past the regression
// it exists to catch.
const TIMING_SENSITIVE = [
  "src/tests/error-category.test.ts",
  "src/tests/install-targets.test.ts",
  "src/tests/uv-bootstrap.test.ts",
  // Same class as the two above: spawns the real broker plus a real upstream
  // and asserts BOTH settle within a budget after stdin closes. "Never exits"
  // is the regression it guards, so the budget cannot be relaxed into
  // "eventually" -- which makes it exactly the kind of assertion that must be
  // measured on an idle box.
  "src/tests/shutdown-on-stdin-close.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Explicit, not inherited: hookTimeout defaults to 10 s and does NOT
    // follow testTimeout, so every heavy beforeAll/afterAll (temp-dir setup, a
    // tsup build, a spawned CLI) had to remember its own literal -- and only
    // cli-dispatch.test.ts does. This is the floor for the ones that do not.
    hookTimeout: 30000,
    // Builds and warms the broker bundle once for the whole run, when the run
    // includes a suite that spawns it (see src/tests/broker-bundle.ts).
    globalSetup: ["./src/tests/broker-bundle.setup.ts"],
    // `extends: true` so each project inherits the timeouts above rather than
    // silently falling back to vitest's defaults.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...defaultExclude, "**/dist/**", ...TIMING_SENSITIVE],
        },
      },
      {
        extends: true,
        test: {
          name: "timing",
          include: TIMING_SENSITIVE,
          fileParallelism: false,
        },
      },
    ],
  },
});
