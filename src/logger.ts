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
//
// There is deliberately no "already guarded" latch. A latch set before the
// attach was attempted permanently disabled the guard whenever a foreign
// 'error' listener happened to be present at the FIRST log() call -- that
// call attached nothing, and every later one returned early. `listenerCount`
// is O(1) and the count===0 check is already idempotent, so re-checking per
// call costs nothing and re-arms us if a host later removes its handler.
function guardStderrErrors(): void {
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

/** Where this process's log records are going.
 *
 *  "server" is the stdio MCP server: stderr is the ONLY channel it has (stdout
 *  carries JSON-RPC), the reader is a client's log pane or a support
 *  transcript, and one machine-parseable record per line is exactly right.
 *
 *  "cli" is a person at a terminal running a subcommand. The same records
 *  reach them as raw envelopes interleaved with the command's own report --
 *  `yaw-mcp list` against a hand-broken bundles.json printed
 *  {"level":"warn","msg":"bundles.json is not valid JSON; ignoring",...} above
 *  the sentence saying the same thing in English. Every subcommand prints its
 *  own diagnostics, so the envelope adds nothing there but noise.
 *
 *  Deliberately NOT auto-detected from stdout.isTTY: `yaw-mcp doctor > report`
 *  is still a person running a subcommand, and the server's stderr is never a
 *  TTY under a client either -- the caller knows which it is, so it says. */
export type LogSurface = "server" | "cli";

let surface: LogSurface = "server";

/** Called once by the CLI dispatcher for any subcommand. Not called on the
 *  bare-`yaw-mcp` server launch, which keeps the structured stream. */
export function setLogSurface(next: LogSurface): void {
  surface = next;
}

/** Whether the operator explicitly asked for the structured stream. An
 *  unrecognized value is NOT "explicit": minLevel already falls back to info
 *  for it, so treating `LOG_LEVEL=chatty` as an opt-in would turn a typo into
 *  a wall of JSON. */
function logLevelRequested(): boolean {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return raw !== undefined && raw in LOG_LEVELS;
}

/** One `key=value` tail for the plain-text CLI rendering. Never throws: `data`
 *  is caller-supplied and can carry a BigInt or a cycle, exactly like the
 *  JSON.stringify below, and a diagnostic must not take down the operation it
 *  is describing. */
function renderData(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return "";
  try {
    const parts = Object.entries(data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  } catch {
    return " (details omitted)";
  }
}

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < minLevel()) return;
  guardStderrErrors();

  // CLI surface, and the operator did not ask for the structured stream.
  // debug/info are the server's own operational telemetry ("Loaded bundles",
  // "yaw-mcp startup") and have no reader here, so they are dropped. warn and
  // error are NOT dropped -- some of them (an invalid YAW_MCP_DEFAULT_RUNTIME,
  // an unreadable trust store) have no other surface at all, and silencing
  // those would trade a formatting complaint for a missing warning. They are
  // re-rendered as the one plain sentence a person can read, prefixed like
  // every other line the CLI writes to stderr.
  if (surface === "cli" && !logLevelRequested()) {
    if (LOG_LEVELS[level] < LOG_LEVELS.warn) return;
    try {
      process.stderr.write(`yaw-mcp: ${level === "warn" ? "warning" : "error"}: ${msg}${renderData(data)}\n`);
    } catch {
      // Same closed-stderr case the structured write below swallows.
    }
    return;
  }

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

// --- writers for a CLI's own stdout / stderr ---------------------------------
//
// WHY THIS EXISTS. `yaw-mcp call` is built for scripts, hooks and pipelines,
// so an early-exiting consumer -- `yaw-mcp call fake med {} | head -1` -- is
// the NORMAL case, not an edge one. When `head` exits it closes the read end,
// and the next write to stdout emits 'error' (EPIPE) on the stream. With no
// listener Node treats that as an unhandled 'error' event and takes the
// process down where it stands, which is mid-await inside the tool call: the
// `finally` in transient-upstream.ts never runs, disconnectFromUpstream is
// SKIPPED, and the spawned upstream is left orphaned. It also exits 1, the
// code `call` documents for "the tool answered with an error", so a script
// branching on $? reads a successful call as a failed one.
//
// WHY NOT JUST try/catch THE WRITE. On a pipe the failure arrives as an EVENT,
// not as a throw -- the write returns normally and the error lands a tick
// later (confirmed against a built binary on win32: the stack said "Emitted
// 'error' event on Socket instance"). A catch around the write covers the
// synchronous shape only, so both are handled here.
//
// WHY IT IS NOT guardStderrErrors ABOVE. That guard defers to a host's own
// 'error' listener and deliberately keeps no latch, because its only job is
// "do not die". This one additionally has to KNOW the stream broke so it can
// stop writing, which means owning a listener rather than relying on someone
// else's -- so it latches per stream, and only ever on a listener it attached
// itself, which is the case the no-latch note up there was warning about.

/** Streams whose consumer has gone. Keyed on the stream rather than held in
 *  the writer's closure so two writers over ONE stream (a command that builds
 *  one for stdout and one for stderr, then is handed the same fd twice by
 *  `2>&1`) share a single verdict instead of each having to learn it. */
const brokenStreams = new WeakSet<NodeJS.WritableStream>();

/** Streams this module has already attached its 'error' listener to. Without
 *  it a second writer over the same stream stacks a second listener, and ten
 *  of those trip Node's MaxListenersExceededWarning on stdout. */
const guardedStreams = new WeakSet<NodeJS.WritableStream>();

/**
 * A `write` for a CLI's own stdout or stderr that treats a dead consumer as
 * "stop writing", not as "die". Returns a plain writer so a caller can keep
 * using it exactly like `(s) => stream.write(s)`.
 *
 * ANY error on the stream marks it broken, not just EPIPE: once a stream has
 * failed there is nowhere for the remaining output to go, and a second write
 * only re-emits the same error. Nothing is reported when that happens --
 * `| head -1` is an ordinary shell idiom, and a diagnostic about it would be
 * noise on every correct use.
 *
 * The caller keeps its own exit code. A consumer leaving early says nothing
 * about whether the tool answered, so the code the command computed stands.
 */
export function createStreamWriter(stream: NodeJS.WritableStream): (s: string) => void {
  if (!guardedStreams.has(stream)) {
    guardedStreams.add(stream);
    try {
      stream.on("error", () => {
        brokenStreams.add(stream);
      });
    } catch {
      // An embedding host may substitute a stdout/stderr stub with no
      // EventEmitter surface. The try/catch on the write below still holds.
    }
  }
  return (s: string): void => {
    if (brokenStreams.has(stream)) return;
    try {
      stream.write(s);
    } catch {
      // The synchronous shape of the same failure.
      brokenStreams.add(stream);
    }
  };
}
