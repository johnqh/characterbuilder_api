import { Hono } from 'hono';
import {
  composeRequestSchema,
  cursorQuerySchema,
  generateRequestSchema,
  successResponse,
  type ComposeResponse,
} from '@sudobility/characterbuilder_types';
import {
  compose,
  generate,
  getImageBytes,
  listGenerations,
  loadGeneration,
} from '../services/generation';
import { validate } from './util';

const router = new Hono();

router.post('/compose', validate('json', composeRequestSchema), async (c) => {
  const prompt = await compose(c.get('userId'), c.req.valid('json'));
  return c.json(successResponse<ComposeResponse>({ prompt }));
});

router.post('/generate', validate('json', generateRequestSchema), async (c) =>
  c.json(successResponse(await generate(c.get('userId'), c.req.valid('json'))))
);

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
