import { AlertCircle, BadgeIndianRupee, BellRing, Check, CheckCheck, CircleCheck, Clock3, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { Modal } from '../components/Modal';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import { messageLifecycleState, type MessageLifecycleState } from '../lib/message-status';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type PaymentFollowUpCase,
  type PaymentFollowUpConfig,
  type PaymentReminderJob,
} from '../types';

type Tone = MessageLifecycleState;
type PageTone = 'paid' | 'late' | 'critical' | 'due' | 'calm';

type PaymentDetailsForm = {
  paymentDate: string;
  paymentMethod: string;
  referenceNumber: string;
  notes: string;
};

const PAYMENT_METHOD_OPTIONS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];

function emptyPaymentDetails(): PaymentDetailsForm {
  return { paymentDate: '', paymentMethod: '', referenceNumber: '', notes: '' };
}

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
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetailsForm>(emptyPaymentDetails);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');
  const [restartNotice, setRestartNotice] = useState<{ repeatSeconds: number; maximum: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadInFlight = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const nextCase = await apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${caseId}`);
      setPaymentCase(nextCase);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      loadInFlight.current = false;
    }
  }, [caseId]);

  useEffect(() => {
    void load();
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
  const sentCount = jobs.filter((job) => ['sent', 'delivered', 'read'].includes(toneOf(job))).length;
  const needsLiveRefresh = Boolean(paymentCase && !settled && (
    paymentCase.status === 'active' ||
    jobs.some((job) => {
      const messageStatus = relationOne(job.messages)?.status;
      return ['pending', 'awaiting_approval', 'queued', 'processing'].includes(job.status) ||
        ['queued', 'sent', 'delivered'].includes(messageStatus ?? '');
    })
  ));

  useEffect(() => {
    if (!needsLiveRefresh || confirmingPaid || confirmingRestart) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [confirmingPaid, confirmingRestart, load, needsLiveRefresh]);

  const confirmation = receivable?.raw_data?.payment_confirmation;
  const heroValue = receivable ? (settled ? original : outstanding) : 0;
  const shownAmount = useCountUp(heroValue);
  const chatRef = useRef<HTMLDivElement>(null);
  const hasCase = Boolean(paymentCase);
  useEffect(() => {
    // Like WhatsApp, open the conversation at the newest message.
    const thread = chatRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [hasCase, jobs.length]);

  async function markPaid() {
    setMarkingPaid(true);
    setMarkPaidError('');
    try {
      setPaymentCase(await apiRequest<PaymentFollowUpCase>(`/payment-follow-up/cases/${caseId}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify(paymentDetails),
      }));
      setConfirmingPaid(false);
      setPaymentDetails(emptyPaymentDetails());
    } catch (markError) {
      setMarkPaidError(toMessage(markError));
    } finally {
      setMarkingPaid(false);
    }
  }

  function openMarkPaid() {
    setMarkPaidError('');
    setPaymentDetails(emptyPaymentDetails());
    setConfirmingPaid(true);
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

  const invoiceNumber = paymentCase?.invoice?.sap_billing_document;
  const customer = paymentCase?.customer ?? null;
  const dueDate = receivable?.due_date;
  const untilDue = daysUntil(dueDate);
  const nextReminderAt = paymentCase?.next_action_at ?? null;
  const markedInDashboard = confirmation?.source === 'marked_paid_in_dashboard';

  const tone: PageTone = settled
    ? 'paid'
    : daysOverdue > 30 ? 'critical' : daysOverdue > 0 ? 'late' : receivable?.aging_bucket === 'due' ? 'due' : 'calm';
  const pill = settled
    ? (markedInDashboard ? 'Marked as paid' : 'Paid in full')
    : daysOverdue > 0
      ? `Overdue · ${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'}`
      : tone === 'due'
        ? 'Due today'
        : untilDue !== null && untilDue > 0 ? `Due in ${untilDue} ${untilDue === 1 ? 'day' : 'days'}` : 'Not yet due';
  const amountLabel = settled ? 'Invoice total' : paid > 0 ? 'Still to pay' : 'Amount due';
  const heroDetail = settled
    ? markedInDashboard
      ? `Recorded${confirmation?.marked_by ? ` by ${confirmation.marked_by}` : ''} on ${formatDateTime(confirmation?.confirmed_at)}`
      : 'The full amount has been received'
    : dueDate ? `${daysOverdue > 0 ? 'Was due' : 'Due'} on ${formatDate(dueDate)}` : 'No due date set yet';
  const money = moneyParts(shownAmount, currency);
  const initials = (customer?.display_name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join('');

  // Collection timeline: one axis scaled by real dates, so lateness and reminder spacing are visible at a glance.
  const nowMs = Date.now();
  const issueMs = parseDay(paymentCase?.invoice?.billing_document_date);
  const dueMs = parseDay(dueDate);
  const paidMs = settled ? Date.parse(confirmation?.payment_date ?? paymentCase?.resolved_at ?? '') : Number.NaN;
  const scheduledMs = !settled && nextReminderAt ? Date.parse(nextReminderAt) : Number.NaN;
  const points = jobs
    .map((job, index) => {
      const message = relationOne(job.messages);
      return { id: job.id, n: jobs.length - index, tone: toneOf(job), ms: Date.parse(message?.sent_at ?? job.created_at) };
    })
    .filter((point) => Number.isFinite(point.ms))
    .sort((a, b) => a.ms - b.ms);
  const runEndMs = settled ? (Number.isFinite(paidMs) ? paidMs : nowMs) : nowMs;
  const stamps = [issueMs, dueMs, runEndMs, scheduledMs, ...points.map((point) => point.ms)].filter((value) => Number.isFinite(value));
  const axisStart = Number.isFinite(issueMs) ? issueMs : Math.min(...stamps);
  const axisSpan = Math.max(Math.max(...stamps) - axisStart, 7 * 86_400_000) * 1.06;
  const at = (ms: number) => Math.min(100, Math.max(0, ((ms - axisStart) / axisSpan) * 100));
  const edgeLabels = [
    { key: 'issued', kicker: 'Issued', ms: issueMs, text: formatDate(paymentCase?.invoice?.billing_document_date) },
    { key: 'due', kicker: 'Due', ms: dueMs, text: formatDate(dueDate) },
    { key: 'paid', kicker: 'Paid', ms: paidMs, text: formatDate(confirmation?.payment_date ?? paymentCase?.resolved_at) },
  ]
    .filter((label) => Number.isFinite(label.ms))
    .sort((a, b) => a.ms - b.ms)
    .reduce<Array<{ key: string; kicker: string; text: string; x: number; row: number }>>((placed, label) => {
      const x = at(label.ms);
      const previous = placed[placed.length - 1];
      const row = previous && x - previous.x < 15 && previous.row === 0 ? 1 : 0;
      placed.push({ key: label.key, kicker: label.kicker, text: label.text, x, row });
      return placed;
    }, []);
  const lastReminderAt = paymentCase?.last_reminder_at ?? (points.length ? new Date(points[points.length - 1].ms).toISOString() : null);
  const legendTones = [...new Set(points.map((point) => point.tone))];
  const rulerSummary = `Timeline. Invoice issued ${formatDate(paymentCase?.invoice?.billing_document_date)}, due ${formatDate(dueDate)}, ${points.length} ${points.length === 1 ? 'reminder' : 'reminders'} sent${settled ? ', paid' : ''}.`;

  // Conversation, oldest first like WhatsApp itself.
  const thread = [...jobs].reverse().map((job, index) => {
    const message = relationOne(job.messages);
    const ms = Date.parse(message?.sent_at ?? job.created_at);
    return { job, message, n: index + 1, ms, tone: toneOf(job), failure: message?.failure_reason ?? job.last_error };
  });
  const days = thread.reduce<Array<{ key: string; label: string; items: typeof thread }>>((groups, item) => {
    const key = Number.isFinite(item.ms) ? indiaDay(new Date(item.ms)) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(key), items: [item] });
    return groups;
  }, []);
  const scheduledDay = Number.isFinite(scheduledMs) ? dayLabel(indiaDay(new Date(scheduledMs))) : null;

  return (
    <AppShell
      route={route}
      eyebrow={customer?.display_name ?? (paymentCase ? 'Customer unavailable' : undefined)}
      title={invoiceNumber ? `Invoice ${invoiceNumber}` : 'Payment case'}
      headerLeading={<BackLink fallbackPath="/payments" fallbackLabel="Payments" onNavigate={onNavigate} />}
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
        <div className="pf" data-tone={tone}>
          <div className="pf-main">
            <header className="pf-hero pf-rise" style={{ '--i': 0 } as CSSProperties}>
              <span className="pf-pill"><i aria-hidden="true" />{pill}</span>
              <p className="pf-hero__label">{amountLabel}</p>
              <p className="pf-amount" aria-label={receivable ? formatCurrency(heroValue, currency) : undefined}>
                {receivable ? (
                  <>
                    <span className="pf-amount__cur" aria-hidden="true">{money.cur}</span>
                    <span aria-hidden="true">{money.int}</span>
                    <span className="pf-amount__dec" aria-hidden="true">{money.dec}</span>
                  </>
                ) : '—'}
              </p>
              <p className="pf-hero__detail">
                <span>{heroDetail}</span>
                {!settled && nextReminderAt && <span className="pf-hero__next"><BellRing size={13} aria-hidden="true" /> Next reminder {formatDateTime(nextReminderAt)}</span>}
              </p>
              {(!settled || paymentCase.restartable) && (
                <div className="pf-actions">
                  {!settled && (
                    <button className="pf-btn pf-btn--solid" type="button" onClick={openMarkPaid}>
                      <CircleCheck size={16} aria-hidden="true" /> Mark as paid
                    </button>
                  )}
                  {paymentCase.restartable && (
                    <button className="pf-btn pf-btn--ghost" type="button" onClick={() => { setRestartError(''); setConfirmingRestart(true); }}>
                      <RotateCcw size={15} aria-hidden="true" /> Restart reminders
                    </button>
                  )}
                </div>
              )}
            </header>

            {stamps.length > 0 && (
              <section className="pf-timeline pf-rise" style={{ '--i': 1 } as CSSProperties} aria-label="Collection timeline">
                <div className={`pf-ruler${edgeLabels.some((label) => label.row === 1) ? ' pf-ruler--tall' : ''}`} role="img" aria-label={rulerSummary}>
                  <div className="pf-ruler__plot">
                    <span className="pf-ruler__base" />
                    <span className="pf-ruler__run" style={{ width: `${at(runEndMs)}%` }} />
                    {!settled && Number.isFinite(dueMs) && nowMs > dueMs && (
                      <span className="pf-ruler__late" style={{ left: `${at(dueMs)}%`, width: `${Math.max(at(nowMs) - at(dueMs), 0.6)}%` }} />
                    )}
                    {Number.isFinite(scheduledMs) && scheduledMs > nowMs && (
                      <span className="pf-ruler__ahead" style={{ left: `${at(nowMs)}%`, width: `${at(scheduledMs) - at(nowMs)}%` }} />
                    )}
                    {Number.isFinite(issueMs) && <span className="pf-mark pf-mark--node" style={{ left: `${at(issueMs)}%` }} />}
                    {Number.isFinite(dueMs) && <span className="pf-mark pf-mark--node pf-mark--due" style={{ left: `${at(dueMs)}%` }} />}
                    {points.map((point) => (
                      <span key={point.id} className={`pf-mark pf-mark--reminder pf-mark--${point.tone}`} style={{ left: `${at(point.ms)}%` }} title={`Reminder ${point.n} · ${TONE_LABEL[point.tone]} · ${formatDateTime(new Date(point.ms).toISOString())}`} />
                    ))}
                    {Number.isFinite(scheduledMs) && scheduledMs > nowMs && !(Number.isFinite(dueMs) && Math.abs(at(scheduledMs) - at(dueMs)) < 3) && (
                      <span className="pf-mark pf-mark--reminder pf-mark--scheduled" style={{ left: `${at(scheduledMs)}%` }} title={`Scheduled · ${formatDateTime(nextReminderAt)}`} />
                    )}
                    {settled && Number.isFinite(paidMs) && (
                      <span className="pf-mark pf-mark--paid" style={{ left: `${at(paidMs)}%` }}><Check size={11} strokeWidth={3.2} aria-hidden="true" /></span>
                    )}
                    {!settled && (
                      <span className="pf-today" style={{ left: `${at(nowMs)}%` }}><b>Today</b></span>
                    )}
                    {edgeLabels.map((label) => (
                      <span
                        key={label.key}
                        className={`pf-edge pf-edge--row${label.row}${label.x < 9 ? ' pf-edge--start' : label.x > 91 ? ' pf-edge--end' : ''}`}
                        style={{ left: `${label.x}%` }}
                      >
                        <small>{label.kicker}</small>{label.text}
                      </span>
                    ))}
                  </div>
                </div>
                {(legendTones.length > 0 || Number.isFinite(scheduledMs)) && (
                  <ul className="pf-legend" aria-hidden="true">
                    {legendTones.map((legendTone) => <li key={legendTone}><i className={`pf-key pf-key--${legendTone}`} />{TONE_LABEL[legendTone]}</li>)}
                    {!settled && Number.isFinite(scheduledMs) && <li><i className="pf-key pf-key--scheduled" />Scheduled</li>}
                  </ul>
                )}
              </section>
            )}

            <dl className="pf-ledger pf-rise" style={{ '--i': 2 } as CSSProperties}>
              <div><dt>Invoice total</dt><dd>{receivable ? formatCurrency(original, currency) : '—'}</dd></div>
              <div><dt>Received</dt><dd className={paid > 0 ? 'pf-pos' : undefined}>{receivable ? formatCurrency(paid, currency) : '—'}<small>{paidShare}% of invoice</small></dd></div>
              <div><dt>Lateness</dt><dd>{receivable?.aging_bucket && !settled ? agingLabel(receivable.aging_bucket) : settled ? 'Settled' : '—'}<small>{receivable?.payment_status ? humanize(receivable.payment_status) : ' '}</small></dd></div>
              <div><dt>Reminders</dt><dd>{sentCount} sent<small>{lastReminderAt ? `Last ${formatDate(lastReminderAt)}` : 'None yet'}</small></dd></div>
            </dl>

            <div className="pf-info pf-rise" style={{ '--i': 3 } as CSSProperties}>
              <section className="pf-block" aria-label="Customer">
                <p className="pf-kicker">Customer</p>
                <h3>
                  {customer?.id
                    ? <button className="pf-link" type="button" onClick={() => onNavigate(`/customers/${customer.id}`)}>{customer.display_name}</button>
                    : 'Customer unavailable'}
                </h3>
                <dl className="pf-rows">
                  <StatementRow label="Customer code">{customer?.sap_customer_number ?? '—'}</StatementRow>
                  <StatementRow label="WhatsApp" mono>{paymentCase.whatsappNumber ?? '—'}</StatementRow>
                </dl>
              </section>
              <section className="pf-block" aria-label="Invoice">
                <p className="pf-kicker">Invoice</p>
                <h3>{invoiceNumber ?? '—'}</h3>
                <dl className="pf-rows">
                  <StatementRow label="Issued">{formatDate(paymentCase.invoice?.billing_document_date)}</StatementRow>
                  <StatementRow label="Due">{formatDate(dueDate)}</StatementRow>
                </dl>
              </section>
              {settled && confirmation && (
                <section className="pf-block pf-block--wide" aria-label="Payment record">
                  <p className="pf-kicker">Payment record <span>Entered manually</span></p>
                  <dl className="pf-rows pf-rows--two">
                    {confirmation.payment_date && <StatementRow label="Paid on">{formatDate(confirmation.payment_date)}</StatementRow>}
                    {confirmation.payment_method && <StatementRow label="Method">{methodLabel(confirmation.payment_method)}</StatementRow>}
                    {confirmation.reference_number && <StatementRow label="Reference" mono>{confirmation.reference_number}</StatementRow>}
                    {confirmation.marked_by && <StatementRow label="Recorded by">{confirmation.marked_by}</StatementRow>}
                    {confirmation.confirmed_at && <StatementRow label="Recorded">{formatDateTime(confirmation.confirmed_at)}</StatementRow>}
                    {confirmation.notes && <StatementRow label="Note" wrap>{confirmation.notes}</StatementRow>}
                  </dl>
                </section>
              )}
            </div>

            <details className="ds-tech pf-tech">
              <summary>Technical details</summary>
              <dl className="dt-details dt-details--stacked">
                <div><dt>Case reference</dt><dd>#{paymentCase.id}</dd></div>
                <div><dt>Follow-up status</dt><dd>{humanize(paymentCase.status)}</dd></div>
                <div><dt>Last reminder</dt><dd>{formatDateTime(lastReminderAt)}</dd></div>
                <div><dt>Last synced from SAP</dt><dd>{formatDateTime(receivable?.last_synced_at)}</dd></div>
              </dl>
            </details>
          </div>

          <aside className="pf-phone pf-rise" style={{ '--i': 2 } as CSSProperties} aria-label="Reminder conversation">
            <header className="pf-phone__bar">
              <span className="pf-phone__avatar" aria-hidden="true">{initials}</span>
              <div>
                <strong>{customer?.display_name ?? 'Customer'}</strong>
                <small className="mono">{paymentCase.whatsappNumber ?? 'WhatsApp'}</small>
              </div>
              <span className="pf-phone__count">{jobs.length} {jobs.length === 1 ? 'reminder' : 'reminders'}</span>
            </header>
            <div className="pf-phone__body" ref={chatRef}>
              {days.length === 0 && !scheduledDay && (
                <div className="pf-phone__empty">
                  <BadgeIndianRupee size={22} aria-hidden="true" />
                  <strong>No reminders sent</strong>
                  <p>{settled ? 'This invoice was settled before any reminder was needed.' : 'Reminders start if the invoice isn’t paid on time.'}</p>
                </div>
              )}
              {days.map((day) => (
                <section className="pf-day" key={day.key} aria-label={day.label}>
                  <h4>{day.label}</h4>
                  {day.items.map(({ job, message, n, ms, tone: messageTone, failure }) => (
                    <div className="pf-turn" key={job.id}>
                      <div className={`pf-bubble${messageTone === 'failed' ? ' pf-bubble--failed' : ''}`}>
                        <b className="pf-bubble__tag">Reminder {n}</b>
                        <p>{message?.body ?? `Payment reminder for invoice ${invoiceNumber ?? ''}`.trim()}</p>
                        <span className="pf-bubble__meta">
                          {formatTime(Number.isFinite(ms) ? new Date(ms).toISOString() : job.created_at)}
                          <ReminderTicks tone={messageTone} />
                        </span>
                      </div>
                      {failure && <p className="pf-notice"><AlertCircle size={12} aria-hidden="true" /> {failure}</p>}
                    </div>
                  ))}
                </section>
              ))}
              {!settled && nextReminderAt && (
                <section className="pf-day" aria-label="Scheduled">
                  <h4>{scheduledDay === 'Today' ? 'Later today' : scheduledDay}</h4>
                  <div className="pf-bubble pf-bubble--scheduled">
                    <b className="pf-bubble__tag">Reminder {jobs.length + 1} · scheduled</b>
                    <p><Clock3 size={13} aria-hidden="true" /> Goes out {formatDateTime(nextReminderAt)}</p>
                  </div>
                </section>
              )}
            </div>
          </aside>
        </div>
      )}
      {confirmingPaid && paymentCase && (
        <Modal
          title="Mark this invoice as paid?"
          description="Reminders for this invoice stop right away. Only do this once the payment has been received."
          onClose={() => { if (!markingPaid) setConfirmingPaid(false); }}
        >
          <dl className="pf-recap">
            <div><dt>Customer</dt><dd>{customer?.display_name ?? '—'}</dd></div>
            <div><dt>Invoice</dt><dd>{invoiceNumber ?? '—'}</dd></div>
            <div className="pf-recap__key"><dt>Amount received</dt><dd>{receivable ? formatCurrency(outstanding, currency) : '—'}</dd></div>
          </dl>
          <div className="payment-entry">
            <div className="payment-entry__heading">
              <strong>Payment information</strong>
              <span>Optional</span>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Payment date</span>
                <input
                  type="date"
                  max={todayInIndia()}
                  value={paymentDetails.paymentDate}
                  onInput={(event) => {
                    const paymentDate = event.currentTarget.value;
                    setPaymentDetails((current) => ({ ...current, paymentDate }));
                  }}
                />
              </label>
              <label className="field">
                <span>Reference number</span>
                <input
                  type="text"
                  maxLength={120}
                  placeholder="UTR, cheque or transaction no."
                  value={paymentDetails.referenceNumber}
                  onChange={(event) => setPaymentDetails((current) => ({ ...current, referenceNumber: event.target.value }))}
                />
              </label>
              <div className="field field--full" role="group" aria-label="Payment method">
                <span>Payment method</span>
                <div className="pf-chips">
                  {PAYMENT_METHOD_OPTIONS.map((option) => {
                    const selected = paymentDetails.paymentMethod === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`pf-chip${selected ? ' pf-chip--on' : ''}`}
                        aria-pressed={selected}
                        onClick={() => setPaymentDetails((current) => ({ ...current, paymentMethod: selected ? '' : option.value }))}
                      >
                        {selected && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="field field--full">
                <span>Notes</span>
                <textarea
                  maxLength={500}
                  placeholder="Add any internal payment note"
                  value={paymentDetails.notes}
                  onChange={(event) => setPaymentDetails((current) => ({ ...current, notes: event.target.value }))}
                />
                <small>{paymentDetails.notes.length}/500 characters</small>
              </label>
            </div>
          </div>
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
          <dl className="pf-recap pf-recap--four">
            <div><dt>Customer</dt><dd>{customer?.display_name ?? '—'}</dd></div>
            <div><dt>Invoice</dt><dd>{invoiceNumber ?? '—'}</dd></div>
            <div><dt>Reminders go to</dt><dd className="mono">{paymentCase.whatsappNumber ?? '—'}</dd></div>
            <div className="pf-recap__key"><dt>Amount due</dt><dd>{formatCurrency(original, currency)}</dd></div>
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
  return messageLifecycleState(message?.status ?? job.status, message);
}

function ReminderTicks({ tone }: { tone: Tone }) {
  if (tone === 'failed') return <AlertCircle className="dt-ticks dt-ticks--failed" size={13} aria-label="Failed" />;
  if (tone === 'queued') return <Clock3 className="dt-ticks" size={12} aria-label="Queued" />;
  if (tone === 'sent') return <Check className="dt-ticks" size={14} aria-label="Sent" />;
  if (tone === 'read') return <CheckCheck className="dt-ticks dt-ticks--read" size={14} aria-label="Read" />;
  return <CheckCheck className="dt-ticks" size={14} aria-label="Delivered; read not confirmed" />;
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));
}

const TONE_LABEL: Record<Tone, string> = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
};

const AGING_LABELS: Record<string, string> = {
  current: 'Not yet due',
  due: 'Due today',
  late30: '1–30 days',
  late60: '31–60 days',
  late60plus: '60+ days',
};

function agingLabel(bucket: string): string {
  return AGING_LABELS[bucket] ?? humanize(bucket);
}

function methodLabel(method: string): string {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.label ?? humanize(method);
}

/** Whole days from today (India) to a YYYY-MM-DD date; negative once it has passed. */
function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  const due = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayInIndia()}T00:00:00Z`);
  return Number.isNaN(due) ? null : Math.round((due - today) / 86_400_000);
}

function humanize(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function indiaDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function todayInIndia(): string {
  return indiaDay(new Date());
}

function dayLabel(key: string): string {
  if (key === 'unknown') return 'Earlier';
  const today = todayInIndia();
  if (key === today) return 'Today';
  const yesterday = indiaDay(new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000));
  if (key === yesterday) return 'Yesterday';
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(new Date(`${key}T00:00:00Z`));
}

/** A YYYY-MM-DD date (or ISO timestamp) as epoch milliseconds, NaN when absent. */
function parseDay(value?: string | null): number {
  if (!value) return Number.NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
}

function moneyParts(amount: number, currency: string): { cur: string; int: string; dec: string } {
  const parts = new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(amount);
  const join = (types: string[]) => parts.filter((part) => types.includes(part.type)).map((part) => part.value).join('');
  return { cur: join(['currency']), int: join(['integer', 'group']), dec: join(['decimal', 'fraction']) };
}

/** Eases a number up to its target so the headline amount settles in rather than popping. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - began) / 900);
      const next = start + (target - start) * (1 - (1 - progress) ** 4);
      from.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function StatementRow({ label, children, mono, wrap }: { label: string; children: ReactNode; mono?: boolean; wrap?: boolean }) {
  return (
    <div className={`pf-row${wrap ? ' pf-row--wrap' : ''}`}>
      <dt>{label}</dt>
      {!wrap && <i className="pf-leader" aria-hidden="true" />}
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}
