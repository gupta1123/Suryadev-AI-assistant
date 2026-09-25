import { apiRequest } from './api';
import type { CursorPage } from '../types';

export const FETCH_ALL_LIMIT = 1000;
const BATCH_SIZE = 100;

/**
 * Walks a cursor-paginated endpoint until it is exhausted (or the safety cap is hit)
 * so list pages can filter and page the full dataset in the browser.
 */
export async function fetchAllPages<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let beforeId: number | null | undefined;
  do {
    const query = new URLSearchParams({ ...params, limit: String(BATCH_SIZE), paginated: 'true' });
    if (beforeId) query.set('beforeId', String(beforeId));
    const page = await apiRequest<CursorPage<T> | T[]>(`${path}?${query}`);
    // Older API versions return a bare array without cursors.
    if (Array.isArray(page)) return { items: page, truncated: false };
    items.push(...page.items);
    beforeId = page.nextCursor;
  } while (beforeId && items.length < FETCH_ALL_LIMIT);
  return { items, truncated: Boolean(beforeId) };
}
