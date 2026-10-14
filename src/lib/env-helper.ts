/** Environment access. `process.env` under Bun; every read goes through here. */

export function getEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return v;
}

/** Comma- or whitespace-separated list, trimmed and de-blanked. */
export function getEnvList(name: string): string[] {
  const raw = getEnv(name);
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Dev/test bypass: `Bearer dev:<uid>:<email>` is accepted as that user. */
export function isTestMode(): boolean {
  return getEnv('AUTH_TEST_MODE', '0') === '1';
}

/** True when the real ShapeShyft transport has the credentials it needs. */
export function shapeShyftConfigured(): boolean {
  return Boolean(getEnv('SHAPESHYFT_ENDPOINT_URL') && getEnv('SHAPESHYFT_API_KEY'));
}
