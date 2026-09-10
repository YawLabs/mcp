import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `yaw-mcp doctor | head` used to die with a raw Node stack trace:
//
//   node:events:497
//         throw er; // Unhandled 'error' event
//   Error: EPIPE: broken pipe, write
//
// Piping into something that reads a few lines and leaves -- `| head`, `| grep
// -q`, a shell `$(...)` whose consumer exits -- is an ordinary thing to do to a
// CLI, and every subcommand that printed through a bare
// `(s) => process.stdout.write(s)` crashed on it. The exit code was wrong too:
// the crash produced 1 on a config `doctor` had just judged healthy, so a
// script branching on the code got the opposite answer piped than unpiped.
//
// logger.ts's createStreamWriter is the fix and predates this file -- it
// attaches one no-op 'error' listener per stream, latches the stream broken so
// later writes are dropped rather than re-raising, and leaves the caller's own
// exit code alone. What was missing is that only `call` used it. Every other
// command kept its own raw default, so the guard existed and did not apply.
//
// This is the cheap half of the guard: a scan that fails when a NEW command
// arrives with a raw writer default, which is the way the bug comes back. The
// expensive half -- proving the mechanism works against a real process whose
// reader walks away -- lives in e2e-round-trip.test.ts, where a bundle already
// exists to spawn.

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The two shapes that were swept, spelled without the `opts.out ??` prefix so
 *  the scan also catches them assigned any other way. A writer built straight
 *  onto the process stream is the defect regardless of what it is named. */
const RAW_WRITER_PATTERNS = [
  "process.stdout.write(s)",
  "process.stderr.write(s)",
  "process.stdout.write(`${s}",
  "process.stderr.write(`${s}",
];

/** Files exempt, each for a stated reason rather than by convenience.
 *
 *  logger.ts DEFINES the guard, so it necessarily writes to the raw stream
 *  inside it -- that write is the one place the try/catch belongs.
 *
 *  index.ts's own writes are the pre-dispatch surface (`--version`, usage, the
 *  unknown-subcommand signpost): a handful of lines emitted before any command
 *  runs, where there is nothing yet to stop doing. They are safe to leave raw
 *  only because they are short enough that the pipe cannot fill; if that ever
 *  stops being true this exemption is the thing to revisit. */
const EXEMPT = new Set(["logger.ts", "index.ts"]);

describe("CLI output survives a consumer that stops reading", () => {
  it("has no subcommand writing straight to a process stream", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(SRC_DIR)) {
      if (!file.endsWith(".ts") || EXEMPT.has(file)) continue;
      const src = readFileSync(join(SRC_DIR, file), "utf8");
      for (const pattern of RAW_WRITER_PATTERNS) {
        if (src.includes(pattern)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(
      offenders,
      `These write directly to a process stream, so piping the command into a reader that exits ` +
        `kills it with an unhandled EPIPE. Use createStreamWriter(process.stdout) from logger.js ` +
        `instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("routes every command's writer defaults through createStreamWriter", () => {
    // The positive half. The scan above proves the bad shape is gone; without
    // this one, deleting every writer default would also pass it.
    const withDefaults: string[] = [];

    for (const file of readdirSync(SRC_DIR)) {
      if (!file.endsWith(".ts") || EXEMPT.has(file)) continue;
      const src = readFileSync(join(SRC_DIR, file), "utf8");
      if (/opts\.(out|err|printErr)\s*\?\?/.test(src)) withDefaults.push(file);
    }

    // Every file that falls back to a default writer must import the guard.
    // Named individually rather than counted, so the failure says which file
    // regressed instead of that a number moved.
    for (const file of withDefaults) {
      const src = readFileSync(join(SRC_DIR, file), "utf8");
      expect(src, `${file} has a writer default but does not import createStreamWriter`).toContain(
        "createStreamWriter",
      );
    }

    // A floor, so a refactor that removes the defaults wholesale cannot leave
    // this test passing vacuously over an empty list.
    expect(withDefaults.length).toBeGreaterThan(10);
  });
});
