// `yaw-mcp reset-learning` — delete ~/.yaw-mcp/state.json so cross-session
// learning starts fresh. Pairs with the doctor RELIABILITY section (see
// doctor-cmd.ts) and the dispatch penalty branch (learning.ts):
// once doctor has flagged a namespace as flaky, its penalty keeps
// suppressing routing to it until enough new successes pile up.
// If the user fixed the underlying issue (rotated the token, swapped
// the upstream, rotated its credentials) the history is now stale and
// that penalty has overstayed its welcome — this command wipes it.
//
// IMPORTANT: this deletes the file on disk, it does NOT reach into a
// running session. `yaw-mcp serve` holds the learning store in memory and
// flushes a full snapshot (server.ts flushStateSave, on a ~1s debounce
// after every recorded outcome/miss/exec step, plus once on shutdown)
// without ever re-reading the file first -- so a serve process attached to
// an MCP client will recreate state.json with every pre-reset entry on its
// next proxied tool call. That is the NORMAL configuration, so the success
// report says so explicitly and tells the user to restart the client.
//
// Scope is intentionally "all or nothing." A per-namespace flag feels
// nice but the failure mode is a footgun (user clears one namespace,
// forgets about three others, keeps getting silently mis-ranked).
// If finer granularity is ever needed we can add `--namespace <ns>`
// as an additive flag without breaking the current contract.
//
// Exit codes:
//   0  normal: file removed, nothing to remove, or persistence disabled
//   1  I/O error: file existed but couldn't be removed (permissions, etc.)

import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { userConfigDir } from "./paths.js";
import { isPersistenceDisabled, isReadableStateVersion, loadState, STATE_FILENAME } from "./persistence.js";

export const RESET_LEARNING_USAGE = `Usage: yaw-mcp reset-learning

  Delete ~/.yaw-mcp/state.json so cross-session learning starts fresh.
  Use this after fixing the root cause of a flaky upstream (token
  rotated, account swapped, server replaced) so the routing penalty
  doesn't keep suppressing it.

  Restart your MCP client afterwards: a running "yaw-mcp serve" keeps
  the learning it has in memory and re-saves it over the deleted file
  on its next tool call.

  -h, --help  Show this help.`;

// Printed on every path that actually removed the file. The delete is a
// pure filesystem operation with no channel to a live serve process, and
// that process re-saves its in-memory snapshot without consulting the file
// first -- so without this the user watches "cleared persisted state" and
// then keeps getting the exact routing penalty they just cleared, with
// nothing on screen connecting the two.
const RUNNING_SERVE_NOTE = [
  "  note: a running yaw-mcp serve process still holds this learning in",
  "        memory and re-saves it over the deleted file within a second of",
  "        the next tool call. Restart your MCP client (or stop that serve",
  "        process) for the reset to take effect.",
];

export type ParsedResetLearning =
  | { kind: "help" }
  | { kind: "error"; error: string }
  | { kind: "ok"; options: Record<string, never> };

// Argv parser. Crucially, this exists so `yaw-mcp reset-learning --help`
// doesn't fall through to runResetLearning() and silently delete state.
//
// The command takes ZERO arguments (the only switch is -h/--help). So
// rather than loop over argv pretending to validate each element, we
// state that contract directly: no args is the only success, the first
// arg being a help flag prints help, and anything else is an error on
// that first arg. (A loop here would imply per-arg validation it never
// actually performs — it returns on its first iteration regardless, so
// argv[1..] are never inspected. Making the contract explicit avoids
// that misleading shape; behavior is unchanged.)
export function parseResetLearningArgs(argv: string[]): ParsedResetLearning {
  if (argv.length === 0) return { kind: "ok", options: {} };
  const first = argv[0];
  if (first === "-h" || first === "--help") return { kind: "help" };
  return {
    kind: "error",
    error: `yaw-mcp reset-learning: unknown argument "${first}"\n\n${RESET_LEARNING_USAGE}`,
  };
}

export interface ResetLearningOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. */
  err?: (s: string) => void;
}

export interface ResetLearningResult {
  exitCode: number;
  /** Lines printed to stdout/stderr, in order — exposed for tests. */
  lines: string[];
  /** True when the state file was actually deleted. */
  removed: boolean;
  /** Absolute path we targeted — useful for the "nothing to reset" message. */
  path: string;
}

export async function runResetLearning(opts: ResetLearningOptions = {}): Promise<ResetLearningResult> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const filePath = join(userConfigDir(home), STATE_FILENAME);

  // When persistence is disabled, the running yaw-mcp session isn't
  // reading or writing state.json anyway. A stale file on disk could
  // still exist from a prior session when the env wasn't set — we
  // leave it alone. Rationale: the env flag is usually a temporary
  // opt-out (CI, sandbox, debug); wiping real history every time
  // someone runs this command under the flag would surprise users who
  // expected their opt-out to be non-destructive. If they really want
  // the file gone they can unset the flag and re-run.
  //
  // The predicate is persistence.ts's -- this command used to open-code the
  // same expression, and a divergence would have it deleting the file a
  // running broker still believed it owned (or refusing to when the broker had
  // already stopped writing).
  if (isPersistenceDisabled(env)) {
    print("yaw-mcp reset-learning: persistence is disabled (YAW_MCP_DISABLE_PERSISTENCE) — nothing to clear.");
    return { exitCode: 0, lines, removed: false, path: filePath };
  }

  // Peek before deleting so we can report what was cleared. loadState
  // is tolerant — missing file, malformed JSON, and version mismatch
  // all collapse to emptyState (0/0), so its counts alone can't tell a
  // genuinely-empty file from an unreadable one. We separately classify
  // the file as "parsed cleanly" vs "present but unreadable" so the
  // report doesn't claim "0 entries removed" when a non-trivial file was
  // actually deleted.
  //
  // This is a peek/delete TOCTOU by nature: the counts come from the
  // pre-delete read, so a concurrent serve-write between the peek and the
  // unlink can make them slightly stale. That's acceptable — the delete
  // is correct regardless, and reset-learning is a manual, one-shot admin
  // command, not something racing a live writer in practice. The counts
  // are advisory reporting, not a contract.
  const persisted = await loadState(filePath);
  const learningCount = Object.keys(persisted.learning).length;
  const packCount = persisted.packHistory.length;
  const parsedCleanly = await peekParsedCleanly(filePath);

  try {
    await unlink(filePath);
  } catch (err) {
    if (isFileNotFound(err)) {
      print("yaw-mcp reset-learning: no persisted state to reset.");
      print(`  path: ${filePath}`);
      return { exitCode: 0, lines, removed: false, path: filePath };
    }
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`yaw-mcp reset-learning: failed to remove ${filePath}: ${msg}`);
    return { exitCode: 1, lines, removed: false, path: filePath };
  }

  // A file existed (unlink succeeded) but loadState couldn't parse it into
  // a current-version state — malformed JSON or a version mismatch. The
  // 0/0 counts would be misleading, so report that the file was cleared
  // without claiming an entry count we never actually read.
  if (!parsedCleanly) {
    print("yaw-mcp reset-learning: cleared persisted state (contents unreadable).");
    print(`  path: ${filePath}`);
    for (const line of RUNNING_SERVE_NOTE) print(line);
    return { exitCode: 0, lines, removed: true, path: filePath };
  }

  print("yaw-mcp reset-learning: cleared persisted state.");
  print(`  path: ${filePath}`);
  print(`  learning entries removed:     ${learningCount}`);
  print(`  pack history entries removed: ${packCount}`);
  for (const line of RUNNING_SERVE_NOTE) print(line);
  return { exitCode: 0, lines, removed: true, path: filePath };
}

// Did the state file parse into a current-version state object? This
// mirrors loadState's own accept conditions (valid JSON, an object, the
// expected schema version) so a `true` here means the learning/pack
// counts loadState returned are real, and a `false` means loadState fell
// through to emptyState because the file was malformed or version-stale.
// A missing file (ENOENT) returns true — its absence is reported via the
// unlink ENOENT path, never the "unreadable" branch.
async function peekParsedCleanly(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isFileNotFound(err)) return true;
    // Couldn't read for another reason (permissions, etc.) — treat as
    // unreadable so we don't claim a concrete entry count we never got.
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    // Any version loadState can READ counts as parsed-cleanly, not just the
    // current one. STATE_SCHEMA_VERSION went 1 -> 2 for the additive
    // toolCache field and loadState MIGRATES v1 rather than dropping it, so
    // an exact-equality check here would report a perfectly good v1 file as
    // unreadable for the one session before its first save rewrites it.
    return isReadableStateVersion((parsed as { version?: unknown }).version);
  } catch {
    return false;
  }
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
