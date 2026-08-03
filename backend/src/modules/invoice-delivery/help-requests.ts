import { getSupabaseServerClient } from '../../lib/supabase.js';

export type InvoiceResponseType = 'received' | 'needs_help';

export type ParsedInvoiceButtonResponse = {
  responseType: InvoiceResponseType;
  buttonText: string;
  buttonPayload: string;
  replyMessageId: string;
  inboundMessageId: string;
  customerNumber?: string;
  receivedAt: string;
};

export type HelpRequestStatus = 'open' | 'in_progress' | 'resolved';

export type InvoiceHelpRequest = {
  id: number;
  status: HelpRequestStatus;
  requestedAt: string;
  resolvedAt: string | null;
  customer: {
    id: number;
    name: string;
    sapCustomerNumber: string | null;
  } | null;
  invoice: {
    id: number;
    billingDocument: string;
    billingDocumentDate: string;
    currency: string;
    totalGrossAmount: number | null;
  } | null;
  communicationJobId: number | null;
  inboundMessageId: number | null;
  buttonText: string;
};

export type HelpRequestCounts = Record<'all' | HelpRequestStatus, number>;

export type InvoiceHelpRequestPage = {
  items: InvoiceHelpRequest[];
  nextCursor: number | null;
  counts: HelpRequestCounts;
};

export function parseMsg91InvoiceButtonResponse(
  payload: Record<string, unknown>,
  now = new Date(),
): ParsedInvoiceButtonResponse | null {
  const messages = parseJsonValue(findValue(payload, ['messages']));
  const buttonValue = findValue(payload, ['button']) ?? findValue(messages, ['button', 'interactive']);
  const button = parseJsonValue(buttonValue);
  const buttonText = findText(button, ['text', 'title', 'body']) || primitiveText(buttonValue);
  const buttonPayload = findText(button, ['payload', 'id']) || buttonText;
  const responseType = classifyButtonResponse(buttonPayload, buttonText);
  if (!responseType) return null;

  const replyMessageId =
    findText(payload, ['replyMsgId', 'reply_msg_id', 'contextMessageId', 'context_message_id']) ||
    findText(messages, ['replyMsgId', 'reply_msg_id', 'contextMessageId', 'context_message_id']) ||
    findContextMessageId(messages) ||
    findContextMessageId(payload);
  if (!replyMessageId) return null;

  const inboundMessageId =
    findText(messages, ['id', 'message_id', 'messageId']) ||
    findText(payload, ['uuid', 'message_uuid', 'messageId', 'message_id']);
  if (!inboundMessageId) return null;

  const receivedAt = parseTimestamp(
    findValue(messages, ['timestamp']) ??
      findValue(payload, ['ts', 'timestamp', 'requestedAt', 'requested_at']),
    now,
  );
  const customerNumber =
    findText(messages, ['from', 'customerNumber', 'customer_number']) ||
    findText(payload, ['customerNumber', 'customer_number', 'from']);

  return {
    responseType,
    buttonText: buttonText || (responseType === 'needs_help' ? 'Need Help' : 'Received'),
    buttonPayload,
    replyMessageId,
    inboundMessageId,
    ...(customerNumber ? { customerNumber } : {}),
    receivedAt,
  };
}

export async function processMsg91InvoiceButtonResponse(input: {
  payload: Record<string, unknown>;
  providerIntegrationId: number | null;
  webhookEventId: number;
}): Promise<{ matched: boolean; responseType?: InvoiceResponseType; helpRequestId?: number }> {
  const parsed = parseMsg91InvoiceButtonResponse(input.payload);
  if (!parsed) return { matched: false };

  const client = getSupabaseServerClient();
  let outboundQuery = client
    .from('messages')
    .select('id,communication_job_id,customer_id,contact_id,provider_integration_id')
    .eq('provider_message_id', parsed.replyMessageId)
    .eq('direction', 'outbound');
  if (input.providerIntegrationId) {
    outboundQuery = outboundQuery.eq('provider_integration_id', input.providerIntegrationId);
  }
  const { data: outbound, error: outboundError } = await outboundQuery.maybeSingle();
  if (outboundError) throw new Error(`Unable to match invoice response: ${outboundError.message}`);
  if (!outbound?.communication_job_id) {
    throw new Error(`No outgoing invoice message matches reply ${parsed.replyMessageId}`);
  }

  const { data: job, error: jobError } = await client
    .from('communication_jobs')
    .select('id,primary_invoice_id,customer_id')
    .eq('id', outbound.communication_job_id)
    .single();
  if (jobError || !job) throw new Error(jobError?.message ?? 'Invoice delivery job was not found');

  const providerIntegrationId = input.providerIntegrationId ?? outbound.provider_integration_id ?? null;
  let { data: inbound, error: inboundLookupError } = await client
    .from('messages')
    .select('id')
    .eq('provider_message_id', parsed.inboundMessageId)
    .eq('direction', 'inbound')
    .maybeSingle();
  if (inboundLookupError) throw new Error(inboundLookupError.message);

  if (!inbound) {
    const { data, error } = await client
      .from('messages')
      .insert({
        customer_id: outbound.customer_id,
        contact_id: outbound.contact_id,
        provider_integration_id: providerIntegrationId,
        direction: 'inbound',
        channel: 'whatsapp',
        purpose: parsed.responseType === 'needs_help' ? 'invoice_help_request' : 'invoice_received',
        body: parsed.buttonText,
        provider_message_id: parsed.inboundMessageId,
        reply_to_message_id: outbound.id,
        status: 'received',
        received_at: parsed.receivedAt,
        metadata: {
          response_type: parsed.responseType,
          button_payload: parsed.buttonPayload,
          communication_job_id: job.id,
          invoice_id: job.primary_invoice_id,
          webhook_event_id: input.webhookEventId,
        },
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Unable to store invoice response');
    inbound = data;
  }

  const { error: responseError } = await client
    .from('customer_response_details')
    .upsert(
      {
        inbound_message_id: inbound.id,
        classification: parsed.responseType === 'needs_help' ? 'callback_requested' : 'other',
        notes: parsed.buttonText,
        requires_human_review: parsed.responseType === 'needs_help',
        classified_by: 'agent',
      },
      { onConflict: 'inbound_message_id' },
    );
  if (responseError) throw new Error(`Unable to classify invoice response: ${responseError.message}`);

  if (parsed.responseType !== 'needs_help') {
    return { matched: true, responseType: parsed.responseType };
  }

  const { data: existingTask, error: existingTaskError } = await client
    .from('review_tasks')
    .select('id')
    .eq('message_id', inbound.id)
    .eq('task_type', 'customer_response')
    .maybeSingle();
  if (existingTaskError) throw new Error(existingTaskError.message);
  if (existingTask) {
    return { matched: true, responseType: parsed.responseType, helpRequestId: existingTask.id };
  }

  const { data: task, error: taskError } = await client
    .from('review_tasks')
    .insert({
      task_type: 'customer_response',
      title: 'Invoice help requested',
      description: `Customer selected “${parsed.buttonText}” for this invoice.`,
      priority: 'high',
      status: 'open',
      customer_id: job.customer_id,
      invoice_id: job.primary_invoice_id,
      communication_job_id: job.id,
      message_id: inbound.id,
    })
    .select('id')
    .single();
  if (taskError || !task) throw new Error(taskError?.message ?? 'Unable to create invoice help request');

  return { matched: true, responseType: parsed.responseType, helpRequestId: task.id };
}

export async function listInvoiceHelpRequestsPage(input: {
  limit?: number;
  beforeId?: number;
  status?: HelpRequestStatus;
} = {}): Promise<InvoiceHelpRequestPage> {
  const client = getSupabaseServerClient();
  const pageSize = Math.min(Math.max(input.limit ?? 10, 1), 100);
  let query = client
    .from('review_tasks')
    .select(
      'id,status,created_at,resolved_at,communication_job_id,message_id,customers(id,display_name,sap_customer_number),invoices(id,sap_billing_document,billing_document_date,transaction_currency,total_gross_amount),messages(body)',
    )
    .eq('task_type', 'customer_response')
    .eq('title', 'Invoice help requested')
    .order('id', { ascending: false })
    .limit(pageSize + 1);
  if (input.beforeId) query = query.lt('id', input.beforeId);
  if (input.status) query = query.eq('status', input.status);

  const countQuery = (status?: HelpRequestStatus) => {
    let count = client
      .from('review_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('task_type', 'customer_response')
      .eq('title', 'Invoice help requested');
    if (status) count = count.eq('status', status);
    return count;
  };
  const [pageResult, allCount, openCount, progressCount, resolvedCount] = await Promise.all([
    query,
    countQuery(),
    countQuery('open'),
    countQuery('in_progress'),
    countQuery('resolved'),
  ]);
  const { data, error } = pageResult;
  if (error) throw new Error(`Unable to load help requests: ${error.message}`);
  const countError = allCount.error ?? openCount.error ?? progressCount.error ?? resolvedCount.error;
  if (countError) throw new Error(`Unable to count help requests: ${countError.message}`);

  const rows = data ?? [];
  const hasNextPage = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const items = pageRows.map((row) => {
    const customer = relationOne(row.customers);
    const invoice = relationOne(row.invoices);
    const message = relationOne(row.messages);
    return {
      id: Number(row.id),
      status: row.status as HelpRequestStatus,
      requestedAt: String(row.created_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      customer: customer
        ? {
            id: Number(customer.id),
            name: String(customer.display_name),
            sapCustomerNumber: customer.sap_customer_number ? String(customer.sap_customer_number) : null,
          }
        : null,
      invoice: invoice
        ? {
            id: Number(invoice.id),
            billingDocument: String(invoice.sap_billing_document),
            billingDocumentDate: String(invoice.billing_document_date),
            currency: String(invoice.transaction_currency),
            totalGrossAmount: invoice.total_gross_amount == null ? null : Number(invoice.total_gross_amount),
          }
        : null,
      communicationJobId: row.communication_job_id == null ? null : Number(row.communication_job_id),
      inboundMessageId: row.message_id == null ? null : Number(row.message_id),
      buttonText: message?.body ? String(message.body) : 'Need Help',
    };
  });
  return {
    items,
    nextCursor: hasNextPage && pageRows.length > 0
      ? Number(pageRows.at(-1)?.id)
      : null,
    counts: {
      all: allCount.count ?? 0,
      open: openCount.count ?? 0,
      in_progress: progressCount.count ?? 0,
      resolved: resolvedCount.count ?? 0,
    },
  };
}

export async function listInvoiceHelpRequests(status?: HelpRequestStatus): Promise<InvoiceHelpRequest[]> {
  return (await listInvoiceHelpRequestsPage({ limit: 100, status })).items;
}

export async function updateInvoiceHelpRequestStatus(
  id: number,
  status: HelpRequestStatus,
): Promise<void> {
  const { error } = await getSupabaseServerClient()
    .from('review_tasks')
    .update({
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : null,
    })
    .eq('id', id)
    .eq('task_type', 'customer_response')
    .eq('title', 'Invoice help requested');
  if (error) throw new Error(`Unable to update help request: ${error.message}`);
}

function classifyButtonResponse(payload: string, text: string): InvoiceResponseType | null {
  const value = `${payload} ${text}`.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/need(?:s)?\s+help|help\s+needed|contact\s+me|support/.test(value)) return 'needs_help';
  if (/\breceive(?:d)?\b|acknowledge(?:d)?|got\s+it/.test(value)) return 'received';
  return null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function parseTimestamp(value: unknown, fallback: Date): string {
  const raw = primitiveText(value);
  if (!raw) return fallback.toISOString();
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}+05:30`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

function findText(value: unknown, keys: string[]): string {
  return primitiveText(findValue(value, keys));
}

function findContextMessageId(value: unknown): string {
  const context = findValue(value, ['context']);
  return findText(context, ['id', 'message_id', 'messageId']);
}

function primitiveText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function findValue(value: unknown, keys: string[]): unknown {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findValue(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  for (const key of keys) {
    if (parsed[key] !== undefined && parsed[key] !== null) return parsed[key];
  }
  for (const child of Object.values(parsed)) {
    const found = findValue(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function relationOne<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
