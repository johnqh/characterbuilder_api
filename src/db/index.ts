/**
 * Database access: lazy postgres.js client + Drizzle. `initDatabase()` runs
 * idempotent raw SQL (CREATE ... IF NOT EXISTS, forward-only). schema.ts mirrors it.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getEnv, getRequiredEnv } from '../lib/env-helper';

export * from './schema';

let _client: ReturnType<typeof postgres> | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

export function getClient() {
  if (!_client) {
    _client = postgres(getRequiredEnv('DATABASE_URL'), {
      max: parseInt(getEnv('DATABASE_POOL_MAX', '20')!, 10),
      onnotice: () => {},
    });
  }
  return _client;
}

export function getDb() {
  if (!_db) _db = drizzle(getClient(), { schema });
  return _db;
}

export async function closeDatabase(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export async function initDatabase(): Promise<void> {
  const sql = getClient();

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`;

  await sql`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT,
      notes TEXT,
      spec JSONB NOT NULL DEFAULT '{}',
      preview_image_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS characters_user_idx ON characters (user_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      params JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credits_spent INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS generations_user_idx ON generations (user_id, created_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS generations_idempotency_key
      ON generations (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS generation_images (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      width INTEGER,
      height INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS generation_images_gen_idx ON generation_images (generation_id)`;

  // Jobs migration (forward-only): generations became async job rows. Each job
  // carries a base spec + demographics the caster fills per image, reserves
  // credits while running, and records a finish time.
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS spec JSONB`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS demographics JSONB`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS reserved_credits INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE generations ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`;
  await sql`ALTER TABLE generations ALTER COLUMN prompt DROP NOT NULL`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS spec JSONB`;
  await sql`ALTER TABLE generation_images ADD COLUMN IF NOT EXISTS prompt TEXT`;
  // At most one running job per user — the real concurrency guarantee (an
  // app-level check races under READ COMMITTED). A losing promotion is a no-op.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS generations_one_running_per_user
      ON generations (user_id) WHERE status = 'running'`;

  // consumables ledger (consumables_service shape)
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_balances (
      user_id VARCHAR(128) PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      initial_credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_purchases (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      credits INTEGER NOT NULL,
      source VARCHAR(20) NOT NULL,
      transaction_ref_id VARCHAR(255),
      product_id VARCHAR(255),
      price_cents INTEGER,
      currency VARCHAR(10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS consumable_usages (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(128) NOT NULL,
      credits INTEGER NOT NULL DEFAULT 1,
      reference VARCHAR(500),
      filename VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS consumable_purchases_transaction_ref
      ON consumable_purchases (transaction_ref_id) WHERE transaction_ref_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS consumable_usages_user ON consumable_usages (user_id, created_at DESC)`;
}
