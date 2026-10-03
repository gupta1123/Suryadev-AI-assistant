import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  env,
  isPaymentFollowUpTestConfigured,
  paymentTestRecipients,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { type AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { formatPhone } from '../invoice-delivery/policy.js';
import {
  getPaymentCase,
  listPaymentCases,
  markPaymentCasePaid,
  preparePaymentEndToEndTest,
  restartPaymentCase,
} from './repository.js';
import { getPaymentTestPreview } from './service.js';
import {
  getReminderSettings,
  reminderSettingsSchema,
  saveReminderSettings,
} from './settings.js';
import { persistControlledInvoiceResendAndEnqueue } from '../invoice-delivery/repository.js';
import { processDeliveryQueue } from '../invoice-delivery/worker.js';
import { paymentDetailsSchema } from './payment-details.js';

const caseIdSchema = z.coerce.number().int().positive();

export const paymentFollowUpRouter = Router();

paymentFollowUpRouter.use((request, response, next) => {
  void requireAdmin(request, response, next);
});

paymentFollowUpRouter.get('/config', asyncHandler(async (_request, response) => {
  const reminderSettings = await getReminderSettings();
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
      maskedRecipient: [...paymentTestRecipients].map(formatPhone).join(', '),
      templateName: env.MSG91_PAYMENT_TEMPLATE_NAME,
      firstReminderDelaySeconds: reminderSettings.firstReminderDelaySeconds,
      repeatReminderDelaySeconds: reminderSettings.repeatReminderDelaySeconds,
      maximumTestReminders: reminderSettings.maximumReminders,
      reminderSettingsSource: reminderSettings.source,
      reminderSettingsUpdatedAt: reminderSettings.updatedAt,
      deploymentAllowed: env.NODE_ENV !== 'production' || env.PAYMENT_TEST_DEPLOYMENT_ENABLED,
    },
  });
}));

paymentFollowUpRouter.put(
  '/settings',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const parsed = reminderSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Reminder settings are invalid',
        parsed.error.issues.map((issue) => ({ label: `${issue.path.join('.')}: ${issue.message}` })),
      );
    }
    response.json({
      data: await saveReminderSettings(
        parsed.data,
        request.auth ? { id: request.auth.userId, username: request.auth.user.username } : undefined,
      ),
    });
  }),
);

paymentFollowUpRouter.get(
  '/test-preview',
  asyncHandler(async (_request, response) => {
    response.json({ data: safePreview(await getPaymentTestPreview()) });
  }),
);

paymentFollowUpRouter.post(
  '/test-run',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    response.status(202).json({ data: await startPaymentDemoRun(request.auth?.userId) });
  }),
);

paymentFollowUpRouter.post(
  '/cases/:caseId/restart',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const caseId = caseIdSchema.parse(request.params.caseId);
    response.json({
      data: await restartPaymentCase(
        caseId,
        request.auth ? { id: request.auth.userId, username: request.auth.user.username } : undefined,
      ),
    });
  }),
);

async function startPaymentDemoRun(startedBy?: string) {
  const preview = await getPaymentTestPreview();
  if (!preview.sendAllowed) {
    throw new HttpError(
      409,
      'Payment reminder preflight failed',
      preview.validations.filter((validation) => validation.blocking && !validation.passed),
    );
  }
  const cycleId = randomUUID();
  const paymentCase = await preparePaymentEndToEndTest(preview, cycleId, startedBy);
  const invoiceDelivery = await persistControlledInvoiceResendAndEnqueue(
    preview.candidate,
    preview.recipient,
    cycleId,
    startedBy,
  );
  setImmediate(() => {
    void processDeliveryQueue();
  });
  const reminderSettings = await getReminderSettings();
  return {
    ...paymentCase,
    jobId: invoiceDelivery.jobId,
    duplicate: invoiceDelivery.duplicate,
    status: 'invoice_queued',
    testCycleId: cycleId,
    firstReminderDelaySeconds: reminderSettings.firstReminderDelaySeconds,
    repeatReminderDelaySeconds: reminderSettings.repeatReminderDelaySeconds,
    invoice: preview.candidate.billingDocument,
    customer: preview.candidate.customer.displayName,
    outstandingAmount: preview.receivable.outstandingAmount,
    currency: preview.receivable.currency,
    dueDate: preview.receivable.dueDate,
    maskedRecipient: preview.maskedRecipient,
  };
}

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

paymentFollowUpRouter.post(
  '/cases/:caseId/mark-paid',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const caseId = caseIdSchema.parse(request.params.caseId);
    const paymentDetails = paymentDetailsSchema.parse(request.body ?? {});
    response.json({
      data: await markPaymentCasePaid(
        caseId,
        request.auth ? { id: request.auth.userId, username: request.auth.user.username } : undefined,
        paymentDetails,
      ),
    });
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
