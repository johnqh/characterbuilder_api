import type { Context, Next } from 'hono';
import { log } from '../lib/log';

export async function requestId(c: Context, next: Next) {
  const id = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
}

export async function requestLogger(c: Context, next: Next) {
  const started = Date.now();
  await next();
  log('info', 'request', {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - started,
  });
}
