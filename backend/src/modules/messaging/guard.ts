import {
  digitsOnly,
  env,
  marketingManagerAllowedRecipients,
  paymentTestRecipients,
  sapAllowedCustomers,
  whatsappTestRecipients,
  isDashboardCustomerApprovalEnabled,
} from '../../config/env.js';
import {
  type Ceilings,
  evaluateDocumentSend,
  evaluateLivePhone,
  evaluateManagerCopy,
  evaluatePaymentRecipient,
  isHelpAlertRecipientPermitted as helpAlertPermitted,
} from './policy.js';
import { getCustomerSetting, getInternalRecipient } from './repository.js';
import { documentDateBlocker, type DocumentSendDates } from './document-date-policy.js';
import { readCurrentSapManagerAssignments, readCurrentSapPrimaryPhone } from '../customers/sap-masters.js';
import { evaluateSapManagerCopy, type ManagerCopyDecision } from './sap-manager-policy.js';

export function currentCeilings(): Ceilings {
  return {
    dashboardApprovals: isDashboardCustomerApprovalEnabled(),
    mode: env.DELIVERY_MODE,
    customers: sapAllowedCustomers,
    phones: whatsappTestRecipients,
    paymentPhones: paymentTestRecipients,
    managerPhones: marketingManagerAllowedRecipients,
  };
}

export function assertDocumentDateAllowed(dates: DocumentSendDates, enabledAt?: string | null): void {
  const refusal = documentDateBlocker(dates, enabledAt);
  if (refusal) throw new MessagingRefusal(refusal);
}

export class MessagingRefusal extends Error {
  constructor(reason: string) {
    super(`Messaging refused: ${reason}`);
    this.name = 'MessagingRefusal';
  }
}

export function jobSource(metadata: Record<string, unknown> | undefined): 'sap' | 'fixture' {
  // An unknown source is treated as 'sap', which has the stricter rules.
  return metadata?.source === 'fixture' ? 'fixture' : 'sap';
}

/** Final gate for a customer-facing document. Reads fresh from the database. */
export async function assertDocumentSendAllowed(input: {
  source: 'sap' | 'fixture';
  customerNumber: string;
  recipient: string;
  documentCreatedAt: string | null;
  documentDate: string | null;
}): Promise<'customer' | 'internal'> {
  const recipient = digitsOnly(input.recipient);
  const livePhone = isDashboardCustomerApprovalEnabled() && input.source === 'sap'
    ? await readCurrentSapPrimaryPhone(input.customerNumber) : undefined;
  const [setting, internal] = await Promise.all([
    getCustomerSetting(input.customerNumber),
    getInternalRecipient(recipient),
  ]);
  if (livePhone !== undefined) {
    const live = evaluateLivePhone(setting, livePhone);
    if (!live.allowed) throw new MessagingRefusal(live.reason);
  }
  const decision = evaluateDocumentSend(currentCeilings(), { ...input, recipient, setting, internal });
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
  return decision.route;
}

/** Poller pre-check: also verifies the live SAP phone still matches the approval. */
export async function documentPollBlocker(candidate: {
  customerNumber: string;
  livePhone: string;
  creationDateTime: string | null;
  documentDate: string | null;
}): Promise<string | null> {
  try {
    const setting = await getCustomerSetting(candidate.customerNumber);
    const live = evaluateLivePhone(setting, candidate.livePhone);
    if (!live.allowed) return live.reason;
    const decision = evaluateDocumentSend(currentCeilings(), {
      source: 'sap',
      customerNumber: candidate.customerNumber,
      recipient: candidate.livePhone,
      documentCreatedAt: candidate.creationDateTime,
      documentDate: candidate.documentDate,
      setting,
      internal: null,
    });
    return decision.allowed ? null : decision.reason;
  } catch (error) {
    return `messaging controls unavailable (${error instanceof Error ? error.message : 'unknown error'})`;
  }
}

/** Recipient for a customer's manager copy, or null (no copy) with the reason. */
export async function resolveManagerCopyRecipient(
  customerNumber: string,
): Promise<{ recipient: string | null; reason?: string }> {
  const decision = await currentManagerCopyDecision(customerNumber);
  return decision.allowed
    ? { recipient: decision.recipient }
    : { recipient: null, reason: decision.reason };
}

async function currentManagerCopyDecision(customerNumber: string, queuedRecipient?: string): Promise<ManagerCopyDecision> {
  const setting = await getCustomerSetting(customerNumber);
  if (env.MSG91_MARKETING_COPY_SOURCE !== 'sap') return evaluateManagerCopy(currentCeilings(), setting, queuedRecipient);
  if (!setting?.enabled) return { allowed: false, reason: 'customer is not enabled in Settings' };
  try {
    const assignments = await readCurrentSapManagerAssignments(customerNumber);
    // The SAP call can be slow. Re-read approval AFTER it, so disabling while
    // the lookup is running cannot leave an old enabled snapshot in use.
    const latestSetting = await getCustomerSetting(customerNumber);
    return evaluateSapManagerCopy(currentCeilings(), latestSetting, assignments, queuedRecipient);
  } catch {
    // A manager-lookup outage must not fall back to an unrelated internal
    // recipient or prevent the separately approved customer message.
    return { allowed: false, reason: 'live SAP manager lookup unavailable; no fallback copy is sent' };
  }
}

/** Re-checked immediately before a queued manager copy is dispatched. */
export async function assertManagerCopyStillAllowed(
  customerNumber: string,
  queuedRecipient: string,
  dates: DocumentSendDates,
): Promise<void> {
  const livePhone = isDashboardCustomerApprovalEnabled() ? await readCurrentSapPrimaryPhone(customerNumber) : undefined;
  const decision = await currentManagerCopyDecision(customerNumber, queuedRecipient);
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
  const setting = await getCustomerSetting(customerNumber);
  if (!setting?.enabled) throw new MessagingRefusal('customer is not enabled in Settings');
  if (livePhone !== undefined) {
    const live = evaluateLivePhone(setting, livePhone);
    if (!live.allowed) throw new MessagingRefusal(live.reason);
  }
  assertDocumentDateAllowed(dates, setting.enabledAt);
}

export async function assertPaymentRecipientApproved(customerNumber: string, recipient: string, dates: DocumentSendDates): Promise<void> {
  const phone = digitsOnly(recipient);
  const livePhone = isDashboardCustomerApprovalEnabled() ? await readCurrentSapPrimaryPhone(customerNumber) : undefined;
  const [setting, internal] = await Promise.all([
    getCustomerSetting(customerNumber),
    getInternalRecipient(phone),
  ]);
  if (livePhone !== undefined) {
    const live = evaluateLivePhone(setting, livePhone);
    if (!live.allowed) throw new MessagingRefusal(live.reason);
  }
  const decision = evaluatePaymentRecipient(
    currentCeilings(),
    customerNumber,
    phone,
    setting,
    internal,
  );
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
  assertDocumentDateAllowed(dates, setting?.enabledAt);
}

export function isHelpAlertRecipientPermitted(recipient: string): boolean {
  return helpAlertPermitted(currentCeilings(), recipient);
}
