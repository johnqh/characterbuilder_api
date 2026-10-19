/**
 * ShapeShyft image transport. One POST to `${SHAPESHYFT_ENDPOINT_URL}/<endpoint>`
 * with `SHAPESHYFT_API_KEY` as a bearer token; the provider key and the image
 * model live on the ShapeShyft endpoint, never here. Adapted from
 * screenwriter_api's `services/ai/transport.ts` + `image-output.ts`.
 */
import {
  FACE_FEATURE_VALUES,
  faceDistributionsSchema,
  type Demographics,
  type FaceDistributions,
  type FaceSpec,
} from '@sudobility/characterbuilder_types';
import { getEnv, shapeShyftConfigured } from '../lib/env-helper';
import { HttpError } from '../lib/errors';
import { log } from '../lib/log';

/** Every enum trait the complete spec must carry before it may reach ShapeShyft. */
const REQUIRED_TRAIT_KEYS = Object.keys(FACE_FEATURE_VALUES);

/**
 * The hard completeness gate (requirement R3): a spec sent to ShapeShyft MUST
 * have every enum trait set. ShapeShyft's platform does not validate request
 * input against an endpoint's input_schema, so this is where "all traits
 * required" is actually enforced — the last characterbuilder-controlled point
 * before the call. A missing trait is a caster bug and fails loudly rather than
 * silently letting the model free-choose (which is what causes the sameness).
 */
export function assertCompleteSpec(traits: FaceSpec): void {
  const missing = REQUIRED_TRAIT_KEYS.filter(
    (k) => (traits as Record<string, unknown>)[k] == null
  );
  if (missing.length > 0) {
    throw new HttpError(
      'AI_OUTPUT_INVALID',
      `Incomplete FaceSpec sent to ShapeShyft — missing ${missing.length} trait(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`
    );
  }
}

interface ShapeShyftMedia {
  type: string;
  mimeType: string;
  data: string;
}
interface ShapeShyftBody {
  success?: boolean;
  error?: string;
  data?: { output?: unknown; generated_media?: ShapeShyftMedia[] };
  output?: unknown;
  generated_media?: ShapeShyftMedia[];
}

export interface GeneratedBytes {
  bytes: Uint8Array;
  mimeType: string;
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isBase64 = (s: string) => /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const isValidPng = (b: Buffer) =>
  b.length >= 100 &&
  b.length <= 25 * 1024 * 1024 &&
  b.subarray(0, 8).equals(PNG_MAGIC);

function endpointName(): string {
  return getEnv('SHAPESHYFT_IMAGE_ENDPOINT', 'character-image')!;
}

function promptEndpointName(): string {
  return getEnv('SHAPESHYFT_PROMPT_ENDPOINT', 'character-prompt')!;
}

function distributionEndpointName(): string {
  return getEnv('SHAPESHYFT_DISTRIBUTION_ENDPOINT', 'character-distribution')!;
}

function timeoutMs(): number {
  const n = parseInt(getEnv('SHAPESHYFT_TIMEOUT_MS', '240000')!, 10);
  return Number.isFinite(n) && n > 0 ? n : 240000;
}

/**
 * Compose -> POST -> validated PNG bytes. `prompt` is the composed FaceSpec
 * prompt; `referenceImage` is an optional `data:image/...;base64,...` string.
 */
export async function generateImage(
  prompt: string,
  referenceImage?: string
): Promise<GeneratedBytes> {
  const base = getEnv('SHAPESHYFT_ENDPOINT_URL');
  const key = getEnv('SHAPESHYFT_API_KEY');
  if (!base || !key || !shapeShyftConfigured()) {
    throw new HttpError(
      'AI_UNAVAILABLE',
      'Image generation is not configured (SHAPESHYFT_ENDPOINT_URL / SHAPESHYFT_API_KEY unset)'
    );
  }
  const name = endpointName();
  const url = `${base.replace(/\/+$/, '')}/${name}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs());
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        prompt,
        ...(referenceImage ? { referenceImage } : {}),
      }),
      signal: controller.signal,
    });
  } catch {
    if (timedOut)
      throw new HttpError(
        'AI_GENERATION_FAILED',
        `Image request exceeded the ${Math.round(timeoutMs() / 1000)}s timeout`
      );
    throw new HttpError('AI_UNAVAILABLE', 'Image provider is unreachable');
  } finally {
    clearTimeout(timer);
  }

  let body: ShapeShyftBody;
  try {
    body = (await response.json()) as ShapeShyftBody;
  } catch {
    throw new HttpError(
      'AI_GENERATION_FAILED',
      `ShapeShyft ${name} returned a non-JSON body (HTTP ${response.status})`
    );
  }
  if (!response.ok || body.success === false) {
    const message = body.error ?? `HTTP ${response.status}`;
    if (/refus|content[ _]policy|safety/i.test(message))
      throw new HttpError('AI_CONTENT_REFUSED', 'The provider declined this prompt');
    throw new HttpError('AI_GENERATION_FAILED', `ShapeShyft ${name} failed: ${message}`);
  }

  const payload = body.data ?? body;
  const media = payload.generated_media?.find(
    (m) => m.type === 'image' && isBase64(m.data)
  );
  if (!media)
    throw new HttpError('AI_OUTPUT_INVALID', 'The image endpoint returned no image');
  const bytes = Buffer.from(media.data, 'base64');
  if (!isValidPng(bytes))
    throw new HttpError('AI_OUTPUT_INVALID', 'The image endpoint returned invalid PNG data');

  log('info', '[image] generated', { endpoint: name, ms: Date.now() - started });
  return { bytes, mimeType: 'image/png' };
}

/**
 * Stage 1 of the two-stage pipeline: send the COMPLETE cast FaceSpec to the
 * `character-prompt` text endpoint and get back a polished prose prompt. The
 * runner falls back to the local `composePrompt` if this throws (endpoint
 * unconfigured or failing), so generation never hard-depends on it.
 */
export async function composeRemote(
  traits: FaceSpec,
  shot?: string,
  expression?: string
): Promise<string> {
  assertCompleteSpec(traits);
  const base = getEnv('SHAPESHYFT_ENDPOINT_URL');
  const key = getEnv('SHAPESHYFT_API_KEY');
  if (!base || !key || !shapeShyftConfigured()) {
    throw new HttpError('AI_UNAVAILABLE', 'Prompt endpoint is not configured');
  }
  const name = promptEndpointName();
  const url = `${base.replace(/\/+$/, '')}/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ traits, shot, expression }),
      signal: controller.signal,
    });
    const body = (await response.json()) as ShapeShyftBody;
    if (!response.ok || body.success === false) {
      throw new HttpError(
        'AI_GENERATION_FAILED',
        `ShapeShyft ${name} failed: ${body.error ?? `HTTP ${response.status}`}`
      );
    }
    const output = (body.data?.output ?? body.output) as
      | { prompt?: unknown }
      | undefined;
    const prompt = output?.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new HttpError('AI_OUTPUT_INVALID', `${name} returned no prompt`);
    }
    return prompt;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hybrid's LLM half (requirement A): ask the `character-distribution`
 * endpoint to shift per-trait odds for a named sub-population / health nuance
 * that the static tables only know at the broad-ancestry level. Returns
 * per-trait probability OVERRIDES (sanitized to known traits + allowed values);
 * `{}` when the model declines or returns nothing usable. Throws only when the
 * endpoint is unconfigured/unreachable, so callers can fall back to the static base.
 */
export async function refineDistributionsRemote(
  demo: Demographics
): Promise<FaceDistributions> {
  const base = getEnv('SHAPESHYFT_ENDPOINT_URL');
  const key = getEnv('SHAPESHYFT_API_KEY');
  if (!base || !key || !shapeShyftConfigured()) {
    throw new HttpError('AI_UNAVAILABLE', 'Distribution endpoint is not configured');
  }
  const name = distributionEndpointName();
  const url = `${base.replace(/\/+$/, '')}/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ demographics: demo, vocabulary: FACE_FEATURE_VALUES }),
      signal: controller.signal,
    });
    const body = (await response.json()) as ShapeShyftBody;
    if (!response.ok || body.success === false) {
      throw new HttpError(
        'AI_GENERATION_FAILED',
        `ShapeShyft ${name} failed: ${body.error ?? `HTTP ${response.status}`}`
      );
    }
    const output = (body.data?.output ?? body.output) as
      | { distributions?: unknown }
      | undefined;
    const parsed = faceDistributionsSchema.safeParse(output?.distributions ?? {});
    if (!parsed.success) return {};
    // Keep only real traits + their allowed values, so a stray key/value from
    // the model can never make the caster pick something invalid.
    const clean: Record<string, Record<string, number>> = {};
    for (const [trait, dist] of Object.entries(parsed.data)) {
      const allowed = FACE_FEATURE_VALUES[trait as keyof typeof FACE_FEATURE_VALUES] as
        | readonly string[]
        | undefined;
      if (!allowed) continue;
      const entries = Object.entries(dist).filter(
        ([v, p]) => allowed.includes(v) && p > 0
      );
      if (entries.length > 0) clean[trait] = Object.fromEntries(entries);
    }
    return clean as FaceDistributions;
  } finally {
    clearTimeout(timer);
  }
}
