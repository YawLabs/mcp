// Shared URL-safety helpers used by config-loader, config, and heartbeat to
// avoid leaking bearer tokens over plaintext http:// to non-loopback hosts.
//
// The single exception is loopback (localhost / 127.0.0.1 / ::1) so a dev
// can point yaw-mcp at a local stub during development without forcing TLS.
//
// Keep this file tiny and dep-free; it gets imported from cold paths
// (initial config load, every heartbeat) where pulling in heavier modules
// would slow startup.

/** True iff `host` is one of the loopback names that we allow http:// for. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Validate that `apiBase` is a usable yaw-mcp API origin. Returns the
 * parsed URL on success; throws a clear Error on failure so callers can
 * surface the message verbatim. Allows https:// unconditionally and
 * http:// for loopback hosts only.
 */
export function validateApiBase(apiBase: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error(`apiBase must be a valid URL (got: ${apiBase})`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed;
  throw new Error(`apiBase must use https (or http for loopback only). Got: ${apiBase}`);
}
