/**
 * `yaw-mcp heal` -- the explicit surface over the stale-entry sweep in
 * heal-entries.ts.
 *
 * WHY A SUBCOMMAND AT ALL, when `serve` already runs the same pass. The serve
 * trigger can only fire once some client successfully starts the broker, and
 * the users this exists for are precisely the ones whose entry is dead. A user
 * whose ONLY configured client is the broken one has no working path to a
 * running broker at all, so the sweep has to be reachable without one. This is
 * the verb Yaw Terminal calls at app startup for exactly that reason.
 *
 * Unlike the serve trigger this is not opt-out-able: the user (or the app
 * acting for them) asked for it by name, so `YAW_MCP_AUTO_HEAL=0` -- which
 * governs the UNATTENDED pass -- does not apply. The read-only gate still does,
 * because that one is about never writing behind a diagnostics poll.
 *
 * EXIT CODES. 0 for a clean sweep and for a repair; 1 when the sweep threw,
 * or when a stale entry it found could not be re-pointed (the file would not
 * take the write, or the edit was refused) -- that entry's client still
 * cannot start the broker, so it is not a success. The two 1s differ on
 * stdout under --json: the throw prints no JSON, the failed repair prints the
 * whole result with the entry under `failed`.
 */
import {
  type FailedHeal,
  type HealedEntry,
  type HealResult,
  healStaleBrokerEntries,
  type HealOptions as SweepOptions,
} from "./heal-entries.js";

export interface HealOptions {
  json?: boolean;
  dryRun?: boolean;
  /** Suppress the human transcript; exit code and JSON still apply, and so
   *  does the stderr report of a stale entry the run could not re-point. Used
   *  by the app, which logs its own line and has no terminal to print to. */
  quiet?: boolean;
}

const USAGE =
  "Usage: yaw-mcp heal [--json] [--dry-run] [--quiet]\n" +
  "\n" +
  "Re-point yaw-mcp entries whose launch file no longer exists -- what an app\n" +
  "upgrade leaves behind when it deletes the directory the entry named.\n" +
  "Only an entry yaw-mcp wrote AND that is currently broken is touched.\n" +
  "\n" +
  "  --json      Machine-readable result\n" +
  "  --dry-run   Report what would change; write nothing\n" +
  "  --quiet     No human transcript\n";

/** Inline result union, matching every sibling parse function (the shared
 *  ParseResult lives in index.ts, which cannot be imported: its dispatcher
 *  runs at import time). */
export function parseHealArgs(
  argv: readonly string[],
): { ok: true; options: HealOptions } | { ok: false; error: string; help?: boolean } {
  const options: HealOptions = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { ok: false, error: USAGE, help: true };
    else if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--quiet") options.quiet = true;
    else return { ok: false, error: `yaw-mcp heal: unknown option ${arg}\n\n${USAGE}` };
  }
  return { ok: true, options };
}

function describe(h: HealedEntry): string {
  return `  ${h.clientId} (${h.scope}): ${h.path}\n    was -> ${h.from}\n    now -> ${h.to}`;
}

/** The stderr block for the stale entries this run could not re-point: which
 *  entry, the dead path it still names, the clause saying why (it names the
 *  file and, where there is one, the step past it), and the re-run. */
function describeFailures(failed: readonly FailedHeal[], dryRun: boolean): string {
  const one = failed.length === 1;
  const rows = failed.map((f) => `  ${f.clientId} (${f.scope}): ${f.path}\n    still -> ${f.from}\n    ${f.error}`);
  return (
    `yaw-mcp heal: ${dryRun ? "cannot" : "could not"} re-point ${failed.length} stale ${one ? "entry" : "entries"}:\n` +
    `${rows.join("\n")}\n` +
    (one
      ? "It still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what the line above says, then re-run `yaw-mcp heal`.\n"
      : "Each still names a launch file that no longer exists, so its client cannot start yaw-mcp -- fix what each entry's last line says, then re-run `yaw-mcp heal`.\n")
  );
}

/** `sweep` is the test seam: the real one reads and writes this machine's
 *  client configs. */
export async function runHeal(
  options: HealOptions = {},
  sweep: (opts: SweepOptions) => Promise<HealResult> = healStaleBrokerEntries,
): Promise<{ exitCode: number }> {
  let result: HealResult;
  try {
    result = await sweep({ dryRun: options.dryRun });
  } catch (err) {
    // The sweep already catches per-file problems; reaching here means
    // something unexpected went wrong for the whole run. Say so rather than
    // letting it escape as a bare non-zero exit: the app maps ANY non-zero to
    // "skipped (exit N)" -- the same line an older broker that does not know
    // this verb produces -- so an unreported throw would read as a benign
    // no-op forever.
    process.stderr.write(`yaw-mcp heal: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }
  const { healed, unhealable, failed } = result;
  // A stale entry the sweep found and could not re-point is an ERROR, not
  // part of the transcript: it goes to stderr in every mode -- --json and
  // --quiet included, as the throw above does -- and the run exits 1. Before,
  // the sweep only logged it, and this command went on to say "No stale
  // yaw-mcp entries found." with exit 0 about a file whose dead entry it had
  // just failed to rewrite.
  const exitCode = failed.length > 0 ? 1 : 0;
  const reportFailures = (afterTranscript: boolean): void => {
    if (failed.length === 0) return;
    process.stderr.write(`${afterTranscript ? "\n" : ""}${describeFailures(failed, options.dryRun === true)}`);
  };

  if (options.json === true) {
    // `failed` is new; the other four fields keep their meaning (`count` is
    // still repairs only), so a reader that knows only those reads what it
    // always did.
    process.stdout.write(
      `${JSON.stringify({ healed, unhealable, failed, count: healed.length, dryRun: options.dryRun === true }, null, 2)}\n`,
    );
    reportFailures(false);
    return { exitCode };
  }

  // Whether this run has put anything on stdout yet, so each later block is
  // set off by a blank line and none of them starts the output with one.
  let printed = false;
  if (options.quiet !== true) {
    if (healed.length === 0) {
      // Only when the sweep found nothing at all: a stale entry it could not
      // re-point is reported below, and this line would contradict it.
      if (failed.length === 0) {
        process.stdout.write("No stale yaw-mcp entries found.\n");
        printed = true;
      }
    } else {
      const verb = options.dryRun === true ? "Would re-point" : "Re-pointed";
      process.stdout.write(
        `${verb} ${healed.length} stale ${healed.length === 1 ? "entry" : "entries"}:\n${healed.map(describe).join("\n")}\n` +
          (options.dryRun === true ? "" : "\nRestart the affected client(s) to pick this up.\n"),
      );
      printed = true;
    }
    // Never folded into the "no stale entries" line above: these are files the
    // sweep could not read INTO, so it cannot claim they are healthy, and a
    // user sitting on a dead entry in one of them would otherwise be told
    // everything was fine. `doctor` explains each shape and its by-hand fix.
    if (unhealable.length > 0) {
      process.stdout.write(
        `${printed ? "\n" : ""}${unhealable.length} config${unhealable.length === 1 ? "" : "s"} could not be checked:\n` +
          `${unhealable.map((u) => `  ${u.clientId} (${u.scope}): ${u.path} -- ${u.reason}`).join("\n")}\n` +
          "Run `yaw-mcp doctor` for what each one needs.\n",
      );
      printed = true;
    }
  }
  reportFailures(printed);
  // Zero for a clean sweep and for a repair that landed: finding nothing to
  // heal is the healthy result, and a config the sweep could not check is
  // listed above, not failed. One, from the throw above or for an entry it
  // could not re-point, so the app can tell a real failure from a clean sweep.
  return { exitCode };
}
