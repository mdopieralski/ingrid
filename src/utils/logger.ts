export type LogFields = Record<string, unknown>;
export type LogFn = (fields: LogFields) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

type Level = keyof Logger;

// One JSON object per line. `write` is swappable so tests can capture output.
export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const at =
    (level: Level): LogFn =>
    (fields) =>
      write(JSON.stringify({ time: new Date().toISOString(), level, ...fields }));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}
