# characterbuilder_api

CharacterBuilder backend: a Hono (Bun) REST API that stores FaceSpec
**Characters**, composes prompts, and generates character images through
**ShapeShyft**, metering each image against **consumable credits**. Postgres +
Drizzle for persistence, Firebase for auth. Modeled on `screenwriter_api`.

## Endpoints (`/api/v1`)
- `GET  /me` — profile + credit balance (upserts the user row).
- `GET/POST /characters`, `GET/PATCH/DELETE /characters/:id` — FaceSpec CRUD (cursor-paginated).
- `POST /compose` — the prompt a spec+params would produce (charges nothing).
- `POST /generate` — gate credits → render N images via ShapeShyft → store → persist → debit.
- `GET  /generations`, `GET /generations/:id` — history.
- `GET  /images/:id` — served image bytes (owner only).
- `GET  /consumables/products` (public), `GET /consumables/balance`, `POST /consumables/webhook` (RevenueCat).

## Run
```bash
bun install
cp .env.example .env.local   # set DATABASE_URL, FIREBASE_*, SHAPESHYFT_*
bun run db:init              # apply schema (also runs on boot unless SKIP_DB_INIT=1)
bun run dev                  # http://localhost:8040
bun run typecheck
```
For local dev without Firebase set `AUTH_TEST_MODE=1` and send `Authorization: Bearer dev:<uid>:<email>`.

## Layers
`@sudobility/characterbuilder_types` (schemas/prompt composer) → **this api** →
`characterbuilder_client` → `characterbuilder_lib` → `characterbuilder_app`.
Image generation, auth, and credits reuse `shapeshyft`, `@sudobility/auth_service`
and `@sudobility/consumables_service` exactly as screenwriter_api does.
