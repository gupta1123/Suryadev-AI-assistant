import { createHash } from 'node:crypto';
import {
  env,
  isMsg91Configured,
  isPaymentFollowUpRuntimeAllowed,
  isPaymentFollowUpTestConfigured,
  isSapConfigured,
  isSupabaseServiceConfigured,
  paymentTestRecipient,
} from '../../config/env.js';
import type { InvoiceCandidate, ValidationResult } from '../invoice-delivery/domain.js';
import { formatInvoiceAmount, formatInvoiceDate, maskPhone } from '../invoice-delivery/policy.js';
import type { AgingBucket, PaymentTestPreview, TestReceivable } from './domain.js';

export const PAYMENT_HARD_TEST_RECIPIENT = '919765723830';

export function paymentReminderDelayMs(
  reminderCount: number,
  firstDelaySeconds: number,
  repeatDelaySeconds: number,
): number {
  return (reminderCount === 0 ? firstDelaySeconds : repeatDelaySeconds) * 1000;
}

export function todayInIndia(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function calculateAging(
  dueDate: string,
  outstandingAmount: number,
  today = todayInIndia(),
): { bucket: AgingBucket; daysOverdue: number } {
  if (outstandingAmount <= 0) return { bucket: 'closed', daysOverdue: 0 };
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  const daysOverdue = Math.max(0, Math.round((current - due) / 86_400_000));
  if (due > current) return { bucket: 'upcoming', daysOverdue: 0 };
  if (due === current) return { bucket: 'due', daysOverdue: 0 };
  if (daysOverdue >= 30) return { bucket: 'critical', daysOverdue };
  return { bucket: 'overdue', daysOverdue };
}

export function createTestReceivable(candidate: InvoiceCandidate): TestReceivable {
  const outstandingAmount = env.PAYMENT_TEST_OUTSTANDING_AMOUNT ?? candidate.totalGrossAmount;
  const originalAmount = candidate.totalGrossAmount;
  const dueDate = env.PAYMENT_TEST_DUE_DATE ?? '';
  const { bucket, daysOverdue } = calculateAging(dueDate, outstandingAmount);
  return {
    source: 'test_fixture',
    originalAmount,
    outstandingAmount,
    paidAmount: Math.max(0, originalAmount - outstandingAmount),
    currency: candidate.currency,
    dueDate,
    paymentStatus: outstandingAmount < originalAmount ? 'partially_paid' : 'open',
    agingBucket: bucket,
    daysOverdue,
  };
}

export function buildPaymentPreview(
  candidate: InvoiceCandidate,
  templateApproved: boolean,
): PaymentTestPreview {
  const receivable = createTestReceivable(candidate);
  const recipient = paymentTestRecipient;
  const validations: ValidationResult[] = [
    validation('controlled_runtime', 'Controlled test deployment is explicitly enabled', isPaymentFollowUpRuntimeAllowed),
    validation('test_mode', 'Controlled test mode is enabled', env.DELIVERY_MODE === 'test'),
    validation('payment_test_enabled', 'Payment follow-up controlled test is enabled', isPaymentFollowUpTestConfigured),
    validation('sap_read_ready', 'SAP read-only API is configured', isSapConfigured),
    validation('supabase_ready', 'Supabase audit storage is configured', isSupabaseServiceConfigured),
    validation('msg91_ready', 'MSG91 is configured', isMsg91Configured),
    validation('payment_send_enabled', 'Payment reminder sending is enabled for this controlled test', env.PAYMENT_FOLLOW_UP_SEND_ENABLED),
    validation('recipient_locked', 'Recipient is the single approved test number', recipient === PAYMENT_HARD_TEST_RECIPIENT),
    validation('customer_locked', 'SAP customer is the approved test customer', candidate.customer.customerNumber === env.PAYMENT_TEST_CUSTOMER),
    validation('invoice_locked', 'SAP invoice is the configured test invoice', candidate.billingDocument === env.PAYMENT_TEST_INVOICE),
    validation('sap_contact_matches', 'SAP customer phone matches the approved test number', candidate.contact.normalizedValue === PAYMENT_HARD_TEST_RECIPIENT),
    validation('invoice_active', 'SAP invoice is not cancelled', !candidate.isCancelled),
    validation('currency_supported', 'Invoice currency is INR', candidate.currency === 'INR'),
    validation('amount_valid', 'Outstanding amount is positive and not above invoice total', receivable.outstandingAmount > 0 && receivable.outstandingAmount <= candidate.totalGrossAmount),
    validation('due_today', 'Test receivable is due today', receivable.dueDate === todayInIndia()),
    validation('template_approved', 'MSG91 payment reminder template is approved', templateApproved),
  ];
  const formattedAmount = formatInvoiceAmount(receivable.outstandingAmount);
  return {
    mode: 'controlled_test',
    invoiceSource: 'sap',
    receivableSource: 'test_fixture',
    candidate,
    receivable,
    recipient,
    maskedRecipient: maskPhone(recipient),
    template: {
      name: env.MSG91_PAYMENT_TEMPLATE_NAME,
      language: env.MSG91_PAYMENT_TEMPLATE_LANGUAGE,
      approved: templateApproved,
      message: `Hello ${candidate.customer.displayName}, payment of ₹${formattedAmount} is pending against invoice ${candidate.billingDocument} dated ${formatInvoiceDate(candidate.billingDocumentDate)}.`,
    },
    validations,
    sendAllowed: validations.every((item) => !item.blocking || item.passed),
    disclosure: 'Invoice and customer details are read live from SAP QAS. Payment status, outstanding amount and due date are controlled test data because the SAP receivables API is not authorized.',
  };
}

export function createPaymentReminderIdempotencyKey(input: {
  billingDocument: string;
  dueDate: string;
  recipient: string;
  stageCode: string;
}): string {
  const recipientHash = createHash('sha256').update(input.recipient).digest('hex').slice(0, 16);
  return `payment_reminder:${input.billingDocument}:${input.dueDate}:${input.stageCode}:v1:whatsapp:${recipientHash}`;
}

export function createScheduledPaymentReminderIdempotencyKey(input: {
  billingDocument: string;
  scheduledFor: string;
  recipient: string;
  reminderNumber: number;
}): string {
  const recipientHash = createHash('sha256').update(input.recipient).digest('hex').slice(0, 16);
  const scheduleHash = createHash('sha256').update(input.scheduledFor).digest('hex').slice(0, 16);
  return `payment_reminder:${input.billingDocument}:repeat-${input.reminderNumber}:${scheduleHash}:v1:whatsapp:${recipientHash}`;
}

export function assertHardPaymentRecipient(recipient: string): void {
  if (recipient !== PAYMENT_HARD_TEST_RECIPIENT) {
    throw new Error('Payment follow-up refused a recipient outside the single controlled test number');
  }
}

function validation(
  code: string,
  label: string,
  passed: boolean,
  blocking = true,
): ValidationResult {
  return { code, label, passed, blocking };
}
