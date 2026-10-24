import type { SapSalesAssignment } from '../customers/sap-masters.js';
import { type Ceilings, type CustomerMessagingSetting, evaluateManagerCopy, normalizePhone } from './policy.js';

export type ManagerCopyDecision = { allowed: true; recipient: string } | { allowed: false; reason: string };

/** No manual fallback and no fan-out to unrelated sales areas. */
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
  if (assignments.some((area) => area.managerStatus !== 'mapped' || !area.marketingManagerPhone)) {
    return { allowed: false, reason: 'SAP manager mapping is missing, inaccessible or conflicting; no fallback copy is sent' };
  }
  const numbers = [...new Set(assignments.map((area) => normalizePhone(area.marketingManagerPhone!)))];
  if (numbers.length !== 1) {
    return { allowed: false, reason: 'SAP sales areas have different managers; no recipient is chosen automatically' };
  }
  const phone = numbers[0]!;
  if (!/^91[6-9]\d{9}$/.test(phone) || /^(\d)\1{9}$/.test(phone.slice(2))) {
    return { allowed: false, reason: 'SAP manager number is invalid or a placeholder; no copy is sent' };
  }
  // Apply the existing enabled-customer, allowlist and queued-recipient checks
  // to the LIVE SAP phone, never to the old manual assignment.
  return evaluateManagerCopy(ceilings, { ...setting, managerSource: 'sap', managerName: null, managerPhone: phone }, queuedRecipient);
}
