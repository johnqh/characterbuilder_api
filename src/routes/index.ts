import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import me from './me';
import characters from './characters';
import generation from './generation';
import consumablesBalance, {
  consumablesPublic,
  consumablesWebhook,
} from './consumables';

const routes = new Hono();

// Guard the authenticated prefixes (registered before the routers they protect).
routes.use('/me', requireAuth);
routes.use('/me/*', requireAuth);
routes.use('/characters', requireAuth);
routes.use('/characters/*', requireAuth);
routes.use('/compose', requireAuth);
routes.use('/generate', requireAuth);
routes.use('/generations', requireAuth);
routes.use('/generations/*', requireAuth);
routes.use('/images/*', requireAuth);
routes.use('/consumables/balance', requireAuth);

// Public: product catalog + RevenueCat webhook (no auth).
routes.route('/consumables', consumablesPublic);
routes.route('/consumables', consumablesWebhook);

// Authenticated.
routes.route('/consumables', consumablesBalance);
routes.route('/me', me);
routes.route('/characters', characters);
routes.route('/', generation);

export default routes;
