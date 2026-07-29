import { createHash } from 'node:crypto';
import {
  digitsOnly,
  env,
  isMsg91Configured,
  isSupabaseServiceConfigured,
  whatsappTestRecipients,
} from '../../config/env.js';
import type {
  InvoiceCandidate,
  InvoicePreview,
  ValidationResult,
} from './domain.js';

export function buildInvoicePreview(
  candidate: InvoiceCandidate,
  requestedRecipient: string,
): InvoicePreview {
  const recipient = digitsOnly(requestedRecipient);
  const validations: ValidationResult[] = [
    validation('invoice_active', 'Invoice is not cancelled', !candidate.isCancelled),
    validation('customer_present', 'Customer information is available', Boolean(candidate.customer.displayName)),
    validation('pdf_present', 'Invoice PDF is available', candidate.pdf.base64.length > 0),
    validation('currency_supported', 'Template currency is INR', candidate.currency === 'INR'),
    validation('recipient_valid', 'Test recipient is a valid E.164 number', /^[1-9]\d{7,14}$/.test(recipient)),
    validation(
      'recipient_allowlisted',
      'Recipient is included in the test allowlist',
      env.DELIVERY_MODE !== 'test' || whatsappTestRecipients.has(recipient),
    ),
    validation('supabase_service', 'Supabase worker access is configured', isSupabaseServiceConfigured),
    validation('msg91_configured', 'MSG91 credentials are configured', isMsg91Configured),
    validation('sending_enabled', 'Real WhatsApp sending is enabled', env.MSG91_SEND_ENABLED),
    validation('fixture_mode', 'SAP source is fixture-only', env.INVOICE_SOURCE === 'fixture'),
  ];

  const formattedAmount = formatInvoiceAmount(candidate.totalGrossAmount);
  return {
    source: 'fixture',
    fixtureId: candidate.fixtureId,
    fixtureLabel: candidate.fixtureLabel,
    invoice: {
      billingDocument: candidate.billingDocument,
      billingDocumentDate: candidate.billingDocumentDate,
      customerName: candidate.customer.displayName,
      customerNumber: candidate.customer.customerNumber,
      fixtureContact: maskPhone(candidate.contact.normalizedValue),
      currency: candidate.currency,
      totalGrossAmount: candidate.totalGrossAmount,
      itemCount: candidate.items.length,
      pdfFileName: candidate.pdf.fileName,
    },
    actualRecipient: recipient,
    maskedRecipient: maskPhone(recipient),
    template: {
      name: env.MSG91_TEMPLATE_NAME,
      language: env.MSG91_TEMPLATE_LANGUAGE,
      variables: {
        var_1: candidate.customer.displayName,
        var_2: candidate.billingDocument,
        var_3: formatInvoiceDate(candidate.billingDocumentDate),
        var_4: formattedAmount,
        var_5: env.MSG91_TEMPLATE_TEAM_NAME,
      },
    },
    validations,
    sendAllowed: validations.every((item) => !item.blocking || item.passed),
  };
}

export function createDeliveryIdempotencyKey(
  candidate: InvoiceCandidate,
  recipient: string,
): string {
  const recipientHash = createHash('sha256').update(recipient).digest('hex').slice(0, 16);
  return `invoice_delivery:${candidate.billingDocument}:v1:whatsapp:${recipientHash}`;
}

export function formatInvoiceAmount(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatInvoiceDate(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

export function maskPhone(value: string): string {
  if (value.length < 5) return value ? '••••' : '';
  return `${value.slice(0, 2)}••••••${value.slice(-4)}`;
}

function validation(
  code: string,
  label: string,
  passed: boolean,
  blocking = true,
): ValidationResult {
  return { code, label, passed, blocking };
}
