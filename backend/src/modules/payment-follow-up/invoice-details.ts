import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { SapODataClient, escapeODataString } from '../invoice-delivery/sap-client.js';
import { combineSapDateAndTime } from '../invoice-delivery/sap-source.js';
import { documentDateBlocker } from '../messaging/document-date-policy.js';
import { resolveManagerCopyRecipients } from '../messaging/guard.js';
import { getCustomerSetting } from '../messaging/repository.js';
import { materialEnabled, readMaterialState } from '../messaging/tmt-materials.js';
import { paymentDueDate, todayInIndia } from './policy.js';
import { getReminderSettings } from './settings.js';
import { cachedEligibleRow, wasDeliveredToCustomer } from './manual-journeys.js';
import { sapFactsFromHeader, type PaymentState, type SapInvoiceFacts } from './payment-status.js';

// Read-only. Everything here is looked up for display; nothing is written and nothing is sent.

export { paymentStateFromSap, type PaymentState } from './payment-status.js';
export type CheckState = 'pass' | 'fail' | 'warn' | 'unknown';

type Row = Record<string, unknown>;
const many = (value: unknown): Row[] => (Array.isArray(value) ? value : value ? [value] : []) as Row[];
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());
const last4 = (value: unknown): string | null => { const digits = text(value).replace(/\D/g, ''); return digits.length >= 4 ? digits.slice(-4) : null; };

export type InvoiceLine = { number: string; productId: string; description: string | null; quantity: number | null; unit: string | null; amount: number | null; batches: string[] };

const isZero = (value: unknown) => value === null || value === undefined || Number(value) === 0;

/**
 * SAP splits a product over several steel batches by adding one row per batch with no quantity and no
 * price. Those rows are folded into the product line above them, and their batch numbers are kept.
 * A zero row with no matching product line before it stays visible as its own line.
 */
export function groupInvoiceLines(rows: Row[]): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const sorted = [...rows].sort((a, b) => Number(text(a.sap_item_number)) - Number(text(b.sap_item_number)));
  for (const row of sorted) {
    const productId = text(row.product_id);
    const batch = text(row.batch);
    const previous = lines[lines.length - 1];
    if (previous && isZero(row.quantity) && isZero(row.net_amount) && previous.productId === productId) {
      if (batch && !previous.batches.includes(batch)) previous.batches.push(batch);
      continue;
    }
    lines.push({
      number: text(row.sap_item_number), productId, description: text(row.description) || null,
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      unit: text(row.quantity_unit) || null,
      amount: row.net_amount === null || row.net_amount === undefined ? null : Number(row.net_amount),
      batches: batch ? [batch] : [],
    });
  }
  return lines;
}

export function daysPastDue(dueDate: string, today = todayInIndia()): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
}

const INVOICE_COLUMNS = 'id,sap_billing_document,billing_document_date,creation_datetime,total_gross_amount,transaction_currency,'
  + 'customers!invoices_sold_to_customer_id_fkey(display_name,sap_customer_number),'
  + 'invoice_items(sap_item_number,product_id,description,quantity,quantity_unit,net_amount,tax_amount,batch:raw_data->>Batch),'
  + 'communication_jobs!communication_jobs_primary_invoice_id_fkey(job_type,status,created_at,metadata,messages(status,sent_at,delivered_at,read_at))';

async function readInvoice(number: string): Promise<Row> {
  const found = await getSupabaseServerClient().from('invoices').select(INVOICE_COLUMNS).eq('sap_billing_document', number).maybeSingle();
  if (found.error) throw new Error('Unable to read this invoice');
  if (!found.data) throw new HttpError(404, `Invoice ${number} was not found`);
  return found.data as unknown as Row;
}

async function readSapHeaderFacts(number: string): Promise<SapInvoiceFacts | null> {
  const header = await new SapODataClient().collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocument', { filter: `BillingDocument eq '${escapeODataString(number)}'`, top: 1 })
    .then((rows) => rows[0] as Row | undefined).catch(() => null);
  return header ? sapFactsFromHeader(header, combineSapDateAndTime(header.CreationDate, header.CreationTime)) : null;
}

export async function getEligibleInvoiceDetails(number: string) {
  // The eligible list already read this invoice's SAP header, so reuse it. Only an invoice that is
  // not in a recent list pays for a SAP call, and then it runs alongside the database reads.
  const listed = cachedEligibleRow(number);
  const [invoice, sapFacts, setting, rules, materials] = await (async () => {
    if (listed) {
      return Promise.all([readInvoice(number), Promise.resolve<SapInvoiceFacts | null>(listed.sap), getCustomerSetting(listed.customerNumber), getReminderSettings(), readMaterialState()]);
    }
    const invoiceRow = await readInvoice(number);
    const number_ = text(many(invoiceRow.customers)[0]?.sap_customer_number);
    return Promise.all([Promise.resolve(invoiceRow), readSapHeaderFacts(number), getCustomerSetting(number_), getReminderSettings(), readMaterialState()]);
  })();
  const owner = many(invoice.customers)[0] ?? {};
  const customerNumber = text(owner.sap_customer_number);

  const invoiceDate = text(invoice.billing_document_date).slice(0, 10);
  const dueDate = paymentDueDate(invoiceDate, rules.dueDays);
  const today = todayInIndia();

  const items = groupInvoiceLines(many(invoice.invoice_items))
    .map((line) => ({ ...line, enabled: materialEnabled(materials, line.productId) }));
  const offProducts = [...new Set(items.filter((item) => !item.enabled).map((item) => item.productId || '(missing code)'))];

  const jobs = many(invoice.communication_jobs);
  const deliveryJobs = jobs.filter((job) => ['invoice_delivery', 'manual_resend'].includes(text(job.job_type)))
    .sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
  const delivered = wasDeliveredToCustomer(jobs);
  const best = deliveryJobs.find((job) => wasDeliveredToCustomer([job])) ?? deliveryJobs[0];
  const message = many(best?.messages)[0];
  const meta = (best?.metadata && typeof best.metadata === 'object' ? best.metadata : {}) as Row;
  const delivery = {
    delivered, status: message ? text(message.status) || null : null,
    sentAt: text(message?.sent_at) || null, deliveredAt: text(message?.delivered_at) || null, readAt: text(message?.read_at) || null,
    toLast4: last4(meta.actual_recipient), attempts: deliveryJobs.length,
  };

  const payment = sapFacts
    ? { state: sapFacts.state, label: sapFacts.label, clearingStatus: sapFacts.clearingStatus, paymentTerms: sapFacts.paymentTerms }
    : { state: 'unavailable' as PaymentState, label: 'SAP could not be reached just now', clearingStatus: null, paymentTerms: null };

  const dateRefusal = documentDateBlocker({ documentDate: invoiceDate, documentCreatedAt: text(invoice.creation_datetime) || null }, setting?.enabledAt ?? null);
  const enabled = Boolean(setting?.enabled && setting.approvedPhone && setting.enabledAt);
  const check = (key: string, label: string, state: CheckState, detail: string) => ({ key, label, state, detail });
  const checks = [
    check('customer', 'Customer is enabled', enabled ? 'pass' : 'fail', enabled ? `Enabled for messages to a number ending ${last4(setting!.approvedPhone) ?? '----'}` : 'Not enabled in Settings'),
    check('created', 'Invoice was created after the customer was enabled', dateRefusal ? 'fail' : 'pass', dateRefusal ?? 'Created after the customer was enabled and on or after 20 Oct 2026'),
    check('delivered', 'Invoice was delivered to the customer on WhatsApp', delivered ? 'pass' : 'fail', delivered ? 'Sent and accepted by WhatsApp' : 'Not delivered by this app'),
    check('products', 'Every product on the invoice is On', items.length === 0 ? 'unknown' : offProducts.length ? 'fail' : 'pass',
      items.length === 0 ? 'No product lines are stored for this invoice' : offProducts.length ? `Off or not approved: ${offProducts.join(', ')}` : `${items.length} product ${items.length === 1 ? 'line' : 'lines'}, all On`),
    check('type', 'Standard invoice, in INR, not cancelled', !sapFacts ? 'unknown' : sapFacts.documentType === 'F2' && sapFacts.currency === 'INR' && payment.state !== 'cancelled' ? 'pass' : 'fail',
      !sapFacts ? 'SAP could not be reached just now' : `Type ${sapFacts.documentType ?? '?'}, ${sapFacts.currency ?? '?'}${payment.state === 'cancelled' ? ', cancelled' : ''}`),
    check('due', 'Due date has arrived', dueDate <= today ? 'pass' : 'fail', `Invoice date + ${rules.dueDays} days = ${dueDate}`),
    check('payment', 'SAP does not show it as paid', payment.state === 'paid' ? 'fail' : payment.state === 'partly_paid' ? 'warn' : payment.state === 'not_paid' ? 'pass' : 'unknown',
      payment.state === 'paid' ? 'SAP shows this invoice as fully paid. A reminder would be wrong.'
        : payment.state === 'partly_paid' ? 'Partly paid in SAP. The reminder would still quote the amount you enter.'
        : payment.state === 'not_paid' ? 'SAP shows it as not paid' : payment.label),
  ];

  return {
    invoiceNumber: number, customerName: text(owner.display_name) || customerNumber, customerNumber,
    invoiceDate, createdAt: sapFacts?.createdAt ?? (text(invoice.creation_datetime) || null),
    amount: Number(invoice.total_gross_amount), currency: text(invoice.transaction_currency) || 'INR',
    dueDate, dueDays: rules.dueDays, daysPastDue: daysPastDue(dueDate, today),
    payment, delivery, items,
    reminders: {
      firstDelaySeconds: rules.firstReminderDelaySeconds, repeatDelaySeconds: rules.repeatReminderDelaySeconds,
      maximum: rules.maximumReminders, toLast4: last4(setting?.approvedPhone),
    },
    checks,
  };
}

export type EligibleInvoiceDetails = Awaited<ReturnType<typeof getEligibleInvoiceDetails>>;

// Managers come from a live SAP lookup, the slowest part, so the panel asks for them separately and
// shows everything else first. A display copy is kept for a minute per customer; real sends never use it.
const MANAGER_PREVIEW_MS = 60_000;
const managerPreviews = new Map<string, { at: number; value: ManagerPreview }>();
export type ManagerPreview = { enabled: boolean; last4: string[]; reason: string | null };

export async function getManagerPreview(number: string): Promise<ManagerPreview> {
  if (!env.MSG91_MARKETING_COPY_ENABLED) return { enabled: false, last4: [], reason: 'Manager copies are switched off' };
  const customerNumber = cachedEligibleRow(number)?.customerNumber
    ?? text(many((await readInvoice(number)).customers)[0]?.sap_customer_number);
  const cached = managerPreviews.get(customerNumber);
  if (cached && Date.now() - cached.at < MANAGER_PREVIEW_MS) return cached.value;
  const result = await resolveManagerCopyRecipients(customerNumber).catch(() => ({ recipients: [] as string[], reason: 'Could not read the managers from SAP right now' }));
  const value: ManagerPreview = { enabled: true, last4: result.recipients.map(last4).filter((digits): digits is string => Boolean(digits)), reason: result.reason ?? null };
  // A failed lookup is not remembered, so the next click tries again.
  if (!value.reason || !/could not read|unavailable/i.test(value.reason)) managerPreviews.set(customerNumber, { at: Date.now(), value });
  return value;
}
