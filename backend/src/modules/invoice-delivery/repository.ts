import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import type { InvoiceCandidate, PersistedDelivery } from './domain.js';
import { createDeliveryIdempotencyKey, maskPhone } from './policy.js';

type PersistedInvoice = {
  customerId: number;
  contactId: number;
  invoiceId: number;
  documentId: number;
  documentPath: string;
};

export type ClaimedJob = {
  id: number;
  customer_id: number;
  primary_invoice_id: number;
  contact_id: number | null;
  template_id: number | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  metadata: Record<string, unknown>;
};

export type DeliveryJobContext = ClaimedJob & {
  customer: {
    id: number;
    display_name: string;
  };
  invoice: {
    id: number;
    sap_billing_document: string;
    billing_document_date: string;
    transaction_currency: string;
    total_gross_amount: number;
  };
  document: {
    id: number;
    storage_bucket: string;
    storage_path: string;
    file_name: string | null;
  };
  providerIntegrationId: number | null;
};

export async function persistFixtureAndEnqueue(
  candidate: InvoiceCandidate,
  recipient: string,
  startedBy?: string,
): Promise<PersistedDelivery> {
  return persistInvoiceAndEnqueue(candidate, recipient, {
    source: 'fixture',
    triggerType: 'manual',
    startedBy,
  });
}

export async function persistInvoiceAndEnqueue(
  candidate: InvoiceCandidate,
  recipient: string,
  options: {
    source: 'fixture' | 'sap';
    triggerType: 'manual' | 'scheduled';
    startedBy?: string;
  },
): Promise<PersistedDelivery> {
  const client = getSupabaseServerClient();
  const runId = await createAgentRun(client, options);

  try {
    const persisted = await persistInvoice(client, candidate, options.source);
    const templateId = await findTemplateId(client);
    const idempotencyKey = createDeliveryIdempotencyKey(candidate, recipient);

    const { data: insertedJob, error: jobError } = await client
      .from('communication_jobs')
      .insert({
        agent_run_id: runId,
        job_type: 'invoice_delivery',
        customer_id: persisted.customerId,
        primary_invoice_id: persisted.invoiceId,
        contact_id: persisted.contactId,
        template_id: templateId,
        channel: 'whatsapp',
        source_version: 1,
        status: 'queued',
        approval_status: 'not_required',
        max_attempts: 3,
        idempotency_key: idempotencyKey,
        metadata: {
          source: options.source,
          source_id: candidate.fixtureId,
          actual_recipient: recipient,
          masked_recipient: maskPhone(recipient),
          document_id: persisted.documentId,
          document_path: persisted.documentPath,
        },
      })
      .select('id,status')
      .single();

    if (jobError?.code === '23505') {
      const existing = await requiredSingle(
        client
          .from('communication_jobs')
          .select('id,status')
          .eq('idempotency_key', idempotencyKey)
          .single(),
        'Unable to load the existing delivery job',
      );
      await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
      return { jobId: Number(existing.id), duplicate: true, status: String(existing.status) };
    }
    if (jobError || !insertedJob) {
      throw new Error(jobError?.message ?? 'Unable to create delivery job');
    }

    const { error: linkError } = await client.from('communication_job_invoices').insert({
      communication_job_id: insertedJob.id,
      invoice_id: persisted.invoiceId,
    });
    if (linkError && linkError.code !== '23505') throw new Error(linkError.message);

    await finishAgentRun(client, runId, 'succeeded', 1, 1, 0);
    return {
      jobId: Number(insertedJob.id),
      duplicate: false,
      status: String(insertedJob.status),
    };
  } catch (error) {
    await finishAgentRun(client, runId, 'failed', 1, 0, 1, toErrorMessage(error));
    throw error;
  }
}

export async function listDeliveryJobs(limit = 50, beforeId?: number): Promise<unknown[]> {
  const client = getSupabaseServerClient();
  let query = client
    .from('communication_jobs')
    .select(
      'id,status,attempt_count,max_attempts,scheduled_at,completed_at,last_error,metadata,customers(display_name),invoices!communication_jobs_primary_invoice_id_fkey(sap_billing_document,billing_document_date,transaction_currency,total_gross_amount),messages(id,status,provider_message_id,sent_at,delivered_at,read_at,failed_at)',
    )
    .eq('job_type', 'invoice_delivery')
    .order('id', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (beforeId) query = query.lt('id', beforeId);

  const { data, error } = await query;
  if (error) throw new HttpError(500, 'Unable to load delivery history', error.message);
  return (data ?? []).map(sanitizeJobForApi);
}

export async function getDeliveryJob(jobId: number): Promise<Record<string, unknown>> {
  const client = getSupabaseServerClient();
  const job = await requiredSingle(
    client
      .from('communication_jobs')
      .select(
        `id,agent_run_id,job_type,customer_id,primary_invoice_id,contact_id,template_id,
        channel,source_version,status,approval_status,scheduled_at,available_at,locked_at,
        locked_by,attempt_count,max_attempts,idempotency_key,last_error,completed_at,metadata,
        created_at,updated_at,
        customers(id,sap_business_partner_id,sap_customer_number,display_name,legal_name,
          language_code,country_code,default_currency,is_active,last_synced_at,created_at,updated_at),
        customer_contacts(id,channel,label,is_primary,is_verified,is_whatsapp_capable,
          consent_status,do_not_contact,is_active,validation_error,created_at,updated_at),
        invoices!communication_jobs_primary_invoice_id_fkey(id,sap_billing_document,
          billing_document_type,billing_document_category,billing_document_date,creation_datetime,
          sales_organization,distribution_channel,division,transaction_currency,total_net_amount,
          total_tax_amount,total_gross_amount,accounting_posting_status,overall_billing_status,
          is_cancelled,source_version,eligibility_status,eligibility_reason,last_synced_at,
          created_at,updated_at),
        communication_templates(id,code,purpose,channel,locale,name,body_template,
          provider_template_id,version,status,required_variables,created_at,updated_at)`,
      )
      .eq('id', jobId)
      .eq('job_type', 'invoice_delivery')
      .single(),
    'Delivery job not found',
    404,
  );
  const invoiceId = Number(job.primary_invoice_id);
  const agentRunId = job.agent_run_id === null ? null : Number(job.agent_run_id);
  const [messagesResult, itemsResult, documentsResult, agentRunResult] = await Promise.all([
    client
      .from('messages')
      .select(
        `id,direction,channel,purpose,subject,body,provider_message_id,provider_thread_id,
        status,sent_at,delivered_at,read_at,received_at,failed_at,failure_code,failure_reason,
        metadata,created_at,updated_at,
        message_attempts(id,attempt_number,status,provider_request_id,response_status,
          request_payload,response_payload,error_code,error_message,is_retryable,started_at,finished_at)`,
      )
      .eq('communication_job_id', jobId)
      .order('id', { ascending: true }),
    client
      .from('invoice_items')
      .select(
        'id,sap_item_number,product_id,description,quantity,quantity_unit,net_amount,tax_amount,currency',
      )
      .eq('invoice_id', invoiceId)
      .order('sap_item_number', { ascending: true }),
    client
      .from('invoice_documents')
      .select(
        'id,document_type,source_version,storage_bucket,storage_path,file_name,mime_type,size_bytes,is_current,created_at',
      )
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false }),
    agentRunId
      ? client
          .from('agent_runs')
          .select(
            'id,agent_type,trigger_type,status,started_at,finished_at,records_examined,records_succeeded,records_failed,error_summary,metadata',
          )
          .eq('id', agentRunId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (messagesResult.error) throw new HttpError(500, 'Unable to load message history');
  if (itemsResult.error) throw new HttpError(500, 'Unable to load invoice items');
  if (documentsResult.error) throw new HttpError(500, 'Unable to load invoice documents');
  if (agentRunResult.error) throw new HttpError(500, 'Unable to load agent run');

  const documents = await Promise.all(
    (documentsResult.data ?? []).map(async (document) => {
      const { data } = await client.storage
        .from(document.storage_bucket)
        .createSignedUrl(document.storage_path, 3600, {
          download: document.file_name ?? `invoice-${invoiceId}.pdf`,
        });
      return {
        ...document,
        download_url: data?.signedUrl ?? null,
      };
    }),
  );

  return {
    ...sanitizeJobForApi(job),
    agent_run: agentRunResult.data,
    invoice_items: itemsResult.data ?? [],
    invoice_documents: documents,
    messages: messagesResult.data ?? [],
  };
}

export async function claimNextDeliveryJob(workerName: string): Promise<ClaimedJob | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client.rpc('claim_next_communication_job', {
    worker_name: workerName,
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    return row ? asClaimedJob(row) : null;
  }

  if (!['PGRST202', '42883'].includes(error.code ?? '')) {
    throw new Error(`Unable to claim a delivery job: ${error.message}`);
  }

  return claimWithOptimisticFallback(client, workerName);
}

export async function getDeliveryJobContext(job: ClaimedJob): Promise<DeliveryJobContext> {
  const client = getSupabaseServerClient();
  const [customer, invoice, document] = await Promise.all([
    requiredSingle(
      client.from('customers').select('id,display_name').eq('id', job.customer_id).single(),
      'Delivery customer not found',
    ),
    requiredSingle(
      client
        .from('invoices')
        .select('id,sap_billing_document,billing_document_date,transaction_currency,total_gross_amount')
        .eq('id', job.primary_invoice_id)
        .single(),
      'Delivery invoice not found',
    ),
    requiredSingle(
      client
        .from('invoice_documents')
        .select('id,storage_bucket,storage_path,file_name')
        .eq('invoice_id', job.primary_invoice_id)
        .eq('document_type', 'invoice_pdf')
        .eq('is_current', true)
        .single(),
      'Invoice PDF not found',
    ),
  ]);
  const provider = await findProviderIntegration(client);

  return {
    ...job,
    customer: customer as DeliveryJobContext['customer'],
    invoice: invoice as DeliveryJobContext['invoice'],
    document: document as DeliveryJobContext['document'],
    providerIntegrationId: provider?.id ? Number(provider.id) : null,
  };
}

export async function createInvoiceDocumentUrl(
  context: DeliveryJobContext,
): Promise<string> {
  const client = getSupabaseServerClient();
  const { data, error } = await client.storage
    .from(context.document.storage_bucket)
    .createSignedUrl(context.document.storage_path, 3600, {
      download: context.document.file_name ?? `${context.invoice.sap_billing_document}.pdf`,
    });
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Unable to sign invoice PDF');
  return data.signedUrl;
}

export async function getOrCreateMessage(context: DeliveryJobContext): Promise<{
  id: number;
  status: string;
}> {
  const client = getSupabaseServerClient();
  const { data: existing } = await client
    .from('messages')
    .select('id,status')
    .eq('communication_job_id', context.id)
    .maybeSingle();
  if (existing) return { id: Number(existing.id), status: String(existing.status) };

  return requiredSingle(
    client
      .from('messages')
      .insert({
        communication_job_id: context.id,
        customer_id: context.customer_id,
        contact_id: context.contact_id,
        template_id: context.template_id,
        provider_integration_id: context.providerIntegrationId,
        direction: 'outbound',
        channel: 'whatsapp',
        purpose: 'invoice_delivery',
        body: `Invoice ${context.invoice.sap_billing_document}`,
        status: 'created',
        metadata: {
          source: String(context.metadata.source ?? 'unknown'),
          masked_recipient: context.metadata.masked_recipient,
        },
      })
      .select('id,status')
      .single(),
    'Unable to create the outbound message',
  ) as Promise<{ id: number; status: string }>;
}

export async function startMessageAttempt(
  context: DeliveryJobContext,
  messageId: number,
  requestPayload: Record<string, unknown>,
): Promise<{ id: number; attemptNumber: number }> {
  const client = getSupabaseServerClient();
  const { count, error: countError } = await client
    .from('message_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('message_id', messageId);
  if (countError) throw new Error(countError.message);
  const attemptNumber = (count ?? 0) + 1;
  const row = await requiredSingle(
    client
      .from('message_attempts')
      .insert({
        message_id: messageId,
        provider_integration_id: context.providerIntegrationId,
        attempt_number: attemptNumber,
        status: 'started',
        request_payload: requestPayload,
      })
      .select('id')
      .single(),
    'Unable to create the delivery attempt',
  );
  return { id: Number(row.id), attemptNumber };
}

export async function markDeliveryAccepted(input: {
  jobId: number;
  messageId: number;
  attemptId: number;
  attemptNumber: number;
  statusCode: number;
  responseBody: unknown;
  providerRequestId?: string;
  providerMessageId?: string;
}): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  await ensureUpdate(
    client
      .from('message_attempts')
      .update({
        status: 'accepted',
        response_status: input.statusCode,
        response_payload: input.responseBody,
        provider_request_id: input.providerRequestId,
        finished_at: now,
      })
      .eq('id', input.attemptId),
  );
  await ensureUpdate(
    client
      .from('messages')
      .update({
        status: 'accepted',
        provider_message_id: input.providerMessageId,
      })
      .eq('id', input.messageId),
  );
  await ensureUpdate(
    client
      .from('communication_jobs')
      .update({
        status: 'completed',
        attempt_count: input.attemptNumber,
        completed_at: now,
        locked_at: null,
        locked_by: null,
        last_error: null,
      })
      .eq('id', input.jobId),
  );
}

export async function markDeliveryFailed(input: {
  jobId: number;
  messageId: number;
  attemptId: number;
  attemptNumber: number;
  statusCode: number;
  responseBody: unknown;
  errorMessage: string;
  ambiguous: boolean;
}): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  await ensureUpdate(
    client
      .from('message_attempts')
      .update({
        status: input.ambiguous ? 'timed_out' : 'failed',
        response_status: input.statusCode || null,
        response_payload: input.responseBody,
        error_code: input.ambiguous ? 'ambiguous_timeout' : 'provider_rejected',
        error_message: input.errorMessage,
        is_retryable: !input.ambiguous,
        finished_at: now,
      })
      .eq('id', input.attemptId),
  );
  await ensureUpdate(
    client
      .from('messages')
      .update({
        status: 'failed',
        failed_at: now,
        failure_code: input.ambiguous ? 'ambiguous_timeout' : 'provider_rejected',
        failure_reason: input.errorMessage,
      })
      .eq('id', input.messageId),
  );
  await ensureUpdate(
    client
      .from('communication_jobs')
      .update({
        status: 'failed',
        attempt_count: input.attemptNumber,
        locked_at: null,
        locked_by: null,
        last_error: input.errorMessage,
      })
      .eq('id', input.jobId),
  );
}

export async function retryDeliveryJob(jobId: number): Promise<void> {
  const client = getSupabaseServerClient();
  const job = await requiredSingle(
    client
      .from('communication_jobs')
      .select('id,status,attempt_count,max_attempts,last_error')
      .eq('id', jobId)
      .eq('job_type', 'invoice_delivery')
      .single(),
    'Delivery job not found',
    404,
  );
  if (job.status !== 'failed') throw new HttpError(409, 'Only failed jobs can be retried');
  if (Number(job.attempt_count) >= Number(job.max_attempts)) {
    throw new HttpError(409, 'Maximum delivery attempts reached');
  }
  if (String(job.last_error ?? '').includes('outcome is unknown')) {
    throw new HttpError(409, 'Ambiguous timeouts require provider-log review before retrying');
  }

  await ensureUpdate(
    client
      .from('communication_jobs')
      .update({
        status: 'queued',
        available_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: null,
      })
      .eq('id', jobId),
  );
}

export async function markClaimedJobFailed(jobId: number, errorMessage: string): Promise<void> {
  await ensureUpdate(
    getSupabaseServerClient()
      .from('communication_jobs')
      .update({
        status: 'failed',
        locked_at: null,
        locked_by: null,
        last_error: errorMessage,
      })
      .eq('id', jobId)
      .eq('status', 'processing'),
  );
}

export type SapPollingCheckpoint = {
  id: number;
  sap_connection_id: number;
  resource_type: string;
  cursor_value: string | null;
  watermark_at: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_status: string;
  last_error: string | null;
  records_processed: number;
};

export async function claimSapPollingCheckpoint(
  workerName: string,
): Promise<SapPollingCheckpoint | null> {
  const client = getSupabaseServerClient();
  const connectionId = await ensureSapConnection(client);
  const { data, error } = await client.rpc('claim_sap_sync_checkpoint', {
    connection_id: connectionId,
    requested_resource_type: 'billing_documents',
    minimum_watermark: `${env.SAP_POLL_START_DATE}T00:00:00.000Z`,
    worker_name: workerName,
  });
  if (error && ['PGRST202', '42883'].includes(error.code ?? '')) {
    return claimSapPollingCheckpointFallback(client, connectionId, workerName);
  }
  if (error) throw new Error(`Unable to claim the SAP polling checkpoint: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ? asSapPollingCheckpoint(row as Record<string, unknown>) : null;
}

export async function finishSapPollingCheckpoint(input: {
  checkpointId: number;
  status: 'succeeded' | 'failed';
  recordsProcessed: number;
  watermarkAt?: string;
  cursorValue?: string;
  error?: string;
}): Promise<void> {
  const values = {
    last_status: input.status,
    last_completed_at: new Date().toISOString(),
    records_processed: input.recordsProcessed,
    last_error: input.error ?? null,
    ...(input.watermarkAt ? { watermark_at: input.watermarkAt } : {}),
    ...(input.cursorValue ? { cursor_value: input.cursorValue } : {}),
  };
  await ensureUpdate(
    getSupabaseServerClient()
      .from('sap_sync_checkpoints')
      .update(values)
      .eq('id', input.checkpointId),
  );
}

export async function getSapPollingStatus(): Promise<SapPollingCheckpoint | null> {
  const { data, error } = await getSupabaseServerClient()
    .from('sap_sync_checkpoints')
    .select(
      'id,sap_connection_id,resource_type,cursor_value,watermark_at,last_started_at,last_completed_at,last_status,last_error,records_processed',
    )
    .eq('resource_type', 'billing_documents')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? asSapPollingCheckpoint(data) : null;
}

export async function listPendingProviderRequestIds(
  startedAfter: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseServerClient()
    .from('message_attempts')
    .select('message_id,provider_request_id')
    .in('status', ['started', 'accepted', 'succeeded'])
    .not('provider_request_id', 'is', null)
    .gte('started_at', startedAfter);
  if (error) throw new Error(error.message);
  const attempts = data ?? [];
  if (attempts.length === 0) return [];
  const messageIds = [...new Set(attempts.map((row) => Number(row.message_id)).filter(Number.isFinite))];
  const { data: messages, error: messagesError } = await getSupabaseServerClient()
    .from('messages')
    .select('id,status')
    .in('id', messageIds);
  if (messagesError) throw new Error(messagesError.message);
  const pendingMessageIds = new Set(
    (messages ?? [])
      .filter((message) => !['read', 'failed', 'cancelled'].includes(String(message.status)))
      .map((message) => Number(message.id)),
  );
  return [...new Set(
    attempts
      .filter((row) => pendingMessageIds.has(Number(row.message_id)))
      .map((row) => String(row.provider_request_id ?? ''))
      .filter(Boolean),
  )];
}

export type ProviderDeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export async function applyProviderDeliveryStatus(input: {
  providerRequestId?: string;
  providerMessageId?: string;
  status: ProviderDeliveryStatus;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  failureCode?: string;
  failureReason?: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const client = getSupabaseServerClient();
  let attemptQuery = client
    .from('message_attempts')
    .select('id,message_id,status,provider_request_id')
    .order('id', { ascending: false })
    .limit(1);
  if (input.providerRequestId) {
    attemptQuery = attemptQuery.eq('provider_request_id', input.providerRequestId);
  } else if (input.providerMessageId) {
    const { data: message, error: messageLookupError } = await client
      .from('messages')
      .select('id')
      .eq('provider_message_id', input.providerMessageId)
      .maybeSingle();
    if (messageLookupError) throw new Error(messageLookupError.message);
    if (!message) return false;
    attemptQuery = attemptQuery.eq('message_id', message.id);
  } else {
    return false;
  }

  const { data: attempt, error: attemptError } = await attemptQuery.maybeSingle();
  if (attemptError) throw new Error(attemptError.message);
  if (!attempt) return false;
  const { data: message, error: messageError } = await client
    .from('messages')
    .select(
      'id,communication_job_id,status,provider_message_id,sent_at,delivered_at,read_at,failed_at',
    )
    .eq('id', attempt.message_id)
    .single();
  if (messageError || !message) throw new Error(messageError?.message ?? 'Delivery message not found');

  const currentStatus = String(message.status) as ProviderDeliveryStatus;
  if (input.status !== 'failed' && statusRank(input.status) < statusRank(currentStatus)) {
    return true;
  }
  if (input.status === 'failed' && ['sent', 'delivered', 'read'].includes(currentStatus)) {
    return true;
  }

  const now = new Date().toISOString();
  const messageValues: Record<string, unknown> = {
    status: input.status,
    ...(input.providerMessageId ? { provider_message_id: input.providerMessageId } : {}),
  };
  if (statusRank(input.status) >= statusRank('sent')) {
    messageValues.sent_at = input.sentAt ?? message.sent_at ?? input.deliveredAt ?? input.readAt ?? now;
  }
  if (statusRank(input.status) >= statusRank('delivered')) {
    messageValues.delivered_at = input.deliveredAt ?? message.delivered_at ?? input.readAt ?? now;
  }
  if (input.status === 'read') messageValues.read_at = input.readAt ?? message.read_at ?? now;
  if (input.status === 'failed') {
    messageValues.failed_at = message.failed_at ?? input.failedAt ?? now;
    messageValues.failure_code = input.failureCode ?? 'provider_failed';
    messageValues.failure_reason = input.failureReason ?? 'MSG91 reported delivery failure';
  }

  await ensureUpdate(client.from('messages').update(messageValues).eq('id', message.id));
  await ensureUpdate(
    client
      .from('message_attempts')
      .update({
        status: input.status === 'failed' ? 'failed' : input.status === 'accepted' ? 'accepted' : 'succeeded',
        ...(input.payload ? { response_payload: input.payload } : {}),
        ...(input.status === 'failed'
          ? {
              error_code: input.failureCode ?? 'provider_failed',
              error_message: input.failureReason ?? 'MSG91 reported delivery failure',
              is_retryable: true,
            }
          : {}),
      })
      .eq('id', attempt.id),
  );

  const jobStatus = input.status === 'failed' ? 'failed' : 'completed';
  await ensureUpdate(
    client
      .from('communication_jobs')
      .update({
        status: jobStatus,
        completed_at: jobStatus === 'completed' ? input.readAt ?? input.deliveredAt ?? input.sentAt ?? now : null,
        last_error: input.status === 'failed' ? messageValues.failure_reason : null,
        locked_at: null,
        locked_by: null,
      })
      .eq('id', message.communication_job_id),
  );
  return true;
}

async function persistInvoice(
  client: SupabaseClient,
  candidate: InvoiceCandidate,
  source: 'fixture' | 'sap',
): Promise<PersistedInvoice> {
  const customerId = await upsertCustomer(client, candidate);
  const contactId = await upsertContact(client, candidate, customerId);
  const invoiceId = await upsertInvoice(client, candidate, customerId);
  await upsertInvoiceItems(client, candidate, invoiceId);
  const document = await upsertInvoicePdf(client, candidate, invoiceId, source);
  return { customerId, contactId, invoiceId, ...document };
}

async function upsertCustomer(client: SupabaseClient, candidate: InvoiceCandidate): Promise<number> {
  const { data: existing, error: lookupError } = await client
    .from('customers')
    .select('id')
    .eq('sap_customer_number', candidate.customer.customerNumber)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);

  const values = {
    sap_business_partner_id: candidate.customer.businessPartnerId,
    sap_customer_number: candidate.customer.customerNumber,
    display_name: candidate.customer.displayName,
    legal_name: candidate.customer.legalName,
    country_code: candidate.customer.countryCode,
    default_currency: candidate.customer.currency,
    last_synced_at: new Date().toISOString(),
    raw_data: candidate.customer.rawData,
  };
  if (existing) {
    const row = await requiredSingle(
      client.from('customers').update(values).eq('id', existing.id).select('id').single(),
      'Unable to update invoice customer',
    );
    return Number(row.id);
  }
  const row = await requiredSingle(
    client.from('customers').insert(values).select('id').single(),
    'Unable to create invoice customer',
  );
  return Number(row.id);
}

async function upsertContact(
  client: SupabaseClient,
  candidate: InvoiceCandidate,
  customerId: number,
): Promise<number> {
  const { data: existing, error: lookupError } = await client
    .from('customer_contacts')
    .select('id')
    .eq('customer_id', customerId)
    .eq('channel', 'whatsapp')
    .eq('normalized_value', candidate.contact.normalizedValue)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  const values = {
    customer_id: customerId,
    channel: 'whatsapp',
    original_value: candidate.contact.originalValue,
    normalized_value: candidate.contact.normalizedValue,
    label: candidate.fixtureLabel,
    is_primary: candidate.contact.isPrimary,
    is_verified: candidate.contact.isVerified,
    is_whatsapp_capable: true,
    consent_status: 'unknown',
    raw_data: candidate.contact.rawData,
  };
  if (existing) {
    const row = await requiredSingle(
      client.from('customer_contacts').update(values).eq('id', existing.id).select('id').single(),
      'Unable to update invoice contact',
    );
    return Number(row.id);
  }
  const row = await requiredSingle(
    client.from('customer_contacts').insert(values).select('id').single(),
    'Unable to create invoice contact',
  );
  return Number(row.id);
}

async function upsertInvoice(
  client: SupabaseClient,
  candidate: InvoiceCandidate,
  customerId: number,
): Promise<number> {
  const values = {
    sap_billing_document: candidate.billingDocument,
    billing_document_type: candidate.billingDocumentType,
    billing_document_category: candidate.billingDocumentCategory,
    billing_document_date: candidate.billingDocumentDate,
    creation_datetime: candidate.creationDateTime,
    sap_last_changed_at: candidate.lastChangedAt,
    sold_to_customer_id: customerId,
    bill_to_customer_id: customerId,
    payer_customer_id: customerId,
    sales_organization: candidate.salesOrganization,
    distribution_channel: candidate.distributionChannel,
    division: candidate.division,
    transaction_currency: candidate.currency,
    total_net_amount: candidate.totalNetAmount,
    total_tax_amount: candidate.totalTaxAmount,
    total_gross_amount: candidate.totalGrossAmount,
    accounting_posting_status: candidate.accountingPostingStatus,
    overall_billing_status: candidate.overallBillingStatus,
    is_cancelled: candidate.isCancelled,
    source_version: 1,
    eligibility_status: candidate.isCancelled ? 'cancelled' : 'eligible',
    eligibility_reason: candidate.isCancelled ? 'Invoice is cancelled' : null,
    last_synced_at: new Date().toISOString(),
    raw_data: candidate.rawData,
  };
  const row = await requiredSingle(
    client
      .from('invoices')
      .upsert(values, { onConflict: 'sap_billing_document' })
      .select('id')
      .single(),
    'Unable to import invoice',
  );
  return Number(row.id);
}

async function upsertInvoiceItems(
  client: SupabaseClient,
  candidate: InvoiceCandidate,
  invoiceId: number,
): Promise<void> {
  if (candidate.items.length === 0) return;
  const { error } = await client.from('invoice_items').upsert(
    candidate.items.map((item) => ({
      invoice_id: invoiceId,
      sap_item_number: item.itemNumber,
      product_id: item.productId,
      description: item.description,
      quantity: item.quantity,
      quantity_unit: item.quantityUnit,
      net_amount: item.netAmount,
      tax_amount: item.taxAmount,
      currency: item.currency,
      raw_data: item.rawData,
    })),
    { onConflict: 'invoice_id,sap_item_number' },
  );
  if (error) throw new Error(error.message);
}

async function upsertInvoicePdf(
  client: SupabaseClient,
  candidate: InvoiceCandidate,
  invoiceId: number,
  source: 'fixture' | 'sap',
): Promise<{ documentId: number; documentPath: string }> {
  const bytes = Buffer.from(candidate.pdf.base64, 'base64');
  if (!bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new Error('Invoice document is not a valid PDF');
  }
  const path = `${source}/${candidate.billingDocument}/invoice-v1.pdf`;
  const { error: uploadError } = await client.storage
    .from('invoice-documents')
    .upload(path, bytes, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (uploadError) throw new Error(uploadError.message);

  const { data: existing, error: lookupError } = await client
    .from('invoice_documents')
    .select('id')
    .eq('storage_bucket', 'invoice-documents')
    .eq('storage_path', path)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  const values = {
    invoice_id: invoiceId,
    document_type: 'invoice_pdf',
    source_version: 1,
    storage_bucket: 'invoice-documents',
    storage_path: path,
    file_name: candidate.pdf.fileName,
    mime_type: candidate.pdf.mimeType,
    size_bytes: bytes.length,
    is_current: true,
  };
  const row = existing
    ? await requiredSingle(
        client.from('invoice_documents').update(values).eq('id', existing.id).select('id').single(),
        'Unable to update invoice PDF metadata',
      )
    : await requiredSingle(
        client.from('invoice_documents').insert(values).select('id').single(),
        'Unable to create invoice PDF metadata',
      );
  return { documentId: Number(row.id), documentPath: path };
}

async function createAgentRun(
  client: SupabaseClient,
  options: {
    source: 'fixture' | 'sap';
    triggerType: 'manual' | 'scheduled';
    startedBy?: string;
  },
): Promise<number> {
  const row = await requiredSingle(
    client
      .from('agent_runs')
      .insert({
        agent_type: 'invoice_delivery',
        trigger_type: options.triggerType,
        started_by:
          options.startedBy && /^[0-9a-f-]{36}$/i.test(options.startedBy)
            ? options.startedBy
            : null,
        status: 'running',
        metadata: { source: options.source },
      })
      .select('id')
      .single(),
    'Unable to create the agent run',
  );
  return Number(row.id);
}

async function finishAgentRun(
  client: SupabaseClient,
  id: number,
  status: 'succeeded' | 'failed',
  examined: number,
  succeeded: number,
  failed: number,
  errorSummary?: string,
): Promise<void> {
  await client
    .from('agent_runs')
    .update({
      status,
      finished_at: new Date().toISOString(),
      records_examined: examined,
      records_succeeded: succeeded,
      records_failed: failed,
      error_summary: errorSummary,
    })
    .eq('id', id);
}

async function findTemplateId(client: SupabaseClient): Promise<number | null> {
  const { data, error } = await client
    .from('communication_templates')
    .select('id')
    .eq('provider_template_id', env.MSG91_TEMPLATE_NAME)
    .eq('channel', 'whatsapp')
    .eq('status', 'approved')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ? Number(data.id) : null;
}

async function findProviderIntegration(client: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from('provider_integrations')
    .select('id')
    .eq('provider', 'msg91')
    .eq('channel', 'whatsapp')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function ensureSapConnection(client: SupabaseClient): Promise<number> {
  if (!env.SAP_API_BASE_URL) throw new Error('SAP API base URL is not configured');
  const row = await requiredSingle(
    client
      .from('sap_connections')
      .upsert(
        {
          name: 'SuryaDev SAP QAS',
          environment: 'qas',
          base_url: env.SAP_BASE_URL ?? env.SAP_API_BASE_URL,
          api_base_url: env.SAP_API_BASE_URL,
          communication_user_name: env.SAP_API_USERNAME,
          secret_reference: 'environment:SAP_API_PASSWORD',
          is_read_only: true,
          is_active: true,
          last_successful_connection_at: new Date().toISOString(),
          settings: {
            allowed_customers: [...env.SAP_ALLOWED_CUSTOMERS.split(',').map((value) => value.trim()).filter(Boolean)],
            poll_start_date: env.SAP_POLL_START_DATE,
          },
        },
        { onConflict: 'environment' },
      )
      .select('id')
      .single(),
    'Unable to configure the SAP QAS connection',
  );
  return Number(row.id);
}

async function claimSapPollingCheckpointFallback(
  client: SupabaseClient,
  connectionId: number,
  workerName: string,
): Promise<SapPollingCheckpoint | null> {
  const minimumWatermark = `${env.SAP_POLL_START_DATE}T00:00:00.000Z`;
  const { error: upsertError } = await client
    .from('sap_sync_checkpoints')
    .upsert(
      {
        sap_connection_id: connectionId,
        resource_type: 'billing_documents',
        cursor_value: 'not-started',
        watermark_at: minimumWatermark,
      },
      { onConflict: 'sap_connection_id,resource_type', ignoreDuplicates: true },
    );
  if (upsertError) throw new Error(upsertError.message);

  const { data: checkpoint, error: lookupError } = await client
    .from('sap_sync_checkpoints')
    .select('*')
    .eq('sap_connection_id', connectionId)
    .eq('resource_type', 'billing_documents')
    .single();
  if (lookupError || !checkpoint) throw new Error(lookupError?.message ?? 'SAP checkpoint not found');
  const staleBefore = Date.now() - 5 * 60_000;
  if (
    checkpoint.last_status === 'running' &&
    checkpoint.last_started_at &&
    new Date(checkpoint.last_started_at).getTime() >= staleBefore
  ) return null;

  const { data: claimed, error: claimError } = await client
    .from('sap_sync_checkpoints')
    .update({
      cursor_value: workerName,
      watermark_at:
        checkpoint.watermark_at && checkpoint.watermark_at > minimumWatermark
          ? checkpoint.watermark_at
          : minimumWatermark,
      last_started_at: new Date().toISOString(),
      last_status: 'running',
      last_error: null,
    })
    .eq('id', checkpoint.id)
    .select('*')
    .single();
  if (claimError || !claimed) throw new Error(claimError?.message ?? 'Unable to claim SAP checkpoint');
  return asSapPollingCheckpoint(claimed);
}

async function claimWithOptimisticFallback(
  client: SupabaseClient,
  workerName: string,
): Promise<ClaimedJob | null> {
  const cutoff = new Date(Date.now() - env.JOB_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
  await client
    .from('communication_jobs')
    .update({ status: 'queued', locked_at: null, locked_by: null })
    .eq('status', 'processing')
    .lt('locked_at', cutoff);

  const { data: candidate, error: lookupError } = await client
    .from('communication_jobs')
    .select('*')
    .eq('job_type', 'invoice_delivery')
    .in('status', ['pending', 'queued'])
    .lte('available_at', new Date().toISOString())
    .order('available_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (!candidate) return null;

  const { data: claimed, error: claimError } = await client
    .from('communication_jobs')
    .update({
      status: 'processing',
      locked_at: new Date().toISOString(),
      locked_by: workerName,
    })
    .eq('id', candidate.id)
    .in('status', ['pending', 'queued'])
    .select('*')
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  return claimed ? asClaimedJob(claimed) : null;
}

function asClaimedJob(row: Record<string, unknown>): ClaimedJob {
  return {
    id: Number(row.id),
    customer_id: Number(row.customer_id),
    primary_invoice_id: Number(row.primary_invoice_id),
    contact_id: row.contact_id === null ? null : Number(row.contact_id),
    template_id: row.template_id === null ? null : Number(row.template_id),
    status: String(row.status),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    metadata: isRecord(row.metadata) ? row.metadata : {},
  };
}

function asSapPollingCheckpoint(row: Record<string, unknown>): SapPollingCheckpoint {
  return {
    id: Number(row.id),
    sap_connection_id: Number(row.sap_connection_id),
    resource_type: String(row.resource_type),
    cursor_value: row.cursor_value == null ? null : String(row.cursor_value),
    watermark_at: row.watermark_at == null ? null : String(row.watermark_at),
    last_started_at: row.last_started_at == null ? null : String(row.last_started_at),
    last_completed_at: row.last_completed_at == null ? null : String(row.last_completed_at),
    last_status: String(row.last_status),
    last_error: row.last_error == null ? null : String(row.last_error),
    records_processed: Number(row.records_processed),
  };
}

function statusRank(status: string): number {
  return {
    created: 0,
    queued: 0,
    accepted: 1,
    sent: 2,
    delivered: 3,
    read: 4,
  }[status] ?? 0;
}

function sanitizeJobForApi<T extends Record<string, unknown>>(job: T): T {
  const metadata = isRecord(job.metadata) ? { ...job.metadata } : {};
  delete metadata.actual_recipient;
  const customerContact = isRecord(job.customer_contacts)
    ? { ...job.customer_contacts, original_value: '[redacted]', normalized_value: '[redacted]' }
    : job.customer_contacts;
  return {
    ...job,
    metadata,
    ...(customerContact ? { customer_contacts: customerContact } : {}),
  };
}

async function requiredSingle(
  request: PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>,
  message: string,
  status = 500,
): Promise<Record<string, unknown>> {
  const { data, error } = await request;
  if (error || !data) throw new HttpError(status, message, error?.message);
  return data;
}

async function ensureUpdate(
  request: PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  const { error } = await request;
  if (error) throw new Error(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
