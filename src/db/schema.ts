/**
 * Drizzle schema — mirrors the raw DDL in `initDatabase()` (index.ts). The
 * consumable ledger tables are `@sudobility/consumables_service`'s own shape,
 * copied verbatim (the music_api / screenwriter_api pattern).
 */
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  serial,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  Demographics,
  FaceSpec,
  GenerationParams,
} from '@sudobility/characterbuilder_types';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const characters = pgTable('characters', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  notes: text('notes'),
  spec: jsonb('spec').$type<FaceSpec>().notNull().default({}),
  previewImageId: text('preview_image_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const generations = pgTable('generations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  characterId: text('character_id'),
  // The job's inputs: a base (partial) spec the caster fills per image, plus the
  // demographics that steer that casting. `prompt` holds the first image's prompt
  // (kept for history; each image records its own prompt on generation_images).
  spec: jsonb('spec').$type<FaceSpec>(),
  demographics: jsonb('demographics').$type<Demographics>(),
  prompt: text('prompt'),
  params: jsonb('params').$type<GenerationParams>().notNull(),
  status: text('status').notNull().default('pending'),
  creditsSpent: integer('credits_spent').notNull().default(0),
  reservedCredits: integer('reserved_credits').notNull().default(0),
  error: text('error'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const generationImages = pgTable('generation_images', {
  id: text('id').primaryKey(),
  generationId: text('generation_id').notNull(),
  userId: text('user_id').notNull(),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull().default('image/png'),
  // The fully-cast spec and composed prompt that produced THIS image.
  spec: jsonb('spec').$type<FaceSpec>(),
  prompt: text('prompt'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ── consumables ledger (consumables_service shape) ── */

export const consumableBalances = pgTable('consumable_balances', {
  user_id: varchar('user_id', { length: 128 }).primaryKey(),
  balance: integer('balance').notNull().default(0),
  initial_credits: integer('initial_credits').notNull().default(0),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

export const consumablePurchases = pgTable('consumable_purchases', {
  id: serial('id').primaryKey(),
  user_id: varchar('user_id', { length: 128 }).notNull(),
  credits: integer('credits').notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  transaction_ref_id: varchar('transaction_ref_id', { length: 255 }),
  product_id: varchar('product_id', { length: 255 }),
  price_cents: integer('price_cents'),
  currency: varchar('currency', { length: 10 }),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

export const consumableUsages = pgTable('consumable_usages', {
  id: serial('id').primaryKey(),
  user_id: varchar('user_id', { length: 128 }).notNull(),
  credits: integer('credits').notNull().default(1),
  reference: varchar('reference', { length: 500 }),
  filename: varchar('filename', { length: 500 }),
  created_at: timestamp('created_at').defaultNow().notNull(),
});
