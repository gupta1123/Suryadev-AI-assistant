import { createHash } from 'node:crypto';
import {
  env,
  isMsg91Configured,
  isAllowedPaymentRecipient,
  isPaymentFollowUpRuntimeAllowed,
  isPaymentFollowUpTestConfigured,
  isSapConfigured,
  isSupabaseServiceConfigured,
} from '../../config/env.js';
import type { InvoiceCandidate, ValidationResult } from '../invoice-delivery/domain.js';
import { formatInvoiceAmount, formatInvoiceDate, formatPhone } from '../invoice-delivery/policy.js';
import type { AgingBucket, PaymentTestPreview, TestReceivable } from './domain.js';

export function automaticPaymentCycleId(invoiceJobId: number): string {
  if (!Number.isInteger(invoiceJobId) || invoiceJobId <= 0) {
    throw new Error('Invalid invoice job identifier for automatic payment follow-up');
  }
  return `automatic-invoice-job-${invoiceJobId}`;
}

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

export const PAYMENT_TERMS_DAYS = 3;

export function paymentDueDate(invoiceDate: string): string {
  const invoiceDay = Date.parse(`${invoiceDate}T00:00:00Z`);
  if (!Number.isFinite(invoiceDay)) throw new Error(`Invalid invoice date: ${invoiceDate}`);
  return new Date(invoiceDay + PAYMENT_TERMS_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// Aging depends on today's date, so it is derived whenever a receivable is read
// instead of trusting the value stored when the receivable was first written.
export function withCurrentAging<T extends { due_date?: unknown; outstanding_amount?: unknown }>(
  receivable: T,
  today = todayInIndia(),
): T & { aging_bucket: AgingBucket; days_overdue: number } {
  const outstandingAmount = Number(receivable.outstanding_amount ?? 0);
  const { bucket, daysOverdue } = receivable.due_date
    ? calculateAging(String(receivable.due_date), outstandingAmount, today)
    : { bucket: outstandingAmount > 0 ? 'upcoming' as const : 'closed' as const, daysOverdue: 0 };
  return { ...receivable, aging_bucket: bucket, days_overdue: daysOverdue };
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
  return createReceivable(candidate, {
    dueDate: paymentDueDate(candidate.billingDocumentDate),
    outstandingAmount: env.PAYMENT_TEST_OUTSTANDING_AMOUNT ?? candidate.totalGrossAmount,
  });
}

function createReceivable(
  candidate: InvoiceCandidate,
  input: { dueDate: string; outstandingAmount: number },
): TestReceivable {
  const outstandingAmount = input.outstandingAmount;
  const originalAmount = candidate.totalGrossAmount;
  const dueDate = input.dueDate;
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

export function buildSimulatedPaymentPreview(
  candidate: InvoiceCandidate,
  templateApproved: boolean,
  recipient: string,
): PaymentTestPreview {
  const receivable = createReceivable(candidate, {
    dueDate: paymentDueDate(candidate.billingDocumentDate),
    outstandingAmount: candidate.totalGrossAmount,
  });
  const validations: ValidationResult[] = [
    validation('controlled_runtime', 'Controlled test deployment is explicitly enabled', isPaymentFollowUpRuntimeAllowed),
    validation('test_mode', 'Controlled test mode is enabled', env.DELIVERY_MODE === 'test'),
    validation('payment_enabled', 'Payment follow-up is enabled', env.PAYMENT_FOLLOW_UP_ENABLED),
    validation('supabase_ready', 'Supabase audit storage is configured', isSupabaseServiceConfigured),
    validation('msg91_ready', 'MSG91 is configured', isMsg91Configured),
    validation('payment_send_enabled', 'Payment reminder sending is enabled for this controlled test', env.PAYMENT_FOLLOW_UP_SEND_ENABLED),
    validation('recipient_locked', 'Recipient is an approved payment test number', isAllowedPaymentRecipient(recipient)),
    validation('fixture_contact_matches', 'Generated invoice contact matches the recipient', candidate.contact.normalizedValue === recipient),
    validation('invoice_active', 'Generated invoice is not cancelled', !candidate.isCancelled),
    validation('currency_supported', 'Invoice currency is INR', candidate.currency === 'INR'),
    validation('amount_valid', 'Outstanding amount is positive and not above invoice total', receivable.outstandingAmount > 0 && receivable.outstandingAmount <= candidate.totalGrossAmount),
    validation('template_approved', 'MSG91 payment reminder template is approved', templateApproved),
  ];
  const formattedAmount = formatInvoiceAmount(receivable.outstandingAmount);
  return {
    mode: 'controlled_test',
    invoiceSource: 'fixture',
    receivableSource: 'test_fixture',
    candidate,
    receivable,
    recipient,
    maskedRecipient: formatPhone(recipient),
    template: {
      name: env.MSG91_PAYMENT_TEMPLATE_NAME,
      language: env.MSG91_PAYMENT_TEMPLATE_LANGUAGE,
      approved: templateApproved,
      message: `Hello ${candidate.customer.displayName}, payment of ₹${formattedAmount} is pending against invoice ${candidate.billingDocument} dated ${formatInvoiceDate(candidate.billingDocumentDate)}.`,
    },
    validations,
    sendAllowed: validations.every((item) => !item.blocking || item.passed),
    disclosure: 'Invoice and receivable data are generated for this controlled end-to-end test. WhatsApp delivery is real and restricted to the approved test number.',
  };
}

export function buildPaymentPreview(
  candidate: InvoiceCandidate,
  templateApproved: boolean,
): PaymentTestPreview {
  const receivable = createTestReceivable(candidate);
  const recipient = candidate.contact.normalizedValue ?? '';
  const validations: ValidationResult[] = [
    validation('controlled_runtime', 'Controlled test deployment is explicitly enabled', isPaymentFollowUpRuntimeAllowed),
    validation('test_mode', 'Controlled test mode is enabled', env.DELIVERY_MODE === 'test'),
    validation('payment_test_enabled', 'Payment follow-up controlled test is enabled', isPaymentFollowUpTestConfigured),
    validation('sap_read_ready', 'SAP read-only API is configured', isSapConfigured),
    validation('supabase_ready', 'Supabase audit storage is configured', isSupabaseServiceConfigured),
    validation('msg91_ready', 'MSG91 is configured', isMsg91Configured),
    validation('payment_send_enabled', 'Payment reminder sending is enabled for this controlled test', env.PAYMENT_FOLLOW_UP_SEND_ENABLED),
    validation('recipient_locked', 'SAP customer phone is an approved payment test number', isAllowedPaymentRecipient(recipient)),
    validation('customer_locked', 'SAP customer is the approved test customer', candidate.customer.customerNumber === env.PAYMENT_TEST_CUSTOMER),
    validation('invoice_locked', 'SAP invoice is the configured test invoice', candidate.billingDocument === env.PAYMENT_TEST_INVOICE),
    validation('invoice_active', 'SAP invoice is not cancelled', !candidate.isCancelled),
    validation('currency_supported', 'Invoice currency is INR', candidate.currency === 'INR'),
    validation('amount_valid', 'Outstanding amount is positive and not above invoice total', receivable.outstandingAmount > 0 && receivable.outstandingAmount <= candidate.totalGrossAmount),
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
    maskedRecipient: formatPhone(recipient),
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

export function assertAllowedPaymentRecipient(recipient: string): void {
  if (!isAllowedPaymentRecipient(recipient)) {
    throw new Error('Payment follow-up refused a recipient outside the approved payment test numbers');
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
