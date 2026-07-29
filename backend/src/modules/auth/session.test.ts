import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { env } from '../../config/env.js';
import {
  clearSessionCookie,
  createAdminSession,
  createSessionCookie,
  getAdminSession,
  readSessionToken,
  resetAdminSessions,
  revokeAdminSession,
  SESSION_COOKIE_NAME,
  verifyAdminCredentials,
} from './session.js';

describe('local administrator session', () => {
  it('accepts only the configured username and password', () => {
    assert.equal(verifyAdminCredentials(env.ADMIN_USERNAME, env.ADMIN_PASSWORD), true);
    assert.equal(verifyAdminCredentials(env.ADMIN_USERNAME, 'incorrect'), false);
    assert.equal(verifyAdminCredentials('incorrect', env.ADMIN_PASSWORD), false);
  });

  it('creates, resolves, expires and revokes opaque sessions', () => {
    resetAdminSessions();
    const now = 1_000_000;
    const { token, session } = createAdminSession(now);

    assert.notEqual(token, env.ADMIN_PASSWORD);
    assert.equal(getAdminSession(token, now)?.user.username, env.ADMIN_USERNAME);
    assert.equal(getAdminSession(token, session.expiresAt), null);

    const replacement = createAdminSession(now);
    revokeAdminSession(replacement.token);
    assert.equal(getAdminSession(replacement.token, now), null);
  });

  it('serializes an HTTP-only same-site cookie and reads it back', () => {
    const cookie = createSessionCookie('opaque-token');
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=opaque-token;`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(readSessionToken(`other=value; ${cookie}`), 'opaque-token');
    assert.match(clearSessionCookie(), /Max-Age=0/);
  });
});
