/**
 * Credits: the one place characterbuilder_api talks to
 * `@sudobility/consumables_service`. Called in-process (the screenwriter_api /
 * music_api pattern). One credit is charged per generated image.
 */
import { sql } from 'drizzle-orm';
import {
  ConsumablesHelper,
  parseCreditProducts,
  creditsForProduct as findConfiguredCredits,
} from '@sudobility/consumables_service';
import {
  consumableBalances,
  consumablePurchases,
  consumableUsages,
  getDb,
} from '../db';
import { getEnv } from '../lib/env-helper';

export function initialFreeCredits(): number {
  return parseInt(getEnv('INITIAL_FREE_CREDITS', '20')!, 10);
}

let helper: ConsumablesHelper | null = null;

export function consumables(): ConsumablesHelper {
  if (!helper) {
    helper = new ConsumablesHelper(
      getDb() as never,
      { consumableBalances, consumablePurchases, consumableUsages } as never,
      { initialFreeCredits: initialFreeCredits() }
    );
  }
  return helper;
}

/** Current balance; grants the signup credits on first access. */
export function getBalance(userId: string) {
  return consumables().getBalance(userId);
}

/** Debit `credits` for a generation; returns whether the deduction applied. */
export function spend(userId: string, credits: number, reference: string) {
  return consumables().recordUsage(userId, { credits, reference });
}

/**
 * Reserve `credits` up front for a job — an ATOMIC debit guarded by
 * `balance >= credits` (the shared helper's `recordUsage` only guards
 * `balance > 0`, which would silently go negative for a multi-credit batch).
 * Returns `{ success, balance }`; `success: false` (balance left untouched) means
 * the caller should fail the job with 402. Writes a usage row for the audit trail.
 */
export async function reserveCredits(
  userId: string,
  credits: number,
  reference: string
): Promise<{ success: boolean; balance: number }> {
  if (credits <= 0) {
    return { success: true, balance: (await getBalance(userId)).balance };
  }
  // Ensure the balance row exists and the signup credits are granted.
  await getBalance(userId);
  const rows = await getDb()
    .update(consumableBalances)
    .set({
      balance: sql`${consumableBalances.balance} - ${credits}`,
      updated_at: new Date(),
    })
    .where(
      sql`${consumableBalances.user_id} = ${userId} AND ${consumableBalances.balance} >= ${credits}`
    )
    .returning({ balance: consumableBalances.balance });
  if (rows.length === 0) {
    return { success: false, balance: (await getBalance(userId)).balance };
  }
  await getDb()
    .insert(consumableUsages)
    .values({ user_id: userId, credits, reference });
  return { success: true, balance: rows[0]!.balance };
}

/**
 * Release `credits` previously reserved but not spent (a compensating credit) —
 * on a partial batch or a failed/cancelled job. `source: 'free'` since this is
 * not a purchase; `product_id` ties it to the generation for the audit trail.
 */
export async function releaseCredits(
  userId: string,
  credits: number,
  reference: string
): Promise<void> {
  if (credits <= 0) return;
  await consumables().recordPurchase(userId, {
    credits,
    source: 'free',
    product_id: reference,
  });
}

/**
 * Dev-only grant: add `credits` to a user's balance (source `free`), for local
 * testing without a real purchase. The route gates this on AUTH_TEST_MODE.
 */
export async function grantDevCredits(userId: string, credits: number) {
  await consumables().recordPurchase(userId, {
    credits,
    source: 'free',
    product_id: 'dev_topup',
  });
  return getBalance(userId);
}

/** The priced catalog: `CREDIT_PRODUCTS=cb_credits_100:100,cb_credits_500:500`. */
export function creditProducts(): { productId: string; credits: number }[] {
  return parseCreditProducts(getEnv('CREDIT_PRODUCTS', ''));
}

export function creditsForProduct(productId: string): number | null {
  return findConfiguredCredits(productId, creditProducts());
}

/** Test hook: drop the cached helper so a changed environment is picked up. */
export function resetConsumables(): void {
  helper = null;
}
