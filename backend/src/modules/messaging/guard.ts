import {
  digitsOnly,
  env,
  marketingManagerAllowedRecipients,
  paymentTestRecipients,
  sapAllowedCustomers,
  whatsappTestRecipients,
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

export function currentCeilings(): Ceilings {
  return {
    mode: env.DELIVERY_MODE,
    customers: sapAllowedCustomers,
    phones: whatsappTestRecipients,
    paymentPhones: paymentTestRecipients,
    managerPhones: marketingManagerAllowedRecipients,
  };
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
}): Promise<'customer' | 'internal'> {
  const recipient = digitsOnly(input.recipient);
  const [setting, internal] = await Promise.all([
    input.source === 'sap' ? getCustomerSetting(input.customerNumber) : Promise.resolve(null),
    getInternalRecipient(recipient),
  ]);
  const decision = evaluateDocumentSend(currentCeilings(), { ...input, recipient, setting, internal });
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
  return decision.route;
}

/** Poller pre-check: also verifies the live SAP phone still matches the approval. */
export async function documentPollBlocker(candidate: {
  customerNumber: string;
  livePhone: string;
  creationDateTime: string | null;
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
  const decision = evaluateManagerCopy(currentCeilings(), await getCustomerSetting(customerNumber));
  return decision.allowed
    ? { recipient: decision.recipient }
    : { recipient: null, reason: decision.reason };
}

/** Re-checked immediately before a queued manager copy is dispatched. */
export async function assertManagerCopyStillAllowed(
  customerNumber: string,
  queuedRecipient: string,
): Promise<void> {
  const decision = evaluateManagerCopy(
    currentCeilings(),
    await getCustomerSetting(customerNumber),
    queuedRecipient,
  );
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
}

export async function assertPaymentRecipientApproved(recipient: string): Promise<void> {
  const phone = digitsOnly(recipient);
  const decision = evaluatePaymentRecipient(
    currentCeilings(),
    phone,
    await getInternalRecipient(phone),
  );
  if (!decision.allowed) throw new MessagingRefusal(decision.reason);
}

export function isHelpAlertRecipientPermitted(recipient: string): boolean {
  return helpAlertPermitted(currentCeilings(), recipient);
}
