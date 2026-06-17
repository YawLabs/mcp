// Sidecar tracking the remote `mcp_bundles` resource version this machine
// last reconciled with. `sync push` submits THIS version (not a freshly-GET'd
// one) so optimistic concurrency can actually fire when the remote moved ahead
// since the last pull. Lives next to bundles.json under ~/.yaw-mcp/.
//
// Shared by sync-cmd (pull/push/status) and set-active so both writers keep
// the same notion of "what version is this machine current at".

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const SYNC_STATE_FILENAME = "sync-state.json";

export interface SyncState {
  mcp_bundles?: { lastPulledVersion: number };
}

export function syncStatePath(home: string): string {
  return join(home, CONFIG_DIRNAME, SYNC_STATE_FILENAME);
}

/** Read the sync-state sidecar. Tolerates an absent or malformed file by
 *  returning {} -- a missing last-pulled version simply means "never
 *  pulled", which the push path handles by falling back to the GET'd
 *  remote version (seeding). */
export async function readSyncState(home: string): Promise<SyncState> {
  const path = syncStatePath(home);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as SyncState;
  } catch {
    return {};
  }
}

// Merges the given keys into the existing sync-state file (read-modify-write),
// rather than replacing the whole file. Callers can pass only the keys they
// care about and trust unrelated keys to be preserved.
export async function writeSyncState(home: string, state: SyncState): Promise<void> {
  const path = syncStatePath(home);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readSyncState(home);
  const merged = { ...existing, ...state };
  await atomicWriteFile(path, `${JSON.stringify(merged, null, 2)}\n`);
}
