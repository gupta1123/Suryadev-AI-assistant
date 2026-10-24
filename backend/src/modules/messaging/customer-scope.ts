import { isDashboardCustomerApprovalEnabled, sapAllowedCustomers } from '../../config/env.js';
import { listCustomerSettings } from './repository.js';

export async function approvedSapCustomerNumbers(): Promise<Set<string>> {
  if (!isDashboardCustomerApprovalEnabled()) return sapAllowedCustomers;
  return new Set((await listCustomerSettings()).filter(row => row.enabled && row.approvedPhone && row.enabledAt)
    .map(row => row.sapCustomerNumber));
}
