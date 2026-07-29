import {
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

const sessions = new Map<string, AdminSession>();
const sessionLifetimeMs = env.AUTH_SESSION_HOURS * 60 * 60 * 1000;

export function verifyAdminCredentials(username: string, password: string): boolean {
  return constantTimeEqual(username, env.ADMIN_USERNAME)
    && constantTimeEqual(password, env.ADMIN_PASSWORD);
}

export function createAdminSession(now = Date.now()): {
  token: string;
  session: AdminSession;
} {
  pruneExpiredSessions(now);
  const token = randomBytes(32).toString('base64url');
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
  sessions.set(hashToken(token), session);
  return { token, session };
}

export function getAdminSession(token: string | undefined, now = Date.now()): AdminSession | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= now) {
    sessions.delete(tokenHash);
    return null;
  }
  return session;
}

export function revokeAdminSession(token: string | undefined): void {
  if (token) sessions.delete(hashToken(token));
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
  sessions.clear();
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

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function pruneExpiredSessions(now: number): void {
  for (const [tokenHash, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(tokenHash);
  }
}
