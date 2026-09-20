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
 */
import { type HealedEntry, type HealResult, healStaleBrokerEntries } from "./heal-entries.js";

export interface HealOptions {
  json?: boolean;
  dryRun?: boolean;
  /** Suppress the human transcript; exit code and JSON still apply. Used by
   *  the app, which logs its own line and has no terminal to print to. */
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

export async function runHeal(options: HealOptions = {}): Promise<{ exitCode: number }> {
  let result: HealResult;
  try {
    result = await healStaleBrokerEntries({ dryRun: options.dryRun });
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
  const { healed, unhealable } = result;

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ healed, unhealable, count: healed.length, dryRun: options.dryRun === true }, null, 2)}\n`,
    );
    return { exitCode: 0 };
  }

  if (options.quiet !== true) {
    if (healed.length === 0) {
      process.stdout.write("No stale yaw-mcp entries found.\n");
    } else {
      const verb = options.dryRun === true ? "Would re-point" : "Re-pointed";
      process.stdout.write(
        `${verb} ${healed.length} stale ${healed.length === 1 ? "entry" : "entries"}:\n${healed.map(describe).join("\n")}\n` +
          (options.dryRun === true ? "" : "\nRestart the affected client(s) to pick this up.\n"),
      );
    }
    // Never folded into the "no stale entries" line above: these are files the
    // sweep could not read INTO, so it cannot claim they are healthy, and a
    // user sitting on a dead entry in one of them would otherwise be told
    // everything was fine. `doctor` explains each shape and its by-hand fix.
    if (unhealable.length > 0) {
      process.stdout.write(
        `\n${unhealable.length} config${unhealable.length === 1 ? "" : "s"} could not be checked:\n` +
          `${unhealable.map((u) => `  ${u.clientId} (${u.scope}): ${u.path} -- ${u.reason}`).join("\n")}\n` +
          "Run `yaw-mcp doctor` for what each one needs.\n",
      );
    }
  }
  // Zero for both outcomes above: finding nothing to heal is the healthy
  // result, and a repair that succeeded is not an error. Only the catch above
  // returns non-zero, so the app can tell a real failure from a clean sweep.
  return { exitCode: 0 };
}
