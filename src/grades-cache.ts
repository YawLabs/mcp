// Compliance grade cache -- ~/.yaw-mcp/grades.json.
//
// `yaw-mcp audit <namespace>` runs the @yawlabs/mcp-compliance suite against a
// server's stdio spawn config and writes its grade here. `yaw-mcp list`
// (local-add-cmd.ts runList) and the broker's hydrateComplianceGrades
// (server.ts -- the view the Yaw Terminal MCP panel sees) merge a server's
// cached grade into its row so the user sees an up-to-date letter grade
// without re-running the suite on every list.
//
// Shape (keyed by namespace):
//   {
//     "ctxlint": { "grade": "A", "score": 97.7, "gradedAt": "2026-06-11T..." }
//   }
//
// This file is purely a local cache. It is safe to delete; the next `audit`
// run repopulates it. We never fail a list/read on a malformed cache -- a
// garbage grades.json is treated as "no cached grades" and ignored.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { type FileLockOptions, stealStaleLock, withFileLock } from "./file-lock.js";
import { setJsonKey } from "./json-key.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

/** Canonical filename for the grade cache. */
export const GRADES_FILENAME = "grades.json";

/** One cached grade entry. `grade` is the A-F letter; `score` is the 0-100
 *  percentage; `gradedAt` is an ISO-8601 timestamp of when the audit ran.
 *  `suiteVersion` is the compliance rubric that produced the letter -- the
 *  @yawlabs/mcp-compliance PACKAGE version (e.g. "0.17.1"; rubric changes ship
 *  as package releases, whereas the package's exported SPEC_VERSION is the MCP
 *  protocol revision date, identical across releases -- see
 *  resolveComplianceSuiteVersion in audit-cmd.ts). Optional because entries
 *  written before it existed carry only the timestamp. Without it two rubrics'
 *  letters are indistinguishable in `list`, so a pre-rubric-change "A" reads
 *  as current. */
export interface CachedGrade {
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  gradedAt: string;
  suiteVersion?: string;
}

/** The on-disk shape: a map of namespace -> cached grade. */
export type GradesCache = Record<string, CachedGrade>;

const GRADE_LETTERS = new Set(["A", "B", "C", "D", "F"]);

/** Absolute path to grades.json inside the user-global ~/.yaw-mcp/ dir. The
 *  cache is always user-global -- a grade describes how a server BINARY scored,
 *  not a per-project preference, so there's no project-local variant. */
export function gradesCachePath(home: string = homedir()): string {
  return join(userConfigDir(home), GRADES_FILENAME);
}

/** Valid range for a cached score, matching the compliance suite's 0-100
 *  percentage. Range-validated for the same reason the letter is checked
 *  against GRADE_LETTERS: an out-of-range score (-5, 1e9) is a corrupt or
 *  hand-edited entry, and rendering it in the `list` row or the Yaw
 *  Terminal MCP panel would show a nonsense grade rather than falling back
 *  to "no cached grade". */
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** Coerce a raw parsed entry into a CachedGrade, or null if malformed. A
 *  single bad entry is dropped rather than discarding the whole cache. */
function validateEntry(entry: unknown): CachedGrade | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const grade = typeof e.grade === "string" ? e.grade.toUpperCase() : "";
  if (!GRADE_LETTERS.has(grade)) return null;
  const score = typeof e.score === "number" && Number.isFinite(e.score) ? e.score : null;
  if (score === null) return null;
  if (score < MIN_SCORE || score > MAX_SCORE) return null;
  const gradedAt = typeof e.gradedAt === "string" && e.gradedAt.length > 0 ? e.gradedAt : "";
  if (!gradedAt) return null;
  // Optional: entries from before suiteVersion existed stay valid without it;
  // a malformed value is dropped from the entry rather than dropping the entry.
  const suiteVersion = typeof e.suiteVersion === "string" && e.suiteVersion.length > 0 ? e.suiteVersion : undefined;
  return suiteVersion
    ? { grade: grade as CachedGrade["grade"], score, gradedAt, suiteVersion }
    : { grade: grade as CachedGrade["grade"], score, gradedAt };
}

/** Read the grade cache. Returns an empty object when the file is absent or
 *  malformed -- never throws, so a list command degrades to "no cached grades"
 *  instead of crashing on a hand-edited file. */
export async function readGradesCache(home: string = homedir()): Promise<GradesCache> {
  return readGradesCacheImpl(home, { strictRead: false });
}

/** strictRead: true is the WRITE path's posture. writeGrade's
 *  read-modify-write must not treat a transient read failure (EACCES,
 *  EBUSY from a win32 AV/indexer handle -- the same class atomic-write.ts
 *  retries renames for, EISDIR) as "no cache": doing so published a
 *  one-entry file and silently destroyed every other cached grade,
 *  contradicting writeGrade's own "preserving every other entry" doc.
 *  Rethrowing instead lands in audit-cmd's writeGrade catch, which
 *  reports grade-computed-but-cache-write-failed as exit 3. Only
 *  ENOENT/ENOTDIR mean "no cache yet" (same split as config-loader).
 *  A file that reads but does not PARSE -- or parses to something that is
 *  not a namespace -> grade object -- still yields {} on both paths:
 *  replacing a malformed cache with a rebuilt one is fine -- it is
 *  disposable derived data, and both of those cases log a warning on the
 *  way out, so the rebuild is never the user's only clue. */
async function readGradesCacheImpl(home: string, opts: { strictRead: boolean }): Promise<GradesCache> {
  const path = gradesCachePath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.strictRead && code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    log("warn", "grades.json is not valid JSON; ignoring", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  // Warned about, not dropped in silence: a root that PARSES but is not a
  // namespace->grade map (an array, a bare number, `null`) is exactly as
  // corrupt as invalid JSON, and it is the same user staring at a `list`
  // table with no grades in it. Saying nothing here while the parse failure
  // above logs meant the identical symptom had a diagnostic in one case and
  // nothing at all in the other. Both then rebuild the file on the next audit
  // (see the strictRead note above), so the warning is the only trace.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log("warn", "grades.json is not a JSON object of namespace -> grade; ignoring", {
      path,
      rootType: Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed,
    });
    return {};
  }
  const out: GradesCache = {};
  for (const [ns, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const validated = validateEntry(entry);
    // setJsonKey, not out[ns]: ns comes straight from the parsed cache file,
    // and plain assignment to "__proto__" would drop the grade AND repoint
    // `out`'s prototype at it.
    if (validated) setJsonKey(out, ns, validated);
  }
  return out;
}

// --- cross-process lock ------------------------------------------------------
//
// Every production writeGrade runs in its own one-shot `yaw-mcp audit`
// process (audit-cmd.ts is its only caller, and index.ts runs one audit per
// process), so the writers that collide on grades.json are PROCESSES: the Yaw
// Terminal MCP panel grading two servers at once, or two terminals. An
// in-process promise chain -- what this file used to carry -- serialized the
// one case that never happens in production and left the real one open: both
// audits loaded the pre-write snapshot, both atomic renames landed, and
// whichever landed second silently dropped the other's grade. Both printed
// "Cached to ...", and `list` showed no letter for the loser until it was
// re-audited.
//
// The serializer is the shared sidecar lock in file-lock.ts (O_EXCL take,
// stale takeover by rename, ownership-checked release -- the rules live
// there). This file keeps the default budgets: a writer waits 15s on a LIVE
// lock, longer than the 10s stale age, so a writer arriving right after a
// holder crashed always outlives the lock instead of failing on it. Giving up
// throws, which audit-cmd reports as grade-computed-but-not-cached (exit 3):
// the honest outcome, and one re-audit repairs it.

/** Test hooks for the lock's timing. Production callers pass nothing. */
export type WriteGradeOptions = FileLockOptions;

/** Re-exported for the grades-cache test that pins the live-restore path. */
export { stealStaleLock };

// Names the LOCK file only: audit-cmd's exit-3 wrapper already prefixes the
// grades.json path, and the lock sits beside it, so repeating the cache path
// here printed the same long absolute path three times in one stderr line.
function lockTimeoutMessage(lockPath: string, ageMs: number | null): string {
  const held = ageMs === null ? "" : ` for ${Math.round(ageMs / 1000)}s`;
  return `locked by another yaw-mcp audit (${lockPath}, held${held}) -- re-run this audit once it finishes`;
}

/** Write (insert or replace) a single namespace's grade into the cache,
 *  preserving every other entry. Atomic write, under the cross-process lock
 *  above, so two audits finishing together cannot drop each other's entry.
 *  Returns the path written. `opts` is test-only timing for the lock. */
export async function writeGrade(
  namespace: string,
  grade: CachedGrade,
  home: string = homedir(),
  opts: WriteGradeOptions = {},
): Promise<string> {
  const path = gradesCachePath(home);
  await withFileLock(path, opts, lockTimeoutMessage, async () => {
    // strictRead: a transient read failure must throw (surfacing as audit's
    // exit 3), not clobber the cache -- see readGradesCacheImpl.
    const cache = await readGradesCacheImpl(home, { strictRead: true });
    // setJsonKey, not cache[namespace]: mirrors the read side above. Plain
    // assignment of "__proto__" would invoke the inherited setter and the
    // grade would vanish from the serialized file.
    setJsonKey(cache, namespace, grade);
    await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  });
  return path;
}
