/**
 * ShapeShyft image transport. One POST to `${SHAPESHYFT_ENDPOINT_URL}/<endpoint>`
 * with `SHAPESHYFT_API_KEY` as a bearer token; the provider key and the image
 * model live on the ShapeShyft endpoint, never here. Adapted from
 * screenwriter_api's `services/ai/transport.ts` + `image-output.ts`.
 */
import { getEnv, shapeShyftConfigured } from '../lib/env-helper';
import { HttpError } from '../lib/errors';
import { log } from '../lib/log';

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
