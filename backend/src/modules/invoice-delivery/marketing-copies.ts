import { randomUUID } from 'node:crypto';
import { digitsOnly, env } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { sendTemplatePayload } from './msg91-client.js';
import { createInvoiceDocumentUrl, getDeliveryJobContextById } from './repository.js';
import {
  assertManagerCopyStillAllowed,
  MessagingRefusal,
  resolveManagerCopyRecipient,
} from '../messaging/guard.js';

type Components = Record<string, { type: string; value: string; filename?: string }>;
type TemplatePayload = {
  integrated_number: string;
  content_type: string;
  payload: { type: string; template: {
    name: string;
    language: { code: string; policy: string };
    to_and_components: { to: string[]; components: Components }[];
  } };
};

// Clone only the destination. Keep the customer's name, values, buttons,
// attachment filename, template, language, and sender unchanged.
export function buildMarketingCopyPayload(
  payload: Record<string, unknown>, recipient: string,
): TemplatePayload | null {
  const phone = digitsOnly(recipient);
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) throw new Error('Invalid marketing copy recipient');
  const copy = structuredClone(payload) as TemplatePayload;
  const targets = copy.payload.template.to_and_components;
  if (targets.length !== 1 || targets[0]!.to.length !== 1) {
    throw new Error('Marketing copy requires a single original customer');
  }
  if (digitsOnly(targets[0]!.to[0]!) === phone) return null;
  targets[0]!.to = [phone];
  return copy;
}

export async function enqueueMarketingCopy(
  jobId: number,
  payload: Record<string, unknown>,
  customerNumber: string,
): Promise<void> {
  if (!env.MSG91_MARKETING_COPY_ENABLED) return;
  // Use the configured source (live SAP or Settings), with no fallback manager.
  // The resolver returns one unique recipient even if several sales areas agree.
  const { recipient } = await resolveManagerCopyRecipient(customerNumber);
  if (!recipient) return;
  const copy = buildMarketingCopyPayload(payload, recipient);
  if (!copy) return;
  // Store no signed URL/token. A fresh URL for the SAME PDF is generated on dispatch.
  const header = copy.payload.template.to_and_components[0]!.components.header_1;
  if (header?.type === 'document') header.value = '';
  const { error } = await getSupabaseServerClient().from('marketing_whatsapp_copies').upsert({
    source_job_id: jobId, recipient, payload: copy,
  }, { onConflict: 'source_job_id,recipient', ignoreDuplicates: true });
  if (error) throw new Error(`Unable to queue marketing copy: ${error.message}`);
  // A customer retry may use a revised template/sender. Pending copies must
  // reflect that actual attempt, while accepted copies must never be requeued.
  const { error: updateError } = await getSupabaseServerClient().from('marketing_whatsapp_copies')
    .update({ payload: copy }).eq('source_job_id', jobId)
    .eq('recipient', recipient).eq('status', 'pending');
  if (updateError) throw new Error(`Unable to update marketing copy: ${updateError.message}`);
}

let timer: NodeJS.Timeout | undefined;
let running = false;
const workerName = `marketing-copy-${randomUUID().slice(0, 8)}`;

export function startMarketingCopyWorker(): void {
  if (timer || !env.MSG91_MARKETING_COPY_ENABLED || !env.MSG91_SEND_ENABLED) return;
  timer = setInterval(() => { void processMarketingCopyQueue(); }, env.JOB_POLL_INTERVAL_MS);
  timer.unref();
  void processMarketingCopyQueue();
}

export function stopMarketingCopyWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function processMarketingCopyQueue(): Promise<void> {
  if (running || !env.MSG91_MARKETING_COPY_ENABLED || !env.MSG91_SEND_ENABLED) return;
  running = true;
  const client = getSupabaseServerClient();
  const save = async (id: number, values: Record<string, unknown>) => {
    const { error } = await client.from('marketing_whatsapp_copies').update({
      ...values, locked_at: null, locked_by: null,
    }).eq('id', id).eq('status', 'processing').eq('locked_by', workerName);
    if (error) throw new Error(`Unable to save marketing copy result: ${error.message}`);
  };
  try {
    // A stopped process might have sent its message already. Never blindly resend.
    const { error: staleError } = await client.from('marketing_whatsapp_copies').update({
      status: 'unknown', last_error: 'Worker stopped during dispatch; verify MSG91 before retrying',
      locked_at: null, locked_by: null,
    }).eq('status', 'processing').lt('locked_at', new Date(Date.now() - env.JOB_LOCK_TIMEOUT_MINUTES * 60_000).toISOString());
    if (staleError) throw new Error(staleError.message);
    for (let count = 0; count < 20; count++) {
      const { data, error } = await client.rpc('claim_next_marketing_whatsapp_copy', { worker_name: workerName });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) break;
      let dispatched = false;
      try {
        const payload = structuredClone(row.payload) as TemplatePayload;
        const sourceContext = await getDeliveryJobContextById(Number(row.source_job_id));
        // The manager and customer approvals are re-read right before dispatch, so a
        // disabled customer or a changed manager stops a copy that was queued earlier.
        await assertManagerCopyStillAllowed(
          sourceContext.customer.sap_customer_number,
          String(row.recipient),
        );
        const header = payload.payload.template.to_and_components[0]!.components.header_1;
        if (header?.type === 'document') {
          header.value = await createInvoiceDocumentUrl(sourceContext);
        }
        // This path sends only internal copies and never calls the customer workers.
        dispatched = true;
        const result = await sendTemplatePayload(payload as unknown as Record<string, unknown>, 20_000);
        const retryable = !result.ambiguous && (result.statusCode === 429 || result.statusCode >= 500) && Number(row.attempt_count) < 5;
        await save(Number(row.id), {
          status: result.ok ? 'accepted' : result.ambiguous ? 'unknown' : retryable ? 'pending' : 'failed',
          provider_request_id: result.providerRequestId ?? null,
          provider_message_id: result.providerMessageId ?? null,
          accepted_at: result.ok ? new Date().toISOString() : null,
          next_attempt_at: new Date(Date.now() + 60_000 * Number(row.attempt_count)).toISOString(),
          last_error: result.ok ? null : `MSG91 copy HTTP ${result.statusCode}; ambiguous=${result.ambiguous}`,
        });
      } catch (error) {
        if (error instanceof MessagingRefusal) {
          // A policy refusal is final: never retry it, and never send.
          await save(Number(row.id), { status: 'failed', last_error: error.message.slice(0, 2000) });
          continue;
        }
        await save(Number(row.id), {
          status: dispatched ? 'unknown' : Number(row.attempt_count) < 5 ? 'pending' : 'failed',
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
          last_error: error instanceof Error ? error.message.slice(0, 2000) : 'Marketing copy failed',
        });
      }
    }
  } catch (error) {
    console.error('Marketing copy queue failed', error);
  } finally {
    running = false;
  }
}
