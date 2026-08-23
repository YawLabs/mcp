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
// The reporter is drop-in: callers can just describe *what* is happening
// (message-only), or additionally say *how far along* with an absolute
// progress/total pair. Message-only calls omit `total` so the client
// renders an indeterminate progress bar rather than a misleading percentage.
export function createProgressReporter(
  extra: { sendNotification?: ProgressSender["sendNotification"]; _meta?: Record<string, unknown> } | undefined,
): ProgressReporter {
  const token = extra?._meta?.progressToken as string | number | undefined;
  const send = extra?.sendNotification;
  if (token === undefined || token === null || !send) {
    return () => {};
  }

  // MCP requires progress to strictly increase per token. Two kinds of
  // calls share this one token: explicit milestones (caller supplies an
  // absolute `progress`, usually with `total`) and message-only sub-steps
  // (no numbers at all). The old scheme fed both through one integer
  // counter, so message-only calls inflated the counter past the caller's
  // absolute values and the monotonic clamp then re-emitted duplicates
  // and progress > total (a 300% bar on a plain dispatch). Instead:
  //   - message-only calls creep forward by a small epsilon and never
  //     carry a total (indeterminate), so they cannot consume the integer
  //     milestones the caller is about to report;
  //   - explicit calls emit the caller's value when it still moves the
  //     wire forward, otherwise lastEmitted + epsilon, and drop `total`
  //     when the nudged value would exceed it (never >100% on the wire).
  // A scalar suffices: `token` is captured once from this call's _meta and
  // never reassigned, so the reporter can only ever emit under that token.
  const EPSILON = 1e-3;
  let lastEmitted = -EPSILON; // so the first message-only call emits 0
  return (message, progress, total) => {
    let emitted: number;
    let emittedTotal: number | undefined;
    if (progress !== undefined) {
      emitted = progress > lastEmitted ? progress : lastEmitted + EPSILON;
      emittedTotal = total !== undefined && emitted <= total ? total : undefined;
    } else {
      emitted = lastEmitted + EPSILON;
      emittedTotal = undefined;
    }
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
    if (emittedTotal !== undefined) params.total = emittedTotal;
    lastEmitted = emitted;
    send({ method: "notifications/progress", params }).catch((err) => {
      log("warn", "Progress notification send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
}
