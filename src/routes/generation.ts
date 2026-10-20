import { Hono } from 'hono';
import {
  composeRequestSchema,
  cursorQuerySchema,
  distributionRequestSchema,
  generateRequestSchema,
  sheetRequestSchema,
  successResponse,
  type ComposeResponse,
} from '@sudobility/characterbuilder_types';
import {
  compose,
  createSheet,
  generate,
  getImageBytes,
  listGenerations,
  loadGeneration,
} from '../services/generation';
import { getDistributions } from '../services/distribution';
import { ensureUser } from '../services/users';
import { validate } from './util';

const router = new Hono();

router.post('/compose', validate('json', composeRequestSchema), async (c) => {
  const prompt = await compose(c.get('userId'), c.req.valid('json'));
  return c.json(successResponse<ComposeResponse>({ prompt }));
});

// Demographics -> per-trait probability maps (odds the UI can show; the generate
// flow samples these to cast unset traits). Pure compute, no DB.
router.post(
  '/distributions',
  validate('json', distributionRequestSchema),
  async (c) => c.json(successResponse(await getDistributions(c.req.valid('json'))))
);

router.post('/generate', validate('json', generateRequestSchema), async (c) => {
  // Persisting a generation FKs to users(id); ensure the row exists for a
  // signed-in user who generates before ever calling GET /me.
  await ensureUser(c.get('principal'));
  return c.json(successResponse(await generate(c.get('userId'), c.req.valid('json'))));
});

// Staged sheet generation (head / body / clothed). Must be registered before
// any `/generate/:x` param routes (there are none) — a literal path, so order
// is not load-bearing, but keep it next to /generate for clarity.
router.post('/generate/sheet', validate('json', sheetRequestSchema), async (c) => {
  await ensureUser(c.get('principal'));
  return c.json(successResponse(await createSheet(c.get('userId'), c.req.valid('json'))));
});

router.get('/generations', validate('query', cursorQuerySchema), async (c) => {
  const { limit, cursor } = c.req.valid('query');
  return c.json(
    successResponse(await listGenerations(c.get('userId'), limit, cursor))
  );
});

router.get('/generations/:id', async (c) =>
  c.json(
    successResponse(await loadGeneration(c.get('userId'), c.req.param('id')))
  )
);

router.get('/images/:id', async (c) => {
  const { bytes, mimeType } = await getImageBytes(
    c.get('userId'),
    c.req.param('id')
  );
  return new Response(bytes, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

export default router;
