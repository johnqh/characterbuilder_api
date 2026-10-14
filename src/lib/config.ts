import { getEnv } from './env-helper';

export function isFirebaseConfigured(): boolean {
  return Boolean(
    getEnv('FIREBASE_PROJECT_ID') &&
      getEnv('FIREBASE_CLIENT_EMAIL') &&
      getEnv('FIREBASE_PRIVATE_KEY')
  );
}

/** Reasons the server must refuse to boot. Empty = OK to start. */
export function bootProblems(): string[] {
  const problems: string[] = [];
  if (!getEnv('DATABASE_URL')) {
    problems.push('DATABASE_URL is not set');
  }
  return problems;
}
