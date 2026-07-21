// Shared URL-safety helpers used by config-loader, config, and heartbeat to
// avoid leaking bearer tokens over plaintext http:// to non-loopback hosts.
//
// The single exception is loopback so a dev can point yaw-mcp at a local
// stub during development without forcing TLS. "Loopback" here means the
// whole 127.0.0.0/8 range, the IPv6 ::1 literal, and the `localhost`
// special-use name plus any `*.localhost` subdomain (RFC 6761 reserves
// those for loopback resolution, and both browsers and Node resolvers
// honour it).
//
// Keep this file tiny and dep-free; it gets imported from cold paths
// (initial config load, every heartbeat) where pulling in heavier modules
// would slow startup.

/** True iff every label of `host` is a decimal octet and the first is 127
 *  -- i.e. the host is a literal address inside 127.0.0.0/8. Matches only
 *  a full dotted quad, so `127.0.0.1.evil.com` is NOT loopback. */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** True iff `host` is one of the loopback names that we allow http:// for.
 *  Allow-direction only: anything not recognised here stays https-only. */
export function isLoopbackHost(host: string): boolean {
  // URL.hostname is already lowercased, but callers may pass a raw string.
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  // RFC 6761: `localhost` and any subdomain of it resolve to loopback.
  // endsWith rules out `localhost.evil.com` -- only a true suffix matches.
  if (h.length > ".localhost".length && h.endsWith(".localhost")) return true;
  return isIpv4Loopback(h);
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
