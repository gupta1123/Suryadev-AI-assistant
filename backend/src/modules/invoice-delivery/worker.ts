import { randomUUID } from 'node:crypto';
import { digitsOnly, env, whatsappTestRecipients } from '../../config/env.js';
import {
  buildMsg91InvoicePayload,
  sanitizeMsg91Payload,
  sendInvoiceTemplate,
} from './msg91-client.js';
import { formatInvoiceAmount, formatInvoiceDate } from './policy.js';
import { handOffAcceptedInvoiceToPaymentSchedule } from '../payment-follow-up/handoff.js';
import {
  claimNextDeliveryJob,
  createInvoiceDocumentUrl,
  getDeliveryJobContext,
  getOrCreateMessage,
  markDeliveryAccepted,
  markDeliveryFailed,
  markClaimedJobFailed,
  startMessageAttempt,
} from './repository.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const workerName = `invoice-delivery-${randomUUID().slice(0, 8)}`;

export function startDeliveryWorker(): () => void {
  if (timer) return stopDeliveryWorker;
  timer = setInterval(() => {
    void processDeliveryQueue();
  }, env.JOB_POLL_INTERVAL_MS);
  timer.unref();
  void processDeliveryQueue();
  return stopDeliveryWorker;
}

export function stopDeliveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function processDeliveryQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = await claimNextDeliveryJob(workerName);
      if (!job) break;
      try {
        await processClaimedJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery worker error';
        await markClaimedJobFailed(job.id, message);
      }
    }
  } catch (error) {
    console.error('Invoice delivery worker failed', error);
  } finally {
    running = false;
  }
}

async function processClaimedJob(job: Awaited<ReturnType<typeof claimNextDeliveryJob>> & {}): Promise<void> {
  if (!job) return;
  const context = await getDeliveryJobContext(job);
  const recipient = digitsOnly(String(context.metadata.actual_recipient ?? ''));
  if (
    env.DELIVERY_MODE === 'test' &&
    (!recipient || !whatsappTestRecipients.has(recipient))
  ) {
    throw new Error('Delivery worker refused a recipient outside the test allowlist');
  }

  const message = await getOrCreateMessage(context);
  const documentUrl = await createInvoiceDocumentUrl(context);
  const templateInput = {
    recipient,
    documentUrl,
    documentFileName:
      context.document.file_name ?? `${context.invoice.sap_billing_document}.pdf`,
    customerName: context.customer.display_name,
    billingDocument: context.invoice.sap_billing_document,
    billingDocumentDate: formatInvoiceDate(context.invoice.billing_document_date),
    formattedAmount: formatInvoiceAmount(Number(context.invoice.total_gross_amount)),
    teamName: env.MSG91_TEMPLATE_TEAM_NAME,
  };
  const payload = buildMsg91InvoicePayload(templateInput);
  const attempt = await startMessageAttempt(
    context,
    message.id,
    sanitizeMsg91Payload(payload),
  );

  try {
    const result = await sendInvoiceTemplate(templateInput);
    if (result.ok) {
      const acceptedAt = new Date().toISOString();
      await markDeliveryAccepted({
        jobId: context.id,
        messageId: message.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        statusCode: result.statusCode,
        responseBody: result.body,
        ...(result.providerRequestId
          ? { providerRequestId: result.providerRequestId }
          : {}),
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
      });
      try {
        await handOffAcceptedInvoiceToPaymentSchedule(context, acceptedAt);
      } catch (error) {
        console.error(
          'Invoice was accepted but the controlled payment handoff failed',
          error instanceof Error ? error.message : error,
        );
      }
      return;
    }

    const errorMessage = result.ambiguous
      ? 'MSG91 request timed out; delivery outcome is unknown and requires manual review'
      : `MSG91 rejected the invoice template (HTTP ${result.statusCode})`;
    await markDeliveryFailed({
      jobId: context.id,
      messageId: message.id,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      statusCode: result.statusCode,
      responseBody: result.body,
      errorMessage,
      ambiguous: result.ambiguous,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown MSG91 error';
    await markDeliveryFailed({
      jobId: context.id,
      messageId: message.id,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      statusCode: 0,
      responseBody: { error: errorMessage },
      errorMessage,
      ambiguous: false,
    });
  }
}
