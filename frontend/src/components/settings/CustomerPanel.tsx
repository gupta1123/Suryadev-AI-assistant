import { ArrowLeft, CheckCircle2, CircleX, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { formatDateTime, formatPhone, toMessage } from '../../lib/format';
import type { EligibilityResult, CustomerApprovalPreview } from '../../types';
import { Modal } from '../Modal';
import { managerSummary, STATUS_PILL, type CustomerRow } from './customer-rows';
import { LiveNote, Pill } from './ui';

export type PanelView = 'overview' | 'enable' | 'disable' | 'manager';

export function CustomerPanel({
  row,
  initialView,
  onClose,
  onChanged,
}: {
  row: CustomerRow;
  initialView: PanelView;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<PanelView>(initialView);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  async function finished(message: string) {
    await onChanged();
    setNotice(message);
    setRevision((value) => value + 1);
    setView('overview');
  }

  return (
    <Modal title={row.name} description={`SAP customer ${row.number}`} onClose={onClose}>
      {view === 'overview' && <Overview row={row} notice={notice} revision={revision} onView={setView} />}
      {(view === 'enable' || view === 'disable') && (
        <ConfirmMessaging
          row={row}
          enabling={view === 'enable'}
          onBack={() => setView('overview')}
          onDone={() => finished(view === 'enable' ? 'Messaging is on for this customer.' : 'Messaging is off for this customer.')}
        />
      )}
      {view === 'manager' && (
        <ManagerForm row={row} onBack={() => setView('overview')} onDone={(message) => finished(message)} />
      )}
    </Modal>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(task: () => Promise<unknown>, onDone: () => Promise<void>) {
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

function Overview({
  row,
  notice,
  revision,
  onView,
}: {
  row: CustomerRow;
  notice: string;
  revision: number;
  onView: (view: PanelView) => void;
}) {
  const pill = STATUS_PILL[row.status];
  const customer = row.messaging;
  const manager = managerSummary(row);
  const setting = customer?.setting;
  const canManage = row.status === 'enabled' || row.status === 'review' || row.status === 'off';

  return (
    <div className="st-panel">
      {notice && <LiveNote>{notice}</LiveNote>}

      <section className="st-panel__block">
        <div className="st-panel__title">
          <h3>Messaging</h3>
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </div>
        <p>{statusSentence(row)}</p>
        <div className="st-panel__buttons">
          {row.status === 'off' && (
            <button className="button button--primary" type="button" disabled={!row.phone} onClick={() => onView('enable')}>Turn on messaging</button>
          )}
          {row.status === 'review' && (
            <>
              <button className="button button--primary" type="button" onClick={() => onView('enable')}>Approve new number</button>
              <button className="button button--secondary" type="button" onClick={() => onView('disable')}>Turn off</button>
            </>
          )}
          {row.status === 'enabled' && (
            <button className="button button--secondary" type="button" onClick={() => onView('disable')}>Turn off messaging</button>
          )}
        </div>
        {row.status === 'nophone' && <p className="st-hint">SAP has no phone number for this customer, so it can’t be turned on.</p>}
      </section>

      {canManage && <Eligibility key={`${row.number}-${row.status}-${revision}`} customerNumber={row.number} />}

      {canManage && (
        <section className="st-panel__block">
          <div className="st-panel__title">
            <h3>Marketing manager copy</h3>
            {customer?.managerCopy?.source !== 'sap' && (
              <button className="button button--secondary st-sm" type="button" onClick={() => onView('manager')}>
                {setting?.managerPhone ? 'Change' : 'Assign a manager'}
              </button>
            )}
          </div>
          <p>A copy of every message sent to this customer also goes to their marketing manager.</p>
          <div className={`st-manager st-manager--${manager.kind}`}>
            <strong>{manager.title}</strong>
            {manager.detail && <span>{manager.detail}</span>}
          </div>
          {manager.warning && <p className="st-hint st-hint--warn">{manager.warning}</p>}
          {customer?.managerCopy?.source === 'sap' && <p className="st-hint">The manager comes from SAP and can’t be changed here.</p>}
        </section>
      )}

      <details className="st-details">
        <summary>From SAP</summary>
        {row.sap ? (
          <div className="st-sap">
            <h4>Phone numbers</h4>
            {row.sap.phones.length ? (
              <ul>
                {row.sap.phones.map((phone) => (
                  <li key={phone.number}>
                    <span className="mono">{formatPhone(phone.number)}</span>
                    {phone.number === row.sap?.primaryPhone && <em>used for messages</em>}
                    {phone.isDefault && <em>SAP default</em>}
                  </li>
                ))}
              </ul>
            ) : <p className="st-hint">No phone number is kept in SAP for this customer.</p>}
            <h4>Sales areas</h4>
            {row.sap.salesAssignments.length ? (
              <table className="st-mini">
                <thead><tr><th>Area</th><th>Group</th><th>Office</th><th>Manager</th></tr></thead>
                <tbody>
                  {row.sap.salesAssignments.map((area, index) => (
                    <tr key={index}>
                      <td className="mono">{area.salesOrganization || '—'} / {area.distributionChannel || '—'} / {area.division || '—'}</td>
                      <td className="mono">{area.salesGroup || '—'}</td>
                      <td className="mono">{area.salesOffice || '—'}</td>
                      <td className="mono">{area.marketingManagerPhone ? formatPhone(area.marketingManagerPhone) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="st-hint">No sales area is maintained in SAP.</p>}
          </div>
        ) : <p className="st-hint">SAP details aren’t available right now.</p>}
      </details>
    </div>
  );
}

function statusSentence(row: CustomerRow): string {
  const setting = row.messaging?.setting;
  switch (row.status) {
    case 'enabled':
      return `Eligible invoices and memos go to ${formatPhone(row.phone)}. Only documents created since ${formatDateTime(setting?.enabledAt)} are sent. Payment reminders also require this switch to be on and their separate reminder approvals.`;
    case 'review':
      return `SAP now lists ${formatPhone(row.phone)}, but you approved ${formatPhone(setting?.approvedPhone)}. New automatic documents are blocked until you approve the new number. Turn messaging off to also block existing reminders and queued document sends.`;
    case 'off':
      return 'New invoice, memo, reminder, sample-document sends and manager copies are blocked. Messages already handed to WhatsApp cannot be recalled. Customer-initiated Need Help alerts are handled separately.';
    case 'nophone':
      return 'SAP has no phone number for this customer, so it can’t be turned on until one is added in SAP.';
    case 'locked':
      return 'This customer cannot currently be approved. Refresh SAP and check whether dashboard approval is enabled on the server.';
    default:
      return 'Messaging controls couldn’t be loaded. Close this window and try again.';
  }
}

function Eligibility({ customerNumber }: { customerNumber: string }) {
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await apiRequest<EligibilityResult>(`/messaging/customers/${customerNumber}/eligibility`));
      setError('');
    } catch (failure) {
      setError(toMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [customerNumber]);
  useEffect(() => { void load(); }, [load]);

  const failing = result?.checks.filter((check) => !check.passed) ?? [];
  const passing = result?.checks.filter((check) => check.passed) ?? [];
  return (
    <section className="st-panel__block">
      <div className="st-panel__title">
        <h3>Would a new document be sent?</h3>
        <button className="button button--secondary st-sm" type="button" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} aria-hidden="true" /> Re-check
        </button>
      </div>
      {error && <LiveNote tone="bad">{error}</LiveNote>}
      {!result && !error && <p className="st-hint">Checking…</p>}
      {result && (
        <>
          <p className={failing.length ? 'st-verdict st-verdict--bad' : 'st-verdict st-verdict--ok'}>
            {failing.length
              ? `Not right now — ${failing.length} ${failing.length === 1 ? 'thing' : 'things'} to fix.`
              : 'Yes — every check passed. Nothing is sent by this check.'}
          </p>
          {failing.length > 0 && (
            <ul className="st-checks">
              {failing.map((check) => (
                <li key={check.label}>
                  <CircleX size={16} aria-hidden="true" />
                  <div><strong>{check.label}</strong>{check.detail && <p>{check.detail}</p>}</div>
                </li>
              ))}
            </ul>
          )}
          {passing.length > 0 && (
            <details className="st-details st-details--inline">
              <summary>{passing.length} {passing.length === 1 ? 'check' : 'checks'} passed</summary>
              <ul className="st-checks st-checks--ok">
                {passing.map((check) => (
                  <li key={check.label}>
                    <CheckCircle2 size={16} aria-hidden="true" />
                    <div><strong>{check.label}</strong>{check.detail && <p>{check.detail}</p>}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ConfirmMessaging({
  row,
  enabling,
  onBack,
  onDone,
}: {
  row: CustomerRow;
  enabling: boolean;
  onBack: () => void;
  onDone: () => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const approving = row.status === 'review';
  const [preview, setPreview] = useState<CustomerApprovalPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [sharedConfirmed, setSharedConfirmed] = useState(false);
  useEffect(() => {
    if (!enabling) return;
    let active = true;
    void apiRequest<CustomerApprovalPreview>(`/messaging/customers/${row.number}/approval-preview`)
      .then(value => { if (active) setPreview(value); })
      .catch(failure => { if (active) setPreviewError(toMessage(failure)); });
    return () => { active = false; };
  }, [row.number, enabling]);
  return (
    <div className="st-panel">
      <button className="st-back" type="button" onClick={onBack} disabled={busy}><ArrowLeft size={14} aria-hidden="true" /> Back</button>
      <h3 className="st-confirm__title">{enabling ? (approving ? 'Approve the new number?' : 'Turn on messaging?') : 'Turn off messaging?'}</h3>
      {enabling ? (
        <>
          {!preview && !previewError && <p role="status">Checking the latest customer and phone details in SAP…</p>}
          {previewError && <LiveNote tone="bad">{previewError} Approval is blocked; close this dialog and try again.</LiveNote>}
          {preview?.blocker && <LiveNote tone="bad">{preview.blocker}</LiveNote>}
          <p>Invoices and memos for {preview?.name ?? row.name} (SAP {row.number}) will be sent only to:</p>
          <p className="st-confirm__number mono">{formatPhone(preview?.phone ?? row.phone)}</p>
          {preview && <p>Manager copy: {preview.managerRecipient ? formatPhone(preview.managerRecipient) : preview.managerReason ?? 'No copy'}. No other customer is enabled by this approval.</p>}
          {preview && preview.sharedPhoneCustomers.length > 0 && <LiveNote tone="bad">
            This number is also on {preview.sharedPhoneCustomers.length} other SAP customer record(s): {preview.sharedPhoneCustomers.slice(0, 10).map(item => `${item.name} (${item.customerNumber})`).join(', ')}.
          </LiveNote>}
          <ul className="st-bullets">
            <li>Only documents created from this moment on are sent — older ones are not.</li>
            <li>Documents dated before 20 October 2026 are blocked in every sending path, even if imported or retried today.</li>
            <li>If SAP later reports a different number, new automatic documents pause until you approve it again.</li>
            <li>We can’t tell whether this number is on WhatsApp.</li>
            <li>Payment reminders and sample documents also need this customer enabled, plus their separate test/reminder approvals.</li>
          </ul>
          <label className="st-approval-check"><input type="checkbox" checked={confirmed} disabled={busy || !preview?.canEnable} onChange={event => setConfirmed(event.target.checked)} /> I have verified this customer and number, and authorise future eligible messages to this contact.</label>
          {Boolean(preview?.sharedPhoneCustomers.length) && <label className="st-approval-check"><input type="checkbox" checked={sharedConfirmed} disabled={busy} onChange={event => setSharedConfirmed(event.target.checked)} /> I understand this is a shared number and confirm it is the intended destination for this customer.</label>}
        </>
      ) : (
        <p>Block new invoices, memos, payment reminders, sample documents and manager copies for {row.name}, including queued items checked after saving. Messages already handed to WhatsApp cannot be recalled. Customer-initiated Need Help alerts are handled separately.</p>
      )}
      {error && <LiveNote tone="bad">{error}</LiveNote>}
      <div className="modal-footer">
        <button className="button button--secondary" type="button" onClick={onBack} disabled={busy}>Cancel</button>
        <button
          className={enabling ? 'button button--primary' : 'button button--danger'}
          type="button"
          disabled={busy || (enabling && (!preview?.canEnable || !confirmed || (Boolean(preview.sharedPhoneCustomers.length) && !sharedConfirmed)))}
          onClick={() => void run(
            () => apiRequest(`/messaging/customers/${row.number}/enabled`, {
              method: 'PUT',
              body: JSON.stringify(enabling ? { enabled: true, expectedPhone: preview?.phone, acknowledgeRecipient: confirmed, acknowledgeSharedPhone: sharedConfirmed } : { enabled: false }),
            }),
            onDone,
          )}
        >
          {busy ? 'Saving…' : enabling ? (approving ? 'Approve this number' : 'Turn on') : 'Turn off'}
        </button>
      </div>
    </div>
  );
}

function ManagerForm({
  row,
  onBack,
  onDone,
}: {
  row: CustomerRow;
  onBack: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const setting = row.messaging?.setting;
  const [name, setName] = useState(setting?.managerName ?? '');
  const [phone, setPhone] = useState(setting?.managerPhone ?? '');
  const [confirm, setConfirm] = useState('');
  const hasManager = Boolean(setting?.managerPhone);
  const mismatch = confirm.length > 0 && confirm.replace(/\D/g, '') !== phone.replace(/\D/g, '');

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(
      () => apiRequest(`/messaging/customers/${row.number}/manager`, {
        method: 'PUT',
        body: JSON.stringify({ managerName: name, managerPhone: phone, confirmManagerPhone: confirm }),
      }),
      () => onDone('Marketing manager saved.'),
    );
  }

  return (
    <form className="st-panel" onSubmit={submit}>
      <button className="st-back" type="button" onClick={onBack} disabled={busy}><ArrowLeft size={14} aria-hidden="true" /> Back</button>
      <h3 className="st-confirm__title">{hasManager ? 'Change marketing manager' : 'Assign a marketing manager'}</h3>
      <p>They’ll get a copy of every message sent to {row.name}.</p>
      <div className="form-grid">
        <label className="field field--full"><span>Manager’s name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus />
        </label>
        <label className="field"><span>WhatsApp number</span>
          <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" placeholder="98765 43210" required />
          <small>Add the country code for non-Indian numbers.</small>
        </label>
        <label className="field"><span>Type it again to confirm</span>
          <input value={confirm} onChange={(event) => setConfirm(event.target.value)} inputMode="tel" autoComplete="off" required aria-invalid={mismatch} />
          {mismatch && <small className="text-danger">The numbers don’t match.</small>}
        </label>
      </div>
      <p className="st-hint">The number must also be on the server’s approved manager list.</p>
      {error && <LiveNote tone="bad">{error}</LiveNote>}
      <div className="modal-footer">
        {hasManager && (
          <button
            className="button button--secondary st-footer-left"
            type="button"
            disabled={busy}
            onClick={() => void run(
              () => apiRequest(`/messaging/customers/${row.number}/manager`, { method: 'PUT', body: JSON.stringify({ clear: true }) }),
              () => onDone('Marketing manager removed.'),
            )}
          >
            Remove manager
          </button>
        )}
        <button className="button button--secondary" type="button" onClick={onBack} disabled={busy}>Cancel</button>
        <button className="button button--primary" type="submit" disabled={busy || mismatch}>{busy ? 'Saving…' : 'Save manager'}</button>
      </div>
    </form>
  );
}
