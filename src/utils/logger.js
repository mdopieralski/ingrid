// One JSON object per line. `write` is swappable so tests can capture output.
export function createLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  const at = (level) => (fields) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, ...fields }));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}
