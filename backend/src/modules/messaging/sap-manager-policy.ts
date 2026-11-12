import type { SapSalesAssignment } from '../customers/sap-masters.js';
import { type Ceilings, type CustomerMessagingSetting, evaluateManagerCopy, normalizePhone } from './policy.js';

export type ManagerCopyDecision =
  // `recipient` is the first manager; `recipients` is everyone who gets a copy.
  // `skippedAreas` counts sales areas SAP has no usable manager for.
  | { allowed: true; recipient: string; recipients: string[]; skippedAreas: number }
  | { allowed: false; reason: string };

// A customer with sales areas in different sales groups can have several managers.
// Every distinct, valid manager gets a copy; a safety cap stops a bad mapping fanning out.
export const MAX_MANAGER_COPIES = 5;

const validManagerPhone = (phone: string) => /^91[6-9]\d{9}$/.test(phone) && !/^(\d)\1{9}$/.test(phone.slice(2));

/** No manual fallback. Sales areas without a usable manager are skipped, never guessed. */
export function evaluateSapManagerCopy(
  ceilings: Ceilings,
  setting: CustomerMessagingSetting | null,
  assignments: SapSalesAssignment[],
  queuedRecipient?: string,
): ManagerCopyDecision {
  if (!setting?.enabled) return { allowed: false, reason: 'customer is not enabled in Settings' };
  if (!ceilings.dashboardApprovals && ceilings.mode === 'test' && !ceilings.customers.has(setting.sapCustomerNumber)) {
    return { allowed: false, reason: 'customer is outside the server-approved customers' };
  }
  if (!assignments.length) return { allowed: false, reason: 'SAP has no sales-group manager mapping for this customer' };
  const mapped = assignments.filter((area) => area.managerStatus === 'mapped' && area.marketingManagerPhone);
  if (!mapped.length) {
    return { allowed: false, reason: 'SAP manager mapping is missing, inaccessible or conflicting; no fallback copy is sent' };
  }
  const skippedAreas = assignments.length - mapped.length;
  const numbers = [...new Set(mapped.map((area) => normalizePhone(area.marketingManagerPhone!)))];
  const valid = numbers.filter(validManagerPhone);
  if (!valid.length) return { allowed: false, reason: 'SAP manager number is invalid or a placeholder; no copy is sent' };
  if (valid.length > MAX_MANAGER_COPIES) {
    return { allowed: false, reason: `SAP lists more than ${MAX_MANAGER_COPIES} different managers for this customer; no copy is sent` };
  }
  // A queued copy is re-checked for its own recipient only.
  if (queuedRecipient !== undefined && !valid.includes(normalizePhone(queuedRecipient))) {
    return { allowed: false, reason: 'the assigned marketing manager changed after the copy was queued' };
  }
  const candidates = queuedRecipient !== undefined ? [normalizePhone(queuedRecipient)] : valid;
  // Apply the existing enabled-customer, allowlist and queued-recipient checks
  // to the LIVE SAP phone, never to the old manual assignment.
  const decisions = candidates.map((phone) =>
    evaluateManagerCopy(ceilings, { ...setting, managerSource: 'sap', managerName: null, managerPhone: phone }, queuedRecipient));
  const recipients = decisions.flatMap((decision) => decision.allowed ? [decision.recipient] : []);
  if (!recipients.length) {
    const refusal = decisions.find((decision) => !decision.allowed);
    return { allowed: false, reason: refusal && !refusal.allowed ? refusal.reason : 'no manager copy is allowed' };
  }
  return { allowed: true, recipient: recipients[0]!, recipients, skippedAreas };
}
