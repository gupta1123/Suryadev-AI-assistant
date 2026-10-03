import { env } from '../config/env.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isTrustedRequestOrigin(origin: string | undefined): boolean {
  if (!origin || origin === env.FRONTEND_ORIGIN) return true;
  if (env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
