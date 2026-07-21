import { request } from "undici";
import type { ErrorCategory } from "./error-category.js";
import { log } from "./logger.js";
import { isLoopbackHost } from "./url-safety.js";

export interface ConnectAnalyticsEvent {
  namespace: string | null;
  toolName: string | null;
  action:
    | "discover"
    | "activate"
    | "deactivate"
    | "tool_call"
    | "import"
    | "install"
    | "health"
    | "suggest"
    | "read_tool"
    | "exec"
    | "bundles"
    | "secrets";
  latencyMs: number | null;
  // Failure rate is inferred from `success`. Never add a string field
  // sourced from upstream content here -- third-party MCP servers routinely
  // echo back args/secrets in error messages (URLs with api_key= query
  // params, request bodies, Python tracebacks containing locals) and we
  // have no way to scrub them in the general case. The `errorCategory`
  // below is a bounded enum derived from the error text via
  // classifyError() in error-category.ts -- no upstream content, no leak.
  success: boolean;
  errorCategory?: ErrorCategory;
  timestamp: string;
}

export interface DispatchAnalyticsEvent {
  scope: "connect";
  serverId: string | null;
  toolName: string | null;
  requestBytes: number;
  responseBytesRaw: number;
  responseBytesPruned?: number;
}

const FLUSH_INTERVAL = 30_000;
const FLUSH_SIZE = 50;
const MAX_BUFFER = 5000;

const buffer: ConnectAnalyticsEvent[] = [];
const dispatchBuffer: DispatchAnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let apiUrl = "";
let token = "";

// Single-slot latch capturing the most recent rejection from EITHER
// flush path (connect or dispatch) so `yaw-mcp doctor` can surface a
// silently-failing analytics pipeline instead of letting the buffer
// quietly fill and roll over. Cleared on the next successful 2xx flush
// (from either path) so a transient 4xx doesn't stick forever.
// Diagnostic-only: never re-POSTed to the dashboard (no recursion).
export interface AnalyticsFailure {
  statusCode: number;
  url: string;
  at: number;
}
let lastFailure: AnalyticsFailure | null = null;

// Per-path "last warn-logged HTTP status" latches. Suppress re-logging
// the same failure code on back-to-back flushes -- a persistent 401
// against an active user still hits flush() every interval as new
// events arrive, so without these we'd warn-spam every 30s for the
// life of the process. Reset on a 2xx for the same path and on
// initAnalytics. The `lastFailure` field above remains the per-event
// diagnostic surfaced by `yaw-mcp doctor`.
let lastLoggedConnectStatus: number | null = null;
let lastLoggedDispatchStatus: number | null = null;
// One-shot latches: warn once per process (reset by initAnalytics) when
// the configured apiUrl is not https and not loopback, so the operator
// sees the misconfiguration without a warn line every 30s.
// Separate latches for each flush path so the connect flush firing first
// cannot suppress the dispatch-events warning.
let warnedInsecureBearerSkipConnect = false;
let warnedInsecureBearerSkipDispatch = false;

/**
 * Returns true when it is safe to send `Authorization: Bearer ...` to
 * the given URL. Bearers are allowed over https://, or over http:// only
 * to loopback (127.0.0.1, ::1, localhost). Pure predicate -- no side
 * effects. Callers are responsible for one-shot warn logging via their
 * own per-path latch.
 */
function shouldSendBearer(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return true;
  return false;
}

export function getLastAnalyticsFailure(): AnalyticsFailure | null {
  return lastFailure;
}

// Module-scope drop counter. Incremented whenever a buffer push is refused
// because MAX_BUFFER is reached, or events fail to re-enqueue after a flush
// error because the buffer is already full. Operators / `yaw-mcp doctor` can
// read this via getDroppedEventsCount() to spot a backlog-shaped failure
// (e.g. an offline run accumulating > MAX_BUFFER events, or a persistent
// 5xx that retries until the buffer wedges).
let droppedEvents = 0;

export function getDroppedEventsCount(): number {
  return droppedEvents;
}

export interface AnalyticsSnapshot {
  bufferedConnect: number;
  bufferedDispatch: number;
  droppedEvents: number;
  lastFailure: AnalyticsFailure | null;
}

export function getAnalyticsSnapshot(): AnalyticsSnapshot {
  return {
    bufferedConnect: buffer.length,
    bufferedDispatch: dispatchBuffer.length,
    droppedEvents,
    lastFailure,
  };
}

export function recordConnectEvent(event: Omit<ConnectAnalyticsEvent, "timestamp">): void {
  if (buffer.length >= MAX_BUFFER) {
    droppedEvents++;
    return;
  }
  buffer.push({ ...event, timestamp: new Date().toISOString() });
  if (buffer.length >= FLUSH_SIZE) {
    flush().catch(() => {});
  }
}

export function recordDispatchEvent(event: DispatchAnalyticsEvent): void {
  if (dispatchBuffer.length >= MAX_BUFFER) {
    droppedEvents++;
    return;
  }
  dispatchBuffer.push(event);
  if (dispatchBuffer.length >= FLUSH_SIZE) {
    flushDispatch().catch(() => {});
  }
}

async function flush(): Promise<void> {
  if (buffer.length === 0 || !apiUrl || !token) return;

  const events = buffer.splice(0, FLUSH_SIZE);
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/analytics`;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (shouldSendBearer(url)) {
      headers.Authorization = `Bearer ${token}`;
    } else if (!warnedInsecureBearerSkipConnect) {
      log(
        "warn",
        "Analytics URL is not https and not loopback; sending without Authorization header to avoid leaking the bearer token",
        { url },
      );
      warnedInsecureBearerSkipConnect = true;
    }
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400) {
      // Retry only transient classes: 5xx (server-side), 408 (timeout),
      // 429 (rate-limit). A persistent 401/403 from a revoked or
      // scope-reduced token would otherwise re-queue forever and spam
      // the warn log on every flush interval. Latch is set either way
      // so `yaw-mcp doctor` still surfaces the failure.
      const retryable = res.statusCode >= 500 || res.statusCode === 408 || res.statusCode === 429;
      if (retryable) {
        const room = MAX_BUFFER - buffer.length;
        if (room > 0) buffer.push(...events.slice(0, room));
        if (events.length > Math.max(0, room)) droppedEvents += events.length - Math.max(0, room);
      } else {
        droppedEvents += events.length;
      }
      if (lastLoggedConnectStatus !== res.statusCode) {
        log("warn", "Analytics flush failed", { status: res.statusCode, retried: retryable });
        lastLoggedConnectStatus = res.statusCode;
      }
      lastFailure = { statusCode: res.statusCode, url, at: Date.now() };
    } else {
      lastFailure = null;
      lastLoggedConnectStatus = null;
    }
    // Drain response body
    await res.body.text().catch(() => {});
  } catch (err: any) {
    // Re-insert for retry
    const room = MAX_BUFFER - buffer.length;
    if (room > 0) buffer.push(...events.slice(0, room));
    if (events.length > Math.max(0, room)) droppedEvents += events.length - Math.max(0, room);
    log("warn", "Analytics flush error", { error: err.message });
  }
}

async function flushDispatch(): Promise<void> {
  if (dispatchBuffer.length === 0 || !apiUrl || !token) return;

  const events = dispatchBuffer.splice(0, FLUSH_SIZE);
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/dispatch-events`;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (shouldSendBearer(url)) {
      headers.Authorization = `Bearer ${token}`;
    } else if (!warnedInsecureBearerSkipDispatch) {
      log(
        "warn",
        "Analytics URL is not https and not loopback; sending without Authorization header to avoid leaking the bearer token",
        { url },
      );
      warnedInsecureBearerSkipDispatch = true;
    }
    const res = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400) {
      // See flush() above for the retry-class + log-latch rationale.
      const retryable = res.statusCode >= 500 || res.statusCode === 408 || res.statusCode === 429;
      if (retryable) {
        const room = MAX_BUFFER - dispatchBuffer.length;
        if (room > 0) dispatchBuffer.push(...events.slice(0, room));
        if (events.length > Math.max(0, room)) droppedEvents += events.length - Math.max(0, room);
      } else {
        droppedEvents += events.length;
      }
      if (lastLoggedDispatchStatus !== res.statusCode) {
        log("warn", "Dispatch-events flush failed", { status: res.statusCode, retried: retryable });
        lastLoggedDispatchStatus = res.statusCode;
      }
      lastFailure = { statusCode: res.statusCode, url, at: Date.now() };
    } else {
      lastFailure = null;
      lastLoggedDispatchStatus = null;
    }
    await res.body.text().catch(() => {});
  } catch (err: any) {
    const room = MAX_BUFFER - dispatchBuffer.length;
    if (room > 0) dispatchBuffer.push(...events.slice(0, room));
    if (events.length > Math.max(0, room)) droppedEvents += events.length - Math.max(0, room);
    log("warn", "Dispatch-events flush error", { error: err.message });
  }
}

export function initAnalytics(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
  lastLoggedConnectStatus = null;
  lastLoggedDispatchStatus = null;
  warnedInsecureBearerSkipConnect = false;
  warnedInsecureBearerSkipDispatch = false;
  flushTimer = setInterval(() => {
    flush().catch(() => {});
    flushDispatch().catch(() => {});
  }, FLUSH_INTERVAL);
  if (flushTimer.unref) flushTimer.unref();
}

export async function shutdownAnalytics(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  for (let i = 0; i < 3 && buffer.length > 0; i++) {
    await flush();
  }
  for (let i = 0; i < 3 && dispatchBuffer.length > 0; i++) {
    await flushDispatch();
  }
  buffer.length = 0;
  dispatchBuffer.length = 0;
}
