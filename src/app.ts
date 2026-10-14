/** The Hono app (no side effects at import). Boot lives in index.ts. */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { errorResponse, successResponse } from '@sudobility/characterbuilder_types';
import { getEnv, getEnvList } from './lib/env-helper';
import { log } from './lib/log';
import { HttpError } from './lib/errors';
import { healthData } from './lib/health';
import { requestId, requestLogger } from './middleware/request';
import routes from './routes';

export function allowedOrigins(): string[] {
  const list = getEnvList('CORS_ORIGINS');
  if (list.length > 0) return list;
  const pub = getEnv('PUBLIC_APP_URL');
  return pub ? [pub.replace(/\/+$/, '')] : [];
}

export function corsOrigin(origin: string): string | null {
  const allowed = allowedOrigins();
  if (allowed.includes('*')) return origin || '*';
  return allowed.includes(origin) ? origin : null;
}

export const app = new Hono();

app.use('*', requestId);
app.use('*', requestLogger);
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: corsOrigin,
    allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Client'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
  })
);

app.get('/', (c) => c.json(successResponse(healthData())));
app.get('/health', (c) => c.json(successResponse(healthData())));
app.get('/health/ready', (c) => c.json(successResponse(healthData())));
app.route('/api/v1', routes);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
    return c.json(
      errorResponse(err.message, err.code, err.details),
      err.status as 400
    );
  }
  log('error', 'unhandled error', {
    requestId: c.get('requestId'),
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json(errorResponse('Internal server error', 'INTERNAL'), 500);
});

app.notFound((c) => c.json(errorResponse('Not found', 'NOT_FOUND'), 404));
