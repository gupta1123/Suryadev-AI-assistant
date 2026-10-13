import { ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { FilterSelect } from '../components/FilterBar';
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
      const next = await apiRequest<CopyPage>(`/invoice-delivery/marketing-copies?${query}`);
      if (requestId !== sequence.current) return;
      setData(next); setError('');
      if (page > next.pageCount) setPage(next.pageCount);
    } catch (e) {
      if (requestId === sequence.current) setError(toMessage(e));
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [page, pageSize, status, kind]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 15000);
    return () => { window.clearInterval(timer); sequence.current++; };
  }, [load]);
  return (
    <AppShell {...props} title="Marketing manager" eyebrow="Customer message copies" actions={
      <button className="button button--secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
    }>
      <section className="manager-copies" aria-label="Marketing manager message history">
        <div className="manager-copies__intro">
          <div><strong>{data?.recipient ?? 'Loading recipient…'}</strong><p>Same templates and PDFs as the customer messages. {data ? `Copy sending is ${data.enabled ? 'on' : 'off'}.` : ''}</p></div>
          <small>Provider accepted does not mean delivered or read. Customer receipts remain separate.</small>
        </div>
        <div className="manager-copies__filters">
          <FilterSelect label="Status" value={status} options={STATUSES} onChange={(value) => { setStatus(value); setPage(1); }} />
          <FilterSelect label="Message" value={kind} options={[{ value: 'documents', label: 'Documents' }, { value: 'reminders', label: 'Payment reminders' }]} onChange={(value) => { setKind(value); setPage(1); }} />
          <span>{data?.total ?? 0} copies</span>
        </div>
        {error && <p role="alert" className="manager-copies__error">{error}</p>}
        {!data && loading ? <p className="manager-copies__empty">Loading copies…</p> : !data?.items.length ? (
          <p className="manager-copies__empty">{error ? 'Could not load copies. Please refresh.' : 'No matching copies yet. Only messages sent after copying was enabled appear here.'}</p>
        ) : (
          <div className="manager-copies__table-wrap"><table>
            <thead><tr><th>Customer</th><th>Message</th><th>Copied to</th><th>Copy status</th><th>Queued / accepted</th><th><span className="sr-only">Open original</span></th></tr></thead>
            <tbody>{data.items.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.customerName}</strong><small>{row.customerNumber ?? '—'}</small></td>
                <td><strong>{row.documentNumber ?? '—'}</strong><small>{row.kind === 'reminder' ? 'Payment reminder' : billingDocumentLabel(row.documentType)}</small></td>
                <td className="mono">{row.recipient}</td>
                <td><span className="manager-copy-badge" data-copy-status={row.status}>{STATUSES.find((item) => item.value === row.status)?.label ?? row.status}</span>{row.lastError && <details><summary>Details</summary><small>{row.lastError}</small></details>}</td>
                <td>{formatDateTime(row.acceptedAt ?? row.createdAt)}<small>{row.acceptedAt ? 'Provider accepted' : 'Queued'} · {row.attemptCount} attempts</small></td>
                <td>{row.sourcePath && <button className="button button--secondary" onClick={() => props.onNavigate(row.sourcePath!)} aria-label={`Open original message ${row.documentNumber ?? row.id}`}><ExternalLink size={14} /> Original</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data && <PaginationControls page={page} pageCount={data.pageCount} pageSize={pageSize} total={data.total} noun="copies" onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} disabled={loading} />}
      </section>
    </AppShell>
  );
}
