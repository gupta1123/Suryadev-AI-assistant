import { Check, Lock, LogOut, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../lib/api';
import { formatPhone, toMessage } from '../../lib/format';
import type { AdminUser, InternalRecipientRow, MessagingOverview } from '../../types';
import { Card, LiveNote, Pill, Skeleton, Switch } from './ui';

export function TeamTab({
  messaging,
  messagingError,
  onReload,
  user,
  onLogout,
  loggingOut,
}: {
  messaging: MessagingOverview | null;
  messagingError: string;
  onReload: () => Promise<void>;
  user: AdminUser;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [busyPhone, setBusyPhone] = useState('');
  const [savedPhone, setSavedPhone] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function update(
    row: InternalRecipientRow,
    change: Partial<{ label: string | null; allowSimulator: boolean; allowPaymentReminders: boolean }>,
  ) {
    setBusyPhone(row.phone);
    setError('');
    try {
      await apiRequest(`/messaging/internal-recipients/${row.phone}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: change.label !== undefined ? change.label : row.label,
          allowSimulator: change.allowSimulator ?? row.allowSimulator,
          allowPaymentReminders: change.allowPaymentReminders ?? row.allowPaymentReminders,
        }),
      });
      await onReload();
      setSavedPhone(row.phone);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSavedPhone(''), 2500);
    } catch (failure) {
      setError(toMessage(failure));
    } finally {
      setBusyPhone('');
    }
  }

  return (
    <div className="st-stack">
      {messaging && (
        <div className={`st-banner${messaging.sapHostApproved ? '' : ' st-banner--bad'}`}>
          <Pill tone={messaging.deliveryMode === 'test' ? 'test' : 'ok'}>{messaging.deliveryMode === 'test' ? 'Test mode' : 'Live'}</Pill>
          <span>
            {messaging.deliveryMode === 'test'
              ? 'Test documents and reminders can only go to server-approved numbers with the required Settings approvals. Some listed numbers may also belong to customers.'
              : 'You are live. These numbers are for your own team’s testing.'}
          </span>
        </div>
      )}

      <Card
        title="Your team’s phone numbers"
        description="Choose what each test number may receive. The associated customer must also be enabled in Customers; these permissions never override a customer being off."
        flush
      >
        {messagingError && <div className="alert alert--error" role="alert">{messagingError}</div>}
        {error && <div className="st-pad"><LiveNote tone="bad">{error}</LiveNote></div>}
        {!messaging && !messagingError && <Skeleton rows={3} />}
        {messaging && messaging.internalRecipients.length === 0 && (
          <div className="empty-table">
            <Smartphone size={26} aria-hidden="true" />
            <strong>No team numbers yet</strong>
            <p>Your technical admin needs to approve a test number on the server before it can appear here.</p>
          </div>
        )}
        {messaging && messaging.internalRecipients.length > 0 && (
          <ul className="st-team">
            {messaging.internalRecipients.map((row) => (
              <TeamRow
                key={row.phone}
                row={row}
                busy={busyPhone === row.phone}
                saved={savedPhone === row.phone}
                onChange={(change) => void update(row, change)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Your account">
        <div className="st-account">
          <span className="account-avatar" aria-hidden="true">AD</span>
          <div>
            <strong>{user.displayName}</strong>
            <small>Signed in as @{user.username}</small>
          </div>
          <button className="button button--secondary" type="button" disabled={loggingOut} onClick={() => void onLogout()}>
            <LogOut size={15} aria-hidden="true" /> {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </Card>
    </div>
  );
}

function TeamRow({
  row,
  busy,
  saved,
  onChange,
}: {
  row: InternalRecipientRow;
  busy: boolean;
  saved: boolean;
  onChange: (change: Partial<{ label: string | null; allowSimulator: boolean; allowPaymentReminders: boolean }>) => void;
}) {
  const [name, setName] = useState(row.label ?? '');
  useEffect(() => { setName(row.label ?? ''); }, [row.label]);

  function commitName() {
    const next = name.trim();
    if (next !== (row.label ?? '')) onChange({ label: next || null });
  }

  return (
    <li className="st-team__row">
      <div className="st-team__who">
        <input
          className="st-inline-input"
          value={name}
          placeholder="Add a name"
          maxLength={120}
          aria-label={`Name for ${formatPhone(row.phone)}`}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        />
        <small className="mono">{formatPhone(row.phone)}</small>
        {row.alsoCustomerPhone && <small className="st-warn-text">This is also a customer’s number in SAP.</small>}
      </div>

      <div className="st-team__toggle">
        <div>
          <strong>Test documents</strong>
          <small>Sample invoices and memos</small>
        </div>
        <Switch label={`Test documents for ${formatPhone(row.phone)}`} checked={row.allowSimulator} disabled={busy} onChange={(next) => onChange({ allowSimulator: next })} />
      </div>

      <div className="st-team__toggle">
        <div>
          <strong>Payment reminders</strong>
          <small>{row.paymentCeiling ? 'Test reminder messages' : <><Lock size={11} aria-hidden="true" /> Not allowed by the server</>}</small>
        </div>
        <Switch label={`Payment reminders for ${formatPhone(row.phone)}`} checked={row.allowPaymentReminders} disabled={busy || !row.paymentCeiling} onChange={(next) => onChange({ allowPaymentReminders: next })} />
      </div>

      <span className="st-team__saved" role="status" aria-live="polite">{saved && <><Check size={14} aria-hidden="true" /> Saved</>}</span>
    </li>
  );
}
