import {
  AlertTriangle,
  BadgeIndianRupee,
  CheckCircle2,
  Copy,
  FileText,
  Info,
  LifeBuoy,
  Lock,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react';
import { formatDuration, reminderSummary } from './duration';
import {
  billingState,
  customerCounts,
  paymentState,
  STATE_PILL,
  type AutomationState,
  type Issue,
  type TabId,
} from './health';
import { Card, Pill, Skeleton } from './ui';
import { formatPhone, formatRelative } from '../../lib/format';
import type {
  BillingDocumentTemplateReadiness,
  DeliveryConfig,
  HelpRequestAlertSettings,
  MessagingOverview,
  PaymentFollowUpConfig,
  SapPollingStatus,
} from '../../types';

export function OverviewTab({
  config,
  paymentConfig,
  helpAlert,
  polling,
  templates,
  checkingTemplates,
  messaging,
  issues,
  onGo,
}: {
  config: DeliveryConfig | null;
  paymentConfig: PaymentFollowUpConfig | null;
  helpAlert: HelpRequestAlertSettings | null;
  polling: SapPollingStatus;
  templates: BillingDocumentTemplateReadiness | null;
  checkingTemplates: boolean;
  messaging: MessagingOverview | null;
  issues: Issue[];
  onGo: (tab: TabId) => void;
}) {
  if (!config) return <Skeleton rows={4} />;

  const liveSap = config.invoiceSource === 'sap';
  const testMode = config.deliveryMode === 'test';
  const counts = customerCounts(messaging);
  const attention = issues.filter((issue) => issue.tone !== 'info');
  const worst: 'ok' | 'warn' | 'bad' = issues.some((issue) => issue.tone === 'bad') ? 'bad' : attention.length ? 'warn' : 'ok';

  const hero = {
    ok: {
      icon: CheckCircle2,
      title: testMode ? 'Ready — running in test mode' : 'Everything is running',
      text: testMode
        ? 'Messages only go to the customers and phone numbers approved for testing. Nobody else can receive them.'
        : 'New invoices and memos are sent to the customers you’ve turned on.',
    },
    warn: {
      icon: AlertTriangle,
      title: attention.length === 1 ? 'One thing needs your attention' : `${attention.length} things need your attention`,
      text: 'Sending still works where it can, but fix the items below to get everything running.',
    },
    bad: {
      icon: OctagonAlert,
      title: 'Something needs fixing',
      text: 'Part of the system isn’t working. Start with the items below.',
    },
  }[worst];
  const HeroIcon = hero.icon;

  const approved = templates?.templates.filter((item) => item.approved).length ?? 0;
  const totalFormats = templates?.templates.length ?? config.billingDocumentTypes.length;
  const pollFailed = polling?.last_status === 'failed';

  return (
    <div className="st-stack">
      <section className={`st-hero st-hero--${worst}`} aria-live="polite">
        <span className="st-hero__icon"><HeroIcon size={26} aria-hidden="true" /></span>
        <div>
          <h2>{hero.title}</h2>
          <p>{hero.text}</p>
        </div>
      </section>

      {issues.length > 0 && (
        <Card title="To do" description="Things that are stopping or slowing down sending.">
          <ul className="st-issues">
            {issues.map((issue) => (
              <li key={issue.id} className={`st-issue st-issue--${issue.tone}`}>
                <span className="st-issue__icon" aria-hidden="true">
                  {issue.tone === 'info' ? <Info size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{issue.title}</strong>
                  <p>{issue.detail}</p>
                </div>
                <button className="button button--secondary st-sm" type="button" onClick={() => onGo(issue.tab)}>{issue.action}</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="st-tiles">
        <Tile
          label="Customers turned on"
          value={messaging ? String(counts.enabled) : '—'}
          note={messaging ? `of ${counts.available} you can message` : 'Loading…'}
          onClick={() => onGo('customers')}
        />
        <Tile
          label="Message formats"
          value={templates ? `${approved} of ${totalFormats}` : checkingTemplates ? 'Checking…' : '—'}
          note="approved by WhatsApp"
          tone={templates && !templates.allApproved ? 'warn' : undefined}
          onClick={() => onGo('connections')}
        />
        <Tile
          label="Last SAP check"
          value={liveSap ? formatRelative(polling?.last_completed_at) : 'Test data'}
          note={liveSap
            ? pollFailed ? 'The check failed' : polling ? `${polling.records_processed} ${polling.records_processed === 1 ? 'document' : 'documents'} found` : 'Not checked yet'
            : 'Not using live SAP'}
          tone={pollFailed ? 'bad' : undefined}
          onClick={() => onGo('connections')}
        />
        <Tile
          label="Payment reminders"
          value={paymentConfig ? `Up to ${paymentConfig.maximumTestReminders}` : '—'}
          note={paymentConfig ? `first after ${formatDuration(paymentConfig.firstReminderDelaySeconds)}` : 'Loading…'}
          onClick={() => onGo('reminders')}
        />
      </div>

      <Card
        title="What’s automated"
        description="What goes out on WhatsApp without anyone pressing a button."
        flush
      >
        <ul className="st-auto">
          <AutomationRow
            icon={FileText}
            name="Invoices and memos"
            detail={liveSap ? 'Sent as soon as SAP creates them, to customers you’ve turned on.' : 'Only test documents are sent right now.'}
            state={billingState(config)}
            actionLabel="Choose customers"
            onAction={() => onGo('customers')}
          />
          <AutomationRow
            icon={BadgeIndianRupee}
            name="Payment reminders"
            detail={paymentConfig
              ? reminderSummary(paymentConfig.firstReminderDelaySeconds, paymentConfig.repeatReminderDelaySeconds, paymentConfig.maximumTestReminders)
              : 'Sent after an invoice goes out.'}
            state={paymentState(paymentConfig)}
            actionLabel="Change timing"
            onAction={() => onGo('reminders')}
          />
          <AutomationRow
            icon={LifeBuoy}
            name="Customer replies"
            detail={config.msg91WebhookConfigured
              ? helpAlert?.recipient
                ? `When a customer taps “Need Help”, ${formatPhone(helpAlert.recipient)} is alerted and it appears in Needs attention.`
                : 'When a customer taps “Need Help”, it appears in Needs attention.'
              : 'Replies aren’t reaching the app yet — your technical admin needs to finish the WhatsApp connection.'}
            state={config.msg91WebhookConfigured ? 'live' : 'off'}
          />
          <AutomationRow
            icon={Copy}
            name="Marketing manager copies"
            detail="Each customer’s marketing manager gets a copy of what that customer receives."
            state={config.marketingCopy?.enabled ? 'live' : 'off'}
            actionLabel="Choose managers"
            onAction={() => onGo('customers')}
          />
        </ul>
        <p className="st-foot-note">
          <Lock size={13} aria-hidden="true" /> The On/Off switches for these are controlled by your technical admin on the server.
        </p>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'warn' | 'bad' | undefined;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`st-tile${tone ? ` st-tile--${tone}` : ''}`} onClick={onClick}>
      <span className="st-tile__label">{label}</span>
      <strong>{value}</strong>
      <span className="st-tile__note">{note}</span>
    </button>
  );
}

function AutomationRow({
  icon: Icon,
  name,
  detail,
  state,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  name: string;
  detail: string;
  state: AutomationState;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const pill = STATE_PILL[state];
  return (
    <li className="st-auto__row">
      <span className="st-auto__icon"><Icon size={18} aria-hidden="true" /></span>
      <div className="st-auto__text">
        <strong>{name}</strong>
        <p>{detail}</p>
        {actionLabel && onAction && <button type="button" className="st-link" onClick={onAction}>{actionLabel} →</button>}
      </div>
      <Pill tone={pill.tone}>{pill.label}</Pill>
    </li>
  );
}
