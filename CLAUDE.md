# CLAUDE.md — characterbuilder_api

Hono (Bun) backend. Layer 2 of five. Postgres + Drizzle, Firebase auth,
ShapeShyft image generation, consumable credits. Patterns copied from
`screenwriter_api` (slimmed: no sync/collab/jobs/API-keys).

## Shape
- `src/app.ts` — Hono app, CORS, error envelope (no boot side effects).
- `src/index.ts` — boot: config checks, `initDatabase()`, server export (port 8040).
- `src/lib/` — `env-helper`, `log`, `errors` (HttpError → envelope), `config`, `health`.
- `src/middleware/auth.ts` — firebase-or-dev `UserPrincipal`; `requireAuth` sets `principal`/`userId`.
- `src/db/` — lazy postgres client + drizzle; `initDatabase()` is idempotent raw SQL; `schema.ts` mirrors it.
- `src/services/` — `users` (ensureUser), `credits` (consumables_service helper), `storage`
  (memory|local driver), `shapeshyft` (image transport), `characters` (CRUD), `generation` (the flow).
- `src/routes/` — `me`, `characters`, `generation` (compose/generate/generations/images), `consumables`.

## Rules
- All request/response shapes come from `@sudobility/characterbuilder_types`. Never
  hand-roll a DTO here. Routes validate with `validate(target, schema)` (routes/util.ts).
- Services throw `HttpError(code, msg)`; `app.onError` maps code → HTTP status.
- `/generate` gates credits BEFORE rendering, renders all N images (a failure charges
  nothing), persists, then `spend()` debits. Idempotency via `idempotencyKey`.
- Credits go through `services/credits.ts` only (the single `ConsumablesHelper`).
- The prompt is composed with `composePrompt` from types (same text as the frontend).
- Keep `schema.ts` and the `initDatabase()` DDL in lockstep.

## Dev
`AUTH_TEST_MODE=1` + `Bearer dev:<uid>:<email>` to skip Firebase. `STORAGE_DRIVER=memory`
and `SKIP_DB_INIT`/no-DB only for the non-DB routes (health, compose, products).
Typecheck: `bun run typecheck`. The `@sudobility/characterbuilder_types` dep is a
`file:` link resolved to local `src` by tsconfig `paths`.
