import { z } from 'zod';
import { env } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatPhone } from './policy.js';
import { HttpError } from '../../lib/http.js';
import { createInvoiceDocumentUrl, getDeliveryJobContextById } from './repository.js';

export const marketingCopyListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['pending', 'processing', 'accepted', 'failed', 'unknown']).optional(),
  kind: z.enum(['documents', 'reminders']).optional(),
  search: z.string().max(100).optional(),
  documentType: z.enum(['F2', 'S1', 'CBRE', 'G2', 'L2']).optional(),
  rangeDays: z.enum(['1', '7', '30', '90']).optional(),
});

export async function listMarketingCopies(input: z.infer<typeof marketingCopyListQuerySchema>) {
  let query = getSupabaseServerClient().from('marketing_whatsapp_copies').select(`
    id,source_job_id,recipient,status,attempt_count,accepted_at,last_error,created_at,
    source:communication_jobs!inner(id,job_type,payment_follow_up_case_id,
      customer:customers(display_name,sap_customer_number),
      invoice:invoices!communication_jobs_primary_invoice_id_fkey!inner(sap_billing_document,billing_document_type))
  `, { count: 'exact' });
  if (input.status) query = query.eq('status', input.status);
  if (input.kind === 'reminders') query = query.eq('source.job_type', 'payment_reminder');
  if (input.kind === 'documents') query = query.in('source.job_type', ['invoice_delivery', 'manual_resend']);
  if (input.documentType) query = query.eq('source.invoice.billing_document_type', input.documentType);
  if (input.rangeDays) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const start = new Date(`${date}T00:00:00+05:30`);
    start.setUTCDate(start.getUTCDate() - Number(input.rangeDays) + 1);
    query = query.gte('created_at', start.toISOString());
  }
  if (input.search) {
    const term = input.search.replace(/[^\p{L}\p{N} _-]/gu, '').trim();
    if (!term) query = query.eq('id', -1);
    else {
      const fields = ['body_1', 'body_var_1', 'body_2', 'body_var_2', 'body_3'];
      const filters = fields.map((field) => `payload->payload->template->to_and_components->0->components->${field}->>value.ilike.%${term}%`);
      const phone = term.replace(/\D/g, '');
      if (phone) filters.push(`recipient.ilike.%${phone}%`);
      query = query.or(filters.join(','));
    }
  }
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

export async function getMarketingCopyDetail(id: number) {
  const { data: row, error } = await getSupabaseServerClient().from('marketing_whatsapp_copies')
    .select('id,source_job_id,recipient,status,attempt_count,accepted_at,last_error,created_at,payload')
    .eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new HttpError(404, 'Marketing manager copy not found');
  const context = await getDeliveryJobContextById(Number(row.source_job_id));
  const template = row.payload?.payload?.template;
  const components = template?.to_and_components?.[0]?.components ?? {};
  const variables: Record<string, string> = {};
  for (const [key, component] of Object.entries(components)) {
    if (key.startsWith('body_') && component && typeof component === 'object' && 'value' in component) {
      variables[key.replace(/^body_(var_)?/, 'var_')] = String(component.value);
    }
  }
  let document: { fileName: string; url: string; downloadUrl: string } | null = null;
  if (components.header_1?.type === 'document') {
    const [preview, downloadUrl] = await Promise.all([
      getSupabaseServerClient().storage.from(context.document.storage_bucket)
        .createSignedUrl(context.document.storage_path, 3600),
      createInvoiceDocumentUrl(context),
    ]);
    if (preview.error || !preview.data) throw new Error('Unable to load manager copy PDF preview');
    document = { fileName: String(components.header_1.filename ?? context.document.file_name),
      url: preview.data.signedUrl, downloadUrl };
  }
  return {
    id: row.id, sourceJobId: row.source_job_id, recipient: formatPhone(row.recipient),
    status: row.status, attemptCount: row.attempt_count, acceptedAt: row.accepted_at,
    lastError: row.last_error, createdAt: row.created_at,
    customerName: variables.var_1 ?? context.customer.display_name,
    customerNumber: context.customer.sap_customer_number,
    documentNumber: context.invoice.sap_billing_document,
    documentType: context.invoice.billing_document_type,
    documentDate: context.invoice.billing_document_date,
    kind: context.job_type === 'payment_reminder' ? 'reminder' : 'document',
    templateName: template?.name ?? '', variables, document,
  };
}

function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}
