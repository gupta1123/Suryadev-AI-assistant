import { formatPhone } from '../../lib/format';
import type { MessagingCustomer, MessagingOverview, SapMasterDirectoryItem } from '../../types';
import type { Tone } from './ui';

export type CustomerStatus = 'enabled' | 'review' | 'off' | 'nophone' | 'locked' | 'unknown';

export type CustomerRow = {
  number: string;
  name: string;
  phone: string | null;
  status: CustomerStatus;
  messaging: MessagingCustomer | undefined;
  sap: SapMasterDirectoryItem | undefined;
};

export const STATUS_PILL: Record<CustomerStatus, { tone: Tone; label: string }> = {
  enabled: { tone: 'ok', label: 'Messaging on' },
  review: { tone: 'warn', label: 'Number changed' },
  off: { tone: 'off', label: 'Off' },
  nophone: { tone: 'off', label: 'No number in SAP' },
  locked: { tone: 'off', label: 'Not available' },
  unknown: { tone: 'off', label: 'Unknown' },
};

function statusOf(messaging: MessagingOverview | null, customer: MessagingCustomer | undefined): CustomerStatus {
  if (!messaging) return 'unknown';
  if (!customer) return 'locked';
  switch (customer.status) {
    case 'enabled': return 'enabled';
    case 'phone_changed': return 'review';
    case 'not_enabled': return 'off';
    default: return 'locked';
  }
}

// A customer that is Off and has no number in SAP can't be messaged, so it isn't counted as messageable.
function withoutNumber(status: CustomerStatus, phone: string | null | undefined): CustomerStatus {
  return status === 'off' && !phone ? 'nophone' : status;
}

/**
 * One row per customer. SAP's directory supplies names and numbers; the messaging overview
 * supplies what is allowed. A customer known only to the overview (SAP unreachable) is
 * still listed so it can be managed.
 */
export function buildCustomerRows(
  directory: SapMasterDirectoryItem[],
  messaging: MessagingOverview | null,
): CustomerRow[] {
  const byNumber = new Map((messaging?.customers ?? []).map((item) => [item.customerNumber, item]));
  const rows = new Map<string, CustomerRow>();
  const make = (sap: SapMasterDirectoryItem | undefined, customer: MessagingCustomer | undefined, number: string): CustomerRow => ({
    number,
    name: sap?.name || customer?.name || number,
    phone: customer?.livePhone ?? sap?.primaryPhone ?? null,
    status: withoutNumber(statusOf(messaging, customer), customer?.livePhone ?? sap?.primaryPhone),
    messaging: customer,
    sap,
  });
  for (const item of directory) rows.set(item.customerNumber, make(item, byNumber.get(item.customerNumber), item.customerNumber));
  for (const customer of byNumber.values()) {
    if (!rows.has(customer.customerNumber)) rows.set(customer.customerNumber, make(undefined, customer, customer.customerNumber));
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.number.localeCompare(b.number));
}

export type ManagerSummary = {
  kind: 'na' | 'none' | 'assigned' | 'sap' | 'same';
  /** Who gets the copy, e.g. "Rahul" or "From SAP". */
  title: string;
  detail: string;
  warning?: string;
};

export function managerSummary(row: CustomerRow): ManagerSummary {
  const customer = row.messaging;
  if (!customer || row.status === 'locked' || row.status === 'unknown') {
    return { kind: 'na', title: '—', detail: '' };
  }
  const copy = customer.managerCopy;
  if (copy?.source === 'sap') {
    if (!copy.recipient) {
      return { kind: 'none', title: 'No copy', detail: copy.reason ?? 'SAP has no marketing manager for this customer.' };
    }
    // A customer can have several managers (one per sales group). Each gets a copy,
    // except a manager whose number is the customer's own, who already has the message.
    const all = copy.recipients?.length ? copy.recipients : [copy.recipient];
    const extra = all.filter((phone) => phone !== customer.livePhone);
    if (!extra.length) {
      return { kind: 'same', title: 'No extra copy', detail: `${formatPhone(copy.recipient)} already receives the customer’s message.` };
    }
    const skipped = copy.skippedAreas ?? 0;
    const warnings = [
      copy.reason,
      skipped ? `${skipped} sales area${skipped === 1 ? ' has' : 's have'} no manager in SAP and ${skipped === 1 ? 'is' : 'are'} skipped.` : null,
    ].filter(Boolean).join(' ');
    return {
      kind: 'sap',
      title: extra.length > 1 ? `${extra.length} managers (from SAP)` : 'From SAP',
      detail: extra.map(formatPhone).join(', '),
      ...(warnings ? { warning: warnings } : {}),
    };
  }
  const setting = customer.setting;
  if (setting?.managerPhone) {
    return {
      kind: 'assigned',
      title: setting.managerName || 'Manager',
      detail: formatPhone(setting.managerPhone),
      ...(customer.managerPhoneApproved ? {} : { warning: 'Not on the server’s approved list, so no copy is sent.' }),
    };
  }
  return { kind: 'none', title: 'No copy', detail: 'No marketing manager assigned.' };
}
