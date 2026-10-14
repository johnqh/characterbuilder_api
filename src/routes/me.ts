import { Hono } from 'hono';
import { successResponse } from '@sudobility/characterbuilder_types';
import { ensureUser } from '../services/users';

const me = new Hono();

me.get('/', async (c) =>
  c.json(successResponse(await ensureUser(c.get('principal'))))
);

export default me;
