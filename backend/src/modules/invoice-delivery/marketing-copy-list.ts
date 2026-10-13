import { z } from 'zod';
import { env } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatPhone } from './policy.js';

export const marketingCopyListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['pending', 'processing', 'accepted', 'failed', 'unknown']).optional(),
  kind: z.enum(['documents', 'reminders']).optional(),
});

export async function listMarketingCopies(input: z.infer<typeof marketingCopyListQuerySchema>) {
  let query = getSupabaseServerClient().from('marketing_whatsapp_copies').select(`
    id,source_job_id,recipient,status,attempt_count,accepted_at,last_error,created_at,
    source:communication_jobs!inner(id,job_type,payment_follow_up_case_id,
      customer:customers(display_name,sap_customer_number),
      invoice:invoices!communication_jobs_primary_invoice_id_fkey(sap_billing_document,billing_document_type))
  `, { count: 'exact' });
  if (input.status) query = query.eq('status', input.status);
  if (input.kind === 'reminders') query = query.eq('source.job_type', 'payment_reminder');
  if (input.kind === 'documents') query = query.in('source.job_type', ['invoice_delivery', 'manual_resend']);
  const start = (input.page - 1) * input.pageSize;
  const { data, error, count } = await query.order('id', { ascending: false }).range(start, start + input.pageSize - 1);
  if (error) throw new Error(`Unable to load marketing manager copies: ${error.message}`);
  const items = (data ?? []).map((row) => {
    const source = one(row.source);
    const customer = one(source?.customer);
    const invoice = one(source?.invoice);
    return {
      id: row.id, sourceJobId: row.source_job_id, recipient: formatPhone(row.recipient),
      status: row.status, attemptCount: row.attempt_count,
      acceptedAt: row.accepted_at, lastError: row.last_error, createdAt: row.created_at,
      customerName: customer?.display_name ?? 'Customer unavailable',
      customerNumber: customer?.sap_customer_number ?? null,
      documentNumber: invoice?.sap_billing_document ?? null,
      documentType: invoice?.billing_document_type ?? null,
      kind: source?.job_type === 'payment_reminder' ? 'reminder' : 'document',
      sourcePath: source?.job_type === 'payment_reminder'
        ? source.payment_follow_up_case_id ? `/payments/${source.payment_follow_up_case_id}` : null
        : `/documents/${row.source_job_id}`,
    };
  });
  return {
    items, total: count ?? 0, page: input.page, pageSize: input.pageSize,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / input.pageSize)),
    enabled: env.MSG91_MARKETING_COPY_ENABLED,
    recipient: formatPhone(env.MSG91_MARKETING_COPY_RECIPIENT),
  };
}

function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}
