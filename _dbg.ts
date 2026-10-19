import { getDb, users, generations, initDatabase, closeDatabase } from './src/db';
import { getBalance } from './src/services/credits';
import { setRenderImage } from './src/services/jobs';
import { generate, loadGeneration } from './src/services/generation';
import { eq } from 'drizzle-orm';

setRenderImage(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' }));
await initDatabase();
const uid = 'dbg-' + Date.now();
await getDb().insert(users).values({ id: uid, email: uid + '@x.test' });
console.log('balance0:', (await getBalance(uid)).balance);
const g = await generate(uid, { spec: {}, params: { count: 1, size: 'portrait', shot: 'headshot', expression: 'neutral' } });
console.log('enqueued:', g.id, 'status:', g.status);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const [row] = await getDb().select().from(generations).where(eq(generations.id, g.id));
  console.log(i, 'status:', row?.status, 'reserved:', row?.reservedCredits, 'spent:', row?.creditsSpent, 'err:', row?.error);
  if (row?.status === 'succeeded' || row?.status === 'failed') break;
}
await closeDatabase();
console.log('DONE');
