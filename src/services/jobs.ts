/**
 * Async generation jobs. A `generations` row IS the job (its status —
 * pending|running|succeeded|failed — is already job-shaped). Pattern copied from
 * music_api's `services/jobs`, slimmed to poll-only (no live websocket layer):
 *
 *  - enqueue:  reserve N credits up front (402 if short), insert a `pending` row,
 *              kick the self-draining pump.
 *  - promote:  flip the user's oldest `pending` row to `running`; a partial
 *              UNIQUE INDEX on (user_id) WHERE status='running' is the real
 *              one-running-per-user guarantee, so a lost race is just a no-op.
 *  - run:      cast a fresh coherent FaceSpec PER image (ephemeral variety),
 *              compose, render, store; settle credits (release the undelivered
 *              remainder); finish; then promote the user's next job.
 *  - recover:  at boot, fail every orphaned `running` row, release its reserve,
 *              and re-pump stranded `pending` work.
 *
 * `referenceImage` is a large transient input kept in memory (not persisted); a
 * job that outlives a restart simply runs without it.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  SHEET_EXPECTED_COUNT,
  SHEET_ROLES,
  castFaceSpec,
  composePrompt,
  generationParamsSchema,
  makeId,
  type BodySpec,
  type Demographics,
  type FaceSpec,
  type GenerateRequest,
  type HeadSheetTraits,
  type SheetKind,
  type SheetRequest,
  type WardrobeSpec,
} from '@sudobility/characterbuilder_types';
import { generationImages, generations, getDb } from '../db';
import { HttpError } from '../lib/errors';
import { log } from '../lib/log';
import { releaseCredits, reserveCredits } from './credits';
import { getStorage } from './storage';
import {
  assertCompleteSpec,
  composeRemote,
  composeSheetPrompt,
  generateImage,
  generateSheet,
  sheetEndpointName,
} from './shapeshyft';
import { getDistributions } from './distribution';
import { getCharacter } from './characters';

/** Transient reference images, keyed by job id (never persisted — see header). */
const pendingReferenceImages = new Map<string, string>();

/** The transient inputs for a sheet job (the resolved reference + stage input). */
interface SheetJobData {
  kind: SheetKind;
  /** The resolved `data:` reference image (from the selected image or an upload). */
  referenceImage: string;
  traits?: HeadSheetTraits;
  body?: BodySpec;
  wardrobe?: WardrobeSpec;
}
/** Transient sheet-job inputs, keyed by job id (not persisted, like the above). */
const pendingSheetJobs = new Map<string, SheetJobData>();

/** The render step, injectable so tests can stub the provider. */
export type RenderFn = (
  prompt: string,
  referenceImage?: string
) => Promise<{ bytes: Uint8Array; mimeType: string }>;
let renderImage: RenderFn = generateImage;
export function setRenderImage(fn: RenderFn): void {
  renderImage = fn;
}
export function resetRenderImage(): void {
  renderImage = generateImage;
}

const imageKey = (userId: string, generationId: string, imageId: string) =>
  `images/${userId}/${generationId}/${imageId}.png`;

/**
 * Resolve the base (partial) spec and the owning character. An inline `spec`
 * (the editor's live draft) is rendered as-is, but the generation is still
 * associated with `characterId` when one is given — so the images land in that
 * character's gallery. Passing a `characterId` always validates ownership
 * (`getCharacter` throws for someone else's / a missing character).
 */
async function resolveBaseSpec(
  userId: string,
  req: { characterId?: string; spec?: FaceSpec }
): Promise<{ spec: FaceSpec; characterId: string | null }> {
  if (req.spec) {
    const characterId = req.characterId
      ? (await getCharacter(userId, req.characterId)).id
      : null;
    return { spec: req.spec, characterId };
  }
  if (req.characterId) {
    const character = await getCharacter(userId, req.characterId);
    return { spec: character.spec, characterId: character.id };
  }
  return { spec: {}, characterId: null };
}

/**
 * Create a job: reserve the full cost, persist a pending row, start the pump.
 * Throws INSUFFICIENT_CREDITS (402) when the balance can't cover the reserve.
 */
export async function enqueueGeneration(
  userId: string,
  req: GenerateRequest
): Promise<string> {
  const params = generationParamsSchema.parse(req.params);
  const cost = params.count;

  const id = makeId('generation', crypto.randomUUID().replace(/-/g, ''));
  const { spec, characterId } = await resolveBaseSpec(userId, req);

  // Reserve the full cost atomically (402 if the balance can't cover it).
  const reserved = await reserveCredits(userId, cost, `gen:${id}`);
  if (!reserved.success) {
    throw new HttpError('INSUFFICIENT_CREDITS', 'Not enough credits', {
      required: cost,
      balance: reserved.balance,
    });
  }

  // Persist the pending job. If the insert fails — most likely a duplicate
  // idempotency key racing another request — release the reserve so it can't
  // leak, and hand back the job that won the race.
  try {
    await getDb()
      .insert(generations)
      .values({
        id,
        userId,
        characterId,
        spec,
        demographics: req.demographics ?? null,
        prompt: null,
        params,
        status: 'pending',
        creditsSpent: 0,
        reservedCredits: cost,
        error: null,
        idempotencyKey: req.idempotencyKey ?? null,
      });
  } catch (err) {
    await releaseCredits(userId, cost, `gen:${id}`);
    if (req.idempotencyKey) {
      const [existing] = await getDb()
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.userId, userId),
            eq(generations.idempotencyKey, req.idempotencyKey)
          )
        );
      if (existing) return existing.id;
    }
    throw err;
  }

  if (req.referenceImage) pendingReferenceImages.set(id, req.referenceImage);
  startNext(userId);
  return id;
}

/**
 * Create a sheet job (head/body/clothed). Reserves the stage's expected image
 * count up front (settled to what the provider actually returns), persists a
 * pending row tagged with `kind` + `sourceImageId`, and stashes the resolved
 * reference + stage input transiently (like `referenceImage`, not persisted).
 */
export async function enqueueSheet(
  userId: string,
  req: SheetRequest,
  data: SheetJobData
): Promise<string> {
  const cost = SHEET_EXPECTED_COUNT[req.kind];
  const id = makeId('generation', crypto.randomUUID().replace(/-/g, ''));

  const reserved = await reserveCredits(userId, cost, `gen:${id}`);
  if (!reserved.success) {
    throw new HttpError('INSUFFICIENT_CREDITS', 'Not enough credits', {
      required: cost,
      balance: reserved.balance,
    });
  }

  try {
    await getDb()
      .insert(generations)
      .values({
        id,
        userId,
        characterId: req.characterId ?? null,
        spec: null,
        demographics: null,
        prompt: null,
        params: generationParamsSchema.parse({ count: cost }),
        kind: req.kind,
        sourceImageId: req.sourceImageId ?? null,
        status: 'pending',
        creditsSpent: 0,
        reservedCredits: cost,
        error: null,
        idempotencyKey: req.idempotencyKey ?? null,
      });
  } catch (err) {
    await releaseCredits(userId, cost, `gen:${id}`);
    if (req.idempotencyKey) {
      const [existing] = await getDb()
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.userId, userId),
            eq(generations.idempotencyKey, req.idempotencyKey)
          )
        );
      if (existing) return existing.id;
    }
    throw err;
  }

  pendingSheetJobs.set(id, data);
  startNext(userId);
  return id;
}

/** Flip the user's oldest pending job to running; null if none / lost the slot. */
async function promoteNext(userId: string): Promise<string | null> {
  const [next] = await getDb()
    .select({ id: generations.id })
    .from(generations)
    .where(and(eq(generations.userId, userId), eq(generations.status, 'pending')))
    .orderBy(asc(generations.createdAt), asc(generations.id))
    .limit(1);
  if (!next) return null;
  try {
    const updated = await getDb()
      .update(generations)
      .set({ status: 'running' })
      .where(and(eq(generations.id, next.id), eq(generations.status, 'pending')))
      .returning({ id: generations.id });
    return updated.length ? next.id : null;
  } catch {
    // The partial unique index rejected it — another job is already running.
    return null;
  }
}

/** Promote and launch the user's next job, detached. Safe to call spuriously. */
export function startNext(userId: string): void {
  void (async () => {
    const id = await promoteNext(userId);
    if (id) void runJob(id).catch((err) => log('error', 'runJob crashed', { id, error: String(err) }));
  })();
}

async function finish(
  id: string,
  fields: {
    status: 'succeeded' | 'failed';
    creditsSpent?: number;
    prompt?: string | null;
    error?: string | null;
  }
): Promise<void> {
  await getDb()
    .update(generations)
    .set({ ...fields, finishedAt: new Date() })
    .where(eq(generations.id, id));
}

/** Render a promoted job to completion, then pump the user's next one. */
export async function runJob(id: string): Promise<void> {
  const [job] = await getDb()
    .select()
    .from(generations)
    .where(eq(generations.id, id));
  if (!job || job.status !== 'running') return;

  // Sheet jobs take a different path: one provider call returns the whole sheet.
  if (job.kind && job.kind !== 'face') {
    await runSheetJob(job);
    return;
  }

  const userId = job.userId;
  const params = generationParamsSchema.parse(job.params);
  const cost = params.count;
  const baseSpec = (job.spec ?? {}) as FaceSpec;
  const demographics = (job.demographics ?? {}) as Demographics;
  const referenceImage = pendingReferenceImages.get(id);
  pendingReferenceImages.delete(id);

  const started = Date.now();
  const storage = getStorage();
  const imageRows: (typeof generationImages.$inferInsert)[] = [];
  let firstPrompt: string | null = null;
  let lastError: string | null = null;

  // Build the demographic distribution once per job (static base, plus an LLM
  // sub-population refinement when one is named); every image samples from it.
  const { distributions } = await getDistributions(demographics);

  for (let i = 0; i < cost; i++) {
    try {
      // Ephemeral: re-cast the unset traits for every image → a new coherent
      // person each time (explicitly-set traits are kept).
      const { spec } = castFaceSpec(baseSpec, demographics, { distributions });
      // Enforce completeness BEFORE either compose path, so an incomplete spec
      // (a caster bug) fails the image loudly rather than being quietly rendered
      // by the local fallback — "all traits required" is non-bypassable.
      assertCompleteSpec(spec);
      // Two-stage: an LLM writes the prose prompt from the complete spec; fall
      // back to the local deterministic composer if that endpoint is down.
      let prompt: string;
      try {
        prompt = await composeRemote(spec, params.shot, params.expression);
      } catch (err) {
        log('warn', '[job] remote compose failed; using local composePrompt', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        prompt = composePrompt(spec, params);
      }
      if (!firstPrompt) firstPrompt = prompt;
      const r = await renderImage(prompt, referenceImage);
      const imageId = makeId('image', crypto.randomUUID().replace(/-/g, ''));
      const key = imageKey(userId, id, imageId);
      await storage.put(key, r.bytes, r.mimeType);
      imageRows.push({
        id: imageId,
        generationId: id,
        userId,
        storageKey: key,
        mimeType: r.mimeType,
        spec,
        prompt,
        width: null,
        height: null,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log('warn', '[job] image failed', { id, index: i, error: lastError });
    }
  }

  const delivered = imageRows.length;
  if (delivered > 0) await getDb().insert(generationImages).values(imageRows);

  // Settle: release whatever we reserved but didn't deliver.
  if (delivered < cost) {
    await releaseCredits(userId, cost - delivered, `gen:${id}`);
  }

  await finish(id, {
    status: delivered > 0 ? 'succeeded' : 'failed',
    creditsSpent: delivered,
    prompt: firstPrompt,
    error: delivered > 0 ? null : (lastError ?? 'Image generation failed'),
  });
  log('info', '[job] finished', {
    id,
    delivered,
    cost,
    ms: Date.now() - started,
  });

  startNext(userId);
}

/**
 * Render a sheet job: compose the stage prompt, make ONE provider call that
 * returns the whole sheet, store each image tagged with its view/direction
 * role, then settle credits (release any the provider didn't deliver).
 */
async function runSheetJob(job: typeof generations.$inferSelect): Promise<void> {
  const { id, userId } = job;
  const kind = job.kind as SheetKind;
  const reserved = job.reservedCredits;
  const data = pendingSheetJobs.get(id);
  pendingSheetJobs.delete(id);

  const started = Date.now();
  const storage = getStorage();
  const imageRows: (typeof generationImages.$inferInsert)[] = [];
  let prompt: string | null = null;
  let error: string | null = null;

  try {
    if (!data) {
      // Inputs are transient; a job that outlived a restart has lost them.
      throw new Error('Sheet inputs were lost (likely a server restart)');
    }
    prompt = composeSheetPrompt(kind, {
      traits: data.traits,
      body: data.body,
      wardrobe: data.wardrobe,
    });
    const images = await generateSheet(prompt, data.referenceImage, sheetEndpointName(kind));
    const roles = SHEET_ROLES[kind];
    for (let i = 0; i < images.length; i++) {
      const img = images[i]!;
      const imageId = makeId('image', crypto.randomUUID().replace(/-/g, ''));
      const key = imageKey(userId, id, imageId);
      await storage.put(key, img.bytes, img.mimeType);
      imageRows.push({
        id: imageId,
        generationId: id,
        userId,
        storageKey: key,
        mimeType: img.mimeType,
        prompt,
        role: roles[i] ?? `view-${i + 1}`,
        width: null,
        height: null,
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log('warn', '[sheet] failed', { id, kind, error });
  }

  const delivered = imageRows.length;
  if (delivered > 0) await getDb().insert(generationImages).values(imageRows);
  if (delivered < reserved) {
    await releaseCredits(userId, reserved - delivered, `gen:${id}`);
  }

  await finish(id, {
    status: delivered > 0 ? 'succeeded' : 'failed',
    creditsSpent: delivered,
    prompt,
    error: delivered > 0 ? null : (error ?? 'Sheet generation failed'),
  });
  log('info', '[sheet] finished', { id, kind, delivered, ms: Date.now() - started });

  startNext(userId);
}

/**
 * Boot sweep: any job still `running` at startup died with the previous process,
 * so fail it and release its reserve; then re-pump every user with pending work.
 */
export async function recoverOrphanedJobs(): Promise<void> {
  const stuck = await getDb()
    .select()
    .from(generations)
    .where(eq(generations.status, 'running'));
  for (const job of stuck) {
    if (job.reservedCredits > 0) {
      await releaseCredits(job.userId, job.reservedCredits, `gen:${job.id}`);
    }
    await finish(job.id, {
      status: 'failed',
      creditsSpent: 0,
      error: 'Interrupted by a server restart',
    });
  }
  const users = await getDb()
    .selectDistinct({ userId: generations.userId })
    .from(generations)
    .where(eq(generations.status, 'pending'));
  for (const u of users) startNext(u.userId);
  if (stuck.length > 0 || users.length > 0) {
    log('info', '[jobs] recovery swept', {
      failed: stuck.length,
      pumpedUsers: users.length,
    });
  }
}
