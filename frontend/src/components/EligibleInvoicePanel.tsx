import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';
import { formatCurrency, formatDate, formatDateTime, toMessage } from '../lib/format';
import type { EligibleInvoiceDetails, EligibleManagers, EligiblePaymentInvoice, PaymentState } from '../types';
import { ReminderText } from './ReminderText';
import { SidePanel } from './SidePanel';
import { formatDuration } from './settings/duration';

const PAYMENT_TONE: Record<PaymentState, 'ok' | 'warn' | 'bad' | 'muted'> = {
  not_paid: 'ok', partly_paid: 'warn', paid: 'bad', cancelled: 'bad', unknown: 'muted', unavailable: 'muted',
};
export const PAYMENT_SHORT: Record<PaymentState, string> = {
  not_paid: 'Not paid', partly_paid: 'Partly paid', paid: 'Fully paid', cancelled: 'Cancelled', unknown: 'Not reported', unavailable: 'Unavailable',
};

/** SAP's payment status as a small coloured label, used in the list rows. */
export function PaymentPill({ state }: { state: PaymentState }) {
  return <span className={`ep-pill ep-pill--${PAYMENT_TONE[state]} ep-pill--small`}>{PAYMENT_SHORT[state]}</span>;
}
const CHECK_MARK: Record<EligibleInvoiceDetails['checks'][number]['state'], string> = { pass: '✓', fail: '✕', warn: '!', unknown: '?' };

/** Everything known about one eligible invoice, read live. Nothing here sends or changes anything. */
export function EligibleInvoicePanel({ invoice, canStart, onClose, onStart }: {
  invoice: EligiblePaymentInvoice;
  canStart: boolean;
  onClose: () => void;
  onStart: () => void;
}) {
  const [details, setDetails] = useState<EligibleInvoiceDetails | null>(null);
  const [error, setError] = useState('');
  const [managers, setManagers] = useState<EligibleManagers | null>(null);
  const [managersError, setManagersError] = useState(false);
  const openedAt = useMemo(() => Date.now(), []);

  useEffect(() => {
    let current = true;
    setDetails(null); setError(''); setManagers(null); setManagersError(false);
    const base = `/payment-follow-up/eligible/${encodeURIComponent(invoice.invoiceNumber)}`;
    apiRequest<EligibleInvoiceDetails>(`${base}/details`)
      .then((data) => { if (current) setDetails(data); })
      .catch((cause) => { if (current) setError(toMessage(cause)); });
    // The managers come from a slower live SAP lookup, so they fill in after the rest has appeared.
    apiRequest<EligibleManagers>(`${base}/managers`)
      .then((data) => { if (current) setManagers(data); })
      .catch(() => { if (current) setManagersError(true); });
    return () => { current = false; };
  }, [invoice.invoiceNumber]);

  const pastDue = details ? (details.daysPastDue > 0 ? `${details.daysPastDue} ${details.daysPastDue === 1 ? 'day' : 'days'} past` : details.daysPastDue === 0 ? 'Due today' : `Due in ${-details.daysPastDue} days`) : '';

  return <SidePanel
    title={invoice.invoiceNumber}
    subtitle={`${invoice.customerName} · ${formatCurrency(invoice.amount, invoice.currency)}`}
    onClose={onClose}
    footer={<><button className="button button--secondary" type="button" onClick={onClose}>Close</button>
      <button className="button button--primary" type="button" disabled={!canStart} onClick={onStart}>Start journey</button></>}
  >
    {error && <div className="alert alert--error" role="alert">Details could not be loaded: {error}</div>}
    {!details && !error && <div className="table-skeleton"><span /><span /><span /></div>}
    {details && <>
      <section className="ep-section">
        <h3>Payment</h3>
        <p className={`ep-pill ep-pill--${PAYMENT_TONE[details.payment.state]}`}>{details.payment.label}</p>
        {details.payment.state === 'paid' && <p className="sp-note">SAP shows this invoice as fully paid. Starting reminders would be wrong unless SAP is behind.</p>}
        {details.payment.state === 'partly_paid' && <p className="sp-note">SAP shows part of this invoice as paid but not how much. The reminder quotes the amount you enter when you start.</p>}
        <dl className="sp-facts">
          <div><dt>Due date</dt><dd>{formatDate(details.dueDate)}<small>Invoice date + {details.dueDays} days</small></dd></div>
          <div><dt>Days past due date</dt><dd>{pastDue}</dd></div>
          {details.payment.paymentTerms && <div><dt>Payment terms in SAP</dt><dd className="mono">{details.payment.paymentTerms}</dd></div>}
        </dl>
      </section>

      <section className="ep-section">
        <h3>Invoice delivery</h3>
        {details.delivery.delivered ? <dl className="sp-facts">
          <div><dt>Status</dt><dd>{details.delivery.readAt ? 'Read by the customer' : details.delivery.deliveredAt ? 'Delivered' : 'Sent'}</dd></div>
          <div><dt>Sent</dt><dd>{details.delivery.sentAt ? formatDateTime(details.delivery.sentAt) : '—'}</dd></div>
          {details.delivery.deliveredAt && <div><dt>Delivered</dt><dd>{formatDateTime(details.delivery.deliveredAt)}</dd></div>}
          {details.delivery.readAt && <div><dt>Read</dt><dd>{formatDateTime(details.delivery.readAt)}</dd></div>}
          <div><dt>Sent to</dt><dd className="mono">{details.delivery.toLast4 ? `•••• ${details.delivery.toLast4}` : '—'}</dd></div>
        </dl> : <p className="sp-note">This invoice was not delivered to the customer by this app.</p>}
      </section>

      <section className="ep-section">
        <h3>On the invoice</h3>
        <dl className="sp-facts">
          <div><dt>Invoice date</dt><dd>{formatDate(details.invoiceDate)}</dd></div>
          <div><dt>Created in SAP</dt><dd>{details.createdAt ? formatDateTime(details.createdAt) : '—'}</dd></div>
          <div><dt>Total</dt><dd>{formatCurrency(details.amount, details.currency)}</dd></div>
        </dl>
        {details.items.length === 0 ? <p className="sp-note">No product lines are stored for this invoice.</p> : <ul className="sp-list">
          {details.items.map((item) => <li key={item.number}>
            <span><strong>{item.description ?? item.productId}</strong>
              <small>{item.productId}{item.quantity !== null ? ` · ${item.quantity} ${item.unit ?? ''}` : ''}{item.amount !== null ? ` · ${formatCurrency(item.amount, details.currency)}` : ''}</small>
              {item.batches.length > 0 && <details className="ep-batches"><summary>{item.batches.length} {item.batches.length === 1 ? 'batch' : 'batches'}</summary><p>{item.batches.join(', ')}</p></details>}</span>
            <span className={item.enabled ? 'sp-state sp-state--ok' : 'sp-state sp-state--bad'}>{item.enabled ? 'On' : 'Off'}</span>
          </li>)}
        </ul>}
      </section>

      <section className="ep-section">
        <h3>If you start the journey</h3>
        <p className="ep-label">The customer receives</p>
        <div className="ep-message"><ReminderText customerName={details.customerName} amount={details.amount} invoiceNumber={details.invoiceNumber} invoiceDate={details.invoiceDate} /></div>
        <p className="ep-hint">The amount is the full invoice. You can lower it when you start.</p>
        <p className="ep-label">When the reminders go out, if you start now</p>
        <ul className="sp-list">
          {Array.from({ length: details.reminders.maximum }, (_, index) => {
            const at = openedAt + (details.reminders.firstDelaySeconds + index * details.reminders.repeatDelaySeconds) * 1000;
            return <li key={index}><span>Reminder {index + 1}</span><span className="sp-state">{formatDateTime(new Date(at).toISOString())}</span></li>;
          })}
        </ul>
        <p className="ep-hint">First {formatDuration(details.reminders.firstDelaySeconds)} after you start, then every {formatDuration(details.reminders.repeatDelaySeconds)}, up to {details.reminders.maximum}. Marking paid stops them.</p>
        <dl className="sp-facts">
          <div><dt>Reminders go to</dt><dd className="mono">{details.reminders.toLast4 ? `•••• ${details.reminders.toLast4}` : '—'}</dd></div>
          <div><dt>Marketing manager copy</dt><dd>{managersError ? 'Could not check right now'
            : !managers ? 'Checking SAP…'
            : !managers.enabled ? 'Switched off'
            : managers.last4.length ? `${managers.last4.length} ${managers.last4.length === 1 ? 'manager' : 'managers'}: ${managers.last4.map((digits) => `•••• ${digits}`).join(', ')}`
            : 'No copy will be sent'}
            {managers && managers.last4.length === 0 && managers.reason && <small>{managers.reason}</small>}</dd></div>
        </dl>
        {managers && managers.last4.length > 0 && <p className="ep-hint">Each manager gets a copy of every reminder.</p>}
      </section>

      <section className="ep-section">
        <h3>Why it is in this list</h3>
        <ul className="ep-checks">
          {details.checks.map((check) => <li key={check.key} className={`ep-check ep-check--${check.state}`}>
            <span className="ep-check__mark" aria-hidden="true">{CHECK_MARK[check.state]}</span>
            <span><strong>{check.label}</strong><small>{check.detail}</small></span>
          </li>)}
        </ul>
      </section>
    </>}
  </SidePanel>;
}
