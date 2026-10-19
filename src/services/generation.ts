import { and, desc, eq, lt } from 'drizzle-orm';
import {
  composePrompt,
  generationParamsSchema,
  type ComposeRequest,
  type Generation,
  type GeneratedImage,
  type GenerateRequest,
  type FaceSpec,
  type Paginated,
} from '@sudobility/characterbuilder_types';
import { getDb, generations, generationImages } from '../db';
import { HttpError } from '../lib/errors';
import { getStorage, imageUrl } from './storage';
import { getCharacter } from './characters';
import { enqueueGeneration } from './jobs';

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

function toGeneratedImage(row: typeof generationImages.$inferSelect): GeneratedImage {
  return {
    id: row.id,
    mimeType: row.mimeType,
    url: imageUrl(row.id),
    width: row.width,
    height: row.height,
    spec: row.spec ?? undefined,
    prompt: row.prompt ?? undefined,
  };
}

/**
 * Enqueue an async generation job and return it in its initial `pending` state.
 * The job reserves credits up front, then a background runner casts a fresh spec
 * per image, renders, stores, and settles. Clients poll GET /generations/:id.
 */
export async function generate(
  userId: string,
  req: GenerateRequest
): Promise<Generation> {
  // Idempotent replay: a retried request with the same key returns the first job.
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

  const id = await enqueueGeneration(userId, req);
  return await loadGeneration(userId, id);
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
    prompt: gen.prompt ?? '',
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
