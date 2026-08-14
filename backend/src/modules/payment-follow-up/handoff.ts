import { digitsOnly, env } from '../../config/env.js';
import type { DeliveryJobContext } from '../invoice-delivery/repository.js';
import { activatePaymentTestAfterInvoiceAccepted } from './repository.js';
import { getPaymentTestPreview } from './service.js';
import { PAYMENT_HARD_TEST_RECIPIENT } from './policy.js';

export async function handOffAcceptedInvoiceToPaymentSchedule(
  context: DeliveryJobContext,
  acceptedAt: string,
): Promise<void> {
  if (
    context.job_type !== 'manual_resend' ||
    context.metadata.payment_e2e_test !== true
  ) {
    return;
  }

  const cycleId = String(context.metadata.payment_test_cycle_id ?? '');
  const recipient = digitsOnly(String(context.metadata.actual_recipient ?? ''));
  if (
    !cycleId ||
    recipient !== PAYMENT_HARD_TEST_RECIPIENT ||
    context.invoice.sap_billing_document !== env.PAYMENT_TEST_INVOICE
  ) {
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

  await activatePaymentTestAfterInvoiceAccepted(preview, {
    cycleId,
    invoiceJobId: context.id,
    acceptedAt,
  });
}
