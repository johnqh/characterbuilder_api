/** Firebase Admin via @sudobility/auth_service. Initialised lazily on first verify. */
import { getEnv } from '../lib/env-helper';
import { isFirebaseConfigured } from '../lib/config';

type Auth = typeof import('@sudobility/auth_service');
type Verifier = ReturnType<Auth['createCachedVerifier']>;

let _verifier: Verifier | null = null;
let _auth: Auth | null = null;

async function getVerifier(): Promise<Verifier> {
  if (_verifier) return _verifier;
  const auth = await import('@sudobility/auth_service');
  auth.initializeAuth({
    firebase: {
      projectId: getEnv('FIREBASE_PROJECT_ID')!,
      clientEmail: getEnv('FIREBASE_CLIENT_EMAIL')!,
      privateKey: getEnv('FIREBASE_PRIVATE_KEY')!.replace(/\\n/g, '\n'),
    },
    siteAdminEmails: getEnv('SITEADMIN_EMAILS') ?? getEnv('ADMIN_EMAILS'),
  });
  _auth = auth;
  _verifier = auth.createCachedVerifier(300000);
  return _verifier;
}

/** Throws when Firebase is not configured or the token is invalid. */
export async function verifyFirebaseToken(token: string) {
  if (!isFirebaseConfigured()) throw new Error('Firebase not configured');
  const verifier = await getVerifier();
  const decoded = await verifier.verify(token);
  return {
    decoded,
    anonymous: _auth!.isAnonymousUser(decoded),
  };
}
