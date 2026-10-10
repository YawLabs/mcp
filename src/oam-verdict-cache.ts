// Cross-process cache of `oam --version` answers, keyed by the binary's
// identity (absolute path + size + mtime).
//
// Why it exists: every yaw-mcp process probes oam once before its first
// oam-hosted spawn, and the probe is a process start. Measured 2026-10-09
// (perf study m3): with 8 aggregators cold-starting together on a saturated
// box, that probe outlived its timeout -- twice -- in 37 of 260 aggregators,
// and each of those hosted its sidecars on node for the rest of its life. The
// answer it was waiting for never changes for a given binary, so it is asked
// once per binary and remembered here; a self-update or a different OAM_BIN
// changes the identity and is probed afresh.
//
// What is stored is only what a CLEAN `--version` exit printed (the parsed
// version, or null when nothing version-shaped came out). Timeouts, non-zero
// exits and spawn errors are never written: they describe the moment, not the
// binary, and the next launch must ask again. The MIN_OAM_VERSION gate runs on
// the cached version at read time, so raising the floor needs no invalidation.
//
// Best-effort in both directions. A missing, unreadable or malformed file is a
// miss; a failed write is silent beyond a debug line. Concurrent writers (N
// brokers sharing a home) race read-modify-write on the whole file; the loser
// at worst drops another binary's entry, which costs one re-probe.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";
import { isPersistenceDisabled } from "./persistence.js";

export const OAM_VERDICT_FILENAME = "oam-probe.json";
const SCHEMA = 1;
/** Bound on remembered binaries. Real machines have one or two oam builds; a
 *  developer cycling through local builds should not grow the file forever. */
const MAX_ENTRIES = 16;

/** The identity a verdict is valid for. */
export interface OamBinaryIdentity {
  path: string;
  size: number;
  mtimeMs: number;
}

interface StoredEntry {
  size: number;
  mtimeMs: number;
  version: string | null;
  probedAt: string;
}

interface StoredFile {
  schema: number;
  entries: Record<string, StoredEntry>;
}

function verdictFile(): string {
  return path.join(userConfigDir(), OAM_VERDICT_FILENAME);
}

/** Identity of the file at `absPath`, or null when it cannot be stat'ed (in
 *  which case nothing is read or written for it). */
export function oamBinaryIdentity(absPath: string): OamBinaryIdentity | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    return { path: absPath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function readFileEntries(): Record<string, StoredEntry> {
  try {
    const parsed = JSON.parse(readFileSync(verdictFile(), "utf8")) as Partial<StoredFile> | null;
    if (!parsed || parsed.schema !== SCHEMA || typeof parsed.entries !== "object" || parsed.entries === null) {
      return {};
    }
    return parsed.entries as Record<string, StoredEntry>;
  } catch {
    return {};
  }
}

/** Key on the path as Windows compares it: case-insensitively there. */
function keyOf(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * The remembered `--version` answer for this exact binary: a version string,
 * null for "exited cleanly with nothing parsable", or undefined for a miss.
 */
export function readOamVerdict(id: OamBinaryIdentity): string | null | undefined {
  if (isPersistenceDisabled()) return undefined;
  const entry = readFileEntries()[keyOf(id.path)];
  if (!entry || entry.size !== id.size || entry.mtimeMs !== id.mtimeMs) return undefined;
  if (entry.version !== null && typeof entry.version !== "string") return undefined;
  return entry.version;
}

/** Remember a clean `--version` answer. Fire-and-forget; never throws. */
export async function writeOamVerdict(id: OamBinaryIdentity, version: string | null): Promise<void> {
  if (isPersistenceDisabled()) return;
  try {
    const entries = readFileEntries();
    entries[keyOf(id.path)] = { size: id.size, mtimeMs: id.mtimeMs, version, probedAt: new Date().toISOString() };
    // Newest MAX_ENTRIES only.
    const kept = Object.entries(entries)
      .sort((a, b) => String(b[1].probedAt).localeCompare(String(a[1].probedAt)))
      .slice(0, MAX_ENTRIES);
    const file: StoredFile = { schema: SCHEMA, entries: Object.fromEntries(kept) };
    await atomicWriteFile(verdictFile(), `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    log("debug", "could not record the oam --version verdict; the next launch probes again", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
