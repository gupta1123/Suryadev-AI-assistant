import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  env,
  isPaymentFollowUpTestConfigured,
  isPaymentFollowUpSchedulerConfigured,
  isMsg91Configured,
  isSapConfigured,
  paymentTestRecipients,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { type AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { formatPhone } from '../invoice-delivery/policy.js';
import {
  getPaymentCase,
  holdPaymentCase,
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
import { getEligibleInvoiceDetails, getManagerPreview } from './invoice-details.js';
import { autoMasterSchema, getAutoSettings, saveAutoMaster, serverCanSendReminders, setAutoCustomer } from './auto-settings.js';
import { previewAutoStart } from './automation.js';
import { clearEligiblePaymentCache, listEligiblePaymentInvoices, sendManualRemindersNow, sendNowSchema, startJourneySchema, startManualPaymentJourney } from './manual-journeys.js';

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
      manualJourneys: env.PAYMENT_JOURNEY_MODE === 'manual',
      dueDays: reminderSettings.dueDays,
      sendEnabled: env.PAYMENT_FOLLOW_UP_SEND_ENABLED && env.MSG91_SEND_ENABLED,
      controlledTest: env.PAYMENT_JOURNEY_MODE !== 'manual',
      configured: env.PAYMENT_JOURNEY_MODE === 'manual'
        ? isPaymentFollowUpSchedulerConfigured && isMsg91Configured && isSapConfigured
        : isPaymentFollowUpTestConfigured,
      invoiceSource: 'sap',
      receivableSource: env.PAYMENT_JOURNEY_MODE === 'manual' ? 'user_confirmed' : env.PAYMENT_RECEIVABLE_SOURCE,
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
    const saved = await saveReminderSettings(
      parsed.data,
      request.auth ? { id: request.auth.userId, username: request.auth.user.username } : undefined,
    );
    // The eligible list depends on "due after" days, so a copy built under the old value must not be reused.
    clearEligiblePaymentCache();
    response.json({ data: saved });
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
    if (env.PAYMENT_JOURNEY_MODE === 'manual') throw new HttpError(409, 'Use Start journey on an eligible invoice instead of a demo send.');
    response.status(202).json({ data: await startPaymentDemoRun(request.auth?.userId) });
  }),
);

paymentFollowUpRouter.get('/eligible', asyncHandler(async (_request, response) => {
  response.json({ data: await listEligiblePaymentInvoices() });
}));
paymentFollowUpRouter.get('/eligible/:invoiceNumber/details', asyncHandler(async (request, response) => {
  const number = z.string().regex(/^[a-zA-Z0-9-]{1,35}$/).parse(request.params.invoiceNumber);
  response.json({ data: await getEligibleInvoiceDetails(number) });
}));
paymentFollowUpRouter.get('/eligible/:invoiceNumber/managers', asyncHandler(async (request, response) => {
  const number = z.string().regex(/^[a-zA-Z0-9-]{1,35}$/).parse(request.params.invoiceNumber);
  response.json({ data: await getManagerPreview(number) });
}));
paymentFollowUpRouter.post('/journeys/:invoiceNumber/start', asyncHandler(async (request: AuthenticatedRequest, response) => {
  const number = z.string().regex(/^[a-zA-Z0-9-]{1,35}$/).parse(request.params.invoiceNumber);
  response.status(201).json({ data: await startManualPaymentJourney(number, startJourneySchema.parse(request.body), request.auth!.user.username) });
}));

const actorOf = (request: AuthenticatedRequest) => request.auth ? { id: request.auth.userId, username: request.auth.user.username } : undefined;
const customerNumberSchema = z.string().regex(/^[A-Za-z0-9]{1,20}$/);

paymentFollowUpRouter.get('/auto', asyncHandler(async (_request, response) => {
  const settings = await getAutoSettings();
  response.json({ data: { enabled: settings.enabled, goLiveDate: settings.goLiveDate, customers: Object.keys(settings.customers), serverCanSend: serverCanSendReminders(), updatedAt: settings.updatedAt } });
}));
paymentFollowUpRouter.put('/auto', asyncHandler(async (request: AuthenticatedRequest, response) => {
  const parsed = autoMasterSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'Automatic reminder settings are invalid', parsed.error.issues.map((issue) => ({ label: `${issue.path.join('.')}: ${issue.message}` })));
  if (parsed.data.enabled && !serverCanSendReminders()) throw new HttpError(409, 'Payment reminder sending is not switched on for this server, so automatic reminders cannot be turned on.');
  const saved = await saveAutoMaster(parsed.data, actorOf(request));
  response.json({ data: { enabled: saved.enabled, goLiveDate: saved.goLiveDate, customers: Object.keys(saved.customers), serverCanSend: serverCanSendReminders(), updatedAt: saved.updatedAt } });
}));
paymentFollowUpRouter.get('/auto/preview/:customerNumber', asyncHandler(async (request, response) => {
  response.json({ data: await previewAutoStart(customerNumberSchema.parse(request.params.customerNumber)) });
}));
paymentFollowUpRouter.put('/auto/customers/:customerNumber', asyncHandler(async (request: AuthenticatedRequest, response) => {
  const body = z.object({ enabled: z.boolean() }).strict().parse(request.body ?? {});
  const saved = await setAutoCustomer(customerNumberSchema.parse(request.params.customerNumber), body.enabled, actorOf(request));
  response.json({ data: { enabled: saved.enabled, goLiveDate: saved.goLiveDate, customers: Object.keys(saved.customers) } });
}));
paymentFollowUpRouter.post('/cases/:caseId/stop', asyncHandler(async (request: AuthenticatedRequest, response) => {
  const caseId = caseIdSchema.parse(request.params.caseId);
  response.json({ data: await holdPaymentCase(caseId, 'stopped_by_user', { id: request.auth?.userId ?? '', username: request.auth?.user.username ?? 'admin' }) });
}));

paymentFollowUpRouter.post('/cases/send-now', asyncHandler(async (request: AuthenticatedRequest, response) => {
  response.json({ data: await sendManualRemindersNow(sendNowSchema.parse(request.body).caseIds, request.auth!.user.username) });
}));

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
