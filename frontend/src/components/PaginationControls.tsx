import { ChevronLeft, ChevronRight } from 'lucide-react';

export function PaginationControls({
  page,
  itemCount,
  pageSize,
  hasPrevious,
  hasNext,
  disabled,
  onPrevious,
  onNext,
}: {
  page: number;
  itemCount: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!hasPrevious && !hasNext && itemCount <= pageSize) return null;

  return (
    <nav className="pagination" aria-label="Table pagination">
      <p>Page {page}<span> · {itemCount} {itemCount === 1 ? 'record' : 'records'} shown</span></p>
      <div>
        <button className="button button--secondary button--compact" type="button" disabled={disabled || !hasPrevious} onClick={onPrevious}>
          <ChevronLeft size={15} aria-hidden="true" /> Previous
        </button>
        <button className="button button--secondary button--compact" type="button" disabled={disabled || !hasNext} onClick={onNext}>
          Next <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
