import { Router } from 'express';
import { z } from 'zod';
import {
  env,
  isPaymentFollowUpTestConfigured,
  paymentTestRecipient,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { type AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { maskPhone } from '../invoice-delivery/policy.js';
import {
  getPaymentCase,
  listPaymentCases,
  persistPaymentTestAndSchedule,
} from './repository.js';
import { getPaymentTestPreview } from './service.js';

const caseIdSchema = z.coerce.number().int().positive();

export const paymentFollowUpRouter = Router();

paymentFollowUpRouter.use((request, response, next) => {
  void requireAdmin(request, response, next);
});

paymentFollowUpRouter.get('/config', (_request, response) => {
  response.json({
    data: {
      enabled: env.PAYMENT_FOLLOW_UP_ENABLED,
      sendEnabled: env.PAYMENT_FOLLOW_UP_SEND_ENABLED,
      controlledTest: true,
      configured: isPaymentFollowUpTestConfigured,
      invoiceSource: 'sap',
      receivableSource: env.PAYMENT_RECEIVABLE_SOURCE,
      testCustomer: env.PAYMENT_TEST_CUSTOMER,
      testInvoice: env.PAYMENT_TEST_INVOICE,
      testDueDate: env.PAYMENT_TEST_DUE_DATE,
      maskedRecipient: maskPhone(paymentTestRecipient),
      templateName: env.MSG91_PAYMENT_TEMPLATE_NAME,
      firstReminderDelaySeconds: env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
      repeatReminderDelaySeconds: env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
      maximumTestReminders: env.PAYMENT_TEST_MAX_REMINDERS,
      deploymentAllowed: env.NODE_ENV !== 'production' || env.PAYMENT_TEST_DEPLOYMENT_ENABLED,
    },
  });
});

paymentFollowUpRouter.get(
  '/test-preview',
  asyncHandler(async (_request, response) => {
    response.json({ data: safePreview(await getPaymentTestPreview()) });
  }),
);

paymentFollowUpRouter.post(
  '/test-run',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const preview = await getPaymentTestPreview();
    if (!preview.sendAllowed) {
      throw new HttpError(
        409,
        'Payment reminder preflight failed',
        preview.validations.filter((validation) => validation.blocking && !validation.passed),
      );
    }
    const result = await persistPaymentTestAndSchedule(preview, request.auth?.userId);
    response.status(result.duplicate ? 200 : 202).json({
      data: {
        ...result,
        invoice: preview.candidate.billingDocument,
        customer: preview.candidate.customer.displayName,
        outstandingAmount: preview.receivable.outstandingAmount,
        currency: preview.receivable.currency,
        dueDate: preview.receivable.dueDate,
        maskedRecipient: preview.maskedRecipient,
      },
    });
  }),
);

paymentFollowUpRouter.get(
  '/cases',
  asyncHandler(async (_request, response) => {
    response.json({ data: await listPaymentCases() });
  }),
);

paymentFollowUpRouter.get(
  '/cases/:caseId',
  asyncHandler(async (request, response) => {
    response.json({ data: await getPaymentCase(caseIdSchema.parse(request.params.caseId)) });
  }),
);

function safePreview(preview: Awaited<ReturnType<typeof getPaymentTestPreview>>) {
  return {
    mode: preview.mode,
    invoiceSource: preview.invoiceSource,
    receivableSource: preview.receivableSource,
    invoice: {
      billingDocument: preview.candidate.billingDocument,
      billingDocumentDate: preview.candidate.billingDocumentDate,
      customerName: preview.candidate.customer.displayName,
      customerNumber: preview.candidate.customer.customerNumber,
      currency: preview.candidate.currency,
      totalGrossAmount: preview.candidate.totalGrossAmount,
      accountingPostingStatus: preview.candidate.accountingPostingStatus,
    },
    receivable: preview.receivable,
    maskedRecipient: preview.maskedRecipient,
    template: preview.template,
    validations: preview.validations,
    sendAllowed: preview.sendAllowed,
    disclosure: preview.disclosure,
  };
}
