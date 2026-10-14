import { getEnv } from './env-helper';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {}
) {
  const min = LEVELS[(getEnv('LOG_LEVEL', 'info') as Level)] ?? LEVELS.info;
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
