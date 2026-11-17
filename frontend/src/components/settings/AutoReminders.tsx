import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { formatCurrency, formatDate, formatPhone, toMessage } from '../../lib/format';
import type { AutoPreview, AutoReminderState } from '../../types';
import { Modal } from '../Modal';
import { formatDuration } from './duration';
import { Card, LiveNote, Pill, Skeleton } from './ui';

const SHOWN = 12;

/** Master switch and go-live date for automatic payment reminders (Settings → Payment reminders). */
export function AutoRemindersCard() {
  const [state, setState] = useState<AutoReminderState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [goLive, setGoLive] = useState('');
  const [confirming, setConfirming] = useState<'on' | 'off' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<AutoReminderState>('/payment-follow-up/auto');
      setState(next); setGoLive(next.goLiveDate ?? ''); setLoadError('');
    } catch (failure) { setLoadError(toMessage(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(next: { enabled: boolean; goLiveDate: string }, message: string) {
    setBusy(true); setError(''); setSaved('');
    try {
      const result = await apiRequest<AutoReminderState>('/payment-follow-up/auto', { method: 'PUT', body: JSON.stringify({ enabled: next.enabled, goLiveDate: next.goLiveDate || null }) });
      setState(result); setGoLive(result.goLiveDate ?? ''); setConfirming(null); setSaved(message);
    } catch (failure) { setError(toMessage(failure)); } finally { setBusy(false); }
  }

  if (loadError) return <Card title="Automatic payment reminders"><LiveNote tone="bad">{loadError}</LiveNote></Card>;
  if (!state) return <Skeleton rows={2} />;
  const customerCount = state.customers.length;
  const dateChanged = goLive !== (state.goLiveDate ?? '');

  return (
    <Card
      title="Automatic payment reminders"
      description="When on, a payment reminder journey starts by itself for invoices of customers you have set to automatic. Reminders stop by themselves when SAP shows the invoice as paid."
      action={<Pill tone={state.enabled ? 'ok' : 'off'}>{state.enabled ? 'On' : 'Off'}</Pill>}
    >
      <div className="st-stack">
        <p>
          {customerCount === 0
            ? 'No customer is set to automatic yet, so nothing starts by itself. Turn a customer on from Customers.'
            : `${customerCount} ${customerCount === 1 ? 'customer is' : 'customers are'} set to automatic.`}
          {' '}A journey only starts for an invoice that is due, was delivered, has every product On, and that SAP shows as not paid.
        </p>
        <label className="field">
          <span>Go-live date (optional)</span>
          <input type="date" value={goLive} disabled={busy} onChange={(event) => { setGoLive(event.target.value); setSaved(''); }} />
          <small>Only invoices that reach their start day on or after this date begin by themselves. Older invoices stay in All eligible for you to start by hand. Leave empty for no limit.</small>
        </label>
        {!state.serverCanSend && <LiveNote tone="bad">Payment reminder sending is not switched on for this server, so automatic reminders can't be turned on.</LiveNote>}
        {error && <LiveNote tone="bad">{error}</LiveNote>}
        {saved && <LiveNote>{saved}</LiveNote>}
        <div className="st-panel__buttons">
          {state.enabled
            ? <button className="button button--danger" type="button" disabled={busy} onClick={() => setConfirming('off')}>Turn off automatic reminders</button>
            : <button className="button button--primary" type="button" disabled={busy || !state.serverCanSend} onClick={() => setConfirming('on')}>Turn on automatic reminders</button>}
          <button className="button button--secondary" type="button" disabled={busy || !dateChanged} onClick={() => void save({ enabled: state.enabled, goLiveDate: goLive }, 'Go-live date saved.')}>Save date</button>
        </div>
      </div>
      {confirming && (
        <Modal
          title={confirming === 'on' ? 'Turn on automatic reminders?' : 'Turn off automatic reminders?'}
          description={confirming === 'on'
            ? (customerCount === 0 ? 'No customer is set to automatic yet, so nothing will start.' : `Within about a minute, journeys start by themselves for ${customerCount} ${customerCount === 1 ? 'customer' : 'customers'}. WhatsApp reminders are real messages and can't be recalled.`)
            : 'No new journey starts by itself. Journeys already running carry on, and still stop by themselves when SAP shows the invoice as paid.'}
          onClose={() => { if (!busy) setConfirming(null); }}
        >
          {confirming === 'on' && <ul className="st-bullets">
            <li>Check each automatic customer's list first (Customers → the customer → Automatic payment reminders).</li>
            <li>{goLive ? `Only invoices reaching their start day on or after ${formatDate(goLive)} begin.` : 'No go-live date is set, so older invoices of automatic customers begin too.'}</li>
          </ul>}
          {error && <LiveNote tone="bad">{error}</LiveNote>}
          <div className="modal-footer">
            <button className="button button--secondary" type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            <button className={confirming === 'on' ? 'button button--primary' : 'button button--danger'} type="button" disabled={busy}
              onClick={() => void save({ enabled: confirming === 'on', goLiveDate: goLive }, confirming === 'on' ? 'Automatic reminders are on.' : 'Automatic reminders are off.')}>
              {busy ? 'Saving…' : confirming === 'on' ? 'Turn on' : 'Turn off'}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** One customer's automatic switch, shown in the customer panel. */
export function AutoReminderSection({ customerNumber, revision, onOpen }: { customerNumber: string; revision: number; onOpen: () => void }) {
  const [state, setState] = useState<AutoReminderState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    apiRequest<AutoReminderState>('/payment-follow-up/auto').then((next) => { if (current) setState(next); }).catch((failure) => { if (current) setError(toMessage(failure)); });
    return () => { current = false; };
  }, [revision]);
  const automatic = Boolean(state?.customers.includes(customerNumber));
  return (
    <section className="st-panel__block">
      <div className="st-panel__title">
        <h3>Automatic payment reminders</h3>
        {state && <Pill tone={automatic ? 'ok' : 'off'}>{automatic ? 'Automatic' : 'Manual'}</Pill>}
      </div>
      <p>{automatic
        ? 'A reminder journey starts by itself for this customer\'s not-paid invoices, and stops by itself when SAP shows them paid.'
        : 'Journeys for this customer are started by hand from Payment follow-up. Turn this on to have them start by themselves.'}</p>
      {state && !state.enabled && automatic && <p className="st-hint st-hint--warn">The master switch (Settings → Payment reminders) is off, so nothing starts yet.</p>}
      {error && <LiveNote tone="bad">{error}</LiveNote>}
      <div className="st-panel__buttons">
        <button className={automatic ? 'button button--secondary' : 'button button--primary'} type="button" disabled={!state} onClick={onOpen}>
          {automatic ? 'Turn off automatic' : 'Turn on automatic…'}
        </button>
      </div>
    </section>
  );
}

/** Shows exactly what switching the customer would do before it does anything. */
export function AutoReminderConfirm({ customerNumber, customerName, onBack, onDone }: { customerNumber: string; customerName: string; onBack: () => void; onDone: (message: string) => Promise<void> }) {
  const [preview, setPreview] = useState<AutoPreview | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let current = true;
    apiRequest<AutoPreview>(`/payment-follow-up/auto/preview/${encodeURIComponent(customerNumber)}`)
      .then((value) => { if (current) setPreview(value); }).catch((failure) => { if (current) setError(toMessage(failure)); });
    return () => { current = false; };
  }, [customerNumber]);

  const turningOff = Boolean(preview?.alreadyAutomatic);
  const count = preview?.wouldStart.length ?? 0;

  async function apply() {
    setBusy(true); setSaveError('');
    try {
      await apiRequest(`/payment-follow-up/auto/customers/${encodeURIComponent(customerNumber)}`, { method: 'PUT', body: JSON.stringify({ enabled: !turningOff }) });
      await onDone(turningOff ? 'Automatic payment reminders are off for this customer.' : 'Automatic payment reminders are on for this customer.');
    } catch (failure) { setSaveError(toMessage(failure)); } finally { setBusy(false); }
  }

  return (
    <div className="st-panel">
      <button className="st-back" type="button" onClick={onBack} disabled={busy}><ArrowLeft size={14} aria-hidden="true" /> Back</button>
      {error && <LiveNote tone="bad">{error} Nothing was changed. Close this and try again.</LiveNote>}
      {!preview && !error && <p role="status">Checking this customer's invoices in SAP…</p>}
      {preview && turningOff && <>
        <h3 className="st-confirm__title">Turn off automatic reminders for {customerName}?</h3>
        <p>No new journey starts by itself for this customer. Journeys already running carry on.</p>
      </>}
      {preview && !turningOff && <>
        <h3 className="st-confirm__title">Turn on automatic reminders for {customerName}?</h3>
        <p>Reminders go to <strong className="mono">{preview.toLast4 ? `•••• ${preview.toLast4}` : formatPhone(null)}</strong>. {preview.masterOn
          ? 'The master switch is ON, so journeys start within about a minute.'
          : 'The master switch is off, so nothing starts until it is turned on in Settings → Payment reminders.'}</p>
        <p className="st-hint">First reminder {formatDuration(preview.timing.firstDelaySeconds)} after a journey starts, then every {formatDuration(preview.timing.repeatDelaySeconds)}, up to {preview.timing.maximum}. {preview.goLiveDate ? `Only invoices reaching their start day on or after ${formatDate(preview.goLiveDate)} begin.` : 'No go-live date is set.'}</p>
        <h4>{count === 0 ? 'No invoice would start right now' : `${count} ${count === 1 ? 'invoice would' : 'invoices would'} start`}</h4>
        {count > 0 && <ul className="sp-list">
          {preview.wouldStart.slice(0, SHOWN).map((item) => <li key={item.invoiceNumber}><span><strong>{item.invoiceNumber}</strong><small>Dated {formatDate(item.invoiceDate)} · started on day {formatDate(item.dueDate)}</small></span><span className="sp-state">{formatCurrency(item.amount, item.currency)}</span></li>)}
          {count > SHOWN && <li><span>and {count - SHOWN} more</span></li>}
        </ul>}
        {preview.skipped.length > 0 && <details className="st-details st-details--inline">
          <summary>{preview.skipped.length} left out</summary>
          <ul className="sp-list">
            {preview.skipped.slice(0, 30).map((item) => <li key={item.invoiceNumber}><span><strong>{item.invoiceNumber}</strong><small>{item.reason}</small></span><span className="sp-state">{formatCurrency(item.amount, item.currency)}</span></li>)}
          </ul>
        </details>}
        {count > 0 && <label className="st-approval-check"><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} /> I have checked this list. These are real WhatsApp reminders to the customer.</label>}
      </>}
      {saveError && <LiveNote tone="bad">{saveError}</LiveNote>}
      <div className="modal-footer">
        <button className="button button--secondary" type="button" onClick={onBack} disabled={busy}>Cancel</button>
        <button className={turningOff ? 'button button--danger' : 'button button--primary'} type="button" disabled={!preview || busy || (!turningOff && count > 0 && !checked)} onClick={() => void apply()}>
          {busy ? 'Saving…' : turningOff ? 'Turn off' : 'Turn on automatic'}
        </button>
      </div>
    </div>
  );
}
