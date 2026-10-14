/** `bun run db:init` — apply the schema without starting the server. */
import { initDatabase, closeDatabase } from './index';
import { log } from '../lib/log';

try {
  await initDatabase();
  log('info', 'database initialised');
} catch (err) {
  log('error', 'database init failed', { error: String(err) });
  process.exit(1);
} finally {
  await closeDatabase();
}
