import type {
  BillingDocumentTemplateReadiness,
  DeliveryConfig,
  MessagingOverview,
  PaymentFollowUpConfig,
  SapPollingStatus,
} from '../../types';
import type { Tone } from './ui';

export type TabId = 'overview' | 'customers' | 'reminders' | 'connections' | 'team';

export type Issue = {
  id: string;
  tone: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  tab: TabId;
  action: string;
};

export type AutomationState = 'live' | 'test' | 'paused' | 'off';

export const STATE_PILL: Record<AutomationState, { tone: Tone; label: string }> = {
  live: { tone: 'ok', label: 'On' },
  test: { tone: 'test', label: 'Test mode' },
  paused: { tone: 'warn', label: 'Paused' },
  off: { tone: 'off', label: 'Off' },
};

export function customerCounts(messaging: MessagingOverview | null) {
  const customers = messaging?.customers ?? [];
  return {
    available: customers.filter((item) => item.status !== 'locked').length,
    enabled: customers.filter((item) => item.status === 'enabled').length,
    review: customers.filter((item) => item.status === 'phone_changed').length,
  };
}

export function billingState(config: DeliveryConfig | null): AutomationState {
  if (!config) return 'off';
  if (!config.msg91Configured || !config.sendEnabled) return 'paused';
  return config.invoiceSource === 'sap' ? 'live' : 'test';
}

export function paymentState(config: PaymentFollowUpConfig | null): AutomationState {
  if (!config?.enabled) return 'off';
  if (!config.sendEnabled) return 'paused';
  return config.controlledTest ? 'test' : 'live';
}

export function buildIssues(input: {
  config: DeliveryConfig | null;
  polling: SapPollingStatus;
  templates: BillingDocumentTemplateReadiness | null;
  messaging: MessagingOverview | null;
  messagingError: string;
}): Issue[] {
  const { config, polling, templates, messaging, messagingError } = input;
  if (!config) return [];
  const issues: Issue[] = [];
  const liveSap = config.invoiceSource === 'sap';

  if (!config.supabaseServiceConfigured) {
    issues.push({
      id: 'database',
      tone: 'bad',
      title: 'The database isn’t connected',
      detail: 'Documents can’t be saved or tracked until your technical admin finishes the database setup.',
      tab: 'connections',
      action: 'See connections',
    });
  }
  if (!config.msg91Configured) {
    issues.push({
      id: 'whatsapp-missing',
      tone: 'bad',
      title: 'WhatsApp isn’t connected',
      detail: 'The WhatsApp sign-in details are missing on the server, so nothing can be sent.',
      tab: 'connections',
      action: 'See connections',
    });
  } else if (!config.sendEnabled) {
    issues.push({
      id: 'whatsapp-off',
      tone: 'warn',
      title: 'WhatsApp sending is switched off',
      detail: 'Documents are prepared but not sent. Your technical admin can switch sending on.',
      tab: 'connections',
      action: 'See connections',
    });
  }
  if (liveSap) {
    const hostApproved = messaging?.sapHostApproved ?? config.sapHostApproved;
    if (hostApproved === false) {
      issues.push({
        id: 'sap-host',
        tone: 'bad',
        title: 'The SAP system isn’t verified',
        detail: 'Sending is blocked because the SAP address doesn’t match the system approved for this server.',
        tab: 'connections',
        action: 'See connections',
      });
    }
    if (polling?.last_status === 'failed') {
      issues.push({
        id: 'sap-failed',
        tone: 'bad',
        title: 'The last SAP check failed',
        detail: polling.last_error ? shorten(polling.last_error) : 'New documents may not be picked up until this is fixed.',
        tab: 'connections',
        action: 'See details',
      });
    } else if (!config.sapPollingReady) {
      issues.push({
        id: 'sap-not-ready',
        tone: 'warn',
        title: 'Automatic SAP checking isn’t ready',
        detail: 'A few server settings are still needed before new documents are picked up on their own.',
        tab: 'connections',
        action: 'See connections',
      });
    }
  }
  if (templates && !templates.allApproved) {
    const waiting = templates.templates.filter((item) => !item.approved);
    issues.push({
      id: 'formats',
      tone: 'warn',
      title: `${waiting.length} message ${waiting.length === 1 ? 'format is' : 'formats are'} waiting for WhatsApp approval`,
      detail: `${waiting.map((item) => item.label).join(', ')} can’t be sent until approved. They’re held and sent automatically afterwards.`,
      tab: 'connections',
      action: 'See formats',
    });
  }
  if (messagingError) {
    issues.push({
      id: 'messaging-error',
      tone: 'warn',
      title: 'Customer controls couldn’t be loaded',
      detail: shorten(messagingError),
      tab: 'customers',
      action: 'Open customers',
    });
  } else if (messaging) {
    const counts = customerCounts(messaging);
    if (counts.review > 0) {
      issues.push({
        id: 'phone-changed',
        tone: 'warn',
        title: `${counts.review} ${counts.review === 1 ? 'customer has' : 'customers have'} a new number in SAP`,
        detail: 'Sending to them is paused until you check and approve the new number.',
        tab: 'customers',
        action: 'Review',
      });
    }
    if (liveSap && counts.enabled === 0 && counts.review === 0) {
      issues.push({
        id: 'no-customers',
        tone: 'info',
        title: 'No customers are turned on yet',
        detail: 'Documents are only sent to customers you turn on, so nothing goes out right now.',
        tab: 'customers',
        action: 'Choose customers',
      });
    }
  }
  return issues;
}

function shorten(message: string): string {
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}
