import { and, desc, eq, lt } from 'drizzle-orm';
import {
  composePrompt,
  generationParamsSchema,
  makeId,
  type ComposeRequest,
  type Generation,
  type GeneratedImage,
  type GenerateRequest,
  type GenerationParams,
  type FaceSpec,
  type Paginated,
} from '@sudobility/characterbuilder_types';
import { getDb, generations, generationImages } from '../db';
import { HttpError } from '../lib/errors';
import { getBalance, spend } from './credits';
import { getStorage, imageUrl } from './storage';
import { generateImage } from './shapeshyft';
import { getCharacter } from './characters';

/** Resolve the FaceSpec from either a saved character or the inline spec. */
async function resolveSpec(
  userId: string,
  req: { characterId?: string; spec?: FaceSpec }
): Promise<{ spec: FaceSpec; characterId: string | null }> {
  if (req.characterId) {
    const character = await getCharacter(userId, req.characterId);
    return { spec: character.spec, characterId: character.id };
  }
  return { spec: req.spec ?? {}, characterId: null };
}

export async function compose(
  userId: string,
  req: ComposeRequest
): Promise<string> {
  const { spec } = await resolveSpec(userId, req);
  const params = generationParamsSchema.partial().parse(req.params ?? {});
  return composePrompt(spec, params);
}

const imageKey = (userId: string, generationId: string, imageId: string) =>
  `images/${userId}/${generationId}/${imageId}.png`;

function toGeneratedImage(row: typeof generationImages.$inferSelect): GeneratedImage {
  return {
    id: row.id,
    mimeType: row.mimeType,
    url: imageUrl(row.id),
    width: row.width,
    height: row.height,
  };
}

/** The whole generate flow: credits gate -> render N -> store -> persist -> charge. */
export async function generate(
  userId: string,
  req: GenerateRequest
): Promise<Generation> {
  const params: GenerationParams = generationParamsSchema.parse(req.params);
  const cost = params.count;

  // Idempotent replay: a retried request with the same key returns the first result.
  if (req.idempotencyKey) {
    const [existing] = await getDb()
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.userId, userId),
          eq(generations.idempotencyKey, req.idempotencyKey)
        )
      );
    if (existing) return await loadGeneration(userId, existing.id);
  }

  const { spec, characterId } = await resolveSpec(userId, req);
  const prompt = composePrompt(spec, params);

  const balance = await getBalance(userId);
  if (balance.balance < cost) {
    throw new HttpError('INSUFFICIENT_CREDITS', 'Not enough credits', {
      required: cost,
      balance: balance.balance,
    });
  }

  // Render all images first; a failure here charges nothing and persists nothing.
  const rendered: { bytes: Uint8Array; mimeType: string }[] = [];
  for (let i = 0; i < cost; i++) {
    rendered.push(await generateImage(prompt, req.referenceImage));
  }

  const generationId = makeId('generation', crypto.randomUUID().replace(/-/g, ''));
  const storage = getStorage();
  const imageRows: (typeof generationImages.$inferInsert)[] = [];
  for (const r of rendered) {
    const imageId = makeId('image', crypto.randomUUID().replace(/-/g, ''));
    const key = imageKey(userId, generationId, imageId);
    await storage.put(key, r.bytes, r.mimeType);
    imageRows.push({
      id: imageId,
      generationId,
      userId,
      storageKey: key,
      mimeType: r.mimeType,
      width: null,
      height: null,
    });
  }

  await getDb().insert(generations).values({
    id: generationId,
    userId,
    characterId,
    prompt,
    params,
    status: 'succeeded',
    creditsSpent: cost,
    error: null,
    idempotencyKey: req.idempotencyKey ?? null,
  });
  await getDb().insert(generationImages).values(imageRows);
  await spend(userId, cost, `gen:${generationId}`);

  return await loadGeneration(userId, generationId);
}

export async function loadGeneration(
  userId: string,
  id: string
): Promise<Generation> {
  const [gen] = await getDb()
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.userId, userId)));
  if (!gen) throw new HttpError('GENERATION_NOT_FOUND', 'Generation not found');
  const imgs = await getDb()
    .select()
    .from(generationImages)
    .where(eq(generationImages.generationId, id));
  return {
    id: gen.id,
    characterId: gen.characterId,
    prompt: gen.prompt,
    params: gen.params,
    status: gen.status as Generation['status'],
    images: imgs.map(toGeneratedImage),
    creditsSpent: gen.creditsSpent,
    error: gen.error,
    createdAt: gen.createdAt.toISOString(),
  };
}

export async function listGenerations(
  userId: string,
  limit: number,
  cursor?: string
): Promise<Paginated<Generation>> {
  const after = cursor
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : null;
  const where = after
    ? and(eq(generations.userId, userId), lt(generations.id, after))
    : eq(generations.userId, userId);
  const rows = await getDb()
    .select()
    .from(generations)
    .where(where)
    .orderBy(desc(generations.createdAt), desc(generations.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit
      ? Buffer.from(page[page.length - 1]!.id).toString('base64url')
      : null;
  const items = await Promise.all(
    page.map((r) => loadGeneration(userId, r.id))
  );
  return { items, nextCursor };
}

/** Serve raw bytes for an image id the user owns. */
export async function getImageBytes(
  userId: string,
  imageId: string
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const [row] = await getDb()
    .select()
    .from(generationImages)
    .where(
      and(eq(generationImages.id, imageId), eq(generationImages.userId, userId))
    );
  if (!row) throw new HttpError('IMAGE_NOT_FOUND', 'Image not found');
  const bytes = await getStorage().get(row.storageKey);
  if (!bytes) throw new HttpError('IMAGE_NOT_FOUND', 'Image bytes not found');
  return { bytes, mimeType: row.mimeType };
}
