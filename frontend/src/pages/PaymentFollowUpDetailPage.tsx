import { AlertCircle, BadgeIndianRupee, Check, CheckCheck, CircleCheck, Clock3, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type PaymentFollowUpCase,
  type PaymentFollowUpConfig,
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
  const [confirmingPaid, setConfirmingPaid] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [markPaidError, setMarkPaidError] = useState('');
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');
  const [restartNotice, setRestartNotice] = useState<{ repeatSeconds: number; maximum: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  useEffect(() => {
    if (!restartNotice) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [restartNotice]);

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

  const confirmation = receivable?.raw_data?.payment_confirmation;

  async function markPaid() {
    setMarkingPaid(true);
    setMarkPaidError('');
    try {
      setPaymentCase(await apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${caseId}/mark-paid`, { method: 'POST' }));
      setConfirmingPaid(false);
    } catch (markError) {
      setMarkPaidError(toMessage(markError));
    } finally {
      setMarkingPaid(false);
    }
  }

  async function restartReminders() {
    setRestarting(true);
    setRestartError('');
    try {
      await apiRequest(`/payment-follow-up/cases/${caseId}/restart`, { method: 'POST', body: JSON.stringify({}) });
      const config = await apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config').catch(() => null);
      await load();
      setRestartNotice(config ? { repeatSeconds: config.repeatReminderDelaySeconds, maximum: config.maximumTestReminders } : { repeatSeconds: 0, maximum: 0 });
      setNow(Date.now());
      setConfirmingRestart(false);
    } catch (restartFailure) {
      setRestartError(toMessage(restartFailure));
    } finally {
      setRestarting(false);
    }
  }

  const headline = settled
    ? confirmation?.source === 'marked_paid_in_dashboard'
      ? { tone: 'settled', title: 'Marked as paid', detail: `Marked paid${confirmation.marked_by ? ` by ${confirmation.marked_by}` : ''} ${formatDateTime(confirmation.confirmed_at)}. No more reminders will be sent.` }
      : { tone: 'settled', title: 'Paid in full', detail: 'No more reminders will be sent.' }
    : daysOverdue > 0
      ? { tone: 'overdue', title: `Overdue by ${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'}`, detail: paymentCase?.next_action_at ? `Next reminder: ${formatDateTime(paymentCase.next_action_at)}.` : 'No more reminders planned.' }
      : receivable?.aging_bucket === 'due'
        ? { tone: 'current', title: 'Due today', detail: paymentCase?.next_action_at ? `Next reminder: ${formatDateTime(paymentCase.next_action_at)}.` : 'Payment is due today.' }
        : { tone: 'current', title: 'Not yet due', detail: receivable?.due_date ? `Due on ${formatDate(receivable.due_date)}.` : 'No due date yet.' };

  return (
    <AppShell
      route={route}
      eyebrow={paymentCase?.customer?.display_name ?? (paymentCase ? 'Customer unavailable' : undefined)}
      title={paymentCase?.invoice?.sap_billing_document ? `Invoice ${paymentCase.invoice.sap_billing_document}` : 'Payment case'}
      headerLeading={<BackLink fallbackPath="/payments" fallbackLabel="Payments" onNavigate={onNavigate} />}
      actions={paymentCase && (!settled || paymentCase.restartable) ? (
        <>
          {paymentCase.restartable && (
            <button className="button button--secondary" type="button" onClick={() => { setRestartError(''); setConfirmingRestart(true); }}>
              <RotateCcw size={15} aria-hidden="true" /> Restart reminders
            </button>
          )}
          {!settled && (
            <button className="button button--primary" type="button" onClick={() => { setMarkPaidError(''); setConfirmingPaid(true); }}>
              <CircleCheck size={15} aria-hidden="true" /> Mark as paid
            </button>
          )}
        </>
      ) : undefined}
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    >
      {error && <div className="alert alert--error">{error}</div>}
      {restartNotice && paymentCase && (
        <div className="alert alert--info run-notice" role="status">
          <RotateCcw size={15} aria-hidden="true" />
          <span>{restartNoticeText(paymentCase, jobs.length, restartNotice, now, settled)}</span>
          <button className="icon-button" type="button" onClick={() => setRestartNotice(null)} aria-label="Dismiss">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
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
              <div><dt>Customer</dt><dd>{paymentCase.customer?.id ? <button className="dt-inline-link" type="button" onClick={() => onNavigate(`/customers/${paymentCase.customer!.id}`)}>{paymentCase.customer.display_name}</button> : '—'}{paymentCase.whatsappNumber && <small className="dt-facts__sub mono">{paymentCase.whatsappNumber}</small>}</dd></div>
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
                <div><dt>WhatsApp number</dt><dd className="mono">{paymentCase.whatsappNumber ?? '—'}</dd></div>
                <div><dt>Last reminder</dt><dd>{formatDateTime(paymentCase.last_reminder_at)}</dd></div>
                <div><dt>Next reminder</dt><dd>{settled ? '—' : formatDateTime(paymentCase.next_action_at)}</dd></div>
                <div><dt>Last updated</dt><dd>{formatDateTime(receivable?.last_synced_at)}</dd></div>
              </dl>
            </aside>
          </div>
        </>
      )}
      {confirmingPaid && paymentCase && (
        <Modal
          title="Mark this invoice as paid?"
          description="Reminders for this invoice stop right away. Only do this once the payment has been received."
          onClose={() => { if (!markingPaid) setConfirmingPaid(false); }}
        >
          <dl className="dt-details dt-details--single">
            <div><dt>Customer</dt><dd>{paymentCase.customer?.display_name ?? '—'}</dd></div>
            <div><dt>Invoice</dt><dd>{paymentCase.invoice?.sap_billing_document ?? '—'}</dd></div>
            <div><dt>Amount received</dt><dd>{receivable ? formatCurrency(outstanding, currency) : '—'}</dd></div>
          </dl>
          {markPaidError && <div className="alert alert--error">{markPaidError}</div>}
          <div className="modal-footer">
            <button className="button button--secondary" type="button" disabled={markingPaid} onClick={() => setConfirmingPaid(false)}>Cancel</button>
            <button className="button button--primary" type="button" disabled={markingPaid} onClick={() => void markPaid()}>
              <CircleCheck size={15} aria-hidden="true" /> {markingPaid ? 'Marking…' : 'Mark as paid'}
            </button>
          </div>
        </Modal>
      )}
      {confirmingRestart && paymentCase && (
        <Modal
          title="Restart reminders for this invoice?"
          description="The invoice is set back to unpaid and a fresh round of WhatsApp reminders starts now, on the timing set in Settings. The invoice itself is not sent again."
          onClose={() => { if (!restarting) setConfirmingRestart(false); }}
        >
          <dl className="dt-details dt-details--single">
            <div><dt>Customer</dt><dd>{paymentCase.customer?.display_name ?? '—'}</dd></div>
            <div><dt>Invoice</dt><dd>{paymentCase.invoice?.sap_billing_document ?? '—'}</dd></div>
            <div><dt>Reminders go to</dt><dd className="mono">{paymentCase.whatsappNumber ?? '—'}</dd></div>
            <div><dt>Amount due</dt><dd>{formatCurrency(original, currency)}</dd></div>
          </dl>
          {restartError && <div className="alert alert--error">{restartError}</div>}
          <div className="modal-footer">
            <button className="button button--secondary" type="button" disabled={restarting} onClick={() => setConfirmingRestart(false)}>Cancel</button>
            <button className="button button--primary" type="button" disabled={restarting} onClick={() => void restartReminders()}>
              <RotateCcw size={15} aria-hidden="true" /> {restarting ? 'Restarting…' : 'Restart reminders'}
            </button>
          </div>
        </Modal>
      )}
    </AppShell>
  );
}

function restartNoticeText(
  paymentCase: PaymentFollowUpCase,
  sentCount: number,
  notice: { repeatSeconds: number; maximum: number },
  now: number,
  settled: boolean,
): string {
  if (settled) return 'Marked as paid. No more reminders will be sent.';
  const next = paymentCase.next_action_at ? new Date(paymentCase.next_action_at).getTime() : null;
  const when = next ? `${next > now ? `in ${countdown(next - now)}` : 'any moment now'} (at ${formatTime(paymentCase.next_action_at)})` : '';
  const cadence = notice.repeatSeconds && notice.maximum
    ? `, then every ${spokenDuration(notice.repeatSeconds)}, up to ${notice.maximum} ${notice.maximum === 1 ? 'reminder' : 'reminders'}`
    : '';
  if (sentCount === 0) {
    return next ? `Reminders restarted. First reminder ${when}${cadence}.` : 'Reminders restarted. Sending the first reminder…';
  }
  if (notice.maximum && sentCount >= notice.maximum) return `All ${sentCount} reminders sent. This run is finished.`;
  return next
    ? `Reminder ${sentCount} sent. Next reminder ${when}.`
    : `Reminder ${sentCount} sent. Waiting for WhatsApp to confirm delivery before scheduling the next one.`;
}

function countdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function spokenDuration(seconds: number): string {
  const units: Array<[number, string]> = [[86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [size, unit] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
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
