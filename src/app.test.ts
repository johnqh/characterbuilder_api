import { describe, it, expect } from 'vitest';
import { app } from './app';

const call = async (req: Request) => {
  const res = await app.fetch(req);
  const body = await res.json().catch(() => null);
  return { status: res.status, body } as {
    status: number;
    body: Record<string, unknown> | null;
  };
};

describe('characterbuilder_api app', () => {
  it('serves health without a database', async () => {
    const r = await call(new Request('http://t/health'));
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it('exposes the public consumables catalog', async () => {
    process.env.CREDIT_PRODUCTS = 'cb_credits_100:100';
    const r = await call(new Request('http://t/api/v1/consumables/products'));
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { data?: unknown }).data)).toBe(true);
  });

  it('requires auth for /me', async () => {
    const r = await call(new Request('http://t/api/v1/me'));
    expect(r.status).toBe(401);
    expect(r.body?.code).toBe('UNAUTHORIZED');
  });

  it('validates /generate before touching the database (dev auth)', async () => {
    process.env.AUTH_TEST_MODE = '1';
    const r = await call(
      new Request('http://t/api/v1/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev:u1:a@b.co',
        },
        // Schema-invalid (count is 1..10) — rejected by the validator before any
        // DB access. (characterId + spec together is now valid: it associates.)
        body: JSON.stringify({ params: { count: 99 } }),
      })
    );
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('VALIDATION');
  });

  it('returns trait distributions for demographics without a database', async () => {
    process.env.AUTH_TEST_MODE = '1';
    const r = await call(
      new Request('http://t/api/v1/distributions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev:u1:a@b.co',
        },
        body: JSON.stringify({ ancestry: 'east-asian', sex: 'female' }),
      })
    );
    expect(r.status).toBe(200);
    const data = (r.body as { data?: { distributions?: Record<string, unknown> } })
      .data;
    expect(data?.distributions?.hairTexture).toBeTruthy();
  });
});
