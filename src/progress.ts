import { log } from "./logger.js";

export type ProgressReporter = (message: string, progress?: number, total?: number) => void;

export interface ProgressSender {
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

// Returns a progress reporter for the current tool call. If the client
// supplied a progressToken in _meta, notifications flow back to the client
// as it progresses. If not, this is a no-op so callers never need to branch.
//
// The counter auto-increments per call so the reporter is drop-in: callers
// just describe *what* is happening, not *how far along*. When a total is
// unknown (variable N servers to activate), we omit `total` so the client
// renders an indeterminate progress bar rather than a misleading percentage.
export function createProgressReporter(
  extra: { sendNotification?: ProgressSender["sendNotification"]; _meta?: Record<string, unknown> } | undefined,
): ProgressReporter {
  const token = extra?._meta?.progressToken as string | number | undefined;
  const send = extra?.sendNotification;
  if (token === undefined || token === null || !send) {
    return () => {};
  }

  let step = 0;
  // MCP requires progress to be monotonically non-decreasing per token. Clamp
  // each emission to max(lastEmitted, candidate) so a caller-supplied value
  // that regresses (or a stale auto-increment after a higher explicit value)
  // never goes backward on the wire. Keyed by progressToken in case a
  // reporter ever gets reused across tokens.
  const lastEmitted = new Map<string | number, number>();
  return (message, progress, total) => {
    step += 1;
    const candidate = progress ?? step;
    const prior = lastEmitted.get(token) ?? -Number.POSITIVE_INFINITY;
    const emitted = candidate > prior ? candidate : prior;
    const params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    } = {
      progressToken: token,
      progress: emitted,
      message,
    };
    if (total !== undefined) params.total = total;
    lastEmitted.set(token, emitted);
    send({ method: "notifications/progress", params }).catch((err) => {
      log("warn", "Progress notification send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
