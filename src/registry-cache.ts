// On-disk cache of npm-registry "latest" answers for `yaw-mcp doctor`.
//
// doctor asks registry.npmjs.org for the latest version of @yawlabs/mcp and
// of every installed managed sidecar package, and Yaw Terminal's MCP panel
// runs `doctor --json` on every refresh. Without a cache that is one GET per
// package per refresh. This module remembers each answer for
// REGISTRY_CACHE_TTL_MS in ONE JSON file, `~/.yaw-mcp/registry-cache.json`,
// so a repeated run inside that window sends nothing.
//
// Shape on disk:
//   { "version": 1, "packages": { "<pkg>": { "latest": "1.2.3", "at": <epoch ms> } } }
//
// Everything here fails OPEN, toward asking the registry: a missing file, a
// file that does not parse, a wrong shape, an entry with a bad field, an
// expired entry, or one stamped in the future (a clock that moved back) all
// read as a miss and the fetch runs as it did before the cache existed. A
// write that fails is swallowed -- losing it costs one GET on the next run.
// Only a fetched, non-null answer is stored: "unknown" (offline, a timeout, a
// non-2xx) is never cached, so a registry that was briefly unreachable is
// asked again on the next run rather than reading as unknown for a day.
//
// `write: false` is the read-only mode: the cache is consulted and a miss is
// fetched, but nothing is written. doctor passes it under
// YAW_MCP_READONLY_DIAGNOSTICS, whose contract is that the diagnostic
// commands write nothing (see READONLY_DIAGNOSTICS_ENV in config-loader.ts).
//
// Writes are serialized within the process (doctor probes its sidecars in
// parallel), and each write re-reads the file before merging, so concurrent
// probes in one run do not drop each other's entries. Two PROCESSES writing at
// once can still lose one entry to last-writer-wins; the cost is one extra GET.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { userConfigDir } from "./paths.js";

/** Basename of the cache file inside `~/.yaw-mcp/`. */
export const REGISTRY_CACHE_FILENAME = "registry-cache.json";

/** How long a cached answer is trusted: 24 hours. */
export const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** An entry stamped further in the future than this is treated as a miss --
 *  the clock moved back, and trusting the entry would pin it for longer than
 *  the TTL. A small allowance absorbs ordinary clock adjustment. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Longest version string stored or accepted -- a guard against a garbage
 *  registry body or a hand-edited file, not a semver rule. */
const MAX_VERSION_LENGTH = 256;

const CACHE_SCHEMA_VERSION = 1;

/** `~/.yaw-mcp/registry-cache.json` for the given home. */
export function registryCachePath(home: string): string {
  return join(userConfigDir(home), REGISTRY_CACHE_FILENAME);
}

export interface RegistryCacheOptions {
  /** The home whose `.yaw-mcp/` holds the cache file. */
  home: string;
  /** Clock for the TTL check and the stamp on a new entry. */
  now: () => number;
  /** false: read the cache and fetch on a miss, but write nothing. */
  write: boolean;
}

interface CacheEntry {
  latest: string;
  at: number;
}

function isVersionString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_VERSION_LENGTH;
}

function isFresh(entry: CacheEntry, now: number): boolean {
  const age = now - entry.at;
  return age >= -FUTURE_SKEW_MS && age < REGISTRY_CACHE_TTL_MS;
}

/** Every well-formed entry in the file, or an empty map when the file is
 *  missing, unreadable, not JSON, or not the expected shape. A single bad
 *  entry is dropped on its own; the rest of the file still counts. */
async function readEntries(path: string): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  const root = parsed as { version?: unknown; packages?: unknown };
  if (root.version !== CACHE_SCHEMA_VERSION) return out;
  const packages = root.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return out;
  for (const [pkg, raw] of Object.entries(packages as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { latest, at } = raw as { latest?: unknown; at?: unknown };
    if (!isVersionString(latest) || typeof at !== "number" || !Number.isFinite(at)) continue;
    out.set(pkg, { latest, at });
  }
  return out;
}

// In-process write serializer: each write waits for the previous one, then
// re-reads the file and merges, so parallel probes do not overwrite each
// other. Never rejects (every write swallows its own failure).
let writeChain: Promise<void> = Promise.resolve();

function recordLatest(path: string, pkg: string, latest: string, now: number): Promise<void> {
  const next = writeChain.then(async () => {
    try {
      const entries = await readEntries(path);
      entries.set(pkg, { latest, at: now });
      // Prune what can no longer be served, so a package dropped from
      // bundles.json does not keep its entry forever.
      for (const [key, entry] of entries) if (!isFresh(entry, now)) entries.delete(key);
      const body = { version: CACHE_SCHEMA_VERSION, packages: Object.fromEntries(entries) };
      // dirMode 0o700: doctor is often the first command on a fresh machine,
      // so this write can be the one that births ~/.yaw-mcp/. Every other
      // writer into that dir asks for 0o700 (bundles.json there can carry
      // `--env` secrets) and mkdir only applies a mode to a dir it creates,
      // so a 0o755 birth here would stick. 0o600 keeps the file owner-only
      // to match its siblings; the contents are not secret.
      await atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8", 0o600, 0o700);
    } catch {
      // Unwritable home, EACCES, a read-only filesystem: no cache this time.
    }
  });
  writeChain = next;
  return next;
}

/**
 * The latest version of `pkg`: from the cache when a fresh entry is there
 * (no network at all), otherwise from `fetchLatest`, whose non-null answer is
 * then stored unless `opts.write` is false. A rejecting `fetchLatest` reads
 * as null ("unknown"), the same as every other probe failure.
 */
export async function cachedRegistryLatest(
  pkg: string,
  fetchLatest: () => Promise<string | null>,
  opts: RegistryCacheOptions,
): Promise<string | null> {
  const path = registryCachePath(opts.home);
  const now = opts.now();
  const hit = (await readEntries(path)).get(pkg);
  if (hit && isFresh(hit, now)) return hit.latest;
  let latest: string | null;
  try {
    latest = await fetchLatest();
  } catch {
    return null;
  }
  // Returned as the fetcher gave it; only a plausible version string is kept.
  if (opts.write && isVersionString(latest)) await recordLatest(path, pkg, latest, now);
  return latest;
}
