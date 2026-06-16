// `yaw-mcp reset-learning` — delete ~/.yaw-mcp/state.json so cross-session
// learning starts fresh. Pairs with the doctor RELIABILITY section (see
// doctor-cmd.ts) and the dispatch penalty branch (learning.ts):
// once doctor has flagged a namespace as flaky, its penalty keeps
// suppressing routing to it until enough new successes pile up.
// If the user fixed the underlying issue (rotated the token, swapped
// the upstream, re-authed the account) the history is now stale and
// that penalty has overstayed its welcome — this command wipes it.
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
import { loadState, STATE_FILENAME, STATE_SCHEMA_VERSION } from "./persistence.js";

export const RESET_LEARNING_USAGE = `Usage: yaw-mcp reset-learning

  Delete ~/.yaw-mcp/state.json so cross-session learning starts fresh.
  Use this after fixing the root cause of a flaky upstream (token
  rotated, account swapped, server replaced) so the routing penalty
  doesn't keep suppressing it.

  -h, --help  Show this help.`;

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
  const raw = env.YAW_MCP_DISABLE_PERSISTENCE;
  const disabled = raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
  if (disabled) {
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
    return { exitCode: 0, lines, removed: true, path: filePath };
  }

  print("yaw-mcp reset-learning: cleared persisted state.");
  print(`  path: ${filePath}`);
  print(`  learning entries removed:     ${learningCount}`);
  print(`  pack history entries removed: ${packCount}`);
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
    return (parsed as { version?: unknown }).version === STATE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
