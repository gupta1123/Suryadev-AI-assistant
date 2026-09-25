import {
  AlertCircle,
  ArrowRight,
  BadgeIndianRupee,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  FileText,
  LifeBuoy,
  RefreshCw,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { apiRequest } from '../lib/api';
import { loadInbox, type InboxItem } from '../lib/inbox';
import { formatCurrency, toMessage } from '../lib/format';
import {
  relationOne,
  type AdminUser,
  type AppRoute,
  type DeliveryConfig,
  type DeliveryJob,
  type HelpRequest,
  type HelpRequestPage,
  type PaymentFollowUpCase,
  type PaymentFollowUpConfig,
} from '../types';

const VOLUME_DAYS = 14;

type TickState = 'queued' | 'sent' | 'delivered' | 'failed';
type HelpSnapshot = { open: number; inProgress: number; resolved: number };
type AutomationState = 'live' | 'test' | 'paused' | 'off';

const TICKS: Array<{ key: TickState; label: string; icon: LucideIcon; hint: string }> = [
  { key: 'queued', label: 'Queued', icon: Clock3, hint: 'Waiting to send' },
  { key: 'sent', label: 'Sent', icon: Check, hint: 'Accepted by WhatsApp' },
  { key: 'delivered', label: 'Delivered', icon: CheckCheck, hint: 'On the customer’s phone' },
  { key: 'failed', label: 'Failed', icon: AlertCircle, hint: 'Not delivered' },
];

const STATE_LABEL: Record<AutomationState, string> = { live: 'Live', test: 'Test mode', paused: 'Paused', off: 'Off' };

export function OverviewPage({
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
  const [jobs, setJobs] = useState<DeliveryJob[]>([]);
  const [help, setHelp] = useState<HelpSnapshot | null>(null);
  const [cases, setCases] = useState<PaymentFollowUpCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);

  const load = useCallback(async () => {
    // Each automation's data is independent; one failing source must not blank the page.
    const [configResult, jobsResult, helpResult, paymentConfigResult, casesResult] = await Promise.allSettled([
      apiRequest<DeliveryConfig>('/invoice-delivery/config'),
      apiRequest<DeliveryJob[]>('/invoice-delivery/jobs?limit=100'),
      apiRequest<HelpRequestPage | HelpRequest[]>('/invoice-delivery/help-requests?limit=1&paginated=true'),
      apiRequest<PaymentFollowUpConfig>('/payment-follow-up/config'),
      apiRequest<PaymentFollowUpCase[]>('/payment-follow-up/cases'),
    ]);
    if (configResult.status === 'fulfilled') setConfig(configResult.value);
    if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value);
    if (helpResult.status === 'fulfilled') setHelp(toHelpSnapshot(helpResult.value));
    if (paymentConfigResult.status === 'fulfilled') setPaymentConfig(paymentConfigResult.value);
    if (casesResult.status === 'fulfilled') setCases(casesResult.value);
    const failure = [configResult, jobsResult].find((result) => result.status === 'rejected');
    setError(failure && failure.status === 'rejected' ? toMessage(failure.reason) : '');
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    loadInbox().then(setInbox).catch(() => setInbox([]));
  }, [load]);

  const messages = useMemo(() => messageStats(jobs), [jobs]);
  const payments = useMemo(() => paymentStats(cases), [cases]);
  const liveMode = config?.invoiceSource === 'sap';
  const documentTypes = config?.billingDocumentTypes ?? [];

  const billingState: AutomationState = !config
    ? 'off'
    : !config.msg91Configured || !config.sendEnabled
      ? 'paused'
      : liveMode ? 'live' : 'test';
  const paymentState: AutomationState = !paymentConfig?.enabled
    ? 'off'
    : !paymentConfig.sendEnabled
      ? 'paused'
      : paymentConfig.controlledTest ? 'test' : 'live';
  const helpState: AutomationState = config?.msg91WebhookConfigured ? 'live' : 'off';

  return (
    <AppShell
      route={route}
      eyebrow="Today at a glance"
      title="Home"
      onNavigate={onNavigate}
      user={user}
      onLogout={onLogout}
      loggingOut={loggingOut}
      contentClassName="wa-content"
      actions={(
        <button className="sap-status-pill sap-status-pill--link" type="button" onClick={() => onNavigate('/settings')}>
          <span className="sap-dot" />
          {liveMode ? 'Connected to SAP' : 'Test mode'}
        </button>
      )}
    >
      {error && <div className="alert alert--error">{error}</div>}

      <section className={`wa-card wa-status${loading ? ' wa-loading' : ''}`} aria-label="Message status">
        <header className="wa-card__head">
          <div>
            <h2>Message status</h2>
            <p>{messages.total ? `Where your last ${messages.total} messages are right now` : 'Your messages will show up here once sent'}</p>
          </div>
          <button className="wa-link" type="button" onClick={() => onNavigate('/documents')}>
            All messages <ArrowRight size={13} aria-hidden="true" />
          </button>
        </header>
        <div className="wa-ticks">
          {TICKS.map(({ key, label, icon: Icon, hint }) => (
            <div className={`wa-tick wa-tick--${key}`} key={key}>
              <span className="wa-tick__label"><Icon size={15} strokeWidth={2.4} aria-hidden="true" />{label}</span>
              <strong>{messages.counts[key]}</strong>
              <small>{messages.total ? `${pct(messages.counts[key], messages.total)}% · ` : ''}{hint}</small>
            </div>
          ))}
        </div>
        <div className="wa-split" aria-hidden="true">
          {messages.total === 0
            ? <span className="wa-split__empty" />
            : TICKS.map(({ key }) => <span key={key} className={`wa-split--${key}`} style={{ flexGrow: messages.counts[key] }} />)}
        </div>
      </section>

      <div className="wa-grid">
        <section className="wa-card wa-automations" aria-label="Automations">
          <header className="wa-card__head">
            <div><h2>Automations</h2><p>What sends a message, and how it’s going</p></div>
          </header>
          <ul>
            <Automation
              icon={FileText}
              name="Invoices"
              trigger={liveMode ? 'A new invoice is made in SAP' : 'You send a test'}
              action="Send it to the customer on WhatsApp"
              state={billingState}
              stats={[
                { label: 'Sent', value: String(messages.counts.sent + messages.counts.delivered) },
                { label: 'Delivered', value: messages.total ? `${pct(messages.counts.delivered, messages.total)}%` : '—' },
              ]}
              onOpen={() => onNavigate('/documents')}
            />
            <Automation
              icon={BadgeIndianRupee}
              name="Payment reminders"
              trigger="An invoice is not paid on time"
              action="Remind the customer until it’s paid"
              state={paymentState}
              stats={[
                { label: 'Reminders', value: String(payments.remindersSent) },
                { label: 'Still to pay', value: payments.outstanding ? formatCurrency(payments.outstanding, payments.currency) : '—' },
              ]}
              onOpen={() => onNavigate('/payments')}
            />
            <Automation
              icon={LifeBuoy}
              name="Customer help"
              trigger="A customer taps “Need help”"
              action="Let your team know"
              state={helpState}
              stats={[
                { label: 'Open', value: String(help?.open ?? 0) },
                { label: 'Resolved', value: String(help?.resolved ?? 0) },
              ]}
              onOpen={() => onNavigate('/attention')}
            />
          </ul>
        </section>

        <section className="wa-card wa-attention" aria-label="Needs you">
          <header className="wa-card__head">
            <div><h2>Needs attention</h2><p>{inbox === null ? 'Checking…' : inbox.length ? 'The latest things to look at' : 'Nothing waiting'}</p></div>
            {inbox && inbox.length > 0 && (
              <button className="wa-link" type="button" onClick={() => onNavigate('/attention')}>
                See all <span className="wa-badge">{inbox.length}</span>
              </button>
            )}
          </header>
          {!inbox || inbox.length === 0 ? (
            <div className="wa-clear">
              <CheckCheck size={20} aria-hidden="true" />
              <strong>{inbox === null ? 'Checking…' : 'All caught up'}</strong>
              <p>No failed messages, customer replies or late payments.</p>
            </div>
          ) : (
            <ul className="wa-attention__list">
              {inbox.slice(0, 4).map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={() => onNavigate('/attention')}>
                    <i className={`wa-attention__dot wa-attention__dot--${item.kind === 'failed' ? 'danger' : item.kind === 'reply' ? 'info' : 'warn'}`} />
                    <span>
                      <strong>{item.customer} · {item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="wa-card wa-volume" aria-label="Messages sent">
          <header className="wa-card__head">
            <div><h2>Messages sent</h2><p>Last {VOLUME_DAYS} days</p></div>
            <div className="wa-volume__total">
              <strong>{messages.volumeTotal}</strong>
              <small>{messages.volumeFailed ? `${messages.volumeFailed} failed` : 'no failures'}</small>
            </div>
          </header>
          <div className="wa-bars" role="img" aria-label={`${messages.volumeTotal} messages sent in the last ${VOLUME_DAYS} days`}>
            {messages.volume.map((day) => (
              <div className="wa-bars__day" key={day.key} title={`${day.label}: ${day.sent} sent${day.failed ? `, ${day.failed} failed` : ''}`}>
                <div className="wa-bars__col">
                  {day.failed > 0 && <span className="wa-bars__failed" style={{ height: `${(day.failed / messages.volumeMax) * 100}%` }} />}
                  <span className="wa-bars__sent" style={{ height: `${(day.sent / messages.volumeMax) * 100}%` }} />
                </div>
                <small>{day.tick}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="wa-card wa-types" aria-label="Documents by type">
          <header className="wa-card__head">
            <div><h2>Documents by type</h2><p>How each kind of document is doing</p></div>
            <button className="wa-link" type="button" onClick={() => onNavigate('/documents')}>
              All documents <ArrowRight size={13} aria-hidden="true" />
            </button>
          </header>
          <ul className="wa-types__list">
            {documentTypes.map((documentType) => {
              const typeStats = messages.byType[documentType.type] ?? { total: 0, delivered: 0, failed: 0 };
              const share = typeStats.total ? Math.round((typeStats.delivered / typeStats.total) * 100) : 0;
              return (
                <li key={documentType.type}>
                  <span className="document-type-code">{documentType.type}</span>
                  <span className="wa-types__body">
                    <span className="wa-types__row">
                      <strong>{documentType.label}</strong>
                      <b>{typeStats.total}</b>
                    </span>
                    <span className="wa-types__track"><span style={{ width: `${share}%` }} /></span>
                    <small>{typeStats.total ? `${share}% delivered${typeStats.failed ? ` · ${typeStats.failed} not delivered` : ''}` : 'None sent yet'}</small>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

    </AppShell>
  );
}

function Automation({
  icon: Icon,
  name,
  trigger,
  action,
  state,
  stats,
  onOpen,
}: {
  icon: LucideIcon;
  name: string;
  trigger: string;
  action: string;
  state: AutomationState;
  stats: Array<{ label: string; value: string }>;
  onOpen: () => void;
}) {
  return (
    <li>
      <button className="wa-automation" type="button" onClick={onOpen}>
        <span className="wa-automation__icon"><Icon size={17} aria-hidden="true" /></span>
        <span className="wa-automation__body">
          <span className="wa-automation__title">
            <strong>{name}</strong>
            <em className={`wa-state wa-state--${state}`}>{STATE_LABEL[state]}</em>
          </span>
          <span className="wa-automation__rule">
            <span><b>When</b> {trigger}</span>
            <ArrowRight size={12} aria-hidden="true" />
            <span><b>Then</b> {action}</span>
          </span>
        </span>
        <span className="wa-automation__stats">
          {stats.map((stat) => (
            <span key={stat.label}><strong>{stat.value}</strong><small>{stat.label}</small></span>
          ))}
        </span>
        <ChevronRight className="wa-automation__chevron" size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function tickState(job: DeliveryJob): TickState {
  const message = relationOne(job.messages);
  const status = (message?.status ?? job.status).toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'read' || status === 'delivered' || message?.read_at || message?.delivered_at) return 'delivered';
  if (status === 'sent') return 'sent';
  return 'queued';
}

function messageStats(jobs: DeliveryJob[]) {
  const counts: Record<TickState, number> = { queued: 0, sent: 0, delivered: 0, failed: 0 };
  const byType: Record<string, { total: number; delivered: number; failed: number }> = {};
  const failedJobs: DeliveryJob[] = [];
  for (const job of jobs) {
    const state = tickState(job);
    counts[state] += 1;
    if (state === 'failed') failedJobs.push(job);
    const type = (relationOne(job.invoices)?.billing_document_type ?? job.metadata?.billing_document_type ?? '').toUpperCase();
    if (type) {
      const entry = (byType[type] ??= { total: 0, delivered: 0, failed: 0 });
      entry.total += 1;
      if (state === 'delivered') entry.delivered += 1;
      if (state === 'failed') entry.failed += 1;
    }
  }

  const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const volume = Array.from({ length: VOLUME_DAYS }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (VOLUME_DAYS - 1 - index));
    const labelled = index === 0 || index === Math.floor(VOLUME_DAYS / 2);
    return {
      key: dayKey(date),
      label: shortDate.format(date),
      tick: index === VOLUME_DAYS - 1 ? 'Today' : labelled ? shortDate.format(date) : '',
      sent: 0,
      failed: 0,
    };
  });
  const dayIndex = new Map(volume.map((day, index) => [day.key, index]));
  for (const job of jobs) {
    const stamp = job.created_at ?? job.scheduled_at;
    if (!stamp) continue;
    const index = dayIndex.get(dayKey(new Date(stamp)));
    if (index === undefined) continue;
    const state = tickState(job);
    if (state === 'failed') volume[index].failed += 1;
    else if (state !== 'queued') volume[index].sent += 1;
  }

  return {
    total: jobs.length,
    counts,
    byType,
    failedJobs,
    volume,
    volumeMax: Math.max(1, ...volume.map((day) => day.sent + day.failed)),
    volumeTotal: volume.reduce((sum, day) => sum + day.sent, 0),
    volumeFailed: volume.reduce((sum, day) => sum + day.failed, 0),
  };
}

function paymentStats(cases: PaymentFollowUpCase[]) {
  let currency = 'INR';
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let remindersSent = 0;
  for (const item of cases) {
    const jobs = item.jobs ?? (item.latestJob ? [item.latestJob] : []);
    remindersSent += jobs.filter((job) =>
      ['sent', 'delivered', 'read', 'completed'].includes(relationOne(job.messages)?.status ?? job.status)).length;
    const receivable = item.receivable;
    if (!receivable || item.resolved_at || item.status === 'resolved') continue;
    currency = receivable.currency || currency;
    outstanding += receivable.outstanding_amount;
    if (receivable.days_overdue > 0) {
      overdueCount += 1;
      overdueAmount += receivable.outstanding_amount;
    }
  }
  return { currency, outstanding, overdueAmount, overdueCount, remindersSent };
}

function toHelpSnapshot(response: HelpRequestPage | HelpRequest[]): HelpSnapshot {
  if (Array.isArray(response)) {
    const count = (status: HelpRequest['status']) => response.filter((item) => item.status === status).length;
    return { open: count('open'), inProgress: count('in_progress'), resolved: count('resolved') };
  }
  return { open: response.counts.open, inProgress: response.counts.in_progress, resolved: response.counts.resolved };
}
