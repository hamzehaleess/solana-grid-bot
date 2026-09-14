type Level = 'info' | 'warn' | 'error';

const write = (level: Level, message: string, meta?: Record<string, unknown>): void => {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const label = level.toUpperCase().padEnd(5);
  const suffix = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} ${label} ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else console.log(line);
};

export const log = {
  info: (message: string, meta?: Record<string, unknown>): void => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => write('error', message, meta),
};
