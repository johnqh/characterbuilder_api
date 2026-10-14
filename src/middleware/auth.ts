/**
 * Bearer token -> principal. Two paths:
 *  1. Dev bypass (AUTH_TEST_MODE=1): `Bearer dev:<uid>:<email>` authenticates as that user.
 *  2. Firebase ID token via @sudobility/auth_service (needs FIREBASE_* env; else 401).
 *
 * CharacterBuilder has no API keys — every request is a signed-in user.
 */
import type { Context, Next } from 'hono';
import { errorResponse } from '@sudobility/characterbuilder_types';
import { getEnvList, isTestMode } from '../lib/env-helper';
import { isFirebaseConfigured } from '../lib/config';
import { verifyFirebaseToken } from '../services/firebase';

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  email: string | null;
  siteAdmin: boolean;
  via: 'firebase' | 'test';
  emailVerified: boolean;
}

export type Principal = UserPrincipal;

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal;
    userId: string;
    requestId: string;
  }
}

export function isSiteAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return getEnvList('SITEADMIN_EMAILS')
    .concat(getEnvList('ADMIN_EMAILS'))
    .some((a) => a.toLowerCase() === e);
}

/** Parses `dev:<uid>:<email>`; returns null when the token is not of that form. */
export function parseDevToken(
  token: string
): { uid: string; email: string } | null {
  if (!token.startsWith('dev:')) return null;
  const rest = token.slice(4);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const uid = rest.slice(0, i);
  const email = rest.slice(i + 1);
  if (!uid || !email) return null;
  return { uid, email };
}

export type TokenResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'unavailable' | 'anonymous' | 'invalid' };

export async function resolveToken(token: string): Promise<TokenResult> {
  const dev = isTestMode() ? parseDevToken(token) : null;
  if (dev) {
    return {
      ok: true,
      principal: {
        kind: 'user',
        userId: dev.uid,
        email: dev.email,
        siteAdmin: isSiteAdminEmail(dev.email),
        via: 'test',
        emailVerified: true,
      },
    };
  }
  if (!isFirebaseConfigured()) return { ok: false, reason: 'unavailable' };
  try {
    const { decoded, anonymous } = await verifyFirebaseToken(token);
    if (anonymous) return { ok: false, reason: 'anonymous' };
    return {
      ok: true,
      principal: {
        kind: 'user',
        userId: decoded.uid,
        email: decoded.email ?? null,
        siteAdmin: isSiteAdminEmail(decoded.email),
        via: 'firebase',
        emailVerified: decoded.email_verified === true,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

const bearer = (c: Context): string | null => {
  const h = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
};

/** Require a signed-in user; populates `principal` and `userId` on the context. */
export async function requireAuth(c: Context, next: Next) {
  const token = bearer(c);
  if (!token) {
    return c.json(errorResponse('Authentication required', 'UNAUTHORIZED'), 401);
  }
  const result = await resolveToken(token);
  if (!result.ok) {
    const msg =
      result.reason === 'unavailable'
        ? 'Authentication is not configured'
        : result.reason === 'anonymous'
          ? 'Sign in with a full account'
          : 'Invalid or expired token';
    return c.json(errorResponse(msg, 'UNAUTHORIZED'), 401);
  }
  c.set('principal', result.principal);
  c.set('userId', result.principal.userId);
  await next();
}
