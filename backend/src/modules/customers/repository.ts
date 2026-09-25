import { HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatPhone } from '../invoice-delivery/policy.js';

const CUSTOMER_LIMIT = 500;

type Row = Record<string, unknown>;

/** Customer contact as shown in the dashboard: the full number, plus whether we can message it. */
function toContact(contact: Row) {
  const value = String(contact.normalized_value ?? contact.original_value ?? '');
  return {
    id: Number(contact.id),
    channel: String(contact.channel),
    label: (contact.label as string | null) ?? null,
    phone: formatPhone(value) || value,
    isPrimary: Boolean(contact.is_primary),
    isVerified: Boolean(contact.is_verified),
    isWhatsappCapable: (contact.is_whatsapp_capable as boolean | null) ?? null,
    consentStatus: String(contact.consent_status ?? 'unknown'),
    doNotContact: Boolean(contact.do_not_contact),
    isActive: Boolean(contact.is_active),
    validationError: (contact.validation_error as string | null) ?? null,
  };
}

function primaryWhatsapp(contacts: Row[]) {
  const whatsapp = contacts.filter((contact) => contact.channel === 'whatsapp' && contact.is_active !== false);
  const primary = whatsapp.find((contact) => contact.is_primary) ?? whatsapp[0];
  return primary ? toContact(primary) : null;
}

export async function listCustomers() {
  const client = getSupabaseServerClient();
  const { data: customers, error } = await client
    .from('customers')
    .select('id,sap_customer_number,display_name,legal_name,is_active,last_synced_at')
    .order('display_name', { ascending: true })
    .limit(CUSTOMER_LIMIT);
  if (error) throw new HttpError(500, 'Unable to load customers', error.message);
  if (!customers?.length) return [];

  const ids = customers.map((customer) => Number(customer.id));
  const [contactsResult, jobsResult, receivablesResult] = await Promise.all([
    client
      .from('customer_contacts')
      .select('id,customer_id,channel,label,original_value,normalized_value,is_primary,is_verified,is_whatsapp_capable,consent_status,do_not_contact,is_active,validation_error')
      .in('customer_id', ids),
    client
      .from('communication_jobs')
      .select('customer_id,status,created_at,messages(status)')
      .in('job_type', ['invoice_delivery', 'manual_resend'])
      .in('customer_id', ids),
    client
      .from('invoices')
      .select('sold_to_customer_id,invoice_receivables(outstanding_amount,currency,days_overdue)')
      .in('sold_to_customer_id', ids),
  ]);
  const firstError = contactsResult.error ?? jobsResult.error ?? receivablesResult.error;
  if (firstError) throw new HttpError(500, 'Unable to load customer details', firstError.message);

  const contactsBy = groupBy(contactsResult.data ?? [], 'customer_id');
  const jobsBy = groupBy(jobsResult.data ?? [], 'customer_id');
  const invoicesBy = groupBy(receivablesResult.data ?? [], 'sold_to_customer_id');

  return customers.map((customer) => {
    const id = Number(customer.id);
    const jobs = jobsBy.get(id) ?? [];
    const receivables = (invoicesBy.get(id) ?? []).flatMap((invoice) => asArray(invoice.invoice_receivables));
    const failed = jobs.filter((job) => messageStatus(job) === 'failed').length;
    return {
      id,
      sapCustomerNumber: customer.sap_customer_number ?? null,
      name: customer.display_name,
      legalName: customer.legal_name ?? null,
      isActive: Boolean(customer.is_active),
      whatsapp: primaryWhatsapp(contactsBy.get(id) ?? []),
      documentsSent: jobs.length,
      failedDocuments: failed,
      lastDocumentAt: jobs.map((job) => String(job.created_at ?? '')).sort().at(-1) || null,
      amountDue: receivables.reduce((sum, row) => sum + Number(row.outstanding_amount ?? 0), 0),
      overdueAmount: receivables
        .filter((row) => Number(row.days_overdue ?? 0) > 0)
        .reduce((sum, row) => sum + Number(row.outstanding_amount ?? 0), 0),
      currency: String(receivables[0]?.currency ?? 'INR'),
    };
  });
}

export async function getCustomer(customerId: number) {
  const client = getSupabaseServerClient();
  const { data: customer, error } = await client
    .from('customers')
    .select('id,sap_business_partner_id,sap_customer_number,display_name,legal_name,language_code,country_code,default_currency,is_active,last_synced_at')
    .eq('id', customerId)
    .maybeSingle();
  if (error) throw new HttpError(500, 'Unable to load customer', error.message);
  if (!customer) throw new HttpError(404, 'Customer not found');

  const [contactsResult, jobsResult, casesResult] = await Promise.all([
    client
      .from('customer_contacts')
      .select('id,customer_id,channel,label,original_value,normalized_value,is_primary,is_verified,is_whatsapp_capable,consent_status,do_not_contact,is_active,validation_error')
      .eq('customer_id', customerId)
      .order('is_primary', { ascending: false }),
    client
      .from('communication_jobs')
      .select('id,status,created_at,scheduled_at,last_error,metadata,invoices!communication_jobs_primary_invoice_id_fkey(sap_billing_document,billing_document_type,billing_document_date,transaction_currency,total_gross_amount),messages(status,sent_at,delivered_at,read_at,failed_at,failure_reason)')
      .in('job_type', ['invoice_delivery', 'manual_resend'])
      .eq('customer_id', customerId)
      .order('id', { ascending: false })
      .limit(200),
    client
      .from('invoices')
      .select('id,sap_billing_document,billing_document_date,transaction_currency,total_gross_amount,invoice_receivables(outstanding_amount,paid_amount,currency,due_date,payment_status,days_overdue),payment_follow_up_cases(id,status,next_action_at,last_reminder_at,resolved_at)')
      .eq('sold_to_customer_id', customerId)
      .order('billing_document_date', { ascending: false })
      .limit(200),
  ]);
  const firstError = contactsResult.error ?? jobsResult.error ?? casesResult.error;
  if (firstError) throw new HttpError(500, 'Unable to load customer history', firstError.message);

  const payments = (casesResult.data ?? []).flatMap((invoice) => {
    const receivable = asArray(invoice.invoice_receivables)[0];
    const paymentCase = asArray(invoice.payment_follow_up_cases)[0];
    if (!receivable && !paymentCase) return [];
    return [{
      caseId: paymentCase ? Number(paymentCase.id) : null,
      invoice: invoice.sap_billing_document,
      invoiceDate: invoice.billing_document_date,
      currency: String(receivable?.currency ?? invoice.transaction_currency ?? 'INR'),
      originalAmount: Number(invoice.total_gross_amount ?? 0),
      outstandingAmount: Number(receivable?.outstanding_amount ?? 0),
      dueDate: receivable?.due_date ?? null,
      daysOverdue: Number(receivable?.days_overdue ?? 0),
      paymentStatus: receivable?.payment_status ?? null,
      nextReminderAt: paymentCase?.next_action_at ?? null,
      resolved: Boolean(paymentCase?.resolved_at),
    }];
  });

  return {
    id: Number(customer.id),
    sapCustomerNumber: customer.sap_customer_number ?? null,
    sapBusinessPartnerId: customer.sap_business_partner_id ?? null,
    name: customer.display_name,
    legalName: customer.legal_name ?? null,
    languageCode: customer.language_code ?? null,
    countryCode: customer.country_code ?? null,
    isActive: Boolean(customer.is_active),
    lastSyncedAt: customer.last_synced_at ?? null,
    contacts: (contactsResult.data ?? []).map(toContact),
    documents: (jobsResult.data ?? []).map((job) => {
      const invoice = asArray(job.invoices)[0];
      const message = asArray(job.messages)[0];
      return {
        jobId: Number(job.id),
        document: invoice?.sap_billing_document ?? null,
        type: invoice?.billing_document_type ?? (job.metadata as Row | null)?.billing_document_type ?? null,
        documentDate: invoice?.billing_document_date ?? null,
        amount: invoice?.total_gross_amount ?? null,
        currency: invoice?.transaction_currency ?? 'INR',
        status: String(message?.status ?? job.status),
        sentAt: message?.sent_at ?? null,
        createdAt: job.created_at ?? job.scheduled_at ?? null,
        failureReason: message?.failure_reason ?? job.last_error ?? null,
      };
    }),
    payments,
  };
}

function messageStatus(job: Row): string {
  return String(asArray(job.messages)[0]?.status ?? job.status);
}

function asArray(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  return value && typeof value === 'object' ? [value as Row] : [];
}

function groupBy(rows: Row[], key: string): Map<number, Row[]> {
  const groups = new Map<number, Row[]>();
  for (const row of rows) {
    const id = Number(row[key]);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return groups;
}
