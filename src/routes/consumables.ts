import { Hono } from 'hono';
import { successResponse } from '@sudobility/characterbuilder_types';
import {
  consumables,
  creditProducts,
  creditsForProduct,
  getBalance,
  grantDevCredits,
} from '../services/credits';
import { getEnv } from '../lib/env-helper';
import { log } from '../lib/log';

/** Authenticated: the signed-in user's balance. */
const router = new Hono();
router.get('/balance', async (c) =>
  c.json(successResponse(await getBalance(c.get('userId'))))
);

/**
 * Dev-only top-up: grant credits to the signed-in user. Gated on AUTH_TEST_MODE
 * so it is inert in production. Body: `{ credits?: number }` (clamped 1..1000,
 * default 100). No purchase, no payment — local testing only.
 */
router.post('/dev-topup', async (c) => {
  // Dev convenience only: on by default locally, OFF in production.
  if (getEnv('NODE_ENV') === 'production' && getEnv('AUTH_TEST_MODE') !== '1') {
    return c.text('Dev top-up is disabled in production', 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { credits?: number };
  const credits = Math.min(Math.max(Math.round(body.credits ?? 100), 1), 1000);
  return c.json(successResponse(await grantDevCredits(c.get('userId'), credits)));
});
export default router;

/** Public: the priced catalog. */
export const consumablesPublic = new Hono();
consumablesPublic.get('/products', (c) =>
  c.json(successResponse(creditProducts()))
);

/**
 * RevenueCat webhook: grants credits for a verified purchase, idempotent on the
 * transaction id. Protected by a shared bearer secret (REVENUECAT_WEBHOOK_AUTH).
 */
export const consumablesWebhook = new Hono();
consumablesWebhook.post('/webhook', async (c) => {
  const expected = getEnv('REVENUECAT_WEBHOOK_AUTH');
  if (expected) {
    const got = c.req.header('authorization');
    if (got !== `Bearer ${expected}`) return c.text('Unauthorized', 401);
  }
  const body = (await c.req.json().catch(() => null)) as {
    event?: {
      app_user_id?: string;
      product_id?: string;
      transaction_id?: string;
      store?: string;
      price_in_purchased_currency?: number;
      currency?: string;
    };
  } | null;
  const e = body?.event;
  if (!e?.app_user_id || !e.product_id || !e.transaction_id) {
    return c.text('Bad Request', 400);
  }
  const credits = creditsForProduct(e.product_id);
  if (!credits) {
    log('warn', 'webhook for unknown product', { product: e.product_id });
    return c.json({ ok: true, ignored: true });
  }
  const store = (e.store ?? '').toLowerCase();
  const source = store.includes('app_store')
    ? 'apple'
    : store.includes('play_store')
      ? 'google'
      : 'web';
  const result = await consumables().recordPurchaseFromWebhook(
    e.app_user_id,
    e.transaction_id,
    credits,
    source,
    e.product_id,
    Math.round((e.price_in_purchased_currency ?? 0) * 100),
    e.currency ?? 'USD'
  );
  return c.json({ ok: true, balance: result.balance });
});
