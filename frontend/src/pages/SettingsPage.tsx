import { BadgeIndianRupee, FileText, LifeBuoy, LogOut, RefreshCw, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { apiRequest } from '../lib/api';
import { formatDateTime, toMessage } from '../lib/format';
import type {
  AdminUser,
  AppRoute,
  BillingDocumentTemplateReadiness,
  DeliveryConfig,
  HelpRequestAlertSettings,
  PaymentFollowUpConfig,
  ReminderSettings,
  SapPollingStatus,
} from '../types';

type State = 'live' | 'test' | 'paused' | 'off';
const STATE_LABEL: Record<State, string> = { live: 'On', test: 'Test mode', paused: 'Paused', off: 'Off' };

const SECTIONS = [
  { id: 'sending', label: 'Sending' },
  { id: 'reminders', label: 'Reminder timing' },
  { id: 'sap', label: 'SAP connection' },
  { id: 'formats', label: 'Message formats' },
  { id: 'account', label: 'Account' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function sectionFromHash(): SectionId {
  const hash = window.location.hash.slice(1);
  return SECTIONS.find((section) => section.id === hash)?.id ?? 'sending';
}

export function SettingsPage({
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
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [paymentConfig, setPaymentConfig] = useState<PaymentFollowUpConfig | null>(null);
  const [helpAlertSettings, setHelpAlertSettings] = useState<HelpRequestAlertSettings | null>(null);
  const [polling, setPolling] = useState<SapPollingStatus>(null);
  const [templates, setTemplates] = useState<BillingDocumentTemplateReadiness | null>(null);
  const [checkingTemplates, setCheckingTemplates] = useState(true);
  const [pollingNow, setPollingNow] = useState(false);
  const [pollResult, setPollResult] = useState('');
  const [activeSection, setActiveSection] = useState<SectionId>(sectionFromHash);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [configResult, paymentResult, pollingResult, helpAlertResult] = await Promise.allSettled([
      apiRequest<DeliveryConfig>('/invoice-delivery/config'),
      apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
      apiRequest<SapPollingStatus>('/invoice-delivery/polling-status'),
      apiRequest<HelpRequestAlertSettings>('/invoice-delivery/help-alert-settings'),
    ]);
    if (configResult.status === 'fulfilled') setConfig(configResult.value);
    else setError(toMessage(configResult.reason));
    if (paymentResult.status === 'fulfilled') setPaymentConfig(paymentResult.value);
    if (pollingResult.status === 'fulfilled') setPolling(pollingResult.value);
    if (helpAlertResult.status === 'fulfilled') setHelpAlertSettings(helpAlertResult.value);
    else setError(toMessage(helpAlertResult.reason));
  }, []);

  const checkTemplates = useCallback(async () => {
    setCheckingTemplates(true);
    try {
      setTemplates(await apiRequest<BillingDocumentTemplateReadiness>('/invoice-delivery/template-status'));
    } catch {
      setTemplates(null);
    } finally {
      setCheckingTemplates(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void checkTemplates();
  }, [load, checkTemplates]);

  function openSection(id: SectionId) {
    setActiveSection(id);
    window.history.replaceState(window.history.state, '', `#${id}`);
  }

  async function pollNow() {
    setPollingNow(true);
    setPollResult('');
    try {
      await apiRequest('/invoice-delivery/poll-now', { method: 'POST' });
      setPollResult('Done. Any new documents are being sent now.');
      await load();
    } catch (pollError) {
      setPollResult(toMessage(pollError));
    } finally {
      setPollingNow(false);
    }
  }

  const liveMode = config?.invoiceSource === 'sap';
  const billingState: State = !config ? 'off' : !config.msg91Configured || !config.sendEnabled ? 'paused' : liveMode ? 'live' : 'test';
  const paymentState: State = !paymentConfig?.enabled ? 'off' : !paymentConfig.sendEnabled ? 'paused' : paymentConfig.controlledTest ? 'test' : 'live';
  const helpState: State = config?.msg91WebhookConfigured ? 'live' : 'off';
  const intervalMinutes = config?.sapPollIntervalMs ? Math.round(config.sapPollIntervalMs / 60000) : null;
  const nextCheck = polling?.last_completed_at && config?.sapPollIntervalMs
    ? new Date(new Date(polling.last_completed_at).getTime() + config.sapPollIntervalMs).toISOString()
    : null;
  const pollFailed = polling?.last_status === 'failed';

  return (
    <AppShell
      route={route}
      eyebrow="How sending is set up"
      title="Settings"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
    >
      {error && <div className="alert alert--error">{error}</div>}

      <div className="set-layout">
        <nav className="set-toc" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              id={`${section.id}-tab`}
              type="button"
              role="tab"
              aria-selected={activeSection === section.id}
              aria-controls={section.id}
              className={activeSection === section.id ? 'set-toc__tab set-toc__tab--active' : 'set-toc__tab'}
              onClick={() => openSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <div className="set-body">
          {activeSection === 'sending' && (
            <SettingsSection id="sending" title="Sending" description="What goes out on WhatsApp automatically.">
              <ul className="set-rows">
                <AutomationRow icon={FileText} name="Invoices and memos" detail={liveMode ? 'Sent as soon as SAP creates them' : 'Only test documents are sent right now'} state={billingState} />
                <AutomationRow icon={BadgeIndianRupee} name="Payment reminders" detail={paymentConfig ? reminderSummary(paymentConfig.firstReminderDelaySeconds, paymentConfig.repeatReminderDelaySeconds, paymentConfig.maximumTestReminders) : 'Sent after an invoice goes out'} state={paymentState} />
                <AutomationRow icon={LifeBuoy} name="Customer replies" detail="“Need Help” taps show up in Needs attention" state={helpState} />
              </ul>
              {helpAlertSettings
                ? <HelpAlertRecipientForm key={helpAlertSettings.recipient} settings={helpAlertSettings} onSaved={load} />
                : <p className="set-note">Loading the Need Help recipient…</p>}
              <p className="set-note">Automation switches are managed on the server. Ask your admin to change them.</p>
            </SettingsSection>
          )}

          {activeSection === 'reminders' && (
            <SettingsSection id="reminders" title="Reminder timing" description="When payment reminders go out on WhatsApp after an invoice is sent.">
              {paymentConfig
                ? <ReminderTimingForm key={paymentConfig.reminderSettingsUpdatedAt ?? 'default'} config={paymentConfig} onSaved={load} />
                : <p className="set-note">Loading reminder settings…</p>}
            </SettingsSection>
          )}

          {activeSection === 'sap' && (
            <SettingsSection id="sap" title="SAP connection" description="Where new invoices and memos come from.">
              <div className={`set-status${pollFailed ? ' set-status--bad' : ''}`}>
                <span className={`set-dot set-dot--${!liveMode ? 'idle' : pollFailed ? 'bad' : 'ok'}`} />
                <div>
                  <strong>{!liveMode ? 'Not connected · using test data' : pollFailed ? 'Last check failed' : 'Connected'}</strong>
                  <small>{liveMode ? `Checks SAP for new documents${intervalMinutes ? ` every ${intervalMinutes} min` : ''}` : 'Turn on live SAP on the server to send real documents.'}</small>
                </div>
                {liveMode && (
                  <button className="button button--secondary" type="button" disabled={pollingNow || !config?.sapPollingReady} onClick={() => void pollNow()}>
                    <RefreshCw size={15} className={pollingNow ? 'spin' : ''} aria-hidden="true" /> {pollingNow ? 'Checking…' : 'Check SAP now'}
                  </button>
                )}
              </div>
              {pollResult && <p className="set-note">{pollResult}</p>}
              <dl className="dt-details dt-details--stacked set-facts">
                <div><dt>Last check</dt><dd>{formatDateTime(polling?.last_completed_at)}</dd></div>
                <div><dt>Next check</dt><dd>{liveMode ? formatDateTime(nextCheck) : '—'}</dd></div>
                <div><dt>Documents found last time</dt><dd>{polling ? polling.records_processed : '—'}</dd></div>
                <div><dt>Checking from</dt><dd>{config?.sapPollStartDate || '—'}</dd></div>
              </dl>
              {polling?.last_error && <p className="dt-timeline__note">{polling.last_error}</p>}
            </SettingsSection>
          )}

          {activeSection === 'formats' && (
            <SettingsSection
              id="formats"
              title="Message formats"
              description="WhatsApp must approve each format before it can be sent."
              action={(
                <button className="button button--secondary button--compact" type="button" disabled={checkingTemplates} onClick={() => void checkTemplates()}>
                  <RefreshCw size={14} className={checkingTemplates ? 'spin' : ''} aria-hidden="true" /> Check again
                </button>
              )}
            >
              <ul className="set-rows">
                {(config?.billingDocumentTypes ?? []).map((documentType) => {
                  const approved = templates?.templates.find((item) => item.type === documentType.type)?.approved;
                  const state = checkingTemplates || !templates ? 'idle' : approved ? 'ok' : 'pending';
                  return (
                    <li key={documentType.type} className="set-row">
                      <span className="document-type-code">{documentType.type}</span>
                      <span className="set-row__text">
                        <strong>{documentType.label}</strong>
                        <small className="mono">{documentType.templateName}</small>
                      </span>
                      <span className={`health health--${state === 'ok' ? 'ok' : state === 'pending' ? 'warn' : 'none'}`}>
                        {state === 'idle' ? (checkingTemplates ? 'Checking…' : 'Unknown') : state === 'ok' ? 'Approved' : 'Waiting for approval'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </SettingsSection>
          )}

          {activeSection === 'account' && (
            <SettingsSection id="account" title="Account">
              <div className="set-status">
                <span className="account-avatar">AD</span>
                <div>
                  <strong>{user.displayName}</strong>
                  <small>Signed in as @{user.username}</small>
                </div>
                <button className="button button--secondary" type="button" disabled={loggingOut} onClick={() => void onLogout()}>
                  <LogOut size={15} aria-hidden="true" /> {loggingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </SettingsSection>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function HelpAlertRecipientForm({
  settings,
  onSaved,
}: {
  settings: HelpRequestAlertSettings;
  onSaved: () => Promise<void>;
}) {
  const [recipient, setRecipient] = useState(settings.formattedRecipient || settings.recipient);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const normalized = normalizeRecipient(recipient);
  const valid = /^[1-9]\d{7,14}$/.test(normalized);
  const changed = normalized !== settings.recipient;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || !changed) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await apiRequest<HelpRequestAlertSettings>('/invoice-delivery/help-alert-settings', {
        method: 'PUT',
        body: JSON.stringify({ recipient }),
      });
      setRecipient(saved.formattedRecipient);
      setMessage({ tone: 'ok', text: 'Need Help alerts will go to this number.' });
      await onSaved();
    } catch (saveError) {
      setMessage({ tone: 'error', text: toMessage(saveError) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="set-recipient" onSubmit={(event) => void save(event)}>
      <label className="field set-recipient__field">
        <span>Need Help alert number</span>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={recipient}
          onChange={(event) => {
            setRecipient(event.target.value);
            setMessage(null);
          }}
          placeholder="+91 70193 39764"
          aria-describedby="help-alert-number-hint"
        />
        <small id="help-alert-number-hint">Customer and invoice details are sent here when a customer taps Need Help.</small>
      </label>
      <div className="set-recipient__save">
        {message && <small className={message.tone === 'error' ? 'text-danger' : 'text-success'}>{message.text}</small>}
        {!valid && recipient.trim() && <small className="text-danger">Enter a valid WhatsApp number with country code.</small>}
        <button className="button button--primary" type="submit" disabled={saving || !changed || !valid}>
          {saving ? 'Saving…' : 'Save number'}
        </button>
      </div>
    </form>
  );
}

function normalizeRecipient(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return digits;
}

function SettingsSection({ id, title, description, action, children }: { id: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section" id={id} role="tabpanel" aria-labelledby={`${id}-tab`}>
      <header className="set-section__head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';
const UNIT_SECONDS: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
const MIN_DELAY_SECONDS = 10;
const MAX_DELAY_SECONDS = 30 * 86_400;

function splitDuration(seconds: number): { amount: string; unit: TimeUnit } {
  const unit: TimeUnit = seconds % UNIT_SECONDS.days === 0 ? 'days'
    : seconds % UNIT_SECONDS.hours === 0 ? 'hours'
      : seconds % UNIT_SECONDS.minutes === 0 ? 'minutes'
        : 'seconds';
  return { amount: String(Math.max(1, Math.round(seconds / UNIT_SECONDS[unit]))), unit };
}

function formatDuration(seconds: number): string {
  const { amount, unit } = splitDuration(seconds);
  return `${amount} ${Number(amount) === 1 ? unit.slice(0, -1) : unit}`;
}

function reminderCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
}

function reminderSummary(firstSeconds: number, repeatSeconds: number, maximum: number): string {
  if (maximum === 1) return `1 reminder, ${formatDuration(firstSeconds)} after the invoice`;
  return `First ${formatDuration(firstSeconds)} after the invoice, then every ${formatDuration(repeatSeconds)} · up to ${reminderCountLabel(maximum)}`;
}

function ReminderTimingForm({ config, onSaved }: { config: PaymentFollowUpConfig; onSaved: () => Promise<void> }) {
  const [first, setFirst] = useState(() => splitDuration(config.firstReminderDelaySeconds));
  const [repeat, setRepeat] = useState(() => splitDuration(config.repeatReminderDelaySeconds));
  const [maximum, setMaximum] = useState(String(config.maximumTestReminders));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const firstSeconds = Number(first.amount) * UNIT_SECONDS[first.unit];
  const repeatSeconds = Number(repeat.amount) * UNIT_SECONDS[repeat.unit];
  const maximumCount = Number(maximum);
  const problem =
    !Number.isInteger(firstSeconds) || firstSeconds < MIN_DELAY_SECONDS || firstSeconds > MAX_DELAY_SECONDS ? 'The first reminder must be between 10 seconds and 30 days.'
      : !Number.isInteger(repeatSeconds) || repeatSeconds < MIN_DELAY_SECONDS || repeatSeconds > MAX_DELAY_SECONDS ? 'The time between reminders must be between 10 seconds and 30 days.'
        : !Number.isInteger(maximumCount) || maximumCount < 1 || maximumCount > 10 ? 'Send between 1 and 10 reminders.'
          : '';
  const changed =
    firstSeconds !== config.firstReminderDelaySeconds
    || repeatSeconds !== config.repeatReminderDelaySeconds
    || maximumCount !== config.maximumTestReminders;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (problem || !changed) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiRequest<ReminderSettings>('/payment-follow-up/settings', {
        method: 'PUT',
        body: JSON.stringify({
          firstReminderDelaySeconds: firstSeconds,
          repeatReminderDelaySeconds: repeatSeconds,
          maximumReminders: maximumCount,
        }),
      });
      await onSaved();
    } catch (saveError) {
      setMessage({ tone: 'error', text: toMessage(saveError) });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setFirst(splitDuration(config.firstReminderDelaySeconds));
    setRepeat(splitDuration(config.repeatReminderDelaySeconds));
    setMaximum(String(config.maximumTestReminders));
    setMessage(null);
  }

  return (
    <form className="set-timing" onSubmit={(event) => void save(event)}>
      <div className="set-timing__grid">
        <DurationField label="First reminder" hint="after the invoice is sent" value={first} onChange={setFirst} />
        <DurationField label="Then every" hint="until paid or the limit is reached" value={repeat} onChange={setRepeat} disabled={maximumCount === 1} />
        <label className="field">
          <span>Send at most</span>
          <div className="set-timing__pair">
            <input type="number" min={1} max={10} step={1} inputMode="numeric" value={maximum} onChange={(event) => setMaximum(event.target.value)} />
            <span className="set-timing__suffix">reminders</span>
          </div>
          <small>per invoice</small>
        </label>
      </div>
      <p className={`set-timing__summary${problem ? ' set-timing__summary--bad' : ''}`}>
        {problem || reminderSummary(firstSeconds, repeatSeconds, maximumCount)}
      </p>
      <div className="set-timing__foot">
        <small>
          {config.reminderSettingsSource === 'saved'
            ? `Last changed ${formatDateTime(config.reminderSettingsUpdatedAt)}.`
            : 'Using the server defaults.'}
          {' '}Changes apply to the next reminder that gets scheduled.
        </small>
        {message && <small className={message.tone === 'error' ? 'text-danger' : ''}>{message.text}</small>}
        <div className="set-timing__actions">
          <button className="button button--secondary" type="button" disabled={saving || !changed} onClick={reset}>Reset</button>
          <button className="button button--primary" type="submit" disabled={saving || !changed || Boolean(problem)}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </form>
  );
}

function DurationField({
  label,
  hint,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  hint: string;
  value: { amount: string; unit: TimeUnit };
  onChange: (value: { amount: string; unit: TimeUnit }) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="set-timing__pair">
        <input type="number" min={1} step={1} inputMode="numeric" disabled={disabled} value={value.amount} onChange={(event) => onChange({ ...value, amount: event.target.value })} aria-label={`${label} amount`} />
        <select disabled={disabled} value={value.unit} onChange={(event) => onChange({ ...value, unit: event.target.value as TimeUnit })} aria-label={`${label} unit`}>
          <option value="seconds">seconds</option>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
      <small>{hint}</small>
    </label>
  );
}

function AutomationRow({ icon: Icon, name, detail, state }: { icon: LucideIcon; name: string; detail: string; state: State }) {
  return (
    <li className="set-row">
      <span className="set-row__icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="set-row__text"><strong>{name}</strong><small>{detail}</small></span>
      <span className={`wa-state wa-state--${state}`}>{STATE_LABEL[state]}</span>
    </li>
  );
}
