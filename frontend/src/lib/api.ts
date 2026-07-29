const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: string;
    details?: unknown;
  };
  if (!response.ok) {
    const detail = Array.isArray(body.details)
      ? body.details.map((item) => (item as { label?: string }).label).filter(Boolean).join(', ')
      : '';
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
    throw new ApiError(
      [body.error ?? `Request failed (${response.status})`, detail].filter(Boolean).join(': '),
      response.status,
      body.details,
    );
  }
  return body.data as T;
}
