import { AlertCircle, BadgeIndianRupee, BellRing, Check, CircleCheck, Clock3, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { BackLink } from '../components/BackLink';
import { Amount, Bubble, Journey, LIFECYCLE_LABEL, PhoneFrame, formatTime, rise, type JourneyItem, type PageTone } from '../components/statement';
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
  const initials = (customer?.display_name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join('');

  // The story so far, in plain words, oldest first.
  const nowMs = Date.now();
  const issueMs = parseDay(paymentCase?.invoice?.billing_document_date);
  const dueMs = parseDay(dueDate);
  const paidMs = settled ? Date.parse(confirmation?.payment_date ?? paymentCase?.resolved_at ?? '') : Number.NaN;
  const scheduledMs = !settled && nextReminderAt ? Date.parse(nextReminderAt) : Number.NaN;
  const who = customer?.display_name ?? 'the customer';
  const points = jobs
    .map((job, index) => {
      const message = relationOne(job.messages);
      return {
        id: job.id,
        n: jobs.length - index,
        tone: toneOf(job),
        ms: Date.parse(message?.sent_at ?? job.created_at),
        failure: message?.failure_reason ?? job.last_error ?? null,
      };
    })
    .filter((point) => Number.isFinite(point.ms))
    .sort((a, b) => a.ms - b.ms);
  const lastReminderAt = paymentCase?.last_reminder_at ?? (points.length ? new Date(points[points.length - 1].ms).toISOString() : null);
  const journey: Array<JourneyItem & { ms: number }> = [];
  if (Number.isFinite(issueMs)) {
    journey.push({ key: 'issued', ms: issueMs, state: 'done', title: 'Invoice issued', when: formatDate(paymentCase?.invoice?.billing_document_date) });
  }
  if (Number.isFinite(dueMs)) {
    const dueInFuture = dueMs > nowMs;
    journey.push({ key: 'due', ms: dueMs, state: settled ? 'done' : dueInFuture ? 'next' : 'bad', title: dueInFuture ? 'Payment due' : 'Payment was due', when: formatDate(dueDate) });
  }
  points.forEach((point) => {
    journey.push({
      key: `reminder-${point.id}`,
      ms: point.ms,
      state: point.tone === 'failed' ? 'bad' : 'done',
      title: `Reminder ${point.n}`,
      when: formatDate(new Date(point.ms).toISOString()),
      chip: { label: LIFECYCLE_LABEL[point.tone], tone: point.tone },
    });
  });
  if (settled) {
    journey.push({
      key: 'paid',
      ms: Number.isFinite(paidMs) ? paidMs : nowMs,
      state: 'good',
      title: 'Paid',
      when: formatDate(confirmation?.payment_date ?? paymentCase?.resolved_at),
      detail: confirmation?.payment_method ? methodLabel(confirmation.payment_method) : undefined,
    });
  } else {
    journey.push({
      key: 'today',
      ms: nowMs,
      state: 'now',
      title: 'Today',
      when: daysOverdue > 0 ? `${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'} overdue` : 'Unpaid',
    });
    if (Number.isFinite(scheduledMs)) {
      journey.push({ key: 'scheduled', ms: scheduledMs, state: 'next', title: `Reminder ${jobs.length + 1}`, when: formatDate(nextReminderAt), chip: { label: 'Scheduled', tone: 'scheduled' } });
    }
  }
  journey.sort((a, b) => a.ms - b.ms);

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
        <div className="pf pf--stack pf--doc" data-tone={tone}>
          <div className="dd-layout">
            <div className="dd-main">
              <section className="dd-card dd-summary dd-summary--flush pf-rise" style={rise(0)} aria-label="Summary">
                <div className="dd-summary__top">
                  <span className="pf-pill"><i aria-hidden="true" />{pill}</span>
                  {(!settled || paymentCase.restartable) && (
                    <div className="pf-actions">
                      {!settled && (
                        <button className="pf-btn pf-btn--solid" type="button" onClick={openMarkPaid}>
                          <CircleCheck size={14} aria-hidden="true" /> Mark as paid
                        </button>
                      )}
                      {paymentCase.restartable && (
                        <button className="pf-btn pf-btn--ghost" type="button" onClick={() => { setRestartError(''); setConfirmingRestart(true); }}>
                          <RotateCcw size={14} aria-hidden="true" /> Restart reminders
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="dd-figure">
                  <div>
                    <p className="pf-hero__label">{amountLabel}</p>
                    <Amount value={heroValue} currency={currency} available={Boolean(receivable)} />
                  </div>
                  <p className="dd-headline">
                    <strong>{heroDetail}</strong>
                    {!settled && nextReminderAt && <span><BellRing size={12} aria-hidden="true" /> Next reminder {formatDateTime(nextReminderAt)}</span>}
                  </p>
                </div>

                <Journey title="What happened" hint="Oldest to newest" items={journey} label="Payment history" />

                <dl className="dd-stats dd-stats--four">
                  <div><dt>Invoice total</dt><dd>{receivable ? formatCurrency(original, currency) : '—'}</dd><small>{invoiceNumber ? `Invoice ${invoiceNumber}` : ' '}</small></div>
                  <div><dt>Received</dt><dd className={paid > 0 ? 'pf-pos' : undefined}>{receivable ? formatCurrency(paid, currency) : '—'}</dd><small>{paidShare}% of invoice</small></div>
                  <div><dt>Lateness</dt><dd>{receivable?.aging_bucket && !settled ? agingLabel(receivable.aging_bucket) : settled ? 'Settled' : '—'}</dd><small>{receivable?.payment_status ? humanize(receivable.payment_status) : ' '}</small></div>
                  <div><dt>Reminders</dt><dd>{sentCount} sent</dd><small>{lastReminderAt ? `Last ${formatDate(lastReminderAt)}` : 'None yet'}</small></div>
                </dl>
              </section>

              <section className="dd-card dd-details pf-rise" style={rise(1)} aria-label="Details">
                <dl className="dd-facts">
                  <div>
                    <dt>Customer</dt>
                    <dd>
                      {customer?.id
                        ? <button className="pf-link" type="button" onClick={() => onNavigate(`/customers/${customer.id}`)}>{customer.display_name}</button>
                        : 'Customer unavailable'}
                    </dd>
                  </div>
                  <div><dt>Customer code</dt><dd>{customer?.sap_customer_number ?? '—'}</dd></div>
                  <div><dt>WhatsApp</dt><dd className="mono">{paymentCase.whatsappNumber ?? '—'}</dd></div>
                  <div><dt>Invoice</dt><dd>{invoiceNumber ?? '—'}</dd></div>
                  <div><dt>Issued</dt><dd>{formatDate(paymentCase.invoice?.billing_document_date)}</dd></div>
                  <div><dt>Due</dt><dd>{formatDate(dueDate)}</dd></div>
                </dl>
                <details className="ds-tech pf-tech">
                  <summary>Technical details</summary>
                  <dl className="dt-details dt-details--stacked">
                    <div><dt>Case reference</dt><dd>#{paymentCase.id}</dd></div>
                    <div><dt>Follow-up status</dt><dd>{humanize(paymentCase.status)}</dd></div>
                    <div><dt>Last reminder</dt><dd>{formatDateTime(lastReminderAt)}</dd></div>
                    <div><dt>Last synced from SAP</dt><dd>{formatDateTime(receivable?.last_synced_at)}</dd></div>
                  </dl>
                </details>
              </section>

              {settled && confirmation && (
                <section className="dd-card dd-details pf-rise" style={rise(2)} aria-label="Payment record">
                  <header className="dd-card__head">
                    <h3>Payment record</h3>
                    <span>Entered manually</span>
                  </header>
                  <dl className="dd-facts">
                    {confirmation.payment_date && <div><dt>Paid on</dt><dd>{formatDate(confirmation.payment_date)}</dd></div>}
                    {confirmation.payment_method && <div><dt>Method</dt><dd>{methodLabel(confirmation.payment_method)}</dd></div>}
                    {confirmation.reference_number && <div><dt>Reference</dt><dd className="mono">{confirmation.reference_number}</dd></div>}
                    {confirmation.marked_by && <div><dt>Recorded by</dt><dd>{confirmation.marked_by}</dd></div>}
                    {confirmation.confirmed_at && <div><dt>Recorded</dt><dd>{formatDateTime(confirmation.confirmed_at)}</dd></div>}
                    {confirmation.notes && <div className="dd-facts__wide"><dt>Note</dt><dd>{confirmation.notes}</dd></div>}
                  </dl>
                </section>
              )}
            </div>

            <PhoneFrame
            name={customer?.display_name ?? 'Customer'}
            subtitle={paymentCase.whatsappNumber ?? 'WhatsApp'}
            badge={`${jobs.length} ${jobs.length === 1 ? 'reminder' : 'reminders'}`}
            bodyRef={chatRef}
            style={rise(2)}
          >
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
                    <Bubble tag={`Reminder ${n}`} tone={messageTone} time={formatTime(Number.isFinite(ms) ? new Date(ms).toISOString() : job.created_at)}>
                      <p>{message?.body ?? `Payment reminder for invoice ${invoiceNumber ?? ''}`.trim()}</p>
                    </Bubble>
                    {failure && <p className="pf-notice"><AlertCircle size={12} aria-hidden="true" /> {failure}</p>}
                  </div>
                ))}
              </section>
            ))}
            {!settled && nextReminderAt && (
              <section className="pf-day" aria-label="Scheduled">
                <h4>{scheduledDay === 'Today' ? 'Later today' : scheduledDay}</h4>
                <Bubble tag={`Reminder ${jobs.length + 1} · scheduled`} scheduled>
                  <p><Clock3 size={13} aria-hidden="true" /> Goes out {formatDateTime(nextReminderAt)}</p>
                </Bubble>
              </section>
            )}
          </PhoneFrame>
          </div>
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

function humanize(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
