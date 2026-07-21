// Append-only audit trail for secret-vault resolution at spawn time.
//
// One global log at ~/.yaw-mcp/secrets-audit.log, NDJSON (one JSON object
// per line), mode 0o600. Each line records that a named secret was
// injected into (or was missing for) a given server's spawn env -- the
// secret NAME and the server namespace ONLY, never the value. The log
// lets a user answer "which secrets did this server actually consume, and
// when" without ever persisting plaintext.
//
// Discipline:
//   - NEVER write a secret value. The event shape has no value field.
//   - Writes are FAIL-OPEN: appendAuditEvent swallows every error so a
//     broken/unwritable log can never block or crash a server spawn. The
//     audit trail is a convenience, not a correctness dependency.
//   - Tail-capped at 5000 lines on append so the file can't grow without
//     bound on a long-lived process.

import { existsSync } from "node:fs";
import { appendFile, chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const SECRETS_AUDIT_FILENAME = "secrets-audit.log";

/** Max lines retained in the audit log. On append, if the file exceeds
 *  this, the oldest lines are trimmed so the tail of recent activity is
 *  kept. Chosen high enough that a normal session never trims, low enough
 *  the file stays small (~hundreds of KB at the cap). */
export const AUDIT_TAIL_CAP = 5000;

export type AuditEventKind = "injected" | "missing";

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Server namespace the secret was resolved for. */
  server: string;
  /** Secret NAME (never a value). */
  secret: string;
  /** Whether the secret was injected or was referenced-but-absent. */
  event: AuditEventKind;
}

/** Input to appendAuditEvent: the caller supplies server/secret/event;
 *  `ts` is stamped here so every line is consistently formatted. */
export interface AuditEventInput {
  server: string;
  secret: string;
  event: AuditEventKind;
}

export function auditLogPath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SECRETS_AUDIT_FILENAME);
}

/**
 * Append one audit event as an NDJSON line. FAIL-OPEN: any error (dir
 * missing, permission denied, disk full) is swallowed so a broken log
 * never blocks a server spawn. The 0o600 chmod + tail-cap are best-effort
 * for the same reason.
 */
export async function appendAuditEvent(input: AuditEventInput, home: string = homedir()): Promise<void> {
  try {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      server: input.server,
      secret: input.secret,
      event: input.event,
    };
    const path = auditLogPath(home);
    const line = `${JSON.stringify(event)}\n`;

    if (!existsSync(path)) {
      // First write: atomicWriteFile mkdirs ~/.yaw-mcp/ for us, then we
      // lock the mode down. Both best-effort.
      await atomicWriteFile(path, line);
    } else {
      await appendFile(path, line, "utf8");
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o600).catch(() => undefined);
    }
    await trimToTailCap(path);
  } catch {
    // Fail open -- the audit trail must never break a spawn.
  }
}

/** Conservative lower bound on the byte length of one line appendAuditEvent
 *  writes. The shortest possible event line -- 24-char ISO timestamp, empty
 *  server, empty secret, `"missing"` -- is 76 bytes including the newline,
 *  so 64 leaves headroom while staying a valid lower bound. */
const MIN_AUDIT_LINE_BYTES = 64;

/** Trim the log to the last AUDIT_TAIL_CAP lines if it has grown past it.
 *  Best-effort and swallowed by the caller's try/catch. */
async function trimToTailCap(path: string): Promise<void> {
  // Cheap size gate first: a file smaller than cap * MIN_AUDIT_LINE_BYTES
  // cannot hold more than AUDIT_TAIL_CAP of our lines, so skip the read
  // entirely. Without it every single append re-read the whole log (a few
  // hundred KB once the file is near the cap) just to discover it was
  // under. Caveat: hand-appended lines shorter than the bound could push
  // the LINE count over the cap while the file stays under the byte gate.
  // The cap is a best-effort size guard, not an invariant.
  const { size } = await stat(path);
  if (size < AUDIT_TAIL_CAP * MIN_AUDIT_LINE_BYTES) return;
  const raw = await readFile(path, "utf8");
  // Split on newlines; the trailing "" after the final newline is dropped.
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length <= AUDIT_TAIL_CAP) return;
  const kept = lines.slice(lines.length - AUDIT_TAIL_CAP);
  // Rewrite in place. This read-modify-write is neither atomic nor locked:
  // a concurrent appendFile from another yaw-mcp process between the read
  // above and this write is LOST, and an append that interleaves with the
  // write can leave a garbled line behind. Both are accepted here -- the
  // cost is audit history, never a secret (the file holds names only), and
  // readAuditLog skips malformed lines. The size gate above keeps this
  // window rare: it opens only when the log is genuinely over the cap.
  await writeFile(path, `${kept.join("\n")}\n`, "utf8");
}

export interface AuditFilter {
  /** Only events for this secret NAME. */
  secret?: string;
  /** Only events for this server namespace. */
  server?: string;
}

/**
 * Read the audit log, newest line last (file order). Malformed lines are
 * skipped rather than throwing -- a partially-written tail line shouldn't
 * sink the whole read. Returns [] when the file does not exist.
 */
export async function readAuditLog(filter: AuditFilter = {}, home: string = homedir()): Promise<AuditEvent[]> {
  const path = auditLogPath(home);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip a malformed / torn line
    }
    if (!isAuditEvent(parsed)) continue;
    if (filter.secret !== undefined && parsed.secret !== filter.secret) continue;
    if (filter.server !== undefined && parsed.server !== filter.server) continue;
    out.push(parsed);
  }
  return out;
}

function isAuditEvent(v: unknown): v is AuditEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.server === "string" &&
    typeof e.secret === "string" &&
    (e.event === "injected" || e.event === "missing")
  );
}
