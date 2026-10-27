import {
  AlertTriangle,
  BadgeIndianRupee,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { FilterBar, FilterSelect, humanize, matchesSearch } from '../components/FilterBar';
import { Modal } from '../components/Modal';
import { PaginationControls, usePagination } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type PaymentFollowUpCase,
  type PaymentFollowUpConfig,
  type PaymentTestPreview,
  type PaymentTestRunResult,
  type EligiblePaymentInvoice,
} from '../types';

export function PaymentFollowUpsPage({
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
  const [paymentConfig, setPaymentConfig] = useState<PaymentFollowUpConfig | null>(null);
  const [cases, setCases] = useState<PaymentFollowUpCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [reminder, setReminder] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [bucket, setBucket] = useState<Bucket>('journey');
  const [demoOpen, setDemoOpen] = useState(false);
  const [eligible, setEligible] = useState<EligiblePaymentInvoice[]>([]);
  const [eligibleError, setEligibleError] = useState('');
  const [starting, setStarting] = useState<EligiblePaymentInvoice | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextPaymentConfig, nextCases, nextEligible] = await Promise.all([
        apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
        apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases'),
        apiRequest<EligiblePaymentInvoice[]>('/payment-follow-up/eligible').then((rows) => { setEligibleError(''); return rows; }).catch((cause) => { setEligibleError(toMessage(cause)); return null; }),
      ]);
      setPaymentConfig(nextPaymentConfig);
      setCases(nextCases);
      if (nextEligible) setEligible(nextEligible);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const reminderOptions = useMemo(
    () => [...new Set(cases.map(reminderStatus))].sort().map((value) => ({ value, label: humanize(value) })),
    [cases],
  );
  const paymentStatusOptions = useMemo(
    () => [...new Set(cases.map((item) => item.receivable?.payment_status).filter((value): value is string => Boolean(value)))]
      .sort().map((value) => ({ value, label: humanize(value) })),
    [cases],
  );
  const searched = useMemo(() => cases.filter((item) =>
    (!reminder || reminderStatus(item) === reminder)
    && (!paymentStatus || item.receivable?.payment_status === paymentStatus)
    && matchesSearch(search, item.customer?.display_name, item.customer?.sap_customer_number, item.invoice?.sap_billing_document)),
  [cases, reminder, paymentStatus, search]);
  const eligibleFiltered = useMemo(() => eligible.filter((item) => matchesSearch(search, item.customerName, item.customerNumber, item.invoiceNumber)), [eligible, search]);
  const bucketCounts: Record<Bucket,number> = { journey: searched.filter((item) => !isSettled(item)).length, paid: searched.filter(isSettled).length, eligible: eligibleFiltered.length };
  const filtered = useMemo(() => searched.filter((item) => inBucket(item, bucket)), [searched, bucket]);
  const totalDue = filtered.reduce((sum, item) => sum + (isSettled(item) ? 0 : Number(item.receivable?.outstanding_amount ?? 0)), 0);
  const dueCurrency = filtered.find((item) => item.receivable)?.receivable?.currency ?? 'INR';
  const filtersActive = Boolean(search || reminder || paymentStatus);
  const pagination = usePagination(filtered, 'payment-cases', `${search}|${reminder}|${paymentStatus}|${bucket}`);
  const eligiblePagination = usePagination(eligibleFiltered, 'payment-eligible', search);

  function clearFilters() {
    setSearch('');
    setReminder('');
    setPaymentStatus('');
  }

  return (
    <AppShell
      route={route}
      eyebrow="Review eligible invoices, start journeys, and record payments"
      title="Payment followup"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <>
          <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
          </button>
          {!paymentConfig?.manualJourneys && <button
            className="button button--primary"
            type="button"
            disabled={!paymentConfig?.configured}
            title={paymentConfig?.configured ? undefined : 'Payment reminders are not set up on the server'}
            onClick={() => setDemoOpen(true)}
          >
            <Send size={15} aria-hidden="true" /> Start demo reminder
          </button>}
        </>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      <section className="list-section">
        <div className="seg-tabs" role="tablist" aria-label="Payment journey">
          {BUCKETS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={bucket === key} className={bucket === key ? 'seg-tab seg-tab--active' : 'seg-tab'} type="button" onClick={() => setBucket(key)}>
              {label}<span>{bucketCounts[key]}</span>
            </button>
          ))}
        </div>
        <p className="list-summary">Eligibility uses the invoice date + {paymentConfig?.dueDays ?? 3} days, enabled customers and approved materials. Payment is confirmed by your team, not verified from SAP. No reminders start until you choose Start journey.</p>
        {!loading && bucket !== 'eligible' && totalDue > 0 && (
          <p className="list-summary"><strong>{formatCurrency(totalDue, dueCurrency)}</strong> still to pay across {filtered.filter((item) => !isSettled(item)).length} invoices</p>
        )}
        <FilterBar
          search={search}
          searchPlaceholder="Search customer or invoice"
          onSearchChange={setSearch}
          active={filtersActive}
          onClear={clearFilters}
        >
          {bucket !== 'eligible' && <><FilterSelect label="Reminder" value={reminder} options={reminderOptions} onChange={setReminder} />
          <FilterSelect label="Payment" value={paymentStatus} options={paymentStatusOptions} onChange={setPaymentStatus} /></>}
        </FilterBar>
        {bucket === 'eligible' ? <>
          {eligibleError && <div className="alert alert--error" role="alert">Eligible invoices could not be refreshed: {eligibleError}. Starting a journey is disabled until refresh succeeds.</div>}
          {loading ? <div className="table-skeleton"><span /><span /></div> : <div className="table-scroll"><table>
            <thead><tr><th>Customer</th><th>Invoice</th><th>Invoice amount</th><th>Calculated due date</th><th>Payment status</th><th>Action</th></tr></thead>
            <tbody>{eligiblePagination.pageRows.map((item) => <tr key={item.invoiceNumber}>
              <td><strong>{item.customerName}</strong><small>{item.customerNumber}</small></td>
              <td><strong>{item.invoiceNumber}</strong><small>{formatDate(item.invoiceDate)}</small></td>
              <td>{formatCurrency(item.amount,item.currency)}</td><td>{formatDate(item.dueDate)}<small>Invoice date + {item.dueDays} days</small></td>
              <td>Not verified<small>Confirm pending balance before starting</small></td>
              <td><button className="button button--secondary" type="button" disabled={Boolean(eligibleError) || refreshing || !paymentConfig?.manualJourneys || !paymentConfig.sendEnabled} onClick={() => setStarting(item)}>Start journey</button></td>
            </tr>)}</tbody>
          </table>{eligibleFiltered.length === 0 && <div className="empty-table"><strong>No eligible invoices</strong><p>Invoices appear here when due, provided their customer and all materials are enabled and no journey already exists.</p></div>}</div>}
          <PaginationControls page={eligiblePagination.page} pageCount={eligiblePagination.pageCount} pageSize={eligiblePagination.pageSize} total={eligiblePagination.total} noun="invoices" disabled={refreshing} onPageChange={eligiblePagination.setPage} onPageSizeChange={eligiblePagination.setPageSize} />
        </> : loading ? <div className="table-skeleton"><span /><span /><span /></div> : cases.length > 0 && filtered.length === 0 ? (
          <div className="empty-table">
            <strong>{filtersActive ? 'Nothing matches your search' : 'Nothing in this group'}</strong>
            <p>{filtersActive ? <>Try a different search or <button className="text-button" type="button" onClick={clearFilters}>clear all filters</button>.</> : 'Pick another tab to see other invoices.'}</p>
          </div>
        ) : (
          <>
            <PaymentCasesTable cases={pagination.pageRows} onOpen={(caseId) => onNavigate(`/payments/${caseId}`)} />
            <PaginationControls
              page={pagination.page}
              pageCount={pagination.pageCount}
              pageSize={pagination.pageSize}
              total={pagination.total}
              noun="invoices"
              disabled={refreshing}
              onPageChange={pagination.setPage}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </section>

      {demoOpen && paymentConfig && (
        <PaymentTestModal
          maximumReminders={paymentConfig.maximumTestReminders}
          onClose={() => setDemoOpen(false)}
          onComplete={(result) => { setDemoOpen(false); onNavigate(`/payments/${result.caseId}`); }}
        />
      )}
      {starting && <StartJourneyModal invoice={starting} onClose={() => setStarting(null)} onStarted={async (caseId) => { setStarting(null); await load(true); onNavigate(`/payments/${caseId}`); }} />}
    </AppShell>
  );
}

type Bucket = 'journey' | 'eligible' | 'paid';

const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'journey', label: 'In the journey' },
  { key: 'eligible', label: 'All eligible' },
  { key: 'paid', label: 'Paid' },
];

function isSettled(paymentCase: PaymentFollowUpCase): boolean {
  return Boolean(paymentCase.resolved_at) || (paymentCase.receivable ? Number(paymentCase.receivable.outstanding_amount) <= 0 : false);
}

function inBucket(paymentCase: PaymentFollowUpCase, bucket: Bucket): boolean {
  const settled = isSettled(paymentCase);
  if (bucket === 'paid') return settled;
  return bucket === 'journey' && !settled;
}

function StartJourneyModal({ invoice, onClose, onStarted }: { invoice: EligiblePaymentInvoice; onClose: () => void; onStarted: (id: number) => Promise<void> }) {
  const [amount,setAmount] = useState('');
  const [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const valid = confirmed && Number(amount) > 0 && Number(amount) <= invoice.amount;
  async function start() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const result = await apiRequest<{ caseId: number }>(`/payment-follow-up/journeys/${encodeURIComponent(invoice.invoiceNumber)}/start`, { method:'POST',body:JSON.stringify({ confirmedUnpaid:true,outstandingAmount:Number(amount),expectedDueDays:invoice.dueDays }) });
      await onStarted(result.caseId);
    } catch (cause) { setError(toMessage(cause)); } finally { setBusy(false); }
  }
  return <Modal title={`Start journey · ${invoice.invoiceNumber}`} description="This starts real WhatsApp payment reminders. It does not resend the invoice or update SAP." onClose={() => { if (!busy) onClose(); }}>
    <div className="st-stack">
      <p><strong>{invoice.customerName}</strong> · {invoice.customerNumber}<br />Reminders go to <span className="mono">{invoice.recipient}</span><br />Calculated due date: {formatDate(invoice.dueDate)} (invoice date + {invoice.dueDays} days).</p>
      <label className="field"><span>Confirmed unpaid balance ({invoice.currency})</span><input type="number" min="0.01" max={invoice.amount} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /><small>Enter the actual amount still owed. Invoice total: {formatCurrency(invoice.amount,invoice.currency)}.</small></label>
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I have checked that this balance is unpaid and the recipient is correct.</label>
      <p className="set-note">The current due-days, reminder intervals and limit are saved for this journey. Later settings changes will not change it. Mark as paid stops future reminders.</p>
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      <div className="form-actions"><button className="button button--secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button--primary" disabled={!valid || busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Confirm and start journey'}</button></div>
    </div>
  </Modal>;
}

function latenessLabel(paymentCase: PaymentFollowUpCase): string {
  if (isSettled(paymentCase)) return 'Paid';
  if (!paymentCase.receivable) return '—';
  if (paymentCase.receivable.aging_bucket === 'due') return 'Due today';
  const days = paymentCase.receivable.days_overdue;
  return days > 0 ? `${days} ${days === 1 ? 'day' : 'days'} late` : 'Not yet due';
}

function reminderStatus(paymentCase: PaymentFollowUpCase): string {
  return relationOne(paymentCase.latestJob?.messages)?.status ?? paymentCase.latestJob?.status ?? paymentCase.status;
}

function PaymentCasesTable({
  cases,
  onOpen,
}: {
  cases: PaymentFollowUpCase[];
  onOpen: (caseId: number) => void;
}) {
  if (cases.length === 0) {
    return (
      <div className="empty-table">
        <BadgeIndianRupee size={28} aria-hidden="true" />
        <strong>No unpaid invoices yet</strong>
        <p>Invoices show up here when they’re waiting to be paid.</p>
      </div>
    );
  }
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Customer</th><th>Invoice</th><th>Payment</th><th>Due date</th><th>Last reminder</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {cases.map((paymentCase) => {
            const status = reminderStatus(paymentCase);
            const settled = isSettled(paymentCase);
            const confirmation = paymentCase.receivable?.raw_data?.payment_confirmation;
            const paymentDate = confirmation?.payment_date ?? confirmation?.confirmed_at;
            const paymentSummary = [
              paymentDate ? formatDate(paymentDate) : '',
              confirmation?.payment_method ? humanize(confirmation.payment_method) : '',
            ].filter(Boolean).join(' · ');
            return (
              <tr key={paymentCase.id}>
                <td><strong>{paymentCase.customer?.display_name ?? 'Customer unavailable'}</strong><small>{paymentCase.customer?.sap_customer_number ?? '—'}</small></td>
                <td><span className="invoice-number">{paymentCase.invoice?.sap_billing_document ?? '—'}</span><small>{formatDate(paymentCase.invoice?.billing_document_date)}</small></td>
                <td>
                  <strong>{formatCurrency(Number(settled ? paymentCase.receivable?.paid_amount ?? 0 : paymentCase.receivable?.outstanding_amount ?? 0), paymentCase.receivable?.currency)}</strong>
                  <small>{settled ? `Paid${paymentSummary ? ` · ${paymentSummary}` : ''}` : paymentCase.receivable?.payment_status.replaceAll('_', ' ') ?? '—'}</small>
                </td>
                <td>{formatDate(paymentCase.receivable?.due_date)}<small>{latenessLabel(paymentCase)}</small></td>
                <td><StatusBadge status={status} /><small>{formatDateTime(paymentCase.last_reminder_at)}</small></td>
                <td><button className="row-open-button" type="button" onClick={() => onOpen(paymentCase.id)} aria-label="Open payment case"><ChevronRight size={16} /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentTestModal({
  maximumReminders,
  onClose,
  onComplete,
}: {
  maximumReminders: number;
  onClose: () => void;
  onComplete: (result: PaymentTestRunResult) => void;
}) {
  const [preview, setPreview] = useState<PaymentTestPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<PaymentTestPreview>('/payment-follow-up/test-preview')
      .then((data) => { if (active) setPreview(data); })
      .catch((loadError) => { if (active) setError(toMessage(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function send() {
    setSending(true);
    setError('');
    try {
      onComplete(await apiRequest<PaymentTestRunResult>('/payment-follow-up/test-run', {
        method: 'POST',
        body: JSON.stringify({}),
      }));
    } catch (sendError) {
      setError(toMessage(sendError));
      setSending(false);
    }
  }

  return (
    <Modal
      title="Send a test reminder"
      description={`We’ll send the invoice first, then up to ${maximumReminders} payment ${maximumReminders === 1 ? 'reminder' : 'reminders'} on the timing set in Settings. Check the details below before sending.`}
      onClose={onClose}
      width="large"
    >
      {loading && <div className="detail-skeleton"><span /><span /></div>}
      {error && <div className="alert alert--error">{error}</div>}
      {preview && (
        <>
          <div className="payment-preview-grid">
            <div className="payment-preview-summary">
              <div><span>Customer</span><strong>{preview.invoice.customerName}</strong></div>
              <div><span>Invoice</span><strong>{preview.invoice.billingDocument}</strong></div>
              <div><span>Amount due</span><strong>{formatCurrency(preview.receivable.outstandingAmount, preview.receivable.currency)}</strong></div>
              <div><span>Due date</span><strong>{formatDate(preview.receivable.dueDate)}</strong></div>
              <div><span>WhatsApp</span><strong>{preview.maskedRecipient}</strong></div>
              <div><span>Source</span><strong>Test data</strong></div>
            </div>
            <div className="whatsapp-message payment-message-preview">
              <small>Message preview</small>
              <p>{preview.template.message}</p>
              <div className="payment-message-buttons"><span>Confirm Paid</span><span>Need Help</span></div>
            </div>
          </div>
          <p className="payment-disclosure"><AlertTriangle size={15} aria-hidden="true" /> {preview.disclosure}</p>
          <div className="payment-validation-summary">
            {preview.validations.map((validation) => (
              <span className={validation.passed ? 'payment-check--pass' : 'payment-check--fail'} key={validation.code}>
                {validation.passed ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                {validation.label}
              </span>
            ))}
          </div>
          <div className="modal-footer">
            <button className="button button--secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button button--primary" type="button" disabled={!preview.sendAllowed || sending} onClick={() => void send()}>
              <Send size={15} aria-hidden="true" /> {sending ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
