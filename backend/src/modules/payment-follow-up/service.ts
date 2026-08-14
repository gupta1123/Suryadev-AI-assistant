import { env } from '../../config/env.js';
import { isPaymentReminderTemplateApproved } from '../invoice-delivery/msg91-client.js';
import { SapInvoiceSource } from '../invoice-delivery/sap-source.js';
import type { PaymentTestPreview } from './domain.js';
import { buildPaymentPreview } from './policy.js';

const sapSource = new SapInvoiceSource();

export async function getPaymentTestPreview(): Promise<PaymentTestPreview> {
  const [candidate, templateApproved] = await Promise.all([
    sapSource.get(env.PAYMENT_TEST_INVOICE),
    isPaymentReminderTemplateApproved(),
  ]);
  return buildPaymentPreview(candidate, templateApproved);
}
