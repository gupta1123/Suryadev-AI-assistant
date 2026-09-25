import { BadgeIndianRupee, FileText, LifeBuoy, LogOut, RefreshCw, Send, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { SendInvoiceModal } from '../components/SendInvoiceModal';
import { apiRequest } from '../lib/api';
import { formatDateTime, toMessage } from '../lib/format';
import type {
  AdminUser,
  AppRoute,
  BillingDocumentTemplateReadiness,
  DeliveryConfig,
  PaymentFollowUpConfig,
  SapPollingStatus,
} from '../types';
import { PaymentTestModal } from './PaymentFollowUpsPage';

type State = 'live' | 'test' | 'paused' | 'off';
const STATE_LABEL: Record<State, string> = { live: 'On', test: 'Test mode', paused: 'Paused', off: 'Off' };

const SECTIONS = [
  { id: 'sending', label: 'Sending' },
  { id: 'sap', label: 'SAP connection' },
  { id: 'formats', label: 'Message formats' },
  { id: 'test', label: 'Test sends' },
  { id: 'account', label: 'Account' },
];

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
  const [polling, setPolling] = useState<SapPollingStatus>(null);
  const [templates, setTemplates] = useState<BillingDocumentTemplateReadiness | null>(null);
  const [checkingTemplates, setCheckingTemplates] = useState(true);
  const [pollingNow, setPollingNow] = useState(false);
  const [pollResult, setPollResult] = useState('');
  const [modal, setModal] = useState<'document' | 'reminder' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [configResult, paymentResult, pollingResult] = await Promise.allSettled([
      apiRequest<DeliveryConfig>('/invoice-delivery/config'),
      apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
      apiRequest<SapPollingStatus>('/invoice-delivery/polling-status'),
    ]);
    if (configResult.status === 'fulfilled') setConfig(configResult.value);
    else setError(toMessage(configResult.reason));
    if (paymentResult.status === 'fulfilled') setPaymentConfig(paymentResult.value);
    if (pollingResult.status === 'fulfilled') setPolling(pollingResult.value);
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
        <nav className="set-toc" aria-label="Settings sections">
          {SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.label}</a>)}
        </nav>

        <div className="set-body">
          <SettingsSection id="sending" title="Sending" description="What goes out on WhatsApp automatically.">
            <ul className="set-rows">
              <AutomationRow icon={FileText} name="Invoices and memos" detail={liveMode ? 'Sent as soon as SAP creates them' : 'Only test documents are sent right now'} state={billingState} />
              <AutomationRow icon={BadgeIndianRupee} name="Payment reminders" detail="Sent when an invoice isn’t paid on time" state={paymentState} />
              <AutomationRow icon={LifeBuoy} name="Customer replies" detail="“Need Help” taps show up in Needs attention" state={helpState} />
            </ul>
            <p className="set-note">These switches are managed on the server. Ask your admin to change them.</p>
          </SettingsSection>

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

          <SettingsSection id="test" title="Test sends" description="Try the full flow on your test WhatsApp number. Real customers are never messaged.">
            <div className="set-tests">
              <button className="set-test" type="button" disabled={!config || liveMode} onClick={() => setModal('document')}>
                <span><FileText size={18} aria-hidden="true" /></span>
                <strong>Send a test document</strong>
                <small>{liveMode ? 'Not available while connected to live SAP' : `Goes to ${config?.defaultTestRecipient ?? 'your test number'}`}</small>
              </button>
              <button className="set-test" type="button" disabled={!paymentConfig?.configured} onClick={() => setModal('reminder')}>
                <span><Send size={18} aria-hidden="true" /></span>
                <strong>Send a test reminder</strong>
                <small>{paymentConfig?.configured ? 'Sends an invoice, then two reminders' : 'Not set up on the server yet'}</small>
              </button>
            </div>
          </SettingsSection>

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
        </div>
      </div>

      {modal === 'document' && config?.invoiceSource === 'fixture' && (
        <SendInvoiceModal
          config={config}
          onClose={() => setModal(null)}
          onComplete={(jobId) => { setModal(null); onNavigate(`/documents/${jobId}`); }}
        />
      )}
      {modal === 'reminder' && (
        <PaymentTestModal
          onClose={() => setModal(null)}
          onComplete={(result) => { setModal(null); onNavigate(`/payments/${result.caseId}`); }}
        />
      )}
    </AppShell>
  );
}

function SettingsSection({ id, title, description, action, children }: { id: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section" id={id} aria-labelledby={`${id}-title`}>
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

function AutomationRow({ icon: Icon, name, detail, state }: { icon: LucideIcon; name: string; detail: string; state: State }) {
  return (
    <li className="set-row">
      <span className="set-row__icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="set-row__text"><strong>{name}</strong><small>{detail}</small></span>
      <span className={`wa-state wa-state--${state}`}>{STATE_LABEL[state]}</span>
    </li>
  );
}
