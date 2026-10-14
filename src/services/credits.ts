/**
 * Credits: the one place characterbuilder_api talks to
 * `@sudobility/consumables_service`. Called in-process (the screenwriter_api /
 * music_api pattern). One credit is charged per generated image.
 */
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
