import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { HttpError } from '../lib/http.js';
import {
  type AdminUser,
  getAdminSession,
  readSessionToken,
} from '../modules/auth/session.js';

export type AuthenticatedRequest = Request & {
  auth?: {
    userId: string;
    mode: 'local-admin';
    user: AdminUser;
  };
};

export function requireAdmin(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
): void {
  try {
    validateRequestOrigin(request);
    const token = readSessionToken(request.header('cookie'));
    const session = getAdminSession(token);
    if (!session) throw new HttpError(401, 'Authentication required');

    request.auth = {
      userId: session.user.id,
      mode: 'local-admin',
      user: session.user,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function validateRequestOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.header('origin');
  if (origin && origin !== env.FRONTEND_ORIGIN) {
    throw new HttpError(403, 'Request origin is not allowed');
  }
}
