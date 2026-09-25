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
  const [bucket, setBucket] = useState<Bucket>('open');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextPaymentConfig, nextCases] = await Promise.all([
        apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
        apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases'),
      ]);
      setPaymentConfig(nextPaymentConfig);
      setCases(nextCases);
      setError('');
    } catch (loadError) {
      setError(toMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
  const bucketCounts = useMemo(() => Object.fromEntries(BUCKETS.map(({ key }) => [key, searched.filter((item) => inBucket(item, key)).length])) as Record<Bucket, number>, [searched]);
  const filtered = useMemo(() => searched.filter((item) => inBucket(item, bucket)), [searched, bucket]);
  const totalDue = filtered.reduce((sum, item) => sum + (isSettled(item) ? 0 : Number(item.receivable?.outstanding_amount ?? 0)), 0);
  const dueCurrency = filtered.find((item) => item.receivable)?.receivable?.currency ?? 'INR';
  const filtersActive = Boolean(search || reminder || paymentStatus);
  const pagination = usePagination(filtered, 'payment-cases', `${search}|${reminder}|${paymentStatus}|${bucket}`);

  function clearFilters() {
    setSearch('');
    setReminder('');
    setPaymentStatus('');
  }

  return (
    <AppShell
      route={route}
      eyebrow="Unpaid invoices and their reminders"
      title="Payments"
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

      <section className="list-section">
        <div className="seg-tabs" role="tablist" aria-label="How late">
          {BUCKETS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={bucket === key} className={bucket === key ? 'seg-tab seg-tab--active' : 'seg-tab'} type="button" onClick={() => setBucket(key)}>
              {key !== 'open' && key !== 'paid' && <i className={`seg-tab__dot seg-tab__dot--age-${key}`} />}
              {label}<span>{bucketCounts[key]}</span>
            </button>
          ))}
        </div>
        {!loading && totalDue > 0 && (
          <p className="list-summary"><strong>{formatCurrency(totalDue, dueCurrency)}</strong> still to pay across {filtered.filter((item) => !isSettled(item)).length} invoices</p>
        )}
        <FilterBar
          search={search}
          searchPlaceholder="Search customer or invoice"
          onSearchChange={setSearch}
          active={filtersActive}
          onClear={clearFilters}
        >
          <FilterSelect label="Reminder" value={reminder} options={reminderOptions} onChange={setReminder} />
          <FilterSelect label="Payment" value={paymentStatus} options={paymentStatusOptions} onChange={setPaymentStatus} />
        </FilterBar>
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : cases.length > 0 && filtered.length === 0 ? (
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

    </AppShell>
  );
}

type Bucket = 'open' | 'current' | 'late30' | 'late60' | 'late60plus' | 'paid';

const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'open', label: 'All unpaid' },
  { key: 'current', label: 'Not yet due' },
  { key: 'late30', label: '1–30 days late' },
  { key: 'late60', label: '31–60 days late' },
  { key: 'late60plus', label: '60+ days late' },
  { key: 'paid', label: 'Paid' },
];

function isSettled(paymentCase: PaymentFollowUpCase): boolean {
  return Boolean(paymentCase.resolved_at) || (paymentCase.receivable ? Number(paymentCase.receivable.outstanding_amount) <= 0 : false);
}

function inBucket(paymentCase: PaymentFollowUpCase, bucket: Bucket): boolean {
  const settled = isSettled(paymentCase);
  if (bucket === 'paid') return settled;
  if (settled) return false;
  const days = paymentCase.receivable?.days_overdue ?? 0;
  if (bucket === 'current') return days <= 0;
  if (bucket === 'late30') return days >= 1 && days <= 30;
  if (bucket === 'late60') return days >= 31 && days <= 60;
  if (bucket === 'late60plus') return days > 60;
  return true;
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
        <p>Invoices show up here when they’re waiting to be paid. You can send a test reminder from Settings.</p>
      </div>
    );
  }
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Customer</th><th>Invoice</th><th>Amount due</th><th>Due date</th><th>Last reminder</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {cases.map((paymentCase) => {
            const status = reminderStatus(paymentCase);
            return (
              <tr key={paymentCase.id}>
                <td><strong>{paymentCase.customer?.display_name ?? 'Customer unavailable'}</strong><small>{paymentCase.customer?.sap_customer_number ?? '—'}</small></td>
                <td><span className="invoice-number">{paymentCase.invoice?.sap_billing_document ?? '—'}</span><small>{formatDate(paymentCase.invoice?.billing_document_date)}</small></td>
                <td><strong>{formatCurrency(Number(paymentCase.receivable?.outstanding_amount ?? 0), paymentCase.receivable?.currency)}</strong><small>{paymentCase.receivable?.payment_status.replaceAll('_', ' ') ?? '—'}</small></td>
                <td>{formatDate(paymentCase.receivable?.due_date)}<small>{paymentCase.receivable?.aging_bucket ?? '—'}</small></td>
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
  onClose,
  onComplete,
}: {
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
      description="We’ll send the invoice first, then two payment reminders. Check the details below before sending."
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
