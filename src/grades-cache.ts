// Compliance grade cache -- ~/.yaw-mcp/grades.json.
//
// `yaw-mcp audit <namespace>` runs the @yawlabs/mcp-compliance suite against a
// server's stdio spawn config and writes its grade here. The `servers` command
// (and the Yaw Terminal MCP panel, which reads `servers --json`) merge a
// server's cached grade into its row so the user sees an up-to-date letter
// grade without re-running the suite on every list.
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
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

/** Canonical filename for the grade cache. */
export const GRADES_FILENAME = "grades.json";

/** One cached grade entry. `grade` is the A-F letter; `score` is the 0-100
 *  percentage; `gradedAt` is an ISO-8601 timestamp of when the audit ran. */
export interface CachedGrade {
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  gradedAt: string;
}

/** The on-disk shape: a map of namespace -> cached grade. */
export type GradesCache = Record<string, CachedGrade>;

const GRADE_LETTERS = new Set(["A", "B", "C", "D", "F"]);

/** Absolute path to grades.json inside the user-global ~/.yaw-mcp/ dir. The
 *  cache is always user-global -- a grade describes how a server BINARY scored,
 *  not a per-project preference, so there's no project-local variant. */
export function gradesCachePath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, GRADES_FILENAME);
}

/** Valid range for a cached score, matching the compliance suite's 0-100
 *  percentage. Range-validated for the same reason the letter is checked
 *  against GRADE_LETTERS: an out-of-range score (-5, 1e9) is a corrupt or
 *  hand-edited entry, and rendering it in the `servers` row or the Yaw
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
  return { grade: grade as CachedGrade["grade"], score, gradedAt };
}

/** Read the grade cache. Returns an empty object when the file is absent or
 *  malformed -- never throws, so a list command degrades to "no cached grades"
 *  instead of crashing on a hand-edited file. */
export async function readGradesCache(home: string = homedir()): Promise<GradesCache> {
  const path = gradesCachePath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: GradesCache = {};
  for (const [ns, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const validated = validateEntry(entry);
    if (validated) out[ns] = validated;
  }
  return out;
}

// In-process serializer for writeGrade. Concurrent audits against different
// namespaces share the same on-disk grades.json, so the read-modify-write
// sequence below MUST run one-at-a-time per cache path -- otherwise two
// writers race, each loads the pre-write snapshot, and whichever atomic
// rename lands second silently drops the other's entry. We chain each call
// onto the previous Promise (per cache path) so reads-then-writes serialize.
// Errors are caught on the chained tail so one failed write does NOT poison
// subsequent calls (the next caller still gets to run); the original caller
// still sees its own error via the awaited `chained` below.
const writeGradeChain = new Map<string, Promise<void>>();

/** Write (insert or replace) a single namespace's grade into the cache,
 *  preserving every other entry. Atomic write. Returns the path written.
 *  Concurrent calls (same cache file) are serialized via writeGradeChain so
 *  concurrent read-modify-write sequences cannot drop entries. */
export async function writeGrade(namespace: string, grade: CachedGrade, home: string = homedir()): Promise<string> {
  const path = gradesCachePath(home);
  const prev = writeGradeChain.get(path) ?? Promise.resolve();
  const run = async (): Promise<void> => {
    const cache = await readGradesCache(home);
    cache[namespace] = grade;
    await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  };
  // .then(run, run) means: run AFTER the previous link settles, regardless of
  // whether it resolved or rejected. The caller of THIS writeGrade still sees
  // any error its own `run` throws via the awaited `chained` below.
  const chained = prev.then(run, run);
  // Stored variant swallows errors so the NEXT caller's await doesn't reject
  // on a prior write's failure -- decouples chain liveness from per-call outcomes.
  const tail = chained.catch(() => undefined);
  writeGradeChain.set(path, tail);
  try {
    await chained;
  } finally {
    // Drop the map entry once OUR link is the latest -- prevents the map from
    // growing forever in long-lived processes. If another writer queued after
    // us, the map already holds their tail; leave it in place.
    if (writeGradeChain.get(path) === tail) writeGradeChain.delete(path);
  }
  return path;
}
