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
import { type HealedEntry, healStaleBrokerEntries } from "./heal-entries.js";

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
  const healed = await healStaleBrokerEntries({ dryRun: options.dryRun });

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ healed, count: healed.length, dryRun: options.dryRun === true }, null, 2)}\n`,
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
  }
  // Zero either way: finding nothing to heal is the healthy outcome, and a
  // repair that succeeded is not an error. The app treats a non-zero exit as
  // "retry next launch", so a clean sweep must never report one.
  return { exitCode: 0 };
}
