import {
  digitsOnly,
  env,
  isPaymentFollowUpTestConfigured,
} from '../../config/env.js';
import { getDeliveryJobContextById } from '../invoice-delivery/repository.js';
import {
  activatePaymentTestAfterInvoiceSent,
  preparePaymentEndToEndTest,
  scheduleNextPaymentReminderFromSentAt,
} from './repository.js';
import { getPaymentTestPreview } from './service.js';
import {
  automaticPaymentCycleId,
  PAYMENT_HARD_TEST_RECIPIENT,
} from './policy.js';

export async function handOffSentInvoiceToPaymentSchedule(
  jobId: number,
  sentAt: string,
): Promise<void> {
  const context = await getDeliveryJobContextById(jobId);
  const recipient = digitsOnly(String(context.metadata.actual_recipient ?? ''));

  if (context.job_type === 'payment_reminder') {
    const cycleId = String(context.metadata.payment_test_cycle_id ?? '');
    if (
      !cycleId ||
      !context.payment_follow_up_case_id ||
      recipient !== PAYMENT_HARD_TEST_RECIPIENT ||
      context.invoice.sap_billing_document !== env.PAYMENT_TEST_INVOICE
    ) {
      return;
    }
    await scheduleNextPaymentReminderFromSentAt(
      context.payment_follow_up_case_id,
      cycleId,
      context.id,
      sentAt,
    );
    return;
  }

  const isManualTestResend =
    context.job_type === 'manual_resend' &&
    context.metadata.payment_e2e_test === true;
  const isAutomaticInvoiceDelivery = context.job_type === 'invoice_delivery';
  if (!isManualTestResend && !isAutomaticInvoiceDelivery) return;

  if (isAutomaticInvoiceDelivery) {
    if (
      !isPaymentFollowUpTestConfigured ||
      !env.PAYMENT_FOLLOW_UP_SEND_ENABLED ||
      recipient !== PAYMENT_HARD_TEST_RECIPIENT ||
      context.invoice.sap_billing_document !== env.PAYMENT_TEST_INVOICE
    ) {
      return;
    }
  }

  const cycleId = isAutomaticInvoiceDelivery
    ? automaticPaymentCycleId(context.id)
    : String(context.metadata.payment_test_cycle_id ?? '');
  if (!cycleId || recipient !== PAYMENT_HARD_TEST_RECIPIENT) {
    throw new Error('Invoice-to-payment handoff failed its controlled test boundary');
  }

  const preview = await getPaymentTestPreview();
  if (!preview.sendAllowed) {
    const failedChecks = preview.validations
      .filter((validation) => validation.blocking && !validation.passed)
      .map((validation) => validation.code)
      .join(', ');
    throw new Error(`Invoice-to-payment handoff failed preflight: ${failedChecks}`);
  }

  if (isAutomaticInvoiceDelivery) {
    await preparePaymentEndToEndTest(preview, cycleId);
  }

  await activatePaymentTestAfterInvoiceSent(preview, {
    cycleId,
    invoiceJobId: context.id,
    sentAt,
  });
}
