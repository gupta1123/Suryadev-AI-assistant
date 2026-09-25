import { AlertCircle, BadgeIndianRupee, CheckCheck, ChevronRight, LifeBuoy, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { FilterBar, matchesSearch } from '../components/FilterBar';
import { PaginationControls, usePagination } from '../components/PaginationControls';
import { apiRequest } from '../lib/api';
import { formatDateTime, toMessage } from '../lib/format';
import { invalidateInbox, loadInbox, type InboxItem, type InboxKind } from '../lib/inbox';
import type { AdminUser, AppRoute } from '../types';

type Tab = 'all' | InboxKind;

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'failed', label: 'Not delivered' },
  { key: 'reply', label: 'Customer replies' },
  { key: 'overdue', label: 'Late payments' },
];

const KIND_ICON = { failed: AlertCircle, reply: LifeBuoy, overdue: BadgeIndianRupee } as const;

export function InboxPage({
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
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      setItems(await loadInbox(force));
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const counts = useMemo(() => ({
    all: items.length,
    failed: items.filter((item) => item.kind === 'failed').length,
    reply: items.filter((item) => item.kind === 'reply').length,
    overdue: items.filter((item) => item.kind === 'overdue').length,
  }), [items]);

  const visible = useMemo(() => items.filter((item) =>
    (tab === 'all' || item.kind === tab) && matchesSearch(search, item.customer, item.title, item.detail)), [items, tab, search]);
  const pagination = usePagination(visible, 'inbox', `${tab}|${search}`);

  async function act(item: InboxItem, action: () => Promise<unknown>) {
    setBusyKey(item.key);
    setError('');
    try {
      await action();
      invalidateInbox();
      await load(true);
    } catch (actionError) {
      setError(toMessage(actionError));
    } finally {
      setBusyKey(null);
    }
  }

  function openItem(item: InboxItem) {
    if (item.job) onNavigate(`/documents/${item.job.id}`);
    else if (item.paymentCase) onNavigate(`/payments/${item.paymentCase.id}`);
    else if (item.help?.communicationJobId) onNavigate(`/documents/${item.help.communicationJobId}`);
    else if (item.customerId) onNavigate(`/customers/${item.customerId}`);
  }

  return (
    <AppShell
      route={route}
      eyebrow="Things your team should look at"
      title="Needs attention"
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
        <div className="seg-tabs" role="tablist" aria-label="Filter">
          {TABS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'seg-tab seg-tab--active' : 'seg-tab'} type="button" onClick={() => setTab(key)}>
              {key !== 'all' && <i className={`seg-tab__dot seg-tab__dot--${key}`} />}
              {label}
              <span>{counts[key]}</span>
            </button>
          ))}
        </div>

        <FilterBar search={search} searchPlaceholder="Search by customer or invoice" onSearchChange={setSearch} active={Boolean(search)} onClear={() => setSearch('')} />

        {loading ? (
          <div className="table-skeleton"><span /><span /><span /></div>
        ) : visible.length === 0 ? (
          <div className="inbox-empty">
            <span><CheckCheck size={24} aria-hidden="true" /></span>
            <strong>{search ? 'Nothing matches your search' : 'You’re all caught up'}</strong>
            <p>{search ? 'Try a different name or invoice number.' : 'Failed messages, customer replies and late payments will show up here.'}</p>
          </div>
        ) : (
          <>
            <ul className="inbox-list">
              {pagination.pageRows.map((item) => {
                const Icon = KIND_ICON[item.kind];
                const busy = busyKey === item.key;
                return (
                  <li key={item.key} className={`inbox-item inbox-item--${item.kind}`}>
                    <span className="inbox-item__icon"><Icon size={16} aria-hidden="true" /></span>
                    <button className="inbox-item__main" type="button" onClick={() => openItem(item)}>
                      <span className="inbox-item__top">
                        <strong>{item.customer}</strong>
                        <small>{formatDateTime(item.at)}</small>
                      </span>
                      <span className="inbox-item__title">{item.title}</span>
                      <span className="inbox-item__detail">{item.detail}</span>
                    </button>
                    <div className="inbox-item__actions">
                      {item.kind === 'failed' && item.job && (
                        <button className="button button--primary button--compact" type="button" disabled={busy}
                          onClick={() => void act(item, () => apiRequest(`/invoice-delivery/jobs/${item.job!.id}/retry`, { method: 'POST' }))}>
                          <RotateCcw size={14} aria-hidden="true" /> {busy ? 'Sending…' : 'Try again'}
                        </button>
                      )}
                      {item.kind === 'reply' && item.help && (
                        item.help.status === 'open' ? (
                          <button className="button button--secondary button--compact" type="button" disabled={busy}
                            onClick={() => void act(item, () => apiRequest(`/invoice-delivery/help-requests/${item.help!.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) }))}>
                            Start
                          </button>
                        ) : (
                          <button className="button button--primary button--compact" type="button" disabled={busy}
                            onClick={() => void act(item, () => apiRequest(`/invoice-delivery/help-requests/${item.help!.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }))}>
                            <CheckCheck size={14} aria-hidden="true" /> Mark done
                          </button>
                        )
                      )}
                      <button className="inbox-item__open" type="button" onClick={() => openItem(item)} aria-label="Open">
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <PaginationControls
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              total={pagination.total}
              noun="items"
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </section>
    </AppShell>
  );
}
