import { eq } from 'drizzle-orm';
import type { MeResponse } from '@sudobility/characterbuilder_types';
import { getDb, users } from '../db';
import type { Principal } from '../middleware/auth';
import { getBalance } from './credits';

/** Upsert the user row on first contact, then return the `/me` payload. */
export async function ensureUser(p: Principal): Promise<MeResponse> {
  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.id, p.userId));
  if (!existing) {
    await db
      .insert(users)
      .values({
        id: p.userId,
        email: p.email,
        emailVerified: p.emailVerified,
      })
      .onConflictDoNothing({ target: users.id });
  } else if (
    existing.email !== p.email ||
    existing.emailVerified !== p.emailVerified
  ) {
    await db
      .update(users)
      .set({ email: p.email, emailVerified: p.emailVerified, updatedAt: new Date() })
      .where(eq(users.id, p.userId));
  }
  const [row] = await db.select().from(users).where(eq(users.id, p.userId));
  const balance = await getBalance(p.userId);
  return {
    userId: p.userId,
    email: row?.email ?? p.email,
    displayName: row?.displayName ?? null,
    credits: balance.balance,
    createdAt: (row?.createdAt ?? new Date()).toISOString(),
  };
}
