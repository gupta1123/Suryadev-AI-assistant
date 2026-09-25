import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export const PAGE_SIZE_OPTIONS = [2, 5, 10, 25, 50, 100];

function readStoredPageSize(storageKey: string, fallback: number): number {
  try {
    const stored = Number(window.localStorage.getItem(`page-size:${storageKey}`));
    return PAGE_SIZE_OPTIONS.includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Client-side paging over an already filtered list. `resetKey` should change whenever
 * the filters change so the view jumps back to page 1.
 */
export function usePagination<T>(rows: T[], storageKey: string, resetKey: string, defaultPageSize = 10) {
  const [pageSize, setPageSizeState] = useState(() => readStoredPageSize(storageKey, defaultPageSize));
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  useEffect(() => { setPage(1); }, [resetKey]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  const pageRows = useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  );

  function setPageSize(size: number) {
    setPageSizeState(size);
    setPage(1);
    try { window.localStorage.setItem(`page-size:${storageKey}`, String(size)); } catch { /* per-viewer convenience only */ }
  }

  return { page: Math.min(page, pageCount), pageCount, pageSize, pageRows, total: rows.length, setPage, setPageSize };
}

function pageNumbers(page: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((value) => pages.add(value));
  if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((value) => pages.add(value));
  const sorted = [...pages].filter((value) => value >= 1 && value <= pageCount).sort((a, b) => a - b);
  return sorted.flatMap((value, index) => (index > 0 && value - sorted[index - 1] > 1 ? ['gap' as const, value] : [value]));
}

export function PaginationControls({
  page,
  pageCount,
  pageSize,
  total,
  noun = 'records',
  disabled,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  noun?: string;
  disabled?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pagination" aria-label="Table pagination">
      <div className="pagination__meta">
        <label className="pagination__size">
          <span>Rows per page</span>
          <select value={pageSize} disabled={disabled} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <p>{first}–{last} <span>of {total} {noun}</span></p>
      </div>
      <div className="pagination__pages">
        <button className="pagination__step" type="button" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        {pageNumbers(page, pageCount).map((value, index) => value === 'gap'
          ? <span className="pagination__gap" key={`gap-${index}`}>…</span>
          : (
            <button
              key={value}
              type="button"
              className={value === page ? 'pagination__page pagination__page--active' : 'pagination__page'}
              aria-current={value === page ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onPageChange(value)}
            >
              {value}
            </button>
          ))}
        <button className="pagination__step" type="button" disabled={disabled || page >= pageCount} onClick={() => onPageChange(page + 1)} aria-label="Next page">
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
