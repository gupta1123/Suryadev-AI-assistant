import {
  AlertTriangle,
  BadgeIndianRupee,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type DeliveryConfig,
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
  const [deliveryConfig, setDeliveryConfig] = useState<DeliveryConfig | null>(null);
  const [paymentConfig, setPaymentConfig] = useState<PaymentFollowUpConfig | null>(null);
  const [cases, setCases] = useState<PaymentFollowUpCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const [nextDeliveryConfig, nextPaymentConfig, nextCases] = await Promise.all([
        apiRequest<DeliveryConfig>('/invoice-delivery/config'),
        apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
        apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases'),
      ]);
      setDeliveryConfig(nextDeliveryConfig);
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

  return (
    <AppShell
      route={route}
      config={deliveryConfig}
      eyebrow="Payment follow-up agent"
      title="Payment follow-ups"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      actions={(
        <button
          className="button button--primary"
          type="button"
          disabled={!paymentConfig?.configured}
          onClick={() => setModalOpen(true)}
        >
          <Send size={16} aria-hidden="true" /> Run controlled test
        </button>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      <section className="payment-safety-banner">
        <span><ShieldCheck size={20} aria-hidden="true" /></span>
        <div>
          <strong>Controlled test deployment</strong>
          <p>
            Locked to {paymentConfig?.maskedRecipient || 'the approved test number'}. The invoice is sent first. After WhatsApp reports that invoice as sent, the first payment reminder is scheduled after {paymentConfig?.firstReminderDelaySeconds ?? 120} seconds and the next after {paymentConfig?.repeatReminderDelaySeconds ?? 20} seconds. The agent checks payment status before every reminder and stops after {paymentConfig?.maximumTestReminders ?? 2} reminders.
          </p>
        </div>
        <em>{paymentConfig?.deploymentAllowed ? 'Safety lock active' : 'Disabled'}</em>
      </section>

      <section className="panel deliveries-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Receivables</p>
            <h2>Payment cases</h2>
            <p className="section-description">Amounts due, reminder status and the next follow-up date.</p>
          </div>
          <button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void load(true)}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
        {loading ? <div className="table-skeleton"><span /><span /><span /></div> : (
          <PaymentCasesTable cases={cases} onOpen={(caseId) => onNavigate(`/payment-follow-ups/${caseId}`)} />
        )}
      </section>

      {modalOpen && (
        <PaymentTestModal
          onClose={() => setModalOpen(false)}
          onComplete={(result) => {
            setModalOpen(false);
            onNavigate(`/payment-follow-ups/${result.caseId}`);
          }}
        />
      )}
    </AppShell>
  );
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
        <strong>No payment cases yet</strong>
        <p>Run the controlled test when you are ready.</p>
      </div>
    );
  }
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Customer</th><th>Invoice</th><th>Outstanding</th><th>Due date</th><th>Reminder</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {cases.map((paymentCase) => {
            const message = relationOne(paymentCase.latestJob?.messages);
            const status = message?.status ?? paymentCase.latestJob?.status ?? paymentCase.status;
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

function PaymentTestModal({
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
      title="Run invoice-to-payment test"
      description="Review the exact SAP invoice and recipient. The test sends the invoice first, then schedules two payment reminders from the successful invoice send."
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
              <div><span>Source</span><strong>SAP QAS + test payment status</strong></div>
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
              <Send size={15} aria-hidden="true" /> {sending ? 'Starting test…' : 'Send invoice and start test'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
