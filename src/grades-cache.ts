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

/** Coerce a raw parsed entry into a CachedGrade, or null if malformed. A
 *  single bad entry is dropped rather than discarding the whole cache. */
function validateEntry(entry: unknown): CachedGrade | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const grade = typeof e.grade === "string" ? e.grade.toUpperCase() : "";
  if (!GRADE_LETTERS.has(grade)) return null;
  const score = typeof e.score === "number" && Number.isFinite(e.score) ? e.score : null;
  if (score === null) return null;
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

/** Write (insert or replace) a single namespace's grade into the cache,
 *  preserving every other entry. Atomic write. Returns the path written. */
export async function writeGrade(namespace: string, grade: CachedGrade, home: string = homedir()): Promise<string> {
  const path = gradesCachePath(home);
  const cache = await readGradesCache(home);
  cache[namespace] = grade;
  await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  return path;
}
