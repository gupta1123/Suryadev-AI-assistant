import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../../config/env.js';

export const SESSION_COOKIE_NAME = 'suryadev_admin_session';

export type AdminUser = {
  id: 'local-admin';
  username: string;
  displayName: 'Administrator';
  role: 'admin';
};

type AdminSession = {
  user: AdminUser;
  createdAt: number;
  expiresAt: number;
};

type SessionTokenPayload = {
  version: 1;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
};

const TOKEN_VERSION = 'v1';
const revokedSessionIds = new Map<string, number>();
const sessionLifetimeMs = env.AUTH_SESSION_HOURS * 60 * 60 * 1000;
const sessionSigningSecret = Buffer.from(
  env.AUTH_SESSION_SECRET
    ?? createHash('sha256')
      .update(`development-only:${env.ADMIN_USERNAME}:${env.ADMIN_PASSWORD}`, 'utf8')
      .digest('hex'),
  'utf8',
);

export function verifyAdminCredentials(username: string, password: string): boolean {
  return constantTimeEqual(username, env.ADMIN_USERNAME)
    && constantTimeEqual(password, env.ADMIN_PASSWORD);
}

export function createAdminSession(now = Date.now()): {
  token: string;
  session: AdminSession;
} {
  pruneExpiredRevocations(now);
  const session: AdminSession = {
    user: {
      id: 'local-admin',
      username: env.ADMIN_USERNAME,
      displayName: 'Administrator',
      role: 'admin',
    },
    createdAt: now,
    expiresAt: now + sessionLifetimeMs,
  };
  const token = createSignedToken({
    version: 1,
    sessionId: randomBytes(24).toString('base64url'),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
  return { token, session };
}

export function getAdminSession(token: string | undefined, now = Date.now()): AdminSession | null {
  const payload = verifySignedToken(token);
  if (!payload) return null;
  pruneExpiredRevocations(now);
  if (payload.expiresAt <= now || revokedSessionIds.has(payload.sessionId)) return null;
  if (
    payload.createdAt > now + 5 * 60 * 1000
    || payload.expiresAt <= payload.createdAt
    || payload.expiresAt - payload.createdAt > sessionLifetimeMs
  ) return null;
  return {
    user: adminUser(),
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  };
}

export function revokeAdminSession(token: string | undefined): void {
  const payload = verifySignedToken(token);
  if (payload) revokedSessionIds.set(payload.sessionId, payload.expiresAt);
}

export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createSessionCookie(token: string): string {
  const maxAgeSeconds = Math.floor(sessionLifetimeMs / 1000);
  return serializeCookie(encodeURIComponent(token), maxAgeSeconds);
}

export function clearSessionCookie(): string {
  return `${serializeCookie('', 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function resetAdminSessions(): void {
  revokedSessionIds.clear();
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(env.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function adminUser(): AdminUser {
  return {
    id: 'local-admin',
    username: env.ADMIN_USERNAME,
    displayName: 'Administrator',
    role: 'admin',
  };
}

function createSignedToken(payload: SessionTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const unsignedToken = `${TOKEN_VERSION}.${encodedPayload}`;
  return `${unsignedToken}.${sign(unsignedToken)}`;
}

function verifySignedToken(token: string | undefined): SessionTokenPayload | null {
  if (!token) return null;
  const [version, encodedPayload, suppliedSignature, ...extra] = token.split('.');
  if (version !== TOKEN_VERSION || !encodedPayload || !suppliedSignature || extra.length > 0) return null;
  const expectedSignature = sign(`${version}.${encodedPayload}`);
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<SessionTokenPayload>;
    if (
      parsed.version !== 1
      || typeof parsed.sessionId !== 'string'
      || !/^[A-Za-z0-9_-]{24,}$/.test(parsed.sessionId)
      || !Number.isSafeInteger(parsed.createdAt)
      || !Number.isSafeInteger(parsed.expiresAt)
    ) return null;
    return parsed as SessionTokenPayload;
  } catch {
    return null;
  }
}

function sign(value: string): string {
  return createHmac('sha256', sessionSigningSecret).update(value, 'utf8').digest('base64url');
}

function pruneExpiredRevocations(now: number): void {
  for (const [sessionId, expiresAt] of revokedSessionIds) {
    if (expiresAt <= now) revokedSessionIds.delete(sessionId);
  }
}
