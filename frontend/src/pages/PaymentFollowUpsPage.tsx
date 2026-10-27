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
import { SidePanel } from '../components/SidePanel';
import { formatDuration } from '../components/settings/duration';
import { PaginationControls, usePagination } from '../components/PaginationControls';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, formatPhone, formatRelative, toMessage } from '../lib/format';
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
  const [starting, setStarting] = useState<EligiblePaymentInvoice[] | null>(null);
  const [sendingNow, setSendingNow] = useState<PaymentFollowUpCase[] | null>(null);
  const [pickedInvoices, setPickedInvoices] = useState<Set<string>>(new Set());
  const [pickedCases, setPickedCases] = useState<Set<number>>(new Set());

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

  const sendingNow_ = cases.some(isSending);
  useEffect(() => {
    if (!sendingNow_) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases').then(setCases).catch(() => undefined);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [sendingNow_]);

  const hideLegacy = Boolean(paymentConfig?.manualJourneys);
  const visibleCases = useMemo(() => cases.filter((item) => !(hideLegacy && isLegacyOpenJourney(item))), [cases, hideLegacy]);
  const reminderOptions = useMemo(
    () => [...new Set(visibleCases.map(reminderStatus))].sort().map((value) => ({ value, label: humanize(value) })),
    [visibleCases],
  );
  const paymentStatusOptions = useMemo(
    () => [...new Set(visibleCases.map((item) => item.receivable?.payment_status).filter((value): value is string => Boolean(value)))]
      .sort().map((value) => ({ value, label: humanize(value) })),
    [visibleCases],
  );
  const searched = useMemo(() => visibleCases.filter((item) =>
    (!reminder || reminderStatus(item) === reminder)
    && (!paymentStatus || item.receivable?.payment_status === paymentStatus)
    && matchesSearch(search, item.customer?.display_name, item.customer?.sap_customer_number, item.invoice?.sap_billing_document)),
  [visibleCases, reminder, paymentStatus, search]);
  const eligibleFiltered = useMemo(() => eligible.filter((item) => matchesSearch(search, item.customerName, item.customerNumber, item.invoiceNumber)), [eligible, search]);
  const bucketCounts: Record<Bucket,number> = { journey: searched.filter((item) => !isSettled(item)).length, paid: searched.filter(isSettled).length, eligible: eligibleFiltered.length };
  const filtered = useMemo(() => searched.filter((item) => inBucket(item, bucket)), [searched, bucket]);
  const totalDue = filtered.reduce((sum, item) => sum + (isSettled(item) ? 0 : Number(item.receivable?.outstanding_amount ?? 0)), 0);
  const dueCurrency = filtered.find((item) => item.receivable)?.receivable?.currency ?? 'INR';
  const filtersActive = Boolean(search || reminder || paymentStatus);
  const pagination = usePagination(filtered, 'payment-cases', `${search}|${reminder}|${paymentStatus}|${bucket}`);
  const eligiblePagination = usePagination(eligibleFiltered, 'payment-eligible', search);
  const canStart = !eligibleError && !refreshing && Boolean(paymentConfig?.manualJourneys && paymentConfig.sendEnabled);
  const chosenInvoices = eligible.filter((item) => pickedInvoices.has(item.invoiceNumber));
  const sendable = (item: PaymentFollowUpCase) => !isSettled(item) && item.status === 'active' && Boolean(item.next_action_at) && Date.parse(String(item.next_action_at)) > Date.now();
  const chosenCases = cases.filter((item) => pickedCases.has(item.id) && sendable(item));
  const sendableIds = filtered.filter(sendable).map((item) => item.id);
  const toggle = <T,>(set: Set<T>, value: T): Set<T> => { const next = new Set(set); if (!next.delete(value)) next.add(value); return next; };

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
        {bucket === 'eligible' && <p className="list-summary">Eligibility uses the invoice date + {paymentConfig?.dueDays ?? 3} days, enabled customers and approved materials. Payment is confirmed by your team, not verified from SAP. No reminders start until you choose Start journey.</p>}
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
          {chosenInvoices.length > 0 && <div className="bulk-bar" role="region" aria-label="Selected invoices">
            <strong>{chosenInvoices.length} selected</strong><span>{formatCurrency(chosenInvoices.reduce((sum, item) => sum + item.amount, 0), chosenInvoices[0]!.currency)}</span>
            <div className="bulk-bar__actions">
              <button className="button button--secondary" type="button" onClick={() => setPickedInvoices(new Set())}>Clear</button>
              <button className="button button--primary" type="button" disabled={!canStart} onClick={() => setStarting(chosenInvoices)}>Start {chosenInvoices.length} {chosenInvoices.length === 1 ? 'journey' : 'journeys'}</button>
            </div>
          </div>}
          {eligibleError && <div className="alert alert--error" role="alert">Eligible invoices could not be refreshed: {eligibleError}. Starting a journey is disabled until refresh succeeds.</div>}
          {loading ? <div className="table-skeleton"><span /><span /></div> : <div className="table-scroll"><table>
            <thead><tr>
              <th className="select-cell"><input type="checkbox" aria-label="Select all eligible invoices" disabled={!canStart || eligibleFiltered.length === 0}
                checked={eligibleFiltered.length > 0 && eligibleFiltered.every((item) => pickedInvoices.has(item.invoiceNumber))}
                onChange={(event) => setPickedInvoices(event.target.checked ? new Set(eligibleFiltered.map((item) => item.invoiceNumber)) : new Set())} /></th>
              <th>Customer</th><th>Invoice</th><th>Invoice amount</th><th>Calculated due date</th><th>Action</th></tr></thead>
            <tbody>{eligiblePagination.pageRows.map((item) => <tr key={item.invoiceNumber}>
              <td className="select-cell"><input type="checkbox" aria-label={`Select invoice ${item.invoiceNumber}`} disabled={!canStart}
                checked={pickedInvoices.has(item.invoiceNumber)} onChange={() => setPickedInvoices((current) => toggle(current, item.invoiceNumber))} /></td>
              <td><strong>{item.customerName}</strong><small>{item.customerNumber}</small></td>
              <td><strong>{item.invoiceNumber}</strong><small>{formatDate(item.invoiceDate)}</small></td>
              <td>{formatCurrency(item.amount,item.currency)}</td><td>{formatDate(item.dueDate)}<small>Invoice date + {item.dueDays} days</small></td>
              <td><button className="button button--secondary" type="button" disabled={!canStart} onClick={() => setStarting([item])}>Start journey</button></td>
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
            {bucket === 'journey' && chosenCases.length > 0 && <div className="bulk-bar" role="region" aria-label="Selected journeys">
              <strong>{chosenCases.length} selected</strong><span>{formatCurrency(chosenCases.reduce((sum, item) => sum + Number(item.receivable?.outstanding_amount ?? 0), 0), chosenCases[0]?.receivable?.currency ?? 'INR')}</span>
              <div className="bulk-bar__actions">
                <button className="button button--secondary" type="button" onClick={() => setPickedCases(new Set())}>Clear</button>
                <button className="button button--primary" type="button" disabled={!paymentConfig?.manualJourneys || !paymentConfig.sendEnabled} onClick={() => setSendingNow(chosenCases)}><Send size={15} aria-hidden="true" /> Send {chosenCases.length} now</button>
              </div>
            </div>}
            <PaymentCasesTable cases={pagination.pageRows} onOpen={(caseId) => onNavigate(`/payments/${caseId}`)}
              selection={bucket === 'journey' ? {
                picked: pickedCases, canPick: sendable,
                onToggle: (id) => setPickedCases((current) => toggle(current, id)),
                allPicked: sendableIds.length > 0 && sendableIds.every((id) => pickedCases.has(id)),
                onToggleAll: (all) => setPickedCases(all ? new Set(sendableIds) : new Set()),
              } : undefined} />
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
      {starting && paymentConfig && <StartJourneyPanel invoices={starting} config={paymentConfig} onClose={() => setStarting(null)}
        onFinished={async (caseId) => { setStarting(null); setPickedInvoices(new Set()); await load(true); if (caseId) onNavigate(`/payments/${caseId}`); }} />}
      {sendingNow && <SendNowPanel cases={sendingNow} onClose={() => setSendingNow(null)} onFinished={async () => { setSendingNow(null); setPickedCases(new Set()); await load(true); }} />}
    </AppShell>
  );
}

type Bucket = 'journey' | 'eligible' | 'paid';

const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'journey', label: 'In the journey' },
  { key: 'eligible', label: 'All eligible' },
  { key: 'paid', label: 'Paid' },
];

// Demo journeys from before manual mode were never started by anyone here; keep them out of the working list.
function isLegacyOpenJourney(paymentCase: PaymentFollowUpCase): boolean {
  return !isSettled(paymentCase) && paymentCase.receivable?.raw_data?.manual_payment_journey !== true;
}

function isSending(paymentCase: PaymentFollowUpCase): boolean {
  if (isSettled(paymentCase) || isLegacyOpenJourney(paymentCase)) return false;
  const job = paymentCase.latestJob;
  const messageStatus = relationOne(job?.messages)?.status;
  const dueSoon = paymentCase.status === 'active' && Boolean(paymentCase.next_action_at) && Date.parse(String(paymentCase.next_action_at)) - Date.now() < 120_000;
  return dueSoon
    || ['pending', 'awaiting_approval', 'queued', 'processing'].includes(job?.status ?? '')
    || ['created', 'queued', 'sent'].includes(messageStatus ?? '');
}

function isSettled(paymentCase: PaymentFollowUpCase): boolean {
  return Boolean(paymentCase.resolved_at) || (paymentCase.receivable ? Number(paymentCase.receivable.outstanding_amount) <= 0 : false);
}

function inBucket(paymentCase: PaymentFollowUpCase, bucket: Bucket): boolean {
  const settled = isSettled(paymentCase);
  if (bucket === 'paid') return settled;
  return bucket === 'journey' && !settled;
}

type RunState = { status: 'waiting' | 'running' | 'started' | 'failed'; message?: string };

function timingLine(config: PaymentFollowUpConfig): string {
  return `First reminder ${formatDuration(config.firstReminderDelaySeconds)} after you start, then every ${formatDuration(config.repeatReminderDelaySeconds)}, up to ${config.maximumTestReminders}. Marking paid stops them.`;
}

function StartJourneyPanel({ invoices, config, onClose, onFinished }: {
  invoices: EligiblePaymentInvoice[];
  config: PaymentFollowUpConfig;
  onClose: () => void;
  onFinished: (caseId?: number) => Promise<void>;
}) {
  const single = invoices.length === 1;
  const first = invoices[0]!;
  const [amount, setAmount] = useState(String(first.amount));
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [error, setError] = useState('');
  const total = invoices.reduce((sum, item) => sum + item.amount, 0);
  const amountValue = Math.round(Number(amount) * 100) / 100;
  const amountOk = !single || (amountValue > 0 && amountValue <= first.amount);
  const started = Object.values(runs).filter((run) => run.status === 'started').length;
  const failed = Object.values(runs).filter((run) => run.status === 'failed').length;

  async function run() {
    if (!amountOk || busy) return;
    setBusy(true); setError('');
    let firstCase: number | undefined;
    for (const invoice of invoices) {
      setRuns((current) => ({ ...current, [invoice.invoiceNumber]: { status: 'running' } }));
      try {
        const result = await apiRequest<{ caseId: number }>(`/payment-follow-up/journeys/${encodeURIComponent(invoice.invoiceNumber)}/start`, {
          method: 'POST',
          body: JSON.stringify({ confirmedUnpaid: true, outstandingAmount: single ? amountValue : invoice.amount, expectedDueDays: invoice.dueDays }),
        });
        firstCase ??= result.caseId;
        setRuns((current) => ({ ...current, [invoice.invoiceNumber]: { status: 'started' } }));
      } catch (cause) {
        const message = toMessage(cause);
        setRuns((current) => ({ ...current, [invoice.invoiceNumber]: { status: 'failed', message } }));
        if (single) setError(message);
      }
    }
    setBusy(false);
    if (single && firstCase) { await onFinished(firstCase); return; }
    if (!single) setFinished(true);
  }

  return <SidePanel
    title={single ? 'Start payment reminders' : `Start ${invoices.length} journeys`}
    subtitle={single ? `${first.customerName} · ${first.invoiceNumber}` : `${formatCurrency(total, first.currency)} across ${invoices.length} invoices`}
    onClose={() => { if (finished) void onFinished(); else onClose(); }}
    busy={busy}
    footer={finished
      ? <button className="button button--primary" type="button" onClick={() => void onFinished()}>Done</button>
      : <><button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button button--primary" type="button" disabled={!amountOk || busy} onClick={() => void run()}>
          {busy ? 'Starting…' : single ? 'Start reminders' : `Start ${invoices.length} journeys`}</button></>}
  >
    {single ? <>
      <dl className="sp-facts">
        <div><dt>Customer</dt><dd>{first.customerName}<small>{first.customerNumber}</small></dd></div>
        <div><dt>Sends to</dt><dd className="mono">{formatPhone(first.recipient)}</dd></div>
        <div><dt>Invoice</dt><dd>{first.invoiceNumber}<small>{formatDate(first.invoiceDate)}</small></dd></div>
        <div><dt>Calculated due date</dt><dd>{formatDate(first.dueDate)}<small>Invoice date + {first.dueDays} days</small></dd></div>
      </dl>
      <label className="field">
        <span>Amount to remind about ({first.currency})</span>
        <input type="number" min="0.01" max={first.amount} step="0.01" inputMode="decimal" value={amount} disabled={busy}
          aria-invalid={!amountOk} onChange={(event) => setAmount(event.target.value)} />
        <small className={amountOk ? undefined : 'text-danger'}>{amountOk ? `Full invoice amount. Lower it if part has been paid.` : `Enter an amount up to ${formatCurrency(first.amount, first.currency)}.`}</small>
      </label>
    </> : <>
      <div className="sp-total"><span>{invoices.length} invoices, full amounts</span><strong>{formatCurrency(total, first.currency)}</strong></div>
      <ul className="sp-list">
        {invoices.map((invoice) => {
          const state = runs[invoice.invoiceNumber];
          return <li key={invoice.invoiceNumber}>
            <span><strong>{invoice.customerName}</strong><small>{invoice.invoiceNumber} · {formatCurrency(invoice.amount, invoice.currency)}</small></span>
            {state?.status === 'started' ? <span className="sp-state sp-state--ok">Started</span>
              : state?.status === 'failed' ? <span className="sp-state sp-state--bad">{state.message}</span>
              : state?.status === 'running' ? <span className="sp-state">Starting…</span> : null}
          </li>;
        })}
      </ul>
      {finished && <p className="sp-note">{started} started{failed ? `, ${failed} could not start — they stay in All eligible.` : '.'}</p>}
    </>}
    {!finished && <p className="sp-note">{timingLine(config)}</p>}
    {error && <div className="alert alert--error" role="alert">{error}</div>}
  </SidePanel>;
}

function SendNowPanel({ cases, onClose, onFinished }: { cases: PaymentFollowUpCase[]; onClose: () => void; onFinished: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ queued: number[]; skipped: Array<{ caseId: number; reason: string }> } | null>(null);
  const total = cases.reduce((sum, item) => sum + Number(item.receivable?.outstanding_amount ?? 0), 0);
  const currency = cases[0]?.receivable?.currency ?? 'INR';
  const skipped = new Map((result?.skipped ?? []).map((item) => [item.caseId, item.reason]));

  async function send() {
    setBusy(true); setError('');
    try {
      setResult(await apiRequest<{ queued: number[]; skipped: Array<{ caseId: number; reason: string }> }>('/payment-follow-up/cases/send-now', {
        method: 'POST', body: JSON.stringify({ caseIds: cases.map((item) => item.id) }),
      }));
    } catch (cause) { setError(toMessage(cause)); } finally { setBusy(false); }
  }

  return <SidePanel
    title={`Send ${cases.length} ${cases.length === 1 ? 'reminder' : 'reminders'} now`}
    subtitle={`${formatCurrency(total, currency)} still to pay`}
    onClose={() => { if (result) void onFinished(); else onClose(); }}
    busy={busy}
    footer={result
      ? <button className="button button--primary" type="button" onClick={() => void onFinished()}>Done</button>
      : <><button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button button--primary" type="button" disabled={busy} onClick={() => void send()}><Send size={15} aria-hidden="true" /> {busy ? 'Sending…' : `Send ${cases.length} now`}</button></>}
  >
    <ul className="sp-list">
      {cases.map((item) => <li key={item.id}>
        <span><strong>{item.customer?.display_name ?? 'Customer unavailable'}</strong>
          <small>{item.invoice?.sap_billing_document} · {formatCurrency(Number(item.receivable?.outstanding_amount ?? 0), item.receivable?.currency)}</small></span>
        {result
          ? (skipped.has(item.id) ? <span className="sp-state sp-state--bad">{skipped.get(item.id)}</span> : <span className="sp-state sp-state--ok">Queued</span>)
          : <span className="sp-state">Next {formatRelative(item.next_action_at)}</span>}
      </li>)}
    </ul>
    {result
      ? <p className="sp-note">{result.queued.length} queued. They go out one after another over the next few minutes.</p>
      : <p className="sp-note">Reminders go out one after another over the next few minutes. Each one counts toward the reminder limit, and anything marked paid is skipped.</p>}
    {error && <div className="alert alert--error" role="alert">{error}</div>}
  </SidePanel>;
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

type CaseSelection = {
  picked: Set<number>;
  canPick: (item: PaymentFollowUpCase) => boolean;
  onToggle: (id: number) => void;
  allPicked: boolean;
  onToggleAll: (all: boolean) => void;
};

function PaymentCasesTable({
  cases,
  onOpen,
  selection,
}: {
  cases: PaymentFollowUpCase[];
  onOpen: (caseId: number) => void;
  selection?: CaseSelection | undefined;
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
        <thead><tr>
          {selection && <th className="select-cell"><input type="checkbox" aria-label="Select all journeys that can send now" checked={selection.allPicked} onChange={(event) => selection.onToggleAll(event.target.checked)} /></th>}
          <th>Customer</th><th>Invoice</th><th>Payment</th><th>Due date</th><th>Last reminder</th><th aria-label="Open" /></tr></thead>
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
                {selection && <td className="select-cell"><input type="checkbox" aria-label={`Select invoice ${paymentCase.invoice?.sap_billing_document ?? ''}`}
                  disabled={!selection.canPick(paymentCase)} title={selection.canPick(paymentCase) ? undefined : 'No reminder is waiting to be sent'}
                  checked={selection.picked.has(paymentCase.id)} onChange={() => selection.onToggle(paymentCase.id)} /></td>}
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
