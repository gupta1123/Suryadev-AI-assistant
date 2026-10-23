import { RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { apiRequest } from '../../lib/api';
import { formatDate, formatDateTime, formatRelative, toMessage } from '../../lib/format';
import type { BillingDocumentTemplateReadiness, DeliveryConfig, MessagingOverview, SapPollingStatus } from '../../types';
import { Card, LiveNote, Pill, Skeleton, type Tone } from './ui';
import { formatDuration } from './duration';

export function ConnectionsTab({
  config,
  polling,
  templates,
  checkingTemplates,
  messaging,
  onCheckTemplates,
  onRefresh,
}: {
  config: DeliveryConfig | null;
  polling: SapPollingStatus;
  templates: BillingDocumentTemplateReadiness | null;
  checkingTemplates: boolean;
  messaging: MessagingOverview | null;
  onCheckTemplates: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  if (!config) return <Skeleton rows={4} />;

  const liveSap = config.invoiceSource === 'sap';
  const failed = polling?.last_status === 'failed';
  const interval = config.sapPollIntervalMs ? formatDuration(config.sapPollIntervalMs / 1000) : null;
  const next = polling?.last_completed_at && config.sapPollIntervalMs
    ? new Date(new Date(polling.last_completed_at).getTime() + config.sapPollIntervalMs).toISOString()
    : null;
  const hostApproved = messaging?.sapHostApproved ?? config.sapHostApproved;
  const sapHost = messaging?.sapHost ?? config.sapHost;

  async function checkNow() {
    setChecking(true);
    setResult(null);
    try {
      await apiRequest('/invoice-delivery/poll-now', { method: 'POST' });
      setResult({ tone: 'ok', text: 'SAP was checked. Eligible new documents are handled according to the existing sending approvals.' });
      await onRefresh();
    } catch (failure) {
      setResult({ tone: 'bad', text: toMessage(failure) });
    } finally {
      setChecking(false);
    }
  }

  const sapTone: Tone = !liveSap ? 'off' : failed ? 'bad' : config.sapPollingReady ? 'ok' : 'warn';
  const sapLabel = !liveSap ? 'Using test data' : failed ? 'Last check failed' : config.sapPollingReady ? 'Connected' : 'Not ready';
  const approvedCount = templates?.templates.filter((item) => item.approved).length ?? 0;

  return (
    <div className="st-stack">
      <Card
        title="SAP"
        description="Where new invoices and memos come from. The app only reads from SAP — it never changes anything there."
        action={liveSap && (
          <button className="button button--secondary" type="button" disabled={checking || !config.sapPollingReady} onClick={() => void checkNow()}>
            <RefreshCw size={15} className={checking ? 'spin' : ''} aria-hidden="true" /> {checking ? 'Checking…' : 'Check SAP now'}
          </button>
        )}
      >
        <div className="st-statusline">
          <Pill tone={sapTone}>{sapLabel}</Pill>
          <span>
            {liveSap
              ? `Looks for new documents${interval ? ` every ${interval}` : ''}.`
              : 'Live SAP is switched off, so only test documents are used. Your technical admin can turn it on.'}
          </span>
        </div>
        {result && <LiveNote tone={result.tone}>{result.text}</LiveNote>}
        {failed && polling?.last_error && (
          <div className="st-errorbox" role="alert">
            <strong>What went wrong</strong>
            <p className="mono">{polling.last_error}</p>
          </div>
        )}
        <dl className="st-facts">
          <Fact label="Last check" value={liveSap ? formatRelative(polling?.last_completed_at) : '—'} title={formatDateTime(polling?.last_completed_at)} />
          <Fact label="Next check" value={liveSap ? formatRelative(next) : '—'} title={formatDateTime(next)} />
          <Fact label="Documents found last time" value={liveSap && polling ? String(polling.records_processed) : '—'} />
          <Fact label="Looking at documents from" value={config.sapPollStartDate ? formatDate(config.sapPollStartDate) : '—'} />
          <Fact label="Customers allowed by the server" value={String(config.sapAllowedCustomers.length)} />
          <Fact
            label="SAP system"
            value={sapHost || 'Not set'}
            mono
            badge={liveSap && hostApproved !== undefined ? <Pill tone={hostApproved ? 'ok' : 'bad'}>{hostApproved ? 'Verified' : 'Not verified'}</Pill> : undefined}
          />
        </dl>
      </Card>

      <Card title="WhatsApp" description="The service that delivers messages to your customers.">
        <ul className="st-checklist">
          <CheckRow label="Connection" detail="Your WhatsApp sender is linked." tone={config.msg91Configured ? 'ok' : 'bad'} text={config.msg91Configured ? 'Connected' : 'Not connected'} />
          <CheckRow label="Sending" detail="Whether messages are actually sent, or only prepared." tone={!config.msg91Configured ? 'off' : config.sendEnabled ? 'ok' : 'warn'} text={config.sendEnabled ? 'On' : 'Off'} />
          <CheckRow
            label="Delivery updates"
            detail="How the app learns that a message was delivered or read."
            tone={config.msg91WebhookConfigured ? 'ok' : config.msg91StatusPollingEnabled ? 'warn' : 'off'}
            text={config.msg91WebhookConfigured ? 'Live' : config.msg91StatusPollingEnabled ? 'Checked regularly' : 'Off'}
          />
          <CheckRow label="Customer replies" detail="“Received” and “Need Help” taps from customers." tone={config.msg91WebhookConfigured ? 'ok' : 'off'} text={config.msg91WebhookConfigured ? 'Coming through' : 'Not connected'} />
          <CheckRow label="Database" detail="Where documents and their history are stored." tone={config.supabaseServiceConfigured ? 'ok' : 'bad'} text={config.supabaseServiceConfigured ? 'Connected' : 'Not connected'} />
        </ul>
      </Card>

      <Card
        title="Message formats"
        description={templates
          ? `${approvedCount} of ${templates.templates.length} approved by WhatsApp. A format that isn’t approved yet is held, then sent automatically once it is.`
          : 'WhatsApp must approve each format before it can be sent.'}
        action={(
          <button className="button button--secondary st-sm" type="button" disabled={checkingTemplates} onClick={() => void onCheckTemplates()}>
            <RefreshCw size={14} className={checkingTemplates ? 'spin' : ''} aria-hidden="true" /> Check again
          </button>
        )}
      >
        <ul className="st-checklist">
          {config.billingDocumentTypes.map((documentType) => {
            const approved = templates?.templates.find((item) => item.type === documentType.type)?.approved;
            const unknown = checkingTemplates || !templates;
            return (
              <li key={documentType.type} className="st-checklist__row">
                <span className="document-type-code">{documentType.type}</span>
                <div className="st-checklist__text">
                  <strong>{documentType.label}</strong>
                  <small className="mono">{documentType.templateName}</small>
                </div>
                <Pill tone={unknown ? 'off' : approved ? 'ok' : 'warn'}>
                  {unknown ? (checkingTemplates ? 'Checking…' : 'Unknown') : approved ? 'Approved' : 'Waiting for approval'}
                </Pill>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function Fact({ label, value, title, mono = false, badge }: { label: string; value: string; title?: string; mono?: boolean; badge?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined} title={title && title !== '—' ? title : undefined}>{value}{badge}</dd>
    </div>
  );
}

function CheckRow({ label, detail, tone, text }: { label: string; detail: string; tone: Tone; text: string }) {
  return (
    <li className="st-checklist__row">
      <div className="st-checklist__text">
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      <Pill tone={tone}>{text}</Pill>
    </li>
  );
}
