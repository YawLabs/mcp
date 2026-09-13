// The esbuild bundle of src/index.ts that three suites spawn: index-dispatch,
// e2e-round-trip and shutdown-on-stdin-close. It is built and warmed up ONCE
// per vitest run, by broker-bundle.setup.ts (the root global setup), and only
// when the run includes one of those suites; each suite gets the path through
// useBrokerBundle() below and keeps its own temp dir for HOME. index.ts
// dispatches at module scope, so it cannot be imported and called -- these
// suites bundle it into a self-contained ESM file and run that with node.
// (cli-dispatch.test.ts also runs index.ts as a real process, but it spawns
// the tsup build in dist/ rather than this bundle. tsup 8.x calls esbuild with
// `write: false` and writes its output through node's fs, so dist/index.js
// comes from the same writer as this helper's -- read from tsup's source, not
// timed. Re-check it if tsup changes how it writes.)
//
// Not a test file (no `.test.ts`, so vitest's `src/**/*.test.ts` include does
// not pick it up) -- a helper the suites import.
//
// WHY IT EXISTS: THE FIRST RUN OF A FRESH BUNDLE CAN BE VERY SLOW. On a
// Windows box with on-access antivirus (Defender real-time protection), the
// first execution of a just-written bundle has cost far more than every later
// one, and the three suites each paid that first execution inside a test
// budget. On 2026-09-13 that failed a release gate: shutdown-on-stdin-close
// waits 20s for the upstream to start; e2e-round-trip's first spawns are its
// pipe test's two `doctor` runs, which outlived that test's 120s timeout, and
// in the same run its round-trip test then got no answer to `initialize`
// within 30s; and index-dispatch's first boot was SIGKILLed by its 90s guard.
// Both failure messages that print the broker's stderr tail printed it empty:
// the broker never got far enough to log a line.
//
// So the helper does two things.
//
// 1. NODE WRITES THE BUNDLE, NOT ESBUILD. Measured outside vitest on the
//    ARM64 box that morning, `node entry.mjs --version`, a never-before-seen
//    bundle each time:
//
//        esbuild writes it (write: true)          first run 37.3s, 36.5s
//        esbuild builds it, node writes it        first run  1.6s,  1.6s
//        esbuild writes it, node copies it        first run 43.9s,  9.1s
//
//    Three more esbuild-written first runs that morning took 21.6-33.3s; the
//    second run of every variant took 0.5-5.0s. The copy row is why this
//    builds with `write: false` rather than copying esbuild's output: the
//    first run of a node copy of an esbuild-written file still paid.
//
//    The effect did NOT hold. About an hour later, with no Defender signature
//    or engine update in between, the same probe measured esbuild-written
//    first runs at 2.5-6.0s against 2.3-2.9s node-written, and the shutdown
//    test passed with the helper deliberately switched back to esbuild
//    writing: a 13.1s standalone vitest run, against 7.1s with node writing.
//    Both of those ran this helper BEFORE step 2 below existed; with the
//    warm-up in place that mutation no longer says anything about the writer.
//    Why esbuild-written files paid on their first run, and why that stopped,
//    is not established -- on-access scanning is the suspect, but it was
//    never isolated with an exclusion or a scan log. Node writing the file is
//    kept because it was the one variant that was fast in that morning's
//    probes, whose slow esbuild-written first runs are the inferred (not
//    reproduced) cause of the release failure -- not because it is known to
//    be sufficient.
//
// 2. IT RUNS THE BUNDLE ONCE BEFORE ANY TEST DOES. Whatever makes a first run
//    expensive -- scanning or something else -- that run now happens in the
//    global setup, before any test file starts, and every test spawns a bundle
//    that has already executed. This is the half that does not depend on
//    knowing the cause. Building once rather than once per suite also means
//    one fresh file to pay that first run for, not three.
//
// If a first run turns slow again, time the variants above before widening a
// test's budget -- widening is what index-dispatch did the last time (its
// SIGKILL guard went from 15s to 90s in 163a9da), and the cost outgrew it.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The warmed bundle broker-bundle.setup.ts built for this run, or unset
     *  when the run includes no suite that spawns it. */
    brokerBundlePath: string | undefined;
  }
}

const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** How long the warm-up run may take before it is killed. Sized against the
 *  slowest first runs on record, which were CONTENDED ones and only have lower
 *  bounds: in the release run above, index-dispatch's first boot was still
 *  going at its 90s guard, e2e-round-trip's first `doctor` runs outlived a
 *  120s timeout, and its round-trip broker then stayed silent for 30s more.
 *  (Timed directly, outside vitest, the slowest was 43.9s.) A healthy
 *  `--version` exits in seconds, so a guard this generous costs nothing
 *  unless something is already wrong -- and a tighter one would kill a
 *  working bundle under exactly the load that failed the release. */
export const WARM_UP_GUARD_MS = 300_000;

/** The beforeAll ceiling every caller passes. It only matters when
 *  useBrokerBundle falls back to building in the suite: the 180s the suites
 *  already gave the build alone (seen to exceed 60s on a loaded box), plus the
 *  warm-up guard. Derived, so raising the guard cannot leave a hook timeout that fires
 *  first and reports only "hook timed out" in place of the named kill error
 *  warmUp() raises below. */
export const BROKER_BUNDLE_HOOK_TIMEOUT_MS = 180_000 + WARM_UP_GUARD_MS;

export interface BrokerBundle {
  /** A fresh temp dir holding the bundle. The caller removes it. */
  dir: string;
  /** Absolute path of the bundle inside `dir`, ready for `node <path>`. */
  path: string;
}

/** Bundle src/index.ts into a new temp dir named `<prefix>XXXXXX` and run it
 *  once. On a failure the dir is removed before the error propagates: the
 *  caller only learns `dir` from a successful return, so it could not clean
 *  up itself. */
export async function buildBrokerBundle(prefix: string): Promise<BrokerBundle> {
  // Imported on first use, as the three suites did before this helper existed,
  // so importing the helper alone does not load esbuild.
  const { build } = await import("esbuild");
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, "entry.mjs");
  try {
    const result = await build({
      entryPoints: [INDEX_SRC],
      absWorkingDir: PROJECT_ROOT,
      outfile: path,
      // See the header: the bytes come back in memory and node writes them.
      write: false,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      // Prefer each dep's ESM build, and hand bundled CJS a real require: both
      // keep the self-contained bundle runnable outside the repo.
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __yawCreateRequire } from "node:module";\nconst require = __yawCreateRequire(import.meta.url);',
      },
      define: { __VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
    });
    // One entry point, no sourcemap, no code splitting: one output file today.
    // A second one means the options or the kinds of file index.ts imports
    // changed (a stylesheet import, say, emits its own output), and writing
    // only the first would spawn a bundle missing whatever came with it.
    if (result.outputFiles.length !== 1) {
      throw new Error(
        `expected esbuild to emit one file, got ${result.outputFiles.length}: ${result.outputFiles.map((f) => f.path).join(", ")}`,
      );
    }
    await writeFile(path, result.outputFiles[0].contents);
    await warmUp(path, dir);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // A leftover temp dir is noise; the build error is the finding.
    });
    throw err;
  }
  return { dir, path };
}

/** Execute the bundle once and wait for it to exit. `--version` prints and
 *  exits in index.ts's dispatcher before any config is read, so this loads
 *  the whole bundle and touches nothing else; HOME still points at the temp
 *  dir and YAW_MCP_* is scrubbed, the way every suite spawns it. */
function warmUp(path: string, home: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("YAW_MCP_")) delete env[k];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path, "--version"], {
      cwd: home,
      env: { ...env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const guard = setTimeout(() => child.kill("SIGKILL"), WARM_UP_GUARD_MS);
    child.on("error", (err) => {
      clearTimeout(guard);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      if (code === 0) {
        resolve();
        return;
      }
      // Named rather than left to a hook timeout. A non-zero exit on
      // --version means the bundle is broken. A kill means the run outlasted
      // WARM_UP_GUARD_MS -- past every first run on record, though those
      // contended ones only have lower bounds -- so check the box's load and
      // its scanner before blaming the bundle.
      const how = signal ? `was killed by ${signal} (the guard fires at ${WARM_UP_GUARD_MS}ms)` : `exited ${code}`;
      reject(new Error(`warm-up run of ${path} --version ${how}; stderr tail:\n${stderr.slice(-800)}`));
    });
  });
}

/** The suites that spawn the bundle, relative to the project root. The global
 *  setup builds only when a run includes one of them, so a targeted run of any
 *  other file pays for no build and no warm-up. A test in broker-bundle.test.ts
 *  keeps this list equal to the set of files that call useBrokerBundle. */
export const BROKER_BUNDLE_CONSUMERS: readonly string[] = [
  "src/tests/index-dispatch.test.ts",
  "src/tests/e2e-round-trip.test.ts",
  "src/tests/shutdown-on-stdin-close.test.ts",
];

/** Whether a run whose test files are `planned` needs the bundle. vitest
 *  reports forward-slash paths while path.resolve returns backslashes on
 *  Windows, and a Windows drive letter can arrive in either case, so both
 *  sides are compared with forward slashes, and case-insensitively on win32. */
export function runNeedsBrokerBundle(
  planned: readonly string[],
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const norm = (p: string): string => {
    const slashed = resolve(root, p).replace(/\\/g, "/");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const wanted = new Set(BROKER_BUNDLE_CONSUMERS.map(norm));
  return planned.some((p) => wanted.has(norm(p)));
}

/** The bundle for a suite's beforeAll. Normally the one the global setup
 *  built and warmed for the whole run, and `release` does nothing: the setup's
 *  teardown removes it. When the setup provided none -- a watch-mode rerun
 *  that brought a consumer in after the first run, say -- this builds a
 *  private bundle, says so on stderr so a broken detection is visible rather
 *  than silently back to one build per suite, and `release` removes it. */
export async function useBrokerBundle(prefix: string): Promise<{ path: string; release: () => Promise<void> }> {
  const shared = inject("brokerBundlePath");
  if (shared) return { path: shared, release: async () => {} };
  process.stderr.write(`broker-bundle: the global setup provided no bundle; building one for ${prefix}\n`);
  const own = await buildBrokerBundle(prefix);
  return { path: own.path, release: () => rm(own.dir, { recursive: true, force: true }) };
}
