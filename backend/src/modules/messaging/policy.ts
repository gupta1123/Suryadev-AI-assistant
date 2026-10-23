// Pure messaging-approval rules. Nothing here reads the database or the
// environment, so every decision can be tested exhaustively.
//
// Principle: a message needs BOTH the server-environment ceiling AND an explicit
// approval saved from Settings. Settings can only narrow what the ceiling allows.

export type CustomerMessagingSetting = {
  sapCustomerNumber: string;
  enabled: boolean;
  approvedPhone: string | null;
  enabledAt: string | null;
  managerName: string | null;
  managerPhone: string | null;
  managerSource: 'manual' | 'sap';
  updatedBy: string | null;
  updatedAt: string | null;
};

export type InternalRecipient = {
  phone: string;
  label: string | null;
  allowSimulator: boolean;
  allowPaymentReminders: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type Ceilings = {
  mode: 'test' | 'production';
  customers: ReadonlySet<string>;
  phones: ReadonlySet<string>;
  paymentPhones: ReadonlySet<string>;
  managerPhones: ReadonlySet<string>;
};

export type Decision =
  | { allowed: true; route: 'customer' | 'internal' }
  | { allowed: false; reason: string };

// Documents created before a customer was enabled are expected to be skipped (they
// were already handled by earlier deliveries); callers treat this reason as routine.
export const CREATED_BEFORE_ENABLED = 'document was created before this customer was enabled';

const digits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');
const deny = (reason: string) => ({ allowed: false as const, reason });

// Customer approval applies to every document/reminder, including fixtures.
// Team-number approval is an additional restriction, never a customer bypass.
export function evaluateCustomerMessaging(
  ceilings: Ceilings,
  customerNumber: string,
  setting: CustomerMessagingSetting | null,
): Decision {
  if (ceilings.mode === 'test' && !ceilings.customers.has(customerNumber)) {
    return deny('customer is outside the server-approved customers');
  }
  if (!setting?.enabled || setting.sapCustomerNumber !== customerNumber) {
    return deny('customer is not enabled in Settings');
  }
  if (!setting.approvedPhone || !setting.enabledAt) {
    return deny('customer has no approved phone number in Settings');
  }
  return { allowed: true, route: 'customer' };
}

export function evaluateDocumentSend(
  ceilings: Ceilings,
  input: {
    source: 'sap' | 'fixture';
    customerNumber: string;
    recipient: string;
    documentCreatedAt: string | null;
    setting: CustomerMessagingSetting | null;
    internal: InternalRecipient | null;
  },
): Decision {
  const test = ceilings.mode === 'test';
  const recipient = digits(input.recipient);
  if (!recipient) return deny('recipient is missing');
  if (test && !ceilings.phones.has(recipient)) {
    return deny('recipient is outside the server-approved test numbers');
  }
  const customerApproval = evaluateCustomerMessaging(ceilings, input.customerNumber, input.setting);
  if (!customerApproval.allowed) return customerApproval;

  const internalApproved = Boolean(input.internal?.allowSimulator) &&
    digits(input.internal?.phone) === recipient;

  if (input.source === 'fixture') {
    return internalApproved
      ? { allowed: true, route: 'internal' }
      : deny('sample documents may only go to an internal test number approved in Settings');
  }

  const setting = input.setting;
  if (!setting?.approvedPhone || !setting.enabledAt) {
    return deny('customer has no approved phone number in Settings');
  }

  if (recipient === digits(setting.approvedPhone)) {
    const created = input.documentCreatedAt ? Date.parse(input.documentCreatedAt) : NaN;
    const enabledAt = Date.parse(setting.enabledAt);
    if (!Number.isFinite(created) || !Number.isFinite(enabledAt) || created < enabledAt) {
      return deny(CREATED_BEFORE_ENABLED);
    }
    return { allowed: true, route: 'customer' };
  }
  if (internalApproved) return { allowed: true, route: 'internal' };
  return deny('recipient is neither the approved customer phone nor an approved internal test number');
}

// The live SAP phone must still equal the phone an administrator approved.
export function evaluateLivePhone(
  setting: CustomerMessagingSetting | null,
  livePhone: string | null | undefined,
): Decision {
  if (!setting?.enabled || !setting.approvedPhone) return deny('customer is not enabled in Settings');
  if (digits(livePhone) !== digits(setting.approvedPhone)) {
    return deny('SAP phone number differs from the approved number; re-approve it in Settings');
  }
  return { allowed: true, route: 'customer' };
}

export function evaluateManagerCopy(
  ceilings: Ceilings,
  setting: CustomerMessagingSetting | null,
  managerPhone?: string | null,
): { allowed: true; recipient: string } | { allowed: false; reason: string } {
  if (!setting?.enabled) return deny('customer is not enabled in Settings');
  const manager = digits(setting.managerPhone);
  if (!manager) return deny('no marketing manager is assigned to this customer');
  if (managerPhone !== undefined && digits(managerPhone) !== manager) {
    return deny('the assigned marketing manager changed after the copy was queued');
  }
  if (ceilings.mode === 'test' && !ceilings.managerPhones.has(manager)) {
    return deny('manager number is outside the server-approved manager numbers');
  }
  return { allowed: true, recipient: manager };
}

export function evaluatePaymentRecipient(
  ceilings: Ceilings,
  customerNumber: string,
  recipient: string,
  setting: CustomerMessagingSetting | null,
  internal: InternalRecipient | null,
): Decision {
  const customerApproval = evaluateCustomerMessaging(ceilings, customerNumber, setting);
  if (!customerApproval.allowed) return customerApproval;
  const phone = digits(recipient);
  if (!phone) return deny('recipient is missing');
  if (!ceilings.paymentPhones.has(phone) || !ceilings.phones.has(phone)) {
    return deny('recipient is outside the server-approved payment test numbers');
  }
  if (!internal?.allowPaymentReminders || digits(internal.phone) !== phone) {
    return deny('recipient is not approved for payment reminders in Settings');
  }
  return { allowed: true, route: 'internal' };
}

// Help-request alerts go to one internal number; in test mode it must be a
// number the server already approves.
export function isHelpAlertRecipientPermitted(ceilings: Ceilings, recipient: string): boolean {
  if (ceilings.mode !== 'test') return true;
  const phone = digits(recipient);
  return ceilings.phones.has(phone) || ceilings.managerPhones.has(phone);
}

export function normalizePhone(value: string): string {
  const d = digits(value);
  if (/^[6-9]\d{9}$/.test(d)) return `91${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `91${d.slice(1)}`;
  return d;
}

export const PHONE_PATTERN = /^[1-9]\d{7,14}$/;
