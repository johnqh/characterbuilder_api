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
  type SheetRequest,
} from '@sudobility/characterbuilder_types';
import { getDb, generations, generationImages } from '../db';
import { HttpError } from '../lib/errors';
import { getStorage, imageUrl } from './storage';
import { getCharacter } from './characters';
import { enqueueGeneration, enqueueSheet } from './jobs';

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
    role: row.role ?? undefined,
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

/** Resolve a stored image the user owns into a `data:` reference string. */
async function referenceFromImage(userId: string, imageId: string): Promise<string> {
  const { bytes, mimeType } = await getImageBytes(userId, imageId);
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeType};base64,${b64}`;
}

/**
 * Enqueue a staged sheet job (head / body / clothed) and return it `pending`.
 * The conditioning image is resolved here: stage 1 may use an uploaded
 * `referenceImage` (data URL) or a selected `sourceImageId`; stages 2–3 always
 * resolve the selected `sourceImageId`'s bytes. The provider returns the whole
 * sheet in one call (split by the runner).
 */
export async function createSheet(
  userId: string,
  req: SheetRequest
): Promise<Generation> {
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

  // Validate the owning character (if any) before spending credits — throws
  // CHARACTER_NOT_FOUND for a missing or someone else's character.
  if (req.characterId) await getCharacter(userId, req.characterId);

  let referenceImage: string;

  if (req.kind === 'head-sheet') {
    if (req.referenceImage && req.sourceImageId) {
      throw new HttpError('VALIDATION', 'Provide exactly one of sourceImageId or referenceImage');
    }
    if (req.referenceImage) {
      referenceImage = req.referenceImage;
    } else if (req.sourceImageId) {
      referenceImage = await referenceFromImage(userId, req.sourceImageId);
    } else {
      throw new HttpError('VALIDATION', 'A head sheet needs a sourceImageId or an uploaded referenceImage');
    }
    const id = await enqueueSheet(userId, req, {
      kind: 'head-sheet',
      referenceImage,
      traits: req.traits,
    });
    return await loadGeneration(userId, id);
  }

  if (req.kind === 'body-sheet') {
    referenceImage = await referenceFromImage(userId, req.sourceImageId);
    const id = await enqueueSheet(userId, req, {
      kind: 'body-sheet',
      referenceImage,
      body: req.body,
    });
    return await loadGeneration(userId, id);
  }

  // clothed-sheet
  referenceImage = await referenceFromImage(userId, req.sourceImageId);
  const clothedId = await enqueueSheet(userId, req, {
    kind: 'clothed-sheet',
    referenceImage,
    wardrobe: req.wardrobe,
  });
  return await loadGeneration(userId, clothedId);
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
    kind: gen.kind ?? 'face',
    sourceImageId: gen.sourceImageId,
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
