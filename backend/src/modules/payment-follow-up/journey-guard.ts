import { getSupabaseServerClient } from '../../lib/supabase.js';
import { assertDocumentSendAllowed } from '../messaging/guard.js';
import { assertInvoiceTmtAllowed } from '../messaging/tmt-materials.js';
import { SapODataClient, escapeODataString } from '../invoice-delivery/sap-client.js';
import { paymentDueDate, todayInIndia } from './policy.js';
import { journeySettings, defaultReminderSettings } from './settings.js';

/** Fresh database + SAP gates. A job's manual flag alone is never permission. */
export async function assertManualJourneyAllowed(caseId: number, invoiceId: number, recipient: string, cycleId: string, amount?: number): Promise<void> {
  const client = getSupabaseServerClient();
  const [caseResult, balanceResult, invoiceResult] = await Promise.all([
    client.from('payment_follow_up_cases').select('id,invoice_id,status,resolved_at').eq('id',caseId).single(),
    client.from('invoice_receivables').select('outstanding_amount,payment_status,due_date,raw_data').eq('invoice_id',invoiceId).single(),
    client.from('invoices').select('id,sold_to_customer_id,sap_billing_document,billing_document_type,billing_document_date,creation_datetime,is_cancelled,customers(sap_customer_number)').eq('id',invoiceId).single(),
  ]);
  if (caseResult.error || balanceResult.error || invoiceResult.error) throw new Error('Unable to verify the current manual journey; sending is blocked');
  const paymentCase = caseResult.data, balance = balanceResult.data, invoice = invoiceResult.data;
  const raw = balance.raw_data ?? {};
  if (paymentCase.invoice_id !== invoiceId || paymentCase.status !== 'active' || paymentCase.resolved_at ||
    raw.manual_payment_journey !== true || Number(raw.journey_case_id) !== caseId || raw.payment_test_cycle_id !== cycleId ||
    raw.approved_recipient !== recipient || !raw.journey_settings || raw.source !== 'user_confirmed') throw new Error('Manual journey is stopped, paid, or no longer matches this reminder');
  if (['paid','cancelled','written_off','disputed'].includes(balance.payment_status) || Number(balance.outstanding_amount) <= 0 ||
    (amount !== undefined && Number(balance.outstanding_amount) !== amount)) throw new Error('Outstanding balance changed or invoice is closed; sending is blocked');
  const rules = journeySettings(raw, defaultReminderSettings());
  if (balance.due_date !== paymentDueDate(invoice.billing_document_date, rules.dueDays) || balance.due_date > todayInIndia()) throw new Error('Invoice is not due under this journey’s frozen rules');
  if (invoice.billing_document_type !== 'F2' || invoice.is_cancelled) throw new Error('Invoice is cancelled or unsupported');
  const customer = Array.isArray(invoice.customers) ? invoice.customers[0] : invoice.customers;
  if (!customer?.sap_customer_number) throw new Error('Invoice customer is missing');
  const live = await new SapODataClient().collection('API_BILLING_DOCUMENT_SRV','A_BillingDocument', {
    filter: `BillingDocument eq '${escapeODataString(invoice.sap_billing_document)}'`, top: 1,
  });
  const header = live[0];
  if (!header || header.BillingDocumentIsCancelled === true || header.BillingDocumentIsCancelled === 'true' || header.CancelledBillingDocument ||
    String(header.SoldToParty) !== customer.sap_customer_number) throw new Error('SAP invoice is missing, cancelled, or belongs to another customer');
  const route = await assertDocumentSendAllowed({ source:'sap',customerNumber:customer.sap_customer_number,recipient,
    documentDate:invoice.billing_document_date,documentCreatedAt:invoice.creation_datetime });
  if (route !== 'customer') throw new Error('Manual reminder must target the customer’s exact approved phone');
  await assertInvoiceTmtAllowed(invoiceId);
  const contact = await client.from('customer_contacts').select('id').eq('customer_id',invoice.sold_to_customer_id)
    .eq('channel','whatsapp').eq('normalized_value',recipient).eq('is_active',true).eq('do_not_contact',false).maybeSingle();
  if (contact.error || !contact.data) throw new Error('Customer contact is inactive or marked do not contact');
  // SAP requests may be slow: re-read stop/payment status afterwards too.
  const latest = await client.from('payment_follow_up_cases').select('status,resolved_at').eq('id',caseId).single();
  const current = await client.from('invoice_receivables').select('payment_status,outstanding_amount').eq('invoice_id',invoiceId).single();
  if (latest.error || current.error || latest.data.status !== 'active' || latest.data.resolved_at ||
    current.data.payment_status !== balance.payment_status || Number(current.data.outstanding_amount) !== Number(balance.outstanding_amount)) throw new Error('Journey or payment status changed during validation; sending is blocked');
}
