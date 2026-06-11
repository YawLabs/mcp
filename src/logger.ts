const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const minLevel: number = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase() as LogLevel] ?? LOG_LEVELS.info;

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < minLevel) return;
  // Spread data FIRST so a data key named level/msg/ts can never clobber
  // the envelope fields parsers key on.
  const entry = JSON.stringify({ ...data, level, msg, ts: new Date().toISOString() });
  process.stderr.write(`${entry}\n`);
}
