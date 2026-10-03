import {
  env,
} from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatInvoiceAmount, formatInvoiceDate } from './policy.js';
import { getHelpRequestAlertSettings } from './help-settings.js';

export type HelpRequestAlertDetails = {
  customerName: string;
  customerNumber: string;
  billingDocument: string;
  billingDocumentDate: string;
  formattedAmount: string;
  requestedAt: string;
};

export type HelpRequestNotification = {
  id: number;
  reviewTaskId: number;
  recipient: string;
  templateName: string;
  templateLanguage: string;
  status: 'pending' | 'processing' | 'sent' | 'failed';
  attemptCount: number;
  maxAttempts: number;
  details: HelpRequestAlertDetails;
};

export async function enqueueHelpRequestAlert(input: {
  reviewTaskId: number;
  customerId: number;
  invoiceId: number;
  requestedAt: string;
}): Promise<void> {
  if (!env.MSG91_HELP_REQUEST_ALERT_ENABLED) return;
  const alertSettings = await getHelpRequestAlertSettings();
  if (!alertSettings.recipient) {
    throw new Error('Help request alert recipient is not configured');
  }

  const client = getSupabaseServerClient();
  const [customerResult, invoiceResult] = await Promise.all([
    client
      .from('customers')
      .select('display_name,sap_customer_number')
      .eq('id', input.customerId)
      .single(),
    client
      .from('invoices')
      .select('sap_billing_document,billing_document_date,transaction_currency,total_gross_amount')
      .eq('id', input.invoiceId)
      .single(),
  ]);
  if (customerResult.error || !customerResult.data) {
    throw new Error(customerResult.error?.message ?? 'Help request customer was not found');
  }
  if (invoiceResult.error || !invoiceResult.data) {
    throw new Error(invoiceResult.error?.message ?? 'Help request invoice was not found');
  }

  const customer = customerResult.data;
  const invoice = invoiceResult.data;
  const amount = invoice.total_gross_amount == null
    ? 'Not available'
    : `${String(invoice.transaction_currency || 'INR')} ${formatInvoiceAmount(Number(invoice.total_gross_amount))}`;
  const details: HelpRequestAlertDetails = {
    customerName: String(customer.display_name),
    customerNumber: customer.sap_customer_number
      ? String(customer.sap_customer_number)
      : 'Not available',
    billingDocument: String(invoice.sap_billing_document),
    billingDocumentDate: invoice.billing_document_date
      ? formatInvoiceDate(String(invoice.billing_document_date))
      : 'Not available',
    formattedAmount: amount,
    requestedAt: formatHelpRequestAlertDateTime(input.requestedAt),
  };

  const { error } = await client
    .from('help_request_notifications')
    .upsert(
      {
        review_task_id: input.reviewTaskId,
        recipient: alertSettings.recipient,
        template_name: env.MSG91_HELP_REQUEST_TEMPLATE_NAME,
        template_language: env.MSG91_HELP_REQUEST_TEMPLATE_LANGUAGE,
        details,
      },
      {
        onConflict: 'review_task_id',
        ignoreDuplicates: true,
      },
    );
  if (error) throw new Error(`Unable to queue the help request alert: ${error.message}`);
}

export async function claimNextHelpRequestAlert(
  workerName: string,
): Promise<HelpRequestNotification | null> {
  const { data, error } = await getSupabaseServerClient().rpc(
    'claim_next_help_request_notification',
    { worker_name: workerName },
  );
  if (error) throw new Error(`Unable to claim a help request alert: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ? parseHelpRequestNotification(row) : null;
}

export async function releaseStaleHelpRequestAlerts(staleBefore: Date): Promise<void> {
  const { error } = await getSupabaseServerClient()
    .from('help_request_notifications')
    .update({
      status: 'pending',
      next_attempt_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: 'Recovered after the previous alert worker stopped unexpectedly',
    })
    .eq('status', 'processing')
    .lt('locked_at', staleBefore.toISOString());
  if (error) throw new Error(`Unable to release stale help request alerts: ${error.message}`);
}

export async function deferHelpRequestAlert(
  notification: HelpRequestNotification,
  message: string,
  input: { delayMs: number; preserveAttempt?: boolean },
): Promise<void> {
  const { error } = await getSupabaseServerClient()
    .from('help_request_notifications')
    .update({
      status: 'pending',
      next_attempt_at: new Date(Date.now() + input.delayMs).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: message.slice(0, 2_000),
      ...(input.preserveAttempt
        ? { attempt_count: Math.max(notification.attemptCount - 1, 0) }
        : {}),
    })
    .eq('id', notification.id)
    .eq('status', 'processing');
  if (error) throw new Error(`Unable to defer the help request alert: ${error.message}`);
}

export async function markHelpRequestAlertSent(
  notificationId: number,
  input: { providerRequestId?: string; providerMessageId?: string },
): Promise<void> {
  const { error } = await getSupabaseServerClient()
    .from('help_request_notifications')
    .update({
      status: 'sent',
      provider_request_id: input.providerRequestId ?? null,
      provider_message_id: input.providerMessageId ?? null,
      sent_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq('id', notificationId)
    .eq('status', 'processing');
  if (error) throw new Error(`Unable to complete the help request alert: ${error.message}`);
}

export async function markHelpRequestAlertFailed(
  notification: HelpRequestNotification,
  message: string,
  terminal = false,
): Promise<void> {
  const failed = terminal || notification.attemptCount >= notification.maxAttempts;
  const { error } = await getSupabaseServerClient()
    .from('help_request_notifications')
    .update({
      status: failed ? 'failed' : 'pending',
      next_attempt_at: failed
        ? new Date().toISOString()
        : helpRequestAlertRetryAt(notification.attemptCount).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: message.slice(0, 2_000),
    })
    .eq('id', notification.id)
    .eq('status', 'processing');
  if (error) throw new Error(`Unable to record the help request alert failure: ${error.message}`);
}

export function parseHelpRequestAlertDetails(value: unknown): HelpRequestAlertDetails {
  if (!isRecord(value)) throw new Error('Help request alert details are missing');
  return {
    customerName: requiredText(value.customerName, 'customer name'),
    customerNumber: requiredText(value.customerNumber, 'customer number'),
    billingDocument: requiredText(value.billingDocument, 'billing document'),
    billingDocumentDate: requiredText(value.billingDocumentDate, 'billing document date'),
    formattedAmount: requiredText(value.formattedAmount, 'formatted amount'),
    requestedAt: requiredText(value.requestedAt, 'request time'),
  };
}

export function formatHelpRequestAlertDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function helpRequestAlertRetryAt(
  attemptCount: number,
  now = new Date(),
): Date {
  const delayMinutes = Math.min(2 ** Math.max(attemptCount - 1, 0), 60);
  return new Date(now.getTime() + delayMinutes * 60_000);
}

function parseHelpRequestNotification(value: unknown): HelpRequestNotification {
  if (!isRecord(value)) throw new Error('Invalid help request notification row');
  const status = String(value.status);
  if (!['pending', 'processing', 'sent', 'failed'].includes(status)) {
    throw new Error(`Invalid help request notification status: ${status}`);
  }
  return {
    id: Number(value.id),
    reviewTaskId: Number(value.review_task_id),
    recipient: requiredText(value.recipient, 'recipient'),
    templateName: requiredText(value.template_name, 'template name'),
    templateLanguage: requiredText(value.template_language, 'template language'),
    status: status as HelpRequestNotification['status'],
    attemptCount: Number(value.attempt_count),
    maxAttempts: Number(value.max_attempts),
    details: parseHelpRequestAlertDetails(value.details),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Help request alert ${label} is missing`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
