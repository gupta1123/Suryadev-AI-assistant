import { CheckCircle2, Clock3, LifeBuoy, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDateTime, toMessage } from '../lib/format';
import type {
  AdminUser,
  AppRoute,
  DeliveryConfig,
  HelpRequest,
  HelpRequestStatus,
} from '../types';

type HelpFilter = 'all' | HelpRequestStatus;

export function HelpRequestsPage({
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
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const [filter, setFilter] = useState<HelpFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      if (silent) {
        setRequests(await apiRequest<HelpRequest[]>('/invoice-delivery/help-requests'));
      } else {
        const [nextConfig, nextRequests] = await Promise.all([
          apiRequest<DeliveryConfig>('/invoice-delivery/config'),
          apiRequest<HelpRequest[]>('/invoice-delivery/help-requests'),
        ]);
        setConfig(nextConfig);
        setRequests(nextRequests);
      }
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(interval);
  }, [load]);

  const counts = useMemo(() => ({
    all: requests.length,
    open: requests.filter((request) => request.status === 'open').length,
    in_progress: requests.filter((request) => request.status === 'in_progress').length,
    resolved: requests.filter((request) => request.status === 'resolved').length,
  }), [requests]);
  const visibleRequests = filter === 'all'
    ? requests
    : requests.filter((request) => request.status === filter);

  async function updateStatus(id: number, status: HelpRequestStatus) {
    setUpdatingId(id);
    setError('');
    try {
      await apiRequest(`/invoice-delivery/help-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setRequests((current) => current.map((request) => (
        request.id === id
          ? { ...request, status, resolvedAt: status === 'resolved' ? new Date().toISOString() : null }
          : request
      )));
    } catch (updateError) {
      setError(toMessage(updateError));
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <AppShell
      route={route}
      config={config}
      eyebrow="Customer assistance"
      title="Help requests"
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

      <section className="help-summary" aria-label="Help request summary">
        <div><LifeBuoy size={18} /><span>Open</span><strong>{counts.open}</strong></div>
        <div><Clock3 size={18} /><span>In progress</span><strong>{counts.in_progress}</strong></div>
        <div><CheckCircle2 size={18} /><span>Resolved</span><strong>{counts.resolved}</strong></div>
      </section>

      <section className="panel help-panel">
        <div className="section-heading help-heading">
          <div>
            <p className="eyebrow">WhatsApp responses</p>
            <h2>Customers who need assistance</h2>
            <p className="section-description">Each request is linked to the exact invoice message the customer answered.</p>
          </div>
          <div className="help-filters" role="group" aria-label="Filter help requests">
            {(['all', 'open', 'in_progress', 'resolved'] as const).map((value) => (
              <button
                className={filter === value ? 'help-filter help-filter--active' : 'help-filter'}
                type="button"
                key={value}
                onClick={() => setFilter(value)}
              >
                {filterLabel(value)} <span>{counts[value]}</span>
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="table-skeleton"><span /><span /><span /></div>
        ) : visibleRequests.length === 0 ? (
          <div className="empty-table help-empty">
            <LifeBuoy size={28} aria-hidden="true" />
            <strong>No {filter === 'all' ? '' : `${filterLabel(filter).toLowerCase()} `}help requests</strong>
            <p>When a customer selects “Need Help” on an invoice message, it will appear here automatically.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="delivery-table help-table">
              <thead>
                <tr><th>Customer</th><th>Invoice</th><th>Requested</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {visibleRequests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{request.customer?.name ?? 'Customer'}</strong>
                      <small>{request.customer?.sapCustomerNumber ? `Customer #${request.customer.sapCustomerNumber}` : request.buttonText}</small>
                    </td>
                    <td>
                      <strong className="invoice-number">{request.invoice?.billingDocument ?? 'Invoice unavailable'}</strong>
                      <small>{request.invoice ? formatCurrency(request.invoice.totalGrossAmount ?? 0, request.invoice.currency) : '—'}</small>
                    </td>
                    <td>{formatDateTime(request.requestedAt)}</td>
                    <td><StatusBadge status={request.status} /></td>
                    <td>
                      <div className="help-actions">
                        {request.communicationJobId && (
                          <button className="text-button" type="button" onClick={() => onNavigate(`/deliveries/${request.communicationJobId}`)}>
                            View invoice
                          </button>
                        )}
                        {request.status === 'open' && (
                          <button className="button button--secondary button--compact" type="button" disabled={updatingId === request.id} onClick={() => void updateStatus(request.id, 'in_progress')}>
                            Start working
                          </button>
                        )}
                        {request.status === 'in_progress' && (
                          <button className="button button--primary button--compact" type="button" disabled={updatingId === request.id} onClick={() => void updateStatus(request.id, 'resolved')}>
                            <CheckCircle2 size={14} /> Resolve
                          </button>
                        )}
                        {request.status === 'resolved' && (
                          <button className="button button--secondary button--compact" type="button" disabled={updatingId === request.id} onClick={() => void updateStatus(request.id, 'open')}>
                            <RotateCcw size={14} /> Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function filterLabel(filter: HelpFilter): string {
  if (filter === 'all') return 'All';
  if (filter === 'in_progress') return 'In progress';
  return filter[0].toUpperCase() + filter.slice(1);
}
