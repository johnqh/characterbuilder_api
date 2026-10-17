import { Hono } from 'hono';
import {
  createCharacterRequestSchema,
  cursorQuerySchema,
  successResponse,
  updateCharacterRequestSchema,
} from '@sudobility/characterbuilder_types';
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
} from '../services/characters';
import { ensureUser } from '../services/users';
import { validate } from './util';

const router = new Hono();

router.get('/', validate('query', cursorQuerySchema), async (c) => {
  const { limit, cursor } = c.req.valid('query');
  return c.json(
    successResponse(await listCharacters(c.get('userId'), limit, cursor))
  );
});

router.post('/', validate('json', createCharacterRequestSchema), async (c) => {
  // characters.user_id FKs to users(id); onboard a signed-in user who creates
  // a character before ever calling GET /me.
  await ensureUser(c.get('principal'));
  return c.json(
    successResponse(await createCharacter(c.get('userId'), c.req.valid('json'))),
    201
  );
});

router.get('/:id', async (c) =>
  c.json(successResponse(await getCharacter(c.get('userId'), c.req.param('id'))))
);

router.patch(
  '/:id',
  validate('json', updateCharacterRequestSchema),
  async (c) =>
    c.json(
      successResponse(
        await updateCharacter(
          c.get('userId'),
          c.req.param('id'),
          c.req.valid('json')
        )
      )
    )
);

router.delete('/:id', async (c) => {
  await deleteCharacter(c.get('userId'), c.req.param('id'));
  return c.json(successResponse({ deleted: true }));
});

export default router;
