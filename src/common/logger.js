const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (level, msg, fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...fields };
    if (fields.error instanceof Error) entry.stack = fields.error.stack;
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
