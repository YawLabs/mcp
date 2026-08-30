const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// LOG_LEVEL is resolved per call instead of latched at import. The module is
// imported once per process, so a latched threshold makes the env var
// unchangeable for the life of that process -- tests cannot vary it, and an
// embedding host that flips it mid-session is silently ignored. The lookup is
// one env read plus an object index, far cheaper than the JSON.stringify it
// gates.
function minLevel(): number {
  return LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase() as LogLevel] ?? LOG_LEVELS.info;
}

// A host that closes our stderr first (the pipe reader exits before we do)
// makes the next write emit 'error' (EPIPE) on the stream. With no listener
// attached Node treats that as an unhandled 'error' event and takes the
// process down -- losing the session over a log line. One no-op listener
// downgrades it to a dropped line. Attached only when nothing else is
// listening, so a host that installed its own handler keeps it.
let stderrErrorGuarded = false;
function guardStderrErrors(): void {
  if (stderrErrorGuarded) return;
  stderrErrorGuarded = true;
  try {
    if (process.stderr.listenerCount("error") === 0) {
      process.stderr.on("error", () => {
        // Deliberately empty: logging must never be able to kill the process.
      });
    }
  } catch {
    // An embedding host may substitute a stderr stub without an EventEmitter
    // surface; the write below is still guarded by its own try/catch.
  }
}

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < minLevel()) return;
  guardStderrErrors();

  const ts = new Date().toISOString();
  let entry: string;
  try {
    // Spread data FIRST so a data key named level/msg/ts can never clobber
    // the envelope fields parsers key on.
    entry = JSON.stringify({ ...data, level, msg, ts });
  } catch {
    // JSON.stringify throws on a BigInt and on a circular reference, both of
    // which reach us through caller-supplied `data`. The caller is mid
    // diagnostic, so drop the payload rather than the whole line: the level
    // and message are the parts a reader needs, and dataOmitted says why the
    // rest is missing.
    entry = JSON.stringify({ level, msg, ts, dataOmitted: true });
  }

  try {
    process.stderr.write(`${entry}\n`);
  } catch {
    // A synchronous EPIPE/EBADF on an already-closed stderr. There is nowhere
    // left to report it, and throwing here would surface a log failure as a
    // failure of whatever the caller was actually doing.
  }
}
