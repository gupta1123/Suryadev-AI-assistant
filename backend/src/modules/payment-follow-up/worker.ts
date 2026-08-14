import { randomUUID } from 'node:crypto';
import { digitsOnly, env, isPaymentFollowUpTestConfigured } from '../../config/env.js';
import {
  buildMsg91PaymentReminderPayload,
  sanitizeMsg91Payload,
  sendPaymentReminderTemplate,
} from '../invoice-delivery/msg91-client.js';
import { formatInvoiceAmount, formatInvoiceDate } from '../invoice-delivery/policy.js';
import {
  claimNextCommunicationJob,
  getDeliveryJobContext,
  getOrCreateMessage,
  markClaimedJobFailed,
  markDeliveryAccepted,
  markDeliveryFailed,
  startMessageAttempt,
} from '../invoice-delivery/repository.js';
import { assertHardPaymentRecipient } from './policy.js';
import { markPaymentReminderAwaitingSent } from './repository.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
const workerName = `payment-follow-up-${randomUUID().slice(0, 8)}`;

export function startPaymentFollowUpWorker(): () => void {
  if (timer || !env.PAYMENT_FOLLOW_UP_ENABLED) return stopPaymentFollowUpWorker;
  timer = setInterval(() => {
    void processPaymentFollowUpQueue();
  }, env.JOB_POLL_INTERVAL_MS);
  timer.unref();
  void processPaymentFollowUpQueue();
  return stopPaymentFollowUpWorker;
}

export function stopPaymentFollowUpWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function processPaymentFollowUpQueue(): Promise<void> {
  if (running || !env.PAYMENT_FOLLOW_UP_ENABLED) return;
  running = true;
  try {
    while (true) {
      const job = await claimNextCommunicationJob(workerName, 'payment_reminder');
      if (!job) break;
      try {
        await processClaimedPaymentJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown payment reminder worker error';
        await markClaimedJobFailed(job.id, message);
      }
    }
  } catch (error) {
    console.error('Payment follow-up worker failed', error);
  } finally {
    running = false;
  }
}

async function processClaimedPaymentJob(
  job: NonNullable<Awaited<ReturnType<typeof claimNextCommunicationJob>>>,
): Promise<void> {
  if (!isPaymentFollowUpTestConfigured || env.DELIVERY_MODE !== 'test') {
    throw new Error('Payment follow-up worker is disabled outside controlled test mode');
  }
  const context = await getDeliveryJobContext(job);
  const recipient = digitsOnly(String(context.metadata.actual_recipient ?? ''));
  assertHardPaymentRecipient(recipient);
  if (!context.payment_follow_up_case_id) {
    throw new Error('Payment reminder job has no follow-up case');
  }
  const outstandingAmount = Number(context.metadata.outstanding_amount);
  const cycleId = String(context.metadata.payment_test_cycle_id ?? '');
  if (!cycleId) throw new Error('Payment reminder job has no controlled test cycle');
  const messageBody = `Payment reminder for invoice ${context.invoice.sap_billing_document}`;
  const message = await getOrCreateMessage(context, {
    purpose: 'payment_reminder',
    body: messageBody,
  });
  const templateInput = {
    recipient,
    customerName: context.customer.display_name,
    outstandingAmount: formatInvoiceAmount(outstandingAmount),
    billingDocument: context.invoice.sap_billing_document,
    billingDocumentDate: formatInvoiceDate(context.invoice.billing_document_date),
    teamName: env.MSG91_TEMPLATE_TEAM_NAME,
  };
  const payload = buildMsg91PaymentReminderPayload(templateInput);
  const attempt = await startMessageAttempt(
    context,
    message.id,
    sanitizeMsg91Payload(payload),
  );

  try {
    const result = await sendPaymentReminderTemplate(templateInput);
    if (result.ok) {
      await markDeliveryAccepted({
        jobId: context.id,
        messageId: message.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        statusCode: result.statusCode,
        responseBody: result.body,
        ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      });
      await markPaymentReminderAwaitingSent(
        context.payment_follow_up_case_id,
        cycleId,
        context.id,
      );
      return;
    }

    const errorMessage = result.ambiguous
      ? 'MSG91 request timed out; reminder outcome is unknown and requires review'
      : `MSG91 rejected the payment reminder template (HTTP ${result.statusCode})`;
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
