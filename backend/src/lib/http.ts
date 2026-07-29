import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: 'Invalid request',
      details: error.flatten(),
    });
    return;
  }
  const httpError = error instanceof HttpError ? error : undefined;
  const status = httpError?.status ?? 500;
  const message = httpError?.message ?? 'Internal server error';

  if (status >= 500) {
    request.log.error({ err: error }, message);
  }

  response.status(status).json({
    error: message,
    ...(httpError?.details === undefined ? {} : { details: httpError.details }),
  });
}
