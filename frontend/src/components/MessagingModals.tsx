import { CheckCircle2, CircleX } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../lib/api';
import { toMessage } from '../lib/format';
import type { EligibilityResult, InternalRecipientRow, MessagingCustomer } from '../types';
import { Modal } from './Modal';

const plus = (phone: string | null) => (phone ? `+${phone}` : '—');

function useAction(onDone: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      await onDone();
    } catch (failure) {
      setError(toMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function EnableMessagingModal({ mode, customer, onClose, onDone }: {
  mode: 'enable' | 'disable'; customer: MessagingCustomer; onClose: () => void; onDone: () => Promise<void> | void;
}) {
  const { busy, error, run } = useAction(onDone);
  const enabling = mode === 'enable';
  const title = customer.name ?? customer.customerNumber;
  return (
    <Modal
      title={enabling ? 'Enable messaging' : 'Disable messaging'}
      description={`${title} · SAP ${customer.customerNumber}`}
      onClose={onClose}
    >
      {enabling ? (
        <>
          <p className="set-note">Messages for this customer will be sent only to the SAP number below.</p>
          <p className="destination-number mono">{plus(customer.livePhone)}</p>
          <ul className="set-note">
            <li>Only documents created from this moment on are sent.</li>
            <li>If SAP later reports a different number, sending pauses until you approve it again.</li>
            <li>This does not confirm that the number is registered on WhatsApp.</li>
          </ul>
        </>
      ) : (
        <p className="set-note">No new messages will be sent to this customer or copied to its marketing manager. Messages already sent are not affected.</p>
      )}
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      <div className="modal-footer">
        <button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="button button--primary"
          type="button"
          disabled={busy || (enabling && !customer.livePhone)}
          onClick={() => void run(() => apiRequest(`/messaging/customers/${customer.customerNumber}/enabled`, {
            method: 'PUT',
            body: JSON.stringify(enabling ? { enabled: true, expectedPhone: customer.livePhone } : { enabled: false }),
          }))}
        >
          {busy ? 'Saving…' : enabling ? 'Enable messaging' : 'Disable messaging'}
        </button>
      </div>
    </Modal>
  );
}

export function ManagerModal({ customer, onClose, onDone }: {
  customer: MessagingCustomer; onClose: () => void; onDone: () => Promise<void> | void;
}) {
  const { busy, error, run } = useAction(onDone);
  const [name, setName] = useState(customer.setting?.managerName ?? '');
  const [phone, setPhone] = useState(customer.setting?.managerPhone ?? '');
  const [confirm, setConfirm] = useState('');
  const hasManager = Boolean(customer.setting?.managerPhone);
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => apiRequest(`/messaging/customers/${customer.customerNumber}/manager`, {
      method: 'PUT',
      body: JSON.stringify({ managerName: name, managerPhone: phone, confirmManagerPhone: confirm }),
    }));
  }
  return (
    <Modal
      title="Marketing manager"
      description={`${customer.name ?? customer.customerNumber} · SAP ${customer.customerNumber}. Receives a copy of every message sent to this customer.`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field field--full"><span>Manager name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
          </label>
          <label className="field"><span>WhatsApp number</span>
            <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="917019339764" required />
          </label>
          <label className="field"><span>Re-enter number to confirm</span>
            <input value={confirm} onChange={(event) => setConfirm(event.target.value)} inputMode="tel" autoComplete="off" required />
          </label>
        </div>
        <p className="set-note">Stored here until the client grants access to the SAP marketing manager record. The number must also be on the server-approved manager list.</p>
        {error && <div className="alert alert--error" role="alert">{error}</div>}
        <div className="modal-footer">
          {hasManager && (
            <button className="button button--secondary" type="button" disabled={busy}
              onClick={() => void run(() => apiRequest(`/messaging/customers/${customer.customerNumber}/manager`, { method: 'PUT', body: JSON.stringify({ clear: true }) }))}>
              Remove manager
            </button>
          )}
          <button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save manager'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function EligibilityModal({ customer, onClose }: { customer: MessagingCustomer; onClose: () => void }) {
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiRequest<EligibilityResult>(`/messaging/customers/${customer.customerNumber}/eligibility`)
      .then(setResult)
      .catch((failure) => setError(toMessage(failure)));
  }, [customer.customerNumber]);
  return (
    <Modal
      title="Check eligibility"
      description={`${customer.name ?? customer.customerNumber} · Reports what would happen now. Nothing is sent.`}
      onClose={onClose}
    >
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      {!result && !error && <p className="set-note">Checking…</p>}
      {result && (
        <ul className="set-rows">
          {result.checks.map((check) => (
            <li key={check.label} className="set-row">
              {check.passed ? <CheckCircle2 size={16} color="#15803d" aria-hidden="true" /> : <CircleX size={16} color="#dc2626" aria-hidden="true" />}
              <span className="set-row__text">
                <strong>{check.label}</strong>
                {check.detail && <small>{check.detail}</small>}
              </span>
              <span className={`health health--${check.passed ? 'ok' : 'bad'}`}>{check.passed ? 'Yes' : 'No'}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function InternalNumbers({ rows, onChanged }: { rows: InternalRecipientRow[]; onChanged: () => Promise<void> | void }) {
  const { busy, error, run } = useAction(onChanged);
  const update = (row: InternalRecipientRow, change: Partial<Pick<InternalRecipientRow, 'allowSimulator' | 'allowPaymentReminders'>>) =>
    run(() => apiRequest(`/messaging/internal-recipients/${row.phone}`, {
      method: 'PUT',
      body: JSON.stringify({
        label: row.label,
        allowSimulator: change.allowSimulator ?? row.allowSimulator,
        allowPaymentReminders: change.allowPaymentReminders ?? row.allowPaymentReminders,
      }),
    }));
  return (
    <>
      <p className="set-note">Team numbers that may receive test documents and payment reminders. Only numbers already approved on the server are listed.</p>
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      <div className="table-scroll">
        <table className="customers-table">
          <thead><tr><th>Number</th><th>Test documents</th><th>Payment reminders</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.phone}>
                <td className="mono">+{row.phone}{row.alsoCustomerPhone && <small> · also a client’s SAP number</small>}</td>
                <td><label><input type="checkbox" checked={row.allowSimulator} disabled={busy} onChange={(event) => void update(row, { allowSimulator: event.target.checked })} style={{ width: 'auto', height: 'auto' }} /> Allowed</label></td>
                <td><label><input type="checkbox" checked={row.allowPaymentReminders} disabled={busy || !row.paymentCeiling} onChange={(event) => void update(row, { allowPaymentReminders: event.target.checked })} style={{ width: 'auto', height: 'auto' }} /> {row.paymentCeiling ? 'Allowed' : 'Not permitted by server'}</label></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
