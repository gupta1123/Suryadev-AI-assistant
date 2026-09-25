import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { DeliveryTable } from '../components/DeliveryTable';
import { DATE_RANGE_OPTIONS, FilterBar, FilterSelect, humanize, matchesSearch, withinDays } from '../components/FilterBar';
import { PaginationControls, usePagination } from '../components/PaginationControls';
import { apiRequest } from '../lib/api';
import { FETCH_ALL_LIMIT, fetchAllPages } from '../lib/fetch-all';
import { toMessage } from '../lib/format';
import { relationOne, type AdminUser, type AppRoute, type DeliveryConfig, type DeliveryJob } from '../types';

function jobStatus(job: DeliveryJob): string {
  const status = (relationOne(job.messages)?.status ?? job.status).toLowerCase();
  return status === 'read' ? 'delivered' : status;
}

const TYPE_TAB_LABEL: Record<string, string> = {
  F2: 'Invoices',
  S1: 'Cancelled invoices',
  G2: 'Credit memos',
  CBRE: 'Return memos',
  L2: 'Debit memos',
};

function jobType(job: DeliveryJob): string {
  return (relationOne(job.invoices)?.billing_document_type ?? job.metadata?.billing_document_type ?? '').toUpperCase();
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
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextConfig, result] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        fetchAllPages<DeliveryJob>('/invoice-delivery/jobs'),
      ]);
      setConfig(nextConfig);
      setJobs(result.items);
      setTruncated(result.truncated);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const statusOptions = useMemo(
    () => [...new Set(jobs.map(jobStatus))].sort().map((value) => ({ value, label: humanize(value) })),
    [jobs],
  );
  // Tabs are counted within the current search/status/date view, so the numbers always match the list.
  const baseFiltered = useMemo(() => jobs.filter((job) => {
    const invoice = relationOne(job.invoices);
    return (!status || jobStatus(job) === status)
      && withinDays(job.created_at ?? job.scheduled_at, range)
      && matchesSearch(search, invoice?.sap_billing_document, relationOne(job.customers)?.display_name, job.metadata?.masked_recipient, job.id, `#${job.id}`);
  }), [jobs, status, range, search]);
  const typeTabs = [
    { value: '', label: 'All', count: baseFiltered.length },
    ...(config?.billingDocumentTypes ?? []).map((item) => ({
      value: item.type,
      label: TYPE_TAB_LABEL[item.type] ?? item.label,
      count: baseFiltered.filter((job) => jobType(job) === item.type).length,
    })),
  ];

  const filtered = useMemo(() => (type ? baseFiltered.filter((job) => jobType(job) === type) : baseFiltered), [baseFiltered, type]);

  const filtersActive = Boolean(search || status || type || range);
  const pagination = usePagination(filtered, 'deliveries', `${search}|${status}|${type}|${range}`);

  function clearFilters() {
    setSearch('');
    setStatus('');
    setType('');
    setRange('');
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
              {tab.label}<span>{tab.count}</span>
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
          <FilterSelect label="Status" value={status} options={statusOptions} onChange={setStatus} />
          <FilterSelect label="Date" value={range} options={DATE_RANGE_OPTIONS} onChange={setRange} />
        </FilterBar>
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : filtersActive && filtered.length === 0 ? (
          <div className="empty-table">
            <strong>Nothing matches your search</strong>
            <p>Try a different search or <button className="text-button" type="button" onClick={clearFilters}>clear all filters</button>.</p>
          </div>
        ) : (
          <>
            <DeliveryTable jobs={pagination.pageRows} onOpen={(jobId) => onNavigate(`/documents/${jobId}`)} />
            <PaginationControls
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              total={pagination.total}
              noun="documents"
              disabled={refreshing}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
            {truncated && <p className="list-cap-note">Showing the latest {FETCH_ALL_LIMIT} documents.</p>}
          </>
        )}
      </section>

    </AppShell>
  );
}
