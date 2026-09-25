import { AlertCircle, BadgeIndianRupee, Check, CheckCheck, Clock3 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type PaymentFollowUpCase,
  type PaymentReminderJob,
} from '../types';

type Tone = 'queued' | 'sent' | 'delivered' | 'failed';

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
  const [paymentCase, setPaymentCase] = useState<PaymentFollowUpCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const nextCase = await apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${caseId}`);
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

  const receivable = paymentCase?.receivable;
  const currency = receivable?.currency ?? paymentCase?.invoice?.transaction_currency ?? 'INR';
  const original = Number(receivable?.original_amount ?? paymentCase?.invoice?.total_gross_amount ?? 0);
  const paid = Number(receivable?.paid_amount ?? 0);
  const outstanding = Number(receivable?.outstanding_amount ?? 0);
  const paidShare = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
  const daysOverdue = receivable?.days_overdue ?? 0;
  const settled = Boolean(paymentCase?.resolved_at) || (receivable !== null && receivable !== undefined && outstanding <= 0);
  const jobs = paymentCase?.jobs ?? (paymentCase?.latestJob ? [paymentCase.latestJob] : []);
  const sentCount = jobs.filter((job) => ['sent', 'delivered'].includes(toneOf(job))).length;

  const headline = settled
    ? { tone: 'settled', title: 'Paid in full', detail: 'No more reminders will be sent.' }
    : daysOverdue > 0
      ? { tone: 'overdue', title: `Overdue by ${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'}`, detail: paymentCase?.next_action_at ? `Next reminder: ${formatDateTime(paymentCase.next_action_at)}.` : 'No more reminders planned.' }
      : { tone: 'current', title: 'Not yet due', detail: receivable?.due_date ? `Due on ${formatDate(receivable.due_date)}.` : 'No due date yet.' };

  return (
    <AppShell
      route={route}
      eyebrow={paymentCase?.customer?.display_name ?? (paymentCase ? 'Customer unavailable' : undefined)}
      title={paymentCase?.invoice?.sap_billing_document ? `Invoice ${paymentCase.invoice.sap_billing_document}` : 'Payment case'}
      headerLeading={<BackLink fallbackPath="/payments" fallbackLabel="Payments" onNavigate={onNavigate} />}
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    >
      {error && <div className="alert alert--error">{error}</div>}
      {loading && <div className="detail-skeleton"><span /><div><span /><span /></div></div>}
      {paymentCase && (
        <>
          <section className={`dt-hero dt-hero--${headline.tone}`} aria-label="Payment status">
            <div className="dt-hero__status">
              <span className="dt-hero__icon">
                {headline.tone === 'settled' ? <CheckCheck size={20} /> : headline.tone === 'overdue' ? <AlertCircle size={20} /> : <Clock3 size={20} />}
              </span>
              <div>
                <h2>{headline.title}</h2>
                <p>{headline.detail}</p>
              </div>
            </div>
            <dl className="dt-facts">
              <div><dt>Customer</dt><dd>{paymentCase.customer?.id ? <button className="dt-inline-link" type="button" onClick={() => onNavigate(`/customers/${paymentCase.customer!.id}`)}>{paymentCase.customer.display_name}</button> : '—'}</dd></div>
              <div><dt>Still to pay</dt><dd>{receivable ? formatCurrency(outstanding, currency) : '—'}</dd></div>
              <div><dt>Due date</dt><dd>{formatDate(receivable?.due_date)}</dd></div>
              <div><dt>Reminders sent</dt><dd>{sentCount}</dd></div>
            </dl>
          </section>

          <div className="dt-layout dt-layout--payment">
            <section className="dt-section" aria-label="Reminder history">
              <header className="dt-section__head">
                <h3>Reminders</h3>
                <span>{jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'reminder' : 'reminders'} on WhatsApp` : 'None sent yet'}</span>
              </header>
              {jobs.length === 0 ? (
                <div className="dt-empty">
                  <BadgeIndianRupee size={22} aria-hidden="true" />
                  <strong>No reminders sent yet</strong>
                  <p>{paymentCase.next_action_at ? `The first one goes out ${formatDateTime(paymentCase.next_action_at)}.` : 'Reminders start if the invoice isn’t paid on time.'}</p>
                </div>
              ) : (
                <ol className="dt-reminders">
                  {jobs.map((job, index) => {
                    const message = relationOne(job.messages);
                    const tone = toneOf(job);
                    return (
                      <li key={job.id}>
                        <div className="dt-reminders__meta">
                          <strong>Reminder {jobs.length - index}</strong>
                          <small>{formatDateTime(message?.sent_at ?? job.created_at)}</small>
                          <StatusBadge status={message?.status ?? job.status} />
                        </div>
                        <div className="dt-chat dt-chat--compact">
                          <div className="dt-bubble">
                            <p>{message?.body ?? `Payment reminder for invoice ${paymentCase.invoice?.sap_billing_document ?? ''}`.trim()}</p>
                            <span className="dt-bubble__meta">
                              {formatTime(message?.sent_at ?? job.created_at)}
                              <ReminderTicks tone={tone} />
                            </span>
                          </div>
                        </div>
                        {(message?.failure_reason || job.last_error) && (
                          <p className="dt-timeline__note">{message?.failure_reason ?? job.last_error}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <aside className="dt-section" aria-label="Payment details">
              <header className="dt-section__head"><h3>Payment</h3></header>
              <div className="dt-paid">
                <div className="dt-paid__row">
                  <span>Paid</span>
                  <strong>{formatCurrency(paid, currency)} <small>of {formatCurrency(original, currency)}</small></strong>
                </div>
                <div className="dt-paid__track" role="img" aria-label={`${paidShare}% paid`}><span style={{ width: `${paidShare}%` }} /></div>
              </div>
              <dl className="dt-details dt-details--single">
                <div><dt>Invoice</dt><dd>{paymentCase.invoice?.sap_billing_document ?? '—'}</dd></div>
                <div><dt>Invoice date</dt><dd>{formatDate(paymentCase.invoice?.billing_document_date)}</dd></div>
                <div><dt>Payment status</dt><dd>{receivable?.payment_status ? humanize(receivable.payment_status) : '—'}</dd></div>
                <div><dt>How late</dt><dd>{receivable?.aging_bucket ? humanize(receivable.aging_bucket) : '—'}</dd></div>
                <div><dt>Customer code</dt><dd>{paymentCase.customer?.sap_customer_number ?? '—'}</dd></div>
                <div><dt>Last reminder</dt><dd>{formatDateTime(paymentCase.last_reminder_at)}</dd></div>
                <div><dt>Next reminder</dt><dd>{settled ? '—' : formatDateTime(paymentCase.next_action_at)}</dd></div>
                <div><dt>Last updated</dt><dd>{formatDateTime(receivable?.last_synced_at)}</dd></div>
              </dl>
            </aside>
          </div>
        </>
      )}
    </AppShell>
  );
}

function toneOf(job: PaymentReminderJob): Tone {
  const message = relationOne(job.messages);
  const status = (message?.status ?? job.status).toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'read') return 'delivered';
  if (status === 'delivered' || message?.delivered_at) return 'delivered';
  if (status === 'sent' || status === 'completed' || message?.sent_at) return 'sent';
  return 'queued';
}

function ReminderTicks({ tone }: { tone: Tone }) {
  if (tone === 'failed') return <AlertCircle className="dt-ticks dt-ticks--failed" size={13} aria-label="Failed" />;
  if (tone === 'queued') return <Clock3 className="dt-ticks" size={12} aria-label="Queued" />;
  if (tone === 'sent') return <Check className="dt-ticks" size={14} aria-label="Sent" />;
  return <CheckCheck className="dt-ticks" size={14} aria-label="Delivered" />;
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}

function humanize(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
