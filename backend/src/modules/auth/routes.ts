import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import {
  type AuthenticatedRequest,
  requireAdmin,
} from '../../middleware/auth.js';
import {
  clearSessionCookie,
  createAdminSession,
  createSessionCookie,
  readSessionToken,
  revokeAdminSession,
  verifyAdminCredentials,
} from './session.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();
const attemptWindowMs = 15 * 60 * 1000;
const maximumFailures = 5;

export const authRouter = Router();

authRouter.use((_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
});

authRouter.post(
  '/login',
  requireTrustedOrigin,
  asyncHandler(async (request, response) => {
    const input = loginSchema.parse(request.body);
    const attemptKey = request.ip || 'unknown';
    assertLoginAllowed(attemptKey);

    if (!verifyAdminCredentials(input.username, input.password)) {
      recordLoginFailure(attemptKey);
      request.log.warn({ event: 'admin_login_failed', ip: attemptKey }, 'Admin login failed');
      throw new HttpError(401, 'Invalid username or password');
    }

    loginAttempts.delete(attemptKey);
    const { token, session } = createAdminSession();
    response.setHeader('Set-Cookie', createSessionCookie(token));
    request.log.info({ event: 'admin_login_succeeded', ip: attemptKey }, 'Admin login succeeded');
    response.json({ data: { user: session.user } });
  }),
);

authRouter.get(
  '/session',
  requireAdmin,
  (request: AuthenticatedRequest, response) => {
    response.json({ data: { user: request.auth?.user } });
  },
);

authRouter.post('/logout', requireTrustedOrigin, (request, response) => {
  const token = readSessionToken(request.header('cookie'));
  revokeAdminSession(token);
  response.setHeader('Set-Cookie', clearSessionCookie());
  response.status(204).send();
});

function requireTrustedOrigin(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const origin = request.header('origin');
  if (origin && origin !== env.FRONTEND_ORIGIN) {
    next(new HttpError(403, 'Request origin is not allowed'));
    return;
  }
  next();
}

function assertLoginAllowed(key: string, now = Date.now()): void {
  const attempt = loginAttempts.get(key);
  if (!attempt) return;
  if (attempt.resetAt <= now) {
    loginAttempts.delete(key);
    return;
  }
  if (attempt.failures >= maximumFailures) {
    throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  }
}

function recordLoginFailure(key: string, now = Date.now()): void {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { failures: 1, resetAt: now + attemptWindowMs });
    return;
  }
  current.failures += 1;
}
