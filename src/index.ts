/** CharacterBuilder API entry point: boot checks, DB init, server export. */
import { app } from './app';
import { bootProblems, isFirebaseConfigured } from './lib/config';
import { getEnv } from './lib/env-helper';
import { log } from './lib/log';
import { initDatabase, closeDatabase } from './db';
import { shapeShyftConfigured } from './lib/env-helper';
import { recoverOrphanedJobs } from './services/jobs';

const problems = bootProblems();
if (problems.length > 0) {
  for (const p of problems) log('error', `boot refused: ${p}`);
  process.exit(1);
}

if (!isFirebaseConfigured()) {
  log(
    'error',
    'FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY not all set: every Firebase-authenticated request will return 401 (use AUTH_TEST_MODE=1 for dev tokens)'
  );
}
if (!shapeShyftConfigured()) {
  log(
    'warn',
    'SHAPESHYFT_ENDPOINT_URL / SHAPESHYFT_API_KEY not set: /generate answers AI_UNAVAILABLE'
  );
}

if (getEnv('SKIP_DB_INIT', '0') !== '1') {
  try {
    await initDatabase();
  } catch (err) {
    log('error', 'failed to initialise database', { error: String(err) });
    process.exit(1);
  }
  // Fail jobs orphaned by a previous crash and resume any stranded queue.
  try {
    await recoverOrphanedJobs();
  } catch (err) {
    log('error', 'job recovery failed', { error: String(err) });
  }
}

const port = parseInt(getEnv('PORT', '8039')!, 10);
log('info', `characterbuilder_api listening on :${port}`);

process.on('SIGTERM', async () => {
  await closeDatabase();
  process.exit(0);
});

export default {
  port,
  fetch: app.fetch,
};
