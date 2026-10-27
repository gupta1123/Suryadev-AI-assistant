import { ArrowRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { DATE_RANGE_OPTIONS, FilterBar, FilterSelect } from '../components/FilterBar';
import { PaginationControls } from '../components/PaginationControls';
import { apiRequest } from '../lib/api';
import { billingDocumentLabel } from '../lib/billing-documents';
import { formatDateTime, toMessage } from '../lib/format';
import type { AdminUser, AppRoute } from '../types';

type CopyRow = {
  id: number; sourceJobId: number; recipient: string; status: string;
  attemptCount: number; acceptedAt: string | null; lastError: string | null;
  createdAt: string; customerName: string; customerNumber: string | null;
  documentNumber: string | null; documentType: string | null;
  kind: 'document' | 'reminder'; sourcePath: string | null;
};
type CopyPage = {
  items: CopyRow[]; total: number; page: number; pageCount: number;
  enabled: boolean; recipient: string;
};
const STATUSES = [
  { value: 'pending', label: 'Queued' }, { value: 'processing', label: 'Sending' },
  { value: 'accepted', label: 'Provider accepted' }, { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Outcome unknown' },
];

export function MarketingManagerPage(props: {
  route: AppRoute; onNavigate: (path: string) => void; user: AdminUser;
  onLogout: () => Promise<void>; loggingOut: boolean;
}) {
  const [data, setData] = useState<CopyPage | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [range, setRange] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async (silent = false) => {
    const requestId = ++sequence.current;
    if (!silent) setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) query.set('status', status);
      if (kind) query.set('kind', kind);
      if (type) query.set('documentType', type);
      if (debouncedSearch) query.set('search', debouncedSearch);
      if (range) query.set('rangeDays', range);
      const next = await apiRequest<CopyPage>(`/invoice-delivery/marketing-copies?${query}`);
      if (requestId !== sequence.current) return;
      setData(next); setError('');
      if (page > next.pageCount) setPage(next.pageCount);
    } catch (e) {
      if (requestId === sequence.current) setError(toMessage(e));
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [page, pageSize, status, kind, type, debouncedSearch, range]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => { setPage(1); }, [debouncedSearch]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 15000);
    return () => { window.clearInterval(timer); sequence.current++; };
  }, [load]);
  return (
    <AppShell {...props} title="Manager copies" eyebrow="Customer message copies" actions={
      <button className="button button--secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
    }>
      <section className="list-section" aria-label="Marketing manager message history">
        <div className="manager-copies__intro">
          <div><strong>{data?.recipient ?? 'Loading recipient…'}</strong><p>Same templates and PDFs as the customer messages. {data ? `Copy sending is ${data.enabled ? 'on' : 'off'}.` : ''}</p></div>
          <small>Provider accepted does not mean delivered or read. Customer receipts remain separate.</small>
        </div>
        <div className="seg-tabs" role="tablist" aria-label="Copy document type">
          {[['', 'All'], ['F2', 'Invoices'], ['S1', 'Cancelled invoices'], ['G2', 'Credit memos'], ['CBRE', 'Return memos'], ['L2', 'Debit memos'], ['reminders', 'Payment reminders']].map(([value, label]) => (
            <button key={value || 'all'} role="tab" aria-selected={(kind === 'reminders' ? 'reminders' : type) === value} className={(kind === 'reminders' ? 'reminders' : type) === value ? 'seg-tab seg-tab--active' : 'seg-tab'} onClick={() => { setKind(value === 'reminders' ? 'reminders' : value ? 'documents' : ''); setType(value === 'reminders' ? '' : value); setPage(1); }}>{label}</button>
          ))}
        </div>
        <FilterBar search={search} searchPlaceholder="Search by invoice, customer or phone" onSearchChange={setSearch} active={Boolean(search || status || type || kind || range)} onClear={() => { setSearch(''); setStatus(''); setType(''); setKind(''); setRange(''); setPage(1); }}>
          <FilterSelect label="Status" value={status} options={STATUSES} onChange={(value) => { setStatus(value); setPage(1); }} />
          <FilterSelect label="Date" value={range} options={DATE_RANGE_OPTIONS} onChange={(value) => { setRange(value); setPage(1); }} />
        </FilterBar>
        {error && <p role="alert" className="manager-copies__error">{error}</p>}
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : !data?.items.length ? (
          <div className="empty-table"><strong>No matching copies</strong><p>{error ? 'Could not load copies. Please refresh.' : 'Try clearing filters. Only messages sent after copying was enabled appear here.'}</p></div>
        ) : (
          <div className="table-scroll"><table className="delivery-table">
            <thead><tr><th>Document</th><th>Type</th><th>Customer</th><th>Copied to</th><th>Status</th><th>Date</th><th><span className="sr-only">Open copy</span></th></tr></thead>
            <tbody>{data.items.map((row) => (
              <tr key={row.id}>
                <td><strong className="invoice-number">{row.documentNumber ?? '—'}</strong></td>
                <td><span className="document-type-code">{row.kind === 'reminder' ? 'Reminder' : row.documentType}</span><small>{row.kind === 'reminder' ? 'Payment reminder' : billingDocumentLabel(row.documentType)}</small></td>
                <td>{row.customerName}</td>
                <td className="mono">{row.recipient}</td>
                <td><span className="manager-copy-badge" data-copy-status={row.status}>{STATUSES.find((item) => item.value === row.status)?.label ?? row.status}</span>{row.lastError && <details><summary>Details</summary><small>{row.lastError}</small></details>}</td>
                <td>{formatDateTime(row.createdAt)}</td>
                <td><button className="row-open-button" onClick={() => props.onNavigate(`/marketing-manager/${row.id}`)} aria-label={`Open manager copy ${row.documentNumber ?? row.id}`}><ArrowRight size={17} /></button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data && <PaginationControls page={page} pageCount={data.pageCount} pageSize={pageSize} total={data.total} noun="copies" onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} disabled={loading} />}
      </section>
    </AppShell>
  );
}
