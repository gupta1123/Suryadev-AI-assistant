import { ArrowLeft, BadgeIndianRupee, CalendarDays, MessageCircle, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type DeliveryConfig,
  type PaymentFollowUpCase,
} from '../types';

export function PaymentFollowUpDetailPage({
  route,
  caseId,
  onNavigate,
  user,
  onLogout,
  loggingOut,
}: {
  route: AppRoute;
  caseId: number;
  onNavigate: (path: string) => void;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [paymentCase, setPaymentCase] = useState<PaymentFollowUpCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [nextConfig, nextCase] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${caseId}`),
      ]);
      setConfig(nextConfig);
      setPaymentCase(nextCase);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const latestJob = paymentCase?.jobs?.[0] ?? paymentCase?.latestJob;
  const latestMessage = relationOne(latestJob?.messages);
  const messageStatus = latestMessage?.status ?? latestJob?.status ?? paymentCase?.status ?? 'pending';
  const visibleMessageStatus = messageStatus === 'read' ? 'delivered' : messageStatus;

  return (
    <AppShell
      route={route}
      config={config}
      eyebrow="Payment follow-up agent"
      title={paymentCase?.invoice?.sap_billing_document ?? 'Payment case'}
      headerLeading={<button className="back-link" type="button" onClick={() => onNavigate('/payment-follow-ups')}><ArrowLeft size={15} /> Payment follow-ups</button>}
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    >
      {error && <div className="alert alert--error">{error}</div>}
      {loading && <div className="detail-skeleton"><span /><div><span /><span /></div></div>}
      {paymentCase && (
        <>
          <section className="status-banner-card">
            <span className="status-banner-icon"><BadgeIndianRupee size={18} /></span>
            <div className="status-banner-content">
              <h3>Payment reminder {visibleMessageStatus.replaceAll('_', ' ')}</h3>
              <p>{statusDescription(visibleMessageStatus)}</p>
            </div>
            <StatusBadge status={visibleMessageStatus} />
          </section>

          <section className="detail-summary-bar">
            <Summary icon={<UserRound size={18} />} label="Customer" value={paymentCase.customer?.display_name ?? '—'} />
            <Summary icon={<BadgeIndianRupee size={18} />} label="Outstanding" value={formatCurrency(Number(paymentCase.receivable?.outstanding_amount ?? 0), paymentCase.receivable?.currency)} />
            <Summary icon={<CalendarDays size={18} />} label="Due date" value={formatDate(paymentCase.receivable?.due_date)} />
            <Summary icon={<MessageCircle size={18} />} label="Next follow-up" value={formatDateTime(paymentCase.next_action_at)} />
          </section>

          <div className="payment-detail-layout">
            <section className="panel detail-section">
              <div className="section-heading section-heading--compact"><div><p className="eyebrow">Customer message</p><h2>Reminder history</h2></div></div>
              {paymentCase.jobs?.length ? paymentCase.jobs.map((job) => {
                const message = relationOne(job.messages);
                return (
                  <article className="payment-history-row" key={job.id}>
                    <div><StatusBadge status={message?.status ?? job.status} /><small>{formatDateTime(message?.sent_at ?? job.created_at)}</small></div>
                    <div><strong>Payment reminder</strong><p>{message?.body ?? `Reminder for invoice ${paymentCase.invoice?.sap_billing_document}`}</p></div>
                    {message?.failure_reason && <p className="attempt-error">{message.failure_reason}</p>}
                  </article>
                );
              }) : <div className="empty-inline">No reminder has been sent yet.</div>}
            </section>

            <aside className="panel detail-card">
              <h2>Payment details</h2>
              <dl>
                <div><dt>Invoice</dt><dd>{paymentCase.invoice?.sap_billing_document ?? '—'}</dd></div>
                <div><dt>Invoice date</dt><dd>{formatDate(paymentCase.invoice?.billing_document_date)}</dd></div>
                <div><dt>Invoice amount</dt><dd>{formatCurrency(Number(paymentCase.receivable?.original_amount ?? 0), paymentCase.receivable?.currency)}</dd></div>
                <div><dt>Paid</dt><dd>{formatCurrency(Number(paymentCase.receivable?.paid_amount ?? 0), paymentCase.receivable?.currency)}</dd></div>
                <div><dt>Payment status</dt><dd>{paymentCase.receivable?.payment_status.replaceAll('_', ' ') ?? '—'}</dd></div>
                <div><dt>Data source</dt><dd>SAP invoice + test payment status</dd></div>
              </dl>
            </aside>
          </div>
        </>
      )}
    </AppShell>
  );
}

function Summary({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="summary-tile"><span className="summary-tile__icon">{icon}</span><div className="summary-tile__info"><small>{label}</small><strong>{value}</strong></div></div>;
}

function statusDescription(status: string): string {
  if (status === 'delivered') return 'The reminder reached the test recipient’s device.';
  if (status === 'sent' || status === 'accepted' || status === 'completed') return 'MSG91 accepted the reminder and delivery tracking is active.';
  if (status === 'failed') return 'The reminder could not be sent. Review the message below.';
  return 'The reminder is waiting to be processed.';
}
