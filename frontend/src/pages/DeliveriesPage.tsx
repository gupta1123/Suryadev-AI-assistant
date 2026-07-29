import { RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { DeliveryTable } from '../components/DeliveryTable';
import { SendInvoiceModal } from '../components/SendInvoiceModal';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import type { AdminUser, AppRoute, DeliveryConfig, DeliveryJob } from '../types';

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextConfig, nextJobs] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        apiRequest<DeliveryJob[]>('/invoice-delivery/jobs?limit=100'),
      ]);
      setConfig(nextConfig);
      setJobs(nextJobs);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return (
    <AppShell
      route={route}
      config={config}
      eyebrow="Invoice delivery agent"
      title="Deliveries"
      onNavigate={onNavigate}
      onNewDelivery={config?.invoiceSource === 'sap' ? undefined : () => setModalOpen(true)}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={config?.invoiceSource !== 'sap' ? (
        <button className="button button--primary" type="button" disabled={!config} onClick={() => setModalOpen(true)}>
          <Send size={16} aria-hidden="true" /> New test delivery
        </button>
      ) : undefined}
    >
      {error && <div className="alert alert--error">{error}</div>}
      <section className="panel deliveries-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Communication history</p>
            <h2>All invoice deliveries</h2>
            <p className="section-description">One record per invoice destination. Open any row for its complete audit trail.</p>
          </div>
          <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : <DeliveryTable jobs={jobs} onOpen={(jobId) => onNavigate(`/deliveries/${jobId}`)} />}
      </section>

      {modalOpen && config?.invoiceSource === 'fixture' && (
        <SendInvoiceModal
          config={config}
          onClose={() => setModalOpen(false)}
          onComplete={(jobId) => { setModalOpen(false); onNavigate(`/deliveries/${jobId}`); }}
        />
      )}
    </AppShell>
  );
}
