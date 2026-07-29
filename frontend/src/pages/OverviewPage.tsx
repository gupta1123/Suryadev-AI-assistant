import { Activity, CheckCircle2, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { DeliveryTable } from '../components/DeliveryTable';
import { SendInvoiceModal } from '../components/SendInvoiceModal';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type DeliveryConfig,
  type DeliveryJob,
  type SapPollingStatus,
} from '../types';

export function OverviewPage({
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
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [nextConfig, nextJobs] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        apiRequest<DeliveryJob[]>('/invoice-delivery/jobs?limit=20'),
      ]);
      setConfig(nextConfig);
      setJobs(nextJobs);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const deliveryStatus = (job: DeliveryJob) => relationOne(job.messages)?.status ?? job.status;
  const sent = jobs.filter((job) => ['sent', 'delivered', 'read'].includes(deliveryStatus(job))).length;
  const delivered = jobs.filter((job) => ['delivered', 'read'].includes(deliveryStatus(job))).length;
  const failed = jobs.filter((job) => deliveryStatus(job) === 'failed').length;
  const liveMode = config?.invoiceSource === 'sap';

  return (
    <AppShell
      route={route}
      config={config}
      eyebrow="Invoice delivery agent"
      title="Overview"
      onNavigate={onNavigate}
      onNewDelivery={liveMode ? undefined : () => setModalOpen(true)}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sap-status-pill">
            <span className="sap-dot" />
            {liveMode ? 'SAP connected' : 'Simulation ready'}
          </span>
          {!liveMode && (
            <button className="button button--primary" type="button" disabled={!config} onClick={() => setModalOpen(true)}>
              <Send size={16} aria-hidden="true" /> New test delivery
            </button>
          )}
        </div>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      <section className="metric-grid" aria-label="Delivery summary">
        <MetricCard label="Total deliveries" value={jobs.length} detail="All recorded jobs" icon={<Activity size={18} />} />
        <MetricCard label="Sent" value={sent} detail="Confirmed by MSG91" tone="success" icon={<CheckCircle2 size={18} />} />
        <MetricCard label="Delivered" value={delivered} detail="Reached recipient device" tone="success" icon={<CheckCircle2 size={18} />} />
        <MetricCard label="Failed" value={failed} detail="Needs review" tone={failed ? 'danger' : 'neutral'} icon={<TriangleAlert size={18} />} />
      </section>

      <section className="panel recent-panel">
        <div className="section-heading">
          <div><p className="eyebrow">Recent activity</p><h2>Latest deliveries</h2></div>
          <button className="text-button" type="button" onClick={() => onNavigate('/deliveries')}>View all deliveries</button>
        </div>
        {loading ? <TableSkeleton /> : <DeliveryTable jobs={jobs.slice(0, 5)} onOpen={(jobId) => onNavigate(`/deliveries/${jobId}`)} />}
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

function formatPollingTime(status: SapPollingStatus): string {
  if (!status?.last_completed_at) return status?.last_status === 'running' ? 'in progress' : 'not run yet';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(status.last_completed_at));
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  detail: string;
  icon: ReactNode;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__top"><span>{label}</span><i>{icon}</i></div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function TableSkeleton() {
  return <div className="table-skeleton"><span /><span /><span /></div>;
}
