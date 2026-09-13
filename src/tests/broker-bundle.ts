// The ONE build of src/index.ts that every real-process suite spawns:
// index-dispatch, e2e-round-trip and shutdown-on-stdin-close. index.ts
// dispatches at module scope, so it cannot be imported and called -- these
// suites bundle it into a self-contained ESM file and run that with node.
//
// Not a test file (no `.test.ts`, so vitest's `src/**/*.test.ts` include does
// not pick it up) -- a helper the suites import.
//
// NODE WRITES THE BUNDLE, NOT ESBUILD. This is the whole reason the helper
// exists, and it is not a style choice. On a Windows box with on-access
// antivirus (Defender real-time protection), the FIRST execution of a bundle
// esbuild wrote to disk itself was far slower than every later one, and the
// cost followed the writer rather than the bytes. Measured outside vitest on
// an idle ARM64 box, 2026-09-13, `node entry.mjs --version`, a never-before-
// seen bundle each time:
//
//     esbuild writes it (write: true)          first run 37.3s, 36.5s
//     esbuild builds it, node writes it        first run  1.6s,  1.6s
//     esbuild writes it, node copies it        first run 43.9s,  9.1s
//
// The second and later runs of every variant took 0.5-5s. The copy row is
// why this builds with `write: false` instead of copying esbuild's output
// somewhere else: reading an esbuild-written file to copy it still paid.
//
// That first run is what failed a release gate on 2026-09-13. All three
// suites had esbuild write their own bundle, so each one's first spawn paid
// the cost inside a test budget: shutdown-on-stdin-close waits 20s for the
// upstream to start (less than the idle cost alone), e2e-round-trip waits 30s
// for `initialize`, and index-dispatch SIGKILLs at 90s -- which the full
// suite's contention, with two of these bundles scanned side by side in the
// parallel group, pushed the cost past too. Four tests failed, and both
// failure messages that print the broker's stderr tail printed it empty: the
// broker never got far enough to log a line.
//
// Why the scanner treats esbuild's writes differently is not established
// here; the measurement is. If a first run turns slow again, time the variants
// above before widening any budget -- widening is what these suites did the
// last time, and the cost outgrew it.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface BrokerBundle {
  /** A fresh temp dir holding the bundle. The caller removes it. */
  dir: string;
  /** Absolute path of the bundle inside `dir`, ready for `node <path>`. */
  path: string;
}

/** Bundle src/index.ts into a new temp dir named `<prefix>XXXXXX`. */
export async function buildBrokerBundle(prefix: string): Promise<BrokerBundle> {
  // Loaded lazily, as the suites always did: esbuild starts a service process,
  // and a file that imports this helper should not pay for it at import time.
  const { build } = await import("esbuild");
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, "entry.mjs");
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
  // One entry point, no sourcemap, no metafile: exactly one output. Anything
  // else means the options above changed, and writing only the first file
  // would spawn a bundle missing whatever came second.
  if (result.outputFiles.length !== 1) {
    throw new Error(
      `expected esbuild to emit one file, got ${result.outputFiles.length}: ${result.outputFiles.map((f) => f.path).join(", ")}`,
    );
  }
  await writeFile(path, result.outputFiles[0].contents);
  return { dir, path };
}
