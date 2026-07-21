import { request } from "undici";
import { tokenFingerprint } from "./config-loader.js";
import { NAMESPACE_RE } from "./local-bundles.js";
import { log } from "./logger.js";
import type { ConnectConfig } from "./types.js";

// Hard cap on the config response body. The backend's real config
// payload is a few KB; anything larger is either a misbehaving server
// or a malicious / proxied response. Reject before parsing JSON so we
// don't pay the parse cost on absurd inputs.
const MAX_CONFIG_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// Non-2xx bodies are diagnostic text we splice into an error message, so
// they get a far tighter cap than the config payload itself: a runaway
// HTML error page (proxy interstitial, captive portal, 500-page with a
// stack trace) must not be buffered whole just to build one line of
// output. Anything past the cap is dropped with a "(truncated)" marker.
const MAX_ERROR_BODY_BYTES = 8 * 1024; // 8 KB

// The `type` values the backend is allowed to send. Anything else is a
// backend/schema drift we can't route (upstream.ts switches on it), so
// the server is dropped rather than half-loaded. Mirrors the
// UpstreamServerConfig["type"] union in types.ts.
const VALID_SERVER_TYPES: ReadonlySet<string> = new Set(["local", "remote"]);

/**
 * Read at most `maxBytes` of a response body into a string, best-effort.
 * Used for error paths where we want *some* server text in the message
 * without letting a hostile / runaway body drive memory. Never throws --
 * a read failure just yields whatever arrived before it.
 */
async function readBodyCapped(body: AsyncIterable<unknown>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      received += buf.length;
      if (received >= maxBytes) {
        truncated = true;
        // Best-effort abandon of the rest so the socket can be released.
        try {
          (body as { destroy?: (err?: Error) => void }).destroy?.();
        } catch {}
        break;
      }
    }
  } catch {
    // Partial text is still more useful than none for a diagnostic.
  }
  const text = Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
  return truncated ? `${text}... (truncated)` : text;
}

/**
 * Fetch the config from Yaw MCP.
 *
 * Optionally pass `currentVersion` (the configVersion from the previously
 * fetched config) to enable conditional GETs via If-None-Match. When the
 * server responds 304 Not Modified, this returns `null` and the caller
 * should keep its existing config unchanged.
 *
 * On a real config change the server returns 200 with the full body and
 * an `ETag: "<configVersion>"` header; callers should pass the new
 * `configVersion` on the next tick.
 */
export async function fetchConfig(
  apiUrl: string,
  token: string,
  currentVersion?: string,
): Promise<ConnectConfig | null> {
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/config`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (currentVersion) {
    headers["If-None-Match"] = `"${currentVersion}"`;
  }

  const res = await request(url, {
    method: "GET",
    headers,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });

  if (res.statusCode === 304) {
    // Drain body (should be empty) so the connection can be reused.
    await res.body.text().catch(() => {});
    return null;
  }

  if (res.statusCode === 401) {
    await res.body.text().catch(() => {});
    throw new ConfigError(
      `Token rejected (HTTP 401) -- the token ${tokenFingerprint(token)} is invalid or revoked.\n  Generate a new token at https://yaw.sh/mcp/dashboard/settings/tokens,\n  then re-run \`yaw-mcp install <client> --token mcp_pat_...\` or set YAW_MCP_TOKEN.`,
      true,
    );
  }

  if (res.statusCode === 403) {
    await res.body.text().catch(() => {});
    throw new ConfigError(
      `Access denied (HTTP 403) -- the token ${tokenFingerprint(token)} was accepted but lacks permission to read this account's servers.\n  The account may be suspended or the token scope reduced -- check\n  https://yaw.sh/mcp/dashboard/settings/tokens, or reach support@yaw.sh.`,
      true,
    );
  }

  if (res.statusCode !== 200) {
    const body = await readBodyCapped(res.body, MAX_ERROR_BODY_BYTES);
    throw new ConfigError(`Config fetch failed (HTTP ${res.statusCode}): ${body}`, false);
  }

  // Stream-read the body with a hard byte cap so a malicious / runaway
  // server response can't OOM the process. undici's body is an async
  // iterable of Buffer chunks; sum bytes as they arrive and bail the
  // moment we cross the threshold.
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buf.length;
      if (received > MAX_CONFIG_BODY_BYTES) {
        // Make a best-effort attempt to abandon the rest of the body so
        // the connection can be reused / closed cleanly.
        try {
          (res.body as { destroy?: (err?: Error) => void }).destroy?.();
        } catch {}
        throw new ConfigError(`Config response too large (>5 MB) from yaw-mcp backend`, false);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Config response read failed: ${msg}`, false);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  let data: ConnectConfig;
  try {
    data = JSON.parse(bodyText) as ConnectConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Config response was not valid JSON: ${msg}`, false);
  }

  if (!data.servers || !Array.isArray(data.servers)) {
    throw new ConfigError("Invalid config response from server", false);
  }

  // Validate servers in ONE pass, warning once per drop reason. The
  // reasons are checked in dependency order (presence -> type union ->
  // namespace shape) so a later check never re-tests something an earlier
  // one already rejected, and a dropped server produces exactly one log
  // line explaining why.
  //
  // Intentional schema asymmetry vs. local-bundles.validateEntry: that path
  // SYNTHESIZES id/name/type from a bare namespace (locally-authored entries
  // only need a namespace), whereas the backend response is the authoritative
  // source and is expected to carry all four fields, so we reject (rather than
  // coerce) anything missing here. The two ingestion paths are deliberately
  // strict-vs-lenient; do not unify without auditing both callers.
  data.servers = data.servers.filter((s) => {
    if (!s.id || !s.name || !s.namespace || !s.type) {
      log("warn", "Skipping server with missing required fields", { id: s.id, name: s.name, namespace: s.namespace });
      return false;
    }
    if (!VALID_SERVER_TYPES.has(s.type)) {
      log("warn", "Skipping server with unrecognized type", { type: s.type, name: s.name, namespace: s.namespace });
      return false;
    }
    if (!NAMESPACE_RE.test(s.namespace)) {
      log("warn", "Skipping server with invalid namespace", { namespace: s.namespace, name: s.name });
      return false;
    }
    return true;
  });

  log("info", "Config loaded", { serverCount: data.servers.length, version: data.configVersion });

  return data;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly fatal: boolean,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
