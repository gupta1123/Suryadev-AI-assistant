import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { DeliveryTable } from '../components/DeliveryTable';
import { DATE_RANGE_OPTIONS, FilterBar, FilterSelect } from '../components/FilterBar';
import { PaginationControls } from '../components/PaginationControls';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import type { AdminUser, AppRoute, DeliveryConfig, DeliveryJob, OffsetPage } from '../types';

const TYPE_TAB_LABEL: Record<string, string> = {
  F2: 'Invoices',
  S1: 'Cancelled invoices',
  G2: 'Credit memos',
  CBRE: 'Return memos',
  L2: 'Debit memos',
};

const MESSAGE_STATUS_FILTERS = [
  { value: 'queued', label: 'Queued' },
  { value: 'sent', label: 'Sent' },
  { value: 'delivered', label: 'Delivered, not read' },
  { value: 'read', label: 'Read' },
  { value: 'failed', label: 'Failed' },
] as const;

function initialPageSize(): number {
  try {
    const stored = Number(window.localStorage.getItem('page-size:deliveries'));
    return [2, 5, 10, 25, 50, 100].includes(stored) ? stored : 10;
  } catch {
    return 10;
  }
}

export function DeliveriesPage({
  route,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [jobs, setJobs] = useState<DeliveryJob[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async (silent = false) => {
    const requestId = ++requestSequence.current;
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (debouncedSearch) query.set('search', debouncedSearch);
      if (status) query.set('status', status);
      if (type) query.set('documentType', type);
      if (range) query.set('rangeDays', range);
      const result = await apiRequest<OffsetPage<DeliveryJob>>(`/invoice-delivery/jobs?${query}`);
      if (requestId !== requestSequence.current) return;
      setJobs(result.items);
      setTotal(result.total);
      setPageCount(result.pageCount);
      if (page > result.pageCount) setPage(result.pageCount);
      setError('');
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      setError(toMessage(loadError));
    } finally {
      if (requestId !== requestSequence.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [debouncedSearch, page, pageSize, range, status, type]);

  useEffect(() => {
    apiRequest<DeliveryConfig>('/invoice-delivery/config')
      .then(setConfig)
      .catch((loadError) => setError(toMessage(loadError)));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, status, type, range]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const typeTabs = [
    { value: '', label: 'All' },
    ...(config?.billingDocumentTypes ?? []).map((item) => ({
      value: item.type,
      label: TYPE_TAB_LABEL[item.type] ?? item.label,
    })),
  ];

  const filtersActive = Boolean(search || status || type || range);

  function clearFilters() {
    setSearch('');
    setStatus('');
    setType('');
    setRange('');
  }

  function changePageSize(size: number) {
    setPageSize(size);
    setPage(1);
    try { window.localStorage.setItem('page-size:deliveries', String(size)); } catch { /* viewer preference only */ }
  }

  return (
    <AppShell
      route={route}
      eyebrow="Every invoice and memo sent on WhatsApp"
      title="Documents"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
        </button>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}
      <section className="list-section">
        <div className="seg-tabs" role="tablist" aria-label="Document type">
          {typeTabs.map((tab) => (
            <button key={tab.value || 'all'} role="tab" aria-selected={type === tab.value} className={type === tab.value ? 'seg-tab seg-tab--active' : 'seg-tab'} type="button" onClick={() => setType(tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        <FilterBar
          search={search}
          searchPlaceholder="Search by invoice, customer or phone"
          onSearchChange={setSearch}
          active={filtersActive}
          onClear={clearFilters}
        >
          <FilterSelect label="Message status" value={status} options={[...MESSAGE_STATUS_FILTERS]} onChange={setStatus} />
          <FilterSelect label="Date" value={range} options={DATE_RANGE_OPTIONS} onChange={setRange} />
        </FilterBar>
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : filtersActive && jobs.length === 0 ? (
          <div className="empty-table">
            <strong>Nothing matches your search</strong>
            <p>Try a different search or <button className="text-button" type="button" onClick={clearFilters}>clear all filters</button>.</p>
          </div>
        ) : (
          <>
            <DeliveryTable jobs={jobs} onOpen={(jobId) => onNavigate(`/documents/${jobId}`)} />
            <PaginationControls
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              total={total}
              noun="documents"
              disabled={refreshing}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          </>
        )}
      </section>

    </AppShell>
  );
}
