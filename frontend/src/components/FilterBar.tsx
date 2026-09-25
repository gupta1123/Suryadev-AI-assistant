import { Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type FilterOption = { value: string; label: string };

export function FilterBar({
  search,
  searchPlaceholder,
  onSearchChange,
  active,
  onClear,
  children,
}: {
  search: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  active: boolean;
  onClear: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="filter-bar" role="search">
      <label className="filter-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Search</span>
        <input type="search" value={search} placeholder={searchPlaceholder} onChange={(event) => onSearchChange(event.target.value)} />
      </label>
      {children}
      {active && (
        <button className="filter-clear" type="button" onClick={onClear}>
          <X size={13} aria-hidden="true" /> Clear
        </button>
      )}
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={value ? 'filter-select filter-select--active' : 'filter-select'}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        <option value="">{label}: All</option>
        {options.map((option) => <option key={option.value} value={option.value}>{label}: {option.label}</option>)}
      </select>
    </label>
  );
}

export const DATE_RANGE_OPTIONS: FilterOption[] = [
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function withinDays(value: string | null | undefined, days: string): boolean {
  if (!days) return true;
  if (!value) return false;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (Number(days) - 1));
  return new Date(value).getTime() >= since.getTime();
}

export function matchesSearch(search: string, ...fields: Array<string | number | null | undefined>): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field !== null && field !== undefined && String(field).toLowerCase().includes(needle));
}

export function humanize(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
