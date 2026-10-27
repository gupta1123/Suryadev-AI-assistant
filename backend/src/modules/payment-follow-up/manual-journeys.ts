import { z } from 'zod';
import { env, sapTmtMaterialIds, isMsg91Configured, isPaymentFollowUpSchedulerConfigured } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { HttpError } from '../../lib/http.js';
import { SapODataClient, escapeODataString } from '../invoice-delivery/sap-client.js';
import { SapInvoiceSource, combineSapDateAndTime, sapDateOnly } from '../invoice-delivery/sap-source.js';
import { persistInvoiceRecord } from '../invoice-delivery/repository.js';
import { listCustomerSettings } from '../messaging/repository.js';
import { documentDateBlocker } from '../messaging/document-date-policy.js';
import { materialItemsBlocker, readMaterialState, tmtMaterialBlocker } from '../messaging/tmt-materials.js';
import { assertDocumentSendAllowed } from '../messaging/guard.js';
import { getReminderSettings } from './settings.js';
import { paymentDueDate, todayInIndia } from './policy.js';
import { isPaymentReminderTemplateApproved } from '../invoice-delivery/msg91-client.js';

export const startJourneySchema = z.object({
  confirmedUnpaid: z.literal(true), outstandingAmount: z.number().finite().positive().multipleOf(0.01),
  expectedDueDays: z.number().int().min(1).max(90),
}).strict();

export async function listEligiblePaymentInvoices() {
  const client = getSupabaseServerClient();
  const [settings, rules, materialState, customers] = await Promise.all([
    listCustomerSettings(), getReminderSettings(true), readMaterialState(),
    client.from('customers').select('sap_customer_number,display_name').limit(10000),
  ]);
  if (customers.error || customers.data?.length === 10000) throw new Error('Unable to read customer names');
  const names = new Map((customers.data??[]).map(row=>[row.sap_customer_number,row.display_name]));
  const existing = new Map<string, {customers: unknown;payment_follow_up_cases: unknown;invoice_receivables: unknown}>();
  for (let offset=0; ; offset+=500) {
    if (offset>=10000) throw new Error('Existing invoice discovery exceeds its safety limit');
    const page = await client.from('invoices').select('id,sap_billing_document,customers!invoices_sold_to_customer_id_fkey(display_name),payment_follow_up_cases(id),invoice_receivables(payment_status,outstanding_amount)')
      .order('id').range(offset,offset+499);
    if (page.error) throw new Error('Unable to verify the complete existing journey list');
    for (const row of page.data ?? []) existing.set(row.sap_billing_document,row);
    if ((page.data?.length ?? 0)<500) break;
  }
  const sap = new SapODataClient();
  const eligible = [];
  for (const customer of settings.filter(row => row.enabled && row.approvedPhone && row.enabledAt)) {
    for (let skip = 0; ; skip += 500) {
      if (skip >= 10000) throw new Error('SAP invoice discovery exceeds its safety limit');
      const headers = await sap.collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocument', {
        filter: `SoldToParty eq '${escapeODataString(customer.sapCustomerNumber)}' and BillingDocumentType eq 'F2' and BillingDocumentDate ge datetime'2026-10-20T00:00:00'`,
        top: 500, skip, orderBy: 'BillingDocument asc',
      });
      for (const header of headers) {
        const number = String(header.BillingDocument);
        const prior = existing.get(number);
        const cases = prior?.payment_follow_up_cases;
        const balances = prior?.invoice_receivables as {payment_status:string;outstanding_amount:number} | {payment_status:string;outstanding_amount:number}[] | undefined;
        if (Array.isArray(cases) ? cases.length > 0 : Boolean(cases)) continue;
        const balance = Array.isArray(balances) ? balances[0] : balances;
        if (balance && (Number(balance.outstanding_amount) <= 0 || ['paid','written_off','cancelled'].includes(balance.payment_status))) continue;
        const date = sapDateOnly(header.BillingDocumentDate);
        const created = combineSapDateAndTime(header.CreationDate, header.CreationTime);
        if (documentDateBlocker({ documentDate: date, documentCreatedAt: created }, customer.enabledAt)) continue;
        const due = paymentDueDate(date, rules.dueDays);
        if (due > todayInIndia() || header.BillingDocumentIsCancelled === true || header.BillingDocumentIsCancelled === 'true' || header.CancelledBillingDocument || header.TransactionCurrency !== 'INR') continue;
        const items = await sap.collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocumentItem', { filter: `BillingDocument eq '${escapeODataString(number)}'`, top: 1000 });
        if (items.length >= 1000) throw new Error('Unable to inspect all material lines');
        if (materialItemsBlocker(items.map(row => ({ itemNumber: String(row.BillingDocumentItem), productId: String(row.Material ?? ''), rawData: row })), materialState)) continue;
        const name = Array.isArray(prior?.customers) ? prior.customers[0]?.display_name : (prior?.customers as { display_name?: string } | undefined)?.display_name;
        eligible.push({ invoiceNumber: number, customerNumber: customer.sapCustomerNumber, customerName: name ?? names.get(customer.sapCustomerNumber) ?? customer.sapCustomerNumber,
          invoiceDate: date, dueDate: due, dueDays: rules.dueDays, amount: Number(header.TotalGrossAmount), currency: String(header.TransactionCurrency),
          paymentStatus: 'unverified', recipient: customer.approvedPhone });
      }
      if (headers.length < 500) break;
    }
  }
  return [...new Map(eligible.map(row=>[row.invoiceNumber,row])).values()].sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
}

export async function startManualPaymentJourney(number: string, input: z.infer<typeof startJourneySchema>, username: string) {
  if (env.PAYMENT_JOURNEY_MODE !== 'manual' || !isPaymentFollowUpSchedulerConfigured || !isMsg91Configured || !env.PAYMENT_FOLLOW_UP_ENABLED || !env.PAYMENT_FOLLOW_UP_SEND_ENABLED || !env.MSG91_SEND_ENABLED) throw new HttpError(409, 'Manual payment reminder sending is not enabled on the server');
  if (!await isPaymentReminderTemplateApproved()) throw new HttpError(409, 'The WhatsApp payment-reminder template is not approved for the current sender');
  const rules = await getReminderSettings(true);
  if (rules.dueDays !== input.expectedDueDays) throw new HttpError(409, 'Due-day settings changed. Refresh the eligible list.');
  const candidate = await new SapInvoiceSource().get(number);
  if (candidate.billingDocumentType !== 'F2' || candidate.isCancelled || candidate.currency !== 'INR' || paymentDueDate(candidate.billingDocumentDate, rules.dueDays) > todayInIndia()) throw new HttpError(409, 'Invoice is cancelled, not due, or not an eligible INR invoice');
  if (input.outstandingAmount > candidate.totalGrossAmount) throw new HttpError(400, 'Outstanding balance cannot exceed the invoice total');
  const materialBlocker = await tmtMaterialBlocker(candidate.items);
  if (materialBlocker) throw new HttpError(409, materialBlocker);
  const recipient = candidate.contact.normalizedValue ?? '';
  const route = await assertDocumentSendAllowed({ source: 'sap', customerNumber: candidate.customer.customerNumber, recipient,
    documentDate: candidate.billingDocumentDate, documentCreatedAt: candidate.creationDateTime ?? null });
  if (route !== 'customer') throw new HttpError(409, 'A manual journey can only target this customer’s exact approved SAP phone');
  const client = getSupabaseServerClient();
  const invoice = await persistInvoiceRecord(client, candidate, 'sap');
  const contact = await client.from('customer_contacts').select('id').eq('id',invoice.contactId)
    .eq('is_active',true).eq('do_not_contact',false).eq('normalized_value',recipient).maybeSingle();
  if (contact.error || !contact.data) throw new HttpError(409,'The customer contact is inactive or marked do not contact');
  const { data, error } = await client.rpc('start_manual_payment_journey', {
    p_invoice_id: invoice.invoiceId, p_recipient: recipient, p_outstanding: input.outstandingAmount,
    p_rules: rules, p_default_materials: [...sapTmtMaterialIds], p_username: username,
  });
  if (error) throw new HttpError(error.code === 'PGRST202' ? 503 : 409, error.code === 'PGRST202' ? 'The manual payment journey SQL migration must be applied before starting journeys.' : error.message);
  return { caseId: Number(data) };
}
